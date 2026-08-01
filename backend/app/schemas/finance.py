"""Finance schemas (M4).

Every money field is ``Decimal``. Pydantic will happily coerce a float into one
and reintroduce the rounding error the service layer was careful to avoid, so
nothing here is typed ``float`` — not even the ones that "can't" have fractions.
"""
import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field


class BookingPosition(BaseModel):
    """What one booking owes and has paid."""

    request_id: int
    request_number: str
    status: str
    currency: str = "INR"
    billed: Decimal
    paid: Decimal
    refunded: Decimal
    net_paid: Decimal
    awaiting_verification: Decimal
    #: Negative when the merchant has overpaid — deliberately not clamped, so an
    #: overpayment is visible rather than rounded away to "settled".
    balance_due: Decimal
    is_settled: bool


class MerchantPosition(BaseModel):
    """One merchant's whole financial position."""

    merchant_id: int
    merchant_name: str
    currency: str = "INR"
    bookings_billable: int
    billed: Decimal
    paid: Decimal
    refunded: Decimal
    net_paid: Decimal
    awaiting_verification: Decimal
    outstanding: Decimal
    overpaid: Decimal
    wallet_balance: Decimal
    credit_limit: Decimal
    credit_used: Decimal
    #: ``None`` when no limit is configured. A number here would be a ceiling
    #: nobody set — see ``finance_service.has_credit_limit``.
    credit_available: Decimal | None = None
    has_credit_limit: bool
    spending_power: Decimal


class StatementEntry(BaseModel):
    at: datetime.datetime | None = None
    kind: str
    reference: str
    request_id: int | None = None
    description: str
    debit: Decimal
    credit: Decimal
    balance: Decimal
    wallet_movement: Decimal = Decimal("0.00")
    unverified: Decimal = Decimal("0.00")


class Statement(BaseModel):
    merchant_id: int
    merchant_name: str
    currency: str = "INR"
    date_from: datetime.date | None = None
    date_to: datetime.date | None = None
    opening_balance: Decimal
    closing_balance: Decimal
    total_debits: Decimal
    total_credits: Decimal
    entries: list[StatementEntry]
    position: MerchantPosition


class WalletAdjustment(BaseModel):
    """A deliberate move on a merchant's wallet.

    ``amount`` is signed: positive tops up, negative takes back. A reason is
    mandatory in both directions — a wallet movement nobody can explain is the
    thing that makes a ledger untrustworthy.
    """

    amount: Decimal = Field(description="Positive to credit the wallet, negative to debit it")
    reason: str = Field(min_length=3, max_length=500)
    #: CR-4b. What kind of movement this is, so the ledger says *why* rather
    #: than filing everything as an adjustment. Optional and defaulted, so an
    #: existing caller keeps its existing behaviour exactly.
    #:
    #: A credit note is not a refund: it is a commercial credit that reverses no
    #: particular payment, which is why it is its own type on the statement.
    #: ``booking_debit`` is deliberately **not** accepted here — that type is
    #: written only by ticket issuance, and letting it be posted by hand would
    #: put a second, unindexed path around the one-debit-per-booking guarantee.
    txn_type: Literal[
        "manual_adjustment", "credit_note", "refund_credit", "cancellation_charge"
    ] | None = Field(
        default=None,
        description="Ledger transaction type; defaults to wallet_recharge on a "
                    "credit and manual_adjustment on a debit.",
    )


class WalletAdjustmentResult(BaseModel):
    merchant_id: int
    payment_id: int
    amount: Decimal
    wallet_balance: Decimal
    position: MerchantPosition
    #: CR-4b. The ledger reference for this movement — quote this, never an id.
    transaction_reference: str | None = None
