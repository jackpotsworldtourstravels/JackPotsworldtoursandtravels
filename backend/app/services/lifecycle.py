"""Request status lifecycle — the state machine every transition goes through.

There are **two tracks**, and which one a request is on is a property of the
request, not of the caller.

The standard track (catalog-led bookings, Premium portal, Operations)::

    Created -> Pending -> Under Review -> Approved
            -> Payment Pending -> Paid -> Ticket Issued -> Completed

    Created -> Pending -> Rejected

The Classic Tours track (CR-2) — a booking raised from an answered Ticket
Enquiry::

    Created -> Pending Manager Approval -> Under Manager Review
            -> Manager Approved -> Ticket Issued -> Completed

    Pending Manager Approval / Under Manager Review -> Created
        ("returned for correction", with the Manager's remarks)

Two differences carry the whole change request. **The approver is the
Manager**, not the Admin who answered the enquiry, so those edges name the
Manager's permission codes. And **there is no payment step**: Manager Approved
goes straight to Ticket Issued, because the enquiry desk already agreed the
sector and this workflow settles outside the platform. Payment Pending and Paid
are simply not reachable, which is a stronger guarantee than hiding a Pay
button — ``record_payment`` gates on the status it can never have.

Encoded once, here, rather than as scattered ``if status ==`` checks. Each
edge names the permission required to walk it, so "who may approve" and
"what may be approved" are answered in the same place and cannot drift.

Every transition appends to ``service_requests.status_history``, which is
what the Activity Timeline renders — the history is written by the only
function allowed to change status, so a timeline gap would mean a bug rather
than a missing call.
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass

from fastapi import HTTPException, status as http_status
from sqlalchemy.orm import Session

from app.auth.rbac import P, has_permission
from app.models_v2 import RequestStatus as S
from app.models_v2 import RequestType, ServiceRequest, User


@dataclass(frozen=True)
class Transition:
    """One edge of the state machine."""

    to: S
    #: The code required to walk this edge, or a tuple of codes of which the
    #: actor needs **any one**. A tuple is for an edge that two different kinds
    #: of actor may legitimately walk — CR-3's approval, which either the
    #: merchant's own approver or a platform Manager can take. It is deliberately
    #: any-of and not all-of: no actor holds both sets, and requiring both would
    #: close the edge to everyone.
    permission: str | tuple[str, ...]
    label: str
    #: Free-text reason required (rejections must say why).
    requires_reason: bool = False

    @property
    def codes(self) -> tuple[str, ...]:
        return (self.permission,) if isinstance(self.permission, str) else self.permission


#: Allowed edges, keyed by current status. Anything not listed is refused.
TRANSITIONS: dict[S, tuple[Transition, ...]] = {
    S.DRAFT: (
        Transition(S.PENDING_APPROVAL, P.TICKET_REQUEST, "Submitted for approval"),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    S.PENDING_APPROVAL: (
        Transition(S.IN_REVIEW, P.TICKET_APPROVE, "Taken under review"),
        Transition(S.APPROVED, P.TICKET_APPROVE, "Approved"),
        Transition(S.REJECTED, P.TICKET_REJECT, "Rejected", requires_reason=True),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    S.IN_REVIEW: (
        Transition(S.APPROVED, P.TICKET_APPROVE, "Approved"),
        Transition(S.REJECTED, P.TICKET_REJECT, "Rejected", requires_reason=True),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    # Approval immediately opens the payment window.
    S.APPROVED: (
        Transition(S.PAYMENT_PENDING, P.TICKET_APPROVE, "Awaiting payment"),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    # The merchant pays; an Admin verifies the payment to move to PAID.
    S.PAYMENT_PENDING: (
        Transition(S.PAID, P.PAYMENT_VERIFY, "Payment verified"),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    S.PAID: (
        Transition(S.TICKET_ISSUED, P.TICKET_ISSUE, "Ticket issued"),
    ),
    S.TICKET_ISSUED: (
        Transition(S.COMPLETED, P.TICKET_ISSUE, "Completed"),
    ),
    # Terminal.
    S.COMPLETED: (),
    S.REJECTED: (),
    S.CANCELLED: (),
}

#: The Classic Tours track (CR-2). Replaces :data:`TRANSITIONS` wholesale for
#: an enquiry-led booking — it is not a set of overrides layered on top, because
#: "Approved -> Payment Pending" must not survive anywhere on this track.
#:
#: WHY "RETURN FOR CORRECTION" GOES BACK TO DRAFT RATHER THAN TO REJECTED
#: The change request says a rejected Booking Request is *returned to the
#: merchant with remarks for correction*. Rejected is terminal in this state
#: machine and always has been; sending a booking there would end it and leave
#: the merchant re-keying an itinerary the enquiry desk already agreed. Draft is
#: the one status the merchant may edit (:data:`EDITABLE_STATUSES`), so the
#: booking comes back editable, keeps its passengers, its enquiry link and its
#: whole history, and can be resubmitted. The remark rides on the transition's
#: ``reason``, which the timeline already renders.
#: Who may sign off a Classic Tours booking. The merchant's own approver (CR-3)
#: is listed first because it is the one that actually does it now; the platform
#: Manager (CR-2) is kept so the earlier workflow still walks the same edges and
#: can be reinstated without touching the state machine.
_APPROVER: tuple[str, ...] = (P.BOOKING_MERCHANT_APPROVE, P.BOOKING_MANAGER_APPROVE)
_RETURNER: tuple[str, ...] = (P.BOOKING_MERCHANT_RETURN, P.BOOKING_MANAGER_RETURN)

CLASSIC_TRANSITIONS: dict[S, tuple[Transition, ...]] = {
    S.DRAFT: (
        Transition(S.PENDING_APPROVAL, P.TICKET_REQUEST, "Submitted for approval"),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    # CR-3 moved this sign-off to the merchant that raised the booking, so both
    # approver codes open these edges. The *scope* — which bookings each actor
    # may reach — is enforced in ``manager_service``, not here: this table says
    # "may this actor walk this edge at all", never "whose booking is it".
    S.PENDING_APPROVAL: (
        Transition(S.IN_REVIEW, _APPROVER, "Taken under review"),
        Transition(S.APPROVED, _APPROVER, "Approved"),
        Transition(
            S.DRAFT, _RETURNER,
            "Returned for correction", requires_reason=True,
        ),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    S.IN_REVIEW: (
        Transition(S.APPROVED, _APPROVER, "Approved"),
        Transition(
            S.DRAFT, _RETURNER,
            "Returned for correction", requires_reason=True,
        ),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    # Manager approval is what puts a booking on the operations desk. No
    # payment edge exists here at all — see the module docstring.
    S.APPROVED: (
        Transition(S.TICKET_ISSUED, P.TICKET_ISSUE, "Ticket issued"),
        Transition(S.CANCELLED, P.TICKET_REQUEST, "Cancelled by merchant"),
    ),
    S.TICKET_ISSUED: (
        Transition(S.COMPLETED, P.TICKET_ISSUE, "Completed"),
    ),
    # Terminal.
    S.COMPLETED: (),
    S.REJECTED: (),
    S.CANCELLED: (),
}


#: Statuses that only exist on the standard track. A request that has been in
#: one is, by definition, already being settled through the payment workflow.
_PAYMENT_STATUSES: frozenset[S] = frozenset({S.PAYMENT_PENDING, S.PAID})


#: The ``travel_details`` keys that put a booking on the Classic Tours track.
#:
#: Two ways in, one workflow:
#:   ``enquiry_reference``  the booking came from an answered enquiry (CR-2).
#:   ``direct_booking``     the merchant raised it straight from the booking
#:                          form, with no enquiry and therefore no quotation.
#:
#: Named here rather than written as literals at each call site because
#: ``manager_service`` has to express the same predicate as a SQL term against
#: JSONB, and the two drifting apart would mean a queue that lists a booking the
#: state machine will not let a Manager decide.
CLASSIC_MARKER_KEYS: tuple[str, ...] = ("enquiry_reference", "direct_booking")


def is_classic_track(request: ServiceRequest) -> bool:
    """Is this the Classic Tours workflow (CR-2)?

    Decided from :data:`CLASSIC_MARKER_KEYS` in ``travel_details``, which
    ``enquiry_service`` writes on every booking it creates. Read from there
    rather than by loading the parent row and checking its type because this is
    called on every status read, and a parent lookup would put a query behind
    :func:`allowed_transitions` — and because a direct booking has no parent to
    look up at all.

    **A booking that has already entered the payment workflow stays on the
    standard track, permanently.** CR-2 changed the rules for new bookings; it
    did not retrospectively delete the payment step from bookings that were
    already in it. Without this clause every enquiry-led booking sitting at
    Payment Pending on the day this shipped would have been re-read as Classic,
    where that status has no outgoing edge at all — the merchant's money would
    have been owed against a booking nobody could move, in either direction.
    Once payment is behind it, a booking finishes the way it started. That
    clause is why the marker is read as *evidence of how this row was raised*
    and never as a switch anything toggles later.
    """
    if request.request_type is not RequestType.BOOKING:
        return False
    details = request.travel_details or {}
    if not any(details.get(k) for k in CLASSIC_MARKER_KEYS):
        return False
    if request.status in _PAYMENT_STATUSES:
        return False
    return not any(
        h.get("to") in {s.value for s in _PAYMENT_STATUSES}
        for h in (request.status_history or [])
    )


def _table(request: ServiceRequest) -> dict[S, tuple[Transition, ...]]:
    return CLASSIC_TRANSITIONS if is_classic_track(request) else TRANSITIONS


#: Edges that exist **only** as the settled outcome of an approved change
#: request (M3: cancellation / reschedule).
#:
#: WHY THESE ARE NOT IN ``TRANSITIONS``
#: A paid or ticketed booking genuinely can be cancelled — money has moved and
#: an airline seat exists, so the cancellation has to compute a charge and a
#: refund before it settles. Putting the edge in ``TRANSITIONS`` would publish
#: it through :func:`allowed_transitions`, which drives every action menu in
#: every portal, and an admin would get a bare "Cancel" button that skips the
#: charge, the refund and the merchant's request entirely — a second path to
#: the same state with none of the accounting.
#:
#: Keeping them here means the state machine is still the single place that
#: knows the edge exists, but only a caller passing ``settlement=True`` — the
#: change-request service — can walk it.
SETTLEMENT_TRANSITIONS: dict[S, tuple[Transition, ...]] = {
    S.APPROVED: (
        Transition(S.CANCELLED, P.SERVICE_REQUEST_MANAGE, "Cancellation approved", requires_reason=True),
    ),
    S.PAYMENT_PENDING: (
        Transition(S.CANCELLED, P.SERVICE_REQUEST_MANAGE, "Cancellation approved", requires_reason=True),
    ),
    S.PAID: (
        Transition(S.CANCELLED, P.SERVICE_REQUEST_MANAGE, "Cancellation approved", requires_reason=True),
    ),
    S.TICKET_ISSUED: (
        Transition(S.CANCELLED, P.SERVICE_REQUEST_MANAGE, "Cancellation approved", requires_reason=True),
    ),
    # A completed booking can be cancelled too. The trip is behind it, so this
    # is not "stop them travelling" — it is the settlement of a post-travel
    # claim, and it still runs through an approved cancellation request that
    # quotes the charge and the refund. COMPLETED has no edges at all in
    # TRANSITIONS and keeps none: without ``settlement=True`` it is still
    # terminal, which is what stops a Cancel button appearing on a trip that
    # has already flown.
    S.COMPLETED: (
        Transition(S.CANCELLED, P.SERVICE_REQUEST_MANAGE, "Cancellation approved", requires_reason=True),
    ),
}

#: Statuses at which a merchant may still edit passengers/details.
EDITABLE_STATUSES = frozenset({S.DRAFT})

#: Human labels for the timeline, mapped back to the spec's wording.
SPEC_LABELS: dict[S, str] = {
    S.DRAFT: "Created",
    S.PENDING_APPROVAL: "Pending",
    S.IN_REVIEW: "Under Review",
    S.APPROVED: "Approved",
    S.PAYMENT_PENDING: "Payment Pending",
    S.PAID: "Paid",
    S.TICKET_ISSUED: "Ticket Issued",
    S.COMPLETED: "Completed",
    S.REJECTED: "Rejected",
    S.CANCELLED: "Cancelled",
    S.SUBMITTED: "Submitted",
    S.VERIFIED: "Verified",
}

#: Classic Tours wording for the statuses whose *meaning* differs on that
#: track. A merchant looking at "Approved" needs to know it was the Manager who
#: approved it and that the booking is now with the operations desk — not that
#: an invoice is coming. Only the four that differ are listed; everything else
#: falls through to :data:`SPEC_LABELS`.
CLASSIC_LABELS: dict[S, str] = {
    S.DRAFT: "Created",
    S.PENDING_APPROVAL: "Pending Manager Approval",
    S.IN_REVIEW: "Under Manager Review",
    S.APPROVED: "Manager Approved",
}


def labels_for(request: ServiceRequest) -> dict[S, str]:
    """The status vocabulary this request should be described in."""
    if is_classic_track(request):
        return {**SPEC_LABELS, **CLASSIC_LABELS}
    return SPEC_LABELS


def label_of(request: ServiceRequest, status: S | None = None) -> str:
    target = status if status is not None else request.status
    return labels_for(request).get(target, target.value)


#: The happy path, in order — used to render a progress bar with the
#: not-yet-reached steps greyed out.
HAPPY_PATH: tuple[S, ...] = (
    S.DRAFT,
    S.PENDING_APPROVAL,
    S.IN_REVIEW,
    S.APPROVED,
    S.PAYMENT_PENDING,
    S.PAID,
    S.TICKET_ISSUED,
    S.COMPLETED,
)

#: The Classic Tours happy path. Payment Pending and Paid are absent because
#: they are unreachable on that track — projecting them as "still to come"
#: would promise the merchant a payment step that will never arrive.
CLASSIC_HAPPY_PATH: tuple[S, ...] = (
    S.DRAFT,
    S.PENDING_APPROVAL,
    S.IN_REVIEW,
    S.APPROVED,
    S.TICKET_ISSUED,
    S.COMPLETED,
)


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def allowed_transitions(request: ServiceRequest, actor: User) -> list[Transition]:
    """Edges the actor may currently walk — drives the UI's action buttons."""
    return [
        t for t in _table(request).get(request.status, ())
        if any(has_permission(actor, code) for code in t.codes)
    ]


def _find(request: ServiceRequest, target: S, *, settlement: bool = False) -> Transition:
    edges = _table(request).get(request.status, ())
    if settlement:
        # Settlement edges are tried FIRST, not appended. Approved and Payment
        # Pending already have a Cancelled edge in TRANSITIONS — the merchant's
        # own "I changed my mind", which requires ``ticket.request``. Searching
        # in the other order finds that one and refuses the admin settling an
        # approved cancellation, because an admin does not hold a merchant's
        # permission. A caller that explicitly asked to settle means the
        # settlement edge.
        edges = SETTLEMENT_TRANSITIONS.get(request.status, ()) + edges
    for transition in edges:
        if transition.to is target:
            return transition
    labels = labels_for(request)
    raise HTTPException(
        status_code=http_status.HTTP_400_BAD_REQUEST,
        detail=(
            f"Cannot move a request from "
            f"{labels.get(request.status, request.status.value)} to "
            f"{labels.get(target, target.value)}"
        ),
    )


def transition(
    db: Session,
    request: ServiceRequest,
    target: S,
    actor: User,
    *,
    reason: str | None = None,
    note: str | None = None,
    commit: bool = True,
    settlement: bool = False,
) -> ServiceRequest:
    """Move a request to ``target``, enforcing the edge and its permission.

    Appends to ``status_history`` and stamps the matching timestamp column.
    Callers must not set ``request.status`` directly — this is the only
    supported path, which is what keeps the timeline complete.

    ``settlement=True`` additionally allows the edges in
    :data:`SETTLEMENT_TRANSITIONS`. Only the change-request service passes it;
    see that constant for why those edges are not offered to everyone.
    """
    edge = _find(request, target, settlement=settlement)

    if not any(has_permission(actor, code) for code in edge.codes):
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Missing required permission: " + " or ".join(edge.codes),
        )
    if edge.requires_reason and not (reason or "").strip():
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="A reason is required for this action",
        )

    previous = request.status
    now = _now()
    request.status = target

    # Stamp the dedicated columns the reports read.
    if target is S.APPROVED:
        request.approved_by = actor.user_id
        request.approved_at = now
    elif target is S.REJECTED:
        request.rejection_reason = reason
        request.resolved_at = now
    elif target in (S.COMPLETED, S.CANCELLED):
        request.completed_at = now
        request.resolved_at = now

    entry = {
        "from": previous.value,
        "to": target.value,
        "label": edge.label,
        "by": actor.user_id,
        "by_name": actor.full_name,
        "at": now.isoformat(),
    }
    if reason:
        entry["reason"] = reason
    if note:
        entry["note"] = note

    # Reassign rather than append in place: SQLAlchemy does not track
    # mutation of a JSONB list.
    request.status_history = list(request.status_history or []) + [entry]

    if commit:
        db.commit()
        db.refresh(request)
    return request


def timeline(request: ServiceRequest) -> list[dict]:
    """Render the Activity Timeline for one request.

    Combines the recorded history with the remaining happy-path steps, so the
    UI can show what has happened and what is still to come. Both halves are
    track-aware: a Classic Tours booking is described in the Manager's
    vocabulary and never has a payment step projected onto it.
    """
    labels = labels_for(request)
    happy_path = CLASSIC_HAPPY_PATH if is_classic_track(request) else HAPPY_PATH

    history = list(request.status_history or [])
    steps: list[dict] = [
        {
            "status": h.get("to"),
            "label": labels.get(S(h["to"]), h.get("label")) if h.get("to") else h.get("label"),
            "detail": h.get("label"),
            "by": h.get("by_name"),
            "at": h.get("at"),
            "reason": h.get("reason"),
            "note": h.get("note"),
            "state": "done",
        }
        for h in history
        if h.get("to")
    ]

    # Creation is implicit — no transition *creates* the request. (On the
    # Classic track a return-for-correction does move a booking back into
    # Draft, which is a real second entry in the history above; this one is
    # still the moment the merchant started it.)
    steps.insert(
        0,
        {
            "status": S.DRAFT.value,
            "label": labels[S.DRAFT],
            "detail": "Request created",
            "by": None,
            "at": request.created_at.isoformat() if request.created_at else None,
            "reason": None,
            "note": None,
            "state": "done",
        },
    )

    if request.status in (S.REJECTED, S.CANCELLED, S.COMPLETED):
        return steps  # terminal — no pending steps to project

    # Only statuses reached since the request last ENTERED its current status
    # count as already done. A booking returned for correction has
    # "Pending Manager Approval" in its history, but it has to go there again —
    # suppressing it would show a merchant that the next thing to happen is
    # approval, with the submission it still has to make missing from the list.
    last_entry = max(
        (i for i, h in enumerate(history) if h.get("to") == request.status.value),
        default=None,
    )
    since = history[last_entry + 1:] if last_entry is not None else history
    reached = {h.get("to") for h in since}

    upcoming = [
        {
            "status": s.value,
            "label": labels[s],
            "detail": None,
            "by": None,
            "at": None,
            "reason": None,
            "note": None,
            "state": "pending",
        }
        for s in happy_path[happy_path.index(request.status) + 1:]
        if s.value not in reached
    ]
    return steps + upcoming
