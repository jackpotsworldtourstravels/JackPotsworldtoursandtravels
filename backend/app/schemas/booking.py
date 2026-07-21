import datetime
from typing import Literal

from pydantic import BaseModel, Field

BookingType = Literal["flight", "hotel", "cruise", "package"]


class BookingCreate(BaseModel):
    booking_type: BookingType
    item_id: int
    total_price: float = Field(gt=0, description="Client-estimated total; the server recalculates this from the catalog and ignores this value.")
    quantity: int = Field(default=1, ge=1, le=10, description="Number of seats/rooms/travellers to book (max 10 per booking).")
    travel_date: datetime.date | None = None
    coupon_code: str | None = Field(default=None, max_length=40)


class BookingOut(BaseModel):
    id: int
    user_id: int
    booking_type: str
    item_id: int
    status: str
    total_price: float
    quantity: int
    travel_date: datetime.date | None
    coupon_code: str | None = None
    discount_amount: float | None = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class PaymentOut(BaseModel):
    id: int
    booking_id: int
    user_id: int
    amount: float
    method: str
    status: str
    transaction_ref: str
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class BookingConfirmation(BaseModel):
    booking: BookingOut
    payment: PaymentOut


class BookingStatusUpdate(BaseModel):
    status: Literal["pending", "confirmed", "completed", "cancelled"]


class AdminBookingOut(BookingOut):
    user_email: str


class AdminPaymentOut(PaymentOut):
    user_email: str
