"""Hotel Booking — a quoted hotel enquiry becomes a service_requests row.

    Merchant: Raise Booking (on an Approved hotel enquiry) -> guest capture
    Manager:  Approves like any other booking (manager_service, unchanged)
    Admin:    Books with a supplier, issues a voucher (ticket_service, unchanged)

Sibling to ``hotel_enquiry_service.py``, not an extension of it — that
module's own docstring says it deliberately does not import
``app.services.lifecycle``, and this module is exactly the reason that
boundary exists: once a hotel enquiry converts, everything downstream
(Manager Approval, ticket/voucher issuance, wallet billing, invoice PDFs,
Booking History, Reports) is the SAME generic ``service_requests`` machinery
Flight already uses. Converging onto that table — rather than a parallel
``hotel_bookings`` implementation of all of that — is the whole point of this
module. See migration 0048's docstring for the full reasoning.

``hotel_enquiry_service._locked`` is reused rather than duplicated (row-lock
semantics for "two Raise Booking clicks landing together must not both
succeed" are identical to the enquiry module's own re-answer race).
"""
import datetime
from decimal import Decimal

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, select
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import (
    HotelBookingGuest,
    HotelEnquiry,
    Merchant,
    PassengerType,
    RequestStatus as S,
    RequestType,
    ServiceCode,
    ServiceRequest,
    TravelType,
    User,
)
from app.services import (
    activity_service,
    finance_service,
    hotel_enquiry_service,
    merchant_service,
    service_access_service,
    ticket_service,
)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _validate_guest_composition_against_rooms(rooms: list[dict], guests: list) -> None:
    """The room-shape-agnostic half of guest-composition validation.

    ``rooms`` is a plain ``[{"room_number", "adults", "children"}, ...]`` —
    deliberately not an ORM relationship, so this same check works whether
    the room composition came from an already-quoted enquiry
    (:func:`_validate_guest_composition`) or was submitted in the same
    request as the guests themselves (a direct booking, which has no
    enquiry to read rooms from at all).
    """
    rooms_by_number = {room["room_number"]: room for room in rooms}
    unknown = sorted({g.room_number for g in guests} - set(rooms_by_number))
    if unknown:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Room(s) {unknown} were never asked about on this enquiry",
        )

    for room_number, room in rooms_by_number.items():
        room_guests = [g for g in guests if g.room_number == room_number]
        adults = sum(1 for g in room_guests if g.guest_type is PassengerType.ADULT)
        children = sum(1 for g in room_guests if g.guest_type is PassengerType.CHILD)
        infants = sum(1 for g in room_guests if g.guest_type is PassengerType.INFANT)
        if infants:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="A hotel guest cannot be marked as an infant — this enquiry only quoted adults and children",
            )
        if adults != room["adults"]:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Room {room_number} was quoted for {room['adults']} adult(s), "
                    f"but {adults} were entered"
                ),
            )
        if children != room["children"]:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Room {room_number} was quoted for {room['children']} child(ren), "
                    f"but {children} were entered"
                ),
            )


def _validate_guest_composition(enquiry: HotelEnquiry, guests: list) -> None:
    """A booking's guests must match the room/child composition the enquiry
    was quoted against — the same invariant ``hotel_enquiry_rooms`` and
    ``hotel_room_children`` already enforce at the enquiry stage, re-checked
    here because the booking form is a second, independent point of entry.
    """
    rooms = [
        {"room_number": room.room_number, "adults": room.adults, "children": room.children}
        for room in enquiry.rooms
    ]
    _validate_guest_composition_against_rooms(rooms, guests)


def to_booking_request(
    db: Session, actor: User, enquiry_id: int, *, guests: list, remarks: str | None = None,
    contact: dict | None = None, special_requests: str | None = None,
    client_fare: Decimal | None = None,
) -> ServiceRequest:
    """Create the draft booking the Raise Booking button leads to.

    The stay itself is copied from the enquiry rather than accepted from the
    caller, so the booking that reaches Manager Approval is the stay the
    Admin actually quoted. Only the guests are new. ``parent_request_id`` is
    left ``None`` — unlike a Flight booking, there is no ``service_requests``
    row for the enquiry to parent to (the enquiry lives in its own table);
    the enquiry<->booking link is carried instead by
    ``hotel_enquiries.booking_request_id``.
    """
    # Gated on CURRENT access, not on whatever was true when the enquiry was
    # raised: this creates a brand-new service_requests row, so it is "new
    # creation" exactly like raising the enquiry itself was — an Admin
    # turning Hotels off must stop a NEW booking from being drafted here, the
    # same way hotel_enquiry_service.create() already stops a new enquiry.
    # The enquiry and any booking already made from it are untouched.
    service_access_service.assert_enabled(db, actor, ServiceCode.HOTELS)

    enquiry = hotel_enquiry_service._locked(db, actor, enquiry_id)

    if enquiry.status is not S.APPROVED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                "Only an enquiry our team has quoted can be turned into a booking — "
                f"this one is {hotel_enquiry_service.ENQUIRY_LABELS.get(enquiry.status, enquiry.status.value)}"
            ),
        )
    if enquiry.booking_request_id is not None:
        existing = db.get(ServiceRequest, enquiry.booking_request_id)
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"This enquiry has already been booked as "
                f"{existing.request_number if existing else enquiry.booking_request_id}"
            ),
        )

    _validate_guest_composition(enquiry, guests)

    # A hotel enquiry cannot reach APPROVED without a quotation (see
    # hotel_enquiry_service.respond) — unlike Flight there is no pre-CR-5
    # historical row with no quotation to fall back for.
    fare = finance_service.q(enquiry.quoted_fare)

    merchant = db.get(Merchant, enquiry.merchant_id)
    booking = ServiceRequest(
        request_number=ticket_service._next_number(db, "REQ"),
        parent_request_id=None,
        merchant_id=enquiry.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.BOOKING,
        booking_reference=merchant_service.next_booking_reference(db, merchant),
        travel_type=TravelType.HOTEL,
        status=S.DRAFT,
        title=f"Hotel — {enquiry.destination_city}",
        remarks=remarks,
        # Prefer a value in THIS call's payload; fall back to the one the
        # enquiry carried. `is not None`, not a truth test — 0 is a real
        # client fare. Mirrors enquiry_service.to_booking_request exactly:
        # Client Fare is stated once, on the form that describes the stay,
        # and this is what makes omitting it here (see classic-booking-
        # hotel.js) leave that value standing rather than clearing it.
        client_fare=client_fare if client_fare is not None else enquiry.client_fare,
        # `hotel_enquiry_reference` is the CLASSIC_MARKER_KEYS entry
        # (lifecycle.py) that puts this booking on the no-payment,
        # Manager-approval-then-voucher track, same as Flight's
        # `enquiry_reference`/`direct_booking` markers.
        travel_details={
            "hotel_enquiry_reference": enquiry.enquiry_reference,
            "hotel_enquiry_id": enquiry.id,
            "destination_city": enquiry.destination_city,
            "hotel_name": enquiry.hotel_name,
            "star_category": enquiry.star_category,
            "room_type": enquiry.room_type,
            "meal_plan": enquiry.meal_plan,
            "preferred_location": enquiry.preferred_location,
            "special_requirements": enquiry.special_requirements,
            "pan": enquiry.pan,
            "nights": enquiry.number_of_nights,
            "rooms": [
                {
                    "room_number": room.room_number,
                    "adults": room.adults,
                    "children": room.children,
                    "child_ages": [c.child_age for c in room.children_ages],
                }
                for room in enquiry.rooms
            ],
            "contact": contact or {},
            "special_requests": (special_requests or "").strip() or None,
            "quoted_fare": str(fare),
            "quotation_remarks": enquiry.quotation_remarks,
        },
        pricing={
            "currency": "INR",
            "quoted": True,
            "source": "hotel_enquiry",
            "final_amount": str(fare),
            "priced_at": "enquiry_quotation",
        },
        quantity=len(guests),
        total_amount=fare,
        travel_date=enquiry.check_in_date,
        return_date=enquiry.check_out_date,
        status_history=[],
    )
    db.add(booking)
    db.flush()

    for g in guests:
        db.add(
            HotelBookingGuest(
                booking_request_id=booking.request_id,
                room_number=g.room_number,
                is_lead_guest=g.is_lead_guest,
                title=g.title,
                first_name=g.first_name,
                last_name=g.last_name,
                guest_type=g.guest_type,
                age=g.age,
                id_proof_type=g.id_proof_type,
                id_proof_number=g.id_proof_number,
            )
        )

    # Stamp the link back so the enquiry listing shows the booking instead of
    # offering Raise Booking a second time — the DB's partial unique index
    # (migration 0048) is the belt-and-braces backstop for this same rule.
    enquiry.booking_request_id = booking.request_id

    db.commit()
    db.refresh(booking)

    activity_service.log_activity(
        db, actor.user_id, "Hotel booking request created from enquiry",
        activity_type="Booking", module="Hotel Booking",
        description=(
            f"{actor.full_name} drafted {booking.request_number} "
            f"from hotel enquiry {enquiry.enquiry_reference}"
        ),
        reference_id=booking.request_id, merchant_id=booking.merchant_id,
    )
    return booking


def create_direct_booking(db: Session, actor: User, payload) -> ServiceRequest:
    """Book Directly for Hotel — skip the enquiry/quotation step entirely.

    Mirrors ``enquiry_service.create_direct_booking`` field-for-field: no
    enquiry to copy the stay from (the merchant states it here), no
    quotation, so the booking is created at ``0`` and priced when platform
    staff issue the voucher — the same ``_capture_fare_for_wallet_billing``
    path Flight's own direct booking already uses, unchanged, because it was
    never travel_type-specific to begin with.

    ``"direct_booking": True`` is the SAME ``CLASSIC_MARKER_KEYS`` entry
    Flight's direct path already writes (``lifecycle.py``) — reusing the
    literal key rather than minting a ``hotel_direct_booking`` one, since
    ``is_classic_track``/``is_wallet_billed`` only ever check for the key's
    *existence*, never which travel_type wrote it.
    """
    service_access_service.assert_enabled(db, actor, ServiceCode.HOTELS)

    rooms = [
        {"room_number": i, "adults": r.adults, "children": r.children, "child_ages": r.child_ages}
        for i, r in enumerate(payload.rooms, start=1)
    ]
    _validate_guest_composition_against_rooms(
        [{"room_number": r["room_number"], "adults": r["adults"], "children": r["children"]} for r in rooms],
        payload.guests,
    )

    destination = payload.destination_city.strip()
    nights = (payload.check_out - payload.check_in).days

    merchant = db.get(Merchant, actor.merchant_id)
    booking = ServiceRequest(
        request_number=ticket_service._next_number(db, "REQ"),
        parent_request_id=None,
        merchant_id=actor.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.BOOKING,
        booking_reference=merchant_service.next_booking_reference(db, merchant),
        travel_type=TravelType.HOTEL,
        status=S.DRAFT,
        title=f"Hotel — {destination}",
        remarks=payload.remarks,
        client_fare=payload.client_fare,
        travel_details={
            "direct_booking": True,
            "destination_city": destination,
            "hotel_name": payload.hotel_name,
            "star_category": payload.star_category,
            "room_type": payload.room_type,
            "meal_plan": payload.meal_plan,
            "preferred_location": payload.preferred_location,
            "special_requirements": payload.special_requirements,
            "pan": payload.pan,
            "nights": nights,
            "rooms": rooms,
            "contact": payload.contact.model_dump() if payload.contact else {},
            "special_requests": (payload.special_requests or "").strip() or None,
        },
        pricing={
            "currency": "INR",
            "quoted": False,
            "source": "direct_booking",
        },
        quantity=len(payload.guests),
        total_amount=Decimal("0"),
        travel_date=payload.check_in,
        return_date=payload.check_out,
        status_history=[],
    )
    db.add(booking)
    db.flush()

    for g in payload.guests:
        db.add(
            HotelBookingGuest(
                booking_request_id=booking.request_id,
                room_number=g.room_number,
                is_lead_guest=g.is_lead_guest,
                title=g.title,
                first_name=g.first_name,
                last_name=g.last_name,
                guest_type=g.guest_type,
                age=g.age,
                id_proof_type=g.id_proof_type,
                id_proof_number=g.id_proof_number,
            )
        )

    db.commit()
    db.refresh(booking)

    activity_service.log_activity(
        db, actor.user_id, "Hotel booking request created directly",
        activity_type="Booking", module="Hotel Booking",
        description=f"{actor.full_name} drafted {booking.request_number} without a hotel enquiry",
        reference_id=booking.request_id, merchant_id=booking.merchant_id,
    )
    return booking


def load_with_guests(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Re-read a booking with its guests eagerly loaded, for the response.

    Mirrors ``enquiry_service.load_with_passengers`` — avoids a lazy-load
    query when ``RequestResponse.of()`` immediately reads ``hotel_guests``.
    """
    return db.scalars(
        select(ServiceRequest)
        .options(selectinload(ServiceRequest.hotel_guests))
        .where(
            and_(
                ServiceRequest.request_id == request_id,
                ticket_service.scoped_query(actor),
            )
        )
    ).one()
