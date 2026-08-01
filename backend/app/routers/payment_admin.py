"""The staff wallet desk: payment accounts, verification queue, reconciliation (CR-4d).

PERMISSIONS — NO NEW CODES
CR-4 §5.6 decided this in advance and CR-4c held to it. The four existing codes
already describe every capability here:

    payment.verify    read the queue, a claim, a merchant's ledger, reconciliation,
                      and decide a claim — verify (credits the wallet) or reject
    payment.manage    create, edit, retire a payment account; upload its QR

**Reads are gated on `payment.verify`, NOT `payment.view`, and that is the whole
security boundary of this router.** `payment.view` is held by every merchant
role — it is what lets a merchant read *its own* wallet in `wallet.py`, where no
route carries a merchant id. Every route here is platform-wide or takes someone
else's merchant id, so gating them on `payment.view` would have let any merchant
read every other merchant's balances, credit limits, outstanding position and
full ledger. It did, until `verify_cr4d.py` said so.

`payment.verify` and `payment.manage` are held by `_ADMIN` alone — not by Super
Admin, and by nobody merchant-side. That is the same split the M4 payments desk
already used, so no new code was needed.

WHY THIS ROUTER IS SEPARATE FROM ``wallet.py``
``wallet.py`` is CR-4c and frozen. It is also merchant-scoped by construction:
its docstring's central claim is that **no route in it takes a merchant id**, so
there is nothing to tamper with. Every route here is staff-scoped and most take
a merchant id. Merging the two would break the property that makes the merchant
router easy to reason about.
"""
import datetime
from decimal import Decimal
from urllib.parse import quote

from fastapi import (
    APIRouter, Depends, File, Query, UploadFile, status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import PaymentAccountType, User
from app.schemas.payment_admin import (
    CreatePaymentAccount,
    MerchantLedgerPage,
    PaymentAccountAdminOut,
    ReconciliationReport,
    RejectTopupRequest,
    TopupDecisionResult,
    TopupDetail,
    TopupQueueCounts,
    TopupQueuePage,
    TopupQueueRow,
    UpdatePaymentAccount,
    VerifyTopupRequest,
)
from app.schemas.wallet import WalletTransactionOut
from app.services import payment_admin_service, storage, topup_service

router = APIRouter(prefix="/api/admin", tags=["admin · wallet"])


def _attachment(filename: str) -> str:
    """Same two-form Content-Disposition rule as documents.py and wallet.py."""
    try:
        filename.encode("ascii")
    except UnicodeEncodeError:
        return f"attachment; filename*=utf-8''{quote(filename)}"
    return f'attachment; filename="{filename}"'


def _account_out(account) -> PaymentAccountAdminOut:
    return PaymentAccountAdminOut(
        account_id=account.account_id,
        account_type=account.account_type.value,
        label=account.label,
        details=account.details or {},
        has_qr_image=bool(account.qr_image_path),
        display_order=account.display_order,
        is_active=account.is_active,
        created_at=account.created_at,
        updated_at=account.updated_at,
    )


def _queue_row(db: Session, topup, merchant_name: str | None = None) -> TopupQueueRow:
    return TopupQueueRow(
        topup_id=topup.topup_id,
        topup_number=topup.topup_number,
        amount=topup.amount,
        method=topup.method.value,
        payment_account_id=topup.payment_account_id,
        payment_account_label=topup.payment_account_label,
        utr=topup.utr,
        has_proof=bool(topup.proof_path),
        proof_filename=topup.proof_filename,
        status=topup.status.value,
        submitted_at=topup.submitted_at,
        reviewed_at=topup.reviewed_at,
        review_remarks=topup.review_remarks,
        wallet_txn_number=topup_service.txn_number_for(db, topup),
        merchant_id=topup.merchant_id,
        merchant_name=merchant_name,
    )


# ---------------------------------------------------------------------------
# Payment accounts
# ---------------------------------------------------------------------------
@router.get(
    "/payment-accounts",
    response_model=list[PaymentAccountAdminOut],
    summary="Every payment account, active and retired",
    description=(
        "Requires `payment.verify`. Includes retired accounts, unlike the merchant's list — a "
        "top-up paid into an account that has since been switched off still has to be readable "
        "by the desk verifying it. Never returns the QR image's stored path."
    ),
)
def list_accounts(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
):
    return [_account_out(a) for a in payment_admin_service.list_accounts(db)]


@router.post(
    "/payment-accounts",
    response_model=PaymentAccountAdminOut,
    status_code=status.HTTP_201_CREATED,
    summary="Add a bank / UPI / QR account",
    description=(
        "Requires `payment.manage`. An **active** account must be usable: a bank needs a name, "
        "number and IFSC, a UPI needs an ID, a QR needs its image. Create a QR account "
        "`is_active: false`, upload the image, then activate it — an active row a merchant "
        "cannot actually pay into is worse than no row, because it is displayed with authority."
    ),
)
def create_account(
    payload: CreatePaymentAccount,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_MANAGE)),
):
    account = payment_admin_service.create_account(
        db, current_user,
        account_type=PaymentAccountType(payload.account_type),
        label=payload.label, details=payload.details,
        is_active=payload.is_active, display_order=payload.display_order,
    )
    return _account_out(account)


@router.put(
    "/payment-accounts/{account_id}",
    response_model=PaymentAccountAdminOut,
    summary="Edit a payment account",
    description=(
        "Requires `payment.manage`. Partial — an omitted field is left alone. Usability is "
        "re-checked against the **resulting** state, so an edit that empties a live account's "
        "number is refused for the same reason creating one that way is."
    ),
)
def update_account(
    account_id: int,
    payload: UpdatePaymentAccount,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_MANAGE)),
):
    account = payment_admin_service.update_account(
        db, current_user, account_id,
        label=payload.label, details=payload.details,
        is_active=payload.is_active, display_order=payload.display_order,
    )
    return _account_out(account)


@router.post(
    "/payment-accounts/{account_id}/qr",
    response_model=PaymentAccountAdminOut,
    summary="Upload or replace the QR image",
    description=(
        "Requires `payment.manage`. Goes through the same allowlist, magic-byte sniff and "
        "streaming size cap as a passport scan — a QR code is where the platform's money "
        "arrives. PDFs are refused here even though the shared uploader accepts them, because "
        "the image is rendered in an `<img>`."
    ),
)
def upload_qr(
    account_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_MANAGE)),
):
    account = payment_admin_service.set_qr_image(db, current_user, account_id, file)
    return _account_out(account)


@router.get(
    "/payment-accounts/{account_id}/qr",
    response_class=StreamingResponse,
    summary="Read a payment account's QR image",
    description=(
        "Requires `payment.verify`. Staff may read an **inactive** account's image, which the "
        "merchant route deliberately cannot. Never statically mounted."
    ),
)
def read_qr(
    account_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
):
    stream, account = payment_admin_service.open_qr_image(db, account_id)
    return StreamingResponse(
        storage.iter_chunks(stream),
        media_type="image/png",
        headers={"Cache-Control": "private, no-store"},
    )


@router.delete(
    "/payment-accounts/{account_id}",
    response_model=PaymentAccountAdminOut,
    summary="Retire a payment account",
    description=(
        "Requires `payment.manage`. **Deactivates; the row is never deleted.** An account that "
        "has taken money is a fact about the past, and every top-up paid into it keeps its link. "
        "Retiring removes it from the merchant's Add Money screen, which is what 'delete' means "
        "here."
    ),
)
def retire_account(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_MANAGE)),
):
    return _account_out(payment_admin_service.delete_account(db, current_user, account_id))


# ---------------------------------------------------------------------------
# The verification queue
# ---------------------------------------------------------------------------
@router.get(
    "/wallet/topups/counts",
    response_model=TopupQueueCounts,
    summary="Verification queue tab badges",
    description=(
        "Requires `payment.verify`. One grouped query, not one per tab. `pending_amount` is the "
        "money awaiting a decision — reported so the desk can see the size of the backlog, and "
        "never added to any merchant's balance."
    ),
)
def queue_counts(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
):
    return payment_admin_service.queue_counts(db)


@router.get(
    "/wallet/topups",
    response_model=TopupQueuePage,
    summary="Top-ups awaiting verification",
    description=(
        "Requires `payment.verify`. **Oldest first — it is a work queue, not a feed**, so a "
        "merchant waiting on its money is not overtaken by one that submitted later. Buckets: "
        "`pending`, `verified`, `rejected`, `all`. Filter by `merchant_id`, or search "
        "reference/UTR."
    ),
)
def list_queue(
    bucket: str = Query("pending"),
    merchant_id: int | None = Query(default=None),
    search: str | None = Query(default=None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
):
    items, total = payment_admin_service.list_queue(
        db, bucket=bucket, merchant_id=merchant_id, search=search,
        page=page, page_size=page_size,
    )
    return TopupQueuePage(
        items=[_queue_row(db, topup, name) for topup, name in items],
        total=total, page=page, page_size=page_size,
    )


@router.get(
    "/wallet/topups/{topup_id}",
    response_model=TopupDetail,
    summary="One claim, with what the desk needs to decide it",
    description=(
        "Requires `payment.verify`. `wallet_balance` is the merchant's balance **now**, before "
        "this claim is decided — the desk sees what it is about to change."
    ),
)
def topup_detail(
    topup_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VERIFY)),
):
    data = payment_admin_service.topup_detail(db, current_user, topup_id)
    return TopupDetail(
        topup=_queue_row(db, data["topup"], data["merchant_name"]),
        wallet_balance=data["wallet_balance"],
        transaction_reference=data["transaction_reference"],
    )


@router.get(
    "/wallet/topups/{topup_id}/proof",
    response_class=StreamingResponse,
    summary="Download a claim's payment proof",
    description=(
        "Requires `payment.verify`. Served as an **attachment**, `private, no-store`; the stored "
        "path is never exposed. Reuses the merchant service's opener, which already admits "
        "platform staff — one scoping rule, not two."
    ),
)
def topup_proof(
    topup_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VERIFY)),
):
    stream, topup = topup_service.open_proof(db, current_user, topup_id)
    return StreamingResponse(
        storage.iter_chunks(stream),
        media_type=topup.proof_content_type or "application/octet-stream",
        headers={
            "Content-Disposition": _attachment(topup.proof_filename or "proof"),
            "Content-Length": str(topup.proof_size_bytes or 0),
            "Cache-Control": "private, no-store",
        },
    )


@router.post(
    "/wallet/topups/{topup_id}/verify",
    response_model=TopupDecisionResult,
    summary="Confirm the money arrived — credits the wallet",
    description=(
        "Requires `payment.verify`. **This is the only path that credits a merchant wallet from "
        "a top-up.** Writes exactly one `wallet_recharge` transaction, linked to the claim, and "
        "returns its `WTX-…` reference plus the balance either side of it.\n\n"
        "Row-locked and first-wins: a second operator deciding the same claim gets **409**, not "
        "a duplicate credit and not a 500. `uq_wallet_transactions_topup` (migration 0037) "
        "makes a double credit impossible at the database level even if the lock were bypassed."
    ),
)
def verify_topup(
    topup_id: int,
    payload: VerifyTopupRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VERIFY)),
):
    topup, txn = payment_admin_service.verify_topup(
        db, current_user, topup_id, remarks=payload.remarks if payload else None,
    )
    return TopupDecisionResult(
        topup=_queue_row(db, topup),
        transaction_reference=txn.txn_number,
        wallet_balance_before=txn.balance_before,
        wallet_balance_after=txn.balance_after,
    )


@router.post(
    "/wallet/topups/{topup_id}/reject",
    response_model=TopupDecisionResult,
    summary="Refuse a claim — moves no money",
    description=(
        "Requires `payment.verify`. **Remarks are mandatory**: the merchant believes it has paid "
        "us, and a refusal with no reason produces a phone call and an identical resubmission. "
        "Rejecting frees the UTR — `uq_wallet_topups_utr` excludes rejected rows — so a mistyped "
        "reference can be corrected rather than locking the merchant out of its own transfer."
    ),
)
def reject_topup(
    topup_id: int,
    payload: RejectTopupRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VERIFY)),
):
    topup = payment_admin_service.reject_topup(
        db, current_user, topup_id, remarks=payload.remarks,
    )
    return TopupDecisionResult(topup=_queue_row(db, topup))


# ---------------------------------------------------------------------------
# Ledger and reconciliation
# ---------------------------------------------------------------------------
@router.get(
    "/merchants/{merchant_id}/wallet/transactions",
    response_model=MerchantLedgerPage,
    summary="One merchant's wallet ledger, read by staff",
    description=(
        "Requires `payment.verify`. The **same rows the merchant sees**, from the same "
        "`wallet_service.ledger` call — one computation per figure. Ordered by `txn_id`, never "
        "`created_at`: see `docs/WALLET_ARCHITECTURE.md` §6."
    ),
)
def merchant_ledger(
    merchant_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    date_from: datetime.date | None = Query(default=None),
    date_to: datetime.date | None = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
):
    merchant, rows, total = payment_admin_service.merchant_ledger(
        db, merchant_id, page=page, page_size=page_size,
        date_from=date_from, date_to=date_to,
    )
    return MerchantLedgerPage(
        merchant_id=merchant.merchant_id,
        merchant_name=merchant.company_name,
        wallet_balance=merchant.wallet_balance,
        items=[
            WalletTransactionOut(
                txn_id=t.txn_id, txn_number=t.txn_number, txn_type=t.txn_type.value,
                debit=t.debit, credit=t.credit,
                balance_before=t.balance_before, balance_after=t.balance_after,
                reason=t.reason, request_id=t.request_id, topup_id=t.topup_id,
                created_at=t.created_at,
            )
            for t in rows
        ],
        total=total, page=page, page_size=page_size,
    )


@router.get(
    "/wallet/reconciliation",
    response_model=ReconciliationReport,
    summary="Does the platform's money add up?",
    description=(
        "Requires `payment.verify`. One row per merchant: the cached `wallet_balance`, the balance "
        "**recomputed from the ledger**, and the `drift` between them.\n\n"
        "**`drift` must be zero for every merchant, always.** It is invariant #1 of "
        "`docs/WALLET_ARCHITECTURE.md` §7, made continuously visible rather than only asserted "
        "in a test run — a non-zero row is an incident, not a report. `pending_topup_amount` is "
        "reported beside the balances and is never part of them."
    ),
)
def reconciliation(
    db: Session = Depends(get_db),
    _: User = Depends(require(P.PAYMENT_VERIFY)),
):
    return payment_admin_service.reconciliation(db)
