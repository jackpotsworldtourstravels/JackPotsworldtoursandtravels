"""The staff side of the wallet: payment accounts, and verifying what merchants send (CR-4d).

WHY THIS IS A NEW MODULE AND NOT MORE OF ``topup_service``
CR-4c is frozen. Its service owns the *merchant's* half — submitting a claim —
and the instruction on approval was not to modify it without a genuine bug.
Nothing here needs to: ``topup_service.get_topup`` and ``open_proof`` already
admit platform staff (CR-4c wrote them that way for this milestone), so the
reads are reused rather than reimplemented, and everything new lives here.

WHAT VERIFICATION ACTUALLY IS
A merchant submitting a top-up moves no money — that absence is CR-4c's central
property. **This module is where the money moves**, and it is the only place a
`wallet_recharge` is ever written. It does it by calling
``wallet_service.post``; there is no second arithmetic, no second balance write,
and nothing here touches ``merchants.wallet_balance`` directly.

THE TWO GUARDS (docs/WALLET_ARCHITECTURE.md §2.6)
Verification is a read-modify-write on a row two admins can hold at once.

* **The index owns the money.** ``uq_wallet_transactions_topup`` (migration
  0037) makes a second credit for one top-up impossible at the database level.
* **The lock owns the response.** ``SELECT ... FOR UPDATE`` with
  ``populate_existing=True`` on the top-up, then a status re-check, so
  simultaneous callers serialise and the loser is told the claim is already
  decided instead of receiving a raw ``IntegrityError``.

Neither substitutes for the other. CR-4b proved both halves of that the
expensive way.
"""
import datetime
from decimal import Decimal

from fastapi import HTTPException, UploadFile, status as http_status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models_v2 import (
    Merchant,
    PaymentAccount,
    PaymentAccountType,
    User,
    WalletTopup,
    WalletTopupStatus,
    WalletTransaction,
    WalletTxnType,
)
from app.services import (
    activity_service,
    document_service,
    notification_service,
    storage,
    topup_service,
    wallet_service,
)

ZERO = Decimal("0.00")


def q(value) -> Decimal:
    return wallet_service.q(value)


# ---------------------------------------------------------------------------
# Payment accounts — where merchants are told to send money
# ---------------------------------------------------------------------------
#: Fields that mean something for each rail. Stored in ``details`` JSONB rather
#: than fifteen mostly-NULL columns (migration 0036); this is the contract for
#: what a screen may expect to find there, and what the API will keep.
ACCOUNT_FIELDS: dict[PaymentAccountType, tuple[str, ...]] = {
    PaymentAccountType.BANK: (
        "account_name", "account_number", "ifsc", "bank_name", "branch", "account_type",
    ),
    PaymentAccountType.UPI: ("upi_id", "payee_name"),
    PaymentAccountType.QR: ("upi_id", "payee_name", "note"),
}


def list_accounts(db: Session, *, include_inactive: bool = True) -> list[PaymentAccount]:
    """Every payment account, active first, in the order staff chose.

    Unlike the merchant's list this includes retired accounts: a top-up paid
    into an account that has since been switched off still has to be readable
    by the desk verifying it.
    """
    stmt = select(PaymentAccount)
    if not include_inactive:
        stmt = stmt.where(PaymentAccount.is_active.is_(True))
    return list(
        db.scalars(
            stmt.order_by(
                PaymentAccount.is_active.desc(),
                PaymentAccount.display_order.asc(),
                PaymentAccount.account_id.asc(),
            )
        ).all()
    )


def get_account(db: Session, account_id: int) -> PaymentAccount:
    account = db.get(PaymentAccount, account_id)
    if account is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Payment account not found"
        )
    return account


def _clean_details(account_type: PaymentAccountType, details: dict | None) -> dict:
    """Keep the fields that belong to this rail, drop blanks, trim the rest.

    Deliberately not a free-for-all: ``details`` is rendered on a screen that
    tells a merchant where to send money, and an unbounded blob there is a place
    for anything to end up being displayed.
    """
    allowed = ACCOUNT_FIELDS.get(account_type, ())
    out = {}
    for key in allowed:
        value = (details or {}).get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            out[key] = text[:120]
    return out


def _assert_usable(account_type: PaymentAccountType, details: dict, has_qr: bool) -> None:
    """Refuse an account a merchant could not actually pay into.

    An active bank row with no account number, or an active QR with no image, is
    worse than no row at all: it is displayed with authority on the Add Money
    screen and the merchant's money goes nowhere.
    """
    if account_type is PaymentAccountType.BANK:
        missing = [f for f in ("account_name", "account_number", "ifsc") if not details.get(f)]
        if missing:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=(
                    "A bank account needs " + ", ".join(missing.copy())
                    + " before it can be shown to merchants."
                ),
            )
    elif account_type is PaymentAccountType.UPI:
        if not details.get("upi_id"):
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="A UPI account needs a UPI ID before it can be shown to merchants.",
            )
    elif account_type is PaymentAccountType.QR:
        if not has_qr:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail=(
                    "A QR account needs its QR image uploaded before it can be shown "
                    "to merchants."
                ),
            )


def create_account(
    db: Session, actor: User, *, account_type: PaymentAccountType, label: str,
    details: dict | None = None, is_active: bool = True, display_order: int = 0,
) -> PaymentAccount:
    """Add a place merchants can send money to.

    Created **inactive-capable**: a QR account has no image yet at this point, so
    an account that would fail :func:`_assert_usable` may be created as long as
    it is not active. That is what lets the desk create the row, upload the
    image, then switch it on — rather than needing the image in the same request.
    """
    clean = _clean_details(account_type, details)
    if is_active:
        _assert_usable(account_type, clean, has_qr=False)

    account = PaymentAccount(
        account_type=account_type,
        label=label.strip(),
        details=clean,
        is_active=is_active,
        display_order=display_order,
        created_by=actor.user_id,
    )
    db.add(account)
    db.commit()
    db.refresh(account)

    activity_service.log_activity(
        db, actor.user_id, "Payment account added",
        activity_type="Payment", module="Payments",
        description=f"{actor.full_name} added the {account_type.value} account '{account.label}'",
        reference_id=account.account_id,
    )
    return account


def update_account(
    db: Session, actor: User, account_id: int, *, label: str | None = None,
    details: dict | None = None, is_active: bool | None = None,
    display_order: int | None = None,
) -> PaymentAccount:
    """Edit an account. Partial — an omitted field is left alone."""
    account = get_account(db, account_id)

    if label is not None:
        account.label = label.strip()
    if details is not None:
        account.details = _clean_details(account.account_type, details)
    if display_order is not None:
        account.display_order = display_order
    if is_active is not None:
        account.is_active = is_active

    # Re-checked against the *resulting* state, not the submitted fields: an
    # edit that clears the account number of a live account is the same hazard
    # as creating one without it.
    if account.is_active:
        _assert_usable(
            account.account_type, account.details or {}, has_qr=bool(account.qr_image_path)
        )

    account.updated_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()
    db.refresh(account)

    activity_service.log_activity(
        db, actor.user_id, "Payment account updated",
        activity_type="Payment", module="Payments",
        description=f"{actor.full_name} updated the payment account '{account.label}'",
        reference_id=account.account_id,
    )
    return account


def set_qr_image(
    db: Session, actor: User, account_id: int, upload_file: UploadFile
) -> PaymentAccount:
    """Attach (or replace) the QR image a merchant scans to pay.

    Goes through ``document_service.store_upload`` — the allowlist, the
    magic-byte sniff and the streaming size cap — for the same reason a payment
    proof does. A QR code is *where the platform's money arrives*; an unchecked
    upload here is the highest-value swap on the platform.
    """
    account = get_account(db, account_id)
    declared = (upload_file.content_type or "").split(";")[0].strip().lower()
    if declared == "application/pdf":
        # store_upload allows PDFs because a passport scan may be one. A QR is
        # rendered in an <img>, so a PDF here would upload cleanly and then
        # display as a broken image.
        raise HTTPException(
            status_code=http_status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="A QR code must be an image — upload a PNG, JPEG or WebP.",
        )

    stored = document_service.store_upload(upload_file, prefix=f"payment-accounts/{account_id}")
    previous = account.qr_image_path
    account.qr_image_path = stored.relative_path
    account.updated_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()
    db.refresh(account)

    # After the commit: losing the old image is survivable, but deleting it
    # before the new path is durable would leave the account pointing at nothing.
    if previous and previous != stored.relative_path:
        try:
            storage.backend.delete(storage.validate_key(previous))
        except Exception:  # noqa: BLE001 — a stale file is not worth failing the request
            pass

    activity_service.log_activity(
        db, actor.user_id, "Payment account QR updated",
        activity_type="Payment", module="Payments",
        description=f"{actor.full_name} uploaded a QR image for '{account.label}'",
        reference_id=account.account_id,
    )
    return account


def open_qr_image(db: Session, account_id: int):
    """Staff-side QR read. Any account, including inactive ones.

    ``topup_service.open_qr_image`` deliberately serves only *active* accounts —
    that is the merchant's view. The desk has to be able to look at one it has
    just switched off, which is why this is separate rather than a flag.
    """
    account = get_account(db, account_id)
    if not account.qr_image_path:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="This account has no QR image"
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


def delete_account(db: Session, actor: User, account_id: int) -> PaymentAccount:
    """Retire an account. **Deactivates; never deletes the row.**

    ``wallet_topups.payment_account_id`` is ``ON DELETE SET NULL`` and the label
    is denormalised onto the top-up precisely so history survives — but a real
    delete would still strip the link from every past claim and lose which
    account the money went to. An account that has taken money is a fact about
    the past. Switching it off removes it from the merchant's Add Money screen,
    which is the whole of what "delete" means here.
    """
    account = get_account(db, account_id)
    account.is_active = False
    account.updated_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()
    db.refresh(account)

    activity_service.log_activity(
        db, actor.user_id, "Payment account retired",
        activity_type="Payment", module="Payments",
        description=f"{actor.full_name} retired the payment account '{account.label}'",
        reference_id=account.account_id,
    )
    return account


# ---------------------------------------------------------------------------
# The verification queue
# ---------------------------------------------------------------------------
#: The desk's tabs, resolved server-side. Same reasoning as the Manager queue's
#: buckets: a client that asked for everything and filtered its own page would
#: page against the wrong total.
QUEUE_BUCKETS: dict[str, tuple[WalletTopupStatus, ...]] = {
    "pending": (WalletTopupStatus.SUBMITTED,),
    "verified": (WalletTopupStatus.VERIFIED,),
    "rejected": (WalletTopupStatus.REJECTED,),
    "all": tuple(WalletTopupStatus),
}


def queue_counts(db: Session) -> dict:
    """Every tab's badge in one grouped query, plus the money awaiting a decision."""
    rows = db.execute(
        select(WalletTopup.status, func.count(), func.coalesce(func.sum(WalletTopup.amount), 0))
        .group_by(WalletTopup.status)
    ).all()
    by_status = {status: (count, total) for status, count, total in rows}

    counts = {
        bucket: sum(by_status.get(s, (0, ZERO))[0] for s in statuses)
        for bucket, statuses in QUEUE_BUCKETS.items()
    }
    counts["pending_amount"] = q(by_status.get(WalletTopupStatus.SUBMITTED, (0, ZERO))[1])
    return counts


def list_queue(
    db: Session, *, bucket: str = "pending", merchant_id: int | None = None,
    search: str | None = None, page: int = 1, page_size: int = 20,
) -> tuple[list[tuple[WalletTopup, str | None]], int]:
    """The verification queue. **Oldest first** — it is a work queue, not a feed.

    Same decision M1's booking queue took, and for the same reason: a merchant
    waiting on its money should not be overtaken by one that submitted later.

    Returns ``(topup, merchant_name)`` pairs from a **single joined query**.
    ``WalletTopup`` deliberately has no ``merchant`` relationship — CR-4a's model
    defines the foreign key and nothing more, and that model is frozen — so the
    name is joined here rather than lazily loaded per row, which is also the
    thing that would have made this an N+1.
    """
    if bucket not in QUEUE_BUCKETS:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown bucket '{bucket}'. Use one of: {', '.join(QUEUE_BUCKETS)}",
        )

    stmt = select(WalletTopup).where(WalletTopup.status.in_(QUEUE_BUCKETS[bucket]))
    if merchant_id is not None:
        stmt = stmt.where(WalletTopup.merchant_id == merchant_id)
    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(WalletTopup.topup_number.ilike(term), WalletTopup.utr.ilike(term))
        )

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    rows = db.execute(
        stmt.add_columns(Merchant.company_name)
        .outerjoin(Merchant, Merchant.merchant_id == WalletTopup.merchant_id)
        .order_by(WalletTopup.submitted_at.asc(), WalletTopup.topup_id.asc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return [(row[0], row[1]) for row in rows], total


def _locked(db: Session, topup_id: int) -> WalletTopup:
    """Re-read the claim under a row lock, for the actions that decide it.

    ``populate_existing=True`` is not optional — see
    ``docs/WALLET_ARCHITECTURE.md`` §6. Without it the lock is taken and the ORM
    hands back the status the session already had, so the re-check below reads a
    value from before the competing transaction committed and both callers
    proceed.
    """
    topup = db.execute(
        select(WalletTopup)
        .where(WalletTopup.topup_id == topup_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if topup is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Not found")
    return topup


def _assert_undecided(topup: WalletTopup, actor: User | None = None) -> None:
    """Refuse a claim that has already been decided.

    "by another operator" is only said when it *was* another operator — the same
    admin double-clicking Verify is the common case, and telling them a colleague
    got there first sends them to ask who.
    """
    if topup.status is not WalletTopupStatus.SUBMITTED:
        by_someone_else = (
            topup.reviewed_by is not None
            and (actor is None or topup.reviewed_by != actor.user_id)
        )
        raise HTTPException(
            status_code=http_status.HTTP_409_CONFLICT,
            detail=(
                f"{topup.topup_number} has already been {topup.status.value}"
                + (" by another operator" if by_someone_else else "")
                + ". Refresh the queue."
            ),
        )


def verify_topup(
    db: Session, actor: User, topup_id: int, *, remarks: str | None = None,
) -> tuple[WalletTopup, WalletTransaction]:
    """Confirm the money arrived, and credit the wallet. **The only credit path.**

    This is the moment CR-4c's claim becomes money. One
    ``wallet_transactions`` row of type ``wallet_recharge``, linked back through
    ``topup_id``, written by ``wallet_service.post`` under its own merchant lock.

    Lock order is **top-up → merchant**, consistent with §6's
    ``ServiceRequest → Merchant``: the subject row of the request first, the
    merchant second, always, so this path cannot deadlock against ticket
    issuance or a cancellation settling.
    """
    topup = _locked(db, topup_id)
    _assert_undecided(topup, actor)

    merchant = db.get(Merchant, topup.merchant_id)
    if merchant is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="The merchant this top-up belongs to no longer exists",
        )

    now = datetime.datetime.now(datetime.timezone.utc)
    topup.status = WalletTopupStatus.VERIFIED
    topup.reviewed_by = actor.user_id
    topup.reviewed_at = now
    topup.review_remarks = (remarks or "").strip() or None
    topup.updated_at = now

    try:
        txn = wallet_service.post(
            db, merchant,
            txn_type=WalletTxnType.WALLET_RECHARGE,
            amount=q(topup.amount),
            actor_id=actor.user_id,
            reason=f"Wallet top-up {topup.topup_number} verified"
                   + (f" ({topup.method.value}, UTR {topup.utr})" if topup.utr else ""),
            topup_id=topup.topup_id,
            commit=False,
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        # uq_wallet_transactions_topup (migration 0037). The lock above should
        # make this unreachable; it is caught because "should" is not a
        # guarantee, and a merchant credited twice is the worst outcome this
        # module has. See docs/WALLET_ARCHITECTURE.md §2.6.
        if "uq_wallet_transactions_topup" in str(exc.orig):
            raise HTTPException(
                status_code=http_status.HTTP_409_CONFLICT,
                detail="This top-up has already been credited. Refresh the queue.",
            ) from None
        raise

    db.refresh(topup)
    db.refresh(txn)

    activity_service.log_activity(
        db, actor.user_id, "Wallet top-up verified",
        activity_type="Payment", module="Payments",
        description=(
            f"{actor.full_name} verified {topup.topup_number} for "
            f"{merchant.company_name}: {q(topup.amount)} credited as {txn.txn_number}; "
            f"wallet {txn.balance_before} -> {txn.balance_after}"
        ),
        reference_id=topup.topup_id, merchant_id=merchant.merchant_id,
    )
    notification_service.notify_merchant_managers(
        db, merchant.merchant_id,
        "Wallet top-up confirmed",
        f"{topup.topup_number}: {q(topup.amount)} has been added to your wallet "
        f"({txn.txn_number}). Your balance is now {txn.balance_after}.",
    )
    return topup, txn


def reject_topup(
    db: Session, actor: User, topup_id: int, *, remarks: str,
) -> WalletTopup:
    """Refuse a claim. **Moves no money**, and says why.

    Remarks are mandatory and that is the point: the merchant believes it has
    paid us. "Rejected" with no reason produces a phone call and a second
    identical claim, so the refusal has to carry what to fix — a wrong UTR, an
    unreadable screenshot, an amount that does not match what arrived.

    Rejecting frees the UTR: ``uq_wallet_topups_utr`` excludes rejected rows, so
    a merchant that mistyped a reference can correct it and resubmit rather than
    being permanently locked out of its own bank transfer.
    """
    if not (remarks or "").strip():
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="A reason is required when rejecting a top-up — the merchant needs to "
                   "know what to correct.",
        )

    topup = _locked(db, topup_id)
    _assert_undecided(topup, actor)

    now = datetime.datetime.now(datetime.timezone.utc)
    topup.status = WalletTopupStatus.REJECTED
    topup.reviewed_by = actor.user_id
    topup.reviewed_at = now
    topup.review_remarks = remarks.strip()
    topup.updated_at = now
    db.commit()
    db.refresh(topup)

    activity_service.log_activity(
        db, actor.user_id, "Wallet top-up rejected",
        activity_type="Payment", module="Payments",
        description=(
            f"{actor.full_name} rejected {topup.topup_number} "
            f"({q(topup.amount)}): {topup.review_remarks}"
        ),
        reference_id=topup.topup_id, merchant_id=topup.merchant_id,
    )
    notification_service.notify_merchant_managers(
        db, topup.merchant_id,
        "Wallet top-up returned",
        f"{topup.topup_number} ({q(topup.amount)}) could not be confirmed: "
        f"{topup.review_remarks} Your wallet is unchanged. Correct the details and submit again.",
    )
    return topup


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------
def reconciliation(db: Session) -> dict:
    """Does the platform's money add up? One row per merchant, plus the proof.

    The figure that matters is ``drift``: ``wallet_balance`` minus
    ``SUM(credit) - SUM(debit)``. It must be zero for every merchant, always —
    it is invariant #1 in ``docs/WALLET_ARCHITECTURE.md`` §7, and this endpoint
    is that invariant made continuously visible rather than only asserted in a
    test run. A non-zero row here is an incident, not a report.

    ``pending_topups`` is reported **beside** the balances and never inside
    them: money a merchant says it has sent is not money the platform has.
    """
    ledger = (
        select(
            WalletTransaction.merchant_id.label("mid"),
            func.coalesce(func.sum(WalletTransaction.credit), 0).label("credits"),
            func.coalesce(func.sum(WalletTransaction.debit), 0).label("debits"),
            func.count().label("txns"),
        )
        .group_by(WalletTransaction.merchant_id)
        .subquery()
    )
    pending = (
        select(
            WalletTopup.merchant_id.label("mid"),
            func.coalesce(func.sum(WalletTopup.amount), 0).label("pending_amount"),
            func.count().label("pending_count"),
        )
        .where(WalletTopup.status == WalletTopupStatus.SUBMITTED)
        .group_by(WalletTopup.merchant_id)
        .subquery()
    )

    rows = db.execute(
        select(
            Merchant.merchant_id, Merchant.company_name, Merchant.wallet_balance,
            Merchant.credit_limit,
            func.coalesce(ledger.c.credits, 0), func.coalesce(ledger.c.debits, 0),
            func.coalesce(ledger.c.txns, 0),
            func.coalesce(pending.c.pending_amount, 0),
            func.coalesce(pending.c.pending_count, 0),
        )
        .outerjoin(ledger, ledger.c.mid == Merchant.merchant_id)
        .outerjoin(pending, pending.c.mid == Merchant.merchant_id)
        .order_by(Merchant.company_name)
    ).all()

    merchants = []
    totals = {
        "wallet_balance": ZERO, "credits": ZERO, "debits": ZERO,
        "pending_amount": ZERO, "outstanding": ZERO,
    }
    drifted = 0

    for (mid, name, balance, limit, credits, debits, txns,
         pending_amount, pending_count) in rows:
        balance = q(balance)
        computed = q(q(credits) - q(debits))
        drift = q(balance - computed)
        if drift != ZERO:
            drifted += 1
        outstanding = q(-balance) if balance < ZERO else ZERO

        merchants.append({
            "merchant_id": mid,
            "merchant_name": name,
            "wallet_balance": balance,
            "ledger_balance": computed,
            "drift": drift,
            "reconciled": drift == ZERO,
            "total_credits": q(credits),
            "total_debits": q(debits),
            "transaction_count": txns,
            "outstanding": outstanding,
            "credit_limit": q(limit),
            "pending_topup_amount": q(pending_amount),
            "pending_topup_count": pending_count,
        })
        totals["wallet_balance"] += balance
        totals["credits"] += q(credits)
        totals["debits"] += q(debits)
        totals["pending_amount"] += q(pending_amount)
        totals["outstanding"] += outstanding

    return {
        "generated_at": datetime.datetime.now(datetime.timezone.utc),
        "currency": "INR",
        "merchants": merchants,
        "merchant_count": len(merchants),
        "drifted_merchant_count": drifted,
        "reconciled": drifted == 0,
        **{f"total_{k}": q(v) for k, v in totals.items()},
    }


def merchant_ledger(
    db: Session, merchant_id: int, *, page: int = 1, page_size: int = 50,
    date_from=None, date_to=None,
) -> tuple[Merchant, list[WalletTransaction], int]:
    """A merchant's ledger, read by staff — the *same* rows the merchant sees.

    Deliberately delegates to ``wallet_service.ledger``: M4's rule is one
    computation per figure, and a staff view that queried the ledger its own way
    would be the second answer this programme keeps removing.
    """
    merchant = db.get(Merchant, merchant_id)
    if merchant is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Merchant not found"
        )
    rows = wallet_service.ledger(
        db, merchant_id, date_from=date_from, date_to=date_to,
        limit=page_size, offset=(page - 1) * page_size,
    )
    total = wallet_service.ledger_count(db, merchant_id, date_from=date_from, date_to=date_to)
    return merchant, rows, total


def topup_detail(db: Session, actor: User, topup_id: int) -> dict:
    """One claim, with everything the desk needs to decide it.

    Reuses ``topup_service.get_topup`` — which already admits platform staff —
    rather than writing a second lookup with its own scoping rule.
    """
    topup = topup_service.get_topup(db, actor, topup_id)
    merchant = db.get(Merchant, topup.merchant_id)
    return {
        "topup": topup,
        "merchant": merchant,
        "merchant_name": merchant.company_name if merchant else None,
        "transaction_reference": topup_service.txn_number_for(db, topup),
        "wallet_balance": q(merchant.wallet_balance) if merchant else ZERO,
    }
