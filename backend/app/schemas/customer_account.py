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
#: The three products a payment can belong to. Stored on every entry so the
#: Account Center can label a row without inferring it from the reference.
PAYMENT_SERVICE_TYPES = ("flight", "hotel", "package")


class PaymentHistoryEntry(BaseModel):
    """One payment attempt, with the booking and service it belongs to named.

    Unifies the three product payment tables into one shape — see
    ``customer_account_service.list_payments_for_customer``. Optional fields are
    ``None`` when the source row does not carry them (e.g. a pending attempt has
    no transaction reference yet); the API never omits a key or breaks on it.
    """

    service_type: str
    booking_ref: str
    created_at: dt.datetime
    amount: Decimal
    currency: str = "INR"
    method: str
    status: str
    transaction_ref: str | None = None
    #: "refunded" when this payment's own status is refunded, else None. The
    #: fuller refund ledger (amounts, partial refunds) is out of this read's
    #: scope and is never fabricated here.
    refund_status: str | None = None


class PaymentHistoryPage(BaseModel):
    """A page of payment history, with the total so a pager needs no 2nd call."""

    items: list[PaymentHistoryEntry]
    total: int
    page: int
    page_size: int


# ---------------------------------------------------------------------------
# Wishlist
# ---------------------------------------------------------------------------
#: The free-text note cap, shared by the API field and the model column. An
#: over-long note is refused with 422 at the edge, never silently truncated.
WISHLIST_NOTE_MAX_LEN = 500


class WishlistCreate(BaseModel):
    item_type: str = Field(pattern="^(flight|hotel|cruise|package)$")
    item_id: int
    #: Optional note to attach when first saving the item. On a re-save of an
    #: item already on the wishlist this is ignored (the save stays idempotent);
    #: use PATCH /wishlist/{id} to change the note of an existing item.
    note: str | None = Field(default=None, max_length=WISHLIST_NOTE_MAX_LEN)


class WishlistNoteUpdate(BaseModel):
    """Set or clear the note on a saved item. ``null`` or blank clears it."""

    note: str | None = Field(default=None, max_length=WISHLIST_NOTE_MAX_LEN)


class WishlistResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(validation_alias="customer_wishlist_id")
    item_type: str
    item_id: int
    #: None when the customer has attached no note. Blank input never reaches
    #: here as "" — the service stores it as NULL.
    note: str | None = None
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
    #: Moderation state and the desk's reply (0090). Additive: a client that
    #: never read them is unaffected.
    status: str | None = None
    admin_reply: str | None = None


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


class NotificationPreferencesResponse(BaseModel):
    """A customer's email/SMS opt-ins (Issue #21). Booking defaults on,
    promotional defaults off. In-app notifications are always on and not here."""

    booking_email: bool
    booking_sms: bool
    promo_email: bool
    promo_sms: bool


class NotificationPreferencesUpdate(BaseModel):
    """Partial update: send only the switches you want to change."""

    model_config = ConfigDict(extra="forbid")

    booking_email: bool | None = None
    booking_sms: bool | None = None
    promo_email: bool | None = None
    promo_sms: bool | None = None
