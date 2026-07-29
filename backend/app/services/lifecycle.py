"""Request status lifecycle — the state machine every transition goes through.

The spec's flow::

    Created -> Pending -> Under Review -> Approved
            -> Payment Pending -> Paid -> Ticket Issued -> Completed

    Created -> Pending -> Rejected

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
from app.models_v2 import ServiceRequest, User


@dataclass(frozen=True)
class Transition:
    """One edge of the state machine."""

    to: S
    permission: str
    label: str
    #: Free-text reason required (rejections must say why).
    requires_reason: bool = False


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


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def allowed_transitions(request: ServiceRequest, actor: User) -> list[Transition]:
    """Edges the actor may currently walk — drives the UI's action buttons."""
    return [
        t for t in TRANSITIONS.get(request.status, ()) if has_permission(actor, t.permission)
    ]


def _find(request: ServiceRequest, target: S) -> Transition:
    for transition in TRANSITIONS.get(request.status, ()):
        if transition.to is target:
            return transition
    raise HTTPException(
        status_code=http_status.HTTP_400_BAD_REQUEST,
        detail=(
            f"Cannot move a request from "
            f"{SPEC_LABELS.get(request.status, request.status.value)} to "
            f"{SPEC_LABELS.get(target, target.value)}"
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
) -> ServiceRequest:
    """Move a request to ``target``, enforcing the edge and its permission.

    Appends to ``status_history`` and stamps the matching timestamp column.
    Callers must not set ``request.status`` directly — this is the only
    supported path, which is what keeps the timeline complete.
    """
    edge = _find(request, target)

    if not has_permission(actor, edge.permission):
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail=f"Missing required permission: {edge.permission}",
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
    UI can show what has happened and what is still to come.
    """
    history = list(request.status_history or [])
    steps: list[dict] = [
        {
            "status": h.get("to"),
            "label": SPEC_LABELS.get(S(h["to"]), h.get("label")) if h.get("to") else h.get("label"),
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

    # Creation is implicit — nothing transitions *into* DRAFT.
    steps.insert(
        0,
        {
            "status": S.DRAFT.value,
            "label": SPEC_LABELS[S.DRAFT],
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

    reached = {s["status"] for s in steps}
    upcoming = [
        {
            "status": s.value,
            "label": SPEC_LABELS[s],
            "detail": None,
            "by": None,
            "at": None,
            "reason": None,
            "note": None,
            "state": "pending",
        }
        for s in HAPPY_PATH[HAPPY_PATH.index(request.status) + 1 :]
        if s.value not in reached
    ]
    return steps + upcoming
