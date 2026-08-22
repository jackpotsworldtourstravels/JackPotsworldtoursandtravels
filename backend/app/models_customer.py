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
    Date,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
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
