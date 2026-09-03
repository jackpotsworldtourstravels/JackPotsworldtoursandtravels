"""Receiving what a payment provider tells us, exactly once.

WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT DELIBERATELY IS NOT

It is responsible for: proving a delivery came from the provider, recording it
once and only once, finding the local payment it concerns, and moving that
payment's status FORWARD if the event says something new.

It is NOT responsible for deciding that money arrived. A ``payment.captured``
event is recorded and left ``deferred``: the payment is not marked ``captured``
and no booking is confirmed by anything in this module. That decision needs the
amount, the currency and the owner checked against our own rows, which is Phase
6's job, and doing it here — on the strength of a signed message alone — is the
mistake the whole design exists to avoid. A signature proves who sent a
message, not that the message is about the right booking for the right amount.

WHY THE DATABASE DECIDES DUPLICATES, NOT PYTHON

Razorpay documents at-least-once delivery with retries for 24 hours. Two
retries can arrive at the same instant, and:

    if db.query(Event).filter_by(event_id=x).first(): return   # both pass
    db.add(Event(event_id=x))                                  # both insert

is a check-then-act that races itself. So the insert goes first, alone, in its
own transaction, and the unique index on ``(provider, provider_event_id)`` from
migration 0062 is what actually decides. The request that loses the insert
answers 200 and does nothing — the winner either has already done the work or
is doing it. That is the same shape as the booking idempotency in 0060/0061.

WHY THE EVENT ROW IS COMMITTED BEFORE THE PAYMENT IS TOUCHED

If applying the event fails, the event must still be on record — an event we
received and could not process is exactly the thing an operator needs to see.
Rolling it back with the failure would erase the evidence of the failure.
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models_customer import (
    CustomerBookingPayment,
    CustomerHotelBookingPayment,
    CustomerPackageBookingPayment,
    PaymentProviderEvent,
)
from app.services import payments as payment_providers
from app.services.payments.base import ProviderEvent, ProviderPayment

logger = logging.getLogger(__name__)

#: Every B2C payment table carries the provider columns (migration 0062), so a
#: delivery is resolved against all three rather than assuming which product it
#: belongs to. Packages are the only one with a checkout endpoint today; the
#: other two cost one indexed lookup each and stop this module needing an edit
#: when they gain one.
_PAYMENT_MODELS = (
    CustomerPackageBookingPayment,
    CustomerBookingPayment,
    CustomerHotelBookingPayment,
)

#: Outcomes recorded on the event row.
#:   processed — applied, or correctly required no change
#:   deferred  — RECOGNISED AND DELIBERATELY NOT APPLIED. A money-moving event
#:               that Phase 6 must verify (amount, currency, ownership) before
#:               anything is captured. This is a queue, not a failure.
#:   ignored   — nothing here concerns us: an unsubscribed event type, or an
#:               event about a payment this deployment has no row for
#:   failed    — we tried to apply it and could not; needs a human
PROCESSED = "processed"
DEFERRED = "deferred"
IGNORED = "ignored"
FAILED = "failed"

#: Statuses this module may write. ``captured`` and ``refunded`` are absent on
#: purpose — both mean money moved, and neither may be recorded without the
#: verification Phase 6 adds. Kept as an allow-list rather than a deny-list so
#: a new status added to the vocabulary is refused here until someone decides
#: it is safe, rather than silently becoming writable.
_APPLIES_DIRECTLY = frozenset({
    payment_providers.PROCESSING,
    payment_providers.AUTHORIZED,
    payment_providers.FAILED,
    payment_providers.CANCELLED,
    payment_providers.EXPIRED,
})

#: Recognised, but held for Phase 6.
_NEEDS_VERIFICATION = frozenset({
    payment_providers.CAPTURED,
    payment_providers.REFUNDED,
})


class DuplicateEvent(Exception):
    """This delivery has been seen before. Not an error — the expected case."""

    def __init__(self, event_row_id: int | None = None) -> None:
        super().__init__("Event already recorded.")
        self.event_row_id = event_row_id


def record_event(
    db: Session, provider: str, event: ProviderEvent
) -> PaymentProviderEvent:
    """Write the event down, or raise :class:`DuplicateEvent`.

    Commits on its own. The caller gets a row it can rely on existing, and a
    concurrent redelivery gets ``DuplicateEvent`` from the index rather than
    from a lookup that could be stale by the time it returns.
    """
    payment = event.payment
    row = PaymentProviderEvent(
        provider=provider,
        provider_event_id=event.event_id,
        event_type=event.event_type,
        provider_payment_id=payment.provider_payment_id if payment else None,
        provider_order_id=payment.provider_order_id if payment else None,
        # Stored only because the signature already verified. An unverified body
        # is not evidence and never reaches this function.
        payload=_safe_payload(event.raw),
        processing_status="received",
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.execute(
            select(PaymentProviderEvent).where(
                PaymentProviderEvent.provider == provider,
                PaymentProviderEvent.provider_event_id == event.event_id,
            )
        ).scalar_one_or_none()
        raise DuplicateEvent(
            existing.payment_provider_event_id if existing else None
        ) from None
    return row


def _safe_payload(raw: Any) -> dict[str, Any]:
    """The event body, minus anything that should not be kept.

    Razorpay does not put card numbers or UPI PINs in an event — those never
    reach any merchant — but ``notes`` is a free-text map WE populate, and a
    body is stored here permanently and read by staff. Stripping known-sensitive
    keys is cheap; discovering later that something was retained is not.
    """
    if not isinstance(raw, dict):
        return {}
    drop = {
        "card", "card_id", "token", "token_id", "vpa", "bank_account",
        "auth_code", "acquirer_data", "customer_id", "email", "contact",
    }

    def clean(node: Any, depth: int = 0) -> Any:
        if depth > 8:
            return "<truncated>"
        if isinstance(node, dict):
            return {
                k: ("<redacted>" if k.lower() in drop else clean(v, depth + 1))
                for k, v in node.items()
            }
        if isinstance(node, list):
            return [clean(v, depth + 1) for v in node[:50]]
        return node

    return clean(raw)


def find_payment(db: Session, provider: str, payment: ProviderPayment):
    """The local row this event is about, or ``None``.

    Resolved by the provider's PAYMENT id first and its ORDER id second, both
    of which are uniquely indexed per provider. Never by amount, never by
    booking reference, and never by anything the payload could have been shaped
    to match — the identifiers are the provider's own and are the only fields
    that cannot be a coincidence.
    """
    for model in _PAYMENT_MODELS:
        if payment.provider_payment_id:
            found = db.execute(
                select(model).where(
                    model.provider == provider,
                    model.provider_payment_id == payment.provider_payment_id,
                )
            ).scalar_one_or_none()
            if found is not None:
                return found
    for model in _PAYMENT_MODELS:
        if payment.provider_order_id:
            found = db.execute(
                select(model).where(
                    model.provider == provider,
                    model.provider_order_id == payment.provider_order_id,
                )
            ).scalar_one_or_none()
            if found is not None:
                return found
    return None


def apply_event(
    db: Session, event_row: PaymentProviderEvent, event: ProviderEvent
) -> tuple[str, str]:
    """Act on a recorded event. Returns ``(processing_status, note)``.

    Never raises for an ordinary outcome — an unknown event, an unmatched
    payment and a stale status are all normal and all answer 2xx, because a
    non-2xx makes Razorpay retry a delivery that would fail identically.
    """
    provider = event_row.provider
    payment = event.payment

    if not event.supported:
        # AN EVENT TYPE NOBODY HERE HANDLES. Recorded (it is real traffic an
        # operator may want to see) and otherwise untouched — including its
        # provider_status, which must not be copied off an entity belonging to
        # an event we never mapped. Without this a dispute notification about a
        # captured payment would queue itself for capture verification.
        return IGNORED, (
            f"{event.event_type}: not a supported event type; recorded only."
        )

    if payment is None:
        return IGNORED, f"{event.event_type}: carries no payment entity."

    row = find_payment(db, provider, payment)
    if row is None:
        # Not an error. A sandbox key shared between environments, or a payment
        # made against a database this one is not, both land here. Recorded so
        # it is visible, and answered 200 so it is not retried for 24 hours.
        return IGNORED, (
            f"{event.event_type}: no local payment for "
            f"payment_id={payment.provider_payment_id!r} "
            f"order_id={payment.provider_order_id!r}."
        )

    # The provider's own identifiers and status are always recorded, whatever
    # happens to the internal status below. They are what an operator and Phase
    # 6 read, and losing them because a status was stale would be worse than
    # useless.
    if payment.provider_payment_id and not row.provider_payment_id:
        row.provider_payment_id = payment.provider_payment_id
    if payment.provider_order_id and not row.provider_order_id:
        row.provider_order_id = payment.provider_order_id
    if payment.provider_status:
        row.provider_status = payment.provider_status
    if payment.method:
        # What the customer ACTUALLY paid with, from the provider. This is the
        # first point at which "upi" is known rather than assumed — the row was
        # written as "gateway" at checkout precisely so nothing was invented.
        row.method = payment.method
    if payment.failure_reason:
        row.failure_reason = str(payment.failure_reason)[:255]

    incoming = payment.status
    current = row.status

    if incoming in _NEEDS_VERIFICATION:
        # A MONEY-MOVING EVENT. Not applied on the strength of the message.
        # The event says what happened; the authoritative path asks the
        # provider directly and compares the answer against the booking. It is
        # the SAME function the backlog sweep calls, so a live delivery and a
        # replayed one are verified identically.
        db.flush()
        from app.services import payment_verification_service as verify

        # ONLY PACKAGES HAVE A VERIFICATION PATH TODAY. Flights and hotels have
        # the columns and could receive an event, but nothing opens orders for
        # them yet, so there is no booking total to verify against. Such an
        # event stays deferred — visible, un-acted-on, and picked up by the
        # sweep once those products are wired — rather than being guessed at.
        if not isinstance(row, CustomerPackageBookingPayment):
            return DEFERRED, (
                f"{event.event_type}: recorded; no verification path for "
                f"{type(row).__name__} yet."
            )

        result = verify.verify_and_capture(
            db, row.customer_package_booking_payment_id, provider_name=provider,
        )

        if result.disposition == verify.RETRYABLE:
            # STAYS DEFERRED. A slow or unreachable provider, or a payment still
            # in flight, is not an answer — the backlog sweep asks again.
            return DEFERRED, f"{event.event_type}: {result.code} — {result.detail}"
        if result.disposition == verify.REJECTED:
            return FAILED, f"{event.event_type}: {result.code} — {result.detail}"
        return PROCESSED, f"{event.event_type}: {result.code} — {result.detail}"

    if incoming not in _APPLIES_DIRECTLY:
        db.flush()
        return IGNORED, f"{event.event_type}: status {incoming!r} is not applied here."

    if not payment_providers.is_forward(current, incoming):
        # An out-of-order or repeated delivery. Razorpay documents that
        # payment.authorized can arrive after payment.captured, so this is
        # expected traffic and not a fault.
        db.flush()
        return PROCESSED, (
            f"{event.event_type}: {incoming!r} does not advance {current!r}; "
            "no change."
        )

    row.status = incoming
    db.flush()
    return PROCESSED, f"{event.event_type}: {current!r} -> {incoming!r}."


def finish(
    db: Session, event_row: PaymentProviderEvent, status: str, note: str
) -> None:
    """Stamp the outcome and commit. Always called, including on failure."""
    event_row.processing_status = status
    event_row.processing_note = note[:2000] if note else None
    event_row.processed_at = dt.datetime.now(dt.timezone.utc)
    db.commit()


def handle(db: Session, provider: str, event: ProviderEvent) -> tuple[str, str]:
    """Record then act. The one entry point the router uses."""
    try:
        row = record_event(db, provider, event)
    except DuplicateEvent:
        # ALREADY SEEN. Answered as success so Razorpay stops retrying — a
        # non-2xx here would make it redeliver for 24 hours an event that has
        # already been handled correctly.
        logger.info(
            "Duplicate webhook ignored: provider=%s event_id=%s",
            provider, event.event_id,
        )
        return "duplicate", "Already recorded."

    try:
        status, note = apply_event(db, row, event)
    except Exception as exc:                      # noqa: BLE001 — see below
        # Deliberately broad. Whatever went wrong, the event must end up on
        # record as failed rather than vanishing with the exception, and the
        # provider must get an answer. The detail is logged, not returned.
        db.rollback()
        db.add(row)
        logger.exception(
            "Webhook processing failed: provider=%s event_id=%s type=%s",
            provider, event.event_id, event.event_type,
        )
        finish(db, row, FAILED, f"{type(exc).__name__}: {exc}")
        return FAILED, "Recorded; processing failed."

    finish(db, row, status, note)
    logger.info(
        "Webhook %s: provider=%s event_id=%s type=%s — %s",
        status, provider, event.event_id, event.event_type, note,
    )
    return status, note
