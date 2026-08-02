"""Merchant wallet schemas (CR-4c).

Same rule as ``schemas/finance.py`` and for the same reason: **every money field
is ``Decimal``**, never ``float``. Pydantic will coerce a float into a Decimal
without complaint and hand back the rounding error the service layer went to
some trouble to avoid, so the type is the guard.

WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
No field here is computed by adding up another field. The wallet summary comes
from ``wallet_service`` and ``finance_service``, which are the single money
computation; a schema that summed a column would be a second opinion about a
merchant's money, which is the class of bug M4 exists to prevent.
"""
import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Reading the wallet
# ---------------------------------------------------------------------------
class WalletSummary(BaseModel):
    """The figures the wallet screen shows above its ledger.

    ``balance`` may be **negative** — that is the whole point of CR-4, and it is
    not clamped. ``outstanding`` is the same number said the way a person says
    it (10,000 owed, not a balance of -10,000) and *is* floored at zero, because
    a merchant in credit owes nothing rather than a negative amount.
    """

    merchant_id: int
    merchant_name: str
    currency: str = "INR"

    balance: Decimal
    outstanding: Decimal
    credit_limit: Decimal
    #: ``None`` when no limit is configured — a number here would be a ceiling
    #: nobody set. ``credit_limit = 0`` means *unlimited*, per M4.
    credit_available: Decimal | None = None
    has_credit_limit: bool

    total_credits: Decimal
    total_debits: Decimal
    transaction_count: int
    last_transaction_at: datetime.datetime | None = None

    #: Money the merchant says it has sent that no admin has verified yet. It is
    #: reported separately and is **not** added to the balance: crediting an
    #: unverified claim would let a merchant top itself up by typing a number.
    pending_topups: Decimal = Decimal("0.00")
    pending_topup_count: int = 0

    #: True when the merchant is at or past its configured limit, so the screen
    #: can warn without re-deriving the rule the server already applied.
    is_over_limit: bool = False
    #: True when a limit is configured and less than 20% of it remains.
    is_low_balance: bool = False


class WalletTransactionOut(BaseModel):
    """One ledger line, exactly as stored. Nothing here is recomputed."""

    txn_id: int
    #: The reference to quote — never ``txn_id``. See WALLET_ARCHITECTURE §2.5.
    txn_number: str
    txn_type: str
    debit: Decimal
    credit: Decimal
    balance_before: Decimal
    #: The running balance, **server-computed and stored at the time of the
    #: movement**. The screen renders it; it never accumulates its own.
    balance_after: Decimal
    reason: str | None = None
    request_id: int | None = None
    request_number: str | None = None
    topup_id: int | None = None
    created_at: datetime.datetime


class WalletTransactionPage(BaseModel):
    items: list[WalletTransactionOut]
    total: int
    page: int
    page_size: int


# ---------------------------------------------------------------------------
# Where to send money
# ---------------------------------------------------------------------------
class PaymentAccountOut(BaseModel):
    """A platform account, as shown to a merchant. Read-only on this side.

    ``details`` is passed through as stored: a UPI handle and a current account
    share almost no fields, and the set grows whenever a new rail is added, so
    the screen renders whatever key/value pairs are there rather than this
    schema fixing a shape that will be wrong next quarter.
    """

    account_id: int
    account_type: Literal["bank", "upi", "qr"]
    label: str
    details: dict[str, Any] = Field(default_factory=dict)
    #: True when a QR image is stored. The image itself is served from an
    #: authenticated endpoint — never a public URL, and never a path.
    has_qr_image: bool = False
    display_order: int = 0


# ---------------------------------------------------------------------------
# Claiming a payment
# ---------------------------------------------------------------------------
class TopupOut(BaseModel):
    """A merchant's claim that it has sent money, and where it got to."""

    topup_id: int
    #: ``PAY-…``, the reference to quote in support conversations.
    topup_number: str
    amount: Decimal
    method: str
    payment_account_id: int | None = None
    #: Denormalised at submission, so a retired account still reads correctly
    #: on an old top-up rather than showing a blank.
    payment_account_label: str | None = None
    utr: str | None = None
    has_proof: bool = False
    proof_filename: str | None = None
    #: ``awaiting_payment`` was added by migration 0041 for requests the desk
    #: raises. Widening a response Literal is safe for existing clients — they
    #: read this as a string — and it is *required*, because Pydantic refuses to
    #: serialise a value the Literal does not list.
    status: Literal["awaiting_payment", "submitted", "verified", "rejected"]
    submitted_at: datetime.datetime
    reviewed_at: datetime.datetime | None = None
    review_remarks: str | None = None
    #: Set once verified — the ledger entry this top-up became.
    wallet_txn_number: str | None = None

    # --- Admin-initiated requests (0041). Defaulted, so every existing caller
    # and every merchant-initiated row is unaffected.
    #: True when the payments desk raised this, false when the merchant did.
    admin_initiated: bool = False
    #: Where to send the money, shaped by ``method``. Empty on a merchant's own
    #: top-up, which was paid into a listed account instead.
    instructions: dict[str, Any] = Field(default_factory=dict)
    assigned_manager_id: int | None = None
    assigned_manager_name: str | None = None
    raised_by_name: str | None = None
    #: How many times a rejected request has been paid again and resubmitted.
    resubmission_count: int = 0


class TopupPage(BaseModel):
    items: list[TopupOut]
    total: int
    page: int
    page_size: int
