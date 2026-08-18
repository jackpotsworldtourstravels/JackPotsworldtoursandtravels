"""SQLAlchemy 2.0 models for the nine-table schema (migration 0023).

Standalone module, deliberately not merged into ``app/models/``: that
package still holds the legacy models for the 39-table design, which the
routers and services import. Both exist during the rewrite; delete
``app/models/`` once every router has been ported over to this module.

Mirrors backend/db/schema_v2/02_nine_table_schema.sql exactly. If you change
one, change the other — the SQL file is the source of truth for the DDL, and
these classes are the source of truth for the ORM layer.
"""
from __future__ import annotations

import datetime as dt
import enum
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Declarative base for the v2 schema."""


# ---------------------------------------------------------------------
# Enums — names match the PostgreSQL types created by the migration, so
# ``create_type=False`` keeps SQLAlchemy from trying to re-create them.
# ---------------------------------------------------------------------
class UserRole(str, enum.Enum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
    #: Platform staff who sign off a submitted Booking Request before the
    #: operations desk may act on it (CR-2, migration 0033). Deliberately its
    #: own role rather than an Admin holding one extra code — the Admin who
    #: answered the Ticket Enquiry must not also be able to approve the booking
    #: that came out of it.
    MANAGER = "manager"
    MERCHANT_ADMIN = "merchant_admin"
    MERCHANT_USER = "merchant_user"
    CUSTOMER = "customer"


class UserStatus(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    BLOCKED = "blocked"
    SUSPENDED = "suspended"
    DELETED = "deleted"


class MerchantStatus(str, enum.Enum):
    #: A merchant created by an Admin starts here and cannot trade until approved.
    PENDING_APPROVAL = "pending_approval"
    ACTIVE = "active"
    INACTIVE = "inactive"
    SUSPENDED = "suspended"
    DELETED = "deleted"


class MerchantRole(str, enum.Enum):
    """A merchant's internal staff role.

    Orthogonal to :class:`UserRole`, which stays the portal-level role.
    NULL for platform staff (super admin / admin).
    """

    MANAGER = "manager"
    SUPERVISOR = "supervisor"
    OPERATOR = "operator"
    FINANCE = "finance"
    DATA_OPERATOR = "data_operator"


class CompanyType(str, enum.Enum):
    GAMING_COMPANY = "gaming_company"
    CORPORATE_COMPANY = "corporate_company"
    TRAVEL_AGENCY = "travel_agency"
    BUSINESS_PARTNER = "business_partner"
    DIRECT_CUSTOMER = "direct_customer"


class RequestType(str, enum.Enum):
    CATALOG_ITEM = "catalog_item"
    BOOKING = "booking"
    TICKET_ENQUIRY = "ticket_enquiry"
    CANCELLATION = "cancellation"
    REFUND = "refund"
    DATE_CHANGE = "date_change"
    PASSENGER_MODIFICATION = "passenger_modification"
    SUPPORT_TICKET = "support_ticket"
    REVIEW = "review"
    WISHLIST = "wishlist"
    # --- added by migration 0025 for the 3-role B2B spec ---
    DOCUMENT = "document"          # passport / visa / ID / company document
    ATTACHMENT = "attachment"      # file on a support ticket or request
    LIVE_CHAT = "live_chat"        # a chat conversation thread
    EXTRA_BAGGAGE = "extra_baggage"
    MEAL = "meal"
    SEAT = "seat"
    # --- added by migration 0048 for Hotel service requests (Phase 2) ---
    # Not wired to any endpoint yet — grown here because ALTER TYPE ... ADD
    # VALUE can't run in the same transaction that later uses it.
    ROOM_UPGRADE = "room_upgrade"
    ROOM_DOWNGRADE = "room_downgrade"
    EARLY_CHECK_IN = "early_check_in"
    LATE_CHECK_OUT = "late_check_out"
    EXTRA_BED = "extra_bed"
    AIRPORT_TRANSFER = "airport_transfer"
    GUEST_NAME_CORRECTION = "guest_name_correction"


class RequestStatus(str, enum.Enum):
    """Request lifecycle.

    The spec's stages map onto these values as::

        Created         -> DRAFT
        Pending         -> PENDING_APPROVAL
        Under Review    -> IN_REVIEW
        Approved        -> APPROVED
        Payment Pending -> PAYMENT_PENDING
        Paid            -> PAID
        Ticket Issued   -> TICKET_ISSUED
        Completed       -> COMPLETED
        Rejected        -> REJECTED
    """

    DRAFT = "draft"
    SUBMITTED = "submitted"
    PENDING_APPROVAL = "pending_approval"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    REJECTED = "rejected"
    # --- added by migration 0025 ---
    PAYMENT_PENDING = "payment_pending"
    PAID = "paid"
    TICKET_ISSUED = "ticket_issued"
    VERIFIED = "verified"          # terminal state for a document review
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class Priority(str, enum.Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


class TravelType(str, enum.Enum):
    FLIGHT = "flight"
    HOTEL = "hotel"
    CRUISE = "cruise"
    PACKAGE = "package"


class ServiceCode(str, enum.Enum):
    """A travel product an Admin may grant or withhold per merchant.

    Orthogonal to :class:`TravelType`: this gates whether a merchant may use
    a product at all (checked once, at the door); ``TravelType`` just tags
    which product a given ``service_requests`` row belongs to once inside.
    """

    FLIGHTS = "flights"
    HOTELS = "hotels"
    VISA = "visa"
    #: Added by migration 0049 — the entitlement ships before the product
    #: does, same precedent Visa itself set in 0045. No enquiry/booking
    #: feature exists behind this yet; the Merchant Portal gates a "coming
    #: soon" placeholder page on it (classic-holidays.js).
    HOLIDAYS = "holidays"


class PaymentType(str, enum.Enum):
    BOOKING_PAYMENT = "booking_payment"
    REFUND = "refund"
    WALLET_TOPUP = "wallet_topup"
    ADJUSTMENT = "adjustment"


class PaymentStatus(str, enum.Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    SUCCESS = "success"
    FAILED = "failed"
    REFUNDED = "refunded"
    PARTIALLY_REFUNDED = "partially_refunded"


class WalletTxnType(str, enum.Enum):
    """Why the wallet moved (CR-4, migration 0036).

    The direction is *not* encoded here — it lives in the ``debit`` / ``credit``
    columns, because a refund credits and a cancellation charge debits and both
    arise from the same event. Reading direction off the type is how a ledger
    ends up with two answers.
    """

    #: A booking reached Ticket Issued and was billed to the wallet (CR-4b).
    BOOKING_DEBIT = "booking_debit"
    #: A merchant's top-up, verified by an admin.
    WALLET_RECHARGE = "wallet_recharge"
    #: Money given back against a cancelled or re-priced booking.
    REFUND_CREDIT = "refund_credit"
    #: Staff correcting the balance by hand, always with a reason.
    MANUAL_ADJUSTMENT = "manual_adjustment"
    #: A goodwill or commercial credit that is not a refund of a specific payment.
    CREDIT_NOTE = "credit_note"
    #: The charge retained when a booking is cancelled (M3 computes it).
    CANCELLATION_CHARGE = "cancellation_charge"
    #: The fare difference + change fee billed when an approved reschedule is
    #: settled against a wallet-billed booking (M3/M4).
    RESCHEDULE_FEE = "reschedule_fee"


class ProviderStatus(str, enum.Enum):
    """Whether a provider (or a person at one) is still used (migration 0039).

    There is no ``deleted`` member and no delete path: a provider with bookings
    against it is a purchase record, so it is retired by going ``INACTIVE``
    rather than removed.
    """

    ACTIVE = "active"
    INACTIVE = "inactive"


class WalletTopupStatus(str, enum.Enum):
    #: An Admin has raised a payment request and named the manager who must
    #: settle it, but nobody has paid yet (migration 0041). Nothing here is
    #: reviewable — ``_assert_undecided`` admits ``submitted`` only — so a
    #: request in this state can never credit a wallet.
    AWAITING_PAYMENT = "awaiting_payment"
    SUBMITTED = "submitted"
    VERIFIED = "verified"
    REJECTED = "rejected"


class WalletTopupMethod(str, enum.Enum):
    BANK_TRANSFER = "bank_transfer"
    UPI = "upi"
    QR = "qr"
    CASH = "cash"
    #: Admin-initiated only (migration 0041). Carries a wallet address and a
    #: network (TRC20 / ERC20 / BEP20) in ``instructions``, and is proved by an
    #: image rather than a UTR — a chain has no bank reference.
    CRYPTO = "crypto"
    OTHER = "other"


class PaymentAccountType(str, enum.Enum):
    BANK = "bank"
    UPI = "upi"
    QR = "qr"


class Gender(str, enum.Enum):
    MALE = "male"
    FEMALE = "female"
    OTHER = "other"


class PassengerType(str, enum.Enum):
    ADULT = "adult"
    CHILD = "child"
    INFANT = "infant"


class SeatPreference(str, enum.Enum):
    WINDOW = "window"
    AISLE = "aisle"
    MIDDLE = "middle"
    FRONT_ROW = "front_row"
    EXIT_ROW = "exit_row"


class OtpPurpose(str, enum.Enum):
    LOGIN = "login"
    PASSWORD_RESET = "password_reset"
    VERIFICATION = "verification"


class MessageType(str, enum.Enum):
    OTP = "otp"
    EMAIL = "email"
    SMS = "sms"
    WHATSAPP = "whatsapp"
    LIVE_CHAT = "live_chat"
    PUSH = "push"
    NEWSLETTER = "newsletter"
    CONTACT_US = "contact_us"
    NOTIFICATION = "notification"


class MessageStatus(str, enum.Enum):
    QUEUED = "queued"
    SENT = "sent"
    DELIVERED = "delivered"
    FAILED = "failed"
    READ = "read"
    BOUNCED = "bounced"


class AuditOperation(str, enum.Enum):
    INSERT = "INSERT"
    UPDATE = "UPDATE"
    DELETE = "DELETE"


class DocumentType(str, enum.Enum):
    PASSPORT = "passport"
    VISA = "visa"
    PHOTO_ID = "photo_id"
    TICKET = "ticket"
    #: The filled passenger spreadsheet behind a group booking (0042). Kept
    #: distinct from OTHER so the desk can tell a manifest from a scan in a
    #: listing, and so retention rules can treat the two differently.
    GROUP_MANIFEST = "group_manifest"
    OTHER = "other"


class GroupImportStatus(str, enum.Enum):
    """How a group manifest fared against validation (0042).

    ``PARTIAL`` is why this is not a boolean: a 200-row sheet with 3 bad rows is
    neither valid nor invalid, and the merchant is offered a per-row error
    report against exactly that state. Only ``VALID`` may become a booking.
    """

    PENDING = "pending"
    VALID = "valid"
    PARTIAL = "partial"
    INVALID = "invalid"


class DocumentVerification(str, enum.Enum):
    PENDING = "pending"
    VERIFIED = "verified"
    REJECTED = "rejected"


def _pg_enum(python_enum: type[enum.Enum], name: str) -> SAEnum:
    """Bind to an existing PostgreSQL ENUM by value, without re-creating it."""
    return SAEnum(
        python_enum,
        name=name,
        create_type=False,
        native_enum=True,
        values_callable=lambda e: [m.value for m in e],
    )


_TS = DateTime(timezone=True)


# =====================================================================
# 2. merchants
# =====================================================================
class Merchant(Base):
    """A B2B partner company: gaming studio, corporate travel desk, agency.

    Absorbs the legacy ``partners`` table, its wallet columns, and
    ``booking_reference_counters`` (each merchant carries its own reference
    prefix and sequence, so no counter table is needed).
    """

    __tablename__ = "merchants"

    merchant_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merchant_code: Mapped[str] = mapped_column(String(32), nullable=False)
    merchant_name: Mapped[str] = mapped_column(String(150), nullable=False)
    company_name: Mapped[str] = mapped_column(String(200), nullable=False)
    company_type: Mapped[CompanyType] = mapped_column(
        _pg_enum(CompanyType, "company_type_enum"),
        nullable=False,
        server_default=text("'business_partner'"),
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    phone: Mapped[Optional[str]] = mapped_column(String(30))

    reference_prefix: Mapped[str] = mapped_column(String(8), nullable=False)
    booking_sequence: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    wallet_balance: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, server_default=text("0")
    )
    credit_limit: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, server_default=text("0")
    )

    country: Mapped[Optional[str]] = mapped_column(String(100))
    country_code: Mapped[Optional[str]] = mapped_column(String(2))
    city: Mapped[Optional[str]] = mapped_column(String(100))
    address: Mapped[Optional[str]] = mapped_column(Text)

    status: Mapped[MerchantStatus] = mapped_column(
        _pg_enum(MerchantStatus, "merchant_status_enum"),
        nullable=False,
        server_default=text("'active'"),
    )
    # use_alter: merchants.created_by -> users and users.merchant_id ->
    # merchants form a cycle. Marking this side as ALTER-added lets
    # SQLAlchemy sort the tables (and matches the migration, which adds this
    # constraint by ALTER TABLE after both tables exist).
    created_by: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        ForeignKey(
            "users.user_id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_merchants_created_by",
        ),
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    users: Mapped[list["User"]] = relationship(
        back_populates="merchant",
        cascade="all, delete-orphan",
        foreign_keys="User.merchant_id",
    )
    communication_settings: Mapped[Optional["CommunicationSettings"]] = relationship(
        back_populates="merchant", cascade="all, delete-orphan", uselist=False
    )
    #: One row per ServiceCode, not uselist=False — unlike communication
    #: settings, a merchant has several of these (see MerchantServiceAccess).
    service_access: Mapped[list["MerchantServiceAccess"]] = relationship(
        back_populates="merchant", cascade="all, delete-orphan"
    )
    requests: Mapped[list["ServiceRequest"]] = relationship(back_populates="merchant")

    __table_args__ = (
        UniqueConstraint("merchant_code", name="uq_merchants_code"),
        UniqueConstraint("email", name="uq_merchants_email"),
        UniqueConstraint("reference_prefix", name="uq_merchants_prefix"),
        # No non-negative constraint on wallet_balance: CR-4 (migration 0036)
        # made the wallet a running account, and a negative balance is the
        # merchant's outstanding position, not a corruption. Exposure is bounded
        # by credit_limit in wallet_service, which is a per-merchant business
        # limit rather than a floor at zero identical for everyone.
        CheckConstraint("credit_limit >= 0", name="ck_merchants_credit_non_negative"),
        CheckConstraint("booking_sequence >= 0", name="ck_merchants_sequence_non_negative"),
        Index("ix_merchants_status", "status"),
        Index("ix_merchants_company_type", "company_type"),
        Index("ix_merchants_status_name", "status", "company_name"),
    )

    def __repr__(self) -> str:
        return f"<Merchant {self.merchant_code} {self.company_name!r}>"


# =====================================================================
# 1. users
# =====================================================================
class User(Base):
    """Every human identity: super admin, admin, merchant staff, customer.

    Absorbs ``users``, ``roles``, ``permissions``, ``role_permissions``,
    ``partner_users``, and the in-flight row of ``partner_otp_requests``.
    """

    __tablename__ = "users"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merchant_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE")
    )

    role: Mapped[UserRole] = mapped_column(
        _pg_enum(UserRole, "user_role_enum"),
        nullable=False,
        server_default=text("'customer'"),
    )
    #: Internal staff role within a merchant. NULL for platform staff.
    merchant_role: Mapped[Optional[MerchantRole]] = mapped_column(
        _pg_enum(MerchantRole, "merchant_role_enum")
    )
    #: Permission codes, e.g. ``["booking.approve", "reports.export"]``.
    permissions: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )

    full_name: Mapped[str] = mapped_column(String(150), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    phone: Mapped[Optional[str]] = mapped_column(String(30))
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    #: Sparse profile fields (address, dob, passport, preferences, ...).
    profile: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )

    otp_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    otp_code_hash: Mapped[Optional[str]] = mapped_column(String(255))
    otp_purpose: Mapped[Optional[OtpPurpose]] = mapped_column(
        _pg_enum(OtpPurpose, "otp_purpose_enum")
    )
    otp_expires_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    otp_attempts: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("0")
    )
    otp_requested_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)

    email_verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    status: Mapped[UserStatus] = mapped_column(
        _pg_enum(UserStatus, "user_status_enum"),
        nullable=False,
        server_default=text("'active'"),
    )
    last_login: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    failed_login_attempts: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("0")
    )
    login_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    # Password-reset state (migration 0024).
    reset_token_hash: Mapped[Optional[str]] = mapped_column(String(64))
    reset_token_expires_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)

    # Logout for stateless JWTs: any token issued before this instant is
    # rejected. Set by /api/auth/logout and by the admin force-logout action.
    force_logout_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)

    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    merchant: Mapped[Optional["Merchant"]] = relationship(
        back_populates="users", foreign_keys=[merchant_id]
    )
    requests: Mapped[list["ServiceRequest"]] = relationship(
        back_populates="user", foreign_keys="ServiceRequest.user_id"
    )

    __table_args__ = (
        UniqueConstraint("email", name="uq_users_email"),
        CheckConstraint(
            "jsonb_typeof(permissions) = 'array'", name="ck_users_permissions_is_array"
        ),
        CheckConstraint("jsonb_typeof(profile) = 'object'", name="ck_users_profile_is_object"),
        CheckConstraint("otp_attempts >= 0", name="ck_users_otp_attempts_sane"),
        CheckConstraint(
            "merchant_role IS NULL OR role IN ('merchant_admin', 'merchant_user')",
            name="ck_users_merchant_role_scope",
        ),
        CheckConstraint(
            "(role IN ('merchant_admin', 'merchant_user') AND merchant_id IS NOT NULL) "
            "OR (role IN ('super_admin', 'admin', 'manager', 'customer') "
            "AND merchant_id IS NULL)",
            name="ck_users_merchant_scope",
        ),
        Index("ix_users_merchant_id", "merchant_id"),
        Index("ix_users_role", "role"),
        Index("ix_users_status", "status"),
        Index("ix_users_permissions", "permissions", postgresql_using="gin"),
        Index(
            "ix_users_reset_token",
            "reset_token_hash",
            postgresql_where=text("reset_token_hash IS NOT NULL"),
        ),
    )

    @property
    def is_platform_staff(self) -> bool:
        """Works for the platform rather than for one merchant.

        A Manager is included: it reviews bookings across every merchant, so
        the cross-tenant scoping rules (``ticket_service.scoped_query``,
        ``assert_same_merchant``) must let it through. What a Manager may
        actually *do* is decided by its permission codes, which are a much
        smaller set than an Admin's — this property answers "whose data",
        never "which action".
        """
        return self.role in (UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.MANAGER)

    @property
    def is_manager(self) -> bool:
        return self.role is UserRole.MANAGER

    @property
    def is_merchant_user(self) -> bool:
        return self.role in (UserRole.MERCHANT_ADMIN, UserRole.MERCHANT_USER)

    @property
    def is_active(self) -> bool:
        """Legacy-compatible view of ``status``."""
        return self.status is UserStatus.ACTIVE

    @property
    def is_blocked(self) -> bool:
        return self.status is UserStatus.BLOCKED

    def has_permission(self, code: str) -> bool:
        return self.role is UserRole.SUPER_ADMIN or code in (self.permissions or [])

    def __repr__(self) -> str:
        return f"<User {self.email} role={self.role.value}>"


# =====================================================================
# 3. service_requests
# =====================================================================
class ServiceRequest(Base):
    """Catalog inventory, bookings, and every request raised against them.

    ``request_type`` discriminates the row. ``parent_request_id`` carries the
    relationships that used to live in separate tables:

    * ``booking``       -> parent is the ``catalog_item`` being purchased
    * ``cancellation``  -> parent is the ``booking`` being cancelled
    * ``refund``        -> parent is the ``booking`` being refunded
    * ``date_change``   -> parent is the ``booking`` being moved
    * ``review``        -> parent is the ``catalog_item`` being reviewed
    * ``wishlist``      -> parent is the ``catalog_item`` saved
    """

    __tablename__ = "service_requests"

    request_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_number: Mapped[str] = mapped_column(String(40), nullable=False)
    parent_request_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("service_requests.request_id", ondelete="CASCADE")
    )

    merchant_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE")
    )
    user_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )

    request_type: Mapped[RequestType] = mapped_column(
        _pg_enum(RequestType, "request_type_enum"), nullable=False
    )
    booking_reference: Mapped[Optional[str]] = mapped_column(String(40))
    travel_type: Mapped[Optional[TravelType]] = mapped_column(
        _pg_enum(TravelType, "travel_type_enum")
    )

    # Identifiers issued as the request moves through the lifecycle
    # (migration 0025). ``pnr`` is a primary search key in the spec.
    pnr: Mapped[Optional[str]] = mapped_column(String(20))
    ticket_number: Mapped[Optional[str]] = mapped_column(String(40))
    invoice_number: Mapped[Optional[str]] = mapped_column(String(40))

    status: Mapped[RequestStatus] = mapped_column(
        _pg_enum(RequestStatus, "request_status_enum"),
        nullable=False,
        server_default=text("'draft'"),
    )
    priority: Mapped[Priority] = mapped_column(
        _pg_enum(Priority, "priority_enum"), nullable=False, server_default=text("'normal'")
    )

    title: Mapped[Optional[str]] = mapped_column(String(255))
    remarks: Mapped[Optional[str]] = mapped_column(Text)

    #: Type-specific payload — see docs/SCHEMA_V2.md for the shape per type.
    travel_details: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    #: Base fare plus any seasonal/campaign overrides, as a snapshot.
    pricing: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )

    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    total_amount: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, server_default=text("0")
    )
    #: What the merchant quoted its OWN end customer (migration 0040). Never a
    #: price this platform charges — it does not settle, bill or move a wallet.
    #: NULL means "not recorded", which is not the same as 0 ("quoted at zero"),
    #: so every consumer must treat NULL as "no savings figure" rather than as a
    #: zero saving. See ``saved_amount`` below for the derived margin.
    client_fare: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))

    @property
    def saved_amount(self) -> Optional[Decimal]:
        """``client_fare - total_amount``, or None when no fare was recorded.

        FLOORED AT ZERO ON PURPOSE. If we billed more than the merchant sold
        at, that is a loss on their side, not a negative saving — and letting it
        go negative would silently subtract from the "Total Savings" figure on
        their dashboard, making a bad month look like a smaller good one. A loss
        is visible from the two numbers themselves, which are both shown.
        """
        if self.client_fare is None:
            return None
        diff = self.client_fare - (self.total_amount or Decimal("0"))
        return diff if diff > 0 else Decimal("0")

    available_units: Mapped[Optional[int]] = mapped_column(Integer)
    low_stock_threshold: Mapped[Optional[int]] = mapped_column(Integer)

    rating: Mapped[Optional[int]] = mapped_column(SmallInteger)

    requested_date: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    travel_date: Mapped[Optional[dt.date]] = mapped_column(Date)
    return_date: Mapped[Optional[dt.date]] = mapped_column(Date)

    assigned_admin: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    #: Who this booking was actually BOUGHT FROM, recorded at ticket issuance
    #: (migration 0039). Nullable because every booking issued before providers
    #: existed has no honest value — the analytics skip those rather than
    #: attributing them to a supplier that was never asked.
    provider_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("providers.provider_id", ondelete="RESTRICT")
    )
    provider_user_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("provider_users.provider_user_id", ondelete="RESTRICT")
    )
    approved_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    approved_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text)
    completed_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    resolved_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)

    #: Append-only ``[{"from":..., "to":..., "by":..., "at":...}]``.
    status_history: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )

    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    parent: Mapped[Optional["ServiceRequest"]] = relationship(
        back_populates="children", remote_side=[request_id]
    )
    children: Mapped[list["ServiceRequest"]] = relationship(
        back_populates="parent", cascade="all, delete-orphan"
    )
    merchant: Mapped[Optional["Merchant"]] = relationship(back_populates="requests")
    user: Mapped[Optional["User"]] = relationship(
        back_populates="requests", foreign_keys=[user_id]
    )
    #: The supplier this was bought from, and the person there who booked it.
    #: Read-only conveniences for rendering — nothing writes through these; the
    #: foreign keys above are what ticket issuance sets. Ordinary lazy loading,
    #: not ``raise_on_sql``: these hang off ServiceRequest, which is serialised
    #: by a dozen existing responses, and a stricter default would turn any of
    #: them that happens to touch the attribute into a 500.
    provider: Mapped[Optional["Provider"]] = relationship(foreign_keys=[provider_id])
    provider_user: Mapped[Optional["ProviderUser"]] = relationship(
        foreign_keys=[provider_user_id]
    )
    # Ordered explicitly: an UPDATE writes a new tuple in Postgres, so an
    # unordered read can return an edited passenger last and silently reshuffle
    # the traveller list the merchant is looking at. The id is a sequence, so
    # this is the order they were added in.
    passengers: Mapped[list["PassengerData"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="PassengerData.passenger_id",
    )
    #: Guest manifest for a hotel booking (``travel_type='hotel'`` only) —
    #: the hotel equivalent of ``passengers``, kept as a separate table and
    #: relationship because a hotel guest's columns (room number, id-proof)
    #: don't fit PassengerData's flight-shaped ones (seat, passport, meal).
    #: Left lazy on purpose, same posture as ``group_import``: most listing
    #: screens never touch it, and the screens that do (booking detail,
    #: invoice rendering) eager-load it explicitly.
    hotel_guests: Mapped[list["HotelBookingGuest"]] = relationship(
        back_populates="booking_request",
        cascade="all, delete-orphan",
        order_by="HotelBookingGuest.id",
    )
    payments: Mapped[list["Payment"]] = relationship(back_populates="request")
    documents: Mapped[list["RequestDocument"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="RequestDocument.document_id",
    )
    #: The passenger manifest this booking was imported from (0042), or None.
    #: ``uselist=False`` because a booking has at most one — replacing the file
    #: before submission replaces the staging row, it does not add a second.
    #: Left lazy on purpose: listings render hundreds of rows and almost none of
    #: them are group bookings, so the screens that need it eager-load it.
    group_import: Mapped[Optional["GroupBookingImport"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        uselist=False,
    )
    #: Internal operator notes. Never serialised into a merchant-facing
    #: response — see RequestNote and migration 0032.
    notes: Mapped[list["RequestNote"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="RequestNote.note_id",
    )

    __table_args__ = (
        UniqueConstraint("request_number", name="uq_service_requests_number"),
        UniqueConstraint("ticket_number", name="uq_sr_ticket_number"),
        UniqueConstraint("invoice_number", name="uq_sr_invoice_number"),
        CheckConstraint("quantity > 0", name="ck_sr_quantity_positive"),
        CheckConstraint("total_amount >= 0", name="ck_sr_amount_non_negative"),
        CheckConstraint("rating IS NULL OR rating BETWEEN 1 AND 5", name="ck_sr_rating_range"),
        CheckConstraint("jsonb_typeof(travel_details) = 'object'", name="ck_sr_details_is_object"),
        CheckConstraint("jsonb_typeof(pricing) = 'object'", name="ck_sr_pricing_is_object"),
        CheckConstraint("jsonb_typeof(status_history) = 'array'", name="ck_sr_history_is_array"),
        CheckConstraint(
            "return_date IS NULL OR travel_date IS NULL OR return_date >= travel_date",
            name="ck_sr_date_order",
        ),
        CheckConstraint(
            "parent_request_id IS NULL OR parent_request_id <> request_id",
            name="ck_sr_no_self_parent",
        ),
        CheckConstraint(
            "request_type <> 'catalog_item' OR (merchant_id IS NULL AND user_id IS NULL)",
            name="ck_sr_catalog_has_no_owner",
        ),
        CheckConstraint(
            "request_type NOT IN ('cancellation', 'refund', 'date_change', "
            "'passenger_modification') OR parent_request_id IS NOT NULL",
            name="ck_sr_modifications_have_parent",
        ),
        Index("ix_sr_merchant_id", "merchant_id"),
        Index("ix_sr_user_id", "user_id"),
        Index("ix_sr_parent", "parent_request_id"),
        Index("ix_sr_type_status", "request_type", "status"),
        Index("ix_sr_booking_ref", "booking_reference"),
        Index("ix_sr_travel_type", "travel_type"),
        Index("ix_sr_travel_date", "travel_date"),
        Index("ix_sr_pnr", "pnr", postgresql_where=text("pnr IS NOT NULL")),
        Index("ix_sr_created_at", text("created_at DESC")),
        Index("ix_sr_details_gin", "travel_details", postgresql_using="gin"),
        Index(
            "ix_sr_catalog_live",
            "travel_type",
            "status",
            postgresql_where=text("request_type = 'catalog_item'"),
        ),
        Index(
            "uq_sr_wishlist_once",
            "user_id",
            "parent_request_id",
            unique=True,
            postgresql_where=text("request_type = 'wishlist'"),
        ),
        Index(
            "uq_sr_review_once",
            "user_id",
            "parent_request_id",
            unique=True,
            postgresql_where=text("request_type = 'review'"),
        ),
    )

    def __repr__(self) -> str:
        return f"<ServiceRequest {self.request_number} {self.request_type.value}>"


# =====================================================================
# 4. payments
# =====================================================================
class Payment(Base):
    """Money movement. Absorbs ``payments``, ``partner_payments``,
    ``coupons``, and ``discount_campaigns``."""

    __tablename__ = "payments"

    payment_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merchant_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="SET NULL")
    )
    request_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("service_requests.request_id", ondelete="SET NULL")
    )
    user_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )

    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    currency: Mapped[str] = mapped_column(
        String(3), nullable=False, server_default=text("'INR'")
    )
    payment_type: Mapped[PaymentType] = mapped_column(
        _pg_enum(PaymentType, "payment_type_enum"), nullable=False
    )
    payment_method: Mapped[Optional[str]] = mapped_column(String(50))
    transaction_id: Mapped[Optional[str]] = mapped_column(String(100))
    payment_status: Mapped[PaymentStatus] = mapped_column(
        _pg_enum(PaymentStatus, "payment_status_enum"),
        nullable=False,
        server_default=text("'pending'"),
    )

    coupon_code: Mapped[Optional[str]] = mapped_column(String(50))
    discount_amount: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, server_default=text("0")
    )
    discount_meta: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )

    refund_amount: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, server_default=text("0")
    )
    refund_reason: Mapped[Optional[str]] = mapped_column(Text)
    refunded_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)

    paid_date: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    request: Mapped[Optional["ServiceRequest"]] = relationship(back_populates="payments")

    __table_args__ = (
        UniqueConstraint("transaction_id", name="uq_payments_transaction_id"),
        CheckConstraint("amount >= 0", name="ck_payments_amount_non_negative"),
        CheckConstraint("discount_amount >= 0", name="ck_payments_discount_non_negative"),
        CheckConstraint("refund_amount >= 0", name="ck_payments_refund_non_negative"),
        CheckConstraint("refund_amount <= amount", name="ck_payments_refund_within_amount"),
        CheckConstraint("jsonb_typeof(discount_meta) = 'object'", name="ck_payments_meta_is_object"),
        Index("ix_payments_merchant_id", "merchant_id"),
        Index("ix_payments_request_id", "request_id"),
        Index("ix_payments_status", "payment_status"),
        Index("ix_payments_paid_date", text("paid_date DESC")),
        Index("ix_payments_coupon", "coupon_code", postgresql_where=text("coupon_code IS NOT NULL")),
    )

    def __repr__(self) -> str:
        return f"<Payment {self.payment_id} {self.amount} {self.payment_status.value}>"


# =====================================================================
# 5. passenger_data
# =====================================================================
class PassengerData(Base):
    """A traveller on a request. Absorbs ``partner_booking_passengers``,
    ``cancellation_request_passengers``, ``passenger_special_services``,
    and ``ancillary_service_catalog`` selections."""

    __tablename__ = "passenger_data"

    passenger_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("service_requests.request_id", ondelete="CASCADE"),
        nullable=False,
    )
    merchant_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE")
    )

    title: Mapped[Optional[str]] = mapped_column(String(10))
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    gender: Mapped[Optional[Gender]] = mapped_column(_pg_enum(Gender, "gender_enum"))
    dob: Mapped[Optional[dt.date]] = mapped_column(Date)
    passenger_type: Mapped[PassengerType] = mapped_column(
        _pg_enum(PassengerType, "passenger_type_enum"),
        nullable=False,
        server_default=text("'adult'"),
    )

    passport_number: Mapped[Optional[str]] = mapped_column(String(40))
    passport_issue_country: Mapped[Optional[str]] = mapped_column(String(100))
    passport_issue_date: Mapped[Optional[dt.date]] = mapped_column(Date)
    passport_expiry: Mapped[Optional[dt.date]] = mapped_column(Date)
    nationality: Mapped[Optional[str]] = mapped_column(String(100))

    seat_preference: Mapped[Optional[SeatPreference]] = mapped_column(
        _pg_enum(SeatPreference, "seat_preference_enum")
    )
    meal_preference: Mapped[Optional[str]] = mapped_column(String(100))
    #: ``[{"category":"baggage","code":"XBAG20","label":"Extra 20kg","price":1500}]``
    special_services: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )

    is_cancelled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    request: Mapped["ServiceRequest"] = relationship(back_populates="passengers")

    __table_args__ = (
        CheckConstraint(
            "jsonb_typeof(special_services) = 'array'", name="ck_passenger_services_is_array"
        ),
        CheckConstraint(
            "passport_expiry IS NULL OR passport_issue_date IS NULL "
            "OR passport_expiry > passport_issue_date",
            name="ck_passenger_passport_dates",
        ),
        Index("ix_passenger_request_id", "request_id"),
        Index("ix_passenger_merchant_id", "merchant_id"),
        Index("ix_passenger_names", "last_name", "first_name"),
        Index(
            "ix_passenger_passport",
            "passport_number",
            postgresql_where=text("passport_number IS NOT NULL"),
        ),
    )

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()

    def __repr__(self) -> str:
        return f"<PassengerData {self.full_name} req={self.request_id}>"


# =====================================================================
# 6. communication_settings
# =====================================================================
class CommunicationSettings(Base):
    """Per-merchant channel preferences. One row per merchant."""

    __tablename__ = "communication_settings"

    communication_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merchant_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("merchants.merchant_id", ondelete="CASCADE"),
        nullable=False,
    )

    email_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    sms_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    whatsapp_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    otp_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    notification_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    preferred_language: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default=text("'en'")
    )

    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    merchant: Mapped["Merchant"] = relationship(back_populates="communication_settings")

    __table_args__ = (
        UniqueConstraint("merchant_id", name="uq_comm_settings_merchant"),
    )


class MerchantServiceAccess(Base):
    """Whether a merchant may use one travel product. One row per
    ``(merchant_id, service_code)`` — see migration 0045 for why this is a
    table rather than booleans on ``Merchant``."""

    __tablename__ = "merchant_service_access"

    service_access_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merchant_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("merchants.merchant_id", ondelete="CASCADE"),
        nullable=False,
    )
    service_code: Mapped[ServiceCode] = mapped_column(
        _pg_enum(ServiceCode, "service_code_enum"), nullable=False
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    merchant: Mapped["Merchant"] = relationship(back_populates="service_access")

    __table_args__ = (
        UniqueConstraint(
            "merchant_id", "service_code", name="uq_merchant_service_access"
        ),
        Index("ix_merchant_service_access_merchant", "merchant_id"),
    )


# =====================================================================
# 7. msg_logs
# =====================================================================
class MsgLog(Base):
    """Every message in or out. Absorbs ``notifications``,
    ``partner_notifications``, ``newsletter``, ``contact_us``, OTP delivery
    history, and email/SMS/WhatsApp/live-chat logs."""

    __tablename__ = "msg_logs"

    message_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merchant_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE")
    )
    user_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    request_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("service_requests.request_id", ondelete="SET NULL")
    )

    message_type: Mapped[MessageType] = mapped_column(
        _pg_enum(MessageType, "message_type_enum"), nullable=False
    )
    direction: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default=text("'outbound'")
    )

    sender_name: Mapped[Optional[str]] = mapped_column(String(150))
    sender_email: Mapped[Optional[str]] = mapped_column(String(255))

    recipient: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[Optional[str]] = mapped_column(String(255))
    message: Mapped[Optional[str]] = mapped_column(Text)

    status: Mapped[MessageStatus] = mapped_column(
        _pg_enum(MessageStatus, "message_status_enum"),
        nullable=False,
        server_default=text("'queued'"),
    )
    error_message: Mapped[Optional[str]] = mapped_column(Text)
    is_read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    sent_time: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    delivered_time: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("direction IN ('inbound', 'outbound')", name="ck_msg_direction"),
        CheckConstraint(
            "delivered_time IS NULL OR sent_time IS NULL OR delivered_time >= sent_time",
            name="ck_msg_delivery_order",
        ),
        Index("ix_msg_merchant_id", "merchant_id"),
        Index("ix_msg_user_unread", "user_id", "is_read"),
        Index("ix_msg_type_status", "message_type", "status"),
        Index("ix_msg_created_at", text("created_at DESC")),
    )


# =====================================================================
# 8. system_logs
# =====================================================================
class SystemLog(Base):
    """Sessions, activity, report generation. Absorbs ``activity_logs``,
    ``user_sessions``, ``report_generation_log``, and login history."""

    __tablename__ = "system_logs"

    log_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    merchant_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE")
    )

    module: Mapped[str] = mapped_column(String(80), nullable=False)
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)

    ip_address: Mapped[Optional[str]] = mapped_column(INET)
    browser: Mapped[Optional[str]] = mapped_column(String(200))
    device: Mapped[Optional[str]] = mapped_column(String(120))

    session_token: Mapped[Optional[str]] = mapped_column(String(255))
    session_expires_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)

    status: Mapped[str] = mapped_column(
        String(30), nullable=False, server_default=text("'success'")
    )
    #: Named ``extra_data``: ``metadata`` is reserved on declarative classes.
    extra_data: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "jsonb_typeof(extra_data) = 'object'", name="ck_system_logs_extra_is_object"
        ),
        Index("ix_syslog_user_id", "user_id"),
        Index("ix_syslog_merchant", "merchant_id"),
        Index("ix_syslog_module", "module", "action"),
        Index("ix_syslog_created_at", text("created_at DESC")),
        Index(
            "ix_syslog_session",
            "session_token",
            postgresql_where=text("session_token IS NOT NULL"),
        ),
    )


# =====================================================================
# 9. audit_logs
# =====================================================================
class AuditLog(Base):
    """Row-level change history, written by the ``fn_write_audit_log``
    trigger on users/merchants/service_requests/payments. Absorbs
    ``partner_audit_logs``.

    Rows arrive from a database trigger, not the ORM — treat as read-only
    from application code.
    """

    __tablename__ = "audit_logs"

    audit_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    table_name: Mapped[str] = mapped_column(String(80), nullable=False)
    record_id: Mapped[Optional[int]] = mapped_column(BigInteger)
    operation: Mapped[AuditOperation] = mapped_column(
        _pg_enum(AuditOperation, "audit_operation_enum"), nullable=False
    )
    old_value: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    new_value: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    changed_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    changed_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "NOT (old_value IS NULL AND new_value IS NULL)", name="ck_audit_has_payload"
        ),
        Index("ix_audit_table_record", "table_name", "record_id"),
        Index("ix_audit_changed_by", "changed_by"),
        Index("ix_audit_changed_at", text("changed_at DESC")),
    )


# =====================================================================
# 10. request_documents  (migration 0031)
# =====================================================================
class RequestDocument(Base):
    """A supporting file attached to a booking request.

    Only metadata lives here — the bytes sit under the upload root with a
    generated name and are streamed back through an authenticated endpoint.
    ``merchant_id`` is denormalised from the request so scope can be enforced
    without a join, exactly as :class:`PassengerData` does.
    """

    __tablename__ = "request_documents"

    document_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("service_requests.request_id", ondelete="CASCADE"),
        nullable=False,
    )
    merchant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE"), nullable=False
    )
    #: NULL when the document is about the booking rather than one traveller.
    passenger_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("passenger_data.passenger_id", ondelete="CASCADE")
    )

    doc_type: Mapped[DocumentType] = mapped_column(
        _pg_enum(DocumentType, "document_type_enum"),
        nullable=False,
        server_default=text("'other'"),
    )
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Server-side path under the upload root. Never returned to a client.
    stored_path: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    checksum: Mapped[Optional[str]] = mapped_column(String(64))

    uploaded_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    verification_status: Mapped[DocumentVerification] = mapped_column(
        _pg_enum(DocumentVerification, "document_verification_enum"),
        nullable=False,
        server_default=text("'pending'"),
    )
    verified_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    verified_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    request: Mapped["ServiceRequest"] = relationship(back_populates="documents")

    __table_args__ = (
        CheckConstraint("size_bytes > 0", name="ck_request_documents_size_positive"),
        CheckConstraint(
            "verification_status <> 'rejected' OR rejection_reason IS NOT NULL",
            name="ck_request_documents_rejection_reason",
        ),
        Index("ix_request_documents_request", "request_id"),
        Index("ix_request_documents_merchant", "merchant_id"),
        Index(
            "ix_request_documents_passenger", "passenger_id",
            postgresql_where=text("passenger_id IS NOT NULL"),
        ),
        Index(
            "ix_request_documents_pending", "verification_status",
            postgresql_where=text("verification_status = 'pending'"),
        ),
    )

    def __repr__(self) -> str:
        return f"<RequestDocument {self.original_filename} req={self.request_id}>"


# =====================================================================
# 10. group_booking_imports  (migration 0042)
# =====================================================================
class GroupBookingImport(Base):
    """The passenger spreadsheet behind a group booking.

    ``request_id`` is NULL for the window between upload and submission — the
    merchant uploads, reviews the summary, possibly replaces the file, and only
    then raises the booking. See migration 0042 for why that staging window is
    what forced this out of ``travel_details`` and out of ``request_documents``.

    ``imported_passengers`` is what the sheet *said*, frozen at import. The
    ``passenger_data`` rows created at submission remain the source of truth for
    who is travelling; this copy is evidence, not state.
    """

    __tablename__ = "group_booking_imports"

    import_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merchant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE"), nullable=False
    )
    request_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("service_requests.request_id", ondelete="CASCADE")
    )

    #: ``one_way_group`` | ``round_trip_group`` — mirrors ``travel_details``.
    journey_type: Mapped[str] = mapped_column(String(24), nullable=False)

    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Storage key under ``group-imports/``. Never returned to a client.
    stored_path: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    checksum: Mapped[Optional[str]] = mapped_column(String(64))

    imported_passengers: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    #: The journey/booking columns the sheet declared. The booking is still
    #: raised from the form's itinerary — this is what the file claimed, kept so
    #: a disagreement is visible instead of silently resolved.
    imported_journey: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    validation_errors: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )

    total_rows: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    valid_rows: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    invalid_rows: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    passengers_imported: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    validation_status: Mapped[GroupImportStatus] = mapped_column(
        _pg_enum(GroupImportStatus, "group_import_status_enum"),
        nullable=False,
        server_default=text("'pending'"),
    )

    uploaded_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    imported_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    request: Mapped[Optional["ServiceRequest"]] = relationship(
        back_populates="group_import"
    )

    __table_args__ = (
        CheckConstraint("size_bytes > 0", name="ck_group_import_size_positive"),
        CheckConstraint(
            "valid_rows >= 0 AND invalid_rows >= 0 "
            "AND total_rows = valid_rows + invalid_rows",
            name="ck_group_import_row_counts",
        ),
        CheckConstraint(
            "journey_type IN ('one_way_group', 'round_trip_group')",
            name="ck_group_import_journey_type",
        ),
        Index("ix_group_import_merchant", "merchant_id"),
        Index(
            "ix_group_import_request", "request_id",
            postgresql_where=text("request_id IS NOT NULL"),
        ),
        Index(
            "ix_group_import_unattached", "created_at",
            postgresql_where=text("request_id IS NULL"),
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<GroupBookingImport {self.original_filename} "
            f"{self.validation_status.value} req={self.request_id}>"
        )


# =====================================================================
# 11. request_notes
# =====================================================================
class RequestNote(Base):
    """An internal operator note on a booking.

    Staff-only by design — see migration 0032 for why there is no visibility
    column. Nothing in this class enforces that; ``booking_ops_service`` does,
    on every read and write, and no merchant-facing schema references it.
    """

    __tablename__ = "request_notes"

    note_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("service_requests.request_id", ondelete="CASCADE"),
        nullable=False,
    )
    merchant_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE")
    )
    #: SET NULL so an operator leaving does not erase what happened on a booking.
    author_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )

    body: Mapped[str] = mapped_column(Text, nullable=False)
    #: NULL until the note is edited, so "edited" is distinguishable from "new".
    edited_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)

    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    request: Mapped["ServiceRequest"] = relationship(back_populates="notes")

    __table_args__ = (
        CheckConstraint("length(btrim(body)) > 0", name="ck_request_notes_body_not_blank"),
        Index("ix_request_notes_request", "request_id", "note_id"),
        Index("ix_request_notes_merchant", "merchant_id"),
    )

    def __repr__(self) -> str:
        return f"<RequestNote {self.note_id} req={self.request_id}>"


# =====================================================================
# CR-4 — the merchant wallet (migration 0036)
# =====================================================================
class PaymentAccount(Base):
    """A platform account a merchant can send money to: bank, UPI or QR.

    Configured by staff under Account Management (CR-4d) and shown read-only to
    merchants on the Add Money screen. ``details`` is JSONB because a UPI handle
    and a current account share almost no fields, and the set grows every time a
    new payment rail is added.
    """

    __tablename__ = "payment_accounts"

    account_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    account_type: Mapped[PaymentAccountType] = mapped_column(
        _pg_enum(PaymentAccountType, "payment_account_type_enum"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    details: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    #: Storage key, never a URL — served through an authenticated endpoint.
    qr_image_path: Mapped[Optional[str]] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    display_order: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "length(btrim(label)) > 0", name="ck_payment_accounts_label_not_blank"
        ),
        Index("ix_payment_accounts_active", "is_active", "display_order"),
    )

    def __repr__(self) -> str:
        return f"<PaymentAccount {self.account_id} {self.account_type.value} {self.label!r}>"


class WalletTopup(Base):
    """A merchant's claim that it has sent money, awaiting verification.

    Deliberately **not** a ``payments`` row and **not** a ``request_documents``
    row: a top-up belongs to no booking, and ``request_documents.request_id`` is
    NOT NULL, so the proof file has nowhere to live there. Credit only reaches
    the wallet when an admin verifies this, at which point exactly one
    :class:`WalletTransaction` is written and linked back through ``topup_id``.
    """

    __tablename__ = "wallet_topups"

    topup_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    topup_number: Mapped[str] = mapped_column(String(32), nullable=False)
    merchant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE"), nullable=False
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    method: Mapped[WalletTopupMethod] = mapped_column(
        _pg_enum(WalletTopupMethod, "wallet_topup_method_enum"), nullable=False
    )
    payment_account_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("payment_accounts.account_id", ondelete="SET NULL")
    )
    #: Denormalised so a retired account still reads correctly on old top-ups.
    payment_account_label: Mapped[Optional[str]] = mapped_column(String(120))

    utr: Mapped[Optional[str]] = mapped_column(String(64))
    proof_path: Mapped[Optional[str]] = mapped_column(String(500))
    proof_filename: Mapped[Optional[str]] = mapped_column(String(255))
    proof_content_type: Mapped[Optional[str]] = mapped_column(String(100))
    proof_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger)

    status: Mapped[WalletTopupStatus] = mapped_column(
        _pg_enum(WalletTopupStatus, "wallet_topup_status_enum"),
        nullable=False,
        server_default=text("'submitted'"),
    )
    submitted_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    submitted_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    reviewed_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    reviewed_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    review_remarks: Mapped[Optional[str]] = mapped_column(Text)

    # --- Admin-initiated requests (migration 0041) --------------------------
    #: The Admin who raised the request. NULL on every merchant-initiated
    #: top-up, which is what distinguishes the two directions.
    raised_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    #: The merchant's manager who must settle it. Named at creation so the
    #: request lands in one person's queue rather than the company's.
    assigned_manager_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    #: Where to send the money, shaped by ``method`` — bank name/number/IFSC/
    #: branch, cash token/note number, or crypto address/network. Read back
    #: verbatim; never aggregated.
    instructions: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    #: How many times a rejected request has been paid again and resubmitted.
    resubmission_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )

    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("topup_number", name="uq_wallet_topups_number"),
        CheckConstraint("amount > 0", name="ck_wallet_topups_amount_positive"),
        CheckConstraint(
            "jsonb_typeof(instructions) = 'object'",
            name="ck_wallet_topups_instructions_object",
        ),
        CheckConstraint(
            "resubmission_count >= 0",
            name="ck_wallet_topups_resubmissions_non_negative",
        ),
        Index("ix_wallet_topups_merchant", "merchant_id", "topup_id"),
        Index(
            "ix_wallet_topups_assigned",
            "assigned_manager_id", "topup_id",
            postgresql_where=text("assigned_manager_id IS NOT NULL"),
        ),
    )

    @property
    def admin_initiated(self) -> bool:
        """Did the desk ask for this, or did the merchant volunteer it?

        Derived from ``raised_by`` rather than stored as a flag, so the two
        cannot disagree: an Admin raised it exactly when an Admin is recorded
        as having raised it.
        """
        return self.raised_by is not None

    def __repr__(self) -> str:
        return f"<WalletTopup {self.topup_number} {self.amount} {self.status.value}>"


class WalletTransaction(Base):
    """One movement of a merchant's wallet. Append-only, and the source of truth.

    ``merchants.wallet_balance`` is a cache of ``SUM(credit) - SUM(debit)`` over
    this table, kept in step because every write goes through
    ``wallet_service.post`` under a row lock on the merchant. The verification
    script asserts the two agree after every scenario — a cached total that can
    drift from its ledger is precisely the class of bug M4 was written to make
    impossible.

    ``balance_before`` / ``balance_after`` are stored rather than derived so a
    statement line is readable on its own, and the database checks the
    arithmetic on every insert (``ck_wallet_transactions_balance_math``).

    There is no ``updated_at`` and no update path. A wrong entry is corrected by
    posting the opposite entry, the way ledgers have always worked; editing
    history would make every balance before the edit unexplainable.
    """

    __tablename__ = "wallet_transactions"

    txn_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    txn_number: Mapped[str] = mapped_column(String(32), nullable=False)
    merchant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="RESTRICT"), nullable=False
    )
    txn_type: Mapped[WalletTxnType] = mapped_column(
        _pg_enum(WalletTxnType, "wallet_txn_type_enum"), nullable=False
    )

    debit: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, server_default=text("0")
    )
    credit: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, server_default=text("0")
    )
    balance_before: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    balance_after: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)

    request_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("service_requests.request_id", ondelete="SET NULL")
    )
    payment_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("payments.payment_id", ondelete="SET NULL")
    )
    topup_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("wallet_topups.topup_id", ondelete="SET NULL")
    )
    reason: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("txn_number", name="uq_wallet_transactions_number"),
        CheckConstraint("debit >= 0", name="ck_wallet_transactions_debit_non_negative"),
        CheckConstraint("credit >= 0", name="ck_wallet_transactions_credit_non_negative"),
        CheckConstraint(
            "(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)",
            name="ck_wallet_transactions_one_direction",
        ),
        CheckConstraint(
            "balance_after = balance_before + credit - debit",
            name="ck_wallet_transactions_balance_math",
        ),
        Index("ix_wallet_transactions_merchant", "merchant_id", "created_at", "txn_id"),
        Index("ix_wallet_transactions_request", "request_id"),
        Index("ix_wallet_transactions_topup", "topup_id"),
    )

    @property
    def signed_amount(self) -> Decimal:
        """Positive for a credit, negative for a debit."""
        return Decimal(self.credit or 0) - Decimal(self.debit or 0)

    def __repr__(self) -> str:
        return (
            f"<WalletTransaction {self.txn_number} {self.txn_type.value} "
            f"-{self.debit}/+{self.credit} -> {self.balance_after}>"
        )


class Provider(Base):
    """An external supplier the operations desk buys tickets FROM (0039).

    An airline consolidator, a booking portal, a cruise wholesaler. **Not a user
    of this application** — a provider never signs in, and this class carries no
    password, role, permission or session for exactly that reason. The only
    ``users`` references on it are ``created_by`` / ``updated_by``, which record
    which *admin* maintained the row.

    Deliberately NOT a ``Merchant``: a merchant is a customer who signs in and
    owes us money, a provider is a supplier who does neither, and
    ``ServiceRequest.merchant_id`` already means "the customer".

    There is no delete path. A provider that has bookings against it is a
    purchase record; it is retired with ``status = INACTIVE``, and the schema
    backs that up with ``ON DELETE RESTRICT`` from ``service_requests``.
    """

    __tablename__ = "providers"

    provider_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    #: ``PRD001``. Allocated from ``seq_provider_code`` — never typed by hand.
    provider_code: Mapped[str] = mapped_column(String(20), nullable=False)
    provider_name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[ProviderStatus] = mapped_column(
        _pg_enum(ProviderStatus, "provider_status_enum"),
        nullable=False,
        server_default=text("'active'"),
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    updated_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )

    users: Mapped[list["ProviderUser"]] = relationship(
        back_populates="provider",
        cascade="all, delete-orphan",
        order_by="ProviderUser.provider_user_id",
    )

    __table_args__ = (
        Index("uq_providers_code", "provider_code", unique=True),
        Index("ix_providers_status", "status"),
    )

    def __repr__(self) -> str:
        return f"<Provider {self.provider_code} {self.provider_name}>"


class ProviderUser(Base):
    """A named person AT a provider who actually books the tickets (0039).

    "John at Sky Travels". Exists so a booking can record who on the supplier's
    side handled it, and so the desk can see volume per contact.

    **Not an application user.** No password, no username, no role, no
    permission, no session, no OTP — and no foreign key to ``users``. Anything
    that would make this loggable-in is absent on purpose, and adding it would
    take a migration somebody has to justify.

    ``email`` is stored to identify and contact the person, not to authenticate
    them; it is unique per provider rather than globally, because one person may
    legitimately appear under two suppliers.
    """

    __tablename__ = "provider_users"

    provider_user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    provider_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("providers.provider_id", ondelete="CASCADE"),
        nullable=False,
    )
    user_name: Mapped[str] = mapped_column(String(150), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    phone_number: Mapped[Optional[str]] = mapped_column(String(30))
    status: Mapped[ProviderStatus] = mapped_column(
        _pg_enum(ProviderStatus, "provider_status_enum"),
        nullable=False,
        server_default=text("'active'"),
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    provider: Mapped["Provider"] = relationship(back_populates="users")

    __table_args__ = (
        Index("ix_provider_users_provider", "provider_id"),
    )

    def __repr__(self) -> str:
        return f"<ProviderUser {self.user_name} @{self.provider_id}>"


# =====================================================================
# Hotel Enquiry — genuinely separate tables (migration 0047)
# =====================================================================
# Deliberately NOT part of the nine-table service_requests design: the
# earlier Hotel Enquiry pass stored these as travel_type='hotel' rows there
# (matching how Flight already works), but the product spec asked for real,
# independently queryable tables — structured rooms and children, not a
# JSONB array. See 0047's migration docstring for the full reasoning. Status
# reuses RequestStatus/request_status_enum so the same label/tone maps the
# rest of the app already has (ENQUIRY_LABELS, CL_STATUS_TONE, SPEC_LABELS)
# apply here without a hotel-specific translation layer.
class HotelEnquiry(Base):
    """One merchant's request to be quoted a hotel stay."""

    __tablename__ = "hotel_enquiries"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    merchant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("merchants.merchant_id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    enquiry_reference: Mapped[str] = mapped_column(String(40), nullable=False)
    destination_city: Mapped[str] = mapped_column(String(120), nullable=False)
    check_in_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    check_out_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    #: Denormalised at create time — see the migration docstring.
    number_of_nights: Mapped[int] = mapped_column(Integer, nullable=False)
    hotel_name: Mapped[Optional[str]] = mapped_column(String(200))
    #: '3' | '4' | '5' — a CHECK constraint, not a foreign key to a rating
    #: table that would exist to hold three rows.
    star_category: Mapped[str] = mapped_column(String(1), nullable=False)
    room_type: Mapped[Optional[str]] = mapped_column(String(120))
    pan: Mapped[Optional[str]] = mapped_column(String(10))
    meal_plan: Mapped[str] = mapped_column(String(20), nullable=False)
    special_requirements: Mapped[Optional[str]] = mapped_column(Text)
    preferred_location: Mapped[Optional[str]] = mapped_column(String(200))
    status: Mapped[RequestStatus] = mapped_column(
        _pg_enum(RequestStatus, "request_status_enum"),
        nullable=False,
        server_default=text("'pending_approval'"),
    )
    #: CR-5's binding-quotation pattern, carried over unchanged: the fare a
    #: booking raised against this enquiry would be created at, if Hotel ever
    #: grows a booking step. Nothing reads this into a booking today.
    quoted_fare: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    quotation_remarks: Mapped[Optional[str]] = mapped_column(Text)
    #: What the merchant charges its OWN customer (migration 0050) — Hotel's
    #: equivalent of Flight's client_fare on service_requests. Captured once,
    #: here, and carried forward: hotel_booking_service.to_booking_request
    #: prefers a value in its own payload and falls back to this one.
    client_fare: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    admin_response: Mapped[Optional[str]] = mapped_column(Text)
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text)
    review_claimed_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL")
    )
    review_claimed_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    responded_at: Mapped[Optional[dt.datetime]] = mapped_column(_TS)
    #: The service_requests row this enquiry became, once quoted and raised
    #: as a booking (migration 0048). None until then. SET NULL on delete —
    #: a booking being removed must not take the enquiry it came from with
    #: it. At most one booking per enquiry: enforced by a partial unique
    #: index in the DB and re-checked in hotel_booking_service before insert.
    booking_request_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("service_requests.request_id", ondelete="SET NULL")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    merchant: Mapped["Merchant"] = relationship(foreign_keys=[merchant_id])
    user: Mapped[Optional["User"]] = relationship(foreign_keys=[user_id])
    reviewer: Mapped[Optional["User"]] = relationship(foreign_keys=[review_claimed_by])
    booking_request: Mapped[Optional["ServiceRequest"]] = relationship(
        foreign_keys=[booking_request_id]
    )
    rooms: Mapped[list["HotelEnquiryRoom"]] = relationship(
        back_populates="enquiry", cascade="all, delete-orphan",
        order_by="HotelEnquiryRoom.room_number",
    )

    __table_args__ = (
        UniqueConstraint("enquiry_reference", name="uq_hotel_enquiries_reference"),
        CheckConstraint("check_out_date > check_in_date", name="ck_hotel_enq_date_order"),
        CheckConstraint("number_of_nights > 0", name="ck_hotel_enq_nights_positive"),
        CheckConstraint("star_category IN ('3','4','5')", name="ck_hotel_enq_star_category"),
        CheckConstraint(
            "meal_plan IN ('breakfast','half_board','full_board')", name="ck_hotel_enq_meal_plan"
        ),
        Index("ix_hotel_enquiries_merchant", "merchant_id"),
        Index("ix_hotel_enquiries_status", "status"),
        Index("ix_hotel_enquiries_created_at", text("created_at DESC")),
        Index("ix_hotel_enquiries_booking_request", "booking_request_id"),
        Index(
            "uq_hotel_enquiries_booking_request_id", "booking_request_id",
            unique=True, postgresql_where=text("booking_request_id IS NOT NULL"),
        ),
    )

    def __repr__(self) -> str:
        return f"<HotelEnquiry {self.enquiry_reference} {self.destination_city!r}>"


class HotelEnquiryRoom(Base):
    """One room asked about on a hotel enquiry — a merchant may ask for several."""

    __tablename__ = "hotel_enquiry_rooms"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    hotel_enquiry_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("hotel_enquiries.id", ondelete="CASCADE"), nullable=False
    )
    #: 1-based, per enquiry — what "Room 1"/"Room 2" render directly from.
    room_number: Mapped[int] = mapped_column(Integer, nullable=False)
    adults: Mapped[int] = mapped_column(Integer, nullable=False)
    children: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    enquiry: Mapped["HotelEnquiry"] = relationship(back_populates="rooms")
    children_ages: Mapped[list["HotelRoomChild"]] = relationship(
        back_populates="room", cascade="all, delete-orphan", order_by="HotelRoomChild.id"
    )

    __table_args__ = (
        UniqueConstraint("hotel_enquiry_id", "room_number", name="uq_hotel_room_number"),
        CheckConstraint("adults >= 1", name="ck_hotel_room_adults_positive"),
        CheckConstraint("children >= 0", name="ck_hotel_room_children_non_negative"),
        Index("ix_hotel_enquiry_rooms_enquiry", "hotel_enquiry_id"),
    )


class HotelRoomChild(Base):
    """One child's age, within one room, on a hotel enquiry."""

    __tablename__ = "hotel_room_children"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    room_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("hotel_enquiry_rooms.id", ondelete="CASCADE"), nullable=False
    )
    child_age: Mapped[int] = mapped_column(SmallInteger, nullable=False)

    room: Mapped["HotelEnquiryRoom"] = relationship(back_populates="children_ages")

    __table_args__ = (
        CheckConstraint("child_age BETWEEN 0 AND 17", name="ck_hotel_room_child_age_range"),
        Index("ix_hotel_room_children_room", "room_id"),
    )


# =====================================================================
# Hotel Booking Guests (migration 0048)
# =====================================================================
# A booking-stage table, not an enquiry-stage one: it hangs off the
# service_requests row a hotel booking becomes (see ServiceRequest.hotel_guests
# and hotel_booking_service.to_booking_request), not off HotelEnquiry. Kept
# separate from PassengerData because a hotel guest's shape (room number,
# id-proof) doesn't fit PassengerData's flight-shaped columns (seat
# preference, passport fields, airline meal preference) — see 0048's
# migration docstring for the full reasoning.
class HotelBookingGuest(Base):
    """One guest on a hotel booking, tied to the room they're staying in."""

    __tablename__ = "hotel_booking_guests"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    booking_request_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("service_requests.request_id", ondelete="CASCADE"), nullable=False
    )
    #: Mirrors hotel_enquiry_rooms.room_number — which room (within the
    #: booking) this guest belongs to.
    room_number: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Exactly one lead guest per booking is app-enforced only (the
    #: guest-capture screen only ever offers one lead-guest choice) — not a
    #: DB constraint, same posture as other soft invariants in this schema.
    is_lead_guest: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    title: Mapped[Optional[str]] = mapped_column(String(10))
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    #: Reuses PassengerType/passenger_type_enum — a hotel guest is either
    #: kind exactly the way a flight passenger is.
    guest_type: Mapped[PassengerType] = mapped_column(
        _pg_enum(PassengerType, "passenger_type_enum"),
        nullable=False,
        server_default=text("'adult'"),
    )
    #: Child guests only — mirrors hotel_room_children.child_age.
    age: Mapped[Optional[int]] = mapped_column(SmallInteger)
    id_proof_type: Mapped[Optional[str]] = mapped_column(String(40))
    id_proof_number: Mapped[Optional[str]] = mapped_column(String(60))
    created_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        _TS, nullable=False, server_default=func.now()
    )

    booking_request: Mapped["ServiceRequest"] = relationship(back_populates="hotel_guests")

    __table_args__ = (
        CheckConstraint("age IS NULL OR age BETWEEN 0 AND 17", name="ck_hotel_guest_age_range"),
        CheckConstraint("room_number > 0", name="ck_hotel_guest_room_number_positive"),
        Index("ix_hotel_booking_guests_request", "booking_request_id"),
    )

    def __repr__(self) -> str:
        return f"<HotelBookingGuest {self.first_name} {self.last_name} room={self.room_number}>"


__all__ = [
    "Base",
    "User",
    "Merchant",
    "ServiceRequest",
    "Payment",
    "PassengerData",
    "CommunicationSettings",
    "MsgLog",
    "SystemLog",
    "AuditLog",
    "UserRole",
    "UserStatus",
    "MerchantStatus",
    "MerchantRole",
    "CompanyType",
    "RequestType",
    "RequestStatus",
    "Priority",
    "TravelType",
    "PaymentType",
    "PaymentStatus",
    "Gender",
    "PassengerType",
    "SeatPreference",
    "OtpPurpose",
    "MessageType",
    "MessageStatus",
    "AuditOperation",
    "RequestDocument",
    "RequestNote",
    "DocumentType",
    "DocumentVerification",
    "WalletTransaction",
    "WalletTopup",
    "PaymentAccount",
    "WalletTxnType",
    "WalletTopupStatus",
    "WalletTopupMethod",
    "PaymentAccountType",
    "Provider",
    "ProviderUser",
    "ProviderStatus",
    "HotelEnquiry",
    "HotelEnquiryRoom",
    "HotelRoomChild",
    "HotelBookingGuest",
]
