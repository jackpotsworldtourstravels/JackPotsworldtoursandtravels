import datetime

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.models.target_schema.system_logs import SystemLog
from app.models.target_schema.users import User


def log_activity(
    db: Session, *, user_id: int | None, event: str, entity_type: str | None = None,
    entity_id: int | None = None, ip_address: str | None = None, activity_type: str | None = None,
    module: str | None = None, status: str = "success",
) -> SystemLog:
    entry = SystemLog(
        log_type="activity", user_id=user_id, event=event, entity_type=entity_type, entity_id=entity_id,
        ip_address=ip_address, activity_type=activity_type, module=module, status=status,
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db.add(entry)
    db.commit()
    return entry


ONLINE_THRESHOLD_MINUTES = 2


def log_session_start(db: Session, *, user_id: int, ip_address: str | None = None) -> SystemLog:
    now = datetime.datetime.now(datetime.timezone.utc)
    # Close any session left dangling by a closed tab / crashed client that
    # never called /logout, same as the legacy session_service.start_session.
    db.execute(
        update(SystemLog)
        .where(SystemLog.log_type == "session", SystemLog.user_id == user_id, SystemLog.logged_out_at.is_(None))
        .values(logged_out_at=now)
    )
    entry = SystemLog(log_type="session", user_id=user_id, ip_address=ip_address, last_seen_at=now, created_at=now)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def log_session_end(db: Session, session_log_id: int) -> None:
    entry = db.get(SystemLog, session_log_id)
    if entry:
        entry.logged_out_at = datetime.datetime.now(datetime.timezone.utc)
        db.commit()


def end_latest_session(db: Session, user_id: int) -> None:
    """Ends the user's most recent still-open session — for logout call
    sites that only have the user, not the specific session-log row id
    returned by log_session_start (mirrors the legacy session_service.end_session
    behavior, which also looked up "the" active session rather than tracking
    a session id through the request lifecycle)."""
    entry = db.scalar(
        select(SystemLog)
        .where(SystemLog.log_type == "session", SystemLog.user_id == user_id, SystemLog.logged_out_at.is_(None))
        .order_by(SystemLog.created_at.desc())
        .limit(1)
    )
    if entry:
        entry.logged_out_at = datetime.datetime.now(datetime.timezone.utc)
        db.commit()


def heartbeat(db: Session, user_id: int, current_page: str | None) -> None:
    entry = db.scalar(
        select(SystemLog)
        .where(SystemLog.log_type == "session", SystemLog.user_id == user_id, SystemLog.logged_out_at.is_(None))
        .order_by(SystemLog.created_at.desc())
        .limit(1)
    )
    if not entry:
        return
    entry.last_seen_at = datetime.datetime.now(datetime.timezone.utc)
    if current_page:
        entry.log_metadata = {**(entry.log_metadata or {}), "current_page": current_page}
    db.commit()


def is_user_online(db: Session, user_id: int, threshold_minutes: int = ONLINE_THRESHOLD_MINUTES) -> bool:
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=threshold_minutes)
    return (
        db.scalar(
            select(SystemLog.id).where(
                SystemLog.log_type == "session", SystemLog.user_id == user_id,
                SystemLog.logged_out_at.is_(None), SystemLog.last_seen_at >= cutoff,
            ).limit(1)
        )
        is not None
    )


def log_report_generation(db: Session, *, user_id: int, filters: dict, export_format: str) -> SystemLog:
    entry = SystemLog(
        log_type="report_generation", user_id=user_id,
        log_metadata={"filters": filters, "export_format": export_format},
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db.add(entry)
    db.commit()
    return entry


def list_recent_activity(db: Session, *, user_id: int | None = None, limit: int = 20):
    stmt = (
        select(SystemLog, User.email, User.full_name)
        .outerjoin(User, SystemLog.user_id == User.id)
        .where(SystemLog.log_type == "activity")
        .order_by(SystemLog.created_at.desc())
        .limit(limit)
    )
    if user_id is not None:
        stmt = stmt.where(SystemLog.user_id == user_id)
    return db.execute(stmt).all()


def _filtered_activity_stmt(search: str | None, action: str | None, module: str | None):
    stmt = (
        select(SystemLog, User.email, User.full_name)
        .outerjoin(User, SystemLog.user_id == User.id)
        .where(SystemLog.log_type == "activity")
    )
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(or_(SystemLog.event.ilike(pattern), User.email.ilike(pattern)))
    if action:
        stmt = stmt.where(SystemLog.activity_type == action)
    if module:
        stmt = stmt.where(SystemLog.module == module)
    return stmt


def list_activity_logs_paginated(db: Session, page: int, page_size: int, *, search=None, action=None, module=None):
    stmt = _filtered_activity_stmt(search, action, module)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    stmt = stmt.order_by(SystemLog.created_at.desc()).limit(page_size).offset((page - 1) * page_size)
    return db.execute(stmt).all(), total


def list_distinct_actions(db: Session) -> list[str]:
    return sorted(
        a for a in db.scalars(
            select(SystemLog.activity_type).where(SystemLog.log_type == "activity").distinct()
        ).all() if a
    )


def list_distinct_modules(db: Session) -> list[str]:
    return sorted(
        m for m in db.scalars(
            select(SystemLog.module).where(SystemLog.log_type == "activity").distinct()
        ).all() if m
    )
