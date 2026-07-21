import re

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.misc import ActivityLog
from app.models.user import User

_BROWSER_PATTERNS = [
    ("Edge", re.compile(r"Edg/")),
    ("Opera", re.compile(r"OPR/|Opera")),
    ("Chrome", re.compile(r"Chrome/")),
    ("Firefox", re.compile(r"Firefox/")),
    ("Safari", re.compile(r"Version/.*Safari/")),
    ("Internet Explorer", re.compile(r"MSIE|Trident/")),
]

_OS_PATTERNS = [
    ("Windows", re.compile(r"Windows")),
    ("macOS", re.compile(r"Mac OS X")),
    ("iOS", re.compile(r"iPhone|iPad|iPod")),
    ("Android", re.compile(r"Android")),
    ("Linux", re.compile(r"Linux")),
]


def request_context(request) -> dict:
    """Pull ip/browser/os/device out of a FastAPI Request for activity/session logging."""
    ip = request.client.host if request.client else None
    browser, os_name, device = parse_user_agent(request.headers.get("user-agent"))
    return {"ip_address": ip, "browser": browser, "os": os_name, "device": device}


def parse_user_agent(user_agent: str | None) -> tuple[str | None, str | None, str | None]:
    """Best-effort browser/OS/device sniffing from a raw User-Agent header.

    Deliberately lightweight (no dependency) — good enough to populate an admin
    activity table, not a precise device-fingerprinting tool.
    """
    if not user_agent:
        return None, None, None
    browser = next((name for name, pattern in _BROWSER_PATTERNS if pattern.search(user_agent)), "Other")
    os_name = next((name for name, pattern in _OS_PATTERNS if pattern.search(user_agent)), "Other")
    if "iPad" in user_agent or "Tablet" in user_agent:
        device = "Tablet"
    elif "Mobi" in user_agent or "iPhone" in user_agent or "Android" in user_agent:
        device = "Mobile"
    else:
        device = "Desktop"
    return browser, os_name, device


def log_activity(
    db: Session,
    user_id: int | None,
    action: str,
    ip_address: str | None = None,
    *,
    activity_type: str | None = None,
    module: str | None = None,
    description: str | None = None,
    reference_id: int | None = None,
    browser: str | None = None,
    device: str | None = None,
    status: str = "success",
) -> None:
    db.add(
        ActivityLog(
            user_id=user_id,
            action=action,
            ip_address=ip_address,
            activity_type=activity_type,
            module=module,
            description=description or action,
            reference_id=reference_id,
            browser=browser,
            device=device,
            status=status,
        )
    )
    db.commit()


def _filtered_stmt(search: str | None, action: str | None, module: str | None = None):
    stmt = select(ActivityLog, User.email, User.full_name).join(
        User, ActivityLog.user_id == User.id, isouter=True
    )
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(or_(ActivityLog.action.ilike(pattern), User.email.ilike(pattern)))
    if action:
        stmt = stmt.where(ActivityLog.action == action)
    if module:
        stmt = stmt.where(ActivityLog.module == module)
    return stmt


def list_activity_logs_paginated(
    db: Session,
    page: int,
    page_size: int,
    search: str | None = None,
    action: str | None = None,
    module: str | None = None,
):
    total = db.scalar(select(func.count()).select_from(_filtered_stmt(search, action, module).subquery())) or 0
    stmt = (
        _filtered_stmt(search, action, module)
        .order_by(ActivityLog.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return db.execute(stmt).all(), total


def list_distinct_actions(db: Session) -> list[str]:
    return sorted(db.scalars(select(ActivityLog.action).distinct()).all())


def list_distinct_modules(db: Session) -> list[str]:
    return sorted(m for m in db.scalars(select(ActivityLog.module).distinct()).all() if m)


def list_recent_activity(db: Session, limit: int = 20):
    stmt = (
        select(ActivityLog, User.email, User.full_name)
        .join(User, ActivityLog.user_id == User.id, isouter=True)
        .order_by(ActivityLog.created_at.desc())
        .limit(limit)
    )
    return db.execute(stmt).all()
