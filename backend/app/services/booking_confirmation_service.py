"""booking_confirmation_service.py — the customer's booking-confirmation
email and SMS (Phase 2 Bug 1).

ONE SEAM FOR THREE PRODUCTS. A flight, hotel or package booking is confirmed in
exactly one place — ``confirm_booking`` in the matching
``payment_verification_*`` service — and that is the only place this service is
enqueued from. Five different request paths reach those functions (the three
customer routers, the payment webhook sweep and the admin manual-confirm), so
enqueuing at ``confirm_booking`` rather than at a router gives every path a
confirmation with no per-call-site wiring to forget.

ENQUEUE IS ATOMIC WITH THE CONFIRMATION; SENDING IS NOT.
:func:`enqueue` only writes outbox rows (``customer_booking_notifications``),
in the SAME transaction that flips the booking to CONFIRMED. It performs no
network I/O, so it can never roll a confirmation back over a slow mail server,
and a booking that rolls back takes its queued confirmation with it. The actual
email/SMS is sent later by :func:`process_pending`, driven by a background sweep
(``main._confirmation_outbox_loop``) — the same shape the completion and
payment sweeps already use, and the honest answer for a platform with no queue
worker. Sending is best-effort and never raises: each row records its own
outcome (``sent`` / ``failed`` / ``suppressed``) and a failed row is retried on
later sweeps until ``settings.booking_confirmation_max_attempts``.

IDEMPOTENT PER (booking_ref, channel). The outbox has a unique index on those
two columns and :func:`enqueue` checks it first, so a redelivered gateway
callback that re-enters ``confirm_booking`` — or any retry — cannot stack a
second confirmation.

NEVER EXPOSES SENSITIVE DATA. The composed copy carries a reference, an
itinerary and an amount with its currency. No card number, no gateway token, no
credential is read or written. Phone numbers are masked wherever they are
logged (see ``sms_service.mask_number``).
"""
from __future__ import annotations

import datetime as dt
import html
import logging
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models_customer import Customer, CustomerBookingNotification
from app.services import (
    customer_notification_preferences_service as notification_preferences,
    email_service,
    sms_service,
)

logger = logging.getLogger("jackpots.booking_confirmation")

PRODUCTS = ("flight", "hotel", "package")
_EMAIL = "email"
_SMS = "sms"

_QUEUED = "queued"
_SENT = "sent"
_FAILED = "failed"
_SUPPRESSED = "suppressed"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _bookings_link() -> str:
    return f"{settings.frontend_base_url.rstrip('/')}/my-bookings"


def _money(amount, currency: str | None) -> str:
    """``INR 12,345.00`` — the booking total, never a card or account number."""
    cur = (currency or "INR").upper()
    try:
        value = Decimal(str(amount or 0))
    except Exception:  # noqa: BLE001 — a malformed total must not break a confirmation
        return f"{cur} {amount}"
    return f"{cur} {value:,.2f}"


# ---------------------------------------------------------------------------
# Composing the copy — one function per product, each returning the lines the
# email and the SMS are built from. Kept data-light on purpose.
# ---------------------------------------------------------------------------
def _flight_lines(b) -> tuple[str, list[str], str]:
    route = " → ".join(p for p in (b.origin_city, b.destination_city) if p)
    flight = " ".join(p for p in (getattr(b, "airline", None), getattr(b, "flight_number", None)) if p)
    headline = route or flight or "your flight"
    lines: list[str] = []
    if flight:
        lines.append(f"Flight: {flight}")
    if route:
        lines.append(f"Route: {route}")
    if b.travel_date:
        when = b.travel_date.isoformat()
        times = " – ".join(p for p in (getattr(b, "departure_time", None), getattr(b, "arrival_time", None)) if p)
        lines.append(f"Date: {when}" + (f" ({times})" if times else ""))
    if getattr(b, "cabin_class", None):
        lines.append(f"Cabin: {b.cabin_class}")
    if getattr(b, "pnr", None):
        lines.append(f"PNR: {b.pnr}")
    return headline, lines, "flight"


def _hotel_lines(b) -> tuple[str, list[str], str]:
    headline = getattr(b, "hotel_name", None) or "your stay"
    lines: list[str] = [f"Hotel: {headline}"]
    if getattr(b, "hotel_location", None):
        lines.append(f"Location: {b.hotel_location}")
    if getattr(b, "room_name", None):
        lines.append(f"Room: {b.room_name}")
    if getattr(b, "check_in_date", None) and getattr(b, "check_out_date", None):
        nights = getattr(b, "nights", None)
        suffix = f" ({nights} night{'s' if nights != 1 else ''})" if nights else ""
        lines.append(f"Stay: {b.check_in_date.isoformat()} to {b.check_out_date.isoformat()}{suffix}")
    rooms = getattr(b, "rooms_count", None)
    if rooms:
        lines.append(f"Rooms: {rooms}")
    return headline, lines, "hotel"


def _package_lines(b) -> tuple[str, list[str], str]:
    headline = getattr(b, "package_name", None) or "your package"
    lines: list[str] = [f"Package: {headline}"]
    if getattr(b, "package_days", None):
        lines.append(f"Duration: {b.package_days} day(s)")
    if getattr(b, "departure_date", None):
        lines.append(f"Departure: {b.departure_date.isoformat()}")
    if getattr(b, "pax_count", None):
        lines.append(f"Travellers: {b.pax_count}")
    return headline, lines, "package"


_COMPOSERS = {"flight": _flight_lines, "hotel": _hotel_lines, "package": _package_lines}


def _compose(product: str, booking, customer: Customer) -> tuple[str, str, str]:
    """Return ``(subject, email_text_body, sms_body)`` for one booking.

    The e-ticket/voucher lives on the customer's My Bookings page; the email and
    SMS link there rather than attaching a document, so nothing sensitive rides
    in the message and the link always reflects the booking's current state.
    """
    headline, detail_lines, _ = _COMPOSERS[product](booking)
    ref = booking.booking_ref
    total = _money(getattr(booking, "total_amount", None), getattr(booking, "currency", None))
    name = (customer.full_name or "there").strip()
    link = _bookings_link()

    subject = f"Booking confirmed — {ref}"

    body_lines = [
        f"Hi {name},",
        "",
        f"Good news — your booking is confirmed and your payment has been received.",
        "",
        f"Booking reference: {ref}",
    ]
    body_lines += detail_lines
    body_lines += [
        f"Amount paid: {total}",
        "",
        f"View your booking, e-ticket and vouchers here: {link}",
        "",
        "Thank you for booking with JackPots World Tours & Travels.",
    ]
    email_text = "\n".join(body_lines)

    # SMS: one tight line. No link is added when SMS is the channel only if the
    # body would blow past a couple of segments; the My Bookings link is short.
    sms_body = (
        f"JackPots: Booking {ref} for {headline} is CONFIRMED. "
        f"Amount paid {total}. Details: {link}"
    )
    return subject, email_text, sms_body


def _text_to_html(subject: str, text_body: str) -> str:
    """Wrap the plain-text body in the same minimal branded shell the rest of
    ``email_service`` uses. The text body is the source of truth; this only
    styles it, so the two can never disagree."""
    safe = html.escape(text_body).replace("\n", "<br>")
    return f"""
    <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#0A2540;">
      <h2 style="color:#0A2540;">{html.escape(subject)}</h2>
      <div style="white-space:pre-wrap; font-size:14px; line-height:1.6;">{safe}</div>
      <hr style="border:none; border-top:1px solid #eee; margin:24px 0;">
      <p style="font-size:12px; color:#888;">JackPots World Tours &amp; Travels</p>
    </div>
    """


# ---------------------------------------------------------------------------
# Enqueue — atomic with the confirmation, no I/O
# ---------------------------------------------------------------------------
def enqueue(db: Session, booking, product: str) -> list[CustomerBookingNotification]:
    """Queue the confirmation email (and SMS, when a mobile is on file) for one
    just-confirmed booking. Writes outbox rows only; sends nothing.

    Called from ``confirm_booking`` right after the in-app notification. In the
    normal case the rows commit in the SAME transaction that confirms the
    booking, so a confirmation and its queued messages are atomic.

    BUT QUEUING IS BEST-EFFORT AND NEVER BREAKS THE CONFIRMATION. The write runs
    inside a SAVEPOINT (``begin_nested``): if it fails for any reason — a
    transient error, or a caller whose transaction has no outbox table — the
    savepoint is rolled back, the failure is logged, and the surrounding
    confirmation transaction is left clean and committable. A captured payment
    must still confirm the booking even if the courtesy email could not be
    queued; this is the same "delivery never breaks the booking" rule the
    in-app notification layer already follows. The savepoint is also what keeps
    a failed INSERT from poisoning the caller's transaction.

    Idempotent: an already-queued (or already-sent) ``(booking_ref, channel)``
    is left untouched and returned, so a re-entry cannot double-send. Returns
    the rows for this booking (``[]`` if queuing was skipped or failed) so a
    caller or test can act on them immediately.
    """
    if not settings.booking_confirmation_enabled:
        return []
    if product not in PRODUCTS:
        logger.error("enqueue() called with unknown product %r for %s", product, getattr(booking, "booking_ref", "?"))
        return []

    try:
        rows: list[CustomerBookingNotification] = []
        with db.begin_nested():
            customer = db.get(Customer, booking.customer_id)
            if customer is None:
                logger.warning("No customer %s for booking %s; cannot enqueue confirmation.",
                               booking.customer_id, booking.booking_ref)
                return []

            subject, email_text, sms_body = _compose(product, booking, customer)

            wanted: list[tuple[str, str | None, str, str]] = []  # (channel, recipient, subject, body)
            if customer.email:
                wanted.append((_EMAIL, customer.email, subject, email_text))
            if customer.mobile:
                wanted.append((_SMS, customer.mobile, subject, sms_body))

            # Issue #21: respect the customer's channel opt-ins. Booking messages
            # are transactional, so the lookup is FAIL-OPEN (a preference outage
            # never swallows a confirmation) — see booking_channels_allowed. A
            # customer who explicitly turned a channel off is honoured; in-app
            # notification is unaffected and already written by the caller.
            allowed = notification_preferences.booking_channels_allowed(db, customer.customer_id)
            wanted = [w for w in wanted if allowed.get(w[0], True)]

            for channel, recipient, subj, body in wanted:
                existing = db.scalar(
                    select(CustomerBookingNotification).where(
                        CustomerBookingNotification.booking_ref == booking.booking_ref,
                        CustomerBookingNotification.channel == channel,
                    )
                )
                if existing is not None:
                    rows.append(existing)
                    continue
                row = CustomerBookingNotification(
                    booking_ref=booking.booking_ref,
                    product=product,
                    customer_id=customer.customer_id,
                    channel=channel,
                    recipient=recipient or "",
                    subject=subj if channel == _EMAIL else None,
                    body=body,
                    status=_QUEUED,
                    attempts=0,
                )
                db.add(row)
                rows.append(row)
            # Flush inside the savepoint so the unique index is checked now; any
            # failure rolls back only this savepoint (see the docstring).
            db.flush()
        return rows
    except Exception:  # noqa: BLE001 — queuing a courtesy message must not break a confirmation
        logger.exception(
            "Could not queue the booking confirmation for %s; the booking is confirmed regardless.",
            getattr(booking, "booking_ref", "?"),
        )
        return []


def resend(db: Session, booking, product: str) -> list[CustomerBookingNotification]:
    """Re-queue the confirmation for a booking so the sweep sends it again (Issue
    #16 — "Resend Booking Confirmation").

    SECURITY / HONESTY. This only RE-QUEUES an outbox row for a booking the
    caller already owns and that is confirmed — it recomposes the message from
    the booking's CURRENT state and the customer's CURRENT contact details, so a
    resend can never leak a stale address or be used to send to an arbitrary
    recipient. It writes nothing but the outbox and never sends inline; the
    existing best-effort sweep (:func:`process_pending`) does the delivery, with
    the same attempt cap and "never report delivered on failure" rule.

    A booking with no confirmation rows yet (its first confirmation was skipped
    or predates the outbox) is handled by :func:`enqueue`. Rows that already
    exist are reset to ``queued`` with ``attempts`` zeroed and any prior error
    cleared, so a previously ``sent`` or ``failed`` confirmation goes out again.
    A channel the customer has opted out of for booking updates (Issue #21) is
    left untouched. Returns the affected rows (``[]`` when confirmations are
    disabled).
    """
    if not settings.booking_confirmation_enabled:
        return []
    if product not in PRODUCTS:
        logger.error("resend() called with unknown product %r for %s", product, getattr(booking, "booking_ref", "?"))
        return []
    existing = list(db.scalars(
        select(CustomerBookingNotification).where(
            CustomerBookingNotification.booking_ref == booking.booking_ref,
        )
    ).all())
    if not existing:
        # No confirmation was ever queued for this booking — create it now.
        return enqueue(db, booking, product)

    customer = db.get(Customer, booking.customer_id)
    if customer is None:
        logger.warning("No customer %s for booking %s; cannot resend confirmation.",
                       booking.customer_id, booking.booking_ref)
        return []
    # Issue #21: respect the customer's channel opt-ins (FAIL-OPEN, as enqueue).
    allowed = notification_preferences.booking_channels_allowed(db, customer.customer_id)
    subject, email_text, sms_body = _compose(product, booking, customer)
    requeued: list[CustomerBookingNotification] = []
    for row in existing:
        # A channel the customer turned off for booking updates is left untouched
        # rather than re-sent.
        if not allowed.get(row.channel, True):
            continue
        if row.channel == _EMAIL and customer.email:
            row.recipient, row.subject, row.body = customer.email, subject, email_text
        elif row.channel == _SMS and customer.mobile:
            row.recipient, row.body = customer.mobile, sms_body
        row.status = _QUEUED
        row.attempts = 0
        row.error_message = None
        row.sent_at = None
        requeued.append(row)
    db.flush()
    return requeued


# ---------------------------------------------------------------------------
# Sending — best-effort, driven by the sweep
# ---------------------------------------------------------------------------
def _send_one(db: Session, row: CustomerBookingNotification) -> str:
    """Attempt one row and record the outcome on it. Returns the new status.
    Never raises — a provider fault becomes ``failed``, not an exception."""
    row.attempts += 1
    if row.channel == _EMAIL:
        html_body = _text_to_html(row.subject or "Booking confirmed", row.body)
        smtp_configured = bool(settings.smtp_host and settings.smtp_from_email)
        try:
            ok = email_service._send(row.recipient, row.subject or "Booking confirmed", row.body, html_body)
        except Exception as exc:  # noqa: BLE001 — email must never break the sweep
            row.status = _FAILED
            row.error_message = f"{type(exc).__name__}: {exc}"[:1000]
            return row.status
        if ok:
            row.status = _SENT
            row.sent_at = _now()
            row.error_message = None
        elif not smtp_configured:
            # Nothing is wrong — the platform simply has no mail server here.
            # Terminal, not retried, and distinct from a refusal.
            row.status = _SUPPRESSED
            row.error_message = "SMTP is not configured; email not sent."
        else:
            row.status = _FAILED
            row.error_message = "The mail server refused the message."
        return row.status

    # SMS
    result = sms_service.send(row.recipient, row.body)
    if result.suppressed:
        row.status = _SUPPRESSED
        row.error_message = result.detail[:1000]
    elif result.ok:
        row.status = _SENT
        row.sent_at = _now()
        row.error_message = None
    else:
        row.status = _FAILED
        row.error_message = result.detail[:1000]
    return row.status


def _pending_stmt(limit: int, booking_ref: str | None = None):
    stmt = select(CustomerBookingNotification).where(
        CustomerBookingNotification.status.in_((_QUEUED, _FAILED)),
        CustomerBookingNotification.attempts < settings.booking_confirmation_max_attempts,
    )
    if booking_ref is not None:
        stmt = stmt.where(CustomerBookingNotification.booking_ref == booking_ref)
    return stmt.order_by(CustomerBookingNotification.created_at.asc()).limit(limit)


def process_pending(db: Session, limit: int | None = None, *, booking_ref: str | None = None) -> dict:
    """Send every queued/retriable confirmation, oldest first. Returns a tally.

    Each row is committed on its own, so one bad address never strands the rest
    and a sweep that dies halfway keeps what it has already sent. A row that has
    exhausted its attempts is skipped by the query — it stays ``failed`` and is
    visible to staff via :func:`failed`.
    """
    limit = limit or settings.booking_confirmation_batch_size
    tally = {"seen": 0, "sent": 0, "failed": 0, "suppressed": 0}
    rows = list(db.scalars(_pending_stmt(limit, booking_ref)).all())
    for row in rows:
        tally["seen"] += 1
        try:
            status = _send_one(db, row)
            db.commit()
        except Exception:  # noqa: BLE001 — a DB error on one row must not kill the sweep
            db.rollback()
            logger.exception("Could not process confirmation %s; leaving it queued.",
                             row.customer_booking_notification_id)
            continue
        if status == _SENT:
            tally["sent"] += 1
        elif status == _SUPPRESSED:
            tally["suppressed"] += 1
        else:
            tally["failed"] += 1
    return tally


def failed(db: Session, *, page: int = 1, page_size: int = 20) -> tuple[list[CustomerBookingNotification], int]:
    """Confirmations that have exhausted their retries, newest first — the
    staff-visible failure list, the same idea ``delivery_service.failed_messages``
    gives merchant mail."""
    from sqlalchemy import func

    where = (
        CustomerBookingNotification.status == _FAILED,
        CustomerBookingNotification.attempts >= settings.booking_confirmation_max_attempts,
    )
    total = db.scalar(select(func.count()).select_from(CustomerBookingNotification).where(*where)) or 0
    rows = db.scalars(
        select(CustomerBookingNotification).where(*where)
        .order_by(CustomerBookingNotification.updated_at.desc())
        .limit(page_size).offset((page - 1) * page_size)
    ).all()
    return list(rows), total
