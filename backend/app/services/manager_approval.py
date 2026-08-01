"""Manager sign-off — the merchant's own approval step in front of ours.

WHAT CHANGED, AND WHY
A service request used to go straight from the person who raised it to our
desk, and the raiser could take it back again at any point while it was still
Pending. Two things were wrong with that. The merchant's own management had no
say in what their staff asked us to do — a junior operator could cancel a
ticketed booking on their own authority — and a request could vanish from under
an operator who had already started work on it.

So every service request now passes through the raiser's own company first:

    raised  ->  Under Manager Approval  ->  Manager Approved  ->  our desk

Only a **manager** of that company can move it out of the first stage, and the
person who raised it can do nothing to it afterwards. Once the manager has
signed it off, it appears on the Admin portal's Service Request Management
screen and our desk settles it. A manager's refusal ends the request there and
then — it never reaches us, because it was never our decision to make.

WHERE THE STATE LIVES, AND WHY NOT IN THE ENUM
In ``service_requests.travel_details['manager_approval']``, as a small JSONB
block. It is deliberately **not** two new members of ``request_status_enum``:

* the enum is a native PostgreSQL type driving a state machine
  (``lifecycle.TRANSITIONS``) that every portal, report and filter reads. Two
  new values would need an edge from and to every existing one, and would show
  up in the status dropdown of screens this has nothing to do with;
* manager sign-off is orthogonal to the lifecycle. The request genuinely *is*
  Pending Approval throughout — the question is only *whose* approval is
  outstanding, and that is one more fact about a pending request rather than a
  different kind of pending.

What the reader sees is a derived label: :func:`status_label` returns "Under
Manager Approval" or "Manager Approved" in place of the bare "Pending", so the
distinction is visible everywhere without the enum knowing about it.

WHO COUNTS AS A MANAGER
``merchant_role = manager``, or the company's ``merchant_admin`` — the account
created when the merchant was onboarded, which is a manager by definition and
guarantees that every merchant has at least one person who can sign off. A
manager raising a request has already made the decision, so their own request
is stamped approved on the spot rather than waiting for them to approve
themselves.
"""
from __future__ import annotations

import datetime

from fastapi import HTTPException, status as http_status
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import MerchantRole, RequestStatus as S, ServiceRequest, User, UserRole
from app.services import activity_service, lifecycle, notification_service

#: The key inside ``travel_details``.
FIELD = "manager_approval"

PENDING = "pending"
APPROVED = "approved"
REJECTED = "rejected"

#: What each state is called on screen. These are the strings the Admin portal
#: filters and badges on, so they live here rather than being retyped per
#: portal.
LABELS: dict[str, str] = {
    PENDING: "Under Manager Approval",
    APPROVED: "Manager Approved",
    REJECTED: "Manager Rejected",
}


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------------------
# Who may sign off
# ---------------------------------------------------------------------------
def is_manager(actor: User) -> bool:
    """Whether this account may sign off its own company's service requests.

    Platform staff are excluded on purpose. An admin approving on the
    merchant's behalf would erase the very separation this stage exists to
    create: our approval is the *second* one, and it cannot also be the first.
    """
    return bool(actor.is_merchant_user) and (
        actor.merchant_role is MerchantRole.MANAGER or actor.role is UserRole.MERCHANT_ADMIN
    )


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def block(request: ServiceRequest) -> dict:
    """The stored sign-off block, or ``{}`` for a request raised before this."""
    value = (request.travel_details or {}).get(FIELD)
    return value if isinstance(value, dict) else {}


def state(request: ServiceRequest) -> str | None:
    """``pending`` / ``approved`` / ``rejected``, or None when it does not apply.

    None means "this request predates manager sign-off". Those are treated as
    approved by :func:`is_approved` — a request already sitting on our desk when
    this shipped must not become unsettleable because a step that did not exist
    when it was raised was never taken.
    """
    return block(request).get("state")


def is_approved(request: ServiceRequest) -> bool:
    """Whether our desk may act on this request yet."""
    return state(request) in (None, APPROVED)


def is_pending(request: ServiceRequest) -> bool:
    return state(request) == PENDING


def label(request: ServiceRequest) -> str | None:
    """The sign-off label, or None when there is nothing extra to say."""
    return LABELS.get(state(request) or "")


def status_label(request: ServiceRequest, fallback: str) -> str:
    """What the status column should read.

    The sign-off label wins only while the request is still Pending Approval.
    Once it has been approved, rejected or settled by us, the lifecycle status
    is the more informative of the two — "Manager Approved" on a request we
    have since rejected would be true and useless.
    """
    if request.status is not S.PENDING_APPROVAL:
        return fallback
    return label(request) or fallback


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------
def stamp_on_raise(actor: User) -> dict:
    """The sign-off block a newly raised request carries.

    A manager's own request is approved as it is raised. Requiring them to
    approve themselves would add a click that can only ever have one outcome,
    and a merchant whose only manager is the person raising the request would
    otherwise be signing off their own work as a matter of ceremony.
    """
    if is_manager(actor):
        return {
            "state": APPROVED,
            "by": actor.user_id,
            "by_name": actor.full_name,
            "at": _now().isoformat(),
            #: Distinguishes "a manager raised it" from "a manager reviewed it",
            #: which the timeline needs to word the step honestly.
            "self_raised": True,
        }
    return {
        "state": PENDING,
        "requested_by": actor.user_id,
        "requested_by_name": actor.full_name,
        "requested_at": _now().isoformat(),
    }


def _write(request: ServiceRequest, value: dict) -> None:
    # Reassigned rather than mutated: SQLAlchemy does not track in-place
    # changes to a JSONB column.
    request.travel_details = {**(request.travel_details or {}), FIELD: value}


def record_decision(
    request: ServiceRequest, actor: User, *, approved: bool, reason: str | None = None
) -> dict:
    """Write a manager's decision onto the request. Does not commit.

    Committing, transitioning and notifying belong to the caller, which owns
    the transaction — this function's whole job is the one field, so a caller
    cannot half-apply a decision.
    """
    decision = {
        **block(request),
        "state": APPROVED if approved else REJECTED,
        "by": actor.user_id,
        "by_name": actor.full_name,
        "at": _now().isoformat(),
    }
    decision.pop("self_raised", None)
    if reason:
        decision["reason"] = reason
    _write(request, decision)
    return decision


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------
def guard_manager(actor: User) -> None:
    """Refuse anyone who is not a manager of a merchant."""
    if not is_manager(actor):
        raise HTTPException(
            status_code=http_status.HTTP_403_FORBIDDEN,
            detail="Only a manager of your company can approve service requests.",
        )


def guard_awaiting_decision(request: ServiceRequest) -> None:
    """Refuse a second decision on a request a manager has already settled."""
    current = state(request)
    if current == PENDING:
        return
    if current in (APPROVED, REJECTED):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{request.request_number} was already "
                f"{LABELS[current].lower()} by "
                f"{block(request).get('by_name') or 'a manager'}."
            ),
        )
    raise HTTPException(
        status_code=http_status.HTTP_409_CONFLICT,
        detail=f"{request.request_number} does not need manager approval.",
    )


def guard_ready_for_staff(request: ServiceRequest) -> None:
    """Refuse our desk acting on a request the merchant has not signed off.

    Enforced at the service layer, not only in the UI: the Admin screen hides
    the buttons, and this makes hiding them a convenience rather than the rule.
    """
    if is_approved(request):
        return
    if is_pending(request):
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{request.request_number} is still awaiting the merchant's manager. "
                "It can be actioned once their manager has approved it."
            ),
        )
    raise HTTPException(
        status_code=http_status.HTTP_409_CONFLICT,
        detail=(
            f"{request.request_number} was rejected by the merchant's own manager "
            "and never reached us."
        ),
    )


# ---------------------------------------------------------------------------
# The manager's queue
# ---------------------------------------------------------------------------
def _service_request_types() -> tuple:
    """Every request type that passes through this stage.

    Imported lazily from ``ticket_service`` rather than restated here: that
    tuple is the definition of "a service request", and a second copy is how
    a type gets added in one place and silently skips manager sign-off. The
    import is inside the function because ``ticket_service`` reaches
    ``change_request_service``, which reaches this module.
    """
    from app.services.ticket_service import SERVICE_REQUEST_TYPES

    return SERVICE_REQUEST_TYPES


def _scoped(db: Session, actor: User, request_id: int, *, lock: bool = False) -> ServiceRequest:
    """One service request belonging to this manager's own company.

    404 rather than 403 for another company's request, exactly as everywhere
    else in this API — a response must never confirm that a record it is not
    entitled to exists.
    """
    stmt = select(ServiceRequest).where(
        and_(
            ServiceRequest.request_id == request_id,
            ServiceRequest.merchant_id == actor.merchant_id,
        )
    )
    if lock:
        stmt = stmt.with_for_update()
    request = db.scalars(stmt).first()
    if not request or request.request_type not in _service_request_types():
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Service request not found"
        )
    return request


def queue(
    db: Session,
    actor: User,
    *,
    page: int = 1,
    page_size: int = 20,
    outstanding: bool = True,
) -> tuple[list[ServiceRequest], int]:
    """Service requests raised inside this manager's company, newest first.

    ``outstanding=True`` narrows to the ones still waiting on them, which is
    what the screen opens on — a manager wants the decisions they owe, not a
    history. The rest is one filter away.

    Filtered on the JSONB sub-state rather than on ``status``, because every row
    here is Pending Approval either way; the sub-state is the whole distinction.
    """
    conditions = [
        ServiceRequest.merchant_id == actor.merchant_id,
        ServiceRequest.request_type.in_(_service_request_types()),
    ]
    if outstanding:
        conditions.append(ServiceRequest.status == S.PENDING_APPROVAL)
        conditions.append(
            ServiceRequest.travel_details[FIELD]["state"].astext == PENDING
        )

    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(ServiceRequest).where(where)) or 0
    items = list(
        db.scalars(
            select(ServiceRequest)
            .options(selectinload(ServiceRequest.user))
            .where(where)
            .order_by(ServiceRequest.request_id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        ).all()
    )
    return items, total


def pending_count(db: Session, actor: User) -> int:
    """How many decisions this manager owes — drives the sidebar badge."""
    if not is_manager(actor):
        return 0
    return db.scalar(
        select(func.count())
        .select_from(ServiceRequest)
        .where(
            and_(
                ServiceRequest.merchant_id == actor.merchant_id,
                ServiceRequest.request_type.in_(_service_request_types()),
                ServiceRequest.status == S.PENDING_APPROVAL,
                ServiceRequest.travel_details[FIELD]["state"].astext == PENDING,
            )
        )
    ) or 0


def decide(
    db: Session,
    actor: User,
    request_id: int,
    *,
    approved: bool,
    reason: str | None = None,
) -> ServiceRequest:
    """A manager approves or refuses one of their company's service requests.

    Approving moves nothing: the request stays Pending Approval, because that
    is still true — it is now pending *our* approval, and the sub-state says so.
    The only thing that changes is that our desk can see and settle it.

    Refusing ends it. The request walks to Cancelled, which is the edge a
    merchant-side termination has always used (``lifecycle.TRANSITIONS`` gives
    Pending Approval a Cancelled edge gated on ``ticket.request``, which a
    manager holds). Rejected is deliberately not used: that is *our* verdict,
    and reading it on a request our desk never saw would misattribute the
    decision. The sub-state records who really refused it and why.
    """
    guard_manager(actor)

    text = (reason or "").strip()
    if not approved and not text:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Tell the person who raised it why — a reason is required to reject.",
        )

    request = _scoped(db, actor, request_id, lock=True)
    guard_awaiting_decision(request)
    if request.status is not S.PENDING_APPROVAL:
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{request.request_number} is "
                f"{lifecycle.SPEC_LABELS.get(request.status, request.status.value)} "
                "and is no longer awaiting approval."
            ),
        )

    record_decision(request, actor, approved=approved, reason=text or None)
    if not approved:
        lifecycle.transition(
            db, request, S.CANCELLED, actor,
            reason=f"Rejected by {actor.full_name} (manager): {text}",
            commit=False,
        )
    db.commit()
    db.refresh(request)

    verb = "approved" if approved else "rejected"
    activity_service.log_activity(
        db, actor.user_id, f"Service request {verb} by manager",
        activity_type="Service Request", module="Manager Approval",
        description=f"{actor.full_name} {verb} {request.request_number}",
        reference_id=request.request_id, merchant_id=request.merchant_id,
        details={
            "request_number": request.request_number,
            "request_type": request.request_type.value,
            "reason": text or None,
        },
    )

    kind = request.request_type.value.replace("_", " ")
    if approved:
        notification_service.notify_request_merchant(
            db, request, "Approved by your manager",
            f"{request.request_number} ({kind}) has been approved by {actor.full_name} "
            "and is now with our team.",
        )
        notification_service.notify_admins(
            db, "Service request ready to action",
            f"{request.request_number} ({kind}) has been approved by the merchant's manager.",
        )
    else:
        notification_service.notify_request_merchant(
            db, request, "Rejected by your manager",
            f"{request.request_number} ({kind}) was rejected by {actor.full_name}: {text}",
        )
    return request
