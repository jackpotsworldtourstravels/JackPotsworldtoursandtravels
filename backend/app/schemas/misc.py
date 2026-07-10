import datetime

from pydantic import BaseModel, EmailStr


class ContactCreate(BaseModel):
    name: str
    email: EmailStr
    phone: str | None = None
    subject: str | None = None
    message: str


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


class ReportsOut(BaseModel):
    total_users: int
    total_bookings: int
    total_revenue: float
    bookings_by_type: dict[str, int]
    newsletter_subscribers: int
    contact_messages: int
