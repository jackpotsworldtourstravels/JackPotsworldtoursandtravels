from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.target_schema.audit_logs import AuditLog

# Rows are written automatically by the fn_ts_audit_row() DB trigger on
# ts_users/ts_merchants/ts_service_requests/ts_payments (see
# backend/db/target_schema/04_triggers.sql) — this module is read-only by
# design, matching how compliance audit trails should work (the application
# layer should not be able to edit or delete its own audit history).


def list_for_entity(db: Session, entity_type: str, entity_id: int) -> list[AuditLog]:
    return db.scalars(
        select(AuditLog)
        .where(AuditLog.entity_type == entity_type, AuditLog.entity_id == entity_id)
        .order_by(AuditLog.created_at.desc())
    ).all()


def list_recent(db: Session, *, entity_type: str | None = None, limit: int = 50) -> list[AuditLog]:
    stmt = select(AuditLog)
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    return db.scalars(stmt.order_by(AuditLog.created_at.desc()).limit(limit)).all()
