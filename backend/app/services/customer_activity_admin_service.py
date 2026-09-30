"""Reading what B2C customers have done on the site — Phase 7 of the B2C Admin
Portal build-out (User Activity).

READ-ONLY, OVER TWO EXISTING TABLES. ``customer_audit_logs`` (every sign-in,
failed sign-in, OTP, signup, profile change, booking and payment attempt) and
``customer_sessions`` (one row per sign-in). Neither is created or changed.

WHAT IS DELIBERATELY NOT SHOWN: ``customer_activity``, the browsing signal (which
destinations/hotels/packages someone viewed or searched) that
``recommendation_service`` scores. Migration 0085 records it for personalising a
customer's OWN suggestions and stores no IP or free text on that basis; putting
each person's browsing history in front of the whole admin desk is a different
use than the one it was collected for. If the desk needs it, that is a decision
to make on purpose, not a side effect of building this screen.

"ACTIVE" IS DERIVED FROM LAST-SEEN, NOT FROM ``is_active``. That flag is only
cleared by an explicit sign-out, so a customer who simply closed the tab stays
"active" forever — in the development database 98 sessions carry the flag while
having last been seen days ago. A session is ``active`` only if it has not
signed out and was seen within ``ACTIVE_WINDOW_MINUTES``; a session that never
signed out but has gone quiet is ``idle``; anything signed out is ``ended``.
"""
from __future__ import annotations

import datetime as dt
import math

from sqlalchemy import and_, distinct, func, or_, select
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerAuditLog, CustomerSession

ACTIVE_WINDOW_MINUTES = 30
SESSION_STATES = ("active", "idle", "ended")
AUDIT_STATUSES = ("success", "failed")


def _pages(total: int, page_size: int) -> int:
    return max(1, math.ceil(total / page_size))


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _state_condition(state: str):
    cutoff = _now() - dt.timedelta(minutes=ACTIVE_WINDOW_MINUTES)
    open_ = and_(CustomerSession.logout_at.is_(None), CustomerSession.is_active.is_(True))
    if state == "active":
        return and_(open_, CustomerSession.last_seen_at >= cutoff)
    if state == "idle":
        return and_(open_, CustomerSession.last_seen_at < cutoff)
    return ~open_


def _session_state(s: CustomerSession, cutoff: dt.datetime) -> str:
    if s.logout_at is not None or not s.is_active:
        return "ended"
    return "active" if s.last_seen_at >= cutoff else "idle"


def list_activity(
    db: Session, *, page: int, page_size: int, module: str | None = None,
    log_status: str | None = None, search: str | None = None,
    date_from: dt.date | None = None, date_to: dt.date | None = None,
    customer_id: int | None = None,
) -> dict:
    conds = []
    if module:
        conds.append(CustomerAuditLog.module == module)
    if log_status:
        conds.append(CustomerAuditLog.status == log_status)
    if customer_id is not None:
        conds.append(CustomerAuditLog.customer_id == customer_id)
    if date_from:
        conds.append(CustomerAuditLog.created_at >= dt.datetime.combine(date_from, dt.time.min, tzinfo=dt.timezone.utc))
    if date_to:
        conds.append(CustomerAuditLog.created_at < dt.datetime.combine(date_to + dt.timedelta(days=1), dt.time.min, tzinfo=dt.timezone.utc))
    if search:
        like = f"%{search.strip()}%"
        conds.append(or_(
            CustomerAuditLog.action.ilike(like), CustomerAuditLog.description.ilike(like),
            CustomerAuditLog.customer_code.ilike(like), CustomerAuditLog.ip_address.ilike(like),
            Customer.full_name.ilike(like), Customer.email.ilike(like),
        ))
    # OUTER join: a failed sign-in against an unknown address has no customer.
    base = select(CustomerAuditLog, Customer).outerjoin(
        Customer, Customer.customer_id == CustomerAuditLog.customer_id).where(*conds)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.execute(
        base.order_by(CustomerAuditLog.created_at.desc(), CustomerAuditLog.customer_audit_log_id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    return {
        "items": [{
            "log_id": a.customer_audit_log_id, "at": a.created_at,
            "customer": {
                "id": c.customer_id if c else None, "code": a.customer_code or (c.customer_code if c else None),
                "name": c.full_name if c else None, "email": c.email if c else None,
            },
            "module": a.module, "action": a.action, "description": a.description,
            "status": a.status.value if hasattr(a.status, "value") else a.status,
            "ip_address": a.ip_address, "browser": a.browser, "device": a.device,
        } for a, c in rows],
        "total": total, "page": page, "page_size": page_size, "total_pages": _pages(total, page_size),
    }


def list_sessions(
    db: Session, *, page: int, page_size: int, state: str | None = None,
    search: str | None = None, customer_id: int | None = None,
) -> dict:
    conds = []
    if state:
        conds.append(_state_condition(state))
    if customer_id is not None:
        conds.append(CustomerSession.customer_id == customer_id)
    if search:
        like = f"%{search.strip()}%"
        conds.append(or_(
            Customer.full_name.ilike(like), Customer.email.ilike(like),
            CustomerSession.ip_address.ilike(like), CustomerSession.browser.ilike(like),
        ))
    base = select(CustomerSession, Customer).join(
        Customer, Customer.customer_id == CustomerSession.customer_id).where(*conds)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.execute(
        base.order_by(CustomerSession.login_at.desc(), CustomerSession.customer_session_id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    cutoff = _now() - dt.timedelta(minutes=ACTIVE_WINDOW_MINUTES)
    return {
        "items": [{
            "session_id": s.customer_session_id, "customer_id": c.customer_id,
            "customer_name": c.full_name, "customer_email": c.email, "login_at": s.login_at,
            "last_seen_at": s.last_seen_at, "logout_at": s.logout_at,
            "state": _session_state(s, cutoff), "ip_address": s.ip_address,
            "browser": s.browser, "device": s.device,
        } for s, c in rows],
        "total": total, "page": page, "page_size": page_size, "total_pages": _pages(total, page_size),
    }


def _window(db: Session, since: dt.datetime) -> dict:
    def n(*extra) -> int:
        return db.scalar(select(func.count()).where(CustomerAuditLog.created_at >= since, *extra)) or 0

    ok = CustomerAuditLog.status == "success"
    return {
        "logins": n(CustomerAuditLog.action == "Login", ok),
        "failed_logins": n(CustomerAuditLog.action == "Failed login"),
        "signups": n(CustomerAuditLog.action == "Signup", ok),
        # 'Booking created', 'Hotel booking created', 'Package booking created'.
        "bookings_created": n(CustomerAuditLog.action.ilike("%booking created"), ok),
    }


def summary(db: Session) -> dict:
    now = _now()
    active = db.scalar(
        select(func.count(distinct(CustomerSession.customer_id))).where(_state_condition("active"))
    ) or 0
    modules = [m for (m,) in db.execute(
        select(CustomerAuditLog.module).where(CustomerAuditLog.module.is_not(None))
        .group_by(CustomerAuditLog.module).order_by(CustomerAuditLog.module))]
    return {
        "last_24h": _window(db, now - dt.timedelta(hours=24)),
        "last_7d": _window(db, now - dt.timedelta(days=7)),
        "active_now": active, "active_window_minutes": ACTIVE_WINDOW_MINUTES, "modules": modules,
    }
