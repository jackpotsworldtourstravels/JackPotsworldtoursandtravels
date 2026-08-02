"""Finance — the one place money is computed (M4).

WHY THIS FILE EXISTS
Before M4 every surface did its own arithmetic. The invoice PDF summed payments
inline, the merchant dashboard counted rows, the admin dashboard summed a
different set, and the Partner Portal read ``pending_payments_count`` — a count
of *rows* — and rendered it as money owed. Four answers to one question, and at
least one of them was wrong by construction.

So: **every money figure on every screen comes from a function in this module.**
If a new surface needs a number, it calls one of these rather than writing a
``sum()`` of its own. That is the whole design.

THE LEDGER IS THE SOURCE OF TRUTH
``payments`` is authoritative for what has been paid and refunded; nothing is
cached on the request, because a cached total is a total that can disagree with
the ledger after a refund. ``service_requests.total_amount`` is authoritative
only for what was *billed*.

DECIMAL, NEVER FLOAT
Money is ``Decimal`` from the column to the response. There is no ``float()``
anywhere in this module, and there must not be: ``0.1 + 0.2`` is a rounding
error that becomes a customer complaint. Every returned figure is quantized to
two places once, at the end, rather than at each intermediate step.

WHAT COUNTS AS PAID
A payment contributes ``amount - refund_amount``:

    pending    submitted by the merchant, not yet verified   -> owed, not paid
    processing same                                          -> owed, not paid
    success    verified                                      -> paid
    partially_refunded / refunded  verified, some given back -> paid, net of refund
    failed     verification refused                          -> nothing

A refund is therefore never a second negative row; it lives on the payment it
reverses (``refund_amount``), which is what the ``ck_payments_refund_within_amount``
constraint guarantees can never exceed what was taken.
"""
import datetime
from decimal import Decimal

from fastapi import HTTPException, status as http_status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models_v2 import (
    Merchant,
    Payment,
    PaymentStatus,
    PaymentType,
    RequestStatus as S,
    RequestType,
    ServiceRequest,
    WalletTransaction,
    WalletTxnType,
)

ZERO = Decimal("0.00")
_CENTS = Decimal("0.01")

#: Payment states whose money has actually landed.
SETTLED = (PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED)
#: Submitted by the merchant but not yet verified — still owed.
IN_FLIGHT = (PaymentStatus.PENDING, PaymentStatus.PROCESSING)

#: Statuses at which a booking represents money the merchant owes or has paid.
#: A draft is not a commitment; a rejected or cancelled booking is not billable.
#: (A cancellation *charge* is carried by the change request, not by resurrecting
#: the parent's total — see change_request_service.)
BILLABLE_STATUSES = frozenset({
    S.PAYMENT_PENDING, S.PAID, S.TICKET_ISSUED, S.COMPLETED,
})


def q(value) -> Decimal:
    """Round to paise, half-up, from anything numeric. The only rounding point."""
    return Decimal(value or 0).quantize(_CENTS)


# ---------------------------------------------------------------------------
# One booking
# ---------------------------------------------------------------------------
def booking_position(request: ServiceRequest) -> dict:
    """What is owed and what has been paid on a single booking.

    ``balance_due`` is deliberately allowed to go **negative**: that means the
    merchant has paid more than it was billed, which is a real state after a
    downward re-price, and hiding it behind ``max(0, ...)`` would make an
    overpayment invisible on the very screen meant to surface it. Callers that
    need a non-negative figure — the credit computation below — clamp it there,
    explicitly.
    """
    billed = q(request.total_amount)

    settled = ZERO
    refunded = ZERO
    in_flight = ZERO
    for p in request.payments or ():
        if p.payment_status in SETTLED:
            settled += Decimal(p.amount or 0)
            refunded += Decimal(p.refund_amount or 0)
        elif p.payment_status in IN_FLIGHT:
            in_flight += Decimal(p.amount or 0)

    net_paid = settled - refunded
    return {
        "request_id": request.request_id,
        "request_number": request.request_number,
        "status": request.status.value,
        "currency": (request.pricing or {}).get("currency") or "INR",
        "billed": billed,
        "paid": q(settled),
        "refunded": q(refunded),
        "net_paid": q(net_paid),
        "awaiting_verification": q(in_flight),
        "balance_due": q(billed - net_paid),
        "is_settled": q(billed - net_paid) <= ZERO,
    }


def balance_due(request: ServiceRequest) -> Decimal:
    """Shorthand for the one figure most callers want."""
    return booking_position(request)["balance_due"]


# ---------------------------------------------------------------------------
# One merchant
# ---------------------------------------------------------------------------
def _billable_bookings(db: Session, merchant_id: int) -> list[ServiceRequest]:
    return list(
        db.scalars(
            select(ServiceRequest)
            .options(selectinload(ServiceRequest.payments))
            .where(
                ServiceRequest.merchant_id == merchant_id,
                ServiceRequest.request_type == RequestType.BOOKING,
                ServiceRequest.status.in_(tuple(BILLABLE_STATUSES)),
            )
        ).all()
    )


def _booking_payments(db: Session, merchant_id: int) -> list[Payment]:
    """Every payment against any of this merchant's bookings, whatever its status.

    Deliberately **not** restricted to billable bookings. A booking that was
    paid and then cancelled has moved real money in both directions, and
    dropping it from the totals the moment it left the billable set made a
    ₹20,000 refund disappear from the merchant's own statement — caught by
    verify_m4's cancellation fixture. Wallet rows carry ``request_id IS NULL``
    and are excluded here; they are reported as ``wallet_balance``, not as money
    paid against a booking.
    """
    return list(
        db.scalars(
            select(Payment)
            .join(ServiceRequest, ServiceRequest.request_id == Payment.request_id)
            .where(
                ServiceRequest.merchant_id == merchant_id,
                ServiceRequest.request_type == RequestType.BOOKING,
            )
        ).all()
    )


def merchant_position(db: Session, merchant: Merchant) -> dict:
    """The merchant's whole financial position, from the ledger.

    Two different populations, on purpose:

    * ``billed`` / ``outstanding`` come from **currently billable** bookings —
      what the merchant owes right now. A cancelled booking owes nothing.
    * ``paid`` / ``refunded`` come from **every** booking payment ever made,
      because cash that moved is cash that moved. A refund on a cancelled
      booking belongs on the statement, not in a gap.

    ``outstanding`` sums only what each booking still owes, clamped at zero per
    booking. Netting a credit on one booking against a debt on another would
    understate the exposure — the merchant does not get to spend an overpayment
    on flight A to avoid paying for flight B until someone refunds it.
    """
    bookings = _billable_bookings(db, merchant.merchant_id)
    positions = [booking_position(b) for b in bookings]

    billed = sum((p["billed"] for p in positions), ZERO)
    outstanding = sum((max(p["balance_due"], ZERO) for p in positions), ZERO)
    overpaid = sum((max(-p["balance_due"], ZERO) for p in positions), ZERO)

    paid = ZERO
    refunded = ZERO
    awaiting = ZERO
    for p in _booking_payments(db, merchant.merchant_id):
        if p.payment_status in SETTLED:
            paid += Decimal(p.amount or 0)
            refunded += Decimal(p.refund_amount or 0)
        elif p.payment_status in IN_FLIGHT:
            awaiting += Decimal(p.amount or 0)

    limit = q(merchant.credit_limit)
    wallet = q(merchant.wallet_balance)

    return {
        "merchant_id": merchant.merchant_id,
        "merchant_name": merchant.company_name,
        "currency": "INR",
        "bookings_billable": len(positions),
        "billed": q(billed),
        "paid": q(paid),
        "refunded": q(refunded),
        "net_paid": q(paid - refunded),
        "awaiting_verification": q(awaiting),
        "outstanding": q(outstanding),
        "overpaid": q(overpaid),
        "wallet_balance": wallet,
        "credit_limit": limit,
        "credit_used": q(outstanding),
        # None, not a number, when no limit is configured. A UI that renders a
        # figure here would be inventing a ceiling nobody set — see
        # has_credit_limit below and the M4 decision recorded in the roadmap.
        "credit_available": q(limit - outstanding) if limit > ZERO else None,
        "has_credit_limit": limit > ZERO,
        "spending_power": q(wallet + (limit - outstanding if limit > ZERO else ZERO)),
    }


# ---------------------------------------------------------------------------
# Credit limit
# ---------------------------------------------------------------------------
def has_credit_limit(merchant: Merchant) -> bool:
    """A zero limit means **no limit configured**, not a limit of zero.

    Decided explicitly on 2026-07-31 (see docs/BOOKING_OPS_MILESTONES.md, M4):
    the column defaults to 0 and every existing merchant carries that default,
    so reading 0 literally would refuse every booking on the platform the moment
    enforcement shipped. Enforcement is fully built and tested; it simply does
    not bite until an admin sets a real number. Set one and it applies at once.
    """
    return q(merchant.credit_limit) > ZERO


def assert_within_credit_limit(
    db: Session, merchant: Merchant, additional: Decimal, *, request_number: str | None = None
) -> None:
    """Refuse a commitment that would take the merchant past its credit limit.

    Called at **admin approval**, which is where a catalog-led booking's fare is
    confirmed, and again whenever an approved booking is re-priced. The
    merchant's wallet counts towards headroom: money already on account is not
    credit.
    """
    if not has_credit_limit(merchant):
        return

    # A commitment that does not grow cannot breach a limit. Without this, a
    # merchant already past its limit could not have a booking *reduced* —
    # ``reprice_request`` passes the delta precisely so a cheaper fare is a
    # negative number, and refusing that would leave the desk unable to correct
    # an overcharge on exactly the accounts where correcting it matters most.
    # The caller's comment has always said this was handled here; now it is.
    if q(additional) <= 0:
        return

    position = merchant_position(db, merchant)
    outstanding = position["outstanding"]
    wallet = position["wallet_balance"]
    limit = position["credit_limit"]
    projected = q(outstanding + q(additional) - wallet)

    if projected > limit:
        over = q(projected - limit)
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{merchant.company_name} would be {over} over its credit limit of "
                f"{limit}. Outstanding {outstanding}, wallet {wallet}"
                + (f", this booking {q(additional)}" if request_number is None
                   else f", {request_number} {q(additional)}")
                + ". Raise the limit, take a wallet top-up, or collect payment first."
            ),
        )


# ---------------------------------------------------------------------------
# Wallet
# ---------------------------------------------------------------------------
def assert_wallet_covers(merchant: Merchant, amount: Decimal) -> None:
    """A wallet payment is real money moving off a real balance.

    **Left in force by CR-4a, deliberately.** The wallet may now go negative, but
    that is billing — a booking the platform has committed to — not a merchant
    choosing to spend money it has not sent. This guards the standard
    catalog-led track's ``POST /api/requests/{id}/pay``, where the merchant is
    settling a specific invoice from funds on account, and letting that overdraw
    would turn "pay from wallet" into a second, ungated credit facility.
    """
    if q(merchant.wallet_balance) < q(amount):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Wallet balance is {q(merchant.wallet_balance)}, which does not cover "
                f"{q(amount)}. Top up the wallet or pay by another method."
            ),
        )


def adjust_wallet(
    db: Session, merchant: Merchant, amount: Decimal, *, actor_id: int | None,
    payment_type: PaymentType, reason: str | None = None, commit: bool = True,
    txn_type: "WalletTxnType | None" = None, request_id: int | None = None,
    enforce_limit: bool = True,
) -> Payment:
    """Move the wallet and write the ledger rows that explain why.

    ``amount`` is signed: positive credits the wallet, negative debits it.

    **CR-4a re-pointed the balance change at ``wallet_service``**, which is now
    the only code that assigns ``merchant.wallet_balance``, and which does it
    under ``SELECT ... FOR UPDATE``. This function previously did the read and
    the write itself, unlocked, so two concurrent movements both read the old
    balance and one was silently lost.

    **Two rows are written, on purpose and only for now.** The authoritative
    entry is the ``wallet_transactions`` row; the ``payments`` row is kept
    because ``statement()`` below still builds its wallet lines from
    ``discount_meta['wallet_direction']``, and CR-4a's approved scope is the
    ledger foundation with **no change to any read surface**. CR-4c moves
    ``statement()`` onto the ledger and this second write goes away. The two
    cannot drift meanwhile: the ``payments`` row is derived from the transaction
    that has already been posted, never computed a second time.

    **A debit may now take the wallet negative** — migration 0036 dropped
    ``ck_merchants_wallet_non_negative`` and CR-4 makes a negative balance the
    merchant's outstanding position. What bounds it is the credit limit, checked
    inside ``wallet_service.post``.
    """
    from app.models_v2 import WalletTxnType
    from app.services import wallet_service

    amount = q(amount)
    if txn_type is None:
        txn_type = (
            WalletTxnType.WALLET_RECHARGE if payment_type is PaymentType.WALLET_TOPUP
            else WalletTxnType.MANUAL_ADJUSTMENT
        )

    txn = wallet_service.post(
        db, merchant, txn_type=txn_type, amount=amount, actor_id=actor_id,
        reason=reason, request_id=request_id, enforce_limit=enforce_limit, commit=False,
    )

    entry = Payment(
        merchant_id=merchant.merchant_id,
        request_id=None,
        user_id=actor_id,
        # Stored unsigned — `amount >= 0` is a check constraint. The direction
        # lives in payment_type, and the statement below reads it from there.
        amount=abs(amount),
        payment_type=payment_type,
        payment_method="wallet",
        payment_status=PaymentStatus.SUCCESS,
        refund_reason=reason,
        paid_date=datetime.datetime.now(datetime.timezone.utc),
        discount_meta={
            "wallet_direction": "credit" if amount >= ZERO else "debit",
            "wallet_balance_after": str(txn.balance_after),
            "wallet_txn_number": txn.txn_number,
        },
    )
    db.add(entry)
    db.flush()
    # Link the ledger row back to its instrument, so a statement line and the
    # payments row it mirrors can be reconciled from either end.
    txn.payment_id = entry.payment_id

    if commit:
        db.commit()
        db.refresh(entry)
    return entry


# ---------------------------------------------------------------------------
# Billing a booking to the wallet (CR-4b)
# ---------------------------------------------------------------------------
def is_wallet_billed(request: ServiceRequest) -> bool:
    """Does this booking settle through the wallet rather than a payment?

    One predicate, and it is deliberately the one CR-2 already wrote:
    ``lifecycle.is_classic_track``. Enquiry-led bookings have no payment stage,
    so the wallet is their only settlement path; catalog-led bookings keep
    ``POST /api/requests/{id}/pay`` and must **not** be billed here or they pay
    twice.

    It also carries the backward-compatibility guarantee for free. A booking
    that has ever been in a payment status returns False permanently, so an
    enquiry-led booking raised before CR-2 — which settled the old way — is
    never re-billed under rules that did not exist when it was made.
    """
    from app.services import lifecycle

    return lifecycle.is_classic_track(request)


def existing_booking_debit(db: Session, request_id: int) -> WalletTransaction | None:
    """The wallet debit already posted for this booking, if there is one."""
    return db.scalars(
        select(WalletTransaction).where(
            WalletTransaction.request_id == request_id,
            WalletTransaction.txn_type == WalletTxnType.BOOKING_DEBIT,
        )
    ).first()


def bill_booking_to_wallet(
    db: Session, booking: ServiceRequest, *, actor_id: int | None, commit: bool = False,
) -> WalletTransaction | None:
    """Charge a ticketed booking to the merchant's wallet (CR-4b).

    Called from ``ticket_service.issue_ticket``, in the same transaction as the
    lifecycle move to Ticket Issued: the platform has just bought a ticket with
    its own money, and the merchant owes for it from that moment.

    **The credit limit is deliberately not enforced here.** It is a gate on
    *taking on* a commitment — checked at submission and at approval, where a
    refusal can still change the outcome. Refusing this debit would leave real
    money spent and recorded nowhere, which is worse than an over-limit balance
    the desk can see. See ``wallet_service.post``'s ``enforce_limit``.

    **Two rows, one debt.** Besides the wallet debit this writes a ``payments``
    row against the booking, so ``booking_position`` reads it as settled. Without
    it the booking stays in ``BILLABLE_STATUSES`` with a full ``balance_due``
    *and* the wallet is negative by the same amount — one debt reported twice,
    on every screen that adds them up. The wallet is where the exposure lives.

    Returns None when there is nothing to bill, which is not an error: a zero
    amount, a catalog-led booking, or a booking already billed.
    """
    from app.services import wallet_service

    if not is_wallet_billed(booking):
        return None
    if booking.merchant_id is None:
        return None

    amount = q(booking.total_amount)
    if amount <= ZERO:
        return None

    # Belt and braces beside uq_wallet_transactions_booking_debit. The index is
    # the guarantee; this is so a re-issue returns the original entry instead of
    # surfacing an IntegrityError to a desk that did nothing wrong.
    already = existing_booking_debit(db, booking.request_id)
    if already is not None:
        return already

    merchant = db.get(Merchant, booking.merchant_id)
    txn = wallet_service.post(
        db, merchant,
        txn_type=WalletTxnType.BOOKING_DEBIT,
        amount=-amount,
        actor_id=actor_id,
        reason=f"Ticket issued for {booking.request_number}",
        request_id=booking.request_id,
        # The commitment was made at approval; this is the accounting entry for
        # a ticket that has already been bought.
        enforce_limit=False,
        commit=False,
    )

    settlement = Payment(
        merchant_id=booking.merchant_id,
        request_id=booking.request_id,
        user_id=actor_id,
        amount=amount,
        payment_type=PaymentType.BOOKING_PAYMENT,
        payment_method="wallet",
        payment_status=PaymentStatus.SUCCESS,
        paid_date=datetime.datetime.now(datetime.timezone.utc),
        # No `wallet_direction` key: this is a booking payment, not a wallet
        # movement, and statement() must render it as one. The reference is
        # carried so a statement line and its ledger entry reconcile by number.
        discount_meta={"wallet_txn_number": txn.txn_number, "billed_to_wallet": True},
    )
    db.add(settlement)
    db.flush()
    txn.payment_id = settlement.payment_id

    if commit:
        db.commit()
    return txn


def refund_booking_to_wallet(
    db: Session, booking: ServiceRequest, amount: Decimal, *,
    actor_id: int | None, reason: str, commit: bool = False,
) -> WalletTransaction | None:
    """Give a wallet-billed booking's money back to the wallet (CR-4b).

    ``settle_refund`` reverses the booking's ``payments`` — which, for a
    wallet-billed booking, is the settlement row :func:`bill_booking_to_wallet`
    wrote. That fixes the *booking's* position but leaves the merchant's wallet
    still carrying the debit, so the money has to come back to where it went.

    Only the amount genuinely settled is credited; a shortfall that needs a
    manual disbursement stays a shortfall, and ``change_request_service`` already
    records it rather than hiding it.
    """
    from app.services import wallet_service

    amount = q(amount)
    if amount <= ZERO or not is_wallet_billed(booking) or booking.merchant_id is None:
        return None
    # Nothing was ever taken off the wallet for this booking, so nothing goes
    # back onto it — the refund belongs to whatever else paid for it.
    if existing_booking_debit(db, booking.request_id) is None:
        return None

    merchant = db.get(Merchant, booking.merchant_id)
    return wallet_service.post(
        db, merchant,
        txn_type=WalletTxnType.REFUND_CREDIT,
        amount=amount,
        actor_id=actor_id,
        reason=reason,
        request_id=booking.request_id,
        commit=commit,
    )


def charge_reschedule_fee_to_wallet(
    db: Session, booking: ServiceRequest, amount: Decimal, *,
    actor_id: int | None, reason: str, commit: bool = False,
) -> WalletTransaction | None:
    """Bill an approved reschedule's fare difference + change fee (M3's
    ``total_payable``) to the wallet.

    Unlike :func:`refund_booking_to_wallet` this does not require an existing
    booking debit: a reschedule fee is a new charge in its own right, not a
    reversal of one already posted, so it is billed the moment it is approved
    even on a booking that has not reached Ticket Issued yet.

    Only a wallet-billed (Classic/enquiry-led) booking has anywhere for this
    charge to go; a catalog-led booking's reschedule fee is left exactly as M3
    shipped it — quoted, not billed — rather than inventing a new payment path
    here. ``enforce_limit`` stays at its default (True): approving the
    reschedule is the moment this commitment is taken on, not something
    already irreversibly spent, so the same credit-limit gate applies as any
    other new charge.
    """
    from app.services import wallet_service

    amount = q(amount)
    if amount <= ZERO or not is_wallet_billed(booking) or booking.merchant_id is None:
        return None

    merchant = db.get(Merchant, booking.merchant_id)
    return wallet_service.post(
        db, merchant,
        txn_type=WalletTxnType.RESCHEDULE_FEE,
        amount=-amount,
        actor_id=actor_id,
        reason=reason,
        request_id=booking.request_id,
        commit=commit,
    )


def assert_credit_available(
    db: Session, merchant: Merchant, amount: Decimal | None = None, *,
    request_number: str | None = None,
) -> None:
    """CR-4b's gate on taking on a new commitment. A hard block, by decision.

    Two cases, because the Classic track does not know its fare until the desk
    books it:

    * **Amount known** (catalog-led, or a re-price) — the full check: would this
      specific amount take the merchant past its limit?
    * **Amount not yet known** (enquiry-led at submission and approval) — the
      only honest question left is whether there is *any* headroom. A merchant
      already at or past its limit may not commit to more work of unknown value.

    Refusing is the whole point: the business decided this is a hard block with
    no per-booking override, so the message has to carry what the merchant needs
    to act. Both branches raise ``wallet_service.credit_refusal_message``, which
    names the balance, the outstanding, the limit, the credit remaining and —
    where it is known — the amount required. Two gates giving two different
    accounts of the same refusal is how a merchant ends up on the phone.
    """
    from app.services import wallet_service

    if not wallet_service.has_credit_limit(merchant):
        return

    if amount is not None and q(amount) > ZERO:
        wallet_service.assert_within_credit_limit(
            merchant, q(amount), request_number=request_number
        )
        return

    available = wallet_service.available_credit(merchant)
    if available is not None and available <= ZERO:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            # No `required`: on the enquiry-led track the fare is not known until
            # the desk books it, and inventing a number here would be worse than
            # the gap.
            detail=wallet_service.credit_refusal_message(
                merchant, request_number=request_number
            ),
        )


# ---------------------------------------------------------------------------
# Settling a refund against the ledger
# ---------------------------------------------------------------------------
def settle_refund(
    db: Session, booking: ServiceRequest, amount: Decimal, *,
    actor_id: int | None, reason: str, commit: bool = False,
) -> list[Payment]:
    """Give money back against a booking's own payments (M4).

    M3 computes a cancellation's refund position and says so in as many words:
    "recording that ₹21,500 is refundable is not the same as refunding it; the
    payment ledger settles in M4." This is that settlement.

    Spread **oldest payment first**, capped per row by what that payment
    actually took — ``ck_payments_refund_within_amount`` enforces the cap in the
    database, and a refund larger than everything ever paid is not a refund, it
    is a disbursement, which is a different conversation with a different
    approval. So the refund is clamped to what is genuinely reversible and the
    caller is told what was settled.

    Returns the payments touched, so the caller can report the real figure
    rather than the requested one.
    """
    wanted = q(amount)
    if wanted <= ZERO:
        return []

    payments = db.scalars(
        select(Payment)
        .where(
            Payment.request_id == booking.request_id,
            Payment.payment_status.in_(SETTLED),
        )
        .order_by(Payment.created_at, Payment.payment_id)
        .with_for_update()
    ).all()

    touched: list[Payment] = []
    remaining = wanted
    now = datetime.datetime.now(datetime.timezone.utc)

    for p in payments:
        if remaining <= ZERO:
            break
        headroom = q(Decimal(p.amount or 0) - Decimal(p.refund_amount or 0))
        if headroom <= ZERO:
            continue
        take = min(headroom, remaining)
        p.refund_amount = q(Decimal(p.refund_amount or 0) + take)
        p.refund_reason = reason
        p.refunded_at = now
        p.payment_status = (
            PaymentStatus.REFUNDED if p.refund_amount >= q(p.amount)
            else PaymentStatus.PARTIALLY_REFUNDED
        )
        remaining = q(remaining - take)
        touched.append(p)

    if commit:
        db.commit()
    return touched


def refundable_against(db: Session, booking: ServiceRequest) -> Decimal:
    """How much of this booking's money could still be given back."""
    total = ZERO
    for p in booking.payments or ():
        if p.payment_status in SETTLED:
            total += q(Decimal(p.amount or 0) - Decimal(p.refund_amount or 0))
    return q(total)


# ---------------------------------------------------------------------------
# Statement / ledger
# ---------------------------------------------------------------------------
def statement(
    db: Session, merchant: Merchant, *,
    date_from: datetime.date | None = None, date_to: datetime.date | None = None,
) -> dict:
    """A running ledger: what was billed, what was paid, what came back.

    Charges are dated by ``approved_at`` — the moment the booking became a
    commitment — rather than ``created_at``, so a draft raised in March and
    priced in April lands in April, where the money actually is. Rows are
    ordered oldest-first because a statement is read downwards.
    """
    rows: list[dict] = []

    for booking in _billable_bookings(db, merchant.merchant_id):
        pos = booking_position(booking)
        charged_at = booking.approved_at or booking.created_at
        rows.append({
            "at": charged_at,
            "kind": "charge",
            "reference": booking.request_number,
            "request_id": booking.request_id,
            "description": booking.title or "Booking",
            "debit": pos["billed"],
            "credit": ZERO,
        })

    payments = db.scalars(
        select(Payment)
        .options(selectinload(Payment.request))
        .where(Payment.merchant_id == merchant.merchant_id)
        .order_by(Payment.created_at)
    ).all()

    for p in payments:
        if p.payment_status is PaymentStatus.FAILED:
            continue  # a refused payment moved no money and belongs on no statement
        direction = (p.discount_meta or {}).get("wallet_direction")
        reference = p.request.request_number if p.request else "Wallet"

        if p.payment_type is PaymentType.WALLET_TOPUP or direction == "credit":
            rows.append({
                "at": p.paid_date or p.created_at, "kind": "wallet_topup",
                "reference": reference, "request_id": p.request_id,
                "description": p.refund_reason or "Wallet top-up",
                "debit": ZERO, "credit": ZERO,   # funds the wallet, settles nothing yet
                "wallet_movement": q(p.amount),
            })
            continue
        if direction == "debit":
            rows.append({
                "at": p.paid_date or p.created_at, "kind": "wallet_adjustment",
                "reference": reference, "request_id": p.request_id,
                "description": p.refund_reason or "Wallet adjustment",
                "debit": ZERO, "credit": ZERO,
                "wallet_movement": q(-p.amount),
            })
            continue

        if p.payment_status in SETTLED:
            rows.append({
                "at": p.paid_date or p.created_at, "kind": "payment",
                "reference": reference, "request_id": p.request_id,
                "description": f"Payment received ({p.payment_method or 'unspecified'})",
                "debit": ZERO, "credit": q(p.amount),
            })
            if Decimal(p.refund_amount or 0) > 0:
                rows.append({
                    "at": p.refunded_at or p.updated_at, "kind": "refund",
                    "reference": reference, "request_id": p.request_id,
                    "description": p.refund_reason or "Refund issued",
                    "debit": q(p.refund_amount), "credit": ZERO,
                })
        elif p.payment_status in IN_FLIGHT:
            rows.append({
                "at": p.paid_date or p.created_at, "kind": "payment_pending",
                "reference": reference, "request_id": p.request_id,
                "description": f"Payment submitted, awaiting verification "
                               f"({p.payment_method or 'unspecified'})",
                "debit": ZERO, "credit": ZERO,   # not money until it is verified
                "unverified": q(p.amount),
            })

    rows.sort(key=lambda r: (r["at"] is None, r["at"]))

    if date_from is not None:
        rows = [r for r in rows if r["at"] and r["at"].date() >= date_from]
    if date_to is not None:
        rows = [r for r in rows if r["at"] and r["at"].date() <= date_to]

    running = ZERO
    for r in rows:
        running = q(running + r["debit"] - r["credit"])
        r["balance"] = running
        r.setdefault("wallet_movement", ZERO)
        r.setdefault("unverified", ZERO)

    return {
        "merchant_id": merchant.merchant_id,
        "merchant_name": merchant.company_name,
        "currency": "INR",
        "date_from": date_from,
        "date_to": date_to,
        "opening_balance": ZERO,
        "closing_balance": running,
        "total_debits": q(sum((r["debit"] for r in rows), ZERO)),
        "total_credits": q(sum((r["credit"] for r in rows), ZERO)),
        "entries": rows,
        "position": merchant_position(db, merchant),
    }
