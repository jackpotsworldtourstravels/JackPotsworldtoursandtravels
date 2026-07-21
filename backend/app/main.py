from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database.session import SessionLocal
from app.routers import (
    admin,
    auth,
    booking_management,
    bookings,
    content,
    customers,
    misc,
    notifications,
    payment_management,
    reviews,
    support_tickets,
    users,
    wishlist,
)
from app.services import user_service

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


@app.on_event("startup")
def ensure_default_admin_exists():
    db = SessionLocal()
    try:
        user_service.ensure_default_admin(db)
    finally:
        db.close()


@app.get("/api/health", tags=["health"])
def health_check():
    return {"status": "ok"}
