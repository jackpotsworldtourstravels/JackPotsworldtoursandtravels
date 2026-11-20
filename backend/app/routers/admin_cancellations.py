"""Admin view of B2C cancellations & refunds — ``/api/admin/cancellations/*``.
Phase 3 of the B2C Admin Portal build-out: completes the lifecycle Phase 2
left at "a booking can be marked cancelled" with an actual request/decision
trail and a refund state, per the plan's own diagram (Customer -> Booking ->
Payment -> Cancellation -> Refund).

DECIDING A REQUEST AND REFUNDING IT ARE DIFFERENT THINGS.
``PATCH`` carries ``approve`` / ``reject`` (a state machine in
customer_cancellation_admin_service). Money moves only through the ``/refund``
endpoints below, each behind its own permission:

  refund.view       GET  .../{id}/refund
  refund.execute    POST .../{id}/refund                       (the maker)
  refund.authorize  POST .../{id}/refund/attempts/{a}/authorize (the checker;
                    granted per user, held by no role)
  refund.authorize  POST .../{id}/refund/manual                (record a manual
                    refund - TrustBrick has no refund API)
  refund.reconcile  POST .../refunds/reconcile, .../resolve-failed

The permission is enforced HERE, on the server, and again inside
customer_refund_service; the admin screen hiding a button is a convenience.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, has_b2c_scope, has_permission, require, require_b2c_access
from app.config import settings
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_cancellation_admin import (
    CancellationDecision,
    CancellationDetail,
    CancellationList,
    ManualRefundRecord,
    ReconcileResult,
    RefundActionResult,
    RefundInitiate,
    RefundOverview,
    ResolveFailed,
)
from app.models_customer import AdminAuditOutcome
from app.services import activity_service, customer_cancellation_admin_service as service
from app.services import customer_admin_audit_service as b2c_audit
from app.services import customer_refund_service as refunds
from app.services.b2c_admin_readiness import require_audit_ready

# refund outcome word -> B2C-admin audit outcome for the NON-money-success rows
# (the money SUCCESS row is written atomically inside apply_provider_refund via
# the success_hook; see customer_admin_audit_service.success_hook / spec §13).
_NONSUCCESS_OUTCOME = {
    "failed": AdminAuditOutcome.FAILURE,
    "awaiting_approval": AdminAuditOutcome.PARTIAL,
    "manual_required": AdminAuditOutcome.PARTIAL,
    "processing": AdminAuditOutcome.PARTIAL,
    "uncertain": AdminAuditOutcome.PARTIAL,
}


def _audit_refund_outcome(user, action: str, cancellation_id: str, outcome: str) -> None:
    """Record the maker/checker action when it did NOT move money (the money
    SUCCESS row is the atomic one). 'succeeded'/'existing' add no extra row."""
    mapped = _NONSUCCESS_OUTCOME.get(outcome)
    if mapped is not None:
        b2c_audit.record_independently(
            admin=user, action=action, outcome=mapped,
            entity_type="customer_cancellation", entity_id=cancellation_id,
            new={"outcome": outcome},
        )
from app.services.payments.base import PaymentProviderError, to_minor

# B2C DOMAIN GATE (Stage 1 closure), applied to every route on this router.
# Capability is still decided per-endpoint by require(P.REFUND_*/CUSTOMER_VIEW)
# below — the maker-checker separation, the "authorize is held by no role" rule
# and super-admin-is-view-only all come from those unchanged checks. This gate
# only adds the environment boundary: a B2B administrator with role-default
# permissions but no explicit b2c.* scope is refused before any capability runs.
router = APIRouter(
    prefix="/api/admin/cancellations",
    tags=["admin-cancellations"],
    dependencies=[Depends(require_b2c_access())],
)


@router.get(
    "",
    response_model=CancellationList,
    summary="List B2C cancellation/refund requests",
    description=(
        "Requires `customer.view` (admin only). Newest first. "
        "`status`: requested | approved | rejected | refund_processing | refunded."
    ),
)
def list_cancellations(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
    search: str | None = Query(None, max_length=120),
    status_: str | None = Query(None, alias="status"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    if status_ and status_ not in service.STATUSES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Unknown status {status_!r}. Use one of {service.STATUSES}."
        )
    return service.list_requests(db, search=search, status=status_, page=page, page_size=page_size)


# ---------------------------------------------------------------------------
# Refunds
# ---------------------------------------------------------------------------
def _audit(db: Session, request: Request, user: User, cancellation_id: str, action: str, description: str) -> None:
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, action, meta["ip_address"],
        activity_type="Update", module="B2CRefunds",
        description=f"{user.full_name} {description} ({cancellation_id})",
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    db.commit()


def _refund_http(exc: refunds.RefundError) -> HTTPException:
    return HTTPException(exc.http_status, {"code": exc.code, "message": str(exc)})


_OUTCOME_TEXT = {
    "succeeded": "Refund confirmed by the payment provider.",
    "processing": "Refund submitted. The provider has not confirmed it yet; it stays Processing until it does.",
    "awaiting_approval": "Refund recorded and waiting for a second person to approve it. No money has moved.",
    "manual_required": "This provider has no refund API. Refund the customer yourself, then record it with its reference.",
    "failed": "The refund did not go through and no money moved. See the failure reason, then retry.",
    "uncertain": "The provider did not answer clearly, so the refund may or may not have happened. It will not be retried automatically; reconciliation will check.",
    "existing": "A refund is already in progress for this cancellation, so nothing new was started.",
}


def _result(db: Session, cancellation_id: str, outcome: str) -> dict:
    return {
        "outcome": outcome,
        "message": _OUTCOME_TEXT.get(outcome, outcome),
        "overview": refunds.refund_overview(db, cancellation_id),
    }


def _minor(amount):
    if amount is None:
        return None
    try:
        return to_minor(amount, "INR")
    except PaymentProviderError as exc:
        raise HTTPException(400, {"code": "invalid_amount", "message": str(exc)})


# NOTE: registered BEFORE ``/{cancellation_id}`` so "refunds" is never read as an id.
@router.post(
    "/refunds/reconcile",
    response_model=ReconcileResult,
    summary="Ask providers about refunds that are still processing",
    description="Requires `refund.reconcile`. Read-only at the provider: it never submits a refund.",
    dependencies=[Depends(require_audit_ready)],
)
def reconcile_refunds(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.REFUND_RECONCILE)),
):
    tally = refunds.reconcile_pending_refunds(db, limit=settings.payment_sweep_batch_size, min_age_seconds=0)
    _audit(db, request, user, "all", "Refund reconciliation run", f"ran refund reconciliation: {tally}")
    return tally


@router.get(
    "/{cancellation_id}/refund",
    response_model=RefundOverview,
    summary="Refund position and attempt history for a cancellation",
    description="Requires `refund.view`.",
    responses={404: {"description": "No such request."}},
)
def get_refund(
    cancellation_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.REFUND_VIEW)),
):
    overview = refunds.refund_overview(db, cancellation_id)
    if overview is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such request.")
    return overview


@router.post(
    "/{cancellation_id}/refund",
    response_model=RefundActionResult,
    summary="Start a refund (maker)",
    dependencies=[Depends(require_audit_ready)],
    description=(
        "Requires `refund.execute`. Validates the amount against what is still refundable on the "
        "ORIGINAL captured payment (across all cancellations), then sends it to the payment provider "
        "or, when a second approver is required, records it as awaiting approval. Repeating the call "
        "while a refund is open returns that refund instead of starting another."
    ),
)
def start_refund(
    cancellation_id: str,
    payload: RefundInitiate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.REFUND_EXECUTE)),
):
    return _start_refund(cancellation_id, payload.amount, request, db, user, target=payload.refund_amount)


def _start_refund(cancellation_id: str, amount, request: Request, db: Session, user: User, *, target=None) -> dict:
    # Approach C: the money-success audit rides apply_provider_refund's terminal
    # SUCCEEDED commit, so a succeeded refund can never lack its audit row.
    audit = b2c_audit.success_hook(user, action="refund.execute", entity_type="customer_refund_attempt")
    try:
        attempt, outcome = refunds.initiate_refund(
            db, cancellation_id, user, amount_minor=_minor(amount), target_minor=_minor(target), audit=audit,
        )
    except refunds.RefundError as exc:
        b2c_audit.record_independently(
            admin=user, action="refund.execute", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer_cancellation", entity_id=cancellation_id, reason=str(exc),
        )
        raise _refund_http(exc)
    _audit(db, request, user, cancellation_id, "Refund initiated",
           f"initiated refund attempt #{attempt.attempt_number} ({outcome})")
    _audit_refund_outcome(user, "refund.execute", cancellation_id, outcome)
    return _result(db, cancellation_id, outcome)


@router.post(
    "/{cancellation_id}/refund/attempts/{attempt_id}/authorize",
    response_model=RefundActionResult,
    summary="Approve a pending refund (checker)",
    dependencies=[Depends(require_audit_ready)],
    description=(
        "Requires `refund.authorize`, granted per user and held by no role. The approver must be a "
        "different person from whoever started the refund."
    ),
)
def authorize_refund(
    cancellation_id: str,
    attempt_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.REFUND_AUTHORIZE)),
):
    audit = b2c_audit.success_hook(user, action="refund.authorize", entity_type="customer_refund_attempt")
    try:
        attempt, outcome = refunds.authorize_refund(db, attempt_id, user, cancellation_ref=cancellation_id, audit=audit)
    except refunds.RefundError as exc:
        b2c_audit.record_independently(
            admin=user, action="refund.authorize", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer_cancellation", entity_id=cancellation_id, reason=str(exc),
        )
        raise _refund_http(exc)
    _audit(db, request, user, cancellation_id, "Refund authorised",
           f"authorised refund attempt #{attempt.attempt_number} ({outcome})")
    _audit_refund_outcome(user, "refund.authorize", cancellation_id, outcome)
    return _result(db, cancellation_id, outcome)


@router.post(
    "/{cancellation_id}/refund/manual",
    response_model=RefundActionResult,
    summary="Record a manual refund (TrustBrick and other providers with no refund API)",
    dependencies=[Depends(require_audit_ready)],
    description=(
        "Requires `refund.authorize` when a second approver is required (the default), otherwise "
        "`refund.execute`. Needs `admin_override: true`, the transfer reference and a reason. "
        "This calls NO gateway: it records money an operator already returned."
    ),
)
def record_manual_refund(
    cancellation_id: str,
    payload: ManualRefundRecord,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.REFUND_EXECUTE, P.REFUND_AUTHORIZE)),
):
    try:
        attempt = refunds.record_manual_refund(
            db, cancellation_id, user, amount_minor=_minor(payload.amount), reference=payload.reference,
            reason=payload.reason, admin_override=payload.admin_override,
        )
    except refunds.RefundError as exc:
        raise _refund_http(exc)
    _audit(db, request, user, cancellation_id, "Manual refund recorded",
           f"recorded a MANUAL refund for attempt #{attempt.attempt_number}, ref {attempt.manual_reference} "
           "(admin_override)")
    return {
        "outcome": "manual_recorded",
        "message": "Manual refund recorded with your override. No gateway was called.",
        "overview": refunds.refund_overview(db, cancellation_id),
    }


@router.post(
    "/{cancellation_id}/refund/attempts/{attempt_id}/resolve-failed",
    response_model=RefundActionResult,
    summary="Close an uncertain refund as not executed",
    dependencies=[Depends(require_audit_ready)],
    description=(
        "Requires `refund.reconcile`. Use only after confirming at the provider that no refund exists "
        "for this attempt; it then stops counting and a retry becomes possible."
    ),
)
def resolve_failed(
    cancellation_id: str,
    attempt_id: int,
    payload: ResolveFailed,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.REFUND_RECONCILE)),
):
    try:
        attempt = refunds.resolve_uncertain_as_failed(db, attempt_id, user, payload.reason, cancellation_ref=cancellation_id)
    except refunds.RefundError as exc:
        raise _refund_http(exc)
    _audit(db, request, user, cancellation_id, "Refund attempt closed",
           f"closed uncertain refund attempt #{attempt.attempt_number} as not executed")
    return _result(db, cancellation_id, "failed")


# ---------------------------------------------------------------------------
# One request
# ---------------------------------------------------------------------------
@router.get(
    "/{cancellation_id}",
    response_model=CancellationDetail,
    summary="One cancellation/refund request",
    description="Requires `customer.view` (admin only).",
    responses={404: {"description": "No such request."}},
)
def get_cancellation(
    cancellation_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.CUSTOMER_VIEW)),
):
    row = service.get_request(db, cancellation_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such request.")
    return row


@router.patch(
    "/{cancellation_id}",
    response_model=CancellationDetail,
    summary="Approve or reject a request",
    description=(
        "approve | reject require `b2c.customers.manage` (Phase 13); start_refund keeps `customer.view` + `refund.execute`. `action` is approve | reject, each legal only from "
        "`requested`. Approving cancels the underlying booking.\n\n"
        "`start_refund` is kept for older clients and now behaves exactly like POST .../refund "
        "(it needs `refund.execute` and moves money through the provider). `complete_refund` no "
        "longer exists: a refund is completed by the provider's confirmation, or recorded through "
        "POST .../refund/manual."
    ),
    responses={
        404: {"description": "No such request."},
        400: {"description": "Unknown action, or not legal from this request's current status."},
    },
)
def decide_cancellation(
    cancellation_id: str,
    payload: CancellationDecision,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require(P.CUSTOMER_VIEW)),
):
    if payload.action == "start_refund":
        if not has_permission(user, P.REFUND_EXECUTE):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Missing required permission: {P.REFUND_EXECUTE}")
        # What the old button saved - the desk's chosen total - is now the target.
        _start_refund(cancellation_id, None, request, db, user, target=payload.refund_amount)
        updated = service.get_request(db, cancellation_id)
        if updated is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such request.")
        return updated
    if payload.action == "complete_refund":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "complete_refund no longer marks a refund as done. A gateway refund completes when the "
            "provider confirms it; a TrustBrick refund is recorded with POST .../refund/manual.",
        )

    # Phase 13 (owner decision C7): approving or rejecting a request is a
    # booking-management decision and needs b2c.customers.manage ON TOP OF the
    # route's existing customer.view gate (unchanged; it also guards the desk's
    # list/detail reads). NOTE: the Super Admin role holds no customer.view by
    # default, so a super admin is refused by that route gate before reaching
    # this check — pre-existing desk behaviour, left for an owner decision.
    # It authorises NOTHING about refunds — start_refund above keeps its own
    # refund.execute check, and the /refund routes are unchanged.
    if payload.action in ("approve", "reject") and not has_b2c_scope(user, P.B2C_CUSTOMERS_MANAGE):
        b2c_audit.record_independently(
            admin=user, action=f"cancellation.{payload.action}", outcome=AdminAuditOutcome.DENIED,
            entity_type="customer_cancellation", entity_id=cancellation_id,
            reason="missing b2c.customers.manage",
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing required scope: b2c.customers.manage")

    result = service.decide(db, cancellation_id, payload.action, payload.refund_amount,
                            payload.admin_notes, actor_name=user.full_name)
    if result == "booking_completed":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This booking has already been completed, so the cancellation cannot be approved.",
        )
    if result == "booking_not_cancellable":
        raise HTTPException(status.HTTP_409_CONFLICT, "This booking cannot be cancelled in its current state.")
    if result == "invalid_action":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown action {payload.action!r}. Use one of approve | reject (or start_refund).",
        )
    if result == "wrong_state":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{payload.action!r} is not valid for this request's current status.",
        )
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such request.")

    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Cancellation request decided", meta["ip_address"],
        activity_type="Update", module="B2CCancellations",
        description=(
            f"{user.full_name} set {cancellation_id} to {result['status']} "
            f"via {payload.action} ({result['customer']['email']})"
        ),
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    db.commit()
    return result
