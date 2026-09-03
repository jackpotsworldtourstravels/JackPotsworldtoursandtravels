"""Deciding that money actually arrived — the only place that may.

NOTHING ELSE IN THIS CODEBASE MAY SET A PAYMENT TO ``captured``.
Not the browser, not the checkout endpoint, not the webhook handler. A webhook
proves who sent a message; a browser proves nothing at all. What this module
does instead is ask the provider directly, over an authenticated connection,
and then compare the answer against figures the server computed:

    lock the payment row
        -> already captured?  stop, nothing to do
    ask the provider what happened to this payment      (authenticated)
        -> compare order id     against ours
        -> compare payment id   against ours
        -> compare currency     against INR
        -> compare amount       against the booking total, in integer paise
        -> compare ownership    the payment's booking is the one we locked
    only then: reconcile, or capture and reconcile

THE COMPARISON IS AGAINST THE BOOKING, NOT AGAINST THE EVENT.
``payment_provider_events.payload`` is not read here for any figure. It said
what a signed message claimed; the booking row says what the customer agreed to
pay, and those are the two things that must agree. Using the payload's amount
would be verifying a message against itself.

MONEY IS INTEGER PAISE. ``Decimal`` in, ``int`` out, ``==`` between two ints.
No float appears in this module, and the conversion is the same ``to_minor``
the order was opened with, so the two figures are produced identically.

A TIMEOUT IS NOT A FAILURE.
The single most damaging bug available here is marking a payment failed because
the provider was slow. Every outcome below is classified as RETRYABLE or
TERMINAL, and every transport problem is retryable — the event stays
``deferred`` and the backlog sweep tries again. Only the provider itself saying
the payment failed can make a payment failed.

AND IT CONFIRMS THE BOOKING, IN THE SAME TRANSACTION (PHASE 7)
A capture that committed without confirming would leave a window where money
had been taken and the booking still said pending — and a crash inside that
window would leave it there permanently, with a paying customer holding an
unconfirmed trip. So :func:`confirm_booking` runs before the commit, under the
locks already held, and the two facts become true together or not at all.

THE LOCK ORDER IS PAYMENT -> BOOKING, EVERYWHERE.
:func:`verify_and_capture` takes the payment row; :func:`confirm_booking` takes
the booking row after it. Nothing in this codebase locks a booking before its
payment, and nothing should be added that does — two paths taking the same two
rows in opposite orders is the textbook deadlock, and it would show up as a
payment that intermittently hangs.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import logging
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerBookingStatus,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerPaymentStatus,
    PaymentProviderEvent,
)
from app.services import customer_account_service as account_service
from app.services import customer_audit_service
from app.services import payments as payment_providers

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Outcomes
# ---------------------------------------------------------------------------
#: Try again later — the answer is not knowable right now. The event stays
#: ``deferred`` so the backlog sweep picks it up.
RETRYABLE = "retryable"
#: Settled, correctly. Nothing more to do.
DONE = "done"
#: Settled, and wrong. A human must look. Never retried automatically, because
#: retrying a mismatch just produces the same mismatch.
REJECTED = "rejected"


@dataclasses.dataclass(frozen=True)
class Verification:
    """What happened, in a form a caller and a test can both branch on."""

    #: RETRYABLE | DONE | REJECTED
    disposition: str
    #: Stable machine-readable reason. Asserted by tests, logged, and written to
    #: the event row — never shown to a customer.
    code: str
    #: One sentence for an operator.
    detail: str
    #: The local payment status after this ran.
    payment_status: str | None = None
    #: True only when THIS call moved the payment to captured. False for an
    #: already-captured payment, so a caller can tell "I did it" from "it was
    #: already so" — which is what makes the concurrency test meaningful.
    captured_now: bool = False
    #: True only when THIS call moved the booking to confirmed. Separate from
    #: ``captured_now`` because the two can differ: a booking confirmed by an
    #: earlier pass is re-verified without being re-confirmed, and a capture
    #: whose amount no longer matches its booking is captured without being
    #: confirmed at all.
    booking_confirmed_now: bool = False

    @property
    def ok(self) -> bool:
        return self.disposition == DONE


def _v(disposition, code, detail, *, status=None, captured_now=False,
       booking_confirmed_now=False) -> Verification:
    return Verification(
        disposition, code, detail, status, captured_now, booking_confirmed_now,
    )


# ---------------------------------------------------------------------------
# The verification
# ---------------------------------------------------------------------------
def verify_and_capture(
    db: Session,
    payment_id: int,
    *,
    provider_name: str | None = None,
) -> Verification:
    """The authoritative path. Safe to call concurrently and repeatedly.

    ``payment_id`` is OUR primary key, never a provider identifier — the caller
    has already resolved which local row an event concerns, and re-resolving it
    from provider data here would give the payload a second chance to point us
    at a different row.
    """
    # ---- the row lock ----------------------------------------------------
    # populate_existing=True is not optional. Without it SQLAlchemy returns the
    # instance already in this session's identity map — the pre-lock values —
    # and the "is it already captured?" check below reads a stale status while
    # holding a lock that says it did not. That exact bug cost this codebase a
    # concurrency defect in the wallet ledger; see docs/WALLET_ARCHITECTURE.md.
    payment = db.execute(
        select(CustomerPackageBookingPayment)
        .where(CustomerPackageBookingPayment.customer_package_booking_payment_id == payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()

    if payment is None:
        return _v(REJECTED, "unknown_payment", f"No local payment {payment_id}.")

    # ---- already done? -----------------------------------------------------
    # Checked FIRST, under the lock, before any network call. This is what makes
    # six concurrent deliveries cost one provider round trip rather than six:
    # the winner captures, the other five arrive here and leave immediately.
    if payment.status == CustomerPaymentStatus.CAPTURED.value:
        return _v(
            DONE, "already_captured",
            "Already captured; nothing to do.",
            status=payment.status, captured_now=False,
        )
    if payment.status == CustomerPaymentStatus.REFUNDED.value:
        return _v(
            DONE, "already_refunded", "Already refunded; not re-capturing.",
            status=payment.status,
        )

    booking = db.get(CustomerPackageBooking, payment.package_booking_id)
    if booking is None:
        # A payment with no booking cannot be verified against anything.
        return _v(
            REJECTED, "orphan_payment",
            f"Payment {payment_id} has no booking {payment.package_booking_id}.",
            status=payment.status,
        )

    # ---- what we believe, computed from our own rows ----------------------
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

    # ---- ask the provider -------------------------------------------------
    try:
        provider = payment_providers.get_provider_named(
            provider_name or payment.provider or ""
        )
    except payment_providers.PaymentProviderError as exc:
        # The provider that took this payment is not the one configured now.
        # Retryable rather than rejected: reconfiguring is a deployment fix, and
        # the payment is not wrong.
        return _v(
            RETRYABLE, "provider_unavailable",
            f"Provider {payment.provider!r} is not available: {exc}",
            status=payment.status,
        )

    if not (payment.provider_payment_id or payment.provider_order_id):
        # Nothing to ask about yet. The customer opened a checkout and has not
        # paid; that is not an error and not something to retry aggressively.
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
        logger.warning("Verification timed out for payment %s: %s", payment_id, exc)
        return _v(
            RETRYABLE, "provider_timeout",
            "The provider did not answer in time; will retry.",
            status=payment.status,
        )
    except payment_providers.PaymentProviderError as exc:
        # Includes 5xx and unreachable. Also retryable, and also writes nothing.
        logger.warning("Verification could not reach the provider for %s: %s",
                       payment_id, exc)
        return _v(
            RETRYABLE, "provider_error",
            "The provider could not be reached; will retry.",
            status=payment.status,
        )

    # ---- the comparisons --------------------------------------------------
    # Order first: it is the strongest link between a provider payment and one
    # of our bookings, and a mismatch here means the rest is about someone else.
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

    # ---- what the provider says the payment IS ----------------------------
    if remote.status == payment_providers.FAILED:
        # The provider itself says it failed. This is the only thing that may
        # make a payment failed, and it is applied forward-only like any other
        # status so a late failure cannot undo a verified capture.
        return _apply_non_capture(db, payment, remote, "provider_failed")

    if remote.status in (
        payment_providers.PENDING,
        payment_providers.PROCESSING,
    ):
        # Still in flight. NOT a failure and NOT a rejection — the customer may
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

    # ---- the amount, last, because it is the one that decides -------------
    # Compared only for a payment that is actually about to become money. An
    # int == int, both produced by to_minor from a Decimal.
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

    # ---- ownership --------------------------------------------------------
    # The booking this payment row belongs to is the one we locked and priced.
    # Re-asserted rather than assumed, because everything above this line was
    # about matching the PROVIDER's view, and this is the one check that is
    # purely about ours.
    if payment.package_booking_id != booking.customer_package_booking_id:
        return _reject(
            db, payment, booking, "ownership_mismatch",
            "The payment row does not belong to the booking it was verified against.",
        )

    # ---- everything agrees ------------------------------------------------
    _record_remote(payment, remote)

    if remote.status == payment_providers.CAPTURED:
        # RECONCILE, DO NOT CAPTURE AGAIN. Razorpay auto-captures by default and
        # refuses a second capture with "the order is already paid" — issuing
        # one here would turn a healthy reconciliation into a spurious error.
        return _capture_locally(db, payment, booking, remote, "reconciled")

    # AUTHORIZED and every check passed. This is the case that genuinely needs
    # a capture call: an authorised payment that is never captured is
    # auto-refunded by Razorpay after five days, so a late-authorised payment
    # would silently give the money back and leave the traveller with nothing.
    try:
        captured = provider.capture(
            provider_payment_id=payment.provider_payment_id or "",
            amount_minor=expected_minor,        # OUR figure, not the provider's
            currency=expected_currency,
        )
    except payment_providers.PaymentTimeout as exc:
        logger.warning("Capture timed out for payment %s: %s", payment_id, exc)
        db.flush()
        return _v(
            RETRYABLE, "capture_timeout",
            "The capture call timed out; will retry.", status=payment.status,
        )
    except payment_providers.PaymentProviderError as exc:
        # Includes "already paid" if the provider captured between our fetch and
        # our call. Retryable: the next pass re-fetches and reconciles.
        logger.warning("Capture refused for payment %s: %s", payment_id, exc)
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
def _record_remote(payment: CustomerPackageBookingPayment, remote) -> None:
    """Copy the provider's own identifiers and words onto the row.

    Never the amount: our amount came from the booking and stays there. Storing
    the provider's figure would quietly make the two agree on a later read and
    destroy the evidence of a mismatch.
    """
    if remote.provider_payment_id and not payment.provider_payment_id:
        payment.provider_payment_id = remote.provider_payment_id
    if remote.provider_order_id and not payment.provider_order_id:
        payment.provider_order_id = remote.provider_order_id
    if remote.provider_status:
        payment.provider_status = remote.provider_status
    if remote.method:
        payment.method = remote.method
    if remote.failure_reason:
        payment.failure_reason = str(remote.failure_reason)[:255]


def _capture_locally(
    db: Session, payment, booking, remote, code: str
) -> Verification:
    """The one write in this codebase that may set ``captured``."""
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
        "Payment captured: payment_id=%s booking=%s provider=%s code=%s",
        payment.customer_package_booking_payment_id, booking.booking_ref,
        payment.provider, code,
    )

    # SAME TRANSACTION, SAME LOCK ORDER. The payment row is already locked by
    # verify_and_capture(); confirm_booking() takes the booking row next, so
    # this path is payment -> booking and can never be the other way round.
    # Committing the capture and confirming separately would leave a window in
    # which money had been taken and the booking still said pending — and a
    # crash in that window would leave it there permanently.
    confirmed_now = confirm_booking(db, payment, booking)

    return _v(
        DONE, code, "Verified against the provider and captured.",
        status=payment.status, captured_now=True, booking_confirmed_now=confirmed_now,
    )


def confirm_booking(db: Session, payment, booking) -> bool:
    """Move a booking to CONFIRMED, once, on the strength of a captured payment.

    Returns True only if THIS call performed the confirmation.

    THE RULE, IN ONE LINE
    A booking is confirmed when a payment against it is ``captured`` and the
    captured amount equals the booking's own ``total_amount`` to the paisa.
    Nothing else confirms a booking: not a webhook body, not a redirect, not a
    browser, not an admin screen. This function is the only writer of
    ``CustomerBookingStatus.CONFIRMED`` for a B2C package booking.

    WHY THE AMOUNT IS CHECKED AGAIN HERE
    Phase 6 already compared the provider's figure against the booking. This
    compares the LOCAL payment row against the booking, which is a different
    question: it catches a payment row that was captured for one booking and
    somehow points at another, and it is the check that would still hold if a
    future caller reached this function by some other route. Both comparisons
    are integer paise from ``to_minor``; no float appears.

    WHY IT DOES NOT TOUCH SEATS, THE REFERENCE, OR THE TRAVELLERS
    Because ``create_booking`` already did. Seats are decremented when the
    booking is written — that is what stops two people buying the last seat
    while one of them is still typing their passport number — and the reference
    comes from its sequence at the same moment. Confirming again here would
    decrement a second time and quietly oversell the departure. This function
    adds exactly one thing to the booking (its status) and one thing to the
    customer (a notification saying so).
    """
    # LOCK ORDER: payment -> booking. The caller holds the payment row lock
    # already. Taking them in this order everywhere is what prevents a deadlock
    # against any other path; there is no code in this codebase that locks a
    # booking before its payment, and none should be added.
    locked = db.execute(
        select(CustomerPackageBooking)
        .where(
            CustomerPackageBooking.customer_package_booking_id
            == booking.customer_package_booking_id
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if locked is None:
        return False

    # ---- idempotence, checked under the lock ----------------------------
    if locked.status == CustomerBookingStatus.CONFIRMED.value:
        # Already confirmed. No second notification, no second audit entry —
        # "no duplicate confirmation side effect" is the requirement, and a
        # traveller being told twice that their booking is confirmed is exactly
        # the kind of duplicate that gets noticed.
        return False

    if locked.status in (
        CustomerBookingStatus.CANCELLED.value,
        CustomerBookingStatus.COMPLETED.value,
    ):
        # A cancelled booking that somehow received a capture is a refund
        # question for a human, not something to confirm automatically.
        logger.error(
            "CAPTURED PAYMENT ON A %s BOOKING: %s payment_id=%s — not confirming; "
            "needs manual review.",
            locked.status.upper(), locked.booking_ref,
            payment.customer_package_booking_payment_id,
        )
        _audit(
            db, locked, "Payment captured on a non-confirmable booking",
            f"{locked.booking_ref} is {locked.status}; payment "
            f"{payment.provider_payment_id} was captured. Needs review.",
            ok=False,
        )
        return False

    # ---- the two conditions ---------------------------------------------
    if payment.status != CustomerPaymentStatus.CAPTURED.value:
        # Reachable only if a future caller invokes this directly. Refused
        # rather than trusted, because this function's whole value is that its
        # precondition is checked here and not assumed by its callers.
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
            Decimal(str(payment.amount or 0)), (payment.currency or expected_currency).upper()
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
        # NO PARTIAL PAYMENTS. A capture for anything other than the exact
        # total leaves the booking unconfirmed and visible to a human. Treating
        # a short payment as "part paid" would be a new lifecycle nobody has
        # designed, and treating it as confirmed would give away a trip.
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

    # ---- confirm ---------------------------------------------------------
    previous = locked.status
    locked.status = CustomerBookingStatus.CONFIRMED.value
    db.flush()

    # SIDE EFFECTS, ONCE. Seats and the reference are NOT touched — see the
    # docstring. The notification is new information (the trip is now certain),
    # so it is written here and nowhere else.
    #
    # DELIBERATELY NOT WRAPPED IN try/except.
    # It was, and that was a bug: a failed INSERT poisons the surrounding
    # transaction, so swallowing the exception left every later statement in
    # this confirmation failing against a session that could no longer be used.
    # "Protecting" the capture from a notification failure achieved the exact
    # opposite. Letting it raise rolls the whole confirmation back cleanly, the
    # event stays deferred, and the sweep tries again — which is the behaviour
    # every other failure in this module already has.
    account_service.notify(
        db, locked.customer_id, "booking_confirmed",
        title="Booking confirmed",
        message=(
            f"Your payment for {locked.package_name} has been received and "
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
        "Booking confirmed: %s (payment_id=%s)",
        locked.booking_ref, payment.customer_package_booking_payment_id,
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

    The payment status is NOT changed — a mismatch means we do not know what is
    true, and writing ``failed`` would assert something we have not established.
    It stays where it was, and a human decides.
    """
    db.flush()
    _audit(
        db, booking, "Payment verification rejected",
        f"{booking.booking_ref}: {code} — {detail}",
        ok=False,
    )
    logger.error(
        "PAYMENT VERIFICATION REJECTED: payment_id=%s booking=%s code=%s — %s",
        payment.customer_package_booking_payment_id,
        booking.booking_ref if booking else "?", code, detail,
    )
    return _v(REJECTED, code, detail, status=payment.status)


def _audit(db: Session, booking, action: str, description: str, *, ok: bool = True) -> None:
    """Record on the customer's own audit trail.

    A webhook has no session, but it always concerns exactly one customer — the
    one who owns the booking — and that is whose timeline this belongs on. No
    secret, no card detail and no provider credential appears in ``description``;
    it names identifiers and figures only.
    """
    from app.models_customer import CustomerAuditStatus

    customer = db.get(Customer, booking.customer_id) if booking else None
    # commit=False: THIS AUDIT ROW IS PART OF THE CAPTURE'S TRANSACTION.
    #
    # The default committed here, which meant the capture became durable before
    # confirm_booking() had run — and a failure after that point left a payment
    # ``captured`` against a ``pending`` booking, unrecoverable by rollback.
    # Not wrapped in try/except either: a swallowed database error leaves the
    # session poisoned and every later statement in this transaction failing,
    # which is the same trap the notification call fell into in Phase 7.
    customer_audit_service.log(
        db, customer, action,
        module="Payments",
        description=description[:1000],
        status=CustomerAuditStatus.SUCCESS if ok else CustomerAuditStatus.FAILED,
        commit=False,
    )


# ---------------------------------------------------------------------------
# The deferred backlog
# ---------------------------------------------------------------------------
def process_deferred_events(db: Session, *, limit: int = 100) -> dict[str, int]:
    """Drain ``payment_provider_events`` rows left ``deferred`` by Phase 5.

    THE SAME PATH AS A LIVE WEBHOOK. This function resolves the payment and
    calls :func:`verify_and_capture`; it has no verification logic of its own,
    so a backlog event cannot be treated more leniently than a fresh one.

    Nothing is ever deleted. A row that cannot be resolved is marked ``ignored``
    with a reason and kept, because an event we could not act on is exactly what
    an operator needs to find later.
    """
    from app.services import payment_event_service as pes

    rows = db.execute(
        select(PaymentProviderEvent)
        .where(PaymentProviderEvent.processing_status == pes.DEFERRED)
        .order_by(PaymentProviderEvent.received_at)
        .limit(limit)
    ).scalars().all()

    tally = {"seen": len(rows), "captured": 0, "retryable": 0,
             "rejected": 0, "ignored": 0, "done": 0}

    for row in rows:
        payment = _payment_for_event(db, row)
        if payment is None:
            row.processing_status = pes.IGNORED
            row.processing_note = (
                f"No local payment for provider_payment_id="
                f"{row.provider_payment_id!r} order_id={row.provider_order_id!r}."
            )
            row.processed_at = dt.datetime.now(dt.timezone.utc)
            tally["ignored"] += 1
            db.commit()
            continue

        result = verify_and_capture(
            db, payment.customer_package_booking_payment_id,
            provider_name=row.provider,
        )

        if result.disposition == RETRYABLE:
            # LEFT DEFERRED ON PURPOSE, so the next sweep tries again. Only the
            # note is updated, so an operator can see what it is waiting on.
            row.processing_note = f"{result.code}: {result.detail}"[:2000]
            tally["retryable"] += 1
        else:
            row.processing_status = (
                pes.PROCESSED if result.disposition == DONE else pes.FAILED
            )
            row.processing_note = f"{result.code}: {result.detail}"[:2000]
            row.processed_at = dt.datetime.now(dt.timezone.utc)
            tally["rejected" if result.disposition == REJECTED else "done"] += 1
        if result.captured_now:
            tally["captured"] += 1
        db.commit()

    return tally


def _payment_for_event(db: Session, row: PaymentProviderEvent):
    """The local payment an event row concerns, by provider identifier only."""
    if row.provider_payment_id:
        found = db.execute(
            select(CustomerPackageBookingPayment).where(
                CustomerPackageBookingPayment.provider == row.provider,
                CustomerPackageBookingPayment.provider_payment_id == row.provider_payment_id,
            )
        ).scalar_one_or_none()
        if found is not None:
            return found
    if row.provider_order_id:
        return db.execute(
            select(CustomerPackageBookingPayment).where(
                CustomerPackageBookingPayment.provider == row.provider,
                CustomerPackageBookingPayment.provider_order_id == row.provider_order_id,
            )
        ).scalar_one_or_none()
    return None
