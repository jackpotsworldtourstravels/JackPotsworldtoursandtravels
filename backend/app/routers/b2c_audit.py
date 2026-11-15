"""B2C administrative audit trail — read API (Stage 2C).

``GET /api/admin/b2c-audit`` — the ONLY endpoint over ``customer_admin_audit_logs``.
Read-only by design: there is deliberately no create/update/delete route, matching
the table's append-only guarantee (migration 0095's trigger).

Access is gated on the EXPLICIT ``b2c.audit.view`` scope via ``require_scope`` —
which consults per-user grants (``users.permissions``) and the super-admin
short-circuit, never the role-default matrix. So a role-default B2B administrator
who was never granted the scope is refused (B2B/B2C isolation preserved). Uses the
existing single engine/session (``get_db``); the table lives on ``models_customer``.
Sensitive values are redacted before any record is returned.
"""
from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, require_scope
from app.database.session import get_db
from app.models_customer import AdminAuditOutcome
from app.models_v2 import User
from app.schemas.b2c_audit import B2cAuditEntry
from app.schemas.pagination import Page
from app.services import customer_admin_audit_service as audit

router = APIRouter(prefix="/api/admin/b2c-audit", tags=["admin-b2c-audit"])


@router.get(
    "",
    response_model=Page[B2cAuditEntry],
    summary="Read the B2C administrative audit trail",
    description=(
        "Requires the explicit `b2c.audit.view` scope (or super admin). Read-only, "
        "newest first. Filter by `actor` (admin_user_id), `action`, `entity_type`, "
        "`entity_id`, `outcome` and an inclusive `date_from`/`date_to` range. "
        "Sensitive values are redacted; there is no edit or delete endpoint."
    ),
)
def list_b2c_audit(
    db: Session = Depends(get_db),
    _: User = Depends(require_scope(P.B2C_AUDIT_VIEW)),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    actor: int | None = Query(None, description="admin_user_id of the acting administrator"),
    action: str | None = Query(None, max_length=100),
    entity_type: str | None = Query(None, max_length=60),
    entity_id: str | None = Query(None, max_length=64),
    outcome: str | None = Query(None, description="success | failure | denied | partial"),
    date_from: dt.date | None = Query(None),
    date_to: dt.date | None = Query(None),
) -> Page[B2cAuditEntry]:
    outcome_enum: AdminAuditOutcome | None = None
    if outcome is not None:
        try:
            outcome_enum = AdminAuditOutcome(outcome)
        except ValueError:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown outcome {outcome!r}."
            )
    if date_from and date_to and date_to < date_from:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "date_to is before date_from."
        )

    rows, total = audit.list_entries(
        db, actor=actor, action=action, entity_type=entity_type, entity_id=entity_id,
        outcome=outcome_enum, date_from=date_from, date_to=date_to,
        page=page, page_size=page_size,
    )
    return Page.build([B2cAuditEntry.from_model(r) for r in rows], total, page, page_size)
