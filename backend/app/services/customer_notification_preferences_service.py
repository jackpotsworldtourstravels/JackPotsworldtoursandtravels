"""Issue #21 — per-customer notification channel preferences.

Two categories (booking, promo) over two channels (email, SMS). Booking
(transactional) defaults ON; promotional defaults OFF (strictly opt-in). A read
never writes: a customer with no row is served the defaults. These preferences
are consulted when email/SMS are queued, but the booking category is FAIL-OPEN —
a preference-service outage must never swallow a confirmation. In-app
notifications (``CustomerNotification``) are not governed here and are always
delivered.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerNotificationPreferences

logger = logging.getLogger(__name__)

#: Column -> default. Booking on, promo off.
DEFAULTS: dict[str, bool] = {
    "booking_email": True,
    "booking_sms": True,
    "promo_email": False,
    "promo_sms": False,
}
FIELDS: tuple[str, ...] = tuple(DEFAULTS)


def _row(db: Session, customer_id: int) -> CustomerNotificationPreferences | None:
    return db.scalar(
        select(CustomerNotificationPreferences).where(
            CustomerNotificationPreferences.customer_id == customer_id
        )
    )


def as_dict(row: CustomerNotificationPreferences | None) -> dict[str, bool]:
    if row is None:
        return dict(DEFAULTS)
    return {f: bool(getattr(row, f)) for f in FIELDS}


def get(db: Session, customer: Customer) -> dict[str, bool]:
    """The customer's current preferences. Never creates a row — absence means
    all-defaults, so a GET is a pure read."""
    return as_dict(_row(db, customer.customer_id))


def update(db: Session, customer: Customer, changes: dict[str, bool | None]) -> dict[str, bool]:
    """Set some or all switches; creates the row (seeded with the defaults) on
    first write. Keys absent or ``None`` are left unchanged."""
    row = _row(db, customer.customer_id)
    if row is None:
        row = CustomerNotificationPreferences(customer_id=customer.customer_id, **DEFAULTS)
        db.add(row)
    for field in FIELDS:
        value = changes.get(field)
        if value is not None:
            setattr(row, field, bool(value))
    db.flush()
    return as_dict(row)


def allows(db: Session, customer_id: int, channel: str, category: str) -> bool:
    """Whether a ``category`` ('booking' | 'promo') message may be sent on
    ``channel`` ('email' | 'sms').

    FAIL-OPEN for booking: any lookup error is treated as allowed, because a
    transactional confirmation must survive a preference-service outage.
    Promotional stays OFF on error (opt-in only).
    """
    field = f"{category}_{channel}"
    if field not in DEFAULTS:
        return False
    try:
        row = _row(db, customer_id)
    except Exception:  # noqa: BLE001 — a preference outage must not swallow a confirmation
        logger.warning(
            "notification-preference lookup failed for customer %s; using fail-open default.",
            customer_id, exc_info=True,
        )
        return True if category == "booking" else DEFAULTS[field]
    if row is None:
        return DEFAULTS[field]
    return bool(getattr(row, field))


def booking_channels_allowed(db: Session, customer_id: int) -> dict[str, bool]:
    """``{'email': bool, 'sms': bool}`` for BOOKING (transactional) messages.

    FAIL-OPEN: a confirmation must never be swallowed by a preference-service
    problem. The read runs inside its OWN savepoint so that, on a backend where a
    failed statement aborts the surrounding transaction (PostgreSQL), the failure
    is contained here and the caller's confirmation transaction stays clean.
    """
    try:
        with db.begin_nested():
            row = _row(db, customer_id)
            allowed = {
                "email": DEFAULTS["booking_email"] if row is None else bool(row.booking_email),
                "sms": DEFAULTS["booking_sms"] if row is None else bool(row.booking_sms),
            }
        return allowed
    except Exception:  # noqa: BLE001 — never let a preference outage swallow a confirmation
        logger.warning(
            "booking notification-preference lookup failed for customer %s; sending on all channels.",
            customer_id, exc_info=True,
        )
        return {"email": True, "sms": True}
