"""Customer flight e-ticket: a signed token per booking, and the QR that carries it.

(Not to be confused with ``ticket_service`` / ``routers.tickets``, which are the
merchant ticket-request lifecycle.)

THE QR CARRIES A LINK, NOT A BOOKING. It encodes
``{public base}/ticket/verify/{token}``; the token is a signed JWT holding the
booking reference and an expiry, nothing else. Nothing private (no payment,
passport, contact or card data) goes into the QR, and a booking reference alone
opens nothing - so a guessed ``JPB000027`` cannot be turned into a ticket.

The token is DETERMINISTIC for a booking (no issued-at claim): the QR on the
screen, on the printed page and on a ticket opened next week is the same code.
It expires a fixed time after travel, and the verifier re-reads the booking, so
a cancellation is reflected the moment it happens - the token never says
"valid", the database does.
"""
from __future__ import annotations

import datetime as dt
import io
from decimal import Decimal, InvalidOperation

import qrcode
import qrcode.constants
import qrcode.image.svg
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.models_customer import (
    CustomerBooking,
    CustomerBookingStatus,
    CustomerPaymentStatus,
)

TOKEN_TYPE = "eticket"
#: How long after the travel date a ticket still verifies (lost-luggage claims,
#: disputes). Without a travel date it is a year from creation.
GRACE_DAYS = 180

#: A ticket exists only once the booking has reached one of these states. Both
#: are set by ``confirm_booking`` AFTER the provider capture is verified against
#: the booking's own amount — never by a browser status or a webhook body.
TICKETABLE_STATUSES = frozenset(
    {CustomerBookingStatus.CONFIRMED.value, CustomerBookingStatus.COMPLETED.value}
)


def _enum_value(v) -> str:
    return v.value if hasattr(v, "value") else str(v)


def eligibility(booking: CustomerBooking) -> tuple[bool, str]:
    """Server-side e-ticket eligibility, computed ONLY from our own rows.

    Issue #2 — a valid ticket (token, QR, PNR) must never be reachable before a
    booking is genuinely paid. A booking is eligible only when BOTH hold:

      1. its status is CONFIRMED or COMPLETED (``confirm_booking`` sets these
         after the provider capture has been verified server-side), and
      2. it carries a CAPTURED payment whose amount and currency equal the
         booking's own total — re-checked here, independently, so a status that
         somehow ran ahead of the money still yields no ticket.

    This reads no request input: not a client-sent status, not a webhook body.
    Returns ``(eligible, reason)``; ``reason`` is one of ``cancelled``,
    ``not_confirmed``, ``unpaid``, ``amount_mismatch``, ``unusable_amount`` or
    ``eligible``.
    """
    status = _enum_value(booking.status)
    if status == CustomerBookingStatus.CANCELLED.value:
        return False, "cancelled"
    if status not in TICKETABLE_STATUSES:
        return False, "not_confirmed"

    captured = [
        p for p in (booking.payments or [])
        if _enum_value(p.status) == CustomerPaymentStatus.CAPTURED.value
    ]
    if not captured:
        return False, "unpaid"

    try:
        total = Decimal(str(booking.total_amount if booking.total_amount is not None else 0))
    except (InvalidOperation, TypeError, ValueError):
        return False, "unusable_amount"
    if total <= 0:
        return False, "unusable_amount"
    currency = (booking.currency or "INR").upper()

    for p in captured:
        try:
            amount = Decimal(str(p.amount if p.amount is not None else 0))
        except (InvalidOperation, TypeError, ValueError):
            continue
        if amount == total and (p.currency or "INR").upper() == currency:
            return True, "eligible"
    return False, "amount_mismatch"


def is_eligible(booking: CustomerBooking) -> bool:
    return eligibility(booking)[0]


def make_token(booking: CustomerBooking) -> str:
    if booking.travel_date:
        expires_on = booking.travel_date + dt.timedelta(days=GRACE_DAYS)
    else:
        created = booking.created_at.date() if booking.created_at else dt.date.today()
        expires_on = created + dt.timedelta(days=365)
    expires = dt.datetime.combine(expires_on, dt.time.min, tzinfo=dt.timezone.utc)
    return jwt.encode(
        {"typ": TOKEN_TYPE, "ref": booking.booking_ref, "exp": int(expires.timestamp())},
        settings.jwt_secret_key, algorithm=settings.jwt_algorithm,
    )


def read_token(token: str) -> str | None:
    """The booking reference a token vouches for, or None if forged/expired."""
    try:
        claims = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    if claims.get("typ") != TOKEN_TYPE or not isinstance(claims.get("ref"), str):
        return None
    return claims["ref"]


def verify_url(base: str, token: str) -> str:
    return f"{base.rstrip('/')}/ticket/verify/{token}"


def qr_svg(data: str) -> str:
    """A real, scannable QR as an inline SVG (vector, so it stays crisp when
    printed or scaled). Error correction M, with the standard 4-module quiet zone."""
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4,
        image_factory=qrcode.image.svg.SvgPathImage,
    )
    qr.add_data(data)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image().save(buf)
    return buf.getvalue().decode("utf-8")


def get_by_ref(db: Session, booking_ref: str) -> CustomerBooking | None:
    return db.execute(
        select(CustomerBooking)
        .options(
            selectinload(CustomerBooking.passengers),
            selectinload(CustomerBooking.payments),
        )
        .where(CustomerBooking.booking_ref == booking_ref)
    ).scalar_one_or_none()


def public_view(booking: CustomerBooking) -> dict:
    """What the public verification page may see: enough to match a person to a
    flight at a desk, and nothing about money, documents or contact details."""
    status = booking.status.value if hasattr(booking.status, "value") else str(booking.status)
    return {
        "valid": status != "cancelled",
        "status": status,
        "booking_ref": booking.booking_ref,
        "airline": booking.airline,
        "flight_number": booking.flight_number,
        "origin_code": booking.origin_code, "origin_city": booking.origin_city,
        "destination_code": booking.destination_code, "destination_city": booking.destination_city,
        "travel_date": booking.travel_date.isoformat() if booking.travel_date else None,
        "departure_time": booking.departure_time, "arrival_time": booking.arrival_time,
        "passengers": [f"{p.first_name} {p.last_name}".strip() for p in booking.passengers],
    }


def company_contact() -> dict:
    return {
        "name": "JackPots World Tours & Travels",
        "email": settings.company_email or "support@jackpotsworldtours.com",
        "phone": settings.company_phone or "+91 9177847799",
        "website": settings.company_website or "jackpotsworldtours.com",
    }
