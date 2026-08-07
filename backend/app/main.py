import asyncio
import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import func, select
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import SessionLocal, engine
from app.models_v2 import User
from app.routers import (
    admin_ops,
    analytics,
    auth,
    booking_ops,
    change_requests,
    dashboard,
    documents,
    enquiries,
    finance,
    group_bookings,
    manager,
    manager_approvals,
    messages,
    merchant_approvals,
    merchant_team,
    merchants,
    notifications_v2,
    profile,
    providers,
    reports,
    super_admin,
    support_tickets,
    tickets,
    payment_admin,
    wallet,
)
from app.services import activity_service, booking_completion_service, user_service

logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
logger = logging.getLogger("jackpots.startup")

# ---------------------------------------------------------------------------
# Schema v2 migration status
# ---------------------------------------------------------------------------
# Migration 0023 replaced the 42-table legacy schema with nine tables. The
# application is being ported module by module; only ported routers are
# registered below. An unported router would import fine but 500 on every
# request, so leaving them out gives an honest 404 instead.
#
# Ported:     auth
# Pending:    content (catalog), bookings, wishlist, reviews, notifications,
#             support_tickets, misc, users, admin, customers,
#             booking_management, payment_management, pricing,
#             admin_merchants, admin_partner_requests, partner_* (9 routers),
#             super_admin
#
# See docs/SCHEMA_V2.md for the module-by-module plan.
# ---------------------------------------------------------------------------

app = FastAPI(
    title="JackPots World Tours & Travels API",
    description=(
        "REST API for the JackPots World Tours & Travels booking platform, covering flights, hotels, "
        "cruises, and tour packages. Authentication uses JWT access/refresh tokens with separate user "
        "and admin roles. Includes a booking and mock-payment flow, plus wishlist, reviews, "
        "notifications, and activity-log features for end users, and reporting/CSV export tools for admins."
        "\n\n**Schema v2 port in progress** — see /api/status for which modules are live."
    ),
    version="2.0.0-alpha",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ---------------------------------------------------------------------------
# Security response headers (M8)
# ---------------------------------------------------------------------------
# deploy/Caddyfile already sets these at the edge, and that is the production
# path. They are set here as well, deliberately, because an edge is not the
# only way this app is reached: deploy/nginx.conf is a supported alternative
# that set none of them, a container can be port-mapped directly during an
# incident, and a staging box behind a plain proxy inherits whatever the proxy
# forgot. A header that only exists in one deployment's config is a header you
# cannot rely on. Caddy's `header` directive replaces rather than appends, so
# nothing is duplicated where both are in play.
#
# HSTS is NOT set here. It would be wrong on the plain-HTTP origin the proxy
# talks to, and telling a browser "never use HTTP for this host" is a decision
# that belongs where TLS is actually terminated — Caddy sets it there.
_SECURITY_HEADERS = {
    # Stop a browser second-guessing Content-Type. Combined with the upload
    # allowlist and magic-byte sniff, this is what keeps a stored file from
    # ever being interpreted as script.
    "X-Content-Type-Options": "nosniff",
    # No portal here is ever meant to be framed; clickjacking a payment
    # verification or an approval button is the concrete risk.
    "X-Frame-Options": "DENY",
    # Referrer-Policy: request paths carry booking ids. Send the origin only.
    "Referrer-Policy": "strict-origin-when-cross-origin",
    # None of these portals uses a camera, a microphone or geolocation.
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
}


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    for header, value in _SECURITY_HEADERS.items():
        # setdefault semantics: a route that deliberately sets its own value —
        # the document download's Cache-Control, for instance — keeps it.
        response.headers.setdefault(header, value)
    return response


@app.middleware("http")
async def request_metadata(request, call_next):
    """Bind who-connected-from-where for the whole request, and ask for more.

    WHY THIS EXISTS. ``system_logs`` has always had ip/browser/device columns,
    but only the four endpoints in ``routers/auth.py`` ever filled them — every
    other action was logged from a service function with no ``Request`` in
    scope, so the Admin portal's System Logs screen showed an empty Origin for
    all of them. Binding the connection once here means the ~60 existing
    ``log_activity`` calls record it without a single signature change.

    ``Accept-CH`` is what makes "Windows 11" and "Chrome 139" possible rather
    than "Windows" and "Chrome". Chromium froze ``Windows NT`` at 10.0, so the
    User-Agent genuinely cannot distinguish Windows 10 from 11; the versions
    live in the high-entropy client hints, which a browser only sends once the
    server has asked for them. This is the ask. It is request-scoped
    (``Critical-CH`` is deliberately not sent — forcing a retry of every request
    to gain a version string on the *first* one is not worth a round trip), so
    the first row a new browser writes says "Windows" and the rest say
    "Windows 11". Firefox and Safari implement none of this and are read from
    the User-Agent, which for them still carries what we need.
    """
    activity_service.bind_request(activity_service.request_context(request))
    try:
        response = await call_next(request)
    finally:
        activity_service.bind_request(None)
    response.headers.setdefault("Accept-CH", activity_service.ACCEPT_CH)
    return response


# A wildcard origin cannot be combined with credentials: the browser refuses
# it, so the practical effect is that every authenticated cross-origin call
# fails in a way that looks like a server bug. Caught at startup rather than
# discovered from a support ticket.
if "*" in settings.cors_origins_list:
    raise RuntimeError(
        "CORS_ORIGINS contains '*', which cannot be used with allow_credentials=True. "
        "List the exact origins each portal is served from."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PORTED_MODULES = [
    "auth", "super_admin", "merchants", "merchant_team",
    "catalog", "ticket_enquiries", "ticket_requests", "approvals", "payments", "service_requests",
    "profile", "merchant_dashboard", "reports_export", "notifications",
    "admin_dashboard", "approval_queue", "payment_management", "active_users",
    "communication", "notification_broadcast", "support_management", "live_chat",
    "super_admin_dashboard", "role_permission_management", "system_info",
    "audit_logs", "reports_summary",
    # M6 — analytics: booking mix, ops queue health, change-request money.
    "analytics",
    "documents",  # ported in Phase 3 — booking-request attachments (migration 0031)
    # Phase 4 — the post-approval operations desk (migration 0032). Distinct
    # from "approval_queue" above, which ends where this begins.
    "booking_operations",
    # M3 — cancellation & reschedule. No migration: the request types and the
    # parent_request_id link have existed since the nine-table redesign.
    "change_requests",
    # The merchant's own sign-off in front of ours. No migration: the state is
    # a JSONB sub-field on service_requests.travel_details.
    "manager_approval",
]
PENDING_MODULES = [
    "catalog_management",  # deliberately deferred — see docs/SCHEMA_V2.md; not in the approved spec
]

app.include_router(auth.router)
app.include_router(super_admin.router)
app.include_router(merchants.router)
app.include_router(merchant_team.router)
app.include_router(tickets.router)
app.include_router(enquiries.router)
# Group booking passenger manifests. Alongside enquiries because it is the same
# workflow's upload step — it grants no new permission code, reusing
# ticket.request/ticket.view exactly as the booking routes do.
app.include_router(group_bookings.router)
app.include_router(profile.router)
app.include_router(dashboard.router)
app.include_router(reports.router)
app.include_router(notifications_v2.router)
app.include_router(admin_ops.router)
app.include_router(support_tickets.router)
# Note there is no app.mount() for the upload directory anywhere in this file,
# and there must not be: booking documents are passport and visa scans, served
# only through documents.py's authenticated, merchant-scoped download route.
app.include_router(documents.router)
app.include_router(booking_ops.router)
app.include_router(change_requests.router)
# The merchant's manager signing off the service requests its own staff raised,
# before any of them reach our desk. Distinct from manager.router below: that is
# the platform Manager approving bookings, this is the merchant approving its own
# change requests, and neither holds the other's permission codes.
app.include_router(manager_approvals.router)
# M4 — the finance surface. Distinct from the payment endpoints in tickets.py
# and admin_ops.py, which move money; this one only reports on it, plus the one
# wallet write that has nowhere else to live.
app.include_router(finance.router)
# CR-2 — the Manager's approval desk, between the merchant's submission and the
# Booking Operations queue. Its own router because its permission codes are its
# own: an Admin holds none of them.
app.include_router(manager.router)
# CR-3 — the merchant's own approval desk, which replaces the platform Manager
# as the approver. Same service underneath, scoped to the caller's merchant;
# its own permission codes so a merchant can never address the platform queue.
app.include_router(merchant_approvals.router)
# CR-4c — the merchant's own wallet: balance, ledger, and telling us money has
# been sent. Separate from finance.router because that one reports on bookings
# and this one is the running account; every route here is implicitly scoped to
# the caller's merchant, so no path carries a merchant_id to tamper with.
app.include_router(wallet.router)
# CR-4d — the staff side of the same wallet: where merchants are told to send
# money, the queue that decides whether it arrived, and the reconciliation that
# proves the ledger and the cached balances still agree. Kept out of
# wallet.router because that one's defining property is that no route in it
# carries a merchant id; almost every route here does.
app.include_router(payment_admin.router)
# M5 — message delivery seen by staff. Gated on notification.send, which only
# the Admin role holds: notification.view is every merchant's own bell.
app.include_router(messages.router)
# M6 — analytics. Separate from reports.py, which exports rows: this one only
# ever returns aggregates, computed in SQL. Two of its three routes are scoped
# to the caller and gated on report.view; the operations one is Admin-only,
# because queue age and operator load have no merchant-scoped meaning.
app.include_router(analytics.router)
# Provider Management (0039) — the external suppliers the desk buys tickets
# FROM. Admin-only and entirely read/write over its own two tables; it shares no
# service with the merchant, wallet or payment modules, which is what keeps
# recording a purchase source from being able to move money.
app.include_router(providers.router)


@app.on_event("startup")
def ensure_default_admin_exists():
    db = SessionLocal()
    try:
        user_service.ensure_default_admin(db)
        user_count = db.scalar(select(func.count()).select_from(User)) or 0
        logger.info(
            "Connected to database %s - %d existing user account(s) found.",
            engine.url.render_as_string(hide_password=True), user_count,
        )
        if user_count == 0:
            logger.warning(
                "Zero users found at startup. If this database previously had accounts, "
                "double-check DATABASE_URL in .env — you may be pointed at the wrong database "
                "instead of a genuinely fresh one."
            )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Automatic booking completion
# ---------------------------------------------------------------------------
# A ticketed booking becomes Completed once its journey has actually finished.
# Nobody presses anything; this timer is what makes that true.
#
# WHY A BARE ASYNCIO TASK AND NOT A SCHEDULER LIBRARY
# There is exactly one periodic job on this platform and it does one UPDATE. A
# scheduler dependency would add a process to deploy, a store to configure and a
# failure mode to learn, to run a loop that fits on a screen. If a second and
# third job ever appear, that is the moment to reach for APScheduler or Celery —
# not before.
#
# The sweep is synchronous SQLAlchemy, so it runs in a worker thread: doing it
# inline would block the event loop, and this API serves requests on it.
_completion_task: "asyncio.Task | None" = None


async def _completion_loop() -> None:
    interval = max(60, settings.booking_completion_interval_minutes * 60)
    while True:
        # SLEEP FIRST, DELIBERATELY. Every worker starts within a second of its
        # siblings, and the advisory lock would then have all of them contend on
        # the same tick forever. It also keeps the sweep off the critical path
        # of a deploy, when the database is busiest.
        await asyncio.sleep(interval)
        try:
            await asyncio.to_thread(_run_completion_sweep)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A failed tick must never kill the loop — the next one is a
            # quarter of an hour away and the work is idempotent.
            logger.exception("Booking completion sweep failed; will retry next tick.")


def _run_completion_sweep() -> None:
    db = SessionLocal()
    try:
        booking_completion_service.sweep_once_locked(db)
    finally:
        db.close()


@app.on_event("startup")
async def start_booking_completion() -> None:
    global _completion_task
    if not settings.booking_completion_enabled:
        logger.info("Automatic booking completion is disabled by configuration.")
        return
    _completion_task = asyncio.create_task(_completion_loop())
    logger.info(
        "Automatic booking completion is on: sweeping every %d minute(s).",
        settings.booking_completion_interval_minutes,
    )


@app.on_event("shutdown")
async def stop_booking_completion() -> None:
    if _completion_task is None:
        return
    _completion_task.cancel()
    try:
        await _completion_task
    except asyncio.CancelledError:
        pass


@app.get("/api/health", tags=["health"])
def health_check():
    return {"status": "ok"}


@app.get("/api/status", tags=["health"])
def port_status():
    """Which API modules have been ported to the nine-table schema."""
    return {
        "schema": "v2-nine-table",
        "ported": PORTED_MODULES,
        "pending": PENDING_MODULES,
        "progress": f"{len(PORTED_MODULES)}/{len(PORTED_MODULES) + len(PENDING_MODULES)}",
    }


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
# In the EC2 layout nginx serves frontend/ and proxies /api/ here. Hosts that
# run a single container have no nginx, so the app serves the frontend itself
# and both halves share one origin — which is what the frontend already assumes
# off localhost (partner-shared.js falls back to an empty API_BASE).
#
# This mount is for frontend/ only. The warning above about uploads still
# stands: passport and visa scans are never mounted, at any path.
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


class CleanUrlStaticFiles(StaticFiles):
    """StaticFiles plus nginx's `try_files $uri $uri.html $uri/` behaviour.

    `html=True` already covers the directory case (`/admin/` -> index.html);
    this adds the extensionless one (`/login` -> login.html) so the URLs keep
    working exactly as they do behind deploy/nginx.conf.
    """

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or path.endswith(".html"):
                raise
            try:
                return await super().get_response(f"{path}.html", scope)
            except StarletteHTTPException:
                raise exc from None


if FRONTEND_DIR.is_dir():
    # Mounted last so every API route above wins the match first.
    app.mount("/", CleanUrlStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
    logger.info("Serving static frontend from %s", FRONTEND_DIR)
else:
    logger.warning("No frontend directory at %s - serving the API only.", FRONTEND_DIR)
