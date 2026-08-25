"""Request/response schemas for the Account Center tabs added in 0054:
wishlist, notifications, reviews, support tickets — plus the payment-history
read model, which has no new table behind it (it reads `customer_booking_payments`,
written by 0053's booking flow).
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

ITEM_TYPES = ("flight", "hotel", "cruise", "package")


# ---------------------------------------------------------------------------
# Payment history
# ---------------------------------------------------------------------------
class PaymentHistoryEntry(BaseModel):
    """One payment attempt, with the booking it belongs to named."""

    booking_ref: str
    created_at: dt.datetime
    amount: Decimal
    method: str
    status: str
    transaction_ref: str | None = None


# ---------------------------------------------------------------------------
# Wishlist
# ---------------------------------------------------------------------------
class WishlistCreate(BaseModel):
    item_type: str = Field(pattern="^(flight|hotel|cruise|package)$")
    item_id: int


class WishlistResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(validation_alias="customer_wishlist_id")
    item_type: str
    item_id: int
    created_at: dt.datetime


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------
class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(validation_alias="customer_notification_id")
    notification_type: str
    title: str
    message: str
    related_ref: str | None = None
    is_read: bool
    created_at: dt.datetime


# ---------------------------------------------------------------------------
# Reviews
# ---------------------------------------------------------------------------
class ReviewCreate(BaseModel):
    item_type: str = Field(pattern="^(flight|hotel|cruise|package)$")
    item_id: int
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)


class ReviewUpdate(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)


class ReviewResponse(BaseModel):
    #: `populate_by_name` because this one, unlike the others in this file, is
    #: also built directly with `id=...` (not just validated off an ORM row)
    #: in the router's post/put handlers — without it, `validation_alias`
    #: only accepts the alias as a keyword, and direct construction with `id=`
    #: raised "Field required" for `customer_review_id`.
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int = Field(validation_alias="customer_review_id")
    #: Present only on `GET /reviews?item_type=&item_id=` (public, any
    #: customer's review) so the reviewer's name can be shown; absent on
    #: `GET /reviews/mine` (there is nothing to attribute it to yourself).
    user_id: int | None = None
    user_name: str | None = None
    item_type: str
    item_id: int
    rating: int
    comment: str | None
    created_at: dt.datetime


# ---------------------------------------------------------------------------
# Support tickets
# ---------------------------------------------------------------------------
class SupportTicketCreate(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=4000)
    priority: str = Field(default="normal", pattern="^(low|normal|high|urgent)$")


class SupportMessageCreate(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class SupportMessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(validation_alias="customer_support_message_id")
    author_name: str | None
    is_staff: bool
    message: str
    created_at: dt.datetime


class SupportTicketResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(validation_alias="customer_support_ticket_id")
    subject: str
    description: str
    priority: str
    status: str
    created_at: dt.datetime
    updated_at: dt.datetime
    messages: list[SupportMessageResponse] = []
