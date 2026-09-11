"""The authoritative payment path for HOTEL bookings.

WHY THIS IS A SEPARATE MODULE AND NOT A PARAMETER
``payment_verification_service`` is the same logic for packages, and it was
proved end to end against a live provider before this file existed. Generalising
it to serve both products would have been the tidier answer, and it is probably
the right answer eventually -- but it would mean editing the one module in this
codebase that decides money arrived, while packages are going into production.
A mistake there takes both products down. This file leaves that one alone.

WHAT IS SHARED AND WHAT IS NOT
Everything genuinely model-agnostic is IMPORTED rather than copied: the
``Verification`` result, the dispositions, ``_record_remote`` (which touches only
columns every payment table has) and ``_audit`` (which needs nothing but
``booking.customer_id``). What is written out again here is only what names a
flight model or a flight column.

THE TWO COPIES MUST NOT DRIFT. The rules below -- only a verified provider read
may capture, only an exact amount may confirm, slow is never failed -- are the
same rules written twice. A change to one is a bug in the other until it is made
there too.
"""

from __future__ import annotations

import datetime as dt
import logging
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import (
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerBookingStatus,
    CustomerPaymentStatus,
)
from app.services import customer_account_service as account_service
from app.services import payments as payment_providers

# The model-agnostic half. Imported, not copied -- importing changes nothing in
# the package path, which is the whole point of this module existing.
from app.services.payment_verification_service import (
    DONE,
    REJECTED,
    RETRYABLE,
    Verification,
    _audit,
    _record_remote,
    _v,
)

logger = logging.getLogger(__name__)

__all__ = ["verify_and_capture", "confirm_booking"]


def verify_and_capture(
    db: Session,
    payment_id: int,
    *,
    provider_name: str | None = None,
) -> Verification:
    """The authoritative path for a hotel payment. Safe to call concurrently.

    ``payment_id`` is OUR primary key, never a provider identifier -- the caller
    has already resolved which local row an event concerns, and re-resolving it
    from provider data here would give the payload a second chance to point us at
    a different row.
    """
    # ---- the row lock ----------------------------------------------------
    # populate_existing=True is not optional. Without it SQLAlchemy returns the
    # instance already in this session's identity map -- the pre-lock values --
    # and the "is it already captured?" check below reads a stale status while
    # holding a lock that says it did not.
    payment = db.execute(
        select(CustomerHotelBookingPayment)
        .where(CustomerHotelBookingPayment.customer_hotel_booking_payment_id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()

    if payment is None:
        return _v(REJECTED, "unknown_payment", f"No local hotel payment {payment_id}.")

    # ---- already done? ---------------------------------------------------
    # Checked FIRST, under the lock, before any network call. This is what makes
    # six concurrent deliveries cost one provider round trip rather than six.
    if payment.status == CustomerPaymentStatus.CAPTURED.value:
        return _v(
            DONE, "already_captured", "Already captured; nothing to do.",
            status=payment.status, captured_now=False,
        )
    if payment.status == CustomerPaymentStatus.REFUNDED.value:
        return _v(
            DONE, "already_refunded", "Already refunded; not re-capturing.",
            status=payment.status,
        )

    booking = db.get(CustomerHotelBooking, payment.hotel_booking_id)
    if booking is None:
        return _v(
            REJECTED, "orphan_payment",
            f"Payment {payment_id} has no booking {payment.hotel_booking_id}.",
            status=payment.status,
        )

    # ---- what we believe, computed from our own rows ---------------------
    expected_currency = (booking.currency or payment_providers.INR).upper()
    if expected_currency != payment_providers.INR:
        return _v(
            REJECTED, "currency_not_inr",
            f"{booking.booking_ref} is denominated in {expected_currency}, not INR.",
            status=payment.status,
        )
    try:
        expected_minor = payment_providers.to_minor(
            Decimal(str(booking.total_amount or 0)), expected_currency
        )
    except payment_providers.PaymentProviderError as exc:
        return _v(
            REJECTED, "unusable_booking_amount",
            f"{booking.booking_ref}: {exc}", status=payment.status,
        )
    if expected_minor <= 0:
        return _v(
            REJECTED, "zero_booking_amount",
            f"{booking.booking_ref} has nothing to pay.", status=payment.status,
        )

    # ---- ask the provider ------------------------------------------------
    try:
        provider = payment_providers.get_provider_named(
            provider_name or payment.provider or ""
        )
    except payment_providers.PaymentProviderError as exc:
        # Retryable rather than rejected: reconfiguring is a deployment fix, and
        # the payment is not wrong.
        return _v(
            RETRYABLE, "provider_unavailable",
            f"Provider {payment.provider!r} is not available: {exc}",
            status=payment.status,
        )

    if not (payment.provider_payment_id or payment.provider_order_id):
        return _v(
            DONE, "no_provider_reference",
            "No provider payment or order recorded yet; nothing to verify.",
            status=payment.status,
        )

    try:
        if payment.provider_payment_id:
            remote = provider.fetch_payment(payment.provider_payment_id)
        else:
            remote = provider.fetch_order(payment.provider_order_id)
    except payment_providers.PaymentTimeout as exc:
        # THE MOST IMPORTANT BRANCH IN THIS FILE.
        # Slow is not failed. Nothing is written; the event stays deferred.
        logger.warning(
            "Hotel verification timed out for payment %s: %s", payment_id, exc
        )
        return _v(
            RETRYABLE, "provider_timeout",
            "The provider did not answer in time; will retry.",
            status=payment.status,
        )
    except payment_providers.PaymentProviderError as exc:
        logger.warning(
            "Hotel verification could not reach the provider for %s: %s",
            payment_id, exc,
        )
        return _v(
            RETRYABLE, "provider_error",
            "The provider could not be reached; will retry.",
            status=payment.status,
        )

    # ---- the comparisons -------------------------------------------------
    # Order first: it is the strongest link between a provider payment and one of
    # our bookings, and a mismatch here means the rest is about someone else.
    if payment.provider_order_id and remote.provider_order_id \
            and remote.provider_order_id != payment.provider_order_id:
        return _reject(
            db, payment, booking, "order_mismatch",
            f"Provider reports order {remote.provider_order_id!r}; "
            f"we opened {payment.provider_order_id!r}.",
        )

    if payment.provider_payment_id and remote.provider_payment_id \
            and remote.provider_payment_id != payment.provider_payment_id:
        return _reject(
            db, payment, booking, "payment_id_mismatch",
            f"Provider reports payment {remote.provider_payment_id!r}; "
            f"we recorded {payment.provider_payment_id!r}.",
        )

    remote_currency = (remote.currency or "").upper()
    if remote_currency and remote_currency != expected_currency:
        return _reject(
            db, payment, booking, "currency_mismatch",
            f"Provider reports {remote_currency}; {booking.booking_ref} is "
            f"{expected_currency}.",
        )

    # ---- what the provider says the payment IS ---------------------------
    if remote.status == payment_providers.FAILED:
        # The provider itself says it failed. This is the only thing that may
        # make a payment failed, and it is applied forward-only.
        return _apply_non_capture(db, payment, remote, "provider_failed")

    if remote.status in (payment_providers.PENDING, payment_providers.PROCESSING):
        # Still in flight. NOT a failure and NOT a rejection -- the customer may
        # be halfway through approving it in their UPI app.
        _record_remote(payment, remote)
        db.flush()
        return _v(
            RETRYABLE, "not_yet_paid",
            f"Provider reports {remote.provider_status!r}; still in progress.",
            status=payment.status,
        )

    if remote.status not in (payment_providers.AUTHORIZED, payment_providers.CAPTURED):
        _record_remote(payment, remote)
        db.flush()
        return _v(
            RETRYABLE, "unexpected_provider_status",
            f"Provider reports {remote.provider_status!r}; not capturable.",
            status=payment.status,
        )

    # ---- the amount, last, because it is the one that decides ------------
    if remote.amount_minor is None:
        return _v(
            RETRYABLE, "provider_amount_missing",
            "The provider did not report an amount; will retry.",
            status=payment.status,
        )
    if int(remote.amount_minor) != expected_minor:
        return _reject(
            db, payment, booking, "amount_mismatch",
            f"Provider reports {remote.amount_minor} minor units; "
            f"{booking.booking_ref} is {expected_minor}.",
        )

    # ---- ownership -------------------------------------------------------
    # Everything above was about matching the PROVIDER's view; this is the one
    # check that is purely about ours.
    if payment.hotel_booking_id != booking.customer_hotel_booking_id:
        return _reject(
            db, payment, booking, "ownership_mismatch",
            "The payment row does not belong to the booking it was verified against.",
        )

    # ---- everything agrees -----------------------------------------------
    _record_remote(payment, remote)

    if remote.status == payment_providers.CAPTURED:
        # RECONCILE, DO NOT CAPTURE AGAIN. Razorpay auto-captures by default and
        # refuses a second capture with "the order is already paid".
        return _capture_locally(db, payment, booking, remote, "reconciled")

    # AUTHORIZED and every check passed. An authorised payment that is never
    # captured is auto-refunded by Razorpay after five days, so a late-authorised
    # payment would silently give the money back and leave the traveller with
    # nothing.
    try:
        captured = provider.capture(
            provider_payment_id=payment.provider_payment_id or "",
            amount_minor=expected_minor,        # OUR figure, not the provider's
            currency=expected_currency,
        )
    except payment_providers.PaymentTimeout as exc:
        logger.warning("Hotel capture timed out for payment %s: %s", payment_id, exc)
        db.flush()
        return _v(
            RETRYABLE, "capture_timeout",
            "The capture call timed out; will retry.", status=payment.status,
        )
    except payment_providers.PaymentProviderError as exc:
        logger.warning("Hotel capture refused for payment %s: %s", payment_id, exc)
        db.flush()
        return _v(
            RETRYABLE, "capture_refused",
            f"The provider refused the capture: {exc}", status=payment.status,
        )

    if captured.status != payment_providers.CAPTURED:
        db.flush()
        return _v(
            RETRYABLE, "capture_not_confirmed",
            f"Capture returned {captured.provider_status!r}, not captured.",
            status=payment.status,
        )

    _record_remote(payment, captured)
    return _capture_locally(db, payment, booking, captured, "captured")


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------
def _capture_locally(db: Session, payment, booking, remote, code: str) -> Verification:
    """The one write in this module that may set ``captured``."""
    payment.status = CustomerPaymentStatus.CAPTURED.value
    payment.paid_at = remote.paid_at or dt.datetime.now(dt.timezone.utc)
    db.flush()

    _audit(
        db, booking, "Payment captured",
        f"{booking.booking_ref}: {payment.currency} {payment.amount} verified "
        f"against {payment.provider} payment {payment.provider_payment_id} "
        f"({code}).",
    )
    logger.info(
        "Hotel payment captured: payment_id=%s booking=%s provider=%s code=%s",
        payment.customer_hotel_booking_payment_id, booking.booking_ref,
        payment.provider, code,
    )

    # SAME TRANSACTION, SAME LOCK ORDER. The payment row is already locked;
    # confirm_booking() takes the booking row next, so this path is
    # payment -> booking and can never be the other way round.
    confirmed_now = confirm_booking(db, payment, booking)

    return _v(
        DONE, code, "Verified against the provider and captured.",
        status=payment.status, captured_now=True, booking_confirmed_now=confirmed_now,
    )


def confirm_booking(db: Session, payment, booking) -> bool:
    """Move a hotel booking to CONFIRMED, once, on a captured payment.

    Returns True only if THIS call performed the confirmation.

    THE RULE, IN ONE LINE
    A booking is confirmed when a payment against it is ``captured`` and the
    captured amount equals the booking's own ``total_amount`` to the paisa.
    Nothing else confirms a booking: not a webhook body, not a redirect, not a
    browser, not an admin screen.

    WHY IT DOES NOT TOUCH ROOMS OR THE GUESTS
    Because ``create_booking`` already did. Room inventory is decremented when
    the booking is written -- that is what stops two people taking the last room
    while one of them is still typing. Confirming again here would decrement a
    second time. This function adds exactly one thing to the booking (its status)
    and one thing to the customer (a notification saying so).
    """
    # LOCK ORDER: payment -> booking. The caller holds the payment row lock.
    locked = db.execute(
        select(CustomerHotelBooking)
        .where(CustomerHotelBooking.customer_hotel_booking_id == booking.customer_hotel_booking_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if locked is None:
        return False

    # ---- idempotence, checked under the lock -----------------------------
    if locked.status == CustomerBookingStatus.CONFIRMED.value:
        # No second notification, no second audit entry.
        return False

    if locked.status in (
        CustomerBookingStatus.CANCELLED.value,
        CustomerBookingStatus.COMPLETED.value,
    ):
        # A cancelled booking that somehow received a capture is a refund
        # question for a human, not something to confirm automatically.
        logger.error(
            "CAPTURED PAYMENT ON A %s HOTEL BOOKING: %s payment_id=%s -- not "
            "confirming; needs manual review.",
            locked.status.upper(), locked.booking_ref,
            payment.customer_hotel_booking_payment_id,
        )
        _audit(
            db, locked, "Payment captured on a non-confirmable booking",
            f"{locked.booking_ref} is {locked.status}; payment "
            f"{payment.provider_payment_id} was captured. Needs review.",
            ok=False,
        )
        return False

    # ---- the two conditions ----------------------------------------------
    if payment.status != CustomerPaymentStatus.CAPTURED.value:
        logger.warning(
            "confirm_booking called for %s with a %s payment; refusing.",
            locked.booking_ref, payment.status,
        )
        return False

    expected_currency = (locked.currency or payment_providers.INR).upper()
    try:
        booking_minor = payment_providers.to_minor(
            Decimal(str(locked.total_amount or 0)), expected_currency
        )
        paid_minor = payment_providers.to_minor(
            Decimal(str(payment.amount or 0)),
            (payment.currency or expected_currency).upper(),
        )
    except payment_providers.PaymentProviderError as exc:
        logger.error("Cannot compare amounts for %s: %s", locked.booking_ref, exc)
        return False

    if (payment.currency or expected_currency).upper() != expected_currency:
        _audit(
            db, locked, "Booking not confirmed",
            f"{locked.booking_ref}: payment is {payment.currency}, booking is "
            f"{expected_currency}.",
            ok=False,
        )
        return False

    if paid_minor != booking_minor:
        # NO PARTIAL PAYMENTS. A capture for anything other than the exact total
        # leaves the booking unconfirmed and visible to a human.
        logger.error(
            "AMOUNT MISMATCH AT CONFIRMATION: %s captured %s, booking is %s (paise).",
            locked.booking_ref, paid_minor, booking_minor,
        )
        _audit(
            db, locked, "Booking not confirmed",
            f"{locked.booking_ref}: captured {paid_minor} paise but the booking "
            f"is {booking_minor} paise. Not confirmed; needs review.",
            ok=False,
        )
        return False

    # ---- confirm ----------------------------------------------------------
    previous = locked.status
    locked.status = CustomerBookingStatus.CONFIRMED.value
    db.flush()

    # DELIBERATELY NOT WRAPPED IN try/except. A failed INSERT poisons the
    # surrounding transaction, so swallowing it would leave every later statement
    # failing against a session that can no longer be used. Letting it raise
    # rolls the confirmation back cleanly and the sweep tries again.
    what = locked.hotel_name or "your stay"
    account_service.notify(
        db, locked.customer_id, "booking_confirmed",
        title="Booking confirmed",
        message=(
            f"Your payment for {what} has been received and "
            f"{locked.booking_ref} is confirmed."
        ),
        related_ref=locked.booking_ref,
    )

    _audit(
        db, locked, "Booking confirmed",
        f"{locked.booking_ref}: {previous} -> confirmed on captured payment "
        f"{payment.provider_payment_id} of {payment.currency} {payment.amount}.",
    )
    logger.info(
        "Hotel booking confirmed: %s (payment_id=%s)",
        locked.booking_ref, payment.customer_hotel_booking_payment_id,
    )
    return True


def _apply_non_capture(db: Session, payment, remote, code: str) -> Verification:
    """Apply a non-money status, forward-only."""
    _record_remote(payment, remote)
    current = payment.status
    if payment_providers.is_forward(current, remote.status):
        payment.status = remote.status
        db.flush()
        return _v(
            DONE, code, f"{current!r} -> {remote.status!r} on the provider's word.",
            status=payment.status,
        )
    db.flush()
    return _v(
        DONE, f"{code}_not_applied",
        f"{remote.status!r} does not advance {current!r}; no change.",
        status=payment.status,
    )


def _reject(db: Session, payment, booking, code: str, detail: str) -> Verification:
    """A mismatch. Nothing is captured, and it is recorded loudly.

    The payment status is NOT changed -- a mismatch means we do not know what is
    true, and writing ``failed`` would assert something we have not established.
    """
    db.flush()
    _audit(
        db, booking, "Payment verification rejected",
        f"{booking.booking_ref}: {code} -- {detail}",
        ok=False,
    )
    logger.error(
        "HOTEL PAYMENT VERIFICATION REJECTED: payment_id=%s booking=%s code=%s -- %s",
        payment.customer_hotel_booking_payment_id,
        booking.booking_ref if booking else "?", code, detail,
    )
    return _v(REJECTED, code, detail, status=payment.status)
