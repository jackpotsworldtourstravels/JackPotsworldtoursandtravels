"""Staff-side wallet schemas (CR-4d).

Every money field is ``Decimal`` and reaches the browser as a decimal **string**
— `docs/WALLET_ARCHITECTURE.md` §2.4. Nothing here is typed ``float``, including
figures that "cannot" have fractions.

``TopupOut`` and ``PaymentAccountOut`` are **reused from `schemas/wallet.py`**
rather than redefined: the desk and the merchant look at the same claim, and two
shapes for one row is how a field ends up meaning different things on two
screens. Only the staff-only additions live here.
"""
import datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.wallet import PaymentAccountOut, TopupOut


# ---------------------------------------------------------------------------
# Payment accounts
# ---------------------------------------------------------------------------
class PaymentAccountAdminOut(PaymentAccountOut):
    """What staff see that a merchant does not."""

    is_active: bool
    created_at: datetime.datetime
    updated_at: datetime.datetime


class CreatePaymentAccount(BaseModel):
    account_type: Literal["bank", "upi", "qr"]
    label: str = Field(min_length=1, max_length=120)
    #: Rail-specific fields; anything not in the rail's allowlist is dropped by
    #: ``payment_admin_service.ACCOUNT_FIELDS`` rather than stored and rendered.
    details: dict[str, Any] = Field(default_factory=dict)
    #: A QR account has no image at creation time, so it may be created
    #: inactive, have its image uploaded, then be switched on.
    is_active: bool = True
    display_order: int = 0


class UpdatePaymentAccount(BaseModel):
    """Partial — an omitted field is left alone, not cleared."""

    label: str | None = Field(default=None, min_length=1, max_length=120)
    details: dict[str, Any] | None = None
    is_active: bool | None = None
    display_order: int | None = None


# ---------------------------------------------------------------------------
# The verification queue
# ---------------------------------------------------------------------------
class TopupQueueRow(TopupOut):
    """A queue row: the claim, plus who it is from."""

    merchant_id: int
    merchant_name: str | None = None


class TopupQueuePage(BaseModel):
    items: list[TopupQueueRow]
    total: int
    page: int
    page_size: int


class TopupQueueCounts(BaseModel):
    #: Raised by the desk, not yet paid (0041). Its own badge and never folded
    #: into ``pending`` — these wait on the merchant, not on us.
    requests: int = 0
    pending: int = 0
    verified: int = 0
    rejected: int = 0
    all: int = 0
    #: The money sitting in the queue awaiting a decision. Reported so the desk
    #: can see the size of what is waiting, never added to any balance.
    pending_amount: Decimal = Decimal("0.00")


class TopupDetail(BaseModel):
    topup: TopupQueueRow
    #: The merchant's balance *now* — before this claim is decided, so the desk
    #: sees what it is about to change rather than what it changed.
    wallet_balance: Decimal
    transaction_reference: str | None = None


class VerifyTopupRequest(BaseModel):
    remarks: str | None = Field(default=None, max_length=500)


class RejectTopupRequest(BaseModel):
    #: Mandatory. The merchant believes it has paid us; "rejected" with no reason
    #: produces a phone call and an identical resubmission.
    remarks: str = Field(min_length=3, max_length=500)


class TopupDecisionResult(BaseModel):
    topup: TopupQueueRow
    #: Present on a verification, absent on a rejection — a rejection moves no
    #: money and therefore has no ledger entry to name.
    transaction_reference: str | None = None
    wallet_balance_before: Decimal | None = None
    wallet_balance_after: Decimal | None = None


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------
class ReconciliationRow(BaseModel):
    merchant_id: int
    merchant_name: str
    wallet_balance: Decimal
    #: Recomputed from the ledger. Must equal ``wallet_balance``.
    ledger_balance: Decimal
    #: The difference. **Zero for every merchant, always** — a non-zero value
    #: here is an incident, not a report. Invariant #1, §7.
    drift: Decimal
    reconciled: bool
    total_credits: Decimal
    total_debits: Decimal
    transaction_count: int
    #: What the merchant owes: the negative balance, floored at zero.
    outstanding: Decimal
    credit_limit: Decimal
    #: Beside the balance, never inside it — money claimed is not money received.
    pending_topup_amount: Decimal
    pending_topup_count: int


class ReconciliationReport(BaseModel):
    generated_at: datetime.datetime
    currency: str = "INR"
    merchants: list[ReconciliationRow]
    merchant_count: int
    drifted_merchant_count: int
    reconciled: bool
    total_wallet_balance: Decimal
    total_credits: Decimal
    total_debits: Decimal
    total_pending_amount: Decimal
    total_outstanding: Decimal


class MerchantLedgerPage(BaseModel):
    merchant_id: int
    merchant_name: str
    wallet_balance: Decimal
    items: list[Any]
    total: int
    page: int
    page_size: int


# ---------------------------------------------------------------------------
# Requests the desk raises (migration 0041)
# ---------------------------------------------------------------------------
class MerchantManagerOut(BaseModel):
    """A merchant's own manager — who a payment request may be addressed to.

    Deliberately thin. This populates one dropdown, and the desk raising a
    payment request has no business reading a merchant employee's full profile.
    """

    user_id: int
    full_name: str
    email: str
    phone: str | None = None


class RaisePaymentRequest(BaseModel):
    merchant_id: int
    #: Re-validated server-side against ``merchant_id``. The browser choosing
    #: from a filtered dropdown is a convenience, not the security boundary.
    manager_id: int
    amount: Decimal = Field(gt=0)
    method: Literal["bank_transfer", "cash", "crypto"]
    #: Method-specific, and required — bank: name/account_number/ifsc/branch;
    #: cash: token_details/note_number; crypto: wallet_address/network.
    #: ``payment_admin_service.REQUEST_METHODS`` is the allowlist; unknown keys
    #: are dropped rather than stored, because this is rendered verbatim on the
    #: manager's screen.
    instructions: dict[str, Any] = Field(default_factory=dict)
    note: str | None = Field(default=None, max_length=500)


class CancelPaymentRequest(BaseModel):
    #: Mandatory. The merchant sees this, and a request that vanishes without a
    #: reason produces the same phone call a bare rejection does.
    remarks: str = Field(min_length=3, max_length=500)


class SettlePaymentRequest(BaseModel):
    """The manager's side, when no file is attached.

    The real submission is multipart — a payment proof is a file — so this
    exists for the bank-transfer case where a UTR alone is being corrected on a
    request that already carries its slip.
    """

    utr: str | None = Field(default=None, max_length=64)
