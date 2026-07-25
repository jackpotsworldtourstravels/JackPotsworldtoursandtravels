import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import func, select

from app.auth.rate_limit import limiter
from app.config import settings
from app.database.session import SessionLocal, engine
from app.models.user import User
from app.routers import (
    admin,
    admin_partner_requests,
    auth,
    booking_management,
    bookings,
    content,
    customers,
    misc,
    notifications,
    partner_auth,
    partner_bookings,
    partner_dashboard,
    partner_profile,
    partner_reference,
    partner_reports,
    partner_service_requests,
    partner_ticket_enquiry,
    payment_management,
    pricing,
    reviews,
    support_tickets,
    users,
    wishlist,
)
from app.services import user_service

logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
logger = logging.getLogger("jackpots.startup")

app = FastAPI(
    title="JackPots World Tours & Travels API",
    description=(
        "REST API for the JackPots World Tours & Travels booking platform, covering flights, hotels, "
        "cruises, and tour packages. Authentication uses JWT access/refresh tokens with separate user "
        "and admin roles. Includes a booking and mock-payment flow, plus wishlist, reviews, "
        "notifications, and activity-log features for end users, and reporting/CSV export tools for admins."
    ),
    version="1.0.0",
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

app.include_router(auth.router)
app.include_router(content.flights_router)
app.include_router(content.hotels_router)
app.include_router(content.cruises_router)
app.include_router(content.packages_router)
app.include_router(bookings.router)
app.include_router(bookings.payments_router)
app.include_router(misc.contact_router)
app.include_router(misc.newsletter_router)
app.include_router(users.router)
app.include_router(users.admin_router)
app.include_router(wishlist.router)
app.include_router(reviews.router)
app.include_router(notifications.router)
app.include_router(support_tickets.router)
app.include_router(admin.router)
app.include_router(customers.router)
app.include_router(booking_management.router)
app.include_router(payment_management.router)
app.include_router(pricing.router)
app.include_router(pricing.admin_router)
app.include_router(partner_auth.router)
app.include_router(partner_reference.router)
app.include_router(partner_dashboard.router)
app.include_router(partner_ticket_enquiry.router)
app.include_router(partner_bookings.router)
app.include_router(partner_service_requests.router)
app.include_router(partner_reports.router)
app.include_router(partner_profile.router)
app.include_router(admin_partner_requests.router)


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
