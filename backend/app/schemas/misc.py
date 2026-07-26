import datetime

from pydantic import BaseModel, EmailStr, Field


class ContactCreate(BaseModel):
    name: str = Field(max_length=150)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)
    subject: str | None = Field(default=None, max_length=200)
    message: str = Field(max_length=2000)


class ContactOut(BaseModel):
    message: str = "Thanks for reaching out — our team will get back to you shortly."


class NewsletterCreate(BaseModel):
    email: EmailStr


class NewsletterOut(BaseModel):
    message: str = "You're subscribed! Watch your inbox for deals."


class ContactMessageOut(BaseModel):
    id: int
    name: str
    email: EmailStr
    phone: str | None
    subject: str | None
    message: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class NewsletterSubscriberOut(BaseModel):
    id: int
    email: EmailStr
    subscribed_at: datetime.datetime

    model_config = {"from_attributes": True}


class RecentUserOut(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class RecentBookingOut(BaseModel):
    id: int
    user_email: str
    booking_type: str
    total_price: float
    status: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class RecentPaymentOut(BaseModel):
    id: int
    user_email: str
    amount: float
    status: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class MonthlyStatOut(BaseModel):
    month: str
    revenue: float
    bookings: int


class TopItemOut(BaseModel):
    item_type: str
    item_id: int
    name: str
    bookings: int
    revenue: float


class TopDestinationOut(BaseModel):
    """Real geographic destinations (grouped by hotel location) — no single catalog item backs
    a destination, so unlike TopItemOut this has no item_type/item_id."""

    name: str
    bookings: int
    revenue: float


class MostActiveUserOut(BaseModel):
    user_id: int
    full_name: str
    email: EmailStr
    activity_count: int
    last_active: datetime.datetime


class ReportsOut(BaseModel):
    total_users: int
    active_users: int
    total_bookings: int
    total_revenue: float
    bookings_by_type: dict[str, int]
    newsletter_subscribers: int
    contact_messages: int
    total_flights: int
    total_hotels: int
    total_cruises: int
    total_packages: int
    pending_bookings: int
    confirmed_bookings: int
    completed_bookings: int = 0
    cancelled_bookings: int
    payments_by_status: dict[str, int] = {}
    recent_users: list[RecentUserOut]
    recent_bookings: list[RecentBookingOut]
    recent_payments: list[RecentPaymentOut]
    today_users: int = 0
    today_logins: int = 0
    today_bookings: int = 0
    today_revenue: float = 0
    today_payments: int = 0
    users_online: int = 0
    active_sessions: int = 0
    top_destinations: list[TopDestinationOut] = []
    top_flights: list[TopItemOut] = []
    top_hotels: list[TopItemOut] = []
    top_cruises: list[TopItemOut] = []
    top_packages: list[TopItemOut] = []
    most_active_users: list[MostActiveUserOut] = []
    total_merchants: int = 0
    merchants_by_type: dict[str, int] = {}
    total_merchant_users: int = 0
    pending_partner_requests: int = 0
    active_cancellation_requests: int = 0
