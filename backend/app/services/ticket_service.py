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
    RequestDocument,
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    TravelType,
    User,
)
from app.services import (
    activity_service,
    catalog_service,
    change_request_service,
    finance_service,
    lifecycle,
    manager_approval,
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
def passenger_columns(payload: dict) -> dict:
    """Column values for a new ``PassengerData`` row.

    ``PassengerInput`` carries an optional ``id`` so :func:`replace_passengers`
    can tell an edited traveller from a new one. It is identity, not data, and
    spreading it into the model raises ``TypeError`` — every creation path goes
    through here so that cannot happen again.
    """
    return {k: v for k, v in payload.items() if k != "id"}


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
                **passenger_columns(p),
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
    contact: dict | None = None, special_requests: str | None = None,
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

    # Merged, never replaced: travel_details also holds the locked itinerary
    # copied from the enquiry, and this endpoint must not be a way to edit it.
    # Reassigned rather than mutated because SQLAlchemy does not track in-place
    # changes to a JSONB dict.
    if contact is not None or special_requests is not None:
        details = dict(request.travel_details or {})
        if contact is not None:
            details["contact"] = contact
        if special_requests is not None:
            details["special_requests"] = special_requests.strip() or None
        request.travel_details = details

    db.commit()
    db.refresh(request)
    return request


def replace_passengers(
    db: Session, actor: User, request_id: int, passengers: list[dict]
) -> ServiceRequest:
    """Replace the passenger list on a draft and reprice accordingly.

    Identity is preserved for any traveller the caller sends back with its
    ``id``. This is not cosmetic: ``request_documents.passenger_id`` cascades on
    delete, so the original delete-everything-then-reinsert would destroy a
    merchant's uploaded passport scans — and their bytes on disk — every time
    the passenger list was saved. The Classic booking screen saves passengers
    immediately before submitting, so an international booking could never
    satisfy its own "a passport per traveller" rule.

    Positional matching was rejected as the fix: if a traveller is removed from
    the middle of the list, the row that shifts up would inherit the previous
    occupant's passport scan and mis-attribute a document to the wrong person.
    An explicit id is the only unambiguous answer.
    """
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

    existing = {p.passenger_id: p for p in request.passengers}
    keep: set[int] = set()
    for p in passengers:
        pid = p.get("id")
        if pid is None:
            continue
        if pid not in existing:
            # A passenger id from another booking, or one already removed.
            # Inserting it as a new traveller would hide the mistake.
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="That passenger is not on this booking request",
            )
        if pid in keep:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="The same passenger was sent twice",
            )
        keep.add(pid)

    # Files belonging to travellers who are genuinely being removed. Collected
    # before the delete, while the rows still exist; unlinked after the commit,
    # so a rollback can never leave a row pointing at bytes that are gone.
    dropped = [pid for pid in existing if pid not in keep]
    orphaned_paths: list[str] = []
    if dropped:
        orphaned_paths = list(
            db.scalars(
                select(RequestDocument.stored_path).where(
                    RequestDocument.passenger_id.in_(dropped)
                )
            ).all()
        )

    for pid in dropped:
        db.delete(existing[pid])
    db.flush()

    for p in passengers:
        fields = passenger_columns(p)
        pid = p.get("id")
        if pid is not None:
            row = existing[pid]
            for key, value in fields.items():
                setattr(row, key, value)
        else:
            db.add(
                PassengerData(
                    request_id=request.request_id, merchant_id=request.merchant_id, **fields
                )
            )

    if request.parent_request_id:
        item = db.get(ServiceRequest, request.parent_request_id)
        # Reprice against a catalog parent only. An enquiry-led booking's parent
        # is the *enquiry*, which carries no base_fare or taxes — quoting against
        # it yields a zero catalog quote that silently replaces the
        # {"quoted": false, "source": "ticket_enquiry"} provenance with something
        # that reads as "priced at zero from the catalog". The fare on these
        # bookings is set by the Admin at approval (approve_request's
        # final_amount), so there is nothing to recompute here. Catalog-led
        # pricing behaviour is unchanged.
        if item is not None and item.request_type is not RequestType.TICKET_ENQUIRY:
            priced = catalog_service.quote(item, len(passengers))
            request.pricing = {
                k: str(v) if isinstance(v, Decimal) else v for k, v in priced.items()
            }
            request.total_amount = priced["total"]
    request.quantity = len(passengers)

    db.commit()
    db.refresh(request)

    # The document rows went with their passenger via ON DELETE CASCADE; the
    # bytes would otherwise stay under the upload root forever. Imported here
    # rather than at module scope because document_service imports this module.
    if orphaned_paths:
        from app.services import document_service

        for stored in orphaned_paths:
            try:
                document_service.discard_file(stored)
            except Exception:
                pass  # a stray blob is not worth failing the save over

    return request


def _validate_enquiry_led_submission(request: ServiceRequest) -> None:
    """Completeness rules for a booking raised from an answered enquiry.

    Scoped to enquiry-led bookings on purpose. ``submit_request`` is shared with
    the catalog-led flow the Premium portal and Operations still use, and those
    have never collected a contact — applying these rules to every request would
    break both the moment this shipped.

    The international rule follows the same decision: a booking is treated as
    international only when the Classic UI positively said so from its airport
    reference data. When the country is unknown, passports stay optional rather
    than blocking a merchant on a fact nobody recorded.

    **Attachments are never checked here.** Documents were dropped from the
    Classic booking workflow: a merchant fills in the travellers and submits, and
    nothing about a file may stand between them and the approvals desk. The
    documents table, service and endpoints are all still in place and still work
    — they are simply not a precondition of submitting. Re-introducing a check
    here would silently make them mandatory again.
    """
    details = request.travel_details or {}

    contact = details.get("contact") or {}
    if not (contact.get("email") or "").strip() or not (contact.get("phone") or "").strip():
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="A contact email and phone are required before submitting this booking",
        )

    missing_names = [
        p.passenger_id for p in request.passengers
        if not (p.first_name or "").strip() or not (p.last_name or "").strip()
    ]
    if missing_names:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Every passenger needs a first and last name",
        )

    if not details.get("international"):
        return

    # International: each traveller needs passport *details*. This is passenger
    # data the merchant types on the form, not an upload — the scan that used to
    # be demanded alongside it is no longer part of the workflow. Infants travel
    # on an adult's passport in some markets but still need their own for
    # immigration, so they are not exempt here.
    for p in request.passengers:
        if not (p.passport_number or "").strip():
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"{p.full_name} needs a passport number — this is an "
                    "international booking"
                ),
            )
        if p.passport_expiry and p.passport_expiry <= request.travel_date:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"{p.full_name}'s passport expires on {p.passport_expiry:%d %b %Y}, "
                    "on or before the travel date"
                ),
            )


def submit_request(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Submit a draft for Admin approval, reserving inventory as it goes."""
    request = get_request(db, actor, request_id)
    if not request.passengers:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Add at least one passenger before submitting",
        )

    # Only bookings that came from an answered enquiry carry the extra rules.
    parent = db.get(ServiceRequest, request.parent_request_id) if request.parent_request_id else None
    if parent is not None and parent.request_type is RequestType.TICKET_ENQUIRY:
        _validate_enquiry_led_submission(request)

    # CR-4b: a hard credit block, at the first point the merchant commits. On the
    # enquiry-led track the fare is not known until the desk books it, so the
    # only honest question here is whether any credit is left at all —
    # assert_credit_available says exactly that and no more. Checked again at
    # approval, where the amount may have appeared: a gate only at submission is
    # one a re-price walks straight through.
    if request.merchant is not None:
        finance_service.assert_credit_available(
            db, request.merchant,
            request.total_amount if finance_service.q(request.total_amount) > 0 else None,
            request_number=request.request_number,
        )

    if request.parent_request_id:
        item = db.get(ServiceRequest, request.parent_request_id)
        if item is not None:
            catalog_service.reserve_units(db, item, request.quantity)

    classic = lifecycle.is_classic_track(request)
    lifecycle.transition(db, request, S.PENDING_APPROVAL, actor, commit=False)
    if classic:
        # A resubmission after a return-for-correction must not carry the old
        # remarks: the merchant has acted on them, and leaving them on the row
        # would show "needs correcting" on a booking that is now waiting on us.
        request.travel_details = {
            k: v for k, v in (request.travel_details or {}).items()
            if not k.startswith("manager_returned") and k != "manager_remarks"
        }
    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, "Ticket request submitted",
        activity_type="Booking", module="Ticket Request",
        description=f"{actor.full_name} submitted {request.request_number} for approval",
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    merchant_name = request.merchant.company_name if request.merchant else "a merchant"
    if classic:
        # Straight to the Managers. Telling the admins would put it on a desk
        # that cannot act on it — the generic approval path refuses this track.
        notification_service.notify_managers(
            db,
            "Booking request awaiting your approval",
            f"{request.request_number} from {merchant_name} is ready for manager review.",
        )
    else:
        notification_service.notify_admins(
            db,
            "New ticket request awaiting approval",
            f"{request.request_number} from {merchant_name} needs review.",
        )
    return request


# ---------------------------------------------------------------------------
# Admin: approve / reject
# ---------------------------------------------------------------------------
def _reject_enquiry_here(request: ServiceRequest) -> None:
    """Keep the booking approval path off rows that have their own workflow.

    Three kinds now: ticket enquiries (Phase 2), change requests (M3) and
    Classic Tours bookings (CR-2).

    An enquiry is a ``service_requests`` row like any other, so these generic
    endpoints would happily accept one — and :func:`approve_request` would walk
    it to **Payment Pending**, showing the merchant a Pay button against an
    enquiry that owes nothing. Enquiries have their own answer endpoint with
    its own rules (final answers, reviewer claims, no payable stage), so the
    generic path refuses them by type rather than trusting callers to know.
    """
    if request.request_type is RequestType.TICKET_ENQUIRY:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} is a ticket enquiry, not a booking. "
                "Use POST /api/admin/enquiries/{id}/respond to answer it."
            ),
        )
    # Same argument, one milestone later. A cancellation walked through this
    # path lands at **Payment Pending** — a Pay button on a request to cancel,
    # and the booking untouched. M3 gave them a settlement path that quotes the
    # charge and applies the outcome; this one refuses them by type rather than
    # trusting callers to know.
    if request.request_type in change_request_service.CHANGE_TYPES:
        label = change_request_service.TYPE_LABELS[request.request_type].lower()
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} is a {label} request, not a booking. "
                "Settle it through /api/admin/change-requests, which quotes the "
                "amounts and applies the change to the booking."
            ),
        )
    # CR-2, and the sharpest case of the three. A Classic Tours booking IS a
    # booking, so nothing about its type stops this path — an Admin holding
    # ticket.approve could approve it here, which would price it, check a credit
    # limit it has no fare against, and walk it to Payment Pending: a payment
    # step in the one workflow that is supposed to have none, taken by the desk
    # that answered its enquiry, with the Manager's sign-off skipped entirely.
    # Refused by track, the same way the two above are refused by type.
    if lifecycle.is_classic_track(request):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} is a Classic Tours booking request. "
                "It is approved by a Manager through /api/manager/bookings, and has "
                "no payment stage."
            ),
        )


def approve_request(
    db: Session, actor: User, request_id: int, *, final_amount: Decimal | None = None,
    note: str | None = None,
) -> ServiceRequest:
    """Approve and move straight to Payment Pending.

    The spec has Approved and Payment Pending as separate stages but no
    action between them, so both edges are walked here — the timeline still
    records each one.

    **This is where the credit limit is enforced (M4).** An enquiry-led booking
    carries ₹0 from submit until the desk prices it here, so this is the first
    moment there is an amount to check — anything earlier would be checking
    nothing. The check happens *before* the amount is written, so a refusal
    leaves the request exactly as it was rather than half-priced.

    **And this is where an unpriced approval is refused.** Because approval ends
    at Payment Pending, approving without a price produces a booking the merchant
    is asked to pay and *cannot*: :func:`record_payment` rejects ``amount <= 0``,
    so every portal correctly renders "Awaiting amount" instead of a Pay button
    and the booking sits there with no action available to anyone — the desk has
    no second chance to price it on this path, since Payment Pending has no edge
    back to Approved. Enquiry-led bookings reach here at exactly ₹0 by design, so
    this is not a rare case; it is the default one. Use
    :func:`reprice_request` to correct a booking already at Payment Pending.
    """
    request = get_request(db, actor, request_id)
    _reject_enquiry_here(request)

    if final_amount is not None:
        if final_amount < 0:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="Final amount cannot be negative",
            )

    # The exposure this approval would add is the *new* amount less whatever
    # this booking already contributed to `outstanding`; re-approving at the
    # same price must not look like a second commitment.
    merchant = db.get(Merchant, request.merchant_id) if request.merchant_id else None
    proposed = Decimal(final_amount if final_amount is not None else request.total_amount)
    if proposed <= 0:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} has no amount to pay. Enter the fare "
                "when approving — a booking approved at 0 lands in Payment "
                "Pending showing the merchant nothing it can pay."
            ),
        )
    if merchant is not None:
        already = (
            finance_service.balance_due(request)
            if request.status in finance_service.BILLABLE_STATUSES
            else Decimal("0")
        )
        finance_service.assert_within_credit_limit(
            db, merchant, proposed - already, request_number=request.request_number,
        )

    if final_amount is not None:
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


def reprice_request(
    db: Session, actor: User, request_id: int, *, amount: Decimal, reason: str,
) -> ServiceRequest:
    """Correct the amount on a booking that is already **Payment Pending**.

    WHY THIS EXISTS AS ITS OWN FUNCTION
    ``final_amount`` used to be settable in exactly one place —
    :func:`approve_request` — and that call walks the booking to Payment
    Pending. Payment Pending has no edge back to Approved, so calling approve a
    second time to fix a price returns "Cannot move a request from Payment
    Pending to Approved". A mistyped fare, or an approval sent with no fare at
    all, was therefore unfixable: the desk could not re-price it and the
    merchant could not pay it. Approval now refuses an unpriced booking, but
    that only prevents new ones — this is what recovers the rows already stuck,
    and the ordinary "we quoted the wrong number" correction.

    **Payment Pending only, deliberately.** Before it there is nothing to fix
    (approve takes the amount); after it money has moved, and re-pricing a paid
    or ticketed booking is a refund or an additional charge — the change-request
    and refund paths, which compute and settle amounts, not a silent overwrite
    of the figure the invoice was raised on.

    **The status is untouched.** This changes what is owed, not where the
    booking is, so it does not call :func:`lifecycle.transition` — and must not:
    the state machine records movement, and there is none here. The audit trail
    is the ``pricing.history`` entry, the activity log and the merchant's
    notification.
    """
    # Row-locked, with the scope filter *inside* the locked query — the same
    # shape as enquiry_service._locked, and for the same two reasons. Two admins
    # re-pricing at once would otherwise both read the old total, both pass the
    # credit check against it, and the second write would win with an exposure
    # nobody checked; and a separate scope query would leave the lock and the
    # permission decision looking at two different reads. ``scoped_query``
    # contributes only WHERE terms, which is what makes FOR UPDATE legal here.
    request = db.scalars(
        select(ServiceRequest)
        .where(and_(ServiceRequest.request_id == request_id, scoped_query(actor)))
        .with_for_update()
    ).first()
    if request is None:
        # 404 rather than 403 — don't confirm another merchant's request exists.
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Request not found")
    _reject_enquiry_here(request)

    if request.status is not S.PAYMENT_PENDING:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"An amount can only be corrected while a booking is Payment Pending — "
                f"{request.request_number} is "
                f"{lifecycle.SPEC_LABELS.get(request.status, request.status.value)}"
            ),
        )
    if amount <= 0:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Amount must be greater than zero",
        )

    previous = finance_service.q(request.total_amount)
    new_amount = finance_service.q(amount)
    if new_amount == previous:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"{request.request_number} is already {previous}",
        )

    # What this changes in the merchant's outstanding is exactly the difference
    # between the two totals: the booking already contributes
    # ``previous - net_paid`` and will contribute ``new - net_paid``, so whatever
    # has been paid cancels out. Passing the *new total* instead would count the
    # part already committed at approval a second time and refuse corrections
    # that add nothing. A reduction passes a negative delta, which
    # ``assert_within_credit_limit`` handles — a cheaper fare cannot breach a
    # limit.
    merchant = db.get(Merchant, request.merchant_id) if request.merchant_id else None
    if merchant is not None:
        finance_service.assert_within_credit_limit(
            db, merchant, new_amount - previous, request_number=request.request_number,
        )

    pricing = {**(request.pricing or {})}
    # Reassigned rather than mutated: SQLAlchemy does not track in-place changes
    # to a JSONB dict — the same reason lifecycle rebuilds status_history.
    pricing["history"] = list(pricing.get("history") or []) + [{
        "from": str(previous),
        "to": str(new_amount),
        "reason": reason,
        "by": actor.user_id,
        "by_name": actor.full_name,
        "at": _now().isoformat(),
    }]
    pricing["final_amount"] = str(new_amount)
    request.pricing = pricing
    request.total_amount = new_amount

    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, "Booking amount corrected",
        activity_type="Booking", module="Ticket Approval",
        description=(
            f"{actor.full_name} changed the amount on {request.request_number} "
            f"from {previous} to {new_amount}: {reason}"
        ),
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    _notify_merchant(
        db, request, "The amount on your booking has changed",
        f"{request.request_number} is now {new_amount} (was {previous}). Reason: {reason}",
    )
    return request


def reject_request(db: Session, actor: User, request_id: int, reason: str) -> ServiceRequest:
    request = get_request(db, actor, request_id)
    _reject_enquiry_here(request)

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
    # This endpoint cancels a BOOKING. A service request is not the caller's to
    # take back at all — it belongs to their manager the moment it is raised, and
    # letting it be cancelled here would be the withdraw that was deliberately
    # removed, under another name: no record of who decided, no reason, and no
    # word to the operator who may already be working it.
    if request.request_type in SERVICE_REQUEST_TYPES:
        kind = request.request_type.value.replace("_", " ")
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} is a {kind} request and cannot be cancelled here. "
                "Your manager can reject it with "
                f"POST /api/manager/service-requests/{request.request_id}/reject."
            ),
        )
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
    """Merchant pays. Lands as ``pending`` until an Admin verifies it.

    M4 added two rules that were simply absent before: a merchant could pay any
    amount it liked, twice, and a "wallet" payment moved no wallet.

    - **Never more than is owed.** The balance is read from the ledger, so
      payments already submitted and awaiting verification count against it —
      otherwise pressing Pay twice queues two full payments and the second one
      is a refund waiting to happen.
    - **A wallet payment moves the wallet.** It is debited here, at submission,
      not at verification: the funds are committed the moment the merchant
      spends them, and a refused verification refunds them (see verify_payment).
    """
    request = get_request(db, actor, request_id)
    # CR-2 disabled the payment workflow for Classic Tours bookings. They can
    # never *be* Payment Pending — the status has no inbound edge on that track —
    # so the check below would already refuse them, but with a message about the
    # wrong stage rather than the real reason. Say the real reason: a merchant
    # who reaches this path is owed an explanation, not a stage name.
    if lifecycle.is_classic_track(request):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} is a Classic Tours booking and is not paid "
                "through the portal. Nothing is owed here."
            ),
        )
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

    position = finance_service.booking_position(request)
    still_owed = finance_service.q(
        position["balance_due"] - position["awaiting_verification"]
    )
    if finance_service.q(amount) > still_owed:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} has {still_owed} left to pay"
                + (f" ({position['awaiting_verification']} is already submitted and "
                   f"awaiting verification)" if position["awaiting_verification"] > 0 else "")
                + f". {finance_service.q(amount)} would overpay it."
            ),
        )

    merchant = db.get(Merchant, request.merchant_id) if request.merchant_id else None
    from_wallet = (method or "").strip().lower() == "wallet"
    if from_wallet:
        if merchant is None:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="A wallet payment needs a merchant account to draw on",
            )
        finance_service.assert_wallet_covers(merchant, amount)
        finance_service.adjust_wallet(
            db, merchant, -finance_service.q(amount), actor_id=actor.user_id,
            payment_type=PaymentType.ADJUSTMENT,
            reason=f"Paid against {request.request_number}",
            commit=False,
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
    """Admin verifies a submitted payment, moving the request to Paid.

    **Row-locked (M4).** Two admins clicking Verify on the same payment used to
    both read it as ``pending`` and both walk the booking to Paid, writing two
    timeline entries for one payment. The status re-check now happens under
    ``SELECT … FOR UPDATE``, after any competing transaction has committed, so
    exactly one wins and the loser gets a 400 rather than a duplicate.

    **Partial payments no longer mark a booking Paid (M4).** Any verified
    payment used to walk the request straight to Paid — so ₹100 verified against
    a ₹48,000 booking marked it settled, and the remaining ₹47,900 silently
    stopped being owed by anything the UI displayed. The booking now moves only
    once the ledger says nothing is left.
    """
    payment = db.execute(
        select(Payment).where(Payment.payment_id == payment_id).with_for_update()
    ).scalar_one_or_none()
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
        # Money taken off the wallet at submission has to go back, or a refused
        # verification silently confiscates it.
        if (payment.payment_method or "").strip().lower() == "wallet" and payment.merchant_id:
            merchant = db.get(Merchant, payment.merchant_id)
            if merchant is not None:
                finance_service.adjust_wallet(
                    db, merchant, finance_service.q(payment.amount), actor_id=actor.user_id,
                    payment_type=PaymentType.ADJUSTMENT,
                    reason=f"Returned — payment {payment.payment_id} could not be verified",
                    commit=False,
                )
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
        db.refresh(request)
        if finance_service.balance_due(request) <= finance_service.ZERO:
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

    Row-locked since M4, for the same reason :func:`verify_payment` is: two admins refunding the
    same payment at once both read ``refund_amount`` as it stood before either wrote, so both
    pass the "would this exceed the original" check and together give back more than was taken.
    """
    payment = db.execute(
        select(Payment).where(Payment.payment_id == payment_id).with_for_update()
    ).scalar_one_or_none()
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


def issue_ticket(
    db: Session, actor: User, request_id: int, *, fare_amount: Decimal | None = None,
) -> ServiceRequest:
    """Issue the ticket: allocate PNR, ticket and invoice numbers, bill the wallet.

    ``fare_amount`` is what the desk actually paid the airline. It is **required
    on a wallet-billed booking that still carries no amount**, and ignored on a
    booking that already has one — see :func:`_capture_fare_for_wallet_billing`.

    **The booking row is locked first**, the same way :func:`reprice` and
    ``manager_service`` lock theirs, and for a sharper reason since CR-4b: this
    function now moves money. Without the lock every step from here down is a
    check-then-act on a status two requests can both read as ``approved`` —
    measured with six simultaneous issues, the result was **two 200s and three
    500s**. The money survived, because
    ``uq_wallet_transactions_booking_debit`` is a database guarantee rather than
    an application one, but the desks saw raw ``IntegrityError``s and two of them
    were told they had issued the same ticket. Serialising here is what turns the
    losers into an ordinary "already issued" refusal.

    ``populate_existing`` for the reason recorded in
    ``docs/WALLET_ARCHITECTURE.md`` §6: without it the lock is taken and the
    *stale* identity-map instance is returned, so the status re-check below would
    read the value from before the lock and let the second caller straight
    through — the precise failure the lock is here to stop.
    """
    request = db.scalars(
        select(ServiceRequest)
        .where(and_(ServiceRequest.request_id == request_id, scoped_query(actor)))
        .with_for_update()
        .execution_options(populate_existing=True)
    ).first()
    if request is None:
        # 404 rather than 403 — don't confirm another merchant's request exists.
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Request not found"
        )

    # On the Classic Tours track "Ticket Issued" is what tells the merchant its
    # paperwork is ready to download, and it is the last step before Completed
    # — there is no later stage at which the files could still arrive. Marking
    # it issued with nothing attached would send that notification against an
    # empty documents list. On the standard track the merchant has an invoice
    # and a confirmation PDF regardless, and the airline file may legitimately
    # follow later, so the requirement is scoped to this track (CR-2).
    if lifecycle.is_classic_track(request):
        # Imported here, not at module scope: document_service imports this
        # module for its scoping rules, so a top-level import would be a cycle.
        from app.services import document_service

        tickets = [
            d for d in request.documents
            if d.doc_type in document_service.STAFF_LATE_TYPES
        ]
        if not tickets:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Upload the issued ticket documents before marking "
                    f"{request.request_number} as Ticket Issued — the merchant "
                    "downloads them from this status."
                ),
            )

    # Validate the transition *before* allocating any numbers. Sequences are
    # non-transactional: a nextval survives the rollback that an illegal
    # transition triggers, so allocating first would burn a ticket and
    # invoice number on every rejected attempt and leave permanent gaps in
    # the invoice series.
    # Before the transition, so a booking with no fare is refused without having
    # moved and without burning a ticket number.
    _capture_fare_for_wallet_billing(request, fare_amount)

    lifecycle.transition(db, request, S.TICKET_ISSUED, actor, commit=False)

    if not request.pnr:
        request.pnr = _pnr()
    if not request.ticket_number:
        request.ticket_number = _next_number(db, "TKT")
    if not request.invoice_number:
        request.invoice_number = _next_number(db, "INV")

    # CR-4b: the platform has just bought a ticket with its own money, so the
    # merchant owes for it from this moment. Same transaction as the transition
    # — a ticket issued without its debit is an unbilled booking, and one that
    # needs a human to notice.
    debit = finance_service.bill_booking_to_wallet(
        db, request, actor_id=actor.user_id, commit=False
    )

    db.commit()
    db.refresh(request)

    activity_service.log_activity(
        db, actor.user_id, "Ticket issued",
        activity_type="Booking", module="Ticket Issuance",
        description=f"{actor.full_name} issued {request.ticket_number} for {request.request_number}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
    )
    if debit is not None:
        # Quoted by txn_number, never txn_id — the reference is what appears in
        # the UI, in reports and in support conversations. See
        # docs/WALLET_ARCHITECTURE.md §2.5.
        activity_service.log_activity(
            db, actor.user_id, "Wallet debited for booking",
            activity_type="Payment", module="Payments",
            description=(
                f"{debit.txn_number}: {request.request_number} billed "
                f"{debit.debit} to {request.merchant.company_name if request.merchant else 'the merchant'}"
                f"; wallet {debit.balance_before} -> {debit.balance_after}"
            ),
            reference_id=request.request_id, merchant_id=request.merchant_id,
        )
    _notify_merchant(
        db, request, "Your ticket has been issued",
        f"{request.request_number} — PNR {request.pnr}. You can now download the ticket and invoice."
        + (f" {debit.debit} has been debited from your wallet ({debit.txn_number}); "
           f"the balance is now {debit.balance_after}." if debit is not None else ""),
    )
    return request


def _capture_fare_for_wallet_billing(
    request: ServiceRequest, fare_amount: Decimal | None
) -> None:
    """Record what the desk paid, on a booking that has no amount yet (CR-4b).

    WHY THIS EXISTS
    An enquiry-led booking is created with ``total_amount = 0`` and there is no
    live path that ever sets it: ``enquiry_service`` says the fare "is set on the
    booking the Admin approves", but CR-2 closed ``approve_request`` to this
    track and CR-3's merchant approval takes no amount by design. So a Classic
    booking reaches this function at zero, and a wallet debit of zero is not a
    feature — it is a wallet that silently never bills.

    The desk issuing the ticket is the first actor who knows the real number,
    which is also where the business put it: *"Admin books ticket externally →
    uploads ticket documents → the amount is deducted."*

    Deliberately narrow:

    * Only when the booking is wallet-billed **and** still at zero. A booking
      that already carries an amount is untouched, so every catalog-led booking
      and every pre-CR-2 enquiry-led booking behaves exactly as before.
    * The refusal mirrors ``approve_request``'s existing one for the standard
      track — a booking ticketed at 0 shows the merchant an invoice for nothing
      and bills nobody.
    """
    if not finance_service.is_wallet_billed(request):
        return
    if finance_service.q(request.total_amount) > 0:
        return

    if fare_amount is None or finance_service.q(fare_amount) <= 0:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} has no amount. Enter the fare paid to the "
                "airline when issuing the ticket — it is what the merchant's wallet is "
                "debited, and a booking issued at 0 bills nobody and invoices nothing."
            ),
        )

    amount = finance_service.q(fare_amount)
    request.total_amount = amount
    request.pricing = {
        **(request.pricing or {}),
        "currency": (request.pricing or {}).get("currency", "INR"),
        "quoted": True,
        "final_amount": str(amount),
        "priced_at": "ticket_issue",
    }


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
    # See resolve_service_request: these two have their own workflow, and a
    # request raised here could never be settled anywhere. Refused at the door
    # rather than left to become an orphan.
    if request_type in change_request_service.CHANGE_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Raise a {change_request_service.TYPE_LABELS[request_type].lower()} through "
                f"POST /api/bookings/{{id}}/"
                f"{'cancellation' if request_type is RequestType.CANCELLATION else 'reschedule'} — "
                "that path quotes the amounts and applies the change to the booking."
            ),
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
        travel_details={
            **(details or {}),
            # The merchant's own sign-off stage, in front of ours. Same block,
            # same rules and the same manager queue as a cancellation — every
            # service request goes through it, not just the two that settle
            # money. See services/manager_approval.py.
            manager_approval.FIELD: manager_approval.stamp_on_raise(actor),
        },
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

    kind = request_type.value.replace("_", " ")
    if manager_approval.is_pending(request):
        # Not our work yet. Announcing it to the admin queue would fill it with
        # requests nobody there is allowed to touch.
        told = notification_service.notify_merchant_managers(
            db, request.merchant_id, "Service request needs your approval",
            f"{request.request_number} ({kind}) against {booking.request_number}: {remarks}",
        )
        if not told:
            notification_service.notify_admins(
                db, "Service request stuck awaiting a manager",
                f"{request.request_number} ({kind}) has no manager who can approve it.",
            )
    else:
        notification_service.notify_admins(
            db, "New service request",
            f"{request.request_number} ({kind}) needs attention.",
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
    # Cancellation and date change settle money and change the parent booking,
    # and this generic path does neither — approving one here would mark the
    # request Approved while leaving the booking exactly as it was, which is
    # the bug M3 exists to remove. Refused rather than quietly mishandled, the
    # same way the generic approve/reject refuses an enquiry.
    if request.request_type in change_request_service.CHANGE_TYPES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{request.request_number} is a "
                f"{change_request_service.TYPE_LABELS[request.request_type].lower()} request — "
                "settle it through /api/admin/change-requests, which quotes the amounts and "
                "applies the change to the booking."
            ),
        )
    # The merchant's manager signs off first. Enforced here rather than only on
    # the Admin screen, so hiding the button is a convenience and this is the
    # rule.
    manager_approval.guard_ready_for_staff(request)

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
    """Notify whoever raised the request, falling back to the company's admins.

    The logic moved to ``notification_service`` once the change-request
    workflow needed it too; this stays as the name every caller here already
    uses.
    """
    notification_service.notify_request_merchant(db, request, title, message)


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
