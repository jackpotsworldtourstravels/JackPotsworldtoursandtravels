"""Admin view of B2C customers — ``/api/admin/customers/*``. Phase 1 of the
B2C Admin Portal build-out (see the plan's own doc for the full phase list).

The LIST and DETAIL reads are read-only, like ``customer_payment_admin.py`` next
to it. Stage 3 M1 adds three account ACTIONS — block, unblock and an
admin-initiated password reset (email-link only) — each gated on the explicit
``b2c.customers.manage`` scope, protected by the audit readiness gate, and
audited. No new table: block/unblock use the existing ``customers.status`` and
``customer_auth.force_logout_at``; the reset reuses the existing customer
password-reset flow. The admin never sees, generates or sets a password.
"""
from __future__ import annotations

import datetime as dt
import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_admin
from app.auth.rbac import P, require_scope
from app.config import settings
from app.models_customer import AdminAuditOutcome
from app.services import customer_admin_audit_service as b2c_audit
from app.services.b2c_admin_readiness import require_audit_ready
from app.database.session import get_db
from app.models_v2 import User
from app.schemas.customer_admin import (
    CustomerBlockRequest,
    CustomerDetail,
    CustomerList,
    CustomerPasswordResetRequest,
    CustomerPasswordResetResponse,
    CustomerStatusChangeResponse,
    CustomerUnblockRequest,
)
from app.services import (
    activity_service,
    customer_admin_account_service as account_actions,
    customer_admin_service as service,
    customer_auth_service,
    email_service,
)

router = APIRouter(prefix="/api/admin/customers", tags=["admin-customers"])
logger = logging.getLogger("jackpots.b2c_customer_admin")

_FILTERS = ("active", "blocked", "new")


def _manage_gate(action: str):
    """Authorization gate for the account actions: the explicit
    ``b2c.customers.manage`` scope (super-admin or an explicit grant — never a
    B2B role default). A denial is recorded as a DENIED audit event, naming the
    action that was refused, and then 403s. ``get_current_admin`` first rejects
    non-admins (merchants) before we reach the scope check."""

    def gate(customer_id: int = Path(...), admin: User = Depends(get_current_admin)) -> User:
        if not admin.has_permission(P.B2C_CUSTOMERS_MANAGE):
            b2c_audit.record_independently(
                admin=admin, action=action, outcome=AdminAuditOutcome.DENIED,
                entity_type="customer", entity_id=customer_id,
                reason="missing b2c.customers.manage",
            )
            raise HTTPException(status.HTTP_403_FORBIDDEN, "B2C customer management access required")
        return admin

    return gate


@router.get(
    "",
    response_model=CustomerList,
    summary="List B2C customers",
    description=(
        "Requires `customer.view` (admin only). Newest first.\n\n"
        "`filter` is the sidebar's own vocabulary — `active`, `blocked` or "
        "`new` (registered in the last 30 days) — separate from `status`, "
        "which takes the database's own values "
        "(`active`/`inactive`/`blocked`/`suspended`)."
    ),
)
def list_customers(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW)),
    search: str | None = Query(None, max_length=120),
    status_: str | None = Query(None, alias="status"),
    filter: str | None = Query(None, description="active | blocked | new"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    if filter and filter not in _FILTERS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Unknown filter {filter!r}. Use one of {_FILTERS}."
        )
    return service.list_customers(
        db, search=search, status=status_, filter_=filter, page=page, page_size=page_size,
    )


@router.get(
    "/{customer_id}",
    response_model=CustomerDetail,
    summary="One customer: profile, booking history, payment history, reviews",
    description="Requires `customer.view` (admin only).",
    responses={404: {"description": "No such customer."}},
)
def get_customer(
    customer_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_scope(P.B2C_CUSTOMERS_VIEW, P.CUSTOMER_VIEW)),
):
    customer = service.get_customer(db, customer_id)
    if customer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such customer.")

    # SENSITIVE-DATA ACCESS IS RECORDED, following the convention
    # customer_payment_admin.py set: naming the customer, never a credential.
    meta = activity_service.request_context(request)
    activity_service.log_activity(
        db, user.user_id, "Customer record viewed", meta["ip_address"],
        activity_type="Read", module="B2CCustomers",
        description=f"{user.full_name} opened customer {customer.customer_code} ({customer.email})",
        browser=meta["browser"], device=meta["device"],
        merchant_id=getattr(user, "merchant_id", None),
    )
    b2c_audit.record_in_session(
        db, admin=user, action="customer.view_detail", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer", entity_id=customer_id,
    )
    db.commit()

    return service.get_customer_detail(db, customer)


# --- Stage 3 M1: account actions (b2c.customers.manage) ---------------------
@router.post(
    "/{customer_id}/block",
    response_model=CustomerStatusChangeResponse,
    summary="Block a customer (and invalidate live sessions)",
    description=(
        "Requires `b2c.customers.manage`. Reason required. Idempotent. Only an "
        "**active** customer can be blocked; an inactive/suspended customer is "
        "refused (409) and left unchanged, so unblock can never reactivate them."
    ),
    dependencies=[Depends(require_audit_ready)],
    responses={
        404: {"description": "No such customer."},
        409: {"description": "Customer is not active and cannot be blocked."},
    },
)
def block_customer(
    customer_id: int,
    payload: CustomerBlockRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(_manage_gate("customer.block")),
):
    customer = service.get_customer(db, customer_id)
    if customer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such customer.")
    try:
        change = account_actions.block_customer(db, customer)
    except account_actions.CustomerActionError as exc:
        # Refused on a status rule (no mutation happened). Audit the refusal.
        b2c_audit.record_independently(
            admin=admin, action="customer.block", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason=str(exc),
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except Exception as exc:  # noqa: BLE001 — record the failed attempt, then surface it
        db.rollback()
        b2c_audit.record_independently(
            admin=admin, action="customer.block", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason=str(exc),
        )
        raise
    # SUCCESS audit rides the SAME commit as the status change (atomic; the
    # readiness gate above guarantees the table exists, so this cannot fail on a
    # missing table — and if it fails for any other reason the block rolls back).
    b2c_audit.record_in_session(
        db, admin=admin, action="customer.block", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer", entity_id=customer_id,
        previous={"status": change["from_status"]},
        new={"status": change["to_status"], "reason": payload.reason},
    )
    db.commit()
    return CustomerStatusChangeResponse(
        status="blocked", customer_id=customer_id,
        from_status=change["from_status"], to_status=change["to_status"],
    )


@router.post(
    "/{customer_id}/unblock",
    response_model=CustomerStatusChangeResponse,
    summary="Unblock a customer (restores login; does not revive old sessions)",
    description=(
        "Requires `b2c.customers.manage`. Reason optional. Idempotent. Only "
        "reverses a **blocked**→active state; an inactive/suspended customer is "
        "refused (409) and left unchanged — unblock never reactivates them."
    ),
    dependencies=[Depends(require_audit_ready)],
    responses={
        404: {"description": "No such customer."},
        409: {"description": "Customer is not blocked; unblock does not apply."},
    },
)
def unblock_customer(
    customer_id: int,
    payload: CustomerUnblockRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(_manage_gate("customer.unblock")),
):
    customer = service.get_customer(db, customer_id)
    if customer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such customer.")
    try:
        change = account_actions.unblock_customer(db, customer)
    except account_actions.CustomerActionError as exc:
        b2c_audit.record_independently(
            admin=admin, action="customer.unblock", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason=str(exc),
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc))
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        b2c_audit.record_independently(
            admin=admin, action="customer.unblock", outcome=AdminAuditOutcome.FAILURE,
            entity_type="customer", entity_id=customer_id, reason=str(exc),
        )
        raise
    b2c_audit.record_in_session(
        db, admin=admin, action="customer.unblock", outcome=AdminAuditOutcome.SUCCESS,
        entity_type="customer", entity_id=customer_id,
        previous={"status": change["from_status"]},
        new={"status": change["to_status"], "reason": payload.reason},
    )
    db.commit()
    return CustomerStatusChangeResponse(
        status="active", customer_id=customer_id,
        from_status=change["from_status"], to_status=change["to_status"],
    )


@router.post(
    "/{customer_id}/password-reset",
    response_model=CustomerPasswordResetResponse,
    summary="Email the customer a secure password-reset link",
    description=(
        "Requires `b2c.customers.manage`. Uses the existing secure email-link "
        "workflow only — the admin never sees, generates or sets a password and "
        "no token is ever returned. A customer with no verified email gets a 422 "
        "and no reset is initiated. `force_logout` also kills live sessions now."
    ),
    dependencies=[Depends(require_audit_ready)],
    responses={
        404: {"description": "No such customer."},
        422: {"description": "Customer has no verified email on file."},
        502: {"description": "Reset link could not be emailed."},
    },
)
def initiate_password_reset(
    customer_id: int,
    payload: CustomerPasswordResetRequest,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(_manage_gate("customer.reset_password_initiated")),
):
    customer = service.get_customer(db, customer_id)
    if customer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such customer.")

    # No verified email => do NOT initiate, generate no token, audit FAILURE, 422.
    if not (customer.email and customer.email_verified):
        b2c_audit.record_independently(
            admin=admin, action="customer.reset_password_initiated",
            outcome=AdminAuditOutcome.FAILURE, entity_type="customer", entity_id=customer_id,
            reason="no verified email on file",
        )
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Customer has no verified email address; a reset link cannot be sent.",
        )

    meta = activity_service.request_context(request)
    # The existing secure flow mints + stores the token and returns the raw value
    # (which we deliberately discard — it is emailed, never surfaced to the admin).
    raw_token = customer_auth_service.start_password_reset(
        db, customer.email, ip_address=meta.get("ip_address"),
    )
    if raw_token is None:  # no resettable account behind that verified email
        b2c_audit.record_independently(
            admin=admin, action="customer.reset_password_initiated",
            outcome=AdminAuditOutcome.FAILURE, entity_type="customer", entity_id=customer_id,
            reason="no resettable account for email",
        )
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Customer has no resettable account.",
        )

    reset_link = f"{settings.frontend_base_url}/customer/reset-password.html?token={raw_token}"
    try:
        email_service.send_password_reset_email(
            customer.email, reset_link, settings.reset_token_expire_minutes,
        )
    except Exception:  # noqa: BLE001 — report the send failure; never reveal token state
        # The token was already persisted by start_password_reset. The email did
        # NOT go out, so leaving that token live would be an unintended usable
        # reset credential — invalidate it (mark it spent) before failing.
        try:
            customer_auth_service.invalidate_reset_token(db, raw_token)
            token_state = "invalidated"
        except Exception:  # noqa: BLE001 — DOUBLE FAILURE: send failed AND cleanup failed
            # We could not spend the token, so it stays live until its TTL
            # expires. Do NOT imply it was invalidated. Roll back the failed
            # cleanup, log loudly, and record the true state in the audit reason.
            db.rollback()
            token_state = "still live (invalidation failed)"
            logger.critical(
                "Reset email to customer %s FAILED and the unused reset token could NOT be "
                "invalidated; it remains usable until it expires — manual action may be required.",
                customer_id,
            )
        b2c_audit.record_independently(
            admin=admin, action="customer.reset_password_initiated",
            outcome=AdminAuditOutcome.FAILURE, entity_type="customer", entity_id=customer_id,
            reason=f"email delivery failed; token {token_state}",
        )
        # Message states only the email outcome — it never claims the token was
        # (or was not) invalidated, and carries no token or link.
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "The reset link could not be emailed; please try again.",
        )

    # The email IS sent now and cannot be un-sent. From here on the SUCCESS audit
    # must persist durably before we report success; it rides the same commit as
    # the optional force-logout.
    if payload.force_logout and customer.auth is not None:
        customer.auth.force_logout_at = dt.datetime.now(dt.timezone.utc)

    b2c_audit.record_in_session(
        db, admin=admin, action="customer.reset_password_initiated",
        outcome=AdminAuditOutcome.SUCCESS, entity_type="customer", entity_id=customer_id,
        new={"channel": "email", "force_logout": bool(payload.force_logout)},
    )
    try:
        db.commit()
    except Exception:  # noqa: BLE001 — email already sent; audit could not be recorded
        # EXTERNAL SIDE EFFECT: the reset email is already delivered; we cannot
        # roll it back. We also cannot claim a recorded success, so we do NOT
        # return 200. We log loudly, best-effort record the anomaly on an
        # independent session, and surface a 500 that leaks no token. The emailed
        # link stays valid for the customer (invalidating it would strand a user
        # who holds a working link); operators reconcile from this marker + logs.
        db.rollback()
        logger.critical(
            "RESET EMAIL SENT to customer %s but the SUCCESS audit failed to commit; "
            "manual audit reconciliation required.", customer_id,
        )
        b2c_audit.record_independently(
            admin=admin, action="customer.reset_password_initiated",
            outcome=AdminAuditOutcome.FAILURE, entity_type="customer", entity_id=customer_id,
            reason="email sent but success audit persistence failed",
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "The reset email was sent but the action could not be fully recorded; "
            "please verify in the audit log.",
        )
    return CustomerPasswordResetResponse(status="reset email sent")
