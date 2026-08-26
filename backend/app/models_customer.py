"""SQLAlchemy models for the Customer Portal (V1) — migration 0044.

Standalone module, like ``models_v2.py`` is standalone from ``app/models/``.

THE SEPARATE ``Base`` IS THE POINT, NOT AN OVERSIGHT
This module declares its own :class:`Base`, so these classes live in their own
mapper registry rather than ``models_v2.Base``'s. That is what makes the
isolation structural instead of a rule people have to remember:

    class Customer(Base):
        merchant = relationship("Merchant")     # <- raises at configure time

A string target in ``relationship()`` is resolved against the registry of the
Base it is declared on. ``Merchant`` is not in this one, so the mapper fails
loudly the first time anything touches it — at import, in every test, not in
production six months later. Two registries mean a relationship across the
B2C/B2B boundary cannot be written by accident; writing one on purpose takes
an explicit ``primaryjoin`` and a foreign key that migration 0044 does not
create.

The trade-off is that nothing here can lazy-load a merchant-side object. That
is the requirement, stated as a type error.

WHY THERE ARE NO PERMISSIONS OR ROLES ON A CUSTOMER
``users`` carries ``role`` and a ``permissions`` array because the merchant
side has staff who may do different things. A customer is one person acting for
themselves: there is nothing to grant and nobody to grant it to. ``app/auth/rbac.py``
is not imported here and must not be — a permission code that a customer could
hold would be a code an Admin screen might one day check for.
"""
from __future__ import annotations

import datetime as dt
import enum
from typing import Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Declarative base for the Customer Portal. Deliberately not shared."""


# ---------------------------------------------------------------------
# Enums. Names match the PostgreSQL types created by 0044, and
# ``create_type=False`` keeps SQLAlchemy from trying to re-create them.
# ---------------------------------------------------------------------
class CustomerStatus(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    BLOCKED = "blocked"
    SUSPENDED = "suspended"


class CustomerOtpPurpose(str, enum.Enum):
    SIGNUP = "signup"
    LOGIN = "login"
    PASSWORD_RESET = "password_reset"
    EMAIL_VERIFY = "email_verify"
    MOBILE_VERIFY = "mobile_verify"


class CustomerAuditStatus(str, enum.Enum):
    SUCCESS = "success"
    FAILED = "failed"


_STATUS = SAEnum(
    CustomerStatus, name="customer_status_enum",
    values_callable=lambda e: [m.value for m in e], create_type=False,
)
_PURPOSE = SAEnum(
    CustomerOtpPurpose, name="customer_otp_purpose_enum",
    values_callable=lambda e: [m.value for m in e], create_type=False,
)
_AUDIT_STATUS = SAEnum(
    CustomerAuditStatus, name="customer_audit_status_enum",
    values_callable=lambda e: [m.value for m in e], create_type=False,
)


class Customer(Base):
    """Who someone is. No credentials, no address — those are their own rows."""

    __tablename__ = "customers"

    customer_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_code: Mapped[str] = mapped_column(String(20), nullable=False)
    full_name: Mapped[str] = mapped_column(String(150), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    mobile: Mapped[str] = mapped_column(String(30), nullable=False)
    date_of_birth: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    status: Mapped[CustomerStatus] = mapped_column(
        _STATUS, nullable=False, default=CustomerStatus.ACTIVE,
    )
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    mobile_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    # All one-to-one except the log tables. `lazy="joined"` on auth would load a
    # password hash into every customer read; it is left lazy on purpose.
    auth: Mapped[Optional["CustomerAuth"]] = relationship(
        back_populates="customer", uselist=False, cascade="all, delete-orphan",
    )
    profile: Mapped[Optional["CustomerProfile"]] = relationship(
        back_populates="customer", uselist=False, cascade="all, delete-orphan",
    )

    @property
    def is_active(self) -> bool:
        return self.status is CustomerStatus.ACTIVE


class CustomerAuth(Base):
    """How they prove it. One row per customer (unique index in 0044)."""

    __tablename__ = "customer_auth"

    customer_auth_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    password_changed_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    failed_login_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_login: Mapped[Optional[dt.datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    login_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: Moved forward on logout; every token issued before it stops working.
    force_logout_at: Mapped[Optional[dt.datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    customer: Mapped["Customer"] = relationship(back_populates="auth")


class CustomerProfile(Base):
    """What they told us about themselves."""

    __tablename__ = "customer_profiles"

    customer_profile_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    gender: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    address_line1: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    address_line2: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    city: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    state: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    country: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    postal_code: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    profile_photo: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    customer: Mapped["Customer"] = relationship(back_populates="profile")


class CustomerSession(Base):
    """A sign-in. Never written to ``system_logs`` — see 0044's note."""

    __tablename__ = "customer_sessions"

    customer_session_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    ip_address: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    browser: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    device: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(400), nullable=True)
    login_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    last_seen_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    logout_at: Mapped[Optional[dt.datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class CustomerOtp(Base):
    """One issued code. Consumed by setting ``consumed_at``, never deleted."""

    __tablename__ = "customer_otps"

    customer_otp_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    purpose: Mapped[CustomerOtpPurpose] = mapped_column(_PURPOSE, nullable=False)
    delivery_channel: Mapped[str] = mapped_column(String(20), nullable=False)
    recipient: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    consumed_at: Mapped[Optional[dt.datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )


class CustomerPasswordReset(Base):
    """A reset in flight. The raw token is emailed and never stored."""

    __tablename__ = "customer_password_resets"

    customer_password_reset_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[Optional[dt.datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    requested_ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )


class CustomerAuditLog(Base):
    """The customer's own trail. Separate from ``audit_logs`` by design."""

    __tablename__ = "customer_audit_logs"

    customer_audit_log_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="SET NULL"), nullable=True,
    )
    #: Copied in at write time so the trail still names the account after the
    #: FK above goes NULL. Deliberately not derived on read.
    customer_code: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    module: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ip_address: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    browser: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    device: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    status: Mapped[CustomerAuditStatus] = mapped_column(
        _AUDIT_STATUS, nullable=False, default=CustomerAuditStatus.SUCCESS,
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )


# =====================================================================
# Flight booking (0053). The portal's booking flow finally has tables to
# land in; everything below is rooted at `customers` and shares this Base.
# =====================================================================

_ITEM_TYPE = SAEnum(
    "flight", "hotel", "cruise", "package",
    name="customer_item_type_enum", create_type=False,
)
_NOTIF_TYPE = SAEnum(
    "booking_created", "booking_cancelled", "booking_payment", "general",
    name="customer_notification_type_enum", create_type=False,
)
_TICKET_STATUS = SAEnum(
    "open", "in_progress", "resolved", "closed",
    name="customer_ticket_status_enum", create_type=False,
)
_TICKET_PRIORITY = SAEnum(
    "low", "normal", "high", "urgent",
    name="customer_ticket_priority_enum", create_type=False,
)

_BOOKING_STATUS = SAEnum(
    "pending", "confirmed", "cancelled", "completed",
    name="customer_booking_status_enum", create_type=False,
)
_TRAVELLER_TYPE = SAEnum(
    "adult", "child", "infant",
    name="customer_traveller_type_enum", create_type=False,
)
_ADDON_TYPE = SAEnum(
    "baggage", "meal", "service",
    name="customer_addon_type_enum", create_type=False,
)
_PAYMENT_STATUS = SAEnum(
    "pending", "authorized", "captured", "failed", "refunded",
    name="customer_payment_status_enum", create_type=False,
)


class CustomerBookingStatus(str, enum.Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    CANCELLED = "cancelled"
    COMPLETED = "completed"


class CustomerTravellerType(str, enum.Enum):
    ADULT = "adult"
    CHILD = "child"
    INFANT = "infant"


class CustomerAddonType(str, enum.Enum):
    BAGGAGE = "baggage"
    MEAL = "meal"
    SERVICE = "service"


class CustomerPaymentStatus(str, enum.Enum):
    PENDING = "pending"
    AUTHORIZED = "authorized"
    CAPTURED = "captured"
    FAILED = "failed"
    REFUNDED = "refunded"


class CustomerTraveller(Base):
    """One saved person in a traveller list.

    Deliberately separate from ``CustomerBookingPassenger``: this row is a
    reusable address-book entry the traveller may edit or delete, while the
    passenger row is a frozen record of who actually flew. Editing a saved
    traveller must never rewrite a ticket already issued.
    """

    __tablename__ = "customer_travellers"

    customer_traveller_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    traveller_type: Mapped[str] = mapped_column(
        _TRAVELLER_TYPE, nullable=False, default=CustomerTravellerType.ADULT.value,
    )
    title: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    gender: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    date_of_birth: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    nationality: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    passport_number: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    passport_expiry: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    issuing_country: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    frequent_flyer_airline: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    frequent_flyer_number: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    mobile: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )


class CustomerBooking(Base):
    """One booking. The itinerary is a snapshot -- see migration 0053."""

    __tablename__ = "customer_bookings"

    customer_booking_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    booking_ref: Mapped[str] = mapped_column(String(20), nullable=False)
    #: NULL until an airline issues one. Never generated locally.
    pnr: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="RESTRICT"), nullable=False,
    )
    product_type: Mapped[str] = mapped_column(String(20), nullable=False, default="flight")
    status: Mapped[str] = mapped_column(
        _BOOKING_STATUS, nullable=False, default=CustomerBookingStatus.PENDING.value,
    )

    airline: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    flight_number: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    origin_code: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    origin_city: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    destination_code: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    destination_city: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    travel_date: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    departure_time: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    arrival_time: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    duration_label: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    stops: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cabin_class: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    is_international: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    base_fare: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    taxes: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    seat_charges: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    baggage_total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    meal_total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    service_total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    discount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    total_amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    coupon_code: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)

    cancelled_at: Mapped[Optional[dt.datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    passengers: Mapped[list["CustomerBookingPassenger"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
        order_by="CustomerBookingPassenger.passenger_index",
    )
    addons: Mapped[list["CustomerBookingAddon"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
    )
    payments: Mapped[list["CustomerBookingPayment"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
        order_by="CustomerBookingPayment.customer_booking_payment_id",
    )


class CustomerBookingPassenger(Base):
    """Who flew. Frozen at booking time; not a link to the saved list."""

    __tablename__ = "customer_booking_passengers"

    customer_booking_passenger_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_booking_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customer_bookings.customer_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    passenger_index: Mapped[int] = mapped_column(Integer, nullable=False)
    traveller_type: Mapped[str] = mapped_column(
        _TRAVELLER_TYPE, nullable=False, default=CustomerTravellerType.ADULT.value,
    )
    title: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    gender: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    date_of_birth: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    nationality: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    passport_number: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    passport_expiry: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    issuing_country: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    frequent_flyer_airline: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    frequent_flyer_number: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    seat_number: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    seat_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    is_contact: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    mobile: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    booking: Mapped["CustomerBooking"] = relationship(back_populates="passengers")


class CustomerBookingAddon(Base):
    """Baggage, a meal or a service actually bought on a booking."""

    __tablename__ = "customer_booking_addons"

    customer_booking_addon_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_booking_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customer_bookings.customer_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    #: NULL = the whole booking, not one traveller.
    passenger_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    addon_type: Mapped[str] = mapped_column(_ADDON_TYPE, nullable=False)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    booking: Mapped["CustomerBooking"] = relationship(back_populates="addons")


class CustomerBookingPayment(Base):
    """A payment attempt. See migration 0053 -- an attempt log, not a ledger."""

    __tablename__ = "customer_booking_payments"

    customer_booking_payment_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_booking_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customer_bookings.customer_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    method: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(
        _PAYMENT_STATUS, nullable=False, default=CustomerPaymentStatus.PENDING.value,
    )
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    provider: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    provider_reference: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    failure_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    booking: Mapped["CustomerBooking"] = relationship(back_populates="payments")


class CustomerCoupon(Base):
    """A discount the site actually offers. Seeded from the landing page."""

    __tablename__ = "customer_coupons"

    customer_coupon_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(400), nullable=True)
    discount_type: Mapped[str] = mapped_column(String(10), nullable=False)
    discount_value: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    max_discount: Mapped[Optional[float]] = mapped_column(Numeric(12, 2), nullable=True)
    min_amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    product_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    international_only: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    valid_from: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    valid_to: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )


# =====================================================================
# Account Center (0054) — wishlist, notifications, reviews, support.
# item_type/item_id name a catalogue entry (still sample data — see
# travel-data.js), not a booking, matching what the frontend has always sent.
# =====================================================================

class CustomerWishlistItem(Base):
    """A saved flight/hotel/cruise/package. One heart per item per customer."""

    __tablename__ = "customer_wishlist"
    __table_args__ = (
        UniqueConstraint("customer_id", "item_type", "item_id", name="uq_customer_wishlist_item"),
    )

    customer_wishlist_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    item_type: Mapped[str] = mapped_column(_ITEM_TYPE, nullable=False)
    item_id: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )


class CustomerNotification(Base):
    """A system-generated message — not a marketing inbox.

    Written by the code that causes it (booking created, cancelled, a payment
    attempt recorded), never composed ahead of time, so there is nothing here
    that was not actually true when it was written.
    """

    __tablename__ = "customer_notifications"

    customer_notification_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    notification_type: Mapped[str] = mapped_column(_NOTIF_TYPE, nullable=False, default="general")
    title: Mapped[str] = mapped_column(String(150), nullable=False)
    message: Mapped[str] = mapped_column(String(500), nullable=False)
    related_ref: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    read_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )


class CustomerReview(Base):
    """One review per customer per catalogue item — matches the existing
    (currently orphaned) reviews modal, which edits "my" review rather than
    ever allowing a second one to exist."""

    __tablename__ = "customer_reviews"
    __table_args__ = (
        UniqueConstraint("customer_id", "item_type", "item_id", name="uq_customer_review_item"),
        CheckConstraint("rating >= 1 AND rating <= 5", name="ck_customer_review_rating"),
    )

    customer_review_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    item_type: Mapped[str] = mapped_column(_ITEM_TYPE, nullable=False)
    item_id: Mapped[int] = mapped_column(Integer, nullable=False)
    rating: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    comment: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )


class CustomerSupportTicket(Base):
    """The customer's own ticket thread — deliberately not the merchant/admin
    chat system in support_tickets.py, which is rooted at models_v2.User and
    out of reach from this Base by design (see the module docstring)."""

    __tablename__ = "customer_support_tickets"

    customer_support_ticket_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="CASCADE"), nullable=False,
    )
    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[str] = mapped_column(_TICKET_PRIORITY, nullable=False, default="normal")
    status: Mapped[str] = mapped_column(_TICKET_STATUS, nullable=False, default="open")
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    messages: Mapped[list["CustomerSupportMessage"]] = relationship(
        back_populates="ticket", cascade="all, delete-orphan",
        order_by="CustomerSupportMessage.customer_support_message_id",
    )


class CustomerSupportMessage(Base):
    """One message on a ticket thread. NULL author = the customer."""

    __tablename__ = "customer_support_messages"

    customer_support_message_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    customer_support_ticket_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customer_support_tickets.customer_support_ticket_id", ondelete="CASCADE"),
        nullable=False,
    )
    author_name: Mapped[Optional[str]] = mapped_column(String(150), nullable=True)
    is_staff: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    ticket: Mapped["CustomerSupportTicket"] = relationship(back_populates="messages")


# =====================================================================
# Hotel system (0055). Its own tables, its own booking reference series —
# see the migration docstring for why a stay does not live on
# ``customer_bookings``. Only the status/payment/traveller-type/addon-type
# vocabularies (immediately above) are shared, because those are enums of
# words, not flight inventory.
# =====================================================================

class CustomerHotel(Base):
    """A property. What ``SAMPLE_HOTELS`` was, now served from a real table."""

    __tablename__ = "customer_hotels"

    customer_hotel_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    star_rating: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=3)
    guest_rating: Mapped[Optional[float]] = mapped_column(Numeric(2, 1), nullable=True)
    location: Mapped[str] = mapped_column(String(200), nullable=False)
    distance_km: Mapped[Optional[float]] = mapped_column(Numeric(5, 1), nullable=True)
    price_per_night: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    amenities: Mapped[list[str]] = mapped_column(ARRAY(String(60)), nullable=False, default=list)
    image_key: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    images: Mapped[list[str]] = mapped_column(ARRAY(String(60)), nullable=False, default=list)
    cancellation_policy: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    rooms: Mapped[list["CustomerHotelRoom"]] = relationship(
        back_populates="hotel", order_by="CustomerHotelRoom.base_price_per_night",
    )


class CustomerHotelRoom(Base):
    """One sellable room type at a property."""

    __tablename__ = "customer_hotel_rooms"

    customer_hotel_room_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    hotel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customer_hotels.customer_hotel_id", ondelete="CASCADE"), nullable=False,
    )
    code: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(400), nullable=True)
    bed_type: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    size_label: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    max_guests: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=2)
    base_price_per_night: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    meal_plan: Mapped[str] = mapped_column(String(60), nullable=False, default="Room only")
    cancellation_policy: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    perks: Mapped[list[str]] = mapped_column(ARRAY(String(60)), nullable=False, default=list)
    total_inventory: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=5)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    hotel: Mapped["CustomerHotel"] = relationship(back_populates="rooms")


class CustomerHotelBooking(Base):
    """One stay. The property/room are a snapshot -- see migration 0055."""

    __tablename__ = "customer_hotel_bookings"

    customer_hotel_booking_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    booking_ref: Mapped[str] = mapped_column(String(20), nullable=False)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="RESTRICT"), nullable=False,
    )
    status: Mapped[str] = mapped_column(
        _BOOKING_STATUS, nullable=False, default=CustomerBookingStatus.PENDING.value,
    )

    hotel_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customer_hotels.customer_hotel_id", ondelete="RESTRICT"), nullable=False,
    )
    hotel_name: Mapped[str] = mapped_column(String(150), nullable=False)
    hotel_location: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    room_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customer_hotel_rooms.customer_hotel_room_id", ondelete="RESTRICT"),
        nullable=False,
    )
    room_name: Mapped[str] = mapped_column(String(120), nullable=False)
    meal_plan: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    check_in_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    check_out_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    nights: Mapped[int] = mapped_column(Integer, nullable=False)
    rooms_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    adults: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    children: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    child_ages: Mapped[Optional[list[int]]] = mapped_column(ARRAY(SmallInteger), nullable=True)
    special_requests: Mapped[Optional[list[str]]] = mapped_column(ARRAY(String(60)), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    room_subtotal: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    taxes: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    addon_total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    discount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    total_amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    coupon_code: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)

    cancelled_at: Mapped[Optional[dt.datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    @property
    def product_type(self) -> str:
        """Always "hotel" — there is no column for it because there is no
        other kind of row in this table; `BookingResponse`-style schemas on
        the flight side read a real column of the same name, so this exists
        only so a hotel booking can be validated the same way."""
        return "hotel"

    guests: Mapped[list["CustomerHotelBookingGuest"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
        order_by="CustomerHotelBookingGuest.guest_index",
    )
    addons: Mapped[list["CustomerHotelBookingAddon"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
    )
    payments: Mapped[list["CustomerHotelBookingPayment"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
        order_by="CustomerHotelBookingPayment.customer_hotel_booking_payment_id",
    )


class CustomerHotelBookingGuest(Base):
    """Who is staying. Frozen at booking time."""

    __tablename__ = "customer_hotel_booking_guests"

    customer_hotel_booking_guest_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    hotel_booking_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customer_hotel_bookings.customer_hotel_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    guest_index: Mapped[int] = mapped_column(Integer, nullable=False)
    guest_type: Mapped[str] = mapped_column(
        _TRAVELLER_TYPE, nullable=False, default=CustomerTravellerType.ADULT.value,
    )
    title: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    gender: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    date_of_birth: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    nationality: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    is_contact: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    mobile: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    booking: Mapped["CustomerHotelBooking"] = relationship(back_populates="guests")


class CustomerHotelBookingAddon(Base):
    """Breakfast, a transfer, late checkout — actually bought on a stay."""

    __tablename__ = "customer_hotel_booking_addons"

    customer_hotel_booking_addon_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    hotel_booking_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customer_hotel_bookings.customer_hotel_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    addon_type: Mapped[str] = mapped_column(_ADDON_TYPE, nullable=False)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    booking: Mapped["CustomerHotelBooking"] = relationship(back_populates="addons")


class CustomerHotelBookingPayment(Base):
    """A payment attempt against a stay. An attempt log, not a ledger."""

    __tablename__ = "customer_hotel_booking_payments"

    customer_hotel_booking_payment_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    hotel_booking_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customer_hotel_bookings.customer_hotel_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    method: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(
        _PAYMENT_STATUS, nullable=False, default=CustomerPaymentStatus.PENDING.value,
    )
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    provider: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    provider_reference: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    failure_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    booking: Mapped["CustomerHotelBooking"] = relationship(back_populates="payments")


# =====================================================================
# Tour package system (0056). Its own tables, its own booking reference
# series (JPP######) — same reasoning as 0055's hotel tables, applied to a
# trip with a departure date and a per-person price instead of a stay.
# =====================================================================

class CustomerPackage(Base):
    """A tour package. What ``SAMPLE_PACKAGES`` was, now served from a real table."""

    __tablename__ = "customer_packages"

    customer_package_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    blurb: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    days: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    price_from: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    is_international: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    inclusions: Mapped[list[str]] = mapped_column(ARRAY(String(120)), nullable=False, default=list)
    cancellation_policy: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    image_key: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    departures: Mapped[list["CustomerPackageDeparture"]] = relationship(
        back_populates="package", order_by="CustomerPackageDeparture.departure_date",
    )


class CustomerPackageDeparture(Base):
    """One group-departure date at a fixed per-person price."""

    __tablename__ = "customer_package_departures"

    customer_package_departure_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    package_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customer_packages.customer_package_id", ondelete="CASCADE"), nullable=False,
    )
    departure_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    price_per_person: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    seats_left: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=12)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    package: Mapped["CustomerPackage"] = relationship(back_populates="departures")


class CustomerPackageBooking(Base):
    """One booking. The trip is a snapshot -- see migration 0056."""

    __tablename__ = "customer_package_bookings"

    customer_package_booking_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    booking_ref: Mapped[str] = mapped_column(String(20), nullable=False)
    customer_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customers.customer_id", ondelete="RESTRICT"), nullable=False,
    )
    status: Mapped[str] = mapped_column(
        _BOOKING_STATUS, nullable=False, default=CustomerBookingStatus.PENDING.value,
    )

    package_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("customer_packages.customer_package_id", ondelete="RESTRICT"), nullable=False,
    )
    package_name: Mapped[str] = mapped_column(String(150), nullable=False)
    package_days: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    is_international: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    departure_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customer_package_departures.customer_package_departure_id", ondelete="RESTRICT"),
        nullable=False,
    )
    departure_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    pax_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    base_total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    taxes: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    addon_total: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    discount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    total_amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    coupon_code: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)

    cancelled_at: Mapped[Optional[dt.datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    @property
    def product_type(self) -> str:
        return "package"

    travellers: Mapped[list["CustomerPackageBookingTraveller"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
        order_by="CustomerPackageBookingTraveller.traveller_index",
    )
    addons: Mapped[list["CustomerPackageBookingAddon"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
    )
    payments: Mapped[list["CustomerPackageBookingPayment"]] = relationship(
        back_populates="booking", cascade="all, delete-orphan",
        order_by="CustomerPackageBookingPayment.customer_package_booking_payment_id",
    )


class CustomerPackageBookingTraveller(Base):
    """Who is going. Frozen at booking time — passport rules mirror a
    flight's (0053): required and 6-month-checked only when the package's
    destination is international."""

    __tablename__ = "customer_package_booking_travellers"

    customer_package_booking_traveller_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    package_booking_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customer_package_bookings.customer_package_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    traveller_index: Mapped[int] = mapped_column(Integer, nullable=False)
    traveller_type: Mapped[str] = mapped_column(
        _TRAVELLER_TYPE, nullable=False, default=CustomerTravellerType.ADULT.value,
    )
    title: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    gender: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    date_of_birth: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    nationality: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    passport_number: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    passport_expiry: Mapped[Optional[dt.date]] = mapped_column(Date, nullable=True)
    issuing_country: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    is_contact: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    mobile: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    booking: Mapped["CustomerPackageBooking"] = relationship(back_populates="travellers")


class CustomerPackageBookingAddon(Base):
    """A hotel upgrade, a private guide, a transfer, insurance — bought on a trip."""

    __tablename__ = "customer_package_booking_addons"

    customer_package_booking_addon_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    package_booking_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customer_package_bookings.customer_package_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    traveller_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    addon_type: Mapped[str] = mapped_column(_ADDON_TYPE, nullable=False)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    unit_price: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    booking: Mapped["CustomerPackageBooking"] = relationship(back_populates="addons")


class CustomerPackageBookingPayment(Base):
    """A payment attempt against a package booking. An attempt log, not a ledger."""

    __tablename__ = "customer_package_booking_payments"

    customer_package_booking_payment_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    package_booking_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("customer_package_bookings.customer_package_booking_id", ondelete="CASCADE"),
        nullable=False,
    )
    method: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(
        _PAYMENT_STATUS, nullable=False, default=CustomerPaymentStatus.PENDING.value,
    )
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    provider: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    provider_reference: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    failure_reason: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    booking: Mapped["CustomerPackageBooking"] = relationship(back_populates="payments")
