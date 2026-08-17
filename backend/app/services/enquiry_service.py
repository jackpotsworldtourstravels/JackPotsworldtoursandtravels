"""Ticket Enquiry — ask the desk about a sector, then book what it quotes.

    Merchant: Enquire Ticket -> (Pending)
    Admin:    Reviews -> Send Quotation (total fare + remarks) / Decline
    Merchant: Request Ticket -> Booking Request at the quoted fare -> Submit

Called **Booking Enquiry** in the merchant portal since CR-5 and **Ticket
Enquiry** everywhere on the staff side, which is a deliberate split: the
merchant is starting a booking, the desk is working an enquiry queue. The
stored ``request_type`` is ``ticket_enquiry`` either way — the difference is
wording, and it lives entirely in the two UIs.

THE QUOTATION IS BINDING (CR-5)
The admin's positive answer carries a total fare and the remarks explaining it.
That fare is copied onto the booking's ``total_amount`` by
:func:`to_booking_request`, which makes it the figure the credit limit is
checked against at submission and approval, and the figure the merchant's
wallet is debited at ticket issuance. Before CR-5 the answer was a bare
availability flag and the booking sat at zero until the desk typed a number in
at issuance; bookings raised under those rules still finish under them, because
an enquiry with no ``quoted_fare`` still produces a zero-amount booking.

WHERE AN ENQUIRY LIVES
In ``service_requests``, as ``request_type = 'ticket_enquiry'`` — a value the
enum has carried since migration 0023, reserved for exactly this. The form
fields sit in ``travel_details`` JSONB, which is how every other request type
in this schema stores its type-specific payload. **No new table, no schema
change**; migration 0030 adds only the ENQ reference sequence.

The keys written into ``travel_details`` (``origin``, ``destination``,
``origin_city``, ``destination_city``, ``airline``, ``flight_number``) are
deliberately the same keys catalog items use. That is not decoration:
``ticket_service.list_requests`` already searches
``travel_details['destination_city']``, and the Classic request-detail modal
already renders those keys as an itinerary — so an enquiry reads correctly on
screens that were written before it existed.

STATUS
Enquiries reuse the shared lifecycle rather than inventing a parallel one:

    pending_approval  the spec's "Pending"      — with our team
    in_review         Admin has picked it up
    approved          "Available for booking"   — unlocks Request Ticket
    rejected          not available             — reason required
    cancelled         withdrawn by the merchant

There is no draft stage: an enquiry is submitted the instant it is created,
so :func:`create` writes the row at ``pending_approval`` with the matching
history entry, exactly as ``create_booking_request`` writes its rows at
``draft``. Every later move goes through :mod:`app.services.lifecycle`.
"""
import datetime
import logging
from decimal import Decimal

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import (
    Merchant,
    PassengerData,
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
    group_booking_service,
    lifecycle,
    merchant_service,
    notification_service,
    service_access_service,
    ticket_service,
)

# NOTE: ServiceCode/service_access_service stay imported — Flight enquiries
# are still gated by ServiceCode.FLIGHTS below. Hotel enquiries moved to their
# own table and their own service (hotel_enquiry_service.py); this module no
# longer branches on travel_type at all.

logger = logging.getLogger("jackpots.enquiry")


#: Enquiry wording for the shared statuses. ``lifecycle.SPEC_LABELS`` says
#: "Approved"/"Rejected", which are right for a booking but read wrongly here —
#: an approved enquiry means "we have this, go ahead and book". The stored
#: status is untouched; only the wording differs, and the Classic merchant UI
#: uses the same map so both surfaces say the same thing.
ENQUIRY_LABELS: dict[S, str] = {
    S.PENDING_APPROVAL: "Pending",
    S.IN_REVIEW: "Under Review",
    S.APPROVED: "Available",
    S.REJECTED: "Not Available",
    S.CANCELLED: "Cancelled",
}


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _next_reference(db: Session) -> str:
    """Allocate ``ENQ-20260730-000123``.

    Date-stamped rather than year-stamped (the spec's format), and backed by
    the sequence migration 0030 adds so two concurrent enquiries cannot
    collide on ``uq_service_requests_number``.
    """
    number = db.scalar(select(func.nextval("seq_enquiry_number")))
    return f"ENQ-{_now():%Y%m%d}-{number:06d}"


def _title(payload) -> str:
    """What the enquiry is called on every screen that lists requests.

    The flight number is upper-cased here for the same reason it is in
    ``travel_details``: the merchant types "ai217" as readily as "AI217", and a
    title that disagrees with the stored value reads as two different flights.

    BOTH THE AIRLINE AND THE FLIGHT NUMBER ARE OPTIONAL. An open enquiry — no
    carrier named, asking us to quote the best available — is titled by its
    route and says so, rather than trailing the empty space where a carrier
    would have gone. The parts are joined only if they exist, so "All Airlines"
    is the whole of the suffix when neither was given.
    """
    route = f"{payload.origin_city or payload.origin} → {payload.destination_city or payload.destination}"
    airline = (payload.airline or "").strip()
    flight = (payload.flight_number or "").strip().upper()
    carrier = " ".join(p for p in (airline, flight) if p) or "All Airlines"
    return f"Enquiry: {route} · {carrier}"


def _base_filter(actor: User):
    """Enquiries this actor may see, honouring the same scoping as requests."""
    return and_(
        ticket_service.scoped_query(actor),
        ServiceRequest.request_type == RequestType.TICKET_ENQUIRY,
    )


# ---------------------------------------------------------------------------
# Merchant
# ---------------------------------------------------------------------------
def create(db: Session, actor: User, payload) -> ServiceRequest:
    """Raise an enquiry and put it straight in front of the Admin team."""
    if actor.merchant_id is None:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only merchant accounts can raise ticket enquiries",
        )
    # THE GATE. Fires before anything is built, so a merchant whose company
    # lacks Flights access never gets as far as allocating a reference number.
    # Does not run in list_enquiries/get/respond/start_review — disabling a
    # service must block new creation only, never hide or break what already
    # exists (see migration 0045's docstring for the backfill this depends on).
    service_access_service.assert_enabled(db, actor, ServiceCode.FLIGHTS)

    now = _now()
    enquiry = ServiceRequest(
        request_number=_next_reference(db),
        merchant_id=actor.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.TICKET_ENQUIRY,
        # Flight-only by design: the form asks for an airline and a flight
        # number, neither of which a hotel or cruise enquiry would carry.
        # Hotel enquiries are their own table now (hotel_enquiry_service.py).
        travel_type=TravelType.FLIGHT,
        status=S.PENDING_APPROVAL,
        title=_title(payload),
        remarks=payload.notes,
        # Shared with create_direct_booking — see _itinerary_details for why the
        # two forms must not each spell these keys out for themselves.
        travel_details=_itinerary_details(payload),
        quantity=payload.passenger_count,
        # An enquiry asks what a sector costs; it does not owe anything. The
        # amount is set on the booking the Admin approves, not here.
        total_amount=Decimal("0"),
        # 0040 — the merchant's own sell price. A real column, not a
        # travel_details key, because "Total Savings" is a SUM() across every
        # booking on the Dashboard and in Reports. None when not supplied,
        # which is different from zero; see the migration for why.
        client_fare=payload.client_fare,
        travel_date=payload.travel_date,
        return_date=payload.return_date,
        # An enquiry has no draft stage, so the row is born submitted. Writing
        # the history entry here keeps the Activity Timeline complete —
        # lifecycle.transition() owns every *move*, but not the initial value,
        # which create_booking_request also sets directly.
        status_history=[
            {
                "from": S.DRAFT.value,
                "to": S.PENDING_APPROVAL.value,
                "label": "Enquiry submitted",
                "by": actor.user_id,
                "by_name": actor.full_name,
                "at": now.isoformat(),
            }
        ],
    )
    db.add(enquiry)
    db.flush()

    # A group enquiry carries its manifest so the desk quoting it can see the
    # party. The travellers are read back off this same row when the enquiry
    # becomes a booking, which is what saves the merchant uploading twice.
    if getattr(payload, "group_import_id", None) is not None:
        group_booking_service.attach_to_request(
            db, group_booking_service.get(db, actor, payload.group_import_id), enquiry
        )

    db.commit()
    db.refresh(enquiry)

    activity_service.log_activity(
        db, actor.user_id, "Ticket enquiry raised",
        activity_type="Enquiry", module="Ticket Enquiry",
        description=f"{actor.full_name} raised {enquiry.request_number}",
        reference_id=enquiry.request_id, merchant_id=actor.merchant_id,
    )
    notification_service.notify_admins(
        db,
        "New ticket enquiry",
        f"{enquiry.request_number} — {enquiry.title} — needs a response.",
    )
    return enquiry


def list_enquiries(
    db: Session,
    actor: User,
    *,
    page: int = 1,
    page_size: int = 20,
    request_status: S | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
) -> tuple[list[ServiceRequest], int]:
    conditions = [_base_filter(actor)]
    if request_status is not None:
        conditions.append(ServiceRequest.status == request_status)
    if merchant_id is not None and actor.is_platform_staff:
        conditions.append(ServiceRequest.merchant_id == merchant_id)
    if search:
        pattern = f"%{search}%"
        conditions.append(
            ServiceRequest.request_number.ilike(pattern)
            | ServiceRequest.title.ilike(pattern)
            | ServiceRequest.travel_details["flight_number"].astext.ilike(pattern)
            | ServiceRequest.travel_details["destination_city"].astext.ilike(pattern)
            | ServiceRequest.travel_details["origin_city"].astext.ilike(pattern)
        )

    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    rows = db.scalars(
        select(ServiceRequest)
        .where(where)
        .order_by(ServiceRequest.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return list(rows), total


def get(db: Session, actor: User, enquiry_id: int) -> ServiceRequest:
    enquiry = db.scalars(
        select(ServiceRequest).where(
            and_(ServiceRequest.request_id == enquiry_id, _base_filter(actor))
        )
    ).first()
    if not enquiry:
        # 404 not 403 — never confirm another merchant's enquiry exists.
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Enquiry not found"
        )
    return enquiry


def _locked(db: Session, actor: User, enquiry_id: int) -> ServiceRequest:
    """Re-read the enquiry under a row lock, for the actions that mutate it.

    Two admins opening the same enquiry is normal; two admins *answering* it
    at the same instant must not both succeed. ``SELECT ... FOR UPDATE`` makes
    the second caller wait for the first to commit, so its status re-check
    below sees the committed outcome rather than the stale value it loaded
    when the screen was rendered. Checking without the lock would be a
    time-of-check/time-of-use race: both would read *Pending* and both would
    transition.

    ``scoped_query`` contributes only WHERE terms (no outer join), so the lock
    is safe to take here — Postgres refuses FOR UPDATE on the nullable side of
    an outer join.
    """
    enquiry = db.scalars(
        select(ServiceRequest)
        .where(and_(ServiceRequest.request_id == enquiry_id, _base_filter(actor)))
        .with_for_update()
    ).first()
    if not enquiry:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Enquiry not found"
        )
    return enquiry


def _reviewer(enquiry: ServiceRequest) -> tuple[int | None, str | None]:
    d = enquiry.travel_details or {}
    return d.get("review_claimed_by"), d.get("review_claimed_by_name")


def _guard_not_answered(enquiry: ServiceRequest) -> None:
    """An answered enquiry is final — the merchant raises a new one instead."""
    if enquiry.status in (S.APPROVED, S.REJECTED, S.CANCELLED):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{enquiry.request_number} has already been answered — it is "
                f"{ENQUIRY_LABELS.get(enquiry.status, enquiry.status.value)}. "
                "An answered enquiry cannot be changed; ask the merchant to raise a new one."
            ),
        )


def _guard_claim(enquiry: ServiceRequest, actor: User) -> None:
    """Block a second admin from answering one already under someone's review."""
    holder_id, holder_name = _reviewer(enquiry)
    if (
        enquiry.status is S.IN_REVIEW
        and holder_id is not None
        and holder_id != actor.user_id
    ):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'Another admin'} is already reviewing "
                f"{enquiry.request_number}. Only they can answer it."
            ),
        )


def _audit(
    db: Session, actor: User, enquiry: ServiceRequest, action: str,
    *, before: S, after: S, note: str | None = None,
) -> None:
    """One actor-attributed audit entry per admin action.

    The ``audit_logs`` trigger on ``service_requests`` already stores the full
    before/after row, but its ``changed_by`` is always NULL — a DB trigger has
    no idea which application user is behind the connection. This records who,
    when, and the exact status edge, and it is queryable from the Admin
    activity feed.
    """
    activity_service.log_activity(
        db, actor.user_id, action,
        activity_type="Enquiry", module="Ticket Enquiry",
        description=(
            f"{actor.full_name} moved {enquiry.request_number} from "
            f"{ENQUIRY_LABELS.get(before, before.value)} to "
            f"{ENQUIRY_LABELS.get(after, after.value)}"
        ),
        reference_id=enquiry.request_id, merchant_id=enquiry.merchant_id,
        details={
            "enquiry_reference": enquiry.request_number,
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
def start_review(db: Session, actor: User, enquiry_id: int) -> ServiceRequest:
    """Claim a Pending enquiry: Pending -> Under Review, owned by this admin.

    This is what makes **Under Review** a real state rather than a label the
    status filter offers but nothing ever occupies. Claiming is also the
    concurrency gate: :func:`_guard_claim` then refuses an answer from anyone
    but the holder, so two admins cannot work the same enquiry into two
    different outcomes.

    Re-claiming your own enquiry is a no-op rather than an error — an admin who
    reopens the panel should not be punished for it.
    """
    enquiry = _locked(db, actor, enquiry_id)
    _guard_not_answered(enquiry)

    holder_id, holder_name = _reviewer(enquiry)
    if enquiry.status is S.IN_REVIEW:
        if holder_id == actor.user_id:
            return enquiry
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'Another admin'} is already reviewing "
                f"{enquiry.request_number}."
            ),
        )

    before = enquiry.status
    now = _now()
    lifecycle.transition(db, enquiry, S.IN_REVIEW, actor, commit=False)
    # Reassign rather than mutate: SQLAlchemy does not track in-place changes
    # to a JSONB dict.
    enquiry.travel_details = {
        **(enquiry.travel_details or {}),
        "review_claimed_by": actor.user_id,
        "review_claimed_by_name": actor.full_name,
        "review_claimed_at": now.isoformat(),
    }
    db.commit()
    db.refresh(enquiry)

    _audit(db, actor, enquiry, "Ticket enquiry review started",
           before=before, after=S.IN_REVIEW)
    return enquiry


def respond(
    db: Session, actor: User, enquiry_id: int, *, available: bool,
    reason: str | None = None, response: str | None = None,
    total_fare: Decimal | None = None,
) -> ServiceRequest:
    """Answer an enquiry: a **quotation**, or a decline.

    Approving stops at **Approved**. It deliberately does *not* walk on to
    Payment Pending the way :func:`ticket_service.approve_request` does for a
    booking — nothing is owed on the *enquiry* itself, and a payable enquiry
    would show the merchant a Pay button against a row that is only a question.

    CR-5 — WHAT THE POSITIVE ANSWER NOW CARRIES
    ``total_fare`` and the remarks that explain it. The quotation is stored on
    the enquiry and is **binding**: :func:`to_booking_request` copies it onto
    the booking's ``total_amount``, so the number the merchant accepted is the
    number the credit limit is checked against and the number its wallet is
    debited. It is stored as a *string* in JSONB, which is both what JSONB can
    hold and what keeps a float out of the money path.

    The answer is final either way: :func:`_guard_not_answered` refuses a
    second response, so a merchant who needs a different quotation raises a new
    enquiry rather than having this one quietly repriced underneath a booking
    they may already have made against it.
    """
    enquiry = _locked(db, actor, enquiry_id)
    _guard_not_answered(enquiry)
    _guard_claim(enquiry, actor)

    before = enquiry.status
    # One reassignment, not three: SQLAlchemy does not track in-place mutation
    # of a JSONB dict, so every key this function writes has to go in together.
    details = dict(enquiry.travel_details or {})
    if response:
        details["admin_response"] = response

    if not available:
        if details:
            enquiry.travel_details = details
        lifecycle.transition(db, enquiry, S.REJECTED, actor, reason=reason, commit=False)
        db.commit()
        db.refresh(enquiry)

        _audit(db, actor, enquiry, "Ticket enquiry declined",
               before=before, after=S.REJECTED, note=reason)
        ticket_service._notify_merchant(
            db, enquiry, "Booking enquiry: declined",
            f"{enquiry.request_number} — {reason or 'this sector is not available.'}",
        )
        return enquiry

    # Quantised on the way in, exactly as `finance_service` quantises every
    # other amount, so the enquiry, the booking and the ledger cannot disagree
    # in the third decimal place.
    fare = finance_service.q(total_fare)
    details["quoted_fare"] = str(fare)
    details["quotation_remarks"] = (reason or "").strip() or None
    details["quoted_by"] = actor.user_id
    details["quoted_by_name"] = actor.full_name
    details["quoted_at"] = _now().isoformat()
    enquiry.travel_details = details

    # The quotation belongs in the timeline too — `note` is what the Activity
    # Timeline renders, and "marked available" alone loses the number the whole
    # answer was about.
    quote_note = f"Quoted {fare}" + (f" — {details['quotation_remarks']}"
                                     if details["quotation_remarks"] else "")
    if enquiry.status is S.PENDING_APPROVAL:
        lifecycle.transition(db, enquiry, S.IN_REVIEW, actor, commit=False)
    lifecycle.transition(db, enquiry, S.APPROVED, actor, note=quote_note, commit=False)
    db.commit()
    db.refresh(enquiry)

    _audit(db, actor, enquiry, "Ticket enquiry quoted",
           before=before, after=S.APPROVED, note=quote_note)
    ticket_service._notify_merchant(
        db, enquiry, "Booking enquiry: quotation received",
        f"{enquiry.request_number} has been quoted at INR {fare}. "
        "Use Request Ticket to raise the booking against it.",
    )
    return enquiry


# ---------------------------------------------------------------------------
# Enquiry -> Booking Request
# ---------------------------------------------------------------------------
def to_booking_request(
    db: Session, actor: User, enquiry_id: int, *, passengers: list[dict],
    remarks: str | None = None, contact: dict | None = None,
    international: bool = False, special_requests: str | None = None,
    group_import_id: int | None = None, client_fare: Decimal | None = None,
) -> ServiceRequest:
    """Create the draft booking the Request Ticket button leads to.

    Every itinerary field is copied from the enquiry rather than accepted from
    the caller, so the booking that reaches the approvals desk is the journey
    the Admin actually said yes to. Only the passengers are new.

    The booking's parent is the **enquiry**, not a catalog row. That is what
    makes the two traceable to each other, and it is safe for the existing
    submit path: ``catalog_service.reserve_units`` returns immediately when
    ``available_units`` is NULL, which it is on an enquiry — so submitting
    reserves nothing and cancelling releases nothing.
    """
    # Gated on CURRENT access, not on whatever was true when the enquiry was
    # raised: converting to a booking creates a brand-new service_requests
    # row, so it is "new creation" exactly like raising the enquiry itself
    # was — an Admin turning Flights off must stop a NEW booking from being
    # drafted here, the same way it already stops a new enquiry. The enquiry
    # and any booking already made from it are untouched; only this next
    # step is blocked.
    service_access_service.assert_enabled(db, actor, ServiceCode.FLIGHTS)

    # Locked for the same reason the admin actions are: two Request Ticket
    # clicks landing together would both read booking_request_id as empty and
    # both raise a booking against one answer.
    enquiry = _locked(db, actor, enquiry_id)

    if enquiry.status is not S.APPROVED:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                "Only an enquiry our team has marked available can be turned into a "
                f"booking — this one is "
                f"{lifecycle.SPEC_LABELS.get(enquiry.status, enquiry.status.value)}"
            ),
        )

    details = dict(enquiry.travel_details or {})
    existing_id = details.get("booking_request_id")
    if existing_id:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"This enquiry has already been booked as "
                f"{details.get('booking_request_number') or existing_id}"
            ),
        )
    # WHERE A GROUP BOOKING'S TRAVELLERS COME FROM — and the order matters.
    #
    # `group_import_id` in the body is now the ORDINARY path, not the fallback:
    # an enquiry asks whether seats exist and what they cost, so the merchant
    # states a passenger *count* there and uploads the sheet listing them at
    # this step, once we have answered. The Merchant portal no longer offers an
    # upload on the enquiry form at all.
    #
    # The inherited branch is kept and is still checked FIRST, because enquiries
    # raised before that change really do carry a manifest, and for those the
    # sheet the desk quoted against is the one the booking must use. Preferring
    # the body on such an enquiry would let a second, different sheet silently
    # replace what was quoted.
    group_import = None
    inherited = getattr(enquiry, "group_import", None)
    if inherited is not None:
        passengers = group_booking_service.passengers_of(inherited)
    elif group_import_id is not None:
        group_import = group_booking_service.get(db, actor, group_import_id)
        passengers = group_booking_service.passengers_of(group_import)

    if not passengers:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one passenger is required",
        )

    # CR-5: the quotation the admin sent is what this booking is worth. It was
    # stored as a string in JSONB; rebuilt as a Decimal here so no float ever
    # touches it. A pre-CR-5 enquiry has no quotation and lands at zero — the
    # CR-4b path then still asks the desk for the fare at issuance, which is
    # exactly the behaviour those bookings were made under.
    quoted = details.get("quoted_fare")
    fare = finance_service.q(Decimal(quoted)) if quoted is not None else Decimal("0")

    merchant = db.get(Merchant, enquiry.merchant_id)
    booking = ServiceRequest(
        request_number=ticket_service._next_number(db, "REQ"),
        parent_request_id=enquiry.request_id,
        merchant_id=enquiry.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.BOOKING,
        booking_reference=merchant_service.next_booking_reference(db, merchant),
        travel_type=enquiry.travel_type,
        status=S.DRAFT,
        title=(enquiry.title or "").replace("Enquiry: ", "", 1) or enquiry.title,
        remarks=remarks,
        # 0040 — THE MERCHANT'S OWN SELLING PRICE, NOW STATED AT THIS STEP.
        #
        # It used to be collected on the enquiry form and is copied forward here
        # so the savings figure survives conversion: Reports, the invoice and the
        # Dashboard's "Total Savings" all aggregate over BOOKINGS, and an enquiry
        # that has become a booking is no longer counted by them. Without the
        # copy every merchant's savings reset to zero the moment they booked.
        #
        # As of 2026-08-05 the Booking Request screen is where it is ENTERED,
        # because that is the first moment our quotation exists to compare it
        # against — asking on the enquiry meant naming a selling price before
        # knowing the cost. So the payload wins when it carries one, and the
        # enquiry's value is the fallback that keeps every enquiry raised before
        # the move working untouched. `is not None` rather than a truth test:
        # zero is a real client fare and must not fall through to the enquiry's.
        client_fare=client_fare if client_fare is not None else enquiry.client_fare,
        # The enquiry's own details are spread first so the itinerary is
        # verbatim what was answered; only the booking-specific additions are
        # layered on. The review claim is dropped — it belongs to the enquiry's
        # workflow, not this booking's.
        #
        # CR-5 drops the quotation's *attribution* for the same reason, and it
        # matters more here than it did for the claim: `travel_details` is
        # returned wholesale to the merchant as `details` (schemas/ticket.py), so
        # `quoted_by` would put a platform staff **user id** on a merchant-facing
        # response. `quoted_fare` and `quotation_remarks` stay — those are the
        # merchant's own price and the explanation of it.
        travel_details={
            **{k: v for k, v in details.items()
               if not k.startswith("review_claimed")
               and k not in ("quoted_by", "quoted_by_name", "quoted_at")},
            "enquiry_reference": enquiry.request_number,
            "contact": contact or {},
            "international": bool(international),
            "special_requests": (special_requests or "").strip() or None,
        },
        # CR-5: priced from the enquiry's quotation, not left at zero.
        #
        # This is the one place the binding quotation takes effect, and it is
        # deliberately the *only* place — nothing downstream needed changing:
        #
        #   * `ticket_service._capture_fare_for_wallet_billing` returns early
        #     once `total_amount > 0`, so CR-4b's "the desk enters the fare at
        #     issuance" path simply stops firing for quoted bookings and still
        #     fires for the unquoted historical ones. CR-4b is untouched.
        #   * Both `assert_credit_available` call sites already pass the amount
        #     when it is non-zero and `None` when it is not, so the credit limit
        #     upgrades itself from "is there any headroom" to the full
        #     "does this specific amount fit" check, at submission and at
        #     approval, with no edit to frozen code.
        #
        # `quoted` distinguishes a real price from the zero a pre-CR-5 enquiry
        # still produces; every screen keys off it rather than off `== 0`.
        pricing={
            "currency": "INR",
            "quoted": fare > 0,
            "source": "ticket_enquiry",
            **({"final_amount": str(fare), "priced_at": "enquiry_quotation"} if fare > 0 else {}),
        },
        quantity=len(passengers),
        total_amount=fare,
        travel_date=enquiry.travel_date,
        return_date=enquiry.return_date,
        status_history=[],
    )
    db.add(booking)
    db.flush()

    for p in passengers:
        db.add(
            PassengerData(
                request_id=booking.request_id,
                merchant_id=enquiry.merchant_id,
                **ticket_service.passenger_columns(p),
            )
        )

    if group_import is not None:
        group_booking_service.attach_to_request(db, group_import, booking)

    # Stamp the link back so the enquiry listing shows the booking instead of
    # offering Request Ticket a second time.
    enquiry.travel_details = {
        **details,
        "booking_request_id": booking.request_id,
        "booking_request_number": booking.request_number,
    }

    db.commit()
    db.refresh(booking)

    activity_service.log_activity(
        db, actor.user_id, "Booking request created from enquiry",
        activity_type="Booking", module="Booking Request",
        description=(
            f"{actor.full_name} drafted {booking.request_number} "
            f"from enquiry {enquiry.request_number}"
        ),
        reference_id=booking.request_id, merchant_id=booking.merchant_id,
    )
    return booking


# ---------------------------------------------------------------------------
# Direct booking — no enquiry in front of it
# ---------------------------------------------------------------------------
def _itinerary_details(payload) -> dict:
    """The ``travel_details`` itinerary keys, from a form payload.

    Extracted from :func:`create` so the enquiry form and the direct booking
    form write **the same keys with the same normalisation** — the flight number
    upper-cased, the city names emptied to ``None`` rather than left as blanks.
    Every screen in the platform reads an itinerary out of these keys; a second
    writer spelling one of them differently would render a booking with a hole
    in it on a screen nobody thought to re-test.
    """
    return {
        "trip_type": payload.trip_type,
        # None on everything that is not a group booking — the schema refuses
        # the pairing any other way round, so this key is present and null
        # rather than absent, and every reader can treat it as a plain lookup.
        "group_journey_type": getattr(payload, "group_journey_type", None),
        "origin": payload.origin.strip(),
        "origin_city": (payload.origin_city or "").strip() or None,
        "destination": payload.destination.strip(),
        "destination_city": (payload.destination_city or "").strip() or None,
        # BOTH OPTIONAL, AND None MEANS SOMETHING. A null airline is an OPEN
        # enquiry — the merchant chose "All Airlines" and is asking the desk to
        # quote whatever is best — and a null flight number means no particular
        # service. Stored as present-and-null rather than omitted, like
        # group_journey_type above, so every reader is a plain lookup.
        "airline": (payload.airline or "").strip() or None,
        "flight_number": (payload.flight_number or "").strip().upper() or None,
        "preferred_time": payload.preferred_time,
        "return_preferred_time": payload.return_preferred_time,
        # None on a group booking, whose form asks for neither: the cabin and
        # the fare bucket are settled when the desk quotes the party. Stored as
        # a present-and-null key rather than omitted, like `group_journey_type`
        # above, so every reader is a plain lookup and never a `in details` test.
        "travel_class": (payload.travel_class or "").strip() or None,
        # The single-letter fare bucket (Y/J/C/F/…). Already uppercased and
        # pattern-checked by the schema, so nothing is re-normalised here.
        "booking_class": getattr(payload, "booking_class", None),
        "passenger_count": payload.passenger_count,
        "adults": payload.adults,
        "children": payload.children,
        "infants": payload.infants,
    }


def _manifest_passengers(db: Session, actor: User, payload):
    """Resolve a group booking's travellers from its uploaded manifest.

    Returns ``(import_row, passengers)`` — both ``None``/``[]`` when the payload
    carries no manifest, which is every booking that is not a group one.

    Shared by both booking paths so the gate is stated once: the import must be
    wholly valid, must belong to this merchant, and must not already have been
    spent on another booking. ``attach_to_request`` enforces all three; this
    only fetches the row and shapes the passengers.
    """
    import_id = getattr(payload, "group_import_id", None)
    if import_id is None:
        return None, []

    imp = group_booking_service.get(db, actor, import_id)
    passengers = group_booking_service.passengers_of(imp)
    if not passengers:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                "That passenger list imported no travellers. Upload a corrected "
                "sheet before raising the booking."
            ),
        )
    return imp, passengers


def create_direct_booking(db: Session, actor: User, payload) -> ServiceRequest:
    """Raise a booking with no enquiry in front of it.

    THE SECOND WAY ONTO ONE TRACK, NOT A SECOND TRACK.
    Everything downstream of this function is the code that already existed:
    ``ticket_service.submit_request`` submits it, the Manager queue picks it up
    (``manager_service._classic_bookings_filter`` matches the marker written
    below), ``lifecycle`` walks it through ``CLASSIC_TRANSITIONS``, and
    ``ticket_service.issue_ticket`` captures the fare and debits the wallet.
    Nothing here duplicates any of that; this function only *creates the row*,
    and it creates the same shape of row :func:`to_booking_request` does.

    THE DIFFERENCES FROM AN ENQUIRY-LED BOOKING, ALL THREE OF THEM:

    1. ``parent_request_id`` is ``None``. There is no enquiry to point at, and
       inventing one would put a row in the enquiry queue that nobody asked the
       desk to answer. ``submit_request``'s ``reserve_units`` call is already
       conditional on a parent, so nothing is reserved and nothing leaks.
    2. ``total_amount`` is ``0``. It has never been quoted, so the fare is
       captured at issuance by ``_capture_fare_for_wallet_billing`` — the
       pre-CR-5 path, still live for exactly this reason, and the one place a
       booking's price may be set by the platform rather than by the merchant.
    3. ``travel_details['direct_booking']`` is the track marker in place of
       ``enquiry_reference``. See ``lifecycle.CLASSIC_MARKER_KEYS``.

    The itinerary is taken from the merchant here, where on the enquiry-led path
    it is copied from the answered enquiry. That is not a weakening of the rule
    that "the booking is the journey we quoted" — it is the *absence* of a
    quotation, which is exactly what the merchant is choosing when it skips the
    enquiry, and it is why the desk still names the fare at issuance.
    """
    if actor.merchant_id is None:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only merchant accounts can raise booking requests",
        )
    # Direct booking has always been Flight-only (no Hotel direct-booking
    # path exists) — gated here the same way `create()` gates a Flight
    # enquiry, closing the one path that could otherwise create a Flight
    # booking for a merchant with Flights disabled.
    service_access_service.assert_enabled(db, actor, ServiceCode.FLIGHTS)
    # A GROUP BOOKING TAKES ITS TRAVELLERS FROM THE UPLOADED MANIFEST.
    # `_manifest_passengers` returns the import row as well, because it has to
    # be bound to this booking once the row exists — and it refuses anything
    # that is not a wholly valid import, so a sheet with outstanding errors
    # cannot reach the approvals desk.
    group_import, manifest = _manifest_passengers(db, actor, payload)
    passengers = manifest if group_import else [p.model_dump() for p in payload.passengers]
    if not passengers:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="At least one passenger is required",
        )

    merchant = db.get(Merchant, actor.merchant_id)
    booking = ServiceRequest(
        request_number=ticket_service._next_number(db, "REQ"),
        merchant_id=actor.merchant_id,
        user_id=actor.user_id,
        request_type=RequestType.BOOKING,
        booking_reference=merchant_service.next_booking_reference(db, merchant),
        travel_type=TravelType.FLIGHT,
        status=S.DRAFT,
        # `_title` produces "Enquiry: HYD → DXB · AI 217"; the same route line
        # without the prefix, matching what to_booking_request strips off.
        title=_title(payload).replace("Enquiry: ", "", 1),
        remarks=payload.remarks,
        client_fare=payload.client_fare,
        travel_details={
            **_itinerary_details(payload),
            "direct_booking": True,
            "contact": (payload.contact.model_dump() if payload.contact else {}),
            "international": bool(payload.international),
            "special_requests": (payload.special_requests or "").strip() or None,
            # The enquiry form's "notes for our team" still has somewhere to go:
            # it is the merchant's own note about the journey, and the desk reads
            # it beside the itinerary rather than in the booking's remarks.
            "merchant_notes": (payload.notes or "").strip() or None,
        },
        pricing={
            "currency": "INR",
            # False, and read by every screen instead of `total_amount == 0`.
            "quoted": False,
            "source": "direct_booking",
        },
        quantity=len(passengers),
        total_amount=Decimal("0"),
        travel_date=payload.travel_date,
        return_date=payload.return_date,
        status_history=[],
    )
    db.add(booking)
    db.flush()

    for p in passengers:
        db.add(
            PassengerData(
                request_id=booking.request_id,
                merchant_id=actor.merchant_id,
                **ticket_service.passenger_columns(p),
            )
        )

    # Bind the manifest to the booking it produced, inside the same transaction
    # as the passengers it produced. A commit between the two would leave a
    # booking whose travellers came from a sheet nothing points at.
    if group_import is not None:
        group_booking_service.attach_to_request(db, group_import, booking)

    db.commit()
    db.refresh(booking)

    activity_service.log_activity(
        db, actor.user_id, "Booking request created",
        activity_type="Booking", module="Booking Request",
        description=f"{actor.full_name} drafted {booking.request_number} without an enquiry",
        reference_id=booking.request_id, merchant_id=booking.merchant_id,
    )
    if group_import is not None:
        activity_service.log_activity(
            db, actor.user_id, "booking_submitted",
            activity_type="Booking", module="group_booking",
            description=(
                f"{booking.request_number} raised from {group_import.original_filename!r} "
                f"with {group_import.passengers_imported} imported passenger(s)"
            ),
            reference_id=booking.request_id, merchant_id=booking.merchant_id,
            details={
                "import_id": group_import.import_id,
                "journey_type": group_import.journey_type,
                "passengers_imported": group_import.passengers_imported,
            },
        )
    return booking


def discard_unsubmitted(db: Session, request_id: int) -> None:
    """Undo a just-created booking whose one-call submit was refused.

    Only reachable from the ``submit: true`` branch of ``POST /api/bookings/direct``.
    ``create_direct_booking`` has to commit — ``activity_service.log_activity``
    commits, so there is no honest way to leave the row pending across the
    submit — which means the refusal has to be undone rather than rolled back.

    THREE GUARDS, BECAUSE THIS DELETES A ROW.
    It refuses unless the booking is still ``DRAFT`` and its ``status_history``
    is empty, which together mean nothing has ever moved it and nobody else can
    have seen it. ``passenger_data.request_id`` is ``ON DELETE CASCADE``, so the
    travellers go with it and no orphan is left behind.

    IT NEVER RAISES. It runs inside an ``except`` block, and the caller is about
    to re-raise the real error — the merchant needs to be told what was missing
    from its form, not that the cleanup afterwards also failed. A booking left
    behind here is an untidy draft, which is strictly better than a 500 that
    hides the 400.
    """
    try:
        db.rollback()
        booking = db.get(ServiceRequest, request_id)
        if booking is None:
            return
        if booking.status is not S.DRAFT or booking.status_history:
            return
        db.delete(booking)
        db.commit()
    except Exception:  # pragma: no cover - cleanup must not mask the real error
        logger.exception("Could not discard unsubmitted direct booking %s", request_id)
        db.rollback()


def load_with_passengers(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Re-read a booking with its passengers eagerly loaded, for the response."""
    return db.scalars(
        select(ServiceRequest)
        .options(selectinload(ServiceRequest.passengers))
        .where(
            and_(
                ServiceRequest.request_id == request_id,
                ticket_service.scoped_query(actor),
            )
        )
    ).one()
