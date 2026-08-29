"""Hotel Enquiry — ask the desk about a stay, then wait for a quotation.

    Merchant: New Booking Enquiry -> Hotel Enquiry -> (Pending)
    Admin:    Reviews -> Send Quotation (total fare + remarks) / Decline
    Merchant: sees the quotation on the enquiry

Same shape as Flight's Ticket Enquiry (``enquiry_service.py``) — Pending ->
Under Review -> Approved/Rejected, an admin claims before answering, the
answer is final — but against the standalone ``hotel_enquiries`` table
(migration 0047) rather than a ``service_requests`` row. Deliberately does
**not** import ``app.services.lifecycle``: that module's ``transition()``
enforces an edge matrix built for the general ``ServiceRequest`` lifecycle
(payment, ticketing, cancellation...), none of which a hotel enquiry has —
its whole lifecycle is the four states below, so the edges are checked
directly here rather than through a generic engine sized for a much bigger
one.

THIS MODULE STILL STOPS AT QUOTATION. Raising a booking from an Approved
enquiry is a separate module, ``hotel_booking_service.py`` (migration 0048)
— kept out of here deliberately, so this module's "does not import
lifecycle" boundary stays true. ``quoted_fare`` is what that module copies
into the booking it creates; ``booking_request_id`` (also 0048) is the link
back once it has.
"""
import datetime
from decimal import Decimal

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import HotelEnquiry, HotelEnquiryRoom, HotelRoomChild, RequestStatus as S, ServiceCode, User
from app.services import activity_service, notification_service, service_access_service

#: Reuses the wording every other enquiry screen already renders with —
#: "Approved" means "we have this, go ahead and book" here too.
ENQUIRY_LABELS: dict[S, str] = {
    S.PENDING_APPROVAL: "Pending",
    S.IN_REVIEW: "Under Review",
    S.APPROVED: "Available",
    S.REJECTED: "Not Available",
    S.CANCELLED: "Cancelled",
}

_LOAD_FULL = (
    selectinload(HotelEnquiry.rooms).selectinload(HotelEnquiryRoom.children_ages),
    selectinload(HotelEnquiry.merchant),
    selectinload(HotelEnquiry.user),
    selectinload(HotelEnquiry.reviewer),
    selectinload(HotelEnquiry.booking_request),
)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _next_reference(db: Session) -> str:
    """Allocate ``HTL-20260813-000001`` off the sequence migration 0046 cut."""
    number = db.scalar(select(func.nextval("seq_hotel_enquiry_number")))
    return f"HTL-{_now():%Y%m%d}-{number:06d}"


def _base_filter(actor: User):
    """Enquiries this actor may see: their own company's, or all of them for staff."""
    if actor.is_platform_staff:
        return True
    return HotelEnquiry.merchant_id == actor.merchant_id


# ---------------------------------------------------------------------------
# Merchant
# ---------------------------------------------------------------------------
def create(db: Session, actor: User, payload) -> HotelEnquiry:
    """Raise a hotel enquiry and put it in front of the Admin team."""
    if actor.merchant_id is None:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only merchant accounts can raise hotel enquiries",
        )
    service_access_service.assert_enabled(db, actor, ServiceCode.HOTELS)

    nights = (payload.check_out - payload.check_in).days

    enquiry = HotelEnquiry(
        merchant_id=actor.merchant_id,
        user_id=actor.user_id,
        enquiry_reference=_next_reference(db),
        destination_city=payload.destination_city.strip(),
        check_in_date=payload.check_in,
        check_out_date=payload.check_out,
        number_of_nights=nights,
        hotel_name=payload.hotel_name,
        star_category=payload.star_category,
        room_type=payload.room_type,
        pan=payload.pan,
        meal_plan=payload.meal_plan,
        special_requirements=payload.special_requirements,
        preferred_location=payload.preferred_location,
        client_fare=payload.client_fare,
        status=S.PENDING_APPROVAL,
    )
    for i, room_in in enumerate(payload.rooms, start=1):
        room = HotelEnquiryRoom(room_number=i, adults=room_in.adults, children=room_in.children)
        room.children_ages = [HotelRoomChild(child_age=age) for age in room_in.child_ages]
        enquiry.rooms.append(room)

    db.add(enquiry)
    db.commit()
    db.refresh(enquiry)
    # Reload with rooms/relationships eagerly attached for the response build.
    enquiry = _get_full(db, enquiry.id)

    activity_service.log_activity(
        db, actor.user_id, "Hotel enquiry raised",
        activity_type="Enquiry", module="Hotel Enquiry",
        description=f"{actor.full_name} raised {enquiry.enquiry_reference}",
        reference_id=enquiry.id, merchant_id=actor.merchant_id,
    )
    notification_service.notify_admins(
        db, "New hotel enquiry",
        f"{enquiry.enquiry_reference} — {enquiry.destination_city} — needs a response.",
    )
    return enquiry


def list_enquiries(
    db: Session, actor: User, *, page: int = 1, page_size: int = 20,
    request_status: S | None = None, merchant_id: int | None = None,
    search: str | None = None,
) -> tuple[list[HotelEnquiry], int]:
    # READING HOTEL DATA IS ALSO USING HOTELS.
    # This used to be gated by `ticket.view` alone, which asks whether the USER
    # may see enquiries — never whether their COMPANY has the product. A
    # merchant whose Hotels entitlement was switched off kept full API access
    # to every hotel enquiry they had already raised: the module vanished from
    # the portal while the data stayed readable. Same helper the create path
    # uses, so there is one rule and it bypasses for platform staff.
    service_access_service.assert_enabled(db, actor, ServiceCode.HOTELS)

    conditions = [_base_filter(actor)]
    if request_status is not None:
        conditions.append(HotelEnquiry.status == request_status)
    if merchant_id is not None and actor.is_platform_staff:
        conditions.append(HotelEnquiry.merchant_id == merchant_id)
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(
            HotelEnquiry.enquiry_reference.ilike(pattern),
            HotelEnquiry.destination_city.ilike(pattern),
            HotelEnquiry.hotel_name.ilike(pattern),
        ))

    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(HotelEnquiry).where(where)) or 0
    rows = db.scalars(
        select(HotelEnquiry)
        .where(where)
        .options(*_LOAD_FULL)
        .order_by(HotelEnquiry.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return list(rows), total


def _get_full(db: Session, enquiry_id: int) -> HotelEnquiry | None:
    return db.scalars(
        select(HotelEnquiry).where(HotelEnquiry.id == enquiry_id).options(*_LOAD_FULL)
    ).first()


def get(db: Session, actor: User, enquiry_id: int) -> HotelEnquiry:
    # Entitlement first, ownership second — see list_enquiries. Checked before
    # the row is looked up so a merchant without the product gets the same
    # answer for every id, rather than a 403 for their own enquiries and a 404
    # for everyone else's, which would say which ids exist.
    service_access_service.assert_enabled(db, actor, ServiceCode.HOTELS)

    enquiry = db.scalars(
        select(HotelEnquiry)
        .where(and_(HotelEnquiry.id == enquiry_id, _base_filter(actor)))
        .options(*_LOAD_FULL)
    ).first()
    if not enquiry:
        # 404 not 403 — never confirm another merchant's enquiry exists.
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Enquiry not found")
    return enquiry


def _locked(db: Session, actor: User, enquiry_id: int) -> HotelEnquiry:
    """Re-read under a row lock, for the actions that mutate status.

    Same reasoning as enquiry_service._locked: two admins answering the same
    enquiry at once must not both succeed.
    """
    enquiry = db.scalars(
        select(HotelEnquiry)
        .where(and_(HotelEnquiry.id == enquiry_id, _base_filter(actor)))
        .with_for_update(of=HotelEnquiry)
    ).first()
    if not enquiry:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Enquiry not found")
    return enquiry


def _guard_not_answered(enquiry: HotelEnquiry) -> None:
    if enquiry.status in (S.APPROVED, S.REJECTED, S.CANCELLED):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{enquiry.enquiry_reference} has already been answered — it is "
                f"{ENQUIRY_LABELS.get(enquiry.status, enquiry.status.value)}. "
                "An answered enquiry cannot be changed; ask the merchant to raise a new one."
            ),
        )


def _guard_claim(enquiry: HotelEnquiry, actor: User) -> None:
    if (
        enquiry.status is S.IN_REVIEW
        and enquiry.review_claimed_by is not None
        and enquiry.review_claimed_by != actor.user_id
    ):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{enquiry.reviewer.full_name if enquiry.reviewer else 'Another admin'} "
                f"is already reviewing {enquiry.enquiry_reference}. Only they can answer it."
            ),
        )


def _audit(
    db: Session, actor: User, enquiry: HotelEnquiry, action: str,
    *, before: S, after: S, note: str | None = None,
) -> None:
    activity_service.log_activity(
        db, actor.user_id, action,
        activity_type="Enquiry", module="Hotel Enquiry",
        description=(
            f"{actor.full_name} moved {enquiry.enquiry_reference} from "
            f"{ENQUIRY_LABELS.get(before, before.value)} to "
            f"{ENQUIRY_LABELS.get(after, after.value)}"
        ),
        reference_id=enquiry.id, merchant_id=enquiry.merchant_id,
        details={
            "enquiry_reference": enquiry.enquiry_reference,
            "from_status": before.value,
            "to_status": after.value,
            "actor_id": actor.user_id,
            "actor_name": actor.full_name,
            "merchant_name": enquiry.merchant.company_name if enquiry.merchant else None,
            **({"note": note} if note else {}),
        },
    )


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------
def start_review(db: Session, actor: User, enquiry_id: int) -> HotelEnquiry:
    """Claim a Pending enquiry: Pending -> Under Review, owned by this admin.

    Re-claiming your own enquiry is a no-op, same as the flight side.
    """
    enquiry = _locked(db, actor, enquiry_id)
    _guard_not_answered(enquiry)

    if enquiry.status is S.IN_REVIEW:
        if enquiry.review_claimed_by == actor.user_id:
            return _get_full(db, enquiry.id)
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{enquiry.reviewer.full_name if enquiry.reviewer else 'Another admin'} "
                f"is already reviewing {enquiry.enquiry_reference}."
            ),
        )

    before = enquiry.status
    enquiry.status = S.IN_REVIEW
    enquiry.review_claimed_by = actor.user_id
    enquiry.review_claimed_at = _now()
    db.commit()

    _audit(db, actor, enquiry, "Hotel enquiry review started", before=before, after=S.IN_REVIEW)
    return _get_full(db, enquiry.id)


def respond(
    db: Session, actor: User, enquiry_id: int, *, available: bool,
    reason: str | None = None, response: str | None = None,
    total_fare: Decimal | None = None,
) -> HotelEnquiry:
    """Answer an enquiry: a quotation, or a decline. Mirrors enquiry_service.respond."""
    from app.services import finance_service

    enquiry = _locked(db, actor, enquiry_id)
    _guard_not_answered(enquiry)
    _guard_claim(enquiry, actor)

    before = enquiry.status
    if response:
        enquiry.admin_response = response

    if not available:
        enquiry.status = S.REJECTED
        enquiry.rejection_reason = reason
        enquiry.responded_at = _now()
        db.commit()

        _audit(db, actor, enquiry, "Hotel enquiry declined", before=before, after=S.REJECTED, note=reason)
        notification_service.notify_request_merchant(
            db, enquiry, "Hotel enquiry: declined",
            f"{enquiry.enquiry_reference} — {reason or 'this stay is not available.'}",
        )
        return _get_full(db, enquiry.id)

    fare = finance_service.q(total_fare)
    enquiry.quoted_fare = fare
    enquiry.quotation_remarks = (reason or "").strip() or None
    enquiry.status = S.APPROVED
    enquiry.responded_at = _now()
    db.commit()

    quote_note = f"Quoted {fare}" + (f" — {enquiry.quotation_remarks}" if enquiry.quotation_remarks else "")
    _audit(db, actor, enquiry, "Hotel enquiry quoted", before=before, after=S.APPROVED, note=quote_note)
    notification_service.notify_request_merchant(
        db, enquiry, "Hotel enquiry: quotation received",
        f"{enquiry.enquiry_reference} has been quoted at INR {fare}.",
    )
    return _get_full(db, enquiry.id)
