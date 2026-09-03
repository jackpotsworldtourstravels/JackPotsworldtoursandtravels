"""Request/response schemas for the customer tour-package booking flow.

Same rule as ``customer_booking.py`` and ``customer_hotel_booking.py``:
request schemas never carry money. The client names a package, a departure
and a party; the server prices it in ``customer_package_pricing_service``.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

TRAVELLER_TYPES = ("adult", "child", "infant")


class DepartureOption(BaseModel):
    """One group-departure date, as the Departure step lists it."""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(validation_alias="customer_package_departure_id")
    date: dt.date = Field(validation_alias="departure_date")
    price: Decimal = Field(validation_alias="price_per_person")
    seats_left: int


class PackageSearchResult(BaseModel):
    """A row on the Tour Packages grid — the shape ``normalisePackage()`` reads."""

    model_config = ConfigDict(from_attributes=True)

    id: str = Field(validation_alias="customer_package_id")
    name: str
    days: int
    priceFrom: Decimal = Field(validation_alias="price_from")
    blurb: str
    is_international: bool

    @field_validator("id", mode="before")
    @classmethod
    def _stringify(cls, v):
        return str(v)


class PackageDetail(BaseModel):
    """Everything the package's own detail view shows: description,
    inclusions, policy, and every upcoming departure."""

    model_config = ConfigDict(from_attributes=True)

    id: str = Field(validation_alias="customer_package_id")
    name: str
    blurb: str
    description: str | None
    days: int
    priceFrom: Decimal = Field(validation_alias="price_from")
    is_international: bool
    inclusions: list[str]
    cancellation_policy: str | None
    departures: list[DepartureOption]

    @field_validator("id", mode="before")
    @classmethod
    def _stringify(cls, v):
        return str(v)


class PackageAddonItem(BaseModel):
    code: str
    name: str
    price: Decimal
    description: str | None = None
    per: str = "booking"
    group: str


class TravellerInput(BaseModel):
    """A person going on the trip. Passport is optional here even for an
    international package — required-ness is enforced at booking time,
    where the destination is known, same as a flight (0053)."""

    traveller_type: str = "adult"
    title: str | None = Field(default=None, max_length=10)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    gender: str | None = Field(default=None, max_length=20)
    date_of_birth: dt.date | None = None
    nationality: str | None = Field(default=None, max_length=100)
    passport_number: str | None = Field(default=None, max_length=40)
    passport_expiry: dt.date | None = None
    issuing_country: str | None = Field(default=None, max_length=100)
    is_contact: bool = False
    mobile: str | None = None
    email: EmailStr | None = None

    @field_validator("traveller_type")
    @classmethod
    def _kind(cls, v: str) -> str:
        v = (v or "adult").lower()
        if v not in TRAVELLER_TYPES:
            raise ValueError(f"Traveller type must be one of {', '.join(TRAVELLER_TYPES)}")
        return v


class PackageAddonSelection(BaseModel):
    code: str = Field(min_length=1, max_length=40)
    #: NULL means the whole booking; an index means just that traveller
    #: (travel insurance is sold per traveller, same as a flight add-on can be).
    traveller_index: int | None = Field(default=None, ge=0)


class TripInput(BaseModel):
    package_id: int = Field(gt=0)
    departure_id: int = Field(gt=0)
    pax_count: int = Field(default=1, ge=1, le=12)


class PackageQuoteRequest(BaseModel):
    trip: TripInput
    addons: list[PackageAddonSelection] = Field(default_factory=list)
    coupon_code: str | None = Field(default=None, max_length=40)


class FareLine(BaseModel):
    label: str
    amount: Decimal


class PackageQuoteResponse(BaseModel):
    currency: str
    base_total: Decimal
    taxes: Decimal
    addon_total: Decimal
    discount: Decimal
    total_amount: Decimal
    coupon_code: str | None = None
    coupon_title: str | None = None
    coupon_error: str | None = None
    lines: list[FareLine]


class PackageBookingCreate(BaseModel):
    trip: TripInput
    travellers: list[TravellerInput] = Field(min_length=1, max_length=12)
    addons: list[PackageAddonSelection] = Field(default_factory=list)
    coupon_code: str | None = Field(default=None, max_length=40)
    #: Identifies ONE submission. Send the same key when retrying and the
    #: server returns the booking it already made rather than making another
    #: (migration 0061). Optional, so existing callers are unaffected.
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=64)


class PackageBookingTravellerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    traveller_index: int
    traveller_type: str
    title: str | None
    first_name: str
    last_name: str
    gender: str | None
    date_of_birth: dt.date | None
    nationality: str | None
    passport_number: str | None
    passport_expiry: dt.date | None
    issuing_country: str | None
    is_contact: bool
    mobile: str | None
    email: str | None


class PackageBookingAddonResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    addon_type: str
    code: str
    name: str
    description: str | None
    unit_price: Decimal
    quantity: int
    traveller_index: int | None


class PackageBookingPaymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    method: str
    status: str
    amount: Decimal
    currency: str
    provider: str | None
    provider_reference: str | None
    created_at: dt.datetime


class PackageBookingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    booking_ref: str
    product_type: str = "package"
    status: str

    package_id: int
    package_name: str
    package_days: int
    is_international: bool
    departure_id: int
    departure_date: dt.date
    pax_count: int

    base_total: Decimal
    taxes: Decimal
    addon_total: Decimal
    discount: Decimal
    total_amount: Decimal
    currency: str
    coupon_code: str | None

    cancelled_at: dt.datetime | None
    created_at: dt.datetime

    travellers: list[PackageBookingTravellerResponse] = []
    addons: list[PackageBookingAddonResponse] = []
    payments: list[PackageBookingPaymentResponse] = []


class PackagePaymentRequest(BaseModel):
    method: str = Field(min_length=1, max_length=30)


# ---------------------------------------------------------------------------
# Opening a provider checkout (Phase 3)
# ---------------------------------------------------------------------------
class PackageCheckoutRequest(BaseModel):
    """What the browser sends to start a payment.

    NOTE WHAT IS NOT HERE: no amount, no currency, no customer id, no package
    price, no payment status. There is deliberately no field for any of them,
    so a client cannot send one and no handler can accidentally read one. The
    booking reference in the URL plus the session identify everything else, and
    every rupee comes off the booking row the server priced.

    THE KEY IS THE CLIENT'S, ON PURPOSE. It identifies one submission, so a
    double-click, a reload or a retried request after a timeout all carry the
    same value and resolve to the same order. A server-generated key would be
    new on every request, which is exactly what must not happen.
    """

    idempotency_key: str = Field(min_length=8, max_length=64)


class PackageCheckoutResponse(BaseModel):
    """Everything the browser needs to open the checkout, and nothing else.

    THERE IS NO FIELD HERE THAT COULD CARRY A SECRET.
    ``key_id`` is the publishable key the provider's own script requires and is
    meant to be public. The API key secret and the webhook secret are never
    serialised into this model, and the model is the only shape this endpoint
    can return.
    """

    #: Which adapter opened it, so the client picks the right renderer.
    provider: str
    #: The provider's order id. The client passes it back to the widget.
    order_id: str
    #: Minor units, as the PROVIDER reported them — not as we computed them.
    #: The two are compared server-side before this is returned, so a mismatch
    #: is an error rather than something the browser gets a chance to see.
    amount: int
    currency: str
    #: Publishable only. Never the secret.
    key_id: str
    #: Our own reference, echoed for display.
    booking_ref: str
    #: Display detail and prefill for the widget. Non-secret by construction.
    options: dict = Field(default_factory=dict)
    #: Where the payment stands locally. Always "pending" from this endpoint:
    #: opening a checkout takes no money, and only the verified webhook path
    #: may report anything else.
    payment_status: str


class PackageReconcileRequest(BaseModel):
    """What the browser may offer when its checkout handler fires.

    EVERY FIELD IS OPTIONAL, AND NONE OF THEM DECIDES ANYTHING.
    The endpoint re-reads the payment from the provider over an authenticated
    channel and compares it against the booking row; that read is what settles
    the payment. These three values only let the server check the handler's
    signature as corroboration, and a request with none of them reconciles
    exactly the same way -- which is what makes the endpoint useful to a
    customer who reloaded the page and no longer has them.

    THERE IS STILL NO AMOUNT FIELD, for the same reason there is none on
    ``PackageCheckoutRequest``: nothing a browser says about money is read.
    """

    #: Razorpay's ``razorpay_payment_id`` from the handler callback.
    provider_payment_id: str | None = Field(default=None, max_length=120)
    #: ``razorpay_order_id``. Compared against the order WE stored, never
    #: substituted for it -- see the note on ``verify_checkout_signature``.
    provider_order_id: str | None = Field(default=None, max_length=120)
    #: ``razorpay_signature``. Corroboration only; never sufficient on its own.
    signature: str | None = Field(default=None, max_length=256)


class PackageReconcileResponse(BaseModel):
    """Where the payment and the booking actually stand, after asking.

    ``booking_status`` is the field the UI acts on. ``code`` is the verifier's
    own word for what happened and is carried through for support and for the
    test suite -- it is not something a screen should try to render.
    """

    booking_ref: str
    #: pending | confirmed | cancelled | completed -- the booking row's status.
    booking_status: str
    #: The local payment status: pending, captured, failed, refunded, ...
    payment_status: str | None = None
    #: True only when THIS call moved the payment to captured. A repeat answers
    #: false with payment_status still "captured", so a client cannot count
    #: captures by counting successes.
    captured: bool = False
    #: The verifier's disposition code, e.g. "captured", "already_captured",
    #: "not_yet_paid", "no_provider_reference", "provider_timeout".
    code: str
    #: Whether asking again could still change the answer. False once the
    #: payment is settled either way, so a poller knows to stop.
    retryable: bool = False
