"""What the admin desk is allowed to see about a customer's payment.

THIS IS AN ALLOW-LIST, NOT A DUMP OF THE ROW.
Every field below was chosen; nothing is serialised because it happened to be
on the model. That is the difference between a screen that shows what a desk
needs and one that leaks whatever the next migration adds — and this is a
payment, so the second kind is expensive.

WHAT IS DELIBERATELY ABSENT
No key secret, no webhook secret and no API credential, because none of those
are on these tables at all — they live in ``settings`` and are never
serialised. Also absent, and these ARE on the rows or reachable from them:

  * the customer's mobile and full address — a payments desk resolving a
    failed capture does not need them, and the customer's own detail screens
    already exist for staff who do
  * the raw provider event payload — kept for reconciliation on
    ``payment_provider_events``, not surfaced per payment
  * anything from ``passenger_data``/traveller rows — passport numbers have no
    business on a payment screen

THE CUSTOMER'S EMAIL IS INCLUDED, and that is a judgement rather than an
oversight: it is how a desk identifies which of two people called Sharma made
the payment, and it is already on every other admin booking screen.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class CustomerPaymentRow(BaseModel):
    """One B2C payment, as the list renders it."""

    model_config = ConfigDict(from_attributes=True)

    #: OUR primary key on the B2C payment table — never a provider id.
    payment_id: int
    #: Which B2C product this belongs to: package | hotel | flight. Present so
    #: the screen can never confuse a customer's payment with a merchant's:
    #: the B2B ``payments`` table is not reachable from this endpoint at all.
    product: str

    booking_ref: str
    booking_status: str

    customer_id: int
    customer_name: str
    customer_email: str

    package_name: str | None = None
    travel_date: dt.date | None = None

    #: The booking's own total — what the customer agreed to pay.
    booking_amount: Decimal
    #: What this payment attempt is for. Equal to the booking total in every
    #: normal case; shown separately because a disagreement between the two is
    #: exactly what a desk is looking for.
    amount: Decimal
    currency: str

    #: OUR vocabulary, unchanged from the database: pending / processing /
    #: authorized / captured / failed / cancelled / expired / refunded.
    #: ``captured`` is NOT renamed — the UI labels it "Paid" for a reader.
    status: str
    #: The provider's own word, verbatim, beside ours.
    provider_status: str | None = None

    method: str | None = None
    provider: str | None = None
    provider_order_id: str | None = None
    provider_payment_id: str | None = None

    failure_reason: str | None = None
    paid_at: dt.datetime | None = None
    created_at: dt.datetime
    updated_at: dt.datetime | None = None


class ProviderEventRow(BaseModel):
    """One webhook delivery, as the detail panel renders it.

    THE PAYLOAD IS NOT INCLUDED. It is stored redacted already, but a desk
    resolving a payment needs to know *what arrived and what happened to it*,
    not to read a provider's JSON. Anyone who genuinely needs the body has
    database access; this screen does not hand it to everyone with
    ``payment.verify``.
    """

    model_config = ConfigDict(from_attributes=True)

    event_id: int = Field(validation_alias="payment_provider_event_id")
    provider: str
    provider_event_id: str
    event_type: str
    #: received | processed | deferred | ignored | failed — the retry state a
    #: desk needs: ``deferred`` means the sweep will come back for it.
    processing_status: str
    processing_note: str | None = None
    received_at: dt.datetime
    processed_at: dt.datetime | None = None


class CustomerPaymentDetail(CustomerPaymentRow):
    """One payment, with its provider events."""

    events: list[ProviderEventRow] = Field(default_factory=list)


class CustomerPaymentList(BaseModel):
    items: list[CustomerPaymentRow]
    total: int
    page: int
    page_size: int


class CustomerPaymentCounts(BaseModel):
    """Row counts per status, for the filter tabs."""

    total: int
    by_status: dict[str, int]
    #: Deliveries still waiting on verification. Not a payment status — it is
    #: an event state — but it is the one number a desk wants to see, because
    #: a non-zero value means money may have moved and not yet been confirmed.
    deferred_events: int
