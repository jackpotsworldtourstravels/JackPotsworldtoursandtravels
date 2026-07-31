"""Session tracking on the v2 ``system_logs`` table.

Replaces the legacy ``user_sessions`` table. A session is a ``system_logs``
row with ``module='Auth'`` and ``action='Session'``:

===========================  ==================================================
Legacy ``user_sessions``     v2 ``system_logs``
===========================  ==================================================
``id``                       ``log_id``
``login_at``                 ``created_at``
``is_active``                ``status`` — ``'active'`` or ``'ended'``
``last_seen_at``             ``session_expires_at`` minus ``ONLINE_THRESHOLD``
``logout_at``                ``extra_data->>'logout_at'``
``os`` / ``current_page``    ``extra_data``
===========================  ==================================================

``session_expires_at`` carries the heartbeat deliberately: "who is online"
is the hot query on the admin dashboard, and this keeps it on an indexed
timestamp column instead of a JSONB extraction.
"""
import datetime
import secrets

from sqlalchemy import and_, func, select, update
from sqlalchemy.orm import Session

from app.models_v2 import SystemLog, User
from app.services.activity_service import clean_ip

ONLINE_THRESHOLD_MINUTES = 2

SESSION_MODULE = "Auth"
SESSION_ACTION = "Session"
STATUS_ACTIVE = "active"
STATUS_ENDED = "ended"


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _session_filter():
    return and_(
        SystemLog.module == SESSION_MODULE,
        SystemLog.action == SESSION_ACTION,
    )


def _active_filter():
    return and_(_session_filter(), SystemLog.status == STATUS_ACTIVE)


def _online_filter():
    return and_(_active_filter(), SystemLog.session_expires_at >= _now())


def start_session(db: Session, user: User, meta: dict) -> SystemLog:
    """Open a session, closing any left dangling by a crashed/closed client."""
    now = _now()
    db.execute(
        update(SystemLog)
        .where(and_(_active_filter(), SystemLog.user_id == user.user_id))
        .values(status=STATUS_ENDED)
    )
    session = SystemLog(
        user_id=user.user_id,
        merchant_id=user.merchant_id,
        module=SESSION_MODULE,
        action=SESSION_ACTION,
        description=f"{user.full_name} session started",
        ip_address=clean_ip(meta.get("ip_address")),
        browser=meta.get("browser"),
        device=meta.get("device"),
        session_token=secrets.token_urlsafe(32),
        session_expires_at=now + datetime.timedelta(minutes=ONLINE_THRESHOLD_MINUTES),
        status=STATUS_ACTIVE,
        extra_data={"os": meta.get("os"), "current_page": None},
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def _active_session(db: Session, user_id: int) -> SystemLog | None:
    stmt = (
        select(SystemLog)
        .where(and_(_active_filter(), SystemLog.user_id == user_id))
        .order_by(SystemLog.created_at.desc())
    )
    return db.scalars(stmt).first()


def end_session(db: Session, user_id: int) -> None:
    session = _active_session(db, user_id)
    if not session:
        return
    session.status = STATUS_ENDED
    session.extra_data = {**(session.extra_data or {}), "logout_at": _now().isoformat()}
    db.commit()


def force_logout_all(db: Session, user_id: int) -> None:
    """Ends every active session for a user (admin 'Force Logout' action)."""
    db.execute(
        update(SystemLog)
        .where(and_(_active_filter(), SystemLog.user_id == user_id))
        .values(status=STATUS_ENDED)
    )
    db.commit()


def latest_session(db: Session, user_id: int) -> SystemLog | None:
    stmt = (
        select(SystemLog)
        .where(and_(_session_filter(), SystemLog.user_id == user_id))
        .order_by(SystemLog.created_at.desc())
    )
    return db.scalars(stmt).first()


def is_user_online(db: Session, user_id: int) -> bool:
    stmt = select(SystemLog.log_id).where(
        and_(_online_filter(), SystemLog.user_id == user_id)
    )
    return db.scalars(stmt).first() is not None


def online_user_ids(db: Session, user_ids: list[int]) -> set[int]:
    """Which of these users currently have a live heartbeat.

    One query for a whole page of results — the Active Users list needs
    this per row, and checking one at a time would be N+1.
    """
    if not user_ids:
        return set()
    stmt = select(SystemLog.user_id).where(
        and_(_online_filter(), SystemLog.user_id.in_(user_ids))
    ).distinct()
    return set(db.scalars(stmt).all())


def heartbeat(db: Session, user_id: int, current_page: str | None) -> SystemLog | None:
    session = _active_session(db, user_id)
    if not session:
        return None
    session.session_expires_at = _now() + datetime.timedelta(minutes=ONLINE_THRESHOLD_MINUTES)
    if current_page:
        session.extra_data = {**(session.extra_data or {}), "current_page": current_page}
    db.commit()
    db.refresh(session)
    return session


def list_online_users(db: Session):
    stmt = (
        select(SystemLog, User)
        .join(User, SystemLog.user_id == User.user_id)
        .where(_online_filter())
        .order_by(SystemLog.session_expires_at.desc())
    )
    return db.execute(stmt).all()


def count_online_users(db: Session) -> int:
    return (
        db.scalar(
            select(func.count(func.distinct(SystemLog.user_id))).where(_online_filter())
        )
        or 0
    )


def count_active_sessions(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(SystemLog).where(_active_filter())) or 0


def count_todays_logins(db: Session) -> int:
    today_start = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        db.scalar(
            select(func.count())
            .select_from(SystemLog)
            .where(and_(_session_filter(), SystemLog.created_at >= today_start))
        )
        or 0
    )


def list_sessions_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(SystemLog).where(_session_filter())) or 0
    stmt = (
        select(SystemLog, User.email, User.full_name)
        .join(User, SystemLog.user_id == User.user_id)
        .where(_session_filter())
        .order_by(SystemLog.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return db.execute(stmt).all(), total
