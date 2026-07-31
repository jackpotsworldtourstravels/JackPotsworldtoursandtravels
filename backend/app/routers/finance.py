"""Finance — merchant position, statement, and wallet management (M4).

Every figure served here comes from ``finance_service``. No endpoint in this
file does arithmetic of its own; that is the point of the milestone, and a
``sum()`` appearing below would defeat it.

PERMISSIONS — NO NEW CODES
The roadmap's convention is that new behaviour reuses an existing code unless
the capability is genuinely new, and reading your own money is not a new
capability:

    payment.view     merchant reads its own position/statement; staff read any
    payment.manage   staff move a wallet (admin-only in the matrix)

Cross-tenant reads go through ``assert_same_merchant``, which 404s rather than
403s so a merchant cannot use this API to discover that another company exists.
"""
import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.rbac import P, assert_same_merchant, require
from app.database.session import get_db
from app.models_v2 import Merchant, PaymentType, User
from app.schemas.finance import (
    MerchantPosition,
    Statement,
    WalletAdjustment,
    WalletAdjustmentResult,
)
from app.services import activity_service, finance_service

router = APIRouter(prefix="/api", tags=["finance"])


def _own_merchant(db: Session, user: User) -> Merchant:
    """The calling merchant's own company, or a 400 for a staff account.

    Platform staff have no merchant of their own, so they are told to use the
    admin-scoped route rather than being handed an arbitrary one.
    """
    if not user.merchant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "This account is not attached to a merchant. Use "
                "/api/admin/merchants/{merchant_id}/finance to read a specific one."
            ),
        )
    merchant = db.get(Merchant, user.merchant_id)
    if merchant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return merchant


def _scoped_merchant(db: Session, user: User, merchant_id: int) -> Merchant:
    assert_same_merchant(user, merchant_id)
    merchant = db.get(Merchant, merchant_id)
    if merchant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return merchant


# ---------------------------------------------------------------------------
# Merchant's own money
# ---------------------------------------------------------------------------
@router.get(
    "/merchant/finance/position",
    response_model=MerchantPosition,
    summary="The calling merchant's financial position",
    description=(
        "Requires `payment.view`. Billed, paid, refunded, outstanding, wallet and credit "
        "headroom — the single computation every finance surface reads. `credit_available` is "
        "null when no credit limit is configured, which is not the same as a limit of zero."
    ),
)
def my_position(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    return finance_service.merchant_position(db, _own_merchant(db, current_user))


@router.get(
    "/merchant/finance/statement",
    response_model=Statement,
    summary="The calling merchant's statement / ledger",
    description=(
        "Requires `payment.view`. Charges, payments and refunds oldest-first with a running "
        "balance. Charges are dated by approval — the moment a booking became a commitment — "
        "not by when its draft was created."
    ),
)
def my_statement(
    date_from: datetime.date | None = Query(default=None),
    date_to: datetime.date | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    return finance_service.statement(
        db, _own_merchant(db, current_user), date_from=date_from, date_to=date_to
    )


# ---------------------------------------------------------------------------
# Staff view of a specific merchant
# ---------------------------------------------------------------------------
@router.get(
    "/admin/merchants/{merchant_id}/finance",
    response_model=MerchantPosition,
    summary="One merchant's financial position",
    description=(
        "Requires `payment.view`. Platform staff may read any merchant; a merchant account "
        "reaching for another company's id gets 404, not 403."
    ),
)
def merchant_finance(
    merchant_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    return finance_service.merchant_position(db, _scoped_merchant(db, current_user, merchant_id))


@router.get(
    "/admin/merchants/{merchant_id}/statement",
    response_model=Statement,
    summary="One merchant's statement / ledger",
    description="Requires `payment.view`. Same scoping rule as the position endpoint.",
)
def merchant_statement(
    merchant_id: int,
    date_from: datetime.date | None = Query(default=None),
    date_to: datetime.date | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    return finance_service.statement(
        db, _scoped_merchant(db, current_user, merchant_id),
        date_from=date_from, date_to=date_to,
    )


# ---------------------------------------------------------------------------
# Wallet
# ---------------------------------------------------------------------------
@router.post(
    "/admin/merchants/{merchant_id}/wallet",
    response_model=WalletAdjustmentResult,
    summary="Credit or debit a merchant's wallet",
    description=(
        "Requires `payment.manage` (staff only). `amount` is signed — positive tops up, "
        "negative takes back — and a reason is mandatory either way. Always writes a `payments` "
        "row alongside the balance change: a wallet that moves without a ledger entry is a "
        "balance nobody can reconcile. A debit that would take the wallet negative is refused."
    ),
)
def adjust_wallet(
    merchant_id: int,
    payload: WalletAdjustment,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_MANAGE)),
):
    merchant = db.get(Merchant, merchant_id)
    if merchant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if finance_service.q(payload.amount) == finance_service.ZERO:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A zero adjustment moves nothing — send a positive or negative amount",
        )

    entry = finance_service.adjust_wallet(
        db, merchant, payload.amount, actor_id=current_user.user_id,
        payment_type=(
            PaymentType.WALLET_TOPUP if payload.amount > 0 else PaymentType.ADJUSTMENT
        ),
        reason=payload.reason,
    )
    activity_service.log_activity(
        db, current_user.user_id, "Wallet adjusted",
        activity_type="Payment", module="Payments",
        description=(
            f"{current_user.full_name} {'credited' if payload.amount > 0 else 'debited'} "
            f"{abs(finance_service.q(payload.amount))} "
            f"{'to' if payload.amount > 0 else 'from'} {merchant.company_name}: {payload.reason}"
        ),
        reference_id=entry.payment_id, merchant_id=merchant.merchant_id,
    )
    return {
        "merchant_id": merchant.merchant_id,
        "payment_id": entry.payment_id,
        "amount": finance_service.q(payload.amount),
        "wallet_balance": finance_service.q(merchant.wallet_balance),
        "position": finance_service.merchant_position(db, merchant),
    }
