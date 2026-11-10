"""Supplier guard for FLIGHT bookings: nothing is paid for, or confirmed, without a supplier behind it.

WHAT THIS IS, AND WHAT IT IS NOT
This is a SAFETY NET. It is not supplier booking support. Nothing in this
codebase creates a supplier order or reads back a PNR yet, so a flight sold
against a live supplier cannot be confirmed by this platform today -- and this
module's job is to make that fact impossible to miss rather than to paper over
it. Offer revalidation (``flight_supplier_service.revalidate_offer``) re-reads an
offer and checks it has not expired and its price has not moved. It does NOT
reserve a seat. Passing it means "worth asking the customer to pay for", never
"booked".

THE THREE RULES (flights only; hotels and packages hold their own inventory when
the booking is written and are deliberately untouched)

1. DEMO FLIGHTS ARE UNCHANGED. A booking that is not tied to a live supplier, on a
   deployment whose ``FLIGHT_SUPPLIER`` is ``demo``, passes straight through. That
   is every flight booking on a laptop and on HDFC UAT.

2. BEFORE A CHECKOUT OPENS (``assert_checkout_allowed``). A booking tied to a live
   supplier -- or ANY flight booking while ``FLIGHT_SUPPLIER`` is not ``demo`` --
   must carry a supplier offer id and the price the customer was shown, and the
   offer must pass revalidation right now. Anything else, including the supplier
   being unreachable, refuses the checkout with the neutral "not available"
   message BEFORE any payment row exists. Also: LIVE HDFC refuses a flight that
   has no live supplier behind it, because it would take real money for a flight
   nobody can ticket. HDFC UAT/test is not affected.

3. BEFORE A BOOKING IS CONFIRMED (``hold_if_unreserved``). A live-supplier flight
   is confirmed only when it carries a valid ``supplier_order_id``. If a payment
   is captured and there is none, the payment STAYS captured (the money is never
   lost), the booking STAYS pending, an audit entry says so ONCE, and no
   confirmation notification is sent. The booking is marked
   ``supplier_status = reservation_missing``; that marker is also what makes
   repeated webhooks, returns and sweeps harmless -- the second delivery finds
   the marker and does nothing.

HOW A HELD BOOKING IS RESOLVED (two doors, both explicit and audited)
* ``complete_reservation`` -- an operator who has secured the reservation with the
  supplier records its order id; the booking is then confirmed, once, through the
  same ``confirm_booking`` every other flight uses.
* Cancelling the held booking flags "refund owed" on the customer's audit trail
  (``flag_refund_owed``) so the existing Cancellations desk picks up the refund,
  exactly as a cancelled package does. No refund is issued automatically.
"""
from __future__ import annotations

import logging
import re
from decimal import Decimal

import app.config
from app.services.payments.base import PaymentProviderError

logger = logging.getLogger(__name__)

DEMO = "demo"
#: Suppliers this platform knows how to revalidate. Anything else that claims to
#: be a live supplier is refused rather than trusted.
SUPPORTED_LIVE_SUPPLIERS = ("duffel",)
#: Written to ``supplier_status`` while a captured payment waits for a supplier
#: order. It is OUR marker, not a supplier status, and is cleared on resolution.
RESERVATION_MISSING = "reservation_missing"

_NEUTRAL = "Online payment is not available on this booking."
_ORDER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{2,79}$")


class SupplierUnavailable(PaymentProviderError):
    """A flight cannot be paid for right now because its supplier backing fails.

    A :class:`PaymentProviderError` on purpose: the checkout route already turns
    that family into a 503 carrying ``customer_message`` and nothing else, so the
    customer never sees a supplier's wording and never learns which check failed.
    ``code`` says which, for the log and for tests.
    """

    code = "supplier_unavailable"
    customer_message = _NEUTRAL


# ---------------------------------------------------------------------------
# Predicates
# ---------------------------------------------------------------------------
def _settings():
    return app.config.settings


def active_supplier() -> str:
    from app.services import flight_supplier_service as supplier

    return supplier.active_provider()


def booking_supplier(booking) -> str:
    return (getattr(booking, "supplier", None) or "").strip().lower()


def requires_live_supplier(booking) -> bool:
    """Must this flight be backed by a supplier reservation?

    True when the booking itself names a non-demo supplier, OR the deployment's
    ``FLIGHT_SUPPLIER`` is not ``demo`` (so even a booking with no supplier
    reference is refused: a live-supplier deployment never sells an unbacked
    flight).
    """
    named = booking_supplier(booking)
    if named and named != DEMO:
        return True
    return active_supplier() != DEMO


def live_payments_environment() -> bool:
    env = str(getattr(_settings(), "payment_environment", "") or "").strip().lower()
    return env in ("live", "production")


def is_live_hdfc(provider_name: str | None) -> bool:
    """HDFC collecting REAL money. UAT/test is deliberately not this."""
    return (provider_name or "").strip().lower() == "hdfc" and live_payments_environment()


def valid_order_id(value) -> bool:
    return bool(_ORDER_ID_RE.match(str(value or "").strip()))


# ---------------------------------------------------------------------------
# 1. Before a checkout opens
# ---------------------------------------------------------------------------
def assert_live_payment_allowed(booking, provider_name: str | None) -> None:
    """Refuse live HDFC for a flight no live supplier stands behind."""
    if is_live_hdfc(provider_name) and not requires_live_supplier(booking):
        logger.error(
            "Flight checkout refused: %s would be paid through LIVE HDFC but "
            "FLIGHT_SUPPLIER=demo, so no supplier can ever reserve or ticket it. "
            "Real money is not taken for a demo flight.",
            getattr(booking, "booking_ref", "?"),
        )
        raise SupplierUnavailable(
            "Live HDFC payments are refused for flights while FLIGHT_SUPPLIER=demo.",
            code="live_payment_demo_supplier",
        )


def assert_supplier_ready(booking) -> None:
    """For a live-supplier flight: the offer is still there at the price shown."""
    if not requires_live_supplier(booking):
        return

    ref = getattr(booking, "booking_ref", "?")
    supplier_name = booking_supplier(booking) or active_supplier()
    if supplier_name not in SUPPORTED_LIVE_SUPPLIERS:
        logger.error("Flight checkout refused: %s names unsupported supplier %r.",
                     ref, supplier_name)
        raise SupplierUnavailable(
            f"Unsupported flight supplier {supplier_name!r}.", code="supplier_unsupported",
        )

    offer_id = str(getattr(booking, "supplier_offer_id", None) or "").strip()
    if not offer_id:
        logger.error("Flight checkout refused: %s has no supplier offer id.", ref)
        raise SupplierUnavailable("No supplier offer id on this booking.",
                                  code="supplier_offer_missing")

    shown = getattr(booking, "supplier_total_amount", None)
    if shown is None:
        # Without the price the customer was shown, revalidation could not catch a
        # price change -- which is half of what it is for.
        logger.error("Flight checkout refused: %s has no supplier price on record.", ref)
        raise SupplierUnavailable("No supplier price on this booking.",
                                  code="supplier_price_missing")

    from app.integrations.duffel.exceptions import (
        DuffelAPIError,
        DuffelNotConfigured,
        DuffelOfferExpired,
        DuffelPriceChanged,
        DuffelTimeout,
        DuffelTransportError,
    )
    from app.services import flight_supplier_service as supplier

    try:
        supplier.revalidate_offer(offer_id, shown_amount=str(Decimal(str(shown))))
    except DuffelOfferExpired as exc:
        logger.warning("Flight checkout refused: %s offer expired (%s).", ref, exc)
        raise SupplierUnavailable("The supplier offer has expired.",
                                  code="supplier_offer_expired") from exc
    except DuffelPriceChanged as exc:
        logger.warning("Flight checkout refused: %s supplier price changed.", ref)
        raise SupplierUnavailable("The supplier price has changed.",
                                  code="supplier_price_changed") from exc
    except DuffelNotConfigured as exc:
        logger.error("Flight checkout refused: the flight supplier is not configured.")
        raise SupplierUnavailable("The flight supplier is not configured.",
                                  code="supplier_not_configured") from exc
    except (DuffelTimeout, DuffelTransportError, DuffelAPIError) as exc:
        # FAIL CLOSED: not being able to ask is not permission to sell.
        logger.warning("Flight checkout refused: %s supplier unreachable (%s).",
                       ref, type(exc).__name__)
        raise SupplierUnavailable("The flight supplier could not be reached.",
                                  code="supplier_unreachable") from exc


def assert_checkout_allowed(booking, provider_name: str | None) -> None:
    """Every flight checkout entry point calls this before a payment row exists."""
    assert_live_payment_allowed(booking, provider_name)
    assert_supplier_ready(booking)


# ---------------------------------------------------------------------------
# 2. Before a booking is confirmed
# ---------------------------------------------------------------------------
def _hold_reason(booking, payment) -> str | None:
    """Why this booking may not be confirmed yet, or ``None`` if it may."""
    if requires_live_supplier(booking):
        if valid_order_id(getattr(booking, "supplier_order_id", None)):
            return None
        return "no supplier order id"
    if is_live_hdfc(getattr(payment, "provider", None)):
        # Defence in depth: a live-money payment captured for a flight no supplier
        # backs (the checkout gate above should have refused it).
        return "live payment on a demo-supplier flight"
    return None


def hold_if_unreserved(db, booking, payment) -> bool:
    """Called by ``confirm_booking`` with the booking row locked.

    Returns ``True`` if the booking MAY be confirmed. Returns ``False`` if it must
    stay unconfirmed -- in which case the booking has been marked and ONE audit
    entry written. Repeat calls (duplicate webhook, return, sweep) find the marker
    and write nothing: no second audit entry, no notification, no side effect.
    """
    reason = _hold_reason(booking, payment)
    if reason is None:
        return True

    if booking.supplier_status == RESERVATION_MISSING:
        return False

    from app.services.payment_verification_service import _audit

    booking.supplier_status = RESERVATION_MISSING
    db.flush()
    logger.error(
        "PAID BUT NOT RESERVED: %s payment_id=%s is captured but %s. The booking "
        "stays unconfirmed; needs manual reconciliation or a refund.",
        booking.booking_ref, getattr(payment, "customer_booking_payment_id", "?"), reason,
    )
    _audit(
        db, booking, "Payment captured, supplier reservation missing",
        f"{booking.booking_ref}: payment {getattr(payment, 'provider_payment_id', None)} of "
        f"{payment.currency} {payment.amount} is captured but {reason}. Not confirmed and "
        f"no confirmation sent. Complete the reservation with the supplier and record its "
        f"order id, or cancel the booking to refund the customer.",
        ok=False,
    )
    return False


# ---------------------------------------------------------------------------
# 3. Resolving a held booking
# ---------------------------------------------------------------------------
def held_bookings(db, *, limit: int = 100) -> list[dict]:
    """Flight bookings holding a captured payment with no supplier reservation."""
    from sqlalchemy import select

    from app.models_customer import (
        CustomerBooking,
        CustomerBookingPayment,
        CustomerBookingStatus,
        CustomerPaymentStatus,
    )

    rows = db.execute(
        select(CustomerBooking, CustomerBookingPayment)
        .join(
            CustomerBookingPayment,
            CustomerBookingPayment.customer_booking_id == CustomerBooking.customer_booking_id,
        )
        .where(
            CustomerBooking.supplier_status == RESERVATION_MISSING,
            CustomerBooking.status == CustomerBookingStatus.PENDING.value,
            CustomerBookingPayment.status == CustomerPaymentStatus.CAPTURED.value,
        )
        .order_by(CustomerBookingPayment.paid_at.desc().nullslast())
        .limit(limit)
    ).all()
    return [
        {
            "booking_ref": b.booking_ref,
            "payment_id": p.customer_booking_payment_id,
            "provider": p.provider,
            "amount": p.amount,
            "currency": p.currency,
            "paid_at": p.paid_at,
        }
        for b, p in rows
    ]


def complete_reservation(
    db, booking_ref: str, *, supplier_order_id: str, supplier_status: str | None = None,
    pnr: str | None = None,
) -> str:
    """Record a supplier order against a held booking and confirm it, once.

    The caller commits. Returns a short stable code: ``confirmed``,
    ``already_confirmed``, ``not_found``, ``invalid_order_id``, ``not_applicable``
    or ``no_captured_payment``.

    LOCK ORDER IS payment -> booking, the same as every other path, so this cannot
    deadlock against a webhook. THE ORDER ID IS AN ADMINISTRATOR ATTESTATION, NOT
    A SUPPLIER-VERIFIED RESERVATION: this platform does not (yet) fetch the order
    from the supplier to check it exists, and every record of it says "attested"
    rather than implying otherwise. Never describe it as automated verification.
    """
    from sqlalchemy import select

    from app.models_customer import (
        CustomerBooking,
        CustomerBookingPayment,
        CustomerBookingStatus,
        CustomerPaymentStatus,
    )
    from app.services import payment_verification_flight_service as flight_verify

    order_id = str(supplier_order_id or "").strip()
    if not valid_order_id(order_id):
        return "invalid_order_id"

    ref = (booking_ref or "").strip()
    booking = db.execute(
        select(CustomerBooking).where(CustomerBooking.booking_ref == ref)
    ).scalar_one_or_none()
    if booking is None:
        return "not_found"

    payment = db.execute(
        select(CustomerBookingPayment)
        .where(
            CustomerBookingPayment.customer_booking_id == booking.customer_booking_id,
            CustomerBookingPayment.status == CustomerPaymentStatus.CAPTURED.value,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalars().first()
    if payment is None:
        return "no_captured_payment"

    locked = db.execute(
        select(CustomerBooking)
        .where(CustomerBooking.customer_booking_id == booking.customer_booking_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()

    if locked.status == CustomerBookingStatus.CONFIRMED.value:
        return "already_confirmed"
    if locked.supplier_status != RESERVATION_MISSING:
        # Only a booking this guard is holding. Not a way to rewrite any booking.
        return "not_applicable"
    if locked.status != CustomerBookingStatus.PENDING.value:
        # Cancelled or completed: an invalid transition. Nothing is written, so
        # no attestation is recorded against a booking that cannot be confirmed.
        return "not_applicable"

    locked.supplier_order_id = order_id
    locked.supplier_status = (supplier_status or "confirmed")[:40]
    if pnr:
        locked.pnr = str(pnr).strip()[:10] or locked.pnr
    db.flush()

    # THE RECORD THAT SAYS WHAT THIS IS. The order id was typed by an
    # administrator; nothing here asked the supplier whether it exists. The
    # trail says "attested" so no one reading it later mistakes it for a
    # supplier-verified reservation.
    from app.models_customer import Customer, CustomerAuditStatus
    from app.services import customer_audit_service

    customer_audit_service.log(
        db, db.get(Customer, locked.customer_id),
        "Supplier order id recorded by an administrator (attested, not supplier-verified)",
        module="Payments",
        description=(
            f"{locked.booking_ref}: supplier order {order_id} was entered by an "
            f"administrator. It is an attestation; the platform did not verify it "
            f"with the supplier."
        )[:1000],
        status=CustomerAuditStatus.SUCCESS,
        commit=False,
    )

    confirmed = flight_verify.confirm_booking(db, payment, locked)
    return "confirmed" if confirmed else "not_applicable"


def flag_refund_owed(db, booking, payment) -> None:
    """A held booking was cancelled while holding the customer's money.

    Issues NO refund and decides NO amount -- the same contract as the package
    flow's refund flag. It makes the case findable on the customer's trail so the
    Cancellations desk can run the refund.
    """
    from app.models_customer import Customer, CustomerAuditStatus
    from app.services import customer_audit_service

    logger.error(
        "REFUND OWED: %s was cancelled holding a captured payment with no supplier "
        "reservation (payment_id=%s). No refund is issued automatically.",
        booking.booking_ref, getattr(payment, "customer_booking_payment_id", "?"),
    )
    customer_audit_service.log(
        db, db.get(Customer, booking.customer_id),
        "Cancelled with a captured payment and no supplier reservation — refund owed",
        module="Payments",
        description=(
            f"{booking.booking_ref} was cancelled while payment "
            f"{getattr(payment, 'provider_payment_id', None) or getattr(payment, 'customer_booking_payment_id', '?')} "
            f"was captured for {payment.amount} {payment.currency} and no supplier "
            f"reservation existed. No refund has been issued."
        )[:1000],
        status=CustomerAuditStatus.FAILED,
        commit=False,
    )
