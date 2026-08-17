"""Manager approval — the sign-off between a submitted Booking Request and the
operations desk (CR-2).

WHERE THIS SITS
``enquiry_service`` owns the Admin's answer to a Ticket Enquiry. ``ticket_service``
owns the merchant's booking and the Admin's catalog-led approval queue.
``booking_ops_service`` owns the desk that works a booking once it is approved.
This module owns the one step CR-2 inserted between the last two: a Manager
reads a submitted Booking Request in full and either sends it on or sends it
back.

WHY IT IS NOT A BRANCH INSIDE ``ticket_service.approve_request``
That function is the Admin's approval: it prices the booking, checks the
merchant's credit limit and walks it to Payment Pending. Every one of those is
wrong here — this workflow has no fare to quote, nothing to bill against and no
payment step. Sharing the function would have meant three ``if classic:`` arms
around code whose whole purpose is money, and the Admin's permission codes on a
path the Admin must not be able to take.

THE CLAIM
Start Review is a claim, taken under ``SELECT ... FOR UPDATE`` and held in
``travel_details``, exactly as Phase 2 did for enquiries. Two managers may open
the same booking; only the one holding the claim may decide it. Deciding without
claiming first is allowed and takes the claim implicitly — the guard exists to
stop two people reaching *different* decisions, not to make one of them press an
extra button.
"""
import datetime

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import (
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    User,
)
from app.services import activity_service, finance_service, lifecycle, notification_service, ticket_service

#: Where a Booking Request sits while it is the Manager's problem.
PENDING_STATUSES: tuple[S, ...] = (S.PENDING_APPROVAL, S.IN_REVIEW)

#: Everything the Manager's queue can show, in the order the tabs appear.
#: "Decided" is deliberately part of the same screen: a manager who has just
#: approved something needs to see that it went, and an audit question ("who
#: signed this off?") is asked far more often than it is answered anywhere else.
QUEUE_STATUSES: tuple[S, ...] = (
    S.PENDING_APPROVAL, S.IN_REVIEW, S.APPROVED, S.TICKET_ISSUED, S.COMPLETED, S.DRAFT,
)

#: The queue's tabs, resolved **server-side**. Two of them cover more than one
#: status, and a client that asked for the whole desk and filtered the page it
#: got back would page against the wrong total — 170 results, 10 rows, and a
#: "page 4 of 9" that renders empty. One status per tab is not enough; one
#: bucket per tab is.
BUCKETS: dict[str, tuple[S, ...]] = {
    "awaiting": (S.PENDING_APPROVAL, S.IN_REVIEW),
    "approved": (S.APPROVED,),
    "returned": (S.DRAFT,),
    "ticketed": (S.TICKET_ISSUED, S.COMPLETED),
}


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def is_merchant_approver(actor: User) -> bool:
    """True for a merchant's own approver (CR-3).

    Deliberately not "has the code": this answers *whose* bookings the actor
    may see, which is a property of being merchant-bound. The codes decide
    which actions they may take once scoped.
    """
    return not actor.is_platform_staff and actor.merchant_id is not None


def _assert_approver_surface(actor: User) -> None:
    """Refuse anyone who is neither platform staff nor a merchant approver.

    CR-3 moved the sign-off to the merchant that raised the booking, so this
    module now serves two kinds of actor. It stays belt-and-braces for both:
    the router's permission codes decide *which* actor, this decides that the
    actor is one of the two kinds at all, so an internal caller cannot get an
    unscoped user into this module by not being an HTTP request.

    A merchant actor is additionally confined to its own merchant by
    :func:`_scope_for` and :func:`_assert_own_merchant` — holding the code is
    never enough to see another merchant's booking.
    """
    if actor.is_platform_staff or is_merchant_approver(actor):
        return
    raise HTTPException(
        status_code=http_status.HTTP_403_FORBIDDEN,
        detail="Booking approval is restricted to platform staff and merchant approvers",
    )


def _assert_own_merchant(actor: User, booking: ServiceRequest) -> None:
    """A merchant approver may only touch its own merchant's bookings.

    The single most important guard in CR-3. Platform staff are unaffected —
    ``is_platform_staff`` is what the cross-tenant rules key on everywhere else.
    """
    if not is_merchant_approver(actor):
        return
    if booking.merchant_id != actor.merchant_id:
        # 404 rather than 403: confirming the booking exists would leak another
        # merchant's request numbers to anyone willing to enumerate them.
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Booking request not found"
        )


def _assert_not_self_approval(actor: User, booking: ServiceRequest) -> None:
    """A merchant approver may not decide a booking they raised themselves.

    The manager sub-role holds ``ticket.request``, so the same person can raise
    and — without this — sign off the same booking, which makes the step
    decorative for exactly the people most likely to use it. Platform staff
    never raise bookings, so this does not apply to them.
    """
    if not is_merchant_approver(actor):
        return
    if booking.user_id == actor.user_id:
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail=(
                f"{booking.request_number} was raised by you. Another approver at "
                "your organisation must decide it."
            ),
        )


def _classic_bookings_filter():
    """Bookings on the Classic Tours track.

    ``lifecycle.CLASSIC_MARKER_KEYS`` are the markers
    :func:`lifecycle.is_classic_track` reads — ``enquiry_reference`` for a
    booking raised from an answered enquiry, ``direct_booking`` for one the
    merchant raised straight from the booking form. Expressed here as a SQL term
    so the queue is one indexed read rather than a full scan filtered in Python,
    and built *from that tuple* rather than from literals, so a third way onto
    the track cannot appear in the state machine without appearing in this
    queue. The Python predicate is still applied per row afterwards — it
    additionally excludes bookings that already entered the payment workflow,
    which is a history check no cheap WHERE clause can make.
    """
    return and_(
        ServiceRequest.request_type == RequestType.BOOKING,
        or_(*[
            ServiceRequest.travel_details[key].astext.isnot(None)
            for key in lifecycle.CLASSIC_MARKER_KEYS
        ]),
    )


def _locked(db: Session, request_id: int) -> ServiceRequest:
    """Re-read the booking under a row lock, for the actions that decide it.

    Two managers opening the same booking is normal; two managers *deciding* it
    at the same instant must not both succeed. ``SELECT ... FOR UPDATE`` makes
    the second caller wait for the first to commit, so the status re-check that
    follows sees the committed outcome rather than the value the screen was
    rendered from.
    """
    booking = db.scalars(
        select(ServiceRequest)
        .where(ServiceRequest.request_id == request_id)
        .with_for_update()
    ).first()
    if booking is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Booking request not found"
        )
    return booking


def _assert_classic(booking: ServiceRequest) -> None:
    """Keep this module off requests that have their own workflow.

    Same shape as ``ticket_service._reject_enquiry_here``: an enquiry, a
    cancellation and a catalog-led booking all live in ``service_requests`` and
    would otherwise be approvable here by anyone holding the Manager's codes,
    skipping the pricing, the credit check and the desk that owns them.
    """
    if not lifecycle.is_classic_track(booking):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{booking.request_number} is not a Classic Tours booking request. "
                "Manager approval covers bookings raised from an answered ticket enquiry."
            ),
        )


def _reviewer(booking: ServiceRequest) -> tuple[int | None, str | None]:
    d = booking.travel_details or {}
    return d.get("manager_claimed_by"), d.get("manager_claimed_by_name")


def _guard_claim(booking: ServiceRequest, actor: User) -> None:
    """Only the manager holding the claim may decide a booking under review."""
    holder_id, holder_name = _reviewer(booking)
    if (
        booking.status is S.IN_REVIEW
        and holder_id is not None
        and holder_id != actor.user_id
    ):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'Another manager'} is already reviewing "
                f"{booking.request_number}. Only they can decide it."
            ),
        )


def _claim(booking: ServiceRequest, actor: User) -> None:
    # Reassign rather than mutate: SQLAlchemy does not track in-place changes
    # to a JSONB dict.
    booking.travel_details = {
        **(booking.travel_details or {}),
        "manager_claimed_by": actor.user_id,
        "manager_claimed_by_name": actor.full_name,
        "manager_claimed_at": _now().isoformat(),
    }


def _release_claim(booking: ServiceRequest) -> None:
    """Drop the claim once a booking leaves the Manager's hands.

    A booking returned for correction comes back as a fresh submission; leaving
    a stale claim on it would hand the second review to whoever happened to
    look at it first, months earlier.
    """
    booking.travel_details = {
        k: v for k, v in (booking.travel_details or {}).items()
        if not k.startswith("manager_claimed")
    }


def _audit(
    db: Session, actor: User, booking: ServiceRequest, action: str,
    *, before: S, after: S, reason: str | None = None,
) -> None:
    """One actor-attributed audit entry per Manager decision.

    The ``audit_logs`` trigger on ``service_requests`` stores the full
    before/after row, but its ``changed_by`` is always NULL — a database
    trigger has no idea which application user is behind the connection. This
    records who, when, and the exact status edge, and it is queryable from the
    admin activity feed. Same reasoning, same shape, as
    ``enquiry_service._audit``.
    """
    labels = lifecycle.labels_for(booking)
    activity_service.log_activity(
        db, actor.user_id, action,
        activity_type="Booking", module="Manager Approval",
        description=(
            f"{actor.full_name} moved {booking.request_number} from "
            f"{labels.get(before, before.value)} to {labels.get(after, after.value)}"
        ),
        reference_id=booking.request_id, merchant_id=booking.merchant_id,
        details={
            "booking_reference": booking.booking_reference,
            "enquiry_reference": (booking.travel_details or {}).get("enquiry_reference"),
            "from_status": before.value,
            "to_status": after.value,
            "actor_id": actor.user_id,
            "actor_name": actor.full_name,
            "merchant_name": booking.merchant.company_name if booking.merchant else None,
            "passenger_count": len(booking.passengers),
            **({"remarks": reason} if reason else {}),
        },
    )


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------
def list_queue(
    db: Session,
    actor: User,
    *,
    status: S | None = None,
    bucket: str | None = None,
    merchant_id: int | None = None,
    search: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[ServiceRequest], int]:
    """Booking Requests on the Manager's desk.

    Oldest first when the manager is looking at what is waiting on them — it is
    a work queue, not a feed, and the booking that has been sitting longest is
    the one that should be picked up. Anything already decided is newest first,
    because that list is read as a record of what just happened.

    ``bucket`` selects one of :data:`BUCKETS`; ``status`` narrows to a single
    status. They compose, so ``bucket=awaiting&status=in_review`` is "claimed,
    of the ones waiting on me".
    """
    _assert_approver_surface(actor)

    statuses = BUCKETS.get(bucket) if bucket else None
    if bucket and statuses is None:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown bucket '{bucket}'. Use one of: {', '.join(BUCKETS)}",
        )

    conditions = [_classic_bookings_filter()]
    # CR-3 — a merchant approver sees only its own merchant, and the caller
    # does not get a say. Applied before the optional `merchant_id` filter
    # below so that passing someone else's id narrows to nothing rather than
    # widening: two conditions, both ANDed, and the actor's own always wins.
    if is_merchant_approver(actor):
        conditions.append(ServiceRequest.merchant_id == actor.merchant_id)
    if status is not None:
        if statuses is not None and status not in statuses:
            # Contradictory filters would silently return nothing, which reads
            # as "no work" rather than "you asked for something impossible".
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=f"{status.value} is not part of the '{bucket}' tab",
            )
        conditions.append(ServiceRequest.status == status)
    elif statuses is not None:
        conditions.append(ServiceRequest.status.in_(statuses))
    else:
        conditions.append(ServiceRequest.status.in_(QUEUE_STATUSES))
    if merchant_id is not None:
        conditions.append(ServiceRequest.merchant_id == merchant_id)
    if search:
        pattern = f"%{search.strip()}%"
        conditions.append(
            or_(
                ServiceRequest.request_number.ilike(pattern),
                ServiceRequest.booking_reference.ilike(pattern),
                ServiceRequest.title.ilike(pattern),
            )
        )

    where = and_(*conditions)
    # Oldest-first only while the manager is looking at work still to do.
    waiting = (
        status in PENDING_STATUSES if status is not None
        else bucket in (None, "awaiting")
    )
    order = (
        ServiceRequest.created_at.asc() if waiting else ServiceRequest.created_at.desc()
    )

    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    rows = list(
        db.scalars(
            select(ServiceRequest)
            .options(
                selectinload(ServiceRequest.passengers),
                selectinload(ServiceRequest.merchant),
                selectinload(ServiceRequest.user),
            )
            .where(where)
            .order_by(order)
            .limit(page_size)
            .offset((page - 1) * page_size)
        ).all()
    )
    # The history-based half of the track test cannot be expressed in the WHERE
    # clause; drop anything the SQL filter let through that is not really on
    # this track. See lifecycle.is_classic_track.
    return [r for r in rows if lifecycle.is_classic_track(r)], total


def queue_counts(db: Session, actor: User) -> dict[str, int]:
    """Tab badges for the Manager's queue, in one grouped query."""
    _assert_approver_surface(actor)
    scope = [_classic_bookings_filter(), ServiceRequest.status.in_(QUEUE_STATUSES)]
    # Same scoping rule as list_queue, or a merchant approver's badges would
    # count every merchant's work while the list below showed only its own.
    if is_merchant_approver(actor):
        scope.append(ServiceRequest.merchant_id == actor.merchant_id)
    rows = db.execute(
        select(ServiceRequest.status, func.count())
        .where(and_(*scope))
        .group_by(ServiceRequest.status)
    ).all()
    counts = {s.value: 0 for s in QUEUE_STATUSES}
    for status, n in rows:
        counts[status.value] = n
    # One roll-up per tab, so a badge and the list behind it can never disagree.
    for name, statuses in BUCKETS.items():
        counts[name] = sum(counts[s.value] for s in statuses)
    return counts


def get_booking(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """One Booking Request, for the Manager's read-only review screen."""
    _assert_approver_surface(actor)
    booking = db.scalars(
        select(ServiceRequest)
        .options(
            selectinload(ServiceRequest.passengers),
            selectinload(ServiceRequest.merchant),
            selectinload(ServiceRequest.user),
        )
        .where(ServiceRequest.request_id == request_id)
    ).first()
    if booking is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Booking request not found"
        )
    _assert_own_merchant(actor, booking)
    _assert_classic(booking)
    return booking


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------
def start_review(db: Session, actor: User, request_id: int) -> ServiceRequest:
    """Claim a submitted Booking Request: Pending -> Under Manager Review.

    Re-claiming your own booking is a no-op rather than an error — a manager
    who reopens the screen should not be punished for it.
    """
    _assert_approver_surface(actor)
    booking = _locked(db, request_id)
    _assert_own_merchant(actor, booking)
    _assert_classic(booking)

    if booking.status is S.IN_REVIEW:
        holder_id, holder_name = _reviewer(booking)
        if holder_id in (None, actor.user_id):
            if holder_id is None:
                _claim(booking, actor)
                db.commit()
                db.refresh(booking)
            return booking
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{holder_name or 'Another manager'} is already reviewing "
                f"{booking.request_number}."
            ),
        )
    if booking.status is not S.PENDING_APPROVAL:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{booking.request_number} is "
                f"{lifecycle.label_of(booking)} — only a submitted booking request "
                "can be taken under review."
            ),
        )

    before = booking.status
    lifecycle.transition(db, booking, S.IN_REVIEW, actor, commit=False)
    _claim(booking, actor)
    db.commit()
    db.refresh(booking)

    _audit(db, actor, booking, "Booking request review started",
           before=before, after=S.IN_REVIEW)
    return booking


def approve(
    db: Session, actor: User, request_id: int, *, note: str | None = None,
) -> ServiceRequest:
    """Manager sign-off. The booking joins the Admin Booking Operations queue.

    **No amount, no payment.** Unlike ``ticket_service.approve_request`` this
    takes no fare and walks nowhere near Payment Pending: on the Classic Tours
    track the sector was already agreed when the enquiry was answered, and the
    only thing left is for the desk to book it. ``lifecycle`` enforces that —
    Manager Approved simply has no payment edge — so this cannot drift back
    into a billing path by accident.
    """
    _assert_approver_surface(actor)
    booking = _locked(db, request_id)
    _assert_own_merchant(actor, booking)
    _assert_classic(booking)
    _assert_not_self_approval(actor, booking)
    _guard_claim(booking, actor)

    if booking.status not in PENDING_STATUSES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{booking.request_number} is {lifecycle.label_of(booking)} and is "
                "no longer awaiting manager approval."
            ),
        )
    if not ticket_service._has_travellers(booking):
        # Belt and braces: submit_request already refuses this. A booking with
        # no travellers reaching the desk would be unbookable, and the Manager
        # is the last person who can catch it. Covers both shapes a traveller
        # takes — Flight's ``passengers`` and Hotel's ``hotel_guests``.
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"{booking.request_number} has no passengers and cannot be approved",
        )

    # CR-4b: the authoritative credit gate. Approval is what puts this booking on
    # the desk that will spend the platform's money on it, so it is the last
    # point at which a refusal can still change the outcome — by the time the
    # ticket is issued the money is gone and the debit is only accounting.
    # The merchant's balance can have moved since submission, which is why this
    # is checked again here and not assumed from the earlier pass.
    if booking.merchant is not None:
        finance_service.assert_credit_available(
            db, booking.merchant,
            booking.total_amount if finance_service.q(booking.total_amount) > 0 else None,
            request_number=booking.request_number,
        )

    before = booking.status
    if booking.status is S.PENDING_APPROVAL:
        # Approving straight from the queue without claiming first is allowed;
        # walk the intermediate edge so the timeline still reads in order.
        lifecycle.transition(db, booking, S.IN_REVIEW, actor, commit=False)
        _claim(booking, actor)
    lifecycle.transition(db, booking, S.APPROVED, actor, note=note, commit=False)
    db.commit()
    db.refresh(booking)

    _audit(db, actor, booking, "Booking request approved by manager",
           before=before, after=S.APPROVED, reason=note)
    notification_service.notify_admins(
        db, "Booking request approved for ticketing",
        f"{booking.request_number} was approved by {actor.full_name} and is in the "
        f"Booking Operations queue.",
    )
    notification_service.notify_request_merchant(
        db, booking, "Your booking request was approved",
        f"{booking.request_number} has been approved and is with our ticketing desk. "
        f"You will be notified when the tickets are issued.",
    )
    return booking


def return_for_correction(
    db: Session, actor: User, request_id: int, *, remarks: str,
) -> ServiceRequest:
    """Send a Booking Request back to the merchant with the Manager's remarks.

    This is the change request's "Reject". It does **not** move the booking to
    Rejected: that status is terminal, and a merchant who mistyped a passport
    number would have to re-key an itinerary the enquiry desk already agreed.
    The booking goes back to Draft — editable, with its passengers, its enquiry
    link and its whole history intact — and can be corrected and resubmitted.
    ``lifecycle`` requires the reason on that edge, so a booking can never come
    back with nothing to act on.
    """
    _assert_approver_surface(actor)
    remarks = (remarks or "").strip()
    if not remarks:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Tell the merchant what needs correcting",
        )

    booking = _locked(db, request_id)
    _assert_own_merchant(actor, booking)
    _assert_classic(booking)
    _assert_not_self_approval(actor, booking)
    _guard_claim(booking, actor)

    if booking.status not in PENDING_STATUSES:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{booking.request_number} is {lifecycle.label_of(booking)} and is "
                "no longer awaiting manager approval."
            ),
        )

    before = booking.status
    lifecycle.transition(db, booking, S.DRAFT, actor, reason=remarks, commit=False)
    _release_claim(booking)
    # Surfaced on the merchant's booking screen as the thing to fix. Kept out of
    # `rejection_reason`, which means "this request is over" everywhere else.
    booking.travel_details = {
        **(booking.travel_details or {}),
        "manager_remarks": remarks,
        "manager_returned_at": _now().isoformat(),
        "manager_returned_by": actor.full_name,
    }
    db.commit()
    db.refresh(booking)

    _audit(db, actor, booking, "Booking request returned for correction",
           before=before, after=S.DRAFT, reason=remarks)
    notification_service.notify_request_merchant(
        db, booking, "Your booking request needs a correction",
        f"{booking.request_number} was returned by our approvals team. {remarks}",
    )
    return booking
