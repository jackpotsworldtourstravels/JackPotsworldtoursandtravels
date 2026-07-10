from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import admin, auth, bookings, content, misc, users

app = FastAPI(title="JackPots World Tours & Travels API", version="1.0.0")

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
app.include_router(admin.router)


@app.get("/api/health", tags=["health"])
def health_check():
    return {"status": "ok"}
