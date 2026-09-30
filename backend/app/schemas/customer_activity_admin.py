"""What the admin desk sees on the B2C User Activity screen — Phase 7 of the
B2C Admin Portal build-out. Read-only; an allow-list of what each row exposes.
"""
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class ActivityCustomerRef(BaseModel):
    #: None for an attempt against an address that matches no account (a failed
    #: sign-in) — "we do not know who that was" is the honest answer there.
    id: int | None
    code: str | None
    name: str | None
    email: str | None


class ActivityRow(BaseModel):
    log_id: int
    at: dt.datetime
    customer: ActivityCustomerRef
    module: str | None
    action: str
    description: str | None
    status: str
    ip_address: str | None
    browser: str | None
    device: str | None


class ActivityList(BaseModel):
    items: list[ActivityRow]
    total: int
    page: int
    page_size: int
    total_pages: int


class SessionRow(BaseModel):
    session_id: int
    customer_id: int
    customer_name: str
    customer_email: str
    login_at: dt.datetime
    last_seen_at: dt.datetime
    logout_at: dt.datetime | None
    #: active | idle | ended — derived, see the service for why the stored
    #: ``is_active`` flag alone is not trusted.
    state: str
    ip_address: str | None
    browser: str | None
    device: str | None


class SessionList(BaseModel):
    items: list[SessionRow]
    total: int
    page: int
    page_size: int
    total_pages: int


class ActivityWindow(BaseModel):
    logins: int
    failed_logins: int
    signups: int
    bookings_created: int


class ActivitySummary(BaseModel):
    last_24h: ActivityWindow
    last_7d: ActivityWindow
    #: Signed in and seen within the active window.
    active_now: int
    active_window_minutes: int
    #: For the module filter: what the log actually contains.
    modules: list[str]
