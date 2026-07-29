import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import func, select

from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import SessionLocal, engine
from app.models_v2 import User
from app.routers import (
    admin_ops,
    auth,
    dashboard,
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
    "catalog", "ticket_requests", "approvals", "payments", "service_requests",
    "profile", "merchant_dashboard", "reports_export", "notifications",
    "admin_dashboard", "approval_queue", "payment_management", "active_users",
    "communication", "notification_broadcast", "support_management", "live_chat",
    "super_admin_dashboard", "role_permission_management", "system_info",
    "audit_logs", "reports_summary",
]
PENDING_MODULES = [
    "documents",
    "catalog_management",  # deliberately deferred — see docs/SCHEMA_V2.md; not in the approved spec
]

app.include_router(auth.router)
app.include_router(super_admin.router)
app.include_router(merchants.router)
app.include_router(merchant_team.router)
app.include_router(tickets.router)
app.include_router(profile.router)
app.include_router(dashboard.router)
app.include_router(reports.router)
app.include_router(notifications_v2.router)
app.include_router(admin_ops.router)
app.include_router(support_tickets.router)


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
