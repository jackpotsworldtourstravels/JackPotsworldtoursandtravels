"""Cancellation and reschedule — what happens when a booking moves backwards.

WHERE THIS SITS
``ticket_service`` walks a booking forwards (approve → pay → issue → complete)
and ``booking_ops_service`` is the desk that works it alongside that lifecycle.
This module owns the two ways a confirmed booking stops going forwards: the
merchant wants it **cancelled**, or wants it **moved to another date**.

WHY IT IS NOT ``ticket_service.create_service_request``
That function already exists and stays — it is the generic hook for baggage,
meals, seats and passenger tweaks, none of which touch the booking itself or
any money. Cancellation and reschedule are different in three ways that a
generic "raise a request, admin says yes" hook cannot express:

* they **settle money** (a cancellation charge and a refund; a fare difference
  and a change fee), which has to be quoted, bounded and recorded;
* they **change the parent booking** — one cancels it outright, the other
  rewrites its itinerary — so the effect has to be applied transactionally
  under a lock, not left as an implication of an approval;
* only **one** may be open against a booking at a time, or two admins settle
  two different outcomes onto the same seat.

WHO QUOTES THE MONEY
The merchant asks; **staff quote**. A merchant cannot state its own
cancellation charge any more than it can state its own fare — the charge comes
from the airline's rules and is entered by the operator at approval time. Until
then the request carries no amounts at all, which is why ``total_amount`` stays
zero on a pending request rather than holding a number nobody has agreed to.

WHAT THIS DOES NOT DO
Move money. Recording that ₹21,500 is refundable is not the same as refunding
it; the payment ledger settles in M4. The refund position is written here so
that milestone has something real and already-agreed to settle against.
"""
import datetime
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, or_, select, true
from sqlalchemy.orm import Session, selectinload

from app.auth.rbac import P, has_permission
from app.models_v2 import (
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    User,
)
from app.services import (
    activity_service,
    catalog_service,
    finance_service,
    lifecycle,
    notification_service,
)

#: The two request types this module owns. The other members of
#: ``ticket_service.SERVICE_REQUEST_TYPES`` keep going through the generic hook.
CHANGE_TYPES: tuple[RequestType, ...] = (RequestType.CANCELLATION, RequestType.DATE_CHANGE)

#: Parent-booking statuses a change may be raised against.
#:
#: ``COMPLETED`` is deliberately absent: the trip has happened, and "cancel a
#: journey that was already flown" is a refund/dispute conversation, not a
#: cancellation. ``DRAFT``/``PENDING_APPROVAL``/``IN_REVIEW`` are absent too —
#: nothing is committed yet, so the merchant simply cancels the request itself
#: through ``POST /api/requests/{id}/cancel``, free of charge.
CHANGEABLE_PARENT_STATUSES: frozenset[S] = frozenset({
    S.APPROVED, S.PAYMENT_PENDING, S.PAID, S.TICKET_ISSUED,
})

#: A change request that is still being worked. Exactly one of these may exist
#: per booking at a time.
OPEN_STATUSES: frozenset[S] = frozenset({S.DRAFT, S.PENDING_APPROVAL, S.IN_REVIEW})

#: Statuses a change request can end at, for the queue's tab badges.
QUEUE_STAGES: tuple[S, ...] = (S.PENDING_APPROVAL, S.IN_REVIEW, S.APPROVED, S.REJECTED, S.CANCELLED)

TYPE_LABELS: dict[RequestType, str] = {
    RequestType.CANCELLATION: "Cancellation",
    RequestType.DATE_CHANGE: "Reschedule",
}


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _today() -> datetime.date:
    return datetime.date.today()


# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------
def _money(value, field: str, *, allow_zero: bool = True) -> Decimal:
    """Parse an amount, or refuse it with a sentence naming the field.

    Accepts a string as well as a number: the API takes amounts as strings so a
    client's float rounding cannot reach the ledger, and ``Decimal(str)`` is the
    only conversion that preserves what was actually sent.
    """
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"{field} must be an amount, e.g. \"1500.00\"",
        )
    if amount < 0:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"{field} cannot be negative",
        )
    if amount == 0 and not allow_zero:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"{field} must be greater than zero",
        )
    return amount.quantize(Decimal("0.01"))


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------
def _scope(actor: User):
    """WHERE terms honouring who may see what.

    Contributes no join, so it is safe to combine with ``FOR UPDATE`` — Postgres
    refuses a row lock on the nullable side of an outer join.
    """
    if actor.is_platform_staff:
        return true()
    return ServiceRequest.merchant_id == actor.merchant_id


def _booking(db: Session, actor: User, booking_id: int, *, lock: bool = False) -> ServiceRequest:
    """The parent booking a change is raised against."""
    stmt = select(ServiceRequest).where(
        and_(ServiceRequest.request_id == booking_id, _scope(actor))
    )
    if lock:
        stmt = stmt.with_for_update()
    booking = db.scalars(stmt).first()
    if not booking or booking.request_type is not RequestType.BOOKING:
        # 404 rather than 403 — a response must not confirm that another
        # company's booking exists.
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Booking not found"
        )
    return booking


def _change(db: Session, actor: User, request_id: int, *, lock: bool = False) -> ServiceRequest:
    """One change request this actor may see."""
    stmt = select(ServiceRequest).where(
        and_(ServiceRequest.request_id == request_id, _scope(actor))
    )
    if lock:
        stmt = stmt.with_for_update()
    request = db.scalars(stmt).first()
    if not request or request.request_type not in CHANGE_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Change request not found"
        )
    return request


def _reviewer(request: ServiceRequest) -> tuple[int | None, str | None]:
    d = request.travel_details or {}
    return d.get("review_claimed_by"), d.get("review_claimed_by_name")


def _guard_claim(request: ServiceRequest, actor: User) -> None:
    """Refuse a second admin settling one already under someone else's review.

    Same rule as the enquiry desk (Phase 2), for the same reason: two people
    quoting two different cancellation charges on one booking is worse than one
    of them being told to wait.
    """
    holder_id, holder_name = _reviewer(request)
    if request.status is S.IN_REVIEW and holder_id is not None and holder_id != actor.user_id:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'Another admin'} is already reviewing "
                f"{request.request_number}. Only they can settle it."
            ),
        )


def _guard_open(request: ServiceRequest) -> None:
    if request.status not in OPEN_STATUSES:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{request.request_number} is already "
                f"{lifecycle.SPEC_LABELS.get(request.status, request.status.value)} — "
                "it cannot be settled again."
            ),
        )


def _open_change_for(db: Session, booking_id: int) -> ServiceRequest | None:
    """Any change request still being worked against this booking."""
    return db.scalars(
        select(ServiceRequest).where(
            and_(
                ServiceRequest.parent_request_id == booking_id,
                ServiceRequest.request_type.in_(CHANGE_TYPES),
                ServiceRequest.status.in_(tuple(OPEN_STATUSES)),
            )
        )
    ).first()


# ---------------------------------------------------------------------------
# Raising
# ---------------------------------------------------------------------------
def _raise(
    db: Session,
    actor: User,
    booking_id: int,
    request_type: RequestType,
    *,
    reason: str,
    details: dict,
) -> ServiceRequest:
    """Create a change request against a booking and submit it for approval.

    The parent is locked for the duration: the "is one already open?" check and
    the insert have to be one atomic step, or two merchant users clicking
    Cancel at the same moment both pass the check and both insert.
    """
    from app.services.ticket_service import _next_number  # local: avoids a cycle

    text = (reason or "").strip()
    if not text:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Tell us why — a reason is required.",
        )

    booking = _booking(db, actor, booking_id, lock=True)

    if booking.status not in CHANGEABLE_PARENT_STATUSES:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{booking.request_number} is "
                f"{lifecycle.SPEC_LABELS.get(booking.status, booking.status.value)}, so it "
                f"cannot be {'cancelled' if request_type is RequestType.CANCELLATION else 'rescheduled'}. "
                + (
                    "A booking that has not been confirmed yet is withdrawn from the booking "
                    "itself, at no charge."
                    if booking.status in (S.DRAFT, S.PENDING_APPROVAL, S.IN_REVIEW)
                    else "This booking is closed."
                )
            ),
        )

    existing = _open_change_for(db, booking.request_id)
    if existing:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{TYPE_LABELS.get(existing.request_type, 'A change')} request "
                f"{existing.request_number} is already open against "
                f"{booking.request_number}. Settle or withdraw it first."
            ),
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
        title=f"{TYPE_LABELS[request_type]} — {booking.request_number}",
        remarks=text,
        travel_details={
            **details,
            "reason": text,
            "booking_request_number": booking.request_number,
            "booking_status_at_request": booking.status.value,
        },
        # No amounts yet, on purpose: staff quote them at approval. A number
        # here would be one nobody has agreed to.
        pricing={},
        total_amount=Decimal("0.00"),
        status_history=[],
    )
    db.add(request)
    db.commit()
    db.refresh(request)

    # Straight to Pending: a change request has no draft stage the merchant
    # edits, unlike a booking.
    lifecycle.transition(db, request, S.PENDING_APPROVAL, actor)

    activity_service.log_activity(
        db, actor.user_id, f"{TYPE_LABELS[request_type]} requested",
        activity_type="Change Request", module="Cancellation & Reschedule",
        description=(
            f"{actor.full_name} raised {request.request_number} "
            f"({TYPE_LABELS[request_type].lower()}) against {booking.request_number}"
        ),
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details={
            "request_number": request.request_number,
            "booking_request_number": booking.request_number,
            "change_type": request_type.value,
            "reason": text,
            **details,
        },
    )
    notification_service.notify_admins(
        db,
        f"{TYPE_LABELS[request_type]} requested",
        f"{request.request_number}: {booking.request_number} "
        f"({booking.merchant.company_name if booking.merchant else 'a merchant'}) — {text}",
    )
    return request


def raise_cancellation(db: Session, actor: User, booking_id: int, *, reason: str) -> ServiceRequest:
    """Merchant asks for a confirmed booking to be cancelled."""
    return _raise(db, actor, booking_id, RequestType.CANCELLATION, reason=reason, details={})


def raise_reschedule(
    db: Session,
    actor: User,
    booking_id: int,
    *,
    new_travel_date: datetime.date,
    new_return_date: datetime.date | None = None,
    reason: str,
) -> ServiceRequest:
    """Merchant asks for a confirmed booking to be moved to another date."""
    booking = _booking(db, actor, booking_id)

    if new_travel_date <= _today():
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="The new travel date must be in the future.",
        )
    if booking.travel_date and new_travel_date == booking.travel_date:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{booking.request_number} already departs on "
                f"{new_travel_date:%d %b %Y} — pick a different date."
            ),
        )
    if new_return_date and new_return_date < new_travel_date:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="The return date cannot be before the new travel date.",
        )

    return _raise(
        db, actor, booking_id, RequestType.DATE_CHANGE, reason=reason,
        details={
            "new_travel_date": new_travel_date.isoformat(),
            "new_return_date": new_return_date.isoformat() if new_return_date else None,
            "current_travel_date": booking.travel_date.isoformat() if booking.travel_date else None,
            "current_return_date": booking.return_date.isoformat() if booking.return_date else None,
        },
    )


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def list_change_requests(
    db: Session,
    actor: User,
    *,
    page: int = 1,
    page_size: int = 20,
    request_type: RequestType | None = None,
    request_status: S | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
) -> tuple[list[ServiceRequest], int]:
    """Change requests, newest first.

    Newest-first rather than the booking queue's oldest-first: this is a review
    list a merchant also reads, and the thing a merchant wants first is the one
    they just raised.
    """
    conditions = [ServiceRequest.request_type.in_(CHANGE_TYPES), _scope(actor)]
    if request_type is not None:
        if request_type not in CHANGE_TYPES:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="type must be one of: cancellation, date_change",
            )
        conditions.append(ServiceRequest.request_type == request_type)
    if request_status is not None:
        conditions.append(ServiceRequest.status == request_status)
    if merchant_id is not None:
        conditions.append(ServiceRequest.merchant_id == merchant_id)
    if search:
        pattern = f"%{search.strip()}%"
        conditions.append(
            or_(
                ServiceRequest.request_number.ilike(pattern),
                ServiceRequest.booking_reference.ilike(pattern),
                ServiceRequest.pnr.ilike(pattern),
                ServiceRequest.title.ilike(pattern),
            )
        )

    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    items = list(
        db.scalars(
            select(ServiceRequest)
            # The list renders the merchant company on every row.
            .options(selectinload(ServiceRequest.merchant))
            .where(where)
            .order_by(ServiceRequest.request_id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        ).all()
    )
    return items, total


def stage_counts(db: Session, actor: User) -> dict[str, int]:
    """Tab badges. One grouped query, not one per tab."""
    where = and_(ServiceRequest.request_type.in_(CHANGE_TYPES), _scope(actor))
    rows = db.execute(
        select(ServiceRequest.status, func.count()).where(where).group_by(ServiceRequest.status)
    ).all()

    counts = {s.value: 0 for s in QUEUE_STAGES}
    for status, n in rows:
        counts[status.value] = counts.get(status.value, 0) + n
    counts["open"] = sum(counts.get(s.value, 0) for s in (S.PENDING_APPROVAL, S.IN_REVIEW))
    counts["total"] = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    return counts


def get_change_request(db: Session, actor: User, request_id: int) -> ServiceRequest:
    return _change(db, actor, request_id)


def for_booking(db: Session, actor: User, booking_id: int) -> list[ServiceRequest]:
    """Every change ever raised against one booking, newest first."""
    booking = _booking(db, actor, booking_id)
    return list(
        db.scalars(
            select(ServiceRequest)
            .where(
                and_(
                    ServiceRequest.parent_request_id == booking.request_id,
                    ServiceRequest.request_type.in_(CHANGE_TYPES),
                )
            )
            .order_by(ServiceRequest.request_id.desc())
        ).all()
    )


def parent_booking(db: Session, request: ServiceRequest) -> ServiceRequest | None:
    return db.get(ServiceRequest, request.parent_request_id) if request.parent_request_id else None


# ---------------------------------------------------------------------------
# Merchant-side settlement
# ---------------------------------------------------------------------------
def withdraw(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Merchant takes back a change request nobody has picked up yet.

    Allowed only while it is still Pending. Once an operator has claimed it they
    are on the phone to the airline, and letting the request vanish underneath
    them is how a seat gets released twice.
    """
    request = _change(db, actor, request_id, lock=True)
    _guard_open(request)

    if request.status is S.IN_REVIEW:
        holder_id, holder_name = _reviewer(request)
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'An operator'} has already started work on "
                f"{request.request_number}. Ask them to reject it instead."
            ),
        )

    lifecycle.transition(
        db, request, S.CANCELLED, actor,
        reason="Withdrawn by the merchant", commit=False,
    )
    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, f"{TYPE_LABELS[request.request_type]} withdrawn",
        activity_type="Change Request", module="Cancellation & Reschedule",
        description=f"{actor.full_name} withdrew {request.request_number}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details={"request_number": request.request_number},
    )
    notification_service.notify_admins(
        db, f"{TYPE_LABELS[request.request_type]} withdrawn",
        f"{request.request_number} was withdrawn by the merchant.",
    )
    return request


# ---------------------------------------------------------------------------
# Staff-side settlement
# ---------------------------------------------------------------------------
def start_review(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Claim a pending change request: Pending -> Under Review, owned by you.

    Re-claiming your own is a no-op rather than an error — reopening the panel
    should not be punished.
    """
    request = _change(db, actor, request_id, lock=True)
    _guard_open(request)

    holder_id, holder_name = _reviewer(request)
    if request.status is S.IN_REVIEW:
        if holder_id == actor.user_id:
            return request
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'Another admin'} is already reviewing "
                f"{request.request_number}."
            ),
        )

    lifecycle.transition(db, request, S.IN_REVIEW, actor, commit=False)
    # Reassigned, not mutated: SQLAlchemy does not track in-place JSONB changes.
    request.travel_details = {
        **(request.travel_details or {}),
        "review_claimed_by": actor.user_id,
        "review_claimed_by_name": actor.full_name,
        "review_claimed_at": _now().isoformat(),
    }
    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, f"{TYPE_LABELS[request.request_type]} review started",
        activity_type="Change Request", module="Cancellation & Reschedule",
        description=f"{actor.full_name} started reviewing {request.request_number}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details={"request_number": request.request_number},
    )
    return request


def _quote_cancellation(booking: ServiceRequest, charge) -> tuple[dict, Decimal]:
    """Bound the cancellation charge against what was actually booked."""
    booking_amount = Decimal(booking.total_amount or 0).quantize(Decimal("0.01"))
    amount = _money(charge if charge is not None else 0, "cancellation_charge")
    if amount > booking_amount:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"A cancellation charge of {amount} is more than the booking itself "
                f"({booking_amount}). The charge cannot exceed what was booked."
            ),
        )
    refund = (booking_amount - amount).quantize(Decimal("0.01"))
    return {
        "kind": "cancellation",
        "booking_amount": str(booking_amount),
        "cancellation_charge": str(amount),
        "refund_amount": str(refund),
    }, refund


def _quote_reschedule(booking: ServiceRequest, fare_difference, change_fee) -> tuple[dict, Decimal]:
    """Price a date change.

    A date change never produces a refund, even onto a cheaper fare — airlines
    do not refund down-fares on a reissue, and a negative payable here would
    silently create a credit nobody agreed to. A merchant who wants money back
    cancels instead, which is the path that computes a refund.
    """
    difference = _money(fare_difference if fare_difference is not None else 0, "fare_difference")
    fee = _money(change_fee if change_fee is not None else 0, "change_fee")
    payable = (difference + fee).quantize(Decimal("0.01"))
    return {
        "kind": "reschedule",
        "booking_amount": str(Decimal(booking.total_amount or 0).quantize(Decimal("0.01"))),
        "fare_difference": str(difference),
        "change_fee": str(fee),
        "total_payable": str(payable),
    }, payable


def approve(
    db: Session,
    actor: User,
    request_id: int,
    *,
    cancellation_charge=None,
    fare_difference=None,
    change_fee=None,
    note: str | None = None,
) -> ServiceRequest:
    """Settle a change request in the merchant's favour, and apply it.

    Both the change request and its parent booking are locked before anything
    is read, so two admins approving the same cancellation cannot both walk the
    parent to Cancelled, and a cancellation racing a reschedule on one booking
    is serialised rather than interleaved.

    The amounts are quoted **here**, by staff, and bounded against the booking.
    """
    request = _change(db, actor, request_id, lock=True)
    _guard_open(request)
    _guard_claim(request, actor)

    booking = db.scalars(
        select(ServiceRequest)
        .where(ServiceRequest.request_id == request.parent_request_id)
        .with_for_update()
    ).first()
    if booking is None:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=f"{request.request_number} no longer has a booking attached.",
        )
    # Re-checked under the lock, not merely at raise time: the booking may have
    # been completed or cancelled by another path while this sat in the queue.
    if booking.status not in CHANGEABLE_PARENT_STATUSES:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{booking.request_number} is now "
                f"{lifecycle.SPEC_LABELS.get(booking.status, booking.status.value)} and can no "
                f"longer be changed. Reject {request.request_number} instead."
            ),
        )

    if request.request_type is RequestType.CANCELLATION:
        pricing, amount = _quote_cancellation(booking, cancellation_charge)
        summary = f"refund {pricing['refund_amount']} after a charge of {pricing['cancellation_charge']}"
    else:
        pricing, amount = _quote_reschedule(booking, fare_difference, change_fee)
        summary = f"payable {pricing['total_payable']}"

    pricing.update({
        "quoted_by": actor.user_id,
        "quoted_by_name": actor.full_name,
        "quoted_at": _now().isoformat(),
        "currency": (booking.pricing or {}).get("currency", "INR"),
    })

    # Claim it if nobody had: approving straight from the list is normal, and
    # the timeline should still show the Under Review step it passed through.
    if request.status is S.PENDING_APPROVAL:
        lifecycle.transition(db, request, S.IN_REVIEW, actor, commit=False)

    # A COPY, not ``pricing`` itself. The cancellation branch below mutates
    # ``pricing`` and reassigns it, and ``settle_refund`` runs a query on the way
    # — which autoflushes. After that flush the attribute's committed baseline
    # *is* the object it was assigned; mutating that same object in place moves
    # the baseline too, so the reassignment that follows compares equal to it and
    # SQLAlchemy emits no UPDATE. The refund settlement figures were written in
    # memory and silently dropped at commit. Copying here keeps ``pricing`` a
    # plain local, which is what the rest of this function assumes.
    request.pricing = dict(pricing)
    request.total_amount = amount
    lifecycle.transition(db, request, S.APPROVED, actor, note=note or summary, commit=False)

    # ---- apply the effect to the parent booking -------------------------
    if request.request_type is RequestType.CANCELLATION:
        # Catalog-led bookings hold inventory; give the seats back. Enquiry-led
        # ones have no catalog parent and this is a no-op.
        if booking.parent_request_id:
            catalog_service.release_units(
                db, db.get(ServiceRequest, booking.parent_request_id), booking.quantity
            )
        lifecycle.transition(
            db, booking, S.CANCELLED, actor,
            reason=f"{request.request_number}: {request.remarks}",
            note=summary, commit=False, settlement=True,
        )
        applied = {"booking_status": S.CANCELLED.value}

        # ---- settle the refund against the ledger (M4) ------------------
        # M3 computed the refund position and deliberately stopped there. Now
        # the money actually moves: the refund is written onto the booking's own
        # payments, clamped to what those payments took. A cancellation on an
        # unpaid booking refunds nothing and is not an error — there is simply
        # nothing to give back, and `settled_refund` says 0 rather than lying.
        wanted = _money(pricing.get("refund_amount") or 0, "refund_amount")
        refundable = finance_service.refundable_against(db, booking)
        settled = min(wanted, refundable)
        if settled > 0:
            finance_service.settle_refund(
                db, booking, settled, actor_id=actor.user_id,
                reason=f"{request.request_number}: cancellation refund",
                commit=False,
            )
        applied.update({
            "refund_due": str(wanted),
            "refund_settled": str(settled),
            "refund_unsettled": str(wanted - settled),
        })
        pricing["refund_settled"] = str(settled)
        # Recorded so the desk can see a refund that could not be completed
        # from this booking's own payments — it needs a manual disbursement,
        # and a silent shortfall is exactly the class of bug M4 exists to stop.
        pricing["refund_unsettled"] = str(wanted - settled)
        request.pricing = dict(pricing)
    else:
        details = request.travel_details or {}
        previous = {
            "travel_date": booking.travel_date.isoformat() if booking.travel_date else None,
            "return_date": booking.return_date.isoformat() if booking.return_date else None,
        }
        booking.travel_date = datetime.date.fromisoformat(details["new_travel_date"])
        booking.return_date = (
            datetime.date.fromisoformat(details["new_return_date"])
            if details.get("new_return_date") else None
        )
        # The itinerary change is not a status change, so it would leave no
        # trace in status_history. Recorded on the booking itself instead, as a
        # list rather than a single field — a booking can be moved twice.
        booking.travel_details = {
            **(booking.travel_details or {}),
            "reschedule_history": list((booking.travel_details or {}).get("reschedule_history") or [])
            + [{
                "change_request": request.request_number,
                "from": previous,
                "to": {
                    "travel_date": details["new_travel_date"],
                    "return_date": details.get("new_return_date"),
                },
                "by": actor.user_id,
                "by_name": actor.full_name,
                "at": _now().isoformat(),
                "payable": pricing["total_payable"],
            }],
        }
        applied = {
            "booking_status": booking.status.value,
            "travel_date": details["new_travel_date"],
            "previous_travel_date": previous["travel_date"],
        }

    db.commit()
    db.refresh(request)
    db.refresh(booking)

    activity_service.log_activity(
        db, actor.user_id, f"{TYPE_LABELS[request.request_type]} approved",
        activity_type="Change Request", module="Cancellation & Reschedule",
        description=(
            f"{actor.full_name} approved {request.request_number} on "
            f"{booking.request_number} — {summary}"
        ),
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details={
            "request_number": request.request_number,
            "booking_request_number": booking.request_number,
            "change_type": request.request_type.value,
            "pricing": pricing,
            **applied,
        },
    )

    if request.request_type is RequestType.CANCELLATION:
        message = (
            f"{booking.request_number} is cancelled. Cancellation charge "
            f"{pricing['cancellation_charge']}, refund due {pricing['refund_amount']}."
        )
    else:
        message = (
            f"{booking.request_number} now departs "
            f"{booking.travel_date:%d %b %Y}. Amount payable {pricing['total_payable']}."
        )
    notification_service.notify_request_merchant(
        db, request, f"{TYPE_LABELS[request.request_type]} approved", message
    )
    return request


def reject(db: Session, actor: User, request_id: int, reason: str) -> ServiceRequest:
    """Refuse a change request. The parent booking is left exactly as it was."""
    text = (reason or "").strip()
    if not text:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="A reason is required when refusing a change request.",
        )

    request = _change(db, actor, request_id, lock=True)
    _guard_open(request)
    _guard_claim(request, actor)

    lifecycle.transition(db, request, S.REJECTED, actor, reason=text, commit=False)
    db.commit()
    db.refresh(request)

    booking = parent_booking(db, request)
    activity_service.log_activity(
        db, actor.user_id, f"{TYPE_LABELS[request.request_type]} rejected",
        activity_type="Change Request", module="Cancellation & Reschedule",
        description=f"{actor.full_name} rejected {request.request_number}: {text}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details={
            "request_number": request.request_number,
            "booking_request_number": booking.request_number if booking else None,
            "reason": text,
        },
    )
    notification_service.notify_request_merchant(
        db, request, f"{TYPE_LABELS[request.request_type]} rejected",
        f"{request.request_number} was not approved. Reason: {text}",
    )
    return request


# ---------------------------------------------------------------------------
# UI helpers
# ---------------------------------------------------------------------------
def can_raise(booking: ServiceRequest, actor: User) -> bool:
    """Whether the merchant may raise a change against this booking right now.

    Drives the buttons on the booking detail screen, so the UI offers nothing
    the server would refuse.
    """
    return (
        booking.request_type is RequestType.BOOKING
        and booking.status in CHANGEABLE_PARENT_STATUSES
        and has_permission(actor, P.SERVICE_REQUEST_CREATE)
    )
