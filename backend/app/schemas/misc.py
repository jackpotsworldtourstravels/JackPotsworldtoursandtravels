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
    cancelled_bookings: int
    recent_users: list[RecentUserOut]
    recent_bookings: list[RecentBookingOut]
    recent_payments: list[RecentPaymentOut]
