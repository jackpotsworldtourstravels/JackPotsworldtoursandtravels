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
    """A wallet payment is real money moving off a real balance."""
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
) -> Payment:
    """Move the wallet and write the ledger row that explains why.

    Never call this without writing a ``payments`` row — a wallet that moves
    without a ledger entry is a balance nobody can reconcile, which is the exact
    failure this milestone exists to make impossible. ``amount`` is signed:
    positive credits the wallet, negative debits it.
    """
    amount = q(amount)
    new_balance = q(merchant.wallet_balance) + amount
    if new_balance < ZERO:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=(
                f"That would take the wallet to {new_balance}. "
                f"ck_merchants_wallet_non_negative forbids a negative balance."
            ),
        )

    merchant.wallet_balance = new_balance
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
            "wallet_balance_after": str(new_balance),
        },
    )
    db.add(entry)
    if commit:
        db.commit()
        db.refresh(entry)
    return entry


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
