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
    auth,
    booking_ops,
    change_requests,
    dashboard,
    documents,
    enquiries,
    manager_approvals,
    merchant_team,
    merchants,
    notifications_v2,
    profile,
    reports,
    super_admin,
    support_tickets,
    tickets,
)
from app.services import user_service

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
app.include_router(manager_approvals.router)


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
