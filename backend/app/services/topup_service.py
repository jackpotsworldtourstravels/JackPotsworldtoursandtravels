"""Wallet top-ups and the accounts merchants send money to (CR-4c).

WHY THIS IS A NEW FILE AND NOT MORE OF ``wallet_service``
``wallet_service.py`` is **frozen** by CR-4a's approval and CR-4b's: it is not
to be modified by a later gate unless a genuine bug is found. Nothing here is a
bug in it, so nothing here belongs in it. This module *calls* ``wallet_service``
and never re-implements any part of it — in particular it never assigns
``merchants.wallet_balance``, which remains something only ``wallet_service.post``
does.

THE ONE RULE THAT MATTERS ON THIS SCREEN
**Submitting a top-up moves no money.** A merchant filling in an amount and a
UTR is making a *claim*; the wallet is credited only when an admin verifies it
(CR-4d), at which point exactly one :class:`WalletTransaction` is written and
linked back through ``topup_id``. If submission credited the wallet, a merchant
could top itself up by typing a number, and the credit limit — the platform's
only bound on its exposure — would mean nothing.

So this file contains **no call to `wallet_service.post`**. That absence is the
feature, and ``verify_cr4c.py`` asserts it: a submitted top-up leaves the
balance and the ledger byte-identical.
"""
import datetime
from decimal import Decimal

from fastapi import HTTPException, UploadFile, status as http_status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models_v2 import (
    Merchant,
    PaymentAccount,
    User,
    WalletTopup,
    WalletTopupMethod,
    WalletTopupStatus,
    WalletTransaction,
)
from app.services import document_service, notification_service, storage, wallet_service

ZERO = Decimal("0.00")

#: Methods a merchant may claim for itself. ``CASH`` and ``OTHER`` exist on the
#: enum for an admin recording an out-of-band receipt (CR-4d) and are
#: deliberately not offered here — a merchant asserting "I paid cash" with no
#: instrument to check is not a claim anyone can verify.
MERCHANT_METHODS: frozenset[WalletTopupMethod] = frozenset({
    WalletTopupMethod.BANK_TRANSFER,
    WalletTopupMethod.UPI,
    WalletTopupMethod.QR,
})


def q(value) -> Decimal:
    """Round to paise, half-up. Same single rounding point as elsewhere."""
    return Decimal(value or 0).quantize(Decimal("0.01"))


# ---------------------------------------------------------------------------
# Where money can be sent
# ---------------------------------------------------------------------------
def active_payment_accounts(db: Session) -> list[PaymentAccount]:
    """The accounts a merchant may pay into, in the order staff arranged them.

    Inactive accounts are excluded *here* but remain readable on historical
    top-ups through the denormalised label, so retiring an account does not
    blank out where last month's money went.
    """
    return list(
        db.scalars(
            select(PaymentAccount)
            .where(PaymentAccount.is_active.is_(True))
            .order_by(PaymentAccount.display_order.asc(), PaymentAccount.account_id.asc())
        ).all()
    )


def get_active_account(db: Session, account_id: int) -> PaymentAccount:
    """One active account, or 404. Used for the QR image and at submission."""
    account = db.get(PaymentAccount, account_id)
    if account is None or not account.is_active:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="That payment account is not available",
        )
    return account


def open_qr_image(db: Session, account_id: int):
    """Open a QR image's bytes for streaming, after checking the account.

    Returns a handle rather than a path because an S3 object has no path — the
    same reason ``document_service.open_for_download`` does. The image is served
    through an authenticated endpoint and never from a public URL: a QR code is
    where the platform's money arrives, and a publicly-guessable one is an
    invitation to swap it.
    """
    account = get_active_account(db, account_id)
    if not account.qr_image_path:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="This account has no QR image",
        )
    try:
        stream = storage.backend.open(storage.validate_key(account.qr_image_path))
    except storage.InvalidDocumentKey:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Invalid stored path"
        ) from None
    except storage.DocumentBytesMissing:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="The stored image for this account is missing.",
        ) from None
    return stream, account


# ---------------------------------------------------------------------------
# Submitting a claim
# ---------------------------------------------------------------------------
def _duplicate_utr(utr: str) -> HTTPException:
    """The refusal for a UTR that has already been claimed.

    Deliberately says *this reference has already been submitted* and not *by
    whom*: `uq_wallet_topups_utr` is platform-wide, so the existing claim may
    belong to another company, and confirming that would let anyone probe for
    other merchants' bank references. The merchant is told the one thing it can
    act on — check the list, or talk to us.
    """
    return HTTPException(
        status_code=http_status.HTTP_400_BAD_REQUEST,
        detail=(
            f"Reference {utr} has already been submitted. Check your list of "
            "payments below — if you have sent a second transfer, enter that "
            "transfer's own reference instead."
        ),
    )


def _assert_utr_unclaimed(db: Session, utr: str) -> None:
    """Refuse a UTR already attached to a live claim.

    A bank reference identifies exactly one real transfer, so two claims on it
    are two claims on one payment — the double-credit this table exists to make
    auditable. Rejected top-ups are excluded, matching the partial index: a
    reference we refused is one the merchant may legitimately resubmit once the
    problem is sorted out.
    """
    clash = db.scalar(
        select(WalletTopup.topup_id).where(
            WalletTopup.utr == utr,
            WalletTopup.status != WalletTopupStatus.REJECTED,
        ).limit(1)
    )
    if clash is not None:
        raise _duplicate_utr(utr)


def _next_number(db: Session) -> str:
    """``PAY-20260801-000042``, from the sequence CR-4a created.

    ``nextval`` is non-transactional on purpose: a rolled-back attempt leaves a
    gap in the series rather than handing the same number to the next caller.
    """
    seq = db.scalar(select(func.nextval("seq_wallet_topup_number")))
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    return f"PAY-{today}-{int(seq):06d}"


def submit_topup(
    db: Session, actor: User, merchant: Merchant, *,
    amount: Decimal,
    method: WalletTopupMethod,
    payment_account_id: int | None = None,
    utr: str | None = None,
    upload_file: UploadFile | None = None,
    commit: bool = True,
) -> WalletTopup:
    """Record that the merchant says it has sent money. Credits nothing.

    The proof file goes through ``document_service.store_upload``, which is the
    one place the allowlist, the magic-byte sniff and the streaming size cap
    live. A payment screenshot is a file a stranger uploads, so it gets exactly
    the same treatment a passport scan does — and it cannot use
    ``request_documents``, whose ``request_id`` is NOT NULL and which therefore
    has nowhere to put a file that belongs to no booking.
    """
    amount = q(amount)
    if amount <= ZERO:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Enter the amount you have paid — it must be more than zero.",
        )
    if method not in MERCHANT_METHODS:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Choose bank transfer, UPI or QR.",
        )

    utr = (utr or "").strip() or None
    # A bank transfer without its reference cannot be matched against the
    # statement, which is the entire job of the desk that verifies it. UPI and
    # QR payments carry one too, but a merchant paying by QR sometimes only has
    # a screenshot, so there the proof file stands in.
    if method is WalletTopupMethod.BANK_TRANSFER and not utr:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                "Enter the UTR or reference number from your bank transfer — "
                "it is how we match your payment to your account."
            ),
        )
    if not utr and upload_file is None:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                "Add the UTR or attach a payment screenshot, so we can confirm "
                "the transfer."
            ),
        )

    account = None
    if payment_account_id is not None:
        account = get_active_account(db, payment_account_id)

    # Checked *before* the file is stored, so the ordinary duplicate — a merchant
    # double-clicking, or re-entering a transfer it already told us about —
    # leaves no orphaned upload behind.
    if utr:
        _assert_utr_unclaimed(db, utr)

    stored = None
    if upload_file is not None:
        stored = document_service.store_upload(
            upload_file, prefix=f"topups/{merchant.merchant_id}"
        )

    topup = WalletTopup(
        topup_number=_next_number(db),
        merchant_id=merchant.merchant_id,
        amount=amount,
        method=method,
        payment_account_id=account.account_id if account else None,
        payment_account_label=account.label if account else None,
        utr=utr,
        proof_path=stored.relative_path if stored else None,
        proof_filename=stored.display_filename if stored else None,
        proof_content_type=stored.content_type if stored else None,
        proof_size_bytes=stored.size_bytes if stored else None,
        status=WalletTopupStatus.SUBMITTED,
        submitted_by=actor.user_id,
        submitted_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db.add(topup)
    try:
        db.flush()
    except IntegrityError as exc:
        # The race-safe half of the pair. The check above is a check-then-act and
        # two simultaneous submissions of one UTR both pass it; what actually
        # stops the second is `uq_wallet_topups_utr`. Without this handler that
        # correctness win surfaces as a **500** — which is precisely the CR-4b
        # lesson written down as WALLET_ARCHITECTURE §2.6: the index owns the
        # data, the application still owes the caller a sane answer.
        #
        # Rollback first: an IntegrityError leaves the session unusable, so
        # anything after this would fail for a second, misleading reason.
        db.rollback()
        if "uq_wallet_topups_utr" in str(getattr(exc, "orig", exc)):
            raise _duplicate_utr(utr) from None
        raise

    if commit:
        db.commit()
        db.refresh(topup)

    # CR-4d, and the ONLY edit this milestone makes to a frozen CR-4c file.
    #
    # Additive, and it changes nothing CR-4c promised: no money moves here, the
    # returned row is identical, and every CR-4c assertion still holds. What it
    # closes is that a merchant could tell us it had paid and **no one was
    # told** — CR-4c had no desk to notify, because the queue that receives this
    # did not exist until CR-4d. Leaving it out would mean money sitting
    # unverified until somebody thought to look at a tab, which is not a
    # payment workflow.
    #
    # Deliberately notify_admins, not notify_merchant_managers: verification is
    # `payment.verify`, which no merchant account holds.
    notification_service.notify_admins(
        db,
        "Wallet top-up awaiting verification",
        f"{topup.topup_number}: {merchant.company_name} says it has sent "
        f"{q(amount)} by {method.value.replace('_', ' ')}"
        + (f" (UTR {utr})" if utr else "")
        + ". Verify it to credit their wallet.",
    )
    return topup


# ---------------------------------------------------------------------------
# Reading claims
# ---------------------------------------------------------------------------
def list_topups(
    db: Session, merchant_id: int, *,
    status: WalletTopupStatus | None = None,
    page: int = 1, page_size: int = 20,
) -> tuple[list[WalletTopup], int]:
    """A merchant's own top-ups, newest first — the opposite of a statement.

    A statement is read downwards through time; a list of submissions is read
    from the most recent, because the question it answers is "what happened to
    the one I just sent".
    """
    where = [WalletTopup.merchant_id == merchant_id]
    if status is not None:
        where.append(WalletTopup.status == status)

    total = db.scalar(
        select(func.count()).select_from(WalletTopup).where(*where)
    ) or 0
    items = list(
        db.scalars(
            select(WalletTopup)
            .where(*where)
            .order_by(WalletTopup.topup_id.desc())
            .limit(page_size)
            .offset(max(page - 1, 0) * page_size)
        ).all()
    )
    return items, total


def pending_summary(db: Session, merchant_id: int) -> tuple[Decimal, int]:
    """Total and count of top-ups awaiting verification, in one grouped query.

    Reported beside the balance and **never added to it**. The distinction is
    the point of the whole submit-then-verify flow, so the API states both
    numbers separately and no screen is left to infer it.
    """
    row = db.execute(
        select(
            func.coalesce(func.sum(WalletTopup.amount), 0),
            func.count(),
        ).where(
            WalletTopup.merchant_id == merchant_id,
            WalletTopup.status == WalletTopupStatus.SUBMITTED,
        )
    ).one()
    return q(row[0]), row[1] or 0


def get_topup(db: Session, actor: User, topup_id: int) -> WalletTopup:
    """One top-up, scoped to the caller's merchant.

    404 rather than 403 for another merchant's row — consistent with the rest
    of the API, so this cannot be used to discover that a company exists.
    Platform staff (no ``merchant_id``) may read any, which is what CR-4d's
    verification desk needs.
    """
    topup = db.get(WalletTopup, topup_id)
    if topup is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Not found")
    if actor.merchant_id and topup.merchant_id != actor.merchant_id:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Not found")
    return topup


def open_proof(db: Session, actor: User, topup_id: int):
    """Open a top-up's proof file, after re-checking scope.

    Scope is re-checked here rather than assumed from the id, for the same
    reason ``document_service.open_for_download`` does it: an id is a plain
    integer, and this is the only thing between one merchant and another's
    banking screenshots.
    """
    topup = get_topup(db, actor, topup_id)
    if not topup.proof_path:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="No payment proof was attached to this top-up",
        )
    try:
        stream = storage.backend.open(storage.validate_key(topup.proof_path))
    except storage.InvalidDocumentKey:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Invalid stored path"
        ) from None
    except storage.DocumentBytesMissing:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="The stored file for this top-up is missing.",
        ) from None
    return stream, topup


def txn_number_for(db: Session, topup: WalletTopup) -> str | None:
    """The ledger reference a verified top-up became, if it has become one.

    Read from the ledger rather than stored on the top-up, so the two cannot
    disagree: the transaction's ``topup_id`` link is the fact, and this is a
    lookup of it.
    """
    return db.scalar(
        select(WalletTransaction.txn_number)
        .where(WalletTransaction.topup_id == topup.topup_id)
        .order_by(WalletTransaction.txn_id.asc())
        .limit(1)
    )


# ---------------------------------------------------------------------------
# The summary the wallet screen opens with
# ---------------------------------------------------------------------------
#: Below this share of the credit limit remaining, the screen warns. A fraction
#: rather than a fixed rupee amount, because "5,000 left" means something very
#: different against a 20,000 limit than against a 20,00,000 one.
LOW_BALANCE_FRACTION = Decimal("0.20")


def summary(db: Session, merchant: Merchant) -> dict:
    """Everything above the ledger on the wallet screen, computed once.

    Every figure is taken from ``wallet_service`` — this function arranges them,
    it does not calculate money. The two derived booleans are the exception and
    are deliberate: they are *presentation* thresholds, and computing them here
    means the screen cannot invent a different definition of "low" from the one
    the platform uses.
    """
    totals = wallet_service.totals(db, merchant.merchant_id)
    pending_amount, pending_count = pending_summary(db, merchant.merchant_id)

    limit = wallet_service.q(merchant.credit_limit)
    available = wallet_service.available_credit(merchant)
    has_limit = wallet_service.has_credit_limit(merchant)

    return {
        "merchant_id": merchant.merchant_id,
        "merchant_name": merchant.company_name,
        "balance": wallet_service.balance(merchant),
        "outstanding": wallet_service.outstanding(merchant),
        "credit_limit": limit,
        "credit_available": available,
        "has_credit_limit": has_limit,
        "total_credits": totals["total_credits"],
        "total_debits": totals["total_debits"],
        "transaction_count": totals["transaction_count"],
        "last_transaction_at": totals["last_transaction_at"],
        "pending_topups": pending_amount,
        "pending_topup_count": pending_count,
        # Only meaningful when a limit is configured; without one there is
        # nothing to be over or low against, and saying otherwise would put a
        # red banner on every merchant that has never had a limit set.
        "is_over_limit": bool(has_limit and available is not None and available <= ZERO),
        "is_low_balance": bool(
            has_limit
            and available is not None
            and ZERO < available <= wallet_service.q(limit * LOW_BALANCE_FRACTION)
        ),
    }
