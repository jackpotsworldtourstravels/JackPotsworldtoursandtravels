"""The customer-facing service registry — read, write, and enforcement.

One global row per travel service (see ``ServiceRegistry`` in
``models_customer``). Three jobs:

* **Admin desk** (``list_all`` / ``get_by_code`` / ``update_service`` /
  ``set_order``): the B2C Service Management screen writes here.
* **Public nav feed** (``public_services``): the storefront's navigation and
  homepage tiles are built from this, so disabling a service removes it from the
  customer's view without a frontend deploy.
* **Enforcement** (``availability`` / ``assert_available`` /
  ``require_service_available``): search and new-booking endpoints call the
  dependency; a disabled service is refused (403) and one in maintenance is
  refused (503), while existing-booking endpoints never call it and stay open.

FAIL-OPEN on the enforcement path only. If the registry table is missing (a
half-applied migration) or a service has no row, the gate treats the service as
available rather than taking a working production flow down over registry
plumbing. The admin read/write paths do NOT fail open — they surface real
errors.
"""
from __future__ import annotations

import datetime as dt
import logging

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.session import get_db
from app.models_customer import ServiceRegistry

logger = logging.getLogger("jackpots.service_registry")

#: Every service code the platform knows about. The registry is seeded with
#: exactly these (migration 0102); kept here so validation and tests have one
#: source of truth independent of what rows currently exist.
KNOWN_CODES: tuple[str, ...] = (
    "flights", "hotels", "villas", "packages", "trains", "buses", "cabs",
    "activities", "visa", "forex", "insurance",
)

INTEGRATION_STATUSES: tuple[str, ...] = ("live", "preview", "enquiry", "coming_soon")

#: Fields an admin may write. ``code`` is immutable (it keys enforcement and
#: the frontend icon map); everything else is editable.
_UPDATABLE = frozenset({
    "name", "description", "href", "icon", "enabled", "nav_visible",
    "home_visible", "nav_order", "maintenance_mode", "maintenance_message",
    "integration_status", "provider",
})


# ----------------------------------------------------------------- admin reads
def list_all(db: Session) -> list[ServiceRegistry]:
    """Every service, ordered as the nav would render it. Admin view."""
    return list(
        db.scalars(
            select(ServiceRegistry).order_by(
                ServiceRegistry.nav_order, ServiceRegistry.service_registry_id
            )
        ).all()
    )


def get_by_code(db: Session, code: str) -> ServiceRegistry | None:
    return db.scalars(
        select(ServiceRegistry).where(ServiceRegistry.code == (code or "").strip().lower())
    ).one_or_none()


# ---------------------------------------------------------------- admin writes
def update_service(db: Session, code: str, data: dict) -> ServiceRegistry | None:
    """Partial update of one service. Only whitelisted, provided keys change.

    Returns the updated row, or ``None`` if there is no service with ``code``.
    Does not commit — the caller owns the transaction (so the audit row written
    alongside it is atomic with the change).
    """
    row = get_by_code(db, code)
    if row is None:
        return None
    changed = False
    for key, value in data.items():
        if key in _UPDATABLE and getattr(row, key) != value:
            setattr(row, key, value)
            changed = True
    if changed:
        row.updated_at = dt.datetime.now(dt.timezone.utc)
        db.flush()
    return row


def set_order(db: Session, ordered_codes: list[str]) -> list[ServiceRegistry]:
    """Set ``nav_order`` from the position of each code in ``ordered_codes``.

    Spacing by tens leaves room to insert later without renumbering everything.
    Unknown codes are ignored. Does not commit.
    """
    by_code = {r.code: r for r in list_all(db)}
    for position, code in enumerate(ordered_codes):
        row = by_code.get((code or "").strip().lower())
        if row is not None:
            row.nav_order = (position + 1) * 10
            row.updated_at = dt.datetime.now(dt.timezone.utc)
    db.flush()
    return list_all(db)


# --------------------------------------------------------------- public feed
def _public_dict(row: ServiceRegistry) -> dict:
    return {
        "code": row.code,
        "name": row.name,
        "href": row.href,
        "icon": row.icon,
        "nav_order": row.nav_order,
        "home_visible": row.home_visible,
        "maintenance_mode": row.maintenance_mode,
        "maintenance_message": row.maintenance_message,
        "integration_status": row.integration_status,
    }


def public_services(db: Session) -> list[dict]:
    """Services the storefront should show in navigation: enabled AND nav_visible,
    ordered. A service in maintenance is still listed (so the customer sees it
    with a notice); a disabled one is omitted entirely."""
    rows = db.scalars(
        select(ServiceRegistry)
        .where(ServiceRegistry.enabled.is_(True), ServiceRegistry.nav_visible.is_(True))
        .order_by(ServiceRegistry.nav_order, ServiceRegistry.service_registry_id)
    ).all()
    return [_public_dict(r) for r in rows]


# --------------------------------------------------------------- enforcement
#: Status returned by :func:`availability`.
AVAILABLE = "available"
DISABLED = "disabled"
MAINTENANCE = "maintenance"

_DISABLED_MSG = "This service is currently unavailable."
_MAINTENANCE_MSG = "This service is temporarily unavailable for maintenance. Please try again later."


def availability(db: Session, code: str) -> tuple[str, str | None]:
    """``(state, message)`` for a service code, where state is one of
    ``AVAILABLE`` / ``DISABLED`` / ``MAINTENANCE``.

    FAIL-OPEN: any lookup failure (table absent, no row) yields ``AVAILABLE`` so
    a registry problem never takes a working flow offline.
    """
    try:
        row = get_by_code(db, code)
    except Exception:  # noqa: BLE001 — registry plumbing must not break bookings
        logger.exception("service_registry lookup failed for %r; failing open", code)
        return AVAILABLE, None
    if row is None:
        return AVAILABLE, None
    if not row.enabled:
        return DISABLED, _DISABLED_MSG
    if row.maintenance_mode:
        return MAINTENANCE, row.maintenance_message or _MAINTENANCE_MSG
    return AVAILABLE, None


def assert_available(db: Session, code: str) -> None:
    """Raise if the service is disabled (403) or in maintenance (503).

    Used by search and NEW-booking endpoints. Existing-booking endpoints (pay,
    cancel, view, reconcile, resend) deliberately never call this, so a service
    can be switched off without stranding bookings already made (requirement 9).
    """
    state, message = availability(db, code)
    if state == DISABLED:
        raise HTTPException(status.HTTP_403_FORBIDDEN, message)
    if state == MAINTENANCE:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, message)


def require_service_available(code: str):
    """FastAPI dependency factory: gate an endpoint on service ``code``.

    Usage::

        @router.get("/flights/search",
                    dependencies=[Depends(require_service_available("flights"))])
    """

    def _dep(db: Session = Depends(get_db)) -> None:
        assert_available(db, code)

    return _dep
