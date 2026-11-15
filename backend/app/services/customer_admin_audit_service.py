"""B2C administrative audit trail (Stage 2) — the authoritative record of what a
B2B administrator did to B2C data.

Writes rows to ``customer_admin_audit_logs`` (``models_customer`` Base). Two
modes, chosen by who owns the commit (spec §12.2, §13):

* :func:`record_in_session` adds the row to the CALLER's session and lets the
  caller's own ``commit()`` persist it — used where the router/service owns the
  terminal commit, so the audit is atomic with the business change.
* :func:`record_independently` writes+commits on a FRESH session, never
  flushing the caller's pending state — used for every FAILURE / DENIED and for
  sensitive reads, so an attempt is recorded even when the business txn rolled
  back and no unrelated change is committed.

Refund money-success is atomic via :func:`success_hook` (Approach C): the hook
``db.add``-s the row to the refund's own terminal transaction, so a rollback
leaves no succeeded-without-audit row and no false success.

Secrets are redacted BEFORE persistence. This module may not be imported by
``models_customer`` (which stays permission-code free); it is free to read the
B2B admin's identity to snapshot it.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import datetime as _dt

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database.session import SessionLocal
from app.models_customer import AdminAuditOutcome, CustomerAdminAuditLog
from app.services import activity_service, audit_service

logger = logging.getLogger("jackpots.b2c_audit")

# --- retention classification (D4) -----------------------------------------
_FINANCIAL_PREFIXES = ("refund.", "payment.", "cancellation.")
_SECURITY_ACTIONS = {"customer.view_detail", "payment.view_detail", "booking.view_detail",
                     "document.download", "report.preview", "customer.reset_password",
                     # Stage 3 M1 sensitive account mutations:
                     "customer.block", "customer.unblock", "customer.reset_password_initiated"}


def _retention_class(action: str, outcome: "AdminAuditOutcome") -> str:
    if action == "report.export" or action.startswith(_FINANCIAL_PREFIXES):
        return "financial"
    if action in _SECURITY_ACTIONS or outcome is AdminAuditOutcome.DENIED:
        return "security"
    return "ordinary"


# --- redaction (never store secrets) ---------------------------------------
def _redact(payload: Optional[dict]) -> Optional[dict]:
    """Mask any secret-looking key's value before the row is persisted.

    Reuses the same key pattern as the B2B audit reader
    (``password|_hash$|token|secret|otp_code|api_key``). Callers should already
    pass only the specific business fields that changed — never whole rows."""
    if payload is None:
        return None
    return audit_service.redact_values(payload)


# --- actor snapshot ---------------------------------------------------------
def _snapshot(admin: Any) -> dict:
    """A value snapshot of the B2B administrator — never a FK, never a secret."""
    if admin is None:
        return {"admin_user_id": None, "admin_email": None, "admin_name": None, "admin_role": None}
    role = getattr(admin, "role", None)
    return {
        "admin_user_id": getattr(admin, "user_id", None),
        "admin_email": getattr(admin, "email", None),
        "admin_name": getattr(admin, "full_name", None),
        "admin_role": getattr(role, "value", role) if role is not None else None,
    }


def _meta() -> dict:
    """Request correlation + origin from the existing ContextVar (D5)."""
    m = activity_service.current_request_meta()
    return {
        "request_id": m.get("request_id"),
        "ip_address": m.get("ip_address"),
        "browser": m.get("browser"),
        "device": m.get("device"),
    }


def build_entry(
    *,
    admin: Any = None,
    admin_snapshot: Optional[dict] = None,
    action: str,
    outcome: AdminAuditOutcome,
    entity_type: Optional[str] = None,
    entity_id: Optional[Any] = None,
    previous: Optional[dict] = None,
    new: Optional[dict] = None,
    reason: Optional[str] = None,
) -> CustomerAdminAuditLog:
    """Construct (but do not add/commit) an audit row with a redacted payload."""
    actor = admin_snapshot or _snapshot(admin)
    meta = _meta()
    return CustomerAdminAuditLog(
        admin_user_id=actor["admin_user_id"],
        admin_email=actor["admin_email"],
        admin_name=actor["admin_name"],
        admin_role=actor["admin_role"],
        environment="b2c",
        action=action,
        entity_type=entity_type,
        entity_id=None if entity_id is None else str(entity_id)[:64],
        outcome=outcome,
        retention_class=_retention_class(action, outcome),
        previous_value=_redact(previous),
        new_value=_redact(new),
        reason=reason,
        request_id=meta["request_id"],
        ip_address=meta["ip_address"],
        browser=meta["browser"],
        device=meta["device"],
    )


def record_in_session(db: Session, **kwargs) -> CustomerAdminAuditLog:
    """Add the row to the caller's transaction; the caller's commit persists it.

    READINESS (Stage 3 M0): before adding the row, assert the audit store is
    usable on this session's engine. If the ``customer_admin_audit_logs`` table
    is absent (migration 0095 not applied) or schema-incompatible, this raises
    503 BEFORE anything is added — so the business operation never reaches a
    commit it cannot audit (fail-closed; no swallow; atomicity preserved). If the
    caller's commit later fails for any other reason, the business change rolls
    back with the audit row."""
    from app.services import b2c_admin_readiness  # local import avoids any cycle
    b2c_admin_readiness.assert_ready(db.get_bind())
    row = build_entry(**kwargs)
    db.add(row)
    return row


def record_independently(*, required: bool = False, **kwargs) -> None:
    """Write + commit the row on a FRESH session, isolated from the caller.

    Always uses its own session and commit, so it never flushes or commits the
    caller's pending business state — there is no unrelated transaction to leak.

    ``required`` controls what happens if that write fails:

    * ``False`` (default) — RESILIENT. For FAILURE / DENIED events and any audit
      that must never break the business path: a write failure is logged and
      swallowed. Never a false success, but the business response is unchanged.
    * ``True`` — DURABLE / FAIL-CLOSED. For a SUCCESS audit of a sensitive READ
      that opens no business transaction (report preview, attachment download).
      The readiness door-gate runs *before* the handler, but the audit store can
      still become unwritable between that check and this INSERT; because the
      protected data must not be disclosed unless the access is durably
      recorded, a write failure is logged and RE-RAISED as 503, failing the read
      closed so the handler returns no protected content."""
    try:
        with SessionLocal() as session:
            session.add(build_entry(**kwargs))
            session.commit()
    except Exception:  # noqa: BLE001 — audit must never break the business path
        logger.exception("B2C admin audit write failed (required=%s, action=%s, entity=%s/%s)",
                         required, kwargs.get("action"), kwargs.get("entity_type"), kwargs.get("entity_id"))
        if required:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="B2C admin audit unavailable — protected read refused because it could not be recorded.",
            ) from None


def success_hook(admin: Any, *, action: str, entity_type: str, entity_id: Any = None,
                 new: Optional[dict] = None, reason: Optional[str] = None):
    """Return a callback ``(db, outcome, attempt)`` for refund Approach C (§13).

    The callback ``db.add``-s a SUCCESS row to the refund's OWN terminal
    transaction and does NOT commit — it rides the single ``apply_provider_refund``
    SUCCEEDED commit, so status + audit are atomic. If the add/commit fails the
    refund does not become succeeded and reconciliation re-drives it.

    ``admin`` is the live administrator for the synchronous execute/authorize
    paths; for a reconciliation-finalised refund the caller passes
    ``admin=None`` and this attributes the event to the attempt's recorded
    approver/initiator with a reconciliation action name."""
    snapshot = _snapshot(admin)

    def _hook(db: Session, outcome: str, attempt: Any) -> None:
        eid = entity_id if entity_id is not None else getattr(attempt, "refund_attempt_id", None)
        actor = snapshot
        act = action
        if snapshot["admin_user_id"] is None:
            # Reconciliation / system-driven finalisation: attribute to the
            # stored approver (or initiator), tagged as a reconcile event.
            actor = {
                "admin_user_id": getattr(attempt, "approved_by_user_id", None)
                or getattr(attempt, "initiated_by_user_id", None),
                "admin_email": None, "admin_name": None, "admin_role": "system:reconciliation",
            }
            act = "refund.reconcile_finalize"
        db.add(build_entry(
            admin_snapshot=actor, action=act, outcome=AdminAuditOutcome.SUCCESS,
            entity_type=entity_type, entity_id=eid,
            new=new or {"status": outcome, "amount_minor": getattr(attempt, "amount_minor", None),
                        "provider": getattr(attempt, "provider", None),
                        "attempt_number": getattr(attempt, "attempt_number", None)},
            reason=reason,
        ))

    return _hook


# --- read side (Stage 2C) ---------------------------------------------------
def list_entries(
    db: Session, *,
    actor: Optional[int] = None,
    action: Optional[str] = None,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    outcome: Optional["AdminAuditOutcome"] = None,
    date_from: Optional[_dt.date] = None,
    date_to: Optional[_dt.date] = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[CustomerAdminAuditLog], int]:
    """Read-only, filtered, paginated query over ``customer_admin_audit_logs``.

    Newest first. Returns ``(rows, total)``. There is no update/delete path —
    the trail is append-only (migration 0095 enforces it at the DB too). Date
    bounds are inclusive and compared on the calendar date, so they behave the
    same on Postgres (timestamptz) and the SQLite test engine.
    """
    conds = []
    if actor is not None:
        conds.append(CustomerAdminAuditLog.admin_user_id == actor)
    if action:
        conds.append(CustomerAdminAuditLog.action == action)
    if entity_type:
        conds.append(CustomerAdminAuditLog.entity_type == entity_type)
    if entity_id:
        conds.append(CustomerAdminAuditLog.entity_id == entity_id)
    if outcome is not None:
        conds.append(CustomerAdminAuditLog.outcome == outcome)
    if date_from is not None:
        conds.append(func.date(CustomerAdminAuditLog.created_at) >= date_from)
    if date_to is not None:
        conds.append(func.date(CustomerAdminAuditLog.created_at) <= date_to)

    total = db.scalar(
        select(func.count()).select_from(CustomerAdminAuditLog).where(*conds)
    ) or 0
    rows = db.scalars(
        select(CustomerAdminAuditLog).where(*conds)
        .order_by(
            CustomerAdminAuditLog.created_at.desc(),
            CustomerAdminAuditLog.customer_admin_audit_log_id.desc(),
        )
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    return list(rows), int(total)
