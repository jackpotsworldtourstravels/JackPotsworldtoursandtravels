"""Ticket Enquiry — the merchant's entry point, and the Admin's answer.

Merchant and Admin endpoints live in one router for the same reason
:mod:`app.routers.tickets` does: they operate on the same rows under the same
visibility rules, and splitting them would mean duplicating the scoping.

Who may call what is decided by permission code, not URL prefix:

* ``ticket.enquiry`` raises an enquiry. Every merchant sub-role that works
  bookings holds it — Operator and Data Operator became the same role on
  2026-07-31, so the enquiry-only capability this split used to describe no
  longer exists. Finance is the one merchant role without it.
* ``ticket.view`` lists and reads them.
* ``ticket.approve`` / ``ticket.reject`` answer them (Admin only — the
  merchant permission sets carry neither).
* ``ticket.request`` turns an answered enquiry into a booking.

Nothing here changes an existing route. Cancelling an enquiry needs no new
endpoint: an enquiry *is* a ``service_requests`` row, so the existing
``POST /api/requests/{id}/cancel`` already handles it.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, has_permission, require
from app.database.session import get_db
from app.models_v2 import RequestStatus, User
from app.schemas.enquiry import (
    DirectBookingCreate,
    EnquiryCreate,
    EnquiryResponse,
    EnquiryRespond,
    EnquiryToBooking,
)
from app.schemas.pagination import Page
from app.schemas.ticket import RequestResponse
from app.services import enquiry_service, ticket_service

router = APIRouter(prefix="/api", tags=["enquiries"])


# ---------------------------------------------------------------------------
# Merchant
# ---------------------------------------------------------------------------
@router.post(
    "/enquiries",
    response_model=EnquiryResponse,
    status_code=201,
    tags=["merchant · enquiry"],
    summary="Enquire Ticket — ask the desk about a sector",
    description=(
        "Requires `ticket.enquiry`. Creates the enquiry at **Pending** and notifies the Admin "
        "team; there is no draft stage. Returns the `ENQ-YYYYMMDD-NNNNNN` reference. "
        "From and To must differ, the travel date cannot be in the past, a round trip's return "
        "must be after departure, and adults + children + infants must equal the passenger count."
    ),
)
def create_enquiry(
    payload: EnquiryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_ENQUIRY)),
):
    enquiry = enquiry_service.create(db, current_user, payload)
    return EnquiryResponse.of(enquiry)


@router.get(
    "/enquiries",
    response_model=Page[EnquiryResponse],
    tags=["merchant · enquiry"],
    summary="Ticket Enquiry listing",
    description=(
        "Requires `ticket.view`. A merchant sees only its own enquiries; platform staff see "
        "every merchant's. Search matches the reference, route, airline and flight number."
    ),
)
def list_enquiries(
    status: RequestStatus | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    items, total = enquiry_service.list_enquiries(
        db, current_user,
        page=page, page_size=page_size, request_status=status,
        merchant_id=merchant_id, search=search,
    )
    return Page.build([EnquiryResponse.of(i) for i in items], total, page, page_size)


@router.get(
    "/enquiries/{enquiry_id}",
    response_model=EnquiryResponse,
    tags=["merchant · enquiry"],
    summary="Enquiry detail",
    description="Requires `ticket.view`. Everything the View Details card shows.",
)
def get_enquiry(
    enquiry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_VIEW)),
):
    return EnquiryResponse.of(enquiry_service.get(db, current_user, enquiry_id))


@router.post(
    "/enquiries/{enquiry_id}/booking-request",
    response_model=RequestResponse,
    status_code=201,
    tags=["merchant · requests"],
    summary="Request Ticket — turn an available enquiry into a draft booking",
    description=(
        "Requires `ticket.request`. Valid only once the Admin has marked the enquiry "
        "**Approved**, and only once per enquiry (409 otherwise). Every itinerary field is "
        "copied from the enquiry server-side — only the passengers come from the body — so the "
        "booking that reaches the approvals desk is the journey that was actually answered. "
        "The draft still needs `POST /api/requests/{id}/submit`."
    ),
)
def enquiry_to_booking_request(
    enquiry_id: int,
    payload: EnquiryToBooking,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    booking = enquiry_service.to_booking_request(
        db, current_user, enquiry_id,
        passengers=[p.model_dump() for p in payload.passengers],
        remarks=payload.remarks,
        contact=payload.contact.model_dump() if payload.contact else None,
        international=payload.international,
        special_requests=payload.special_requests,
    )
    return RequestResponse.of(
        enquiry_service.load_with_passengers(db, current_user, booking.request_id)
    )


@router.post(
    "/bookings/direct",
    response_model=RequestResponse,
    status_code=201,
    tags=["merchant · requests"],
    summary="Book Now — raise a booking without an enquiry first",
    description=(
        "Requires `ticket.request`, the same code the enquiry-led path uses. Creates the booking "
        "at **Created** with its itinerary and passengers, and — unlike the enquiry-led path — "
        "takes the journey from the merchant, because there is no quotation to copy it from. "
        "It therefore carries **no amount**: the desk names the fare when it issues the ticket, "
        "which is where an unpriced booking has always been priced. Everything after this call "
        "is the existing workflow — Manager approval, then ticketing, then the wallet debit. "
        "Send `submit: true` to put it in front of the Manager in the same call, or leave it "
        "false and use `POST /api/requests/{id}/submit` later."
    ),
)
def create_direct_booking(
    payload: DirectBookingCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_REQUEST)),
):
    booking = enquiry_service.create_direct_booking(db, current_user, payload)
    if payload.submit:
        # The same function the two-step path calls. Its completeness rules —
        # contact details, passenger names, passports on an international
        # sector — apply here unchanged, so a booking that would be refused
        # on the enquiry-led screen is refused here too.
        #
        # ALL OR NOTHING, and the cleanup is the reason this is not a bare call.
        # `create_direct_booking` commits before this runs, so a refusal here
        # would otherwise answer 400 while leaving a draft the caller was never
        # told the id of — and a client that reasonably retries the same POST
        # would raise a second one on every attempt. `submit: true` therefore
        # means submitted or not created; the two-step path is what a caller
        # uses when it wants the draft to survive an incomplete form.
        try:
            ticket_service.submit_request(db, current_user, booking.request_id)
        except Exception:
            enquiry_service.discard_unsubmitted(db, booking.request_id)
            raise
    return RequestResponse.of(
        enquiry_service.load_with_passengers(db, current_user, booking.request_id)
    )


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
@router.post(
    "/admin/enquiries/{enquiry_id}/review",
    response_model=EnquiryResponse,
    tags=["admin · enquiry"],
    summary="Start review — claim a pending enquiry",
    description=(
        "Requires `ticket.approve`. Moves **Pending -> Under Review** and records the claiming "
        "admin, so a second admin gets a 409 instead of answering the same enquiry. Re-claiming "
        "your own enquiry is a no-op. Returns 409 if another admin holds it, or if it has "
        "already been answered."
    ),
)
def start_enquiry_review(
    enquiry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.TICKET_APPROVE)),
):
    return EnquiryResponse.of(enquiry_service.start_review(db, current_user, enquiry_id))


@router.post(
    "/admin/enquiries/{enquiry_id}/respond",
    response_model=EnquiryResponse,
    tags=["admin · enquiry"],
    summary="Answer a ticket enquiry — send a quotation, or decline",
    description=(
        "`available: true` is **Send Quotation**: it requires `ticket.approve`, a strictly "
        "positive `total_fare` and remarks explaining it, and moves the enquiry to **Approved**, "
        "which is what unlocks Request Ticket for the merchant. `available: false` is a decline: "
        "it requires `ticket.reject`, a mandatory reason, and no fare. Approval stops at Approved "
        "— the enquiry itself never becomes payable. **The quotation is binding (CR-5):** the "
        "booking raised against this enquiry is created at `total_fare`, so it is the figure the "
        "credit limit is checked against and the figure the merchant's wallet is debited at "
        "ticket issuance. The answer is final: a second response returns 409, as does answering "
        "an enquiry another admin is reviewing."
    ),
)
def respond_to_enquiry(
    enquiry_id: int,
    payload: EnquiryRespond,
    db: Session = Depends(get_db),
    # Either code gets you in the door; the branch below then demands the one
    # that actually matches the decision. Gating the whole endpoint on
    # `require_all` would wrongly lock out an approve-only reviewer, and gating
    # it on either alone would let a reject-only account approve — the check
    # has to follow the payload, not the route.
    current_user: User = Depends(require(P.TICKET_APPROVE, P.TICKET_REJECT)),
):
    needed = P.TICKET_APPROVE if payload.available else P.TICKET_REJECT
    if not has_permission(current_user, needed):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Missing required permission: {needed}",
        )

    enquiry = enquiry_service.respond(
        db, current_user, enquiry_id,
        available=payload.available, reason=payload.reason, response=payload.response,
        total_fare=payload.total_fare,
    )
    return EnquiryResponse.of(enquiry)
