"""The merchant's own wallet: balance, ledger, and adding money (CR-4c).

PERMISSIONS — NO NEW CODES
Same convention as ``routers/finance.py``, and CR-4 §5.6 decided it in advance:
new behaviour reuses an existing code unless the capability is genuinely new,
and neither reading your own wallet nor telling us you have paid is new.

    payment.view    read the balance, the ledger, the payment accounts, own top-ups
    payment.pay     submit a top-up

``payment.pay`` is held by Merchant Admin, the merchant's Manager sub-role and
Finance — but **not** by Supervisor or Operator, who keep ``payment.view``. That
is the existing split for paying a booking and it is the right one here too: the
people who may commit the company to a payment claim are the people who could
already make one.

CROSS-TENANT
Every route here is implicitly scoped to the caller's own merchant — there is no
``merchant_id`` in any path, so there is no id to tamper with. The two routes
that do take an id (a top-up, its proof) re-check ownership in the service and
return **404, not 403**, so this API cannot be used to discover that another
company exists.
"""
import datetime
from decimal import Decimal
from urllib.parse import quote

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth.rbac import P, require
from app.database.session import get_db
from app.models_v2 import (
    Merchant,
    ServiceRequest,
    User,
    WalletTopup,
    WalletTopupMethod,
    WalletTopupStatus,
)
from app.schemas.wallet import (
    PaymentAccountOut,
    TopupOut,
    TopupPage,
    WalletSummary,
    WalletTransactionOut,
    WalletTransactionPage,
)
from app.services import activity_service, storage, topup_service, wallet_service

router = APIRouter(prefix="/api", tags=["wallet"])


def _own_merchant(db: Session, user: User) -> Merchant:
    """The calling merchant's own company, or a 400 for a staff account.

    Platform staff have no merchant of their own. Rather than handing them an
    arbitrary one, they are pointed at the admin-scoped finance routes — the
    same answer ``routers/finance.py`` gives.
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


def _attachment(filename: str) -> str:
    """Content-Disposition for a download. Same two-form rule as documents.py.

    A plain quoted name when it is ASCII, the RFC 5987 encoded form otherwise —
    a bare non-ASCII byte in a header is not something every client parses the
    same way. The name was already stripped of quotes and newlines by
    ``_safe_display_name`` at upload, so it cannot forge a second header line.
    """
    try:
        filename.encode("ascii")
    except UnicodeEncodeError:
        return f"attachment; filename*=utf-8''{quote(filename)}"
    return f'attachment; filename="{filename}"'


def _topup_out(db: Session, topup) -> TopupOut:
    return TopupOut(
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
        **topup_service.request_fields(db, topup),
    )


# ---------------------------------------------------------------------------
# Reading the wallet
# ---------------------------------------------------------------------------
@router.get(
    "/merchant/wallet",
    response_model=WalletSummary,
    summary="The calling merchant's wallet summary",
    description=(
        "Requires `payment.view`. Balance (which **may be negative** — that is the outstanding "
        "position), credit limit and headroom, lifetime credits and debits, and the total of "
        "top-ups still awaiting verification. `pending_topups` is reported **separately and is "
        "never included in the balance**: an unverified claim is not money."
    ),
)
def my_wallet(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    return topup_service.summary(db, _own_merchant(db, current_user))


@router.get(
    "/merchant/wallet/transactions",
    response_model=WalletTransactionPage,
    summary="The calling merchant's wallet ledger",
    description=(
        "Requires `payment.view`. Oldest first — a statement is read downwards — and ordered by "
        "`txn_id`, never `created_at` (see WALLET_ARCHITECTURE §6). Each line carries the "
        "`balance_after` **stored at the time of the movement**, so no client accumulates a "
        "running balance of its own."
    ),
)
def my_transactions(
    date_from: datetime.date | None = Query(default=None),
    date_to: datetime.date | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    merchant = _own_merchant(db, current_user)
    rows = wallet_service.ledger(
        db, merchant.merchant_id,
        date_from=date_from, date_to=date_to,
        limit=page_size, offset=(page - 1) * page_size,
    )
    total = wallet_service.ledger_count(
        db, merchant.merchant_id, date_from=date_from, date_to=date_to
    )

    # One query for every booking referenced on this page, rather than one per
    # row — the N+1 the roadmap's §3 checklist asks about by name.
    request_ids = {r.request_id for r in rows if r.request_id}
    numbers: dict[int, str] = {}
    if request_ids:
        numbers = dict(
            db.execute(
                ServiceRequest.__table__.select()
                .with_only_columns(
                    ServiceRequest.request_id, ServiceRequest.request_number
                )
                .where(ServiceRequest.request_id.in_(request_ids))
            ).all()
        )

    # The same one-query rule for the payment request behind a credit. Kept
    # separate from the block above rather than folded into a join because a
    # ledger row references at most one of the two and usually neither.
    topup_ids = {r.topup_id for r in rows if r.topup_id}
    topup_numbers: dict[int, str] = {}
    if topup_ids:
        topup_numbers = dict(
            db.execute(
                WalletTopup.__table__.select()
                .with_only_columns(WalletTopup.topup_id, WalletTopup.topup_number)
                .where(WalletTopup.topup_id.in_(topup_ids))
            ).all()
        )

    return WalletTransactionPage(
        items=[
            WalletTransactionOut(
                txn_id=r.txn_id,
                txn_number=r.txn_number,
                txn_type=r.txn_type.value,
                debit=r.debit,
                credit=r.credit,
                balance_before=r.balance_before,
                balance_after=r.balance_after,
                reason=r.reason,
                request_id=r.request_id,
                request_number=numbers.get(r.request_id) if r.request_id else None,
                topup_id=r.topup_id,
                topup_number=topup_numbers.get(r.topup_id) if r.topup_id else None,
                created_at=r.created_at,
            )
            for r in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


# ---------------------------------------------------------------------------
# Where to send money
# ---------------------------------------------------------------------------
@router.get(
    "/merchant/wallet/payment-accounts",
    response_model=list[PaymentAccountOut],
    summary="Active platform accounts a merchant can pay into",
    description=(
        "Requires `payment.view`. Read-only on this side — staff configure these under Account "
        "Management (CR-4d). Inactive accounts are omitted here but still name themselves on "
        "historical top-ups, so retiring one does not blank out where last month's money went. "
        "**An empty list is a valid answer** and means no account has been configured yet."
    ),
)
def payment_accounts(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    _own_merchant(db, current_user)
    return [
        PaymentAccountOut(
            account_id=a.account_id,
            account_type=a.account_type.value,
            label=a.label,
            details=a.details or {},
            has_qr_image=bool(a.qr_image_path),
            display_order=a.display_order,
        )
        for a in topup_service.active_payment_accounts(db)
    ]


@router.get(
    "/merchant/wallet/payment-accounts/{account_id}/qr",
    response_class=StreamingResponse,
    summary="A payment account's QR image",
    description=(
        "Requires `payment.view`. Streamed through the API and **never a public URL**: a QR code "
        "is where the platform's money arrives, and a publicly-guessable one is an invitation to "
        "swap it. Served inline because it is meant to be scanned on screen, and it is an image "
        "whose bytes were magic-byte checked at upload."
    ),
)
def account_qr(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    _own_merchant(db, current_user)
    stream, account = topup_service.open_qr_image(db, account_id)
    return StreamingResponse(
        storage.iter_chunks(stream),
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=300"},
    )


# ---------------------------------------------------------------------------
# Adding money
# ---------------------------------------------------------------------------
@router.post(
    "/merchant/wallet/topups",
    response_model=TopupOut,
    status_code=status.HTTP_201_CREATED,
    summary="Tell us you have added money",
    description=(
        "Requires `payment.pay`. **This credits nothing.** It records the merchant's claim; the "
        "wallet moves only when an admin verifies it (CR-4d), at which point exactly one ledger "
        "entry is written. A bank transfer must carry its UTR; any method must carry either a "
        "UTR or a payment screenshot. The screenshot goes through the same allowlist, magic-byte "
        "check and streaming size cap as a passport scan."
    ),
)
def create_topup(
    amount: Decimal = Form(...),
    method: str = Form(...),
    payment_account_id: int | None = Form(default=None),
    utr: str | None = Form(default=None),
    proof: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_PAY)),
):
    merchant = _own_merchant(db, current_user)
    try:
        parsed = WalletTopupMethod(method)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Choose bank transfer, UPI or QR.",
        ) from None

    topup = topup_service.submit_topup(
        db, current_user, merchant,
        amount=amount, method=parsed,
        payment_account_id=payment_account_id,
        utr=utr, upload_file=proof,
    )
    activity_service.log_activity(
        db, current_user.user_id, "Wallet top-up submitted",
        activity_type="Payment", module="Payments",
        # Quoted by topup_number, never topup_id — WALLET_ARCHITECTURE §2.5.
        description=(
            f"{topup.topup_number}: {merchant.company_name} reported {topup.amount} "
            f"by {parsed.value}, awaiting verification"
        ),
        merchant_id=merchant.merchant_id,
    )
    return _topup_out(db, topup)


@router.get(
    "/merchant/wallet/topups",
    response_model=TopupPage,
    summary="The calling merchant's own top-ups",
    description=(
        "Requires `payment.view`. Newest first: the question this list answers is what happened "
        "to the one just sent. `wallet_txn_number` is populated once verified and is read from "
        "the ledger link, not stored twice."
    ),
)
def my_topups(
    topup_status: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    merchant = _own_merchant(db, current_user)
    parsed = None
    if topup_status:
        try:
            parsed = WalletTopupStatus(topup_status)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown status filter",
            ) from None

    items, total = topup_service.list_topups(
        db, merchant.merchant_id, status=parsed, page=page, page_size=page_size
    )
    return TopupPage(
        items=[_topup_out(db, t) for t in items],
        total=total, page=page, page_size=page_size,
    )


@router.get(
    "/merchant/wallet/topups/{topup_id}/proof",
    response_class=StreamingResponse,
    summary="Download a top-up's payment proof",
    description=(
        "Requires `payment.view`, **and** the top-up must belong to the caller's merchant — "
        "re-checked on every request, 404 for anyone else's. Served as an **attachment** rather "
        "than inline, so a crafted file can never execute in the app's origin; the stored path "
        "is never exposed."
    ),
)
def topup_proof(
    topup_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    stream, topup = topup_service.open_proof(db, current_user, topup_id)
    return StreamingResponse(
        storage.iter_chunks(stream),
        media_type=topup.proof_content_type or "application/octet-stream",
        headers={
            "Content-Disposition": _attachment(topup.proof_filename or "proof"),
            "Content-Length": str(topup.proof_size_bytes or 0),
            # Banking screenshots should not sit in a shared cache.
            "Cache-Control": "private, no-store",
        },
    )


# ---------------------------------------------------------------------------
# Payment Management — settling what the desk has asked for (migration 0041)
# ---------------------------------------------------------------------------
@router.get(
    "/merchant/payment-requests/counts",
    response_model=dict,
    summary="Tab badges for Payment Management",
    description=(
        "Requires `payment.view`. One grouped query: `requests` (raised, unpaid), `pending` "
        "(paid, with the desk), `approved`, `rejected`. Counts only requests the **desk** "
        "raised — a merchant's own Add Money submissions are not part of this screen."
    ),
)
def payment_request_counts(
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    merchant = _own_merchant(db, current_user)
    return topup_service.assigned_counts(db, merchant.merchant_id)


@router.get(
    "/merchant/payment-requests",
    response_model=TopupPage,
    summary="Payment requests raised by the desk",
    description=(
        "Requires `payment.view`. Scoped to the caller's merchant and to **admin-initiated** "
        "rows only. Buckets: `requests`, `pending`, `approved`, `rejected`, `all` — the same "
        "vocabulary the Admin queue uses, so both screens describe one row with one word.\n\n"
        "Scoped by company rather than by the named manager: the manager is who the request is "
        "*addressed to*, but a company whose manager is on leave must still be able to see and "
        "settle what it owes."
    ),
)
def my_payment_requests(
    bucket: str = Query("all"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_VIEW)),
):
    merchant = _own_merchant(db, current_user)
    items, total = topup_service.list_assigned(
        db, merchant.merchant_id, bucket=bucket, page=page, page_size=page_size,
    )
    return TopupPage(
        items=[_topup_out(db, t) for t in items],
        total=total, page=page, page_size=page_size,
    )


@router.post(
    "/merchant/payment-requests/{topup_id}/settle",
    response_model=TopupOut,
    summary="Record that you have paid — credits nothing",
    description=(
        "Requires `payment.pay`. **Moves no money**, exactly like `POST /merchant/wallet/topups`: "
        "it attaches the proof and hands the request to the desk. The wallet is credited when an "
        "admin approves it, and nowhere else.\n\n"
        "What must be attached depends on how the desk asked to be paid. A **bank transfer** "
        "needs its UTR *and* the payment slip — the UTR is how it is matched against the "
        "statement. **Cash** and **crypto** have no UTR (a note number is not a bank reference, "
        "and a chain does not issue one), so for those the uploaded image is the proof and is "
        "mandatory; sending a UTR with either is refused rather than ignored, because it would "
        "take a slot in the bank-reference namespace `uq_wallet_topups_utr` protects.\n\n"
        "**Resubmitting a rejected request is this same call.** The row returns to the queue, the "
        "stale verdict is cleared so the desk is not shown last week's reason beside this week's "
        "evidence, and `resubmission_count` records that it happened."
    ),
)
def settle_payment_request(
    topup_id: int,
    utr: str | None = Form(default=None),
    proof: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require(P.PAYMENT_PAY)),
):
    merchant = _own_merchant(db, current_user)
    topup = topup_service.settle_request(
        db, current_user, topup_id, utr=utr, upload_file=proof,
    )
    activity_service.log_activity(
        db, current_user.user_id, "Payment request settled",
        activity_type="Payment", module="Payments",
        description=(
            f"{topup.topup_number}: {merchant.company_name} paid {topup.amount} "
            f"by {topup.method.value}, awaiting approval"
        ),
        merchant_id=merchant.merchant_id,
    )
    return _topup_out(db, topup)
