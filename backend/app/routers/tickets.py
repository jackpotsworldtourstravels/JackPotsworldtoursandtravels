"""Ticket enquiry, requests, approvals, payments and issuance.

One router covering the spec's central transaction, because merchant and
admin actions operate on the same rows and share the same visibility rules —
splitting them would mean duplicating ``scoped_query`` on both sides.

Who may call what is decided by permission codes, not by the URL prefix:
``ticket.request`` is merchant-only, ``ticket.approve`` and
``payment.verify`` are admin-only, and both are enforced again inside the
state machine when the status actually moves.
"""
import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import (
    Payment,
    PaymentStatus,
    RequestStatus,
    RequestType,
    ServiceRequest,
    TravelType,
    User,
)
from app.schemas.document import DocumentResponse
from app.schemas.pagination import Page
from app.schemas.ticket import (
    ActionOption,
    ApproveRequest,
    CancelRequest,
    CatalogItemResponse,
    CreateBookingRequest,
    CreateServiceRequest,
    IssueTicketRequest,
    PassengerLookupResponse,
    PassengerResponse,
    PayRequest,
    PaymentSummary,
    QuoteResponse,
    RejectRequest,
    ReplacePassengersRequest,
    RepriceRequest,
    RequestDetailResponse,
    RequestResponse,
    ResolveServiceRequest,
    TimelineStep,
    UpdateDraftRequest,
    VerifyPaymentRequest,
)
from app.services import catalog_service, invoice_service, lifecycle, ticket_service

router = APIRouter(prefix="/api", tags=["tickets"])


def _detail(db: Session, request, actor: User) -> RequestDetailResponse:
    payments = list(
        db.scalars(
            select(Payment)
            .options(selectinload(Payment.request).selectinload(ServiceRequest.merchant))
            .where(Payment.request_id == request.request_id)
            .order_by(Payment.created_at.desc())
        ).all()
    )
    def _name(uid):
        return db.get(User, uid).full_name if uid else None

    return RequestDetailResponse(
        request=RequestResponse.of(request),
        timeline=[TimelineStep(**s) for s in lifecycle.timeline(request)],
        actions=[ActionOption(**a) for a in ticket_service.action_menu(request, actor)],
        payments=[PaymentSummary.of(p) for p in payments],
        documents=[
            DocumentResponse.of(d, uploader=_name(d.uploaded_by), verifier=_name(d.verified_by))
            for d in sorted(request.documents, key=lambda d: d.created_at)
        ],
        can_download=ticket_service.can_download(request, actor),
    )


# ---------------------------------------------------------------------------
# Ticket Enquiry
# ---------------------------------------------------------------------------
@router.get(
    "/catalog/search",
    response_model=Page[CatalogItemResponse],
    tags=["merchant · enquiry"],
    summary="Ticket Enquiry — search live inventory",
    description=(
        "Requires `ticket.enquiry`. Searches flights, hotels and cruises with route, date, cabin "
        "and price filters. Options that cannot seat the requested party size are excluded."
    ),
)
def search_catalog(
    travel_type: TravelType | None = None,
    origin: str | None = None,
    destination: str | None = None,
    travel_date: datetime.date | None = None,
    cabin_class: str | None = None,
    passengers: int = Query(1, ge=1, le=9),
    max_price: Decimal | None = None,
    airline: str | None = None,
    q: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.TICKET_ENQUIRY)),
):
    items, total = catalog_service.search(
        db,
        travel_type=travel_type, origin=origin, destination=destination,
        travel_date=travel_date, cabin_class=cabin_class, passengers=passengers,
        max_price=max_price, airline=airline, query=q, page=page, page_size=page_size,
    )
    return Page.build([CatalogItemResponse.of(i) for i in items], total, page, page_size)


@router.get(
    "/catalog/{item_id}/quote",
    response_model=QuoteResponse,
    tags=["merchant · enquiry"],
    summary="Review Price — quote an option for a party size",
    description=(
        "Requires `ticket.enquiry`. Prices are computed from the catalog row on the server, so a "
        "tampered request body cannot buy a seat cheaply."
    ),
)
def quote_item(
    item_id: int,
    passengers: int = Query(1, ge=1, le=9),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.TICKET_ENQUIRY)),
):
    item = catalog_service.get_item(db, item_id)
    priced = catalog_service.quote(item, passengers)
    return QuoteResponse(item=CatalogItemResponse.of(item), **priced)


# ---------------------------------------------------------------------------
# Requests — shared list/detail
# ---------------------------------------------------------------------------
@router.get(
    "/requests",
    response_model=Page[RequestResponse],
    summary="Request History — list requests",
    description=(
        "Requires `ticket.view`. A merchant sees only its own requests; platform staff see every "
        "merchant's. Search matches PNR, request number, booking reference, ticket number, "
        "destination and passenger name."
    ),
)
def list_requests(
    request_type: RequestType | None = None,
    status: RequestStatus | None = None,
    travel_type: TravelType | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    items, total = ticket_service.list_requests(
        db, current_user,
        page=page, page_size=page_size, request_type=request_type, request_status=status,
        travel_type=travel_type, merchant_id=merchant_id, search=search,
        date_from=date_from, date_to=date_to,
    )
    return Page.build([RequestResponse.of(i) for i in items], total, page, page_size)


@router.get(
    "/requests/{request_id}",
    response_model=RequestDetailResponse,
    summary="Request detail with status timeline",
    description=(
        "Requires `ticket.view`. Returns the request, its full Activity Timeline (completed steps "
        "plus the ones still ahead), the actions this caller may take right now, and any payments."
    ),
)
def get_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    request = ticket_service.get_request(db, current_user, request_id)
    return _detail(db, request, current_user)


# ---------------------------------------------------------------------------
# Merchant: Request Ticket
# ---------------------------------------------------------------------------
@router.post(
    "/requests",
    response_model=RequestDetailResponse,
    status_code=201,
    tags=["merchant · requests"],
    summary="Request Ticket — create a draft booking",
    description=(
        "Requires `ticket.request`. Creates the request at **Created** with its passengers. "
        "Nothing is reserved until you submit it, so an abandoned draft never holds seats."
    ),
)
def create_request(
    payload: CreateBookingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    request = ticket_service.create_booking_request(
        db, current_user,
        catalog_item_id=payload.catalog_item_id,
        passengers=[p.model_dump() for p in payload.passengers],
        travel_date=payload.travel_date,
        return_date=payload.return_date,
        remarks=payload.remarks,
    )
    return _detail(db, request, current_user)


@router.put(
    "/requests/{request_id}",
    response_model=RequestDetailResponse,
    tags=["merchant · requests"],
    summary="Edit a draft request",
    description="Requires `ticket.request`. Only permitted while the request is still a draft.",
)
def update_request(
    request_id: int,
    payload: UpdateDraftRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    request = ticket_service.update_draft(
        db, current_user, request_id,
        remarks=payload.remarks, travel_date=payload.travel_date, return_date=payload.return_date,
        contact=payload.contact, special_requests=payload.special_requests,
    )
    return _detail(db, request, current_user)


@router.put(
    "/requests/{request_id}/passengers",
    response_model=list[PassengerResponse],
    tags=["merchant · requests"],
    summary="Replace the passenger list on a draft",
    description=(
        "Requires `ticket.request`. Replaces every passenger and reprices the request for the new "
        "party size. Draft only."
    ),
)
def replace_passengers(
    request_id: int,
    payload: ReplacePassengersRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    request = ticket_service.replace_passengers(
        db, current_user, request_id, [p.model_dump() for p in payload.passengers]
    )
    return [PassengerResponse.of(p) for p in request.passengers]


@router.get(
    "/passengers/lookup",
    response_model=PassengerLookupResponse,
    tags=["merchant · requests"],
    summary="Find a traveller this merchant has sent before, by passport number",
    description=(
        "Requires `ticket.request`. Saves retyping a traveller the merchant has already "
        "booked: give a passport number, get back the name, gender, date of birth, "
        "nationality, passport details and preferences last recorded for it.\n\n"
        "**Scoped to the caller's own merchant.** A passport number is guessable, so this "
        "only ever reads rows the calling merchant itself created — a staff account, which "
        "has no merchant, always gets `found: false`.\n\n"
        "**Reads only.** No passenger record is created, updated or linked; the response "
        "carries no row id, and the booking being filled in creates its own passenger rows "
        "as it always has. An unrecognised passport is `200` with `found: false`, not a 404."
    ),
)
def lookup_passenger(
    passport_number: str = Query(min_length=4, max_length=40),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    return PassengerLookupResponse.of(
        ticket_service.lookup_passenger(db, current_user, passport_number)
    )


@router.post(
    "/requests/{request_id}/submit",
    response_model=RequestDetailResponse,
    tags=["merchant · requests"],
    summary="Submit for approval",
    description=(
        "Requires `ticket.request`. Moves **Created → Pending**, reserves the seats under a row "
        "lock, and notifies the admins. Fails with 409 if the fare sold out first."
    ),
)
def submit_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    request = ticket_service.submit_request(db, current_user, request_id)
    return _detail(db, request, current_user)


@router.post(
    "/requests/{request_id}/cancel",
    response_model=RequestDetailResponse,
    tags=["merchant · requests"],
    summary="Cancel your own request",
    description="Requires `ticket.request`. Releases any reserved seats back to inventory.",
)
def cancel_request(
    request_id: int,
    payload: CancelRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    request = ticket_service.cancel_request(db, current_user, request_id, payload.reason)
    return _detail(db, request, current_user)


# ---------------------------------------------------------------------------
# Admin: approval
# ---------------------------------------------------------------------------
@router.post(
    "/admin/requests/{request_id}/approve",
    response_model=RequestDetailResponse,
    tags=["admin · approvals"],
    summary="Approve a request",
    description=(
        "Requires `ticket.approve`. Walks **Pending → Under Review → Approved → Payment Pending** "
        "and records each step on the timeline. Optionally sets a final amount."
    ),
)
def approve_request(
    request_id: int,
    payload: ApproveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_APPROVE)),
):
    request = ticket_service.approve_request(
        db, current_user, request_id, final_amount=payload.final_amount, note=payload.note
    )
    return _detail(db, request, current_user)


@router.post(
    "/admin/requests/{request_id}/reprice",
    response_model=RequestDetailResponse,
    tags=["admin · approvals"],
    summary="Correct the amount on a booking",
    description=(
        "Requires `ticket.approve`. Sets a new amount on a booking that is already **Payment "
        "Pending** — the only stage where what is owed can still change without money moving. "
        "The status is untouched; the reason is mandatory and the merchant is notified. "
        "Approval walks a booking to Payment Pending, which has no edge back to Approved, so "
        "this is the only way to correct a fare after the fact."
    ),
)
def reprice_request(
    request_id: int,
    payload: RepriceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_APPROVE)),
):
    request = ticket_service.reprice_request(
        db, current_user, request_id, amount=payload.amount, reason=payload.reason
    )
    return _detail(db, request, current_user)


@router.post(
    "/admin/requests/{request_id}/reject",
    response_model=RequestDetailResponse,
    tags=["admin · approvals"],
    summary="Reject a request",
    description=(
        "Requires `ticket.reject`. A reason is mandatory — the state machine refuses the "
        "transition without one. Reserved seats are returned to inventory."
    ),
)
def reject_request(
    request_id: int,
    payload: RejectRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REJECT)),
):
    request = ticket_service.reject_request(db, current_user, request_id, payload.reason)
    return _detail(db, request, current_user)


@router.post(
    "/admin/requests/{request_id}/issue-ticket",
    response_model=RequestDetailResponse,
    tags=["admin · approvals"],
    summary="Issue the ticket",
    description=(
        "Requires `ticket.issue`. On the standard track, only valid once the payment is verified "
        "(**Paid**); on the enquiry-led track, once the booking is Manager Approved and its ticket "
        "documents are attached. Allocates the PNR, ticket number and invoice number.\n\n"
        "**CR-4b — `fare_amount`.** On a wallet-billed (enquiry-led) booking that still carries no "
        "amount, this is **required**: it is the fare the desk paid the airline, it becomes the "
        "booking's `total_amount`, and it is what the merchant's wallet is debited. Issuing "
        "such a booking without it returns 400. On any booking that already has an amount the "
        "field is ignored, so the standard track is unchanged.\n\n"
        "**0039 — `provider_id` / `provider_user_id`.** Who the ticket was bought from, and the "
        "person at that supplier who booked it. Both are **optional in this API** so every "
        "pre-existing caller keeps working; the Booking Operations screen requires them before it "
        "will submit. When supplied they are validated — an unknown or inactive provider, or a "
        "person belonging to a different provider, returns 400 and the booking is left untouched."
    ),
)
def issue_ticket(
    request_id: int,
    payload: IssueTicketRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_ISSUE)),
):
    request = ticket_service.issue_ticket(
        db, current_user, request_id,
        fare_amount=payload.fare_amount if payload else None,
        provider_id=payload.provider_id if payload else None,
        provider_user_id=payload.provider_user_id if payload else None,
    )
    return _detail(db, request, current_user)


@router.post(
    "/admin/requests/{request_id}/complete",
    response_model=RequestDetailResponse,
    tags=["admin · approvals"],
    summary="Mark a request completed",
    description="Requires `ticket.issue`. Terminal state after travel.",
)
def complete_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_ISSUE)),
):
    request = ticket_service.complete_request(db, current_user, request_id)
    return _detail(db, request, current_user)


# ---------------------------------------------------------------------------
# Payments
# ---------------------------------------------------------------------------
@router.post(
    "/requests/{request_id}/pay",
    response_model=RequestDetailResponse,
    tags=["merchant · payments"],
    summary="Pay for an approved request",
    description=(
        "Requires `payment.pay`. Accepted only while the request is **Payment Pending**. The "
        "payment lands as `pending` until an Admin verifies it."
    ),
)
def pay_request(
    request_id: int,
    payload: PayRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_PAY)),
):
    ticket_service.record_payment(
        db, current_user, request_id,
        amount=payload.amount, method=payload.method, transaction_id=payload.transaction_id,
    )
    request = ticket_service.get_request(db, current_user, request_id)
    return _detail(db, request, current_user)


@router.get(
    "/admin/payments/pending",
    response_model=Page[PaymentSummary],
    tags=["admin · payments"],
    summary="Payments awaiting verification",
    description=(
        "Requires `payment.verify`. The Admin's verification queue, oldest first. Each row "
        "carries the booking and merchant it belongs to — approving an amount without seeing "
        "what it buys is not a review."
    ),
)
def pending_payments(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
):
    where = Payment.payment_status == PaymentStatus.PENDING
    total = db.scalar(select(func.count()).select_from(Payment).where(where)) or 0
    rows = db.scalars(
        select(Payment)
        # Eager-loaded because PaymentSummary now reads the booking and its
        # merchant for every row — lazily that is two extra queries per payment.
        .options(selectinload(Payment.request).selectinload(ServiceRequest.merchant))
        .where(where)
        .order_by(Payment.created_at.asc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return Page.build([PaymentSummary.of(p) for p in rows], total, page, page_size)


@router.post(
    "/admin/payments/{payment_id}/verify",
    response_model=PaymentSummary,
    tags=["admin · payments"],
    summary="Verify or reject a payment",
    description=(
        "Requires `payment.verify`. Approving marks the payment successful and moves the request "
        "to **Paid**, ready for issuance. Rejecting marks it failed and leaves the request at "
        "Payment Pending so the merchant can try again."
    ),
)
def verify_payment(
    payment_id: int,
    payload: VerifyPaymentRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VERIFY)),
):
    payment = ticket_service.verify_payment(
        db, current_user, payment_id, approve=payload.approve, note=payload.note
    )
    return PaymentSummary.of(payment)


# ---------------------------------------------------------------------------
# Service requests
# ---------------------------------------------------------------------------
@router.post(
    "/service-requests",
    response_model=RequestDetailResponse,
    status_code=201,
    tags=["merchant · service requests"],
    summary="Raise a service request against a booking",
    description=(
        "Requires `servicerequest.create`. Types: cancellation, date change, refund, passenger "
        "modification, extra baggage, meal, seat. Submitted for approval immediately."
    ),
)
def create_service_request(
    payload: CreateServiceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_CREATE)),
):
    request = ticket_service.create_service_request(
        db, current_user,
        booking_id=payload.booking_id, request_type=payload.request_type,
        remarks=payload.remarks, details=payload.details,
    )
    return _detail(db, request, current_user)


@router.post(
    "/admin/service-requests/{request_id}/resolve",
    response_model=RequestDetailResponse,
    tags=["admin · service requests"],
    summary="Approve or reject a service request",
    description="Requires `servicerequest.manage`. A rejection requires a reason.",
)
def resolve_service_request(
    request_id: int,
    payload: ResolveServiceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.SERVICE_REQUEST_MANAGE)),
):
    request = ticket_service.resolve_service_request(
        db, current_user, request_id, approve=payload.approve, reason=payload.reason
    )
    return _detail(db, request, current_user)


# ---------------------------------------------------------------------------
# Booking paperwork — invoice, confirmation, and the airline's own ticket
# ---------------------------------------------------------------------------
# Rendered on demand rather than stored: every figure already lives in these
# rows, and a saved copy would be a second source of truth that disagrees with
# the ledger the moment a refund lands. See invoice_service for why the ticket
# itself is uploaded instead.
def _pdf(payload: tuple[bytes, str]) -> Response:
    content, filename = payload
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            # attachment, not inline: same reasoning as document downloads —
            # nothing served from this origin should render in it.
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.get(
    "/requests/{request_id}/invoice",
    response_class=Response,
    tags=["merchant · requests"],
    summary="Download the invoice PDF",
    description=(
        "Requires `ticket.view`, and the booking must be **ticketed or completed** (409 "
        "otherwise) — that is when `issue_ticket` allocates the invoice number. Merchants get "
        "their own bookings only, enforced by the same scoping rule as every other read. "
        "Generated on demand from the booking and its payments, so a refund is reflected the "
        "moment it is recorded."
    ),
)
def download_invoice(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    return _pdf(invoice_service.build_invoice(db, current_user, request_id))


@router.get(
    "/requests/{request_id}/confirmation",
    response_class=Response,
    tags=["merchant · requests"],
    summary="Download the booking confirmation PDF",
    description=(
        "Requires `ticket.view`; ticketed or completed bookings only. A readable summary of the "
        "itinerary, passengers and PNR. **Explicitly not an e-ticket** — it says so on its face, "
        "because handing someone a platform-generated page that looks like a boarding document "
        "is how people get turned away at check-in."
    ),
)
def download_confirmation(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    return _pdf(invoice_service.build_confirmation(db, current_user, request_id))


@router.get(
    "/requests/{request_id}/tickets",
    response_model=list[DocumentResponse],
    tags=["merchant · requests"],
    summary="E-tickets attached to this booking",
    description=(
        "Requires `ticket.view`. The airline's own ticket files, uploaded by the operations "
        "desk. Metadata only — fetch the bytes from `/api/documents/{id}/download`, which "
        "re-checks merchant scope per file."
    ),
)
def list_ticket_documents(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    docs = invoice_service.ticket_documents(db, current_user, request_id)
    return [
        DocumentResponse.of(
            d,
            uploader=(db.get(User, d.uploaded_by).full_name if d.uploaded_by else None),
            verifier=(db.get(User, d.verified_by).full_name if d.verified_by else None),
        )
        for d in docs
    ]
