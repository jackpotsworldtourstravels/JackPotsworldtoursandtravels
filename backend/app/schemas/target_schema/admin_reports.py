import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field


class MessageResponse(BaseModel):
    message: str


class AdminBookingOut(BaseModel):
    id: int
    user_id: int | None
    user_email: str
    booking_type: str = Field(validation_alias="item_type")
    item_id: int | None
    status: str
    total_price: float = Field(validation_alias="total_amount")
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class BookingStatusUpdate(BaseModel):
    status: Literal["pending", "confirmed", "completed", "cancelled"]


class AdminPaymentOut(BaseModel):
    id: int
    user_id: int | None
    user_email: str
    amount: float
    method: str | None
    status: str | None
    transaction_ref: str | None
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class ContactMessageOut(BaseModel):
    id: int
    email: str | None = Field(validation_alias="recipient_email")
    subject: str | None
    message: str | None
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class NewsletterSubscriberOut(BaseModel):
    id: int
    email: str | None = Field(validation_alias="recipient_email")
    subscribed_at: datetime.datetime = Field(validation_alias="created_at")

    model_config = {"from_attributes": True, "populate_by_name": True}


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


class RecentPaymentOut(BaseModel):
    id: int
    user_email: str
    amount: float
    status: str | None
    created_at: datetime.datetime


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


class ActivityLogOut(BaseModel):
    id: int
    user_id: int | None
    user_name: str | None = None
    user_email: str | None
    action: str = Field(validation_alias="activity_type")
    activity_type: str | None = None
    module: str | None = None
    description: str | None = Field(default=None, validation_alias="event")
    reference_id: int | None = Field(default=None, validation_alias="entity_id")
    ip_address: str | None
    browser: str | None = None
    device: str | None = None
    status: str = "success"
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class AdminNotificationCreate(BaseModel):
    user_id: int | None = Field(default=None, description="Target user id. Omit or null to broadcast to all customers.")
    title: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=2000)


class AdminNotificationOut(BaseModel):
    id: int
    user_email: str
    title: str | None = Field(validation_alias="subject")
    message: str | None
    is_read: bool
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class AdminSupportTicketOut(BaseModel):
    id: int
    user_id: int | None
    user_email: str
    subject: str | None
    description: str | None
    status: str
    priority: str | None
    created_at: datetime.datetime
    resolved_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


class SupportTicketStatusUpdate(BaseModel):
    status: Literal["pending", "approved", "rejected", "resolved", "completed"]
