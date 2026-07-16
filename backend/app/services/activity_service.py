from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.misc import ActivityLog
from app.models.user import User


def log_activity(db: Session, user_id: int | None, action: str, ip_address: str | None = None) -> None:
    db.add(ActivityLog(user_id=user_id, action=action, ip_address=ip_address))
    db.commit()


def _filtered_stmt(search: str | None, action: str | None):
    stmt = select(ActivityLog, User.email).join(User, ActivityLog.user_id == User.id, isouter=True)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(or_(ActivityLog.action.ilike(pattern), User.email.ilike(pattern)))
    if action:
        stmt = stmt.where(ActivityLog.action == action)
    return stmt


def list_activity_logs_paginated(
    db: Session, page: int, page_size: int, search: str | None = None, action: str | None = None
):
    total = db.scalar(select(func.count()).select_from(_filtered_stmt(search, action).subquery())) or 0
    stmt = _filtered_stmt(search, action).order_by(ActivityLog.created_at.desc()).limit(page_size).offset((page - 1) * page_size)
    return db.execute(stmt).all(), total


def list_distinct_actions(db: Session) -> list[str]:
    return sorted(db.scalars(select(ActivityLog.action).distinct()).all())
