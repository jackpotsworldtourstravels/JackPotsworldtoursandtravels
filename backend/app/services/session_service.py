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

#: How long after their last heartbeat a user is still described as *Recently
#: Active* rather than *Offline*.
#:
#: The online window is deliberately tiny — two minutes, so "🟢 Online" means
#: someone is at the keyboard right now — but that makes it a poor answer on its
#: own: a user who closed a tab ninety seconds ago and one who has not signed in
#: for a month both read as Offline, and an admin looking at the list cannot
#: tell them apart. Fifteen minutes is the usual idle-session convention and is
#: short enough that "recently" still means it.
RECENTLY_ACTIVE_MINUTES = 15

SESSION_MODULE = "Auth"
SESSION_ACTION = "Session"
STATUS_ACTIVE = "active"
STATUS_ENDED = "ended"

#: The four presence states the Admin Active Users screen shows and filters on.
PRESENCE_ONLINE = "online"
PRESENCE_RECENT = "recently_active"
PRESENCE_OFFLINE = "offline"
PRESENCE_NEVER = "never_logged_in"

PRESENCE_LABELS = {
    PRESENCE_ONLINE: "Online",
    PRESENCE_RECENT: "Recently Active",
    PRESENCE_OFFLINE: "Offline",
    PRESENCE_NEVER: "Never Logged In",
}


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
        # `local_ip` joins `os` in the blob for the same reason it does in
        # activity_service: system_logs has one INET column and it holds the
        # address the user actually connected from. A LAN address is only ever
        # present when the client is on this network or a proxy forwarded it,
        # so it is stored when it exists and simply absent when it does not.
        extra_data={
            "os": meta.get("os"),
            "local_ip": clean_ip(meta.get("local_ip")),
            "current_page": None,
        },
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


def latest_sessions(db: Session, user_ids: list[int]) -> dict[int, SystemLog]:
    """The newest session row for each of these users, keyed by user id.

    One query for a whole page of the Active Users list. ``DISTINCT ON`` is
    PostgreSQL's idiom for "the newest row per group" and does it in a single
    index scan over ``ix_syslog_user_id`` — the alternative, a window function
    or a correlated subquery per row, is N+1 dressed up.
    """
    if not user_ids:
        return {}
    stmt = (
        select(SystemLog)
        .where(and_(_session_filter(), SystemLog.user_id.in_(user_ids)))
        .distinct(SystemLog.user_id)
        .order_by(SystemLog.user_id, SystemLog.created_at.desc())
    )
    return {row.user_id: row for row in db.scalars(stmt).all()}


def last_seen_at(session: SystemLog | None) -> datetime.datetime | None:
    """When this session last showed a sign of life.

    ``session_expires_at`` is the heartbeat plus :data:`ONLINE_THRESHOLD_MINUTES`
    (see the module docstring), so the heartbeat itself is that value minus the
    same offset. A session with no heartbeat at all has only ever been seen at
    login.
    """
    if session is None:
        return None
    if session.session_expires_at is None:
        return session.created_at
    return session.session_expires_at - datetime.timedelta(minutes=ONLINE_THRESHOLD_MINUTES)


def presence_of(user, session: SystemLog | None) -> str:
    """Which of the four states this user is in.

    ``last_login`` rather than the session row decides *Never Logged In*: the
    sessions table is ``system_logs``, which is prunable operational data, while
    ``users.last_login`` is the durable record of whether an account has ever
    been used. Reading presence off the log would turn a housekeeping job into
    "nobody has ever signed in".
    """
    if getattr(user, "last_login", None) is None and session is None:
        return PRESENCE_NEVER
    if session is None:
        return PRESENCE_OFFLINE
    now = _now()
    if session.status == STATUS_ACTIVE and (session.session_expires_at or now) >= now:
        return PRESENCE_ONLINE
    seen = last_seen_at(session)
    if seen and (now - seen) <= datetime.timedelta(minutes=RECENTLY_ACTIVE_MINUTES):
        return PRESENCE_RECENT
    return PRESENCE_OFFLINE


def online_user_ids_stmt():
    """A SELECT of every user id with a live heartbeat, for use as a subquery.

    Exposed so the Active Users listing can filter on presence *inside* the
    paginated query. Filtering it in Python after the page was fetched would
    return a short page and a total that disagrees with it.
    """
    return select(SystemLog.user_id).where(_online_filter())


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
