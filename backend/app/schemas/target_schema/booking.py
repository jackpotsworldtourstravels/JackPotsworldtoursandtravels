import datetime
from typing import Literal

from pydantic import BaseModel, Field

# Frontend still sends 'package' (see frontend/*.js) — translated to the new
# schema's 'tour_package' item_type at the router boundary so the API
# contract doesn't need a frontend change at cutover.
BookingType = Literal["flight", "hotel", "cruise", "package"]


class BookingCreate(BaseModel):
    booking_type: BookingType
    item_id: int
    total_price: float = Field(gt=0, description="Client-estimated total; the server recalculates this and ignores this value.")
    quantity: int = Field(default=1, ge=1, le=10)
    travel_date: datetime.date | None = None
    coupon_code: str | None = Field(default=None, max_length=40)


class BookingOut(BaseModel):
    id: int
    user_id: int | None
    booking_type: str = Field(validation_alias="item_type")
    item_id: int | None
    status: str
    total_price: float = Field(validation_alias="total_amount")
    quantity: int | None
    travel_date: datetime.date | None = Field(default=None, validation_alias="departure_date")
    coupon_code: str | None = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class PaymentOut(BaseModel):
    id: int
    booking_id: int | None = Field(validation_alias="service_request_id")
    user_id: int | None
    amount: float
    method: str | None
    status: str | None
    transaction_ref: str | None
    created_at: datetime.datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class BookingConfirmation(BaseModel):
    booking: BookingOut
    payment: PaymentOut
