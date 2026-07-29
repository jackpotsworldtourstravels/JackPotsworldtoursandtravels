"""Ticket request lifecycle — the spec's core transaction.

    Merchant: Ticket Enquiry -> Passenger Details -> Select Flight
              -> Review Price -> Submit Request
    Admin:    Receives -> Check Availability -> Approve / Reject
    Merchant: Pays -> Admin Verifies -> Ticket Issued -> Downloads Ticket

Every status change goes through :mod:`app.services.lifecycle`, which owns
the state machine and writes the timeline. Nothing here assigns
``request.status`` directly.

Money and inventory are never taken from the request body: prices are
recomputed from the catalog row and seats are decremented under a row lock
at submit time.
"""
import datetime
import secrets
import string
from decimal import Decimal

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.auth.rbac import P, has_permission
from app.models_v2 import (
    Merchant,
    PassengerData,
    Payment,
    PaymentStatus,
    PaymentType,
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    TravelType,
    User,
)
from app.services import (
    activity_service,
    catalog_service,
    lifecycle,
    merchant_service,
    notification_service,
)

#: Request types a merchant raises against a booking.
SERVICE_REQUEST_TYPES = (
    RequestType.CANCELLATION,
    RequestType.DATE_CHANGE,
    RequestType.REFUND,
    RequestType.PASSENGER_MODIFICATION,
    RequestType.EXTRA_BAGGAGE,
    RequestType.MEAL,
    RequestType.SEAT,
)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _pnr() -> str:
    """Six-character alphanumeric PNR, ambiguous glyphs removed."""
    alphabet = "".join(c for c in string.ascii_uppercase + string.digits if c not in "O0I1")
    return "".join(secrets.choice(alphabet) for _ in range(6))


#: Document prefix -> the PostgreSQL sequence backing it (migration 0028).
_SEQUENCES = {
    "REQ": "seq_request_number",
    "SRQ": "seq_service_request_number",
    "TKT": "seq_ticket_number",
    "INV": "seq_invoice_number",
}


def _next_number(db: Session, prefix: str) -> str:
    """Allocate a human-readable document number, e.g. ``REQ-2026-000123``.

    Backed by a PostgreSQL sequence rather than ``count(*) + 1``: allocation
    is atomic, so two concurrent issuances cannot collide, and it does not
    depend on scanning existing rows. See migration 0028 for the two bugs
    the counting version had.
    """
    sequence = _SEQUENCES[prefix]
    number = db.scalar(select(func.nextval(sequence)))
    return f"{prefix}-{_now().year}-{number:06d}"


# ---------------------------------------------------------------------------
# Visibility
# ---------------------------------------------------------------------------
def scoped_query(actor: User):
    """Base filter honouring who may see what.

    Platform staff see every merchant's requests; a merchant sees only its
    own. Applied in the query rather than filtered afterwards, so a paginated
    count can never leak another company's totals.
    """
    conditions = [ServiceRequest.request_type != RequestType.CATALOG_ITEM]
    if not actor.is_platform_staff:
        conditions.append(ServiceRequest.merchant_id == actor.merchant_id)
    return and_(*conditions)


def get_request(db: Session, actor: User, request_id: int) -> ServiceRequest:
    stmt = (
        select(ServiceRequest)
        .options(selectinload(ServiceRequest.passengers))
        .where(and_(ServiceRequest.request_id == request_id, scoped_query(actor)))
    )
    request = db.scalars(stmt).first()
    if not request:
        # 404 rather than 403 — don't confirm another merchant's request exists.
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Request not found")
    return request


def list_requests(
    db: Session,
    actor: User,
    *,
    page: int = 1,
    page_size: int = 20,
    request_type: RequestType | None = None,
    request_status: S | None = None,
    travel_type: TravelType | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
) -> tuple[list[ServiceRequest], int]:
    """Advanced search: PNR, passenger name, merchant, status, date, route."""
    conditions = [scoped_query(actor)]

    if request_type is not None:
        conditions.append(ServiceRequest.request_type == request_type)
    if request_status is not None:
        conditions.append(ServiceRequest.status == request_status)
    if travel_type is not None:
        conditions.append(ServiceRequest.travel_type == travel_type)
    if merchant_id is not None and actor.is_platform_staff:
        conditions.append(ServiceRequest.merchant_id == merchant_id)
    if date_from is not None:
        conditions.append(ServiceRequest.travel_date >= date_from)
    if date_to is not None:
        conditions.append(ServiceRequest.travel_date <= date_to)

    if search:
        pattern = f"%{search}%"
        passenger_match = (
            select(PassengerData.request_id)
            .where(
                or_(
                    PassengerData.first_name.ilike(pattern),
                    PassengerData.last_name.ilike(pattern),
                    PassengerData.passport_number.ilike(pattern),
                )
            )
            .scalar_subquery()
        )
        conditions.append(
            or_(
                ServiceRequest.pnr.ilike(pattern),
                ServiceRequest.request_number.ilike(pattern),
                ServiceRequest.booking_reference.ilike(pattern),
                ServiceRequest.ticket_number.ilike(pattern),
                ServiceRequest.title.ilike(pattern),
                ServiceRequest.travel_details["destination_city"].astext.ilike(pattern),
                ServiceRequest.travel_details["destination"].astext.ilike(pattern),
                ServiceRequest.request_id.in_(passenger_match),
            )
        )

    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    stmt = (
        select(ServiceRequest)
        .options(selectinload(ServiceRequest.passengers))
        .where(where)
        .order_by(ServiceRequest.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.scalars(stmt).all()), total


# ---------------------------------------------------------------------------
# Merchant: create and submit
# ---------------------------------------------------------------------------
def create_booking_request(
    db: Session,
    actor: User,
    *,
    catalog_item_id: int,
    passengers: list[dict],
    travel_date: datetime.date | None = None,
    return_date: datetime.date | None = None,
    remarks: str | None = None,
) -> ServiceRequest:
    """Create a draft booking against a catalog item.

    Starts at ``draft`` (the spec's "Created"). Nothing is reserved and no
    approval is sought until :func:`submit_request` is called.
    """
    if actor.merchant_id is None:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only merchant accounts can raise ticket requests",
        )
    if not passengers:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one passenger is required",
        )

    item = catalog_service.get_item(db, catalog_item_id)
    merchant = db.get(Merchant, actor.merchant_id)
    priced = catalog_service.quote(item, len(passengers))

    request = ServiceRequest(
        request_number=_next_number(db, "REQ"),
        parent_request_id=item.request_id,
        merchant_id=actor.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.BOOKING,
        booking_reference=merchant_service.next_booking_reference(db, merchant),
        travel_type=item.travel_type,
        status=S.DRAFT,
        title=item.title,
        remarks=remarks,
        # Snapshot the catalog attributes: the fare can change later, but
        # what was bought must not.
        travel_details=dict(item.travel_details or {}),
        pricing={k: str(v) if isinstance(v, Decimal) else v for k, v in priced.items()},
        quantity=len(passengers),
        total_amount=priced["total"],
        travel_date=travel_date or item.travel_date,
        return_date=return_date or item.return_date,
        status_history=[],
    )
    db.add(request)
    db.flush()

    for p in passengers:
        db.add(
            PassengerData(
                request_id=request.request_id,
                merchant_id=actor.merchant_id,
                **p,
            )
        )

    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, "Ticket request created",
        activity_type="Booking", module="Ticket Request",
        description=f"{actor.full_name} drafted {request.request_number}",
        reference_id=request.request_id, merchant_id=actor.merchant_id,
    )
    return request


def update_draft(
    db: Session, actor: User, request_id: int, *, remarks: str | None = None,
    travel_date: datetime.date | None = None, return_date: datetime.date | None = None,
) -> ServiceRequest:
    request = get_request(db, actor, request_id)
    if request.status not in lifecycle.EDITABLE_STATUSES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"A request that is {lifecycle.SPEC_LABELS.get(request.status)} can no longer be edited",
        )
    if remarks is not None:
        request.remarks = remarks
    if travel_date is not None:
        request.travel_date = travel_date
    if return_date is not None:
        request.return_date = return_date
    db.commit()
    db.refresh(request)
    return request


def replace_passengers(
    db: Session, actor: User, request_id: int, passengers: list[dict]
) -> ServiceRequest:
    """Replace the passenger list on a draft and reprice accordingly."""
    request = get_request(db, actor, request_id)
    if request.status not in lifecycle.EDITABLE_STATUSES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Passengers can only be changed while the request is a draft",
        )
    if not passengers:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one passenger is required",
        )

    for existing in list(request.passengers):
        db.delete(existing)
    db.flush()

    for p in passengers:
        db.add(
            PassengerData(request_id=request.request_id, merchant_id=request.merchant_id, **p)
        )

    if request.parent_request_id:
        item = db.get(ServiceRequest, request.parent_request_id)
        if item is not None:
            priced = catalog_service.quote(item, len(passengers))
            request.pricing = {
                k: str(v) if isinstance(v, Decimal) else v for k, v in priced.items()
            }
            request.total_amount = priced["total"]
    request.quantity = len(passengers)

    db.commit()
    db.refresh(request)
    return request


def submit_request(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Submit a draft for Admin approval, reserving inventory as it goes."""
    request = get_request(db, actor, request_id)
    if not request.passengers:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Add at least one passenger before submitting",
        )

    if request.parent_request_id:
        item = db.get(ServiceRequest, request.parent_request_id)
        if item is not None:
            catalog_service.reserve_units(db, item, request.quantity)

    lifecycle.transition(db, request, S.PENDING_APPROVAL, actor, commit=False)
    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, "Ticket request submitted",
        activity_type="Booking", module="Ticket Request",
        description=f"{actor.full_name} submitted {request.request_number} for approval",
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    notification_service.notify_admins(
        db,
        "New ticket request awaiting approval",
        f"{request.request_number} from "
        f"{request.merchant.company_name if request.merchant else 'a merchant'} "
        f"needs review.",
    )
    return request


# ---------------------------------------------------------------------------
# Admin: approve / reject
# ---------------------------------------------------------------------------
def approve_request(
    db: Session, actor: User, request_id: int, *, final_amount: Decimal | None = None,
    note: str | None = None,
) -> ServiceRequest:
    """Approve and move straight to Payment Pending.

    The spec has Approved and Payment Pending as separate stages but no
    action between them, so both edges are walked here — the timeline still
    records each one.
    """
    request = get_request(db, actor, request_id)

    if final_amount is not None:
        if final_amount < 0:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="Final amount cannot be negative",
            )
        request.total_amount = final_amount
        request.pricing = {**(request.pricing or {}), "final_amount": str(final_amount)}

    if request.status is S.PENDING_APPROVAL:
        lifecycle.transition(db, request, S.IN_REVIEW, actor, commit=False)
    lifecycle.transition(db, request, S.APPROVED, actor, note=note, commit=False)
    lifecycle.transition(db, request, S.PAYMENT_PENDING, actor, commit=False)

    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, "Ticket request approved",
        activity_type="Booking", module="Ticket Approval",
        description=f"{actor.full_name} approved {request.request_number}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    _notify_merchant(
        db, request, "Your request was approved",
        f"{request.request_number} is approved. Amount due: {request.total_amount}.",
    )
    return request


def reject_request(db: Session, actor: User, request_id: int, reason: str) -> ServiceRequest:
    request = get_request(db, actor, request_id)

    if request.parent_request_id:
        catalog_service.release_units(
            db, db.get(ServiceRequest, request.parent_request_id), request.quantity
        )

    lifecycle.transition(db, request, S.REJECTED, actor, reason=reason, commit=False)
    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, "Ticket request rejected",
        activity_type="Booking", module="Ticket Approval",
        description=f"{actor.full_name} rejected {request.request_number}: {reason}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    _notify_merchant(
        db, request, "Your request was rejected",
        f"{request.request_number} was rejected. Reason: {reason}",
    )
    return request


def cancel_request(db: Session, actor: User, request_id: int, reason: str | None = None) -> ServiceRequest:
    request = get_request(db, actor, request_id)
    if request.parent_request_id:
        catalog_service.release_units(
            db, db.get(ServiceRequest, request.parent_request_id), request.quantity
        )
    lifecycle.transition(db, request, S.CANCELLED, actor, reason=reason, commit=False)
    db.commit()
    db.refresh(request)
    return request


# ---------------------------------------------------------------------------
# Payment -> verification -> issuance
# ---------------------------------------------------------------------------
def record_payment(
    db: Session, actor: User, request_id: int, *, amount: Decimal, method: str,
    transaction_id: str | None = None,
) -> Payment:
    """Merchant pays. Lands as ``pending`` until an Admin verifies it."""
    request = get_request(db, actor, request_id)
    if request.status is not S.PAYMENT_PENDING:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Payment is only accepted while a request is Payment Pending — "
                f"this one is {lifecycle.SPEC_LABELS.get(request.status)}"
            ),
        )
    if amount <= 0:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Amount must be positive"
        )

    payment = Payment(
        merchant_id=request.merchant_id,
        request_id=request.request_id,
        user_id=actor.user_id,
        amount=amount,
        payment_type=PaymentType.BOOKING_PAYMENT,
        payment_method=method,
        transaction_id=transaction_id,
        payment_status=PaymentStatus.PENDING,
        paid_date=_now(),
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)

    activity_service.log_activity(
        db, actor.user_id, "Payment submitted",
        activity_type="Payment", module="Payments",
        description=f"{actor.full_name} paid {amount} against {request.request_number}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    notification_service.notify_admins(
        db, "Payment awaiting verification",
        f"{request.request_number}: {amount} submitted and needs verification.",
    )
    return payment


def verify_payment(db: Session, actor: User, payment_id: int, *, approve: bool = True,
                   note: str | None = None) -> Payment:
    """Admin verifies a submitted payment, moving the request to Paid."""
    payment = db.get(Payment, payment_id)
    if not payment:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Payment not found")
    if payment.payment_status is not PaymentStatus.PENDING:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Payment is already {payment.payment_status.value}",
        )

    request = db.get(ServiceRequest, payment.request_id) if payment.request_id else None

    if not approve:
        payment.payment_status = PaymentStatus.FAILED
        payment.refund_reason = note
        db.commit()
        db.refresh(payment)
        if request:
            _notify_merchant(
                db, request, "Payment could not be verified",
                f"{request.request_number}: {note or 'Please check the transaction reference.'}",
            )
        return payment

    payment.payment_status = PaymentStatus.SUCCESS
    db.flush()

    if request is not None:
        lifecycle.transition(db, request, S.PAID, actor, note=note, commit=False)
    db.commit()
    db.refresh(payment)

    activity_service.log_activity(
        db, actor.user_id, "Payment verified",
        activity_type="Payment", module="Payments",
        description=f"{actor.full_name} verified payment {payment.payment_id}",
        reference_id=payment.request_id, merchant_id=payment.merchant_id,
    )
    if request:
        _notify_merchant(
            db, request, "Payment verified",
            f"{request.request_number}: payment confirmed. Your ticket will be issued shortly.",
        )
    return payment


def refund_payment(
    db: Session, actor: User, payment_id: int, *, amount: Decimal, reason: str
) -> Payment:
    """Admin issues a refund against a successful payment (API_CONTRACT.md §4.3).

    Mirrors how :func:`verify_payment` updates state in place rather than walking the request
    lifecycle: a refund changes the *payment*, not the booking's approval status — a merchant
    raising a Refund service request (Phase 2) is the path that actually cancels/adjusts the
    booking itself.
    """
    payment = db.get(Payment, payment_id)
    if not payment:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Payment not found")
    if payment.payment_status is not PaymentStatus.SUCCESS:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Only a successful payment can be refunded — this one is {payment.payment_status.value}",
        )
    already_refunded = payment.refund_amount or Decimal("0")
    if already_refunded + amount > payment.amount:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Refund would exceed the original payment amount ({payment.amount})",
        )

    payment.refund_amount = already_refunded + amount
    payment.refund_reason = reason
    payment.refunded_at = _now()
    payment.payment_status = (
        PaymentStatus.REFUNDED if payment.refund_amount >= payment.amount
        else PaymentStatus.PARTIALLY_REFUNDED
    )
    db.commit()
    db.refresh(payment)

    activity_service.log_activity(
        db, actor.user_id, "Payment refunded",
        activity_type="Payment", module="Payments",
        description=f"{actor.full_name} refunded {amount} on payment {payment.payment_id}: {reason}",
        reference_id=payment.request_id, merchant_id=payment.merchant_id,
    )
    request = db.get(ServiceRequest, payment.request_id) if payment.request_id else None
    if request:
        _notify_merchant(
            db, request, "Payment refunded",
            f"{request.request_number}: {amount} refunded. Reason: {reason}",
        )
    return payment


def issue_ticket(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Issue the ticket: allocate PNR, ticket and invoice numbers."""
    request = get_request(db, actor, request_id)

    # Validate the transition *before* allocating any numbers. Sequences are
    # non-transactional: a nextval survives the rollback that an illegal
    # transition triggers, so allocating first would burn a ticket and
    # invoice number on every rejected attempt and leave permanent gaps in
    # the invoice series.
    lifecycle.transition(db, request, S.TICKET_ISSUED, actor, commit=False)

    if not request.pnr:
        request.pnr = _pnr()
    if not request.ticket_number:
        request.ticket_number = _next_number(db, "TKT")
    if not request.invoice_number:
        request.invoice_number = _next_number(db, "INV")

    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, "Ticket issued",
        activity_type="Booking", module="Ticket Issuance",
        description=f"{actor.full_name} issued {request.ticket_number} for {request.request_number}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    _notify_merchant(
        db, request, "Your ticket has been issued",
        f"{request.request_number} — PNR {request.pnr}. You can now download the ticket and invoice.",
    )
    return request


def complete_request(db: Session, actor: User, request_id: int) -> ServiceRequest:
    request = get_request(db, actor, request_id)
    lifecycle.transition(db, request, S.COMPLETED, actor, commit=False)
    db.commit()
    db.refresh(request)
    return request


# ---------------------------------------------------------------------------
# Service requests raised against an issued booking
# ---------------------------------------------------------------------------
def create_service_request(
    db: Session,
    actor: User,
    *,
    booking_id: int,
    request_type: RequestType,
    remarks: str,
    details: dict | None = None,
) -> ServiceRequest:
    """Raise a change request (cancellation, date change, baggage, ...)."""
    if request_type not in SERVICE_REQUEST_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"'{request_type.value}' is not a service request type",
        )
    booking = get_request(db, actor, booking_id)
    if booking.request_type is not RequestType.BOOKING:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Service requests must be raised against a booking",
        )
    if booking.status not in (S.APPROVED, S.PAYMENT_PENDING, S.PAID, S.TICKET_ISSUED, S.COMPLETED):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="This booking is not yet confirmed, so it cannot be changed",
        )

    request = ServiceRequest(
        request_number=_next_number(db, "SRQ"),
        parent_request_id=booking.request_id,
        merchant_id=booking.merchant_id,
        user_id=actor.user_id,
        request_type=request_type,
        booking_reference=booking.booking_reference,
        pnr=booking.pnr,
        travel_type=booking.travel_type,
        status=S.DRAFT,
        title=f"{request_type.value.replace('_', ' ').title()} — {booking.request_number}",
        remarks=remarks,
        travel_details=details or {},
        status_history=[],
    )
    db.add(request)
    db.commit()
    db.refresh(request)

    lifecycle.transition(db, request, S.PENDING_APPROVAL, actor)

    activity_service.log_activity(
        db, actor.user_id, "Service request raised",
        activity_type="Service Request", module="Service Requests",
        description=f"{actor.full_name} raised {request.request_number} ({request_type.value})",
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    notification_service.notify_admins(
        db, "New service request",
        f"{request.request_number} ({request_type.value.replace('_', ' ')}) needs attention.",
    )
    return request


def resolve_service_request(
    db: Session, actor: User, request_id: int, *, approve: bool, reason: str | None = None
) -> ServiceRequest:
    """Admin approves or rejects a change request, then marks it completed."""
    request = get_request(db, actor, request_id)
    if request.request_type not in SERVICE_REQUEST_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Not a service request",
        )

    if not approve:
        lifecycle.transition(db, request, S.REJECTED, actor, reason=reason, commit=False)
        db.commit()
        db.refresh(request)
        _notify_merchant(
            db, request, "Service request rejected",
            f"{request.request_number}: {reason or 'no reason given'}",
        )
        return request

    if request.status is S.PENDING_APPROVAL:
        lifecycle.transition(db, request, S.IN_REVIEW, actor, commit=False)
    lifecycle.transition(db, request, S.APPROVED, actor, note=reason, commit=False)
    db.commit()
    db.refresh(request)
    _notify_merchant(
        db, request, "Service request approved",
        f"{request.request_number} has been approved and is being processed.",
    )
    return request


def _notify_merchant(db: Session, request: ServiceRequest, title: str, message: str) -> None:
    """Notify whoever raised the request, falling back to the company's admins."""
    if request.user_id:
        notification_service.create_notification(db, request.user_id, title, message)
        return
    if request.merchant is None:
        return
    for user in request.merchant.users:
        notification_service.create_notification(db, user.user_id, title, message)


def action_menu(request: ServiceRequest, actor: User) -> list[dict]:
    """What this actor may do to this request right now — drives the UI."""
    return [
        {"to": t.to.value, "label": t.label, "requires_reason": t.requires_reason}
        for t in lifecycle.allowed_transitions(request, actor)
    ]


def can_download(request: ServiceRequest, actor: User) -> bool:
    return request.status in (S.TICKET_ISSUED, S.COMPLETED) and (
        actor.is_platform_staff or actor.merchant_id == request.merchant_id
    ) and has_permission(actor, P.TICKET_VIEW)
