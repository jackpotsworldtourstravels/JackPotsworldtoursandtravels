"""Audit Logs — read-only queries over the trigger-populated ``audit_logs`` table.

Rows arrive from ``fn_write_audit_log`` (see migration 0023's DDL), never
from application code — this module only ever reads.
"""
import datetime

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models_v2 import AuditLog, AuditOperation, User


def list_audit_logs(
    db: Session,
    page: int,
    page_size: int,
    *,
    table_name: str | None = None,
    operation: AuditOperation | None = None,
    changed_by: int | None = None,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
) -> tuple[list[tuple], int]:
    conditions = []
    if table_name:
        conditions.append(AuditLog.table_name == table_name)
    if operation is not None:
        conditions.append(AuditLog.operation == operation)
    if changed_by is not None:
        conditions.append(AuditLog.changed_by == changed_by)
    if date_from is not None:
        conditions.append(AuditLog.changed_at >= date_from)
    if date_to is not None:
        conditions.append(AuditLog.changed_at <= date_to)
    where = and_(*conditions) if conditions else True

    total = db.scalar(select(func.count()).select_from(AuditLog).where(where)) or 0
    stmt = (
        select(AuditLog, User.full_name, User.email)
        .join(User, AuditLog.changed_by == User.user_id, isouter=True)
        .where(where)
        .order_by(AuditLog.changed_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return list(db.execute(stmt).all()), total


def list_audited_tables(db: Session) -> list[str]:
    return sorted(db.scalars(select(AuditLog.table_name).distinct()).all())
