import datetime

from pydantic import BaseModel, EmailStr, Field

from app.schemas.inventory import InventoryItemOut


class BookingListItemOut(BaseModel):
    id: int
    customer_id: int
    customer_name: str
    customer_email: EmailStr
    booking_type: str
    destination: str
    booking_date: datetime.datetime
    travel_date: datetime.date | None
    passengers: int
    total_amount: float
    payment_status: str | None
    booking_status: str
    created_by: str
    updated_at: datetime.datetime


class BookingCustomerOut(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    mobile: str | None


class BookingPaymentDetailOut(BaseModel):
    id: int
    transaction_ref: str
    amount: float
    method: str
    status: str
    created_at: datetime.datetime
    refunded_at: datetime.datetime | None
    refund_reference: str | None


class BookingTimelineEntryOut(BaseModel):
    activity_type: str | None
    description: str | None
    status: str
    created_at: datetime.datetime
    actor: str


class BookingDetailOut(BaseModel):
    id: int
    booking_type: str
    destination: str
    status: str
    quantity: int
    total_price: float
    travel_date: datetime.date | None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    customer: BookingCustomerOut
    payments: list[BookingPaymentDetailOut]
    timeline: list[BookingTimelineEntryOut]
    inventory: InventoryItemOut | None


class RescheduleRequest(BaseModel):
    travel_date: datetime.date


class PassengerCountUpdateRequest(BaseModel):
    quantity: int = Field(ge=1, le=10)


class BookingAnalyticsOut(BaseModel):
    total_bookings: int
    today_bookings: int
    confirmed: int
    cancelled: int
    completed: int
    pending: int
    revenue: float
    average_booking_value: float


class BookingDashboardCardOut(BaseModel):
    today_bookings: int
    pending_approvals: int
    upcoming_trips: int
    cancelled_today: int
