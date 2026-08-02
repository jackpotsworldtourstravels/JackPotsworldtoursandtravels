"""The merchant wallet — one ledger, one lock, one place the balance moves (CR-4a).

WHY THIS FILE EXISTS
Before CR-4 the wallet was two columns and an improvisation. ``merchants.wallet_balance``
held the number, and its history was reconstructed from ``payments`` rows whose
direction lived in ``discount_meta->>'wallet_direction'`` and whose after-balance
was a JSON *string*. Nothing could ask "every debit in July" without parsing
JSON, and nothing stopped the balance and its history disagreeing.

So: **every movement of a merchant's wallet goes through :func:`post`.** It is
the only function in the codebase that assigns ``merchant.wallet_balance``, and
it never assigns it without writing the ``wallet_transactions`` row that explains
why. That is the whole design, and it is the same design ``finance_service``
already applies to booking money.

THE LOCK IS NOT OPTIONAL
Moving a wallet is a read-modify-write on a row two requests can hold at once.
The previous implementation (``finance_service.adjust_wallet``) read
``merchant.wallet_balance`` off whatever the session happened to have loaded and
wrote back the sum — so two concurrent movements both read 10,000, both wrote
their own result, and one silently vanished. Harmless while only an admin could
trigger it by hand; a live money defect the moment CR-4b bills bookings
automatically. :func:`lock` takes ``SELECT ... FOR UPDATE`` on the merchant row
and every write path here goes through it.

NEGATIVE IS NORMAL NOW
Migration 0036 drops ``ck_merchants_wallet_non_negative``. A negative wallet is
the merchant's outstanding balance, which is the point of CR-4. What bounds the
exposure instead is ``merchants.credit_limit``, checked here — a per-merchant
business limit an admin sets, rather than a floor at zero identical for everyone.
``credit_limit = 0`` still means *no limit configured*, the decision recorded in
``finance_service.has_credit_limit``: every merchant carries the column default,
so reading 0 literally would refuse every debit on the platform on day one.

DECIMAL, NEVER FLOAT
Same rule as ``finance_service``, for the same reason. There is no ``float()``
in this module and there must not be.
"""
import datetime
from decimal import Decimal

from fastapi import HTTPException, status as http_status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models_v2 import (
    Merchant,
    WalletTransaction,
    WalletTxnType,
)

ZERO = Decimal("0.00")
_CENTS = Decimal("0.01")

#: Transaction types that take money off the wallet. Kept here rather than on
#: the enum because direction is a property of the *row* (debit/credit columns),
#: not of the type — a refund credits, a cancellation charge debits, and both can
#: arise from one cancellation. This is only the default a caller gets when it
#: does not say.
_DEBIT_TYPES = frozenset({
    WalletTxnType.BOOKING_DEBIT,
    WalletTxnType.CANCELLATION_CHARGE,
    WalletTxnType.RESCHEDULE_FEE,
})


def q(value) -> Decimal:
    """Round to paise, half-up. The only rounding point, as in finance_service."""
    return Decimal(value or 0).quantize(_CENTS)


# ---------------------------------------------------------------------------
# Locking
# ---------------------------------------------------------------------------
def lock(db: Session, merchant_id: int) -> Merchant:
    """Take the merchant row for update, so a balance read cannot go stale.

    Every caller that intends to *move* the wallet must hold this before it
    reads the balance it is about to add to. Callers that only want to display a
    figure should not — an exclusive lock per page view would serialise the
    portal.

    **``populate_existing`` is what makes this correct, and it is not optional.**
    Without it the statement still takes the row lock, but SQLAlchemy's identity
    map returns the instance the session already had — with the balance it
    loaded *before* the lock was granted. The lock is then held over a stale
    read, which is the exact race it was added to close, and it fails silently:
    eight concurrent movements each write a plausible-looking ledger row and
    only half of them reach the balance. Measured, not reasoned about — see
    ``tests/verify_cr4a.py``, which caught this and now guards it.
    """
    merchant = db.execute(
        select(Merchant)
        .where(Merchant.merchant_id == merchant_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if merchant is None:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, detail="Merchant not found"
        )
    return merchant


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def balance(merchant: Merchant) -> Decimal:
    """The cached balance, as displayed. Cheap."""
    return q(merchant.wallet_balance)


def ledger_balance(db: Session, merchant_id: int) -> Decimal:
    """The balance recomputed from the ledger: ``SUM(credit) - SUM(debit)``.

    This must always equal :func:`balance`. It is not used to render anything —
    that would be a second computation of one number, exactly what M4 forbids —
    but it is what the verification script asserts against, and what an operator
    reaches for when a balance is disputed.
    """
    total = db.scalar(
        select(func.coalesce(func.sum(WalletTransaction.credit - WalletTransaction.debit), 0))
        .where(WalletTransaction.merchant_id == merchant_id)
    )
    return q(total)


def ledger(
    db: Session, merchant_id: int, *,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    limit: int = 100, offset: int = 0,
) -> list[WalletTransaction]:
    """The merchant's transactions, oldest first — a statement is read downwards."""
    stmt = select(WalletTransaction).where(WalletTransaction.merchant_id == merchant_id)
    if date_from is not None:
        stmt = stmt.where(WalletTransaction.created_at >= date_from)
    if date_to is not None:
        # Inclusive of the whole end day: a filter to "1 Aug" that drops
        # everything after midnight is a filter users read as broken.
        stmt = stmt.where(
            WalletTransaction.created_at < date_to + datetime.timedelta(days=1)
        )
    # By txn_id, never by created_at. See the index comment in migration 0036:
    # created_at is the transaction *start* time, so under concurrency it can
    # order two rows against the sequence in which they actually moved the
    # balance — and a statement ordered that way shows a running balance that
    # jumps backwards. txn_id is allocated after the lock, so it is the chain.
    stmt = stmt.order_by(WalletTransaction.txn_id.asc()).limit(limit).offset(offset)
    return list(db.scalars(stmt).all())


def ledger_count(
    db: Session, merchant_id: int, *,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
) -> int:
    stmt = (
        select(func.count())
        .select_from(WalletTransaction)
        .where(WalletTransaction.merchant_id == merchant_id)
    )
    if date_from is not None:
        stmt = stmt.where(WalletTransaction.created_at >= date_from)
    if date_to is not None:
        stmt = stmt.where(
            WalletTransaction.created_at < date_to + datetime.timedelta(days=1)
        )
    return db.scalar(stmt) or 0


def totals(db: Session, merchant_id: int) -> dict:
    """Credits, debits and count over the whole ledger, in one grouped query.

    The figures the CR-4c wallet screen needs — "total paid", "total booked" —
    computed here so no page adds a column of its own. §3 of the roadmap:
    counts in one grouped query, not one query per tile.
    """
    row = db.execute(
        select(
            func.coalesce(func.sum(WalletTransaction.credit), 0),
            func.coalesce(func.sum(WalletTransaction.debit), 0),
            func.count(),
            func.max(WalletTransaction.created_at),
        ).where(WalletTransaction.merchant_id == merchant_id)
    ).one()
    return {
        "total_credits": q(row[0]),
        "total_debits": q(row[1]),
        "transaction_count": row[2] or 0,
        "last_transaction_at": row[3],
    }


# ---------------------------------------------------------------------------
# Credit limit
# ---------------------------------------------------------------------------
def has_credit_limit(merchant: Merchant) -> bool:
    """A zero limit means *no limit configured*, not a limit of zero.

    The same rule ``finance_service.has_credit_limit`` states, deliberately
    duplicated as a one-line read of the same column rather than imported: this
    module must not depend on finance_service, because CR-4b makes
    finance_service depend on it.
    """
    return q(merchant.credit_limit) > ZERO


def available_credit(merchant: Merchant) -> Decimal | None:
    """How much further the wallet may go, or None when no limit is configured."""
    if not has_credit_limit(merchant):
        return None
    return q(q(merchant.credit_limit) + q(merchant.wallet_balance))


def outstanding(merchant: Merchant) -> Decimal:
    """What the merchant owes, stated the way a person says it.

    Under CR-4 the wallet *is* the debt: a wallet-billed booking settles itself
    at issuance and stops carrying a ``balance_due``, so the exposure lives in
    one place rather than being added up twice. This is that one place, read
    positively — a merchant 10,000 down owes 10,000, not "minus 10,000".

    Floored at zero on purpose. A merchant in credit owes nothing; without the
    floor a healthy wallet would report a negative debt, which every screen that
    subtotals it would then get wrong.
    """
    return max(ZERO, q(-q(merchant.wallet_balance)))


def credit_refusal_message(
    merchant: Merchant, *, required: Decimal | None = None,
    request_number: str | None = None,
) -> str:
    """The single text a merchant sees when the credit limit stops it (CR-4b).

    Built in one place because the two gates were each naming a *different*
    subset of the figures — the amount-known check gave headroom, limit and
    amount; the "is there any headroom at all" check gave balance and limit — so
    the same hard block read differently depending on which gate happened to
    catch it, and neither carried all of what the business asked for.

    The decision was a hard block with no per-booking override. That makes the
    message the entire remedy: it has to answer "how bad is it and what do I do",
    or the merchant's next action is to phone support and ask. So it names all
    five figures the business listed — balance, outstanding, limit, available
    credit, amount required — plus the shortfall, which is the number that says
    how much money makes this go away.

    ``required`` is left out on the enquiry-led track, where the fare genuinely
    is not known until the desk books it. The gap is left visible rather than
    filled with a guess.
    """
    limit = q(merchant.credit_limit)
    # Clamped, like `outstanding`: a merchant past its limit has no *negative*
    # credit available, it has none.
    available = max(ZERO, q(limit + q(merchant.wallet_balance)))

    figures = (
        f"Wallet balance {q(merchant.wallet_balance)}, "
        f"outstanding {outstanding(merchant)}, "
        f"credit limit {limit}, "
        f"available credit {available}"
    )
    if required is not None and q(required) > ZERO:
        required = q(required)
        figures += (
            f", and this needs {required} — "
            f"{q(required - available)} more than is available"
        )

    # "this transaction" rather than "this booking": the same guard also refuses
    # a manual debit posted from the admin wallet screen, where there is no
    # booking and calling it one would be a small lie in an error message people
    # forward to support.
    subject = request_number or "this transaction"
    return (
        f"{merchant.company_name} does not have the credit for {subject}. "
        f"{figures}. Add money to the wallet, or ask an administrator to raise "
        f"the credit limit."
    )


def assert_within_credit_limit(
    merchant: Merchant, debit: Decimal, *, request_number: str | None = None,
) -> None:
    """Refuse a debit that would take the merchant past its credit limit.

    The arithmetic, stated once: a negative wallet *is* the debt, so the debt
    after this movement is ``-(wallet - debit)`` and the limit caps it. A
    merchant at -92,000 with a 100,000 limit may spend 8,000 and not 8,001.

    The refusal text is :func:`credit_refusal_message`, shared with the other
    gate so one hard block does not read two different ways.
    """
    if not has_credit_limit(merchant):
        return
    debit = q(debit)
    if debit <= ZERO:
        return

    limit = q(merchant.credit_limit)
    projected_debt = q(-(q(merchant.wallet_balance) - debit))
    if projected_debt > limit:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=credit_refusal_message(
                merchant, required=debit, request_number=request_number
            ),
        )


# ---------------------------------------------------------------------------
# Writing — the only path
# ---------------------------------------------------------------------------
def _next_number(db: Session) -> str:
    """``WTX-20260801-000042``, from a sequence, matching the ENQ-/SRQ- series.

    ``nextval`` is non-transactional on purpose: a rolled-back attempt leaves a
    gap in the series rather than handing the same number to the next caller.
    """
    seq = db.scalar(select(func.nextval("seq_wallet_txn_number")))
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    return f"WTX-{today}-{int(seq):06d}"


def post(
    db: Session, merchant: Merchant, *, txn_type: WalletTxnType, amount: Decimal,
    actor_id: int | None = None, reason: str | None = None,
    request_id: int | None = None, payment_id: int | None = None,
    topup_id: int | None = None, enforce_limit: bool = True, commit: bool = False,
) -> WalletTransaction:
    """Move the wallet and write the ledger row that explains why.

    ``amount`` is **signed**: positive credits, negative debits. The caller says
    what happened and in which direction; the ``debit`` / ``credit`` columns are
    derived here so no caller can write a row that is both.

    The merchant row must already be locked by :func:`lock` — this reads the
    balance it is about to modify, and reading it unlocked is the race described
    in the module docstring. Callers holding a merchant loaded some other way get
    a re-read under lock rather than a silent stale write.

    ``enforce_limit=False`` exists for one case, and it is worth stating: CR-4b
    debits a booking at Ticket Issued, *after* the platform has already bought
    the ticket. Refusing that debit would leave real money spent and recorded
    nowhere, so the credit limit is enforced where it can still change the
    outcome — at submission and approval — and never used to reject an
    accounting entry for something that has already happened.
    """
    amount = q(amount)
    if amount == ZERO:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="A zero transaction moves nothing — send a positive or negative amount",
        )

    # Re-read under lock unless the caller already holds it. Cheap when it does
    # (the row is in the transaction's snapshot), and correct when it does not.
    merchant = lock(db, merchant.merchant_id)

    debit = q(-amount) if amount < ZERO else ZERO
    credit = amount if amount > ZERO else ZERO

    if debit > ZERO and enforce_limit:
        assert_within_credit_limit(merchant, debit)

    before = q(merchant.wallet_balance)
    after = q(before + credit - debit)

    entry = WalletTransaction(
        txn_number=_next_number(db),
        merchant_id=merchant.merchant_id,
        txn_type=txn_type,
        debit=debit,
        credit=credit,
        balance_before=before,
        balance_after=after,
        request_id=request_id,
        payment_id=payment_id,
        topup_id=topup_id,
        reason=reason,
        created_by=actor_id,
        # Set here rather than left to the column default: that default is
        # ``now()``, which PostgreSQL fixes at the start of the transaction, so a
        # movement that waited on the lock would be stamped earlier than one that
        # went first. Taken after the lock, this is the real moment the balance
        # moved. Ordering still uses txn_id — this is for reading and filtering.
        created_at=datetime.datetime.now(datetime.timezone.utc),
    )
    merchant.wallet_balance = after
    db.add(entry)
    db.flush()

    if commit:
        db.commit()
        db.refresh(entry)
    return entry


def credit_wallet(db: Session, merchant: Merchant, amount: Decimal, **kw) -> WalletTransaction:
    """Convenience wrapper: ``amount`` is stated positive and credits."""
    kw.setdefault("txn_type", WalletTxnType.MANUAL_ADJUSTMENT)
    return post(db, merchant, amount=abs(q(amount)), **kw)


def debit_wallet(db: Session, merchant: Merchant, amount: Decimal, **kw) -> WalletTransaction:
    """Convenience wrapper: ``amount`` is stated positive and debits."""
    kw.setdefault("txn_type", WalletTxnType.MANUAL_ADJUSTMENT)
    return post(db, merchant, amount=-abs(q(amount)), **kw)


def default_direction(txn_type: WalletTxnType) -> int:
    """-1 if this type normally takes money off the wallet, +1 if it adds.

    Only a default for callers that have an unsigned amount and a type; nothing
    in this module reads it to decide what a stored row means. See ``_DEBIT_TYPES``.
    """
    return -1 if txn_type in _DEBIT_TYPES else 1
