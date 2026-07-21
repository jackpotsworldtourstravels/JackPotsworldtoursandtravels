import datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models.misc import UserSession
from app.models.user import User

ONLINE_THRESHOLD_MINUTES = 2


def _online_cutoff() -> datetime.datetime:
    return datetime.datetime.utcnow() - datetime.timedelta(minutes=ONLINE_THRESHOLD_MINUTES)


def start_session(db: Session, user: User, meta: dict) -> UserSession:
    # Close any session left dangling by a closed tab / crashed client that never called /logout.
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == user.id, UserSession.is_active.is_(True))
        .values(is_active=False, logout_at=datetime.datetime.utcnow())
    )
    session = UserSession(
        user_id=user.id,
        ip_address=meta.get("ip_address"),
        browser=meta.get("browser"),
        os=meta.get("os"),
        device=meta.get("device"),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def _active_session(db: Session, user_id: int) -> UserSession | None:
    stmt = (
        select(UserSession)
        .where(UserSession.user_id == user_id, UserSession.is_active.is_(True))
        .order_by(UserSession.login_at.desc())
    )
    return db.scalar(stmt)


def end_session(db: Session, user_id: int) -> None:
    session = _active_session(db, user_id)
    if not session:
        return
    session.is_active = False
    session.logout_at = datetime.datetime.utcnow()
    db.commit()


def force_logout_all(db: Session, user_id: int) -> None:
    """Ends every active session for a user (admin 'Force Logout' action)."""
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.is_active.is_(True))
        .values(is_active=False, logout_at=datetime.datetime.utcnow())
    )
    db.commit()


def latest_session(db: Session, user_id: int) -> UserSession | None:
    stmt = select(UserSession).where(UserSession.user_id == user_id).order_by(UserSession.login_at.desc())
    return db.scalar(stmt)


def is_user_online(db: Session, user_id: int) -> bool:
    stmt = select(UserSession.id).where(
        UserSession.user_id == user_id, UserSession.is_active.is_(True), UserSession.last_seen_at >= _online_cutoff()
    )
    return db.scalar(stmt) is not None


def heartbeat(db: Session, user_id: int, current_page: str | None) -> UserSession | None:
    session = _active_session(db, user_id)
    if not session:
        return None
    session.last_seen_at = datetime.datetime.utcnow()
    if current_page:
        session.current_page = current_page
    db.commit()
    db.refresh(session)
    return session


def list_online_users(db: Session):
    stmt = (
        select(UserSession, User)
        .join(User, UserSession.user_id == User.id)
        .where(UserSession.is_active.is_(True), UserSession.last_seen_at >= _online_cutoff())
        .order_by(UserSession.last_seen_at.desc())
    )
    return db.execute(stmt).all()


def count_online_users(db: Session) -> int:
    stmt = select(func.count(func.distinct(UserSession.user_id))).where(
        UserSession.is_active.is_(True), UserSession.last_seen_at >= _online_cutoff()
    )
    return db.scalar(stmt) or 0


def count_active_sessions(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(UserSession).where(UserSession.is_active.is_(True))) or 0


def count_todays_logins(db: Session) -> int:
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return db.scalar(select(func.count()).select_from(UserSession).where(UserSession.login_at >= today_start)) or 0


def list_sessions_paginated(db: Session, page: int, page_size: int):
    total = db.scalar(select(func.count()).select_from(UserSession)) or 0
    stmt = (
        select(UserSession, User.email, User.full_name)
        .join(User, UserSession.user_id == User.id)
        .order_by(UserSession.login_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return db.execute(stmt).all(), total
