"""B2C customer account ACTIONS for the admin desk (Stage 3 M1) — block /
unblock.

Writes, unlike the read-only ``customer_admin_service`` next to it. These
functions MUTATE the ``Customer`` (and its ``CustomerAuth``) in the caller's
session but **do not commit** — the router commits so the status change and its
``record_in_session`` audit row land in one transaction (fail-closed: if the
audit write fails, the status change rolls back with it).

Nothing here imports ``app.models_v2``: a customer's account state lives wholly
in the ``customer_*`` tables, and the two identity systems stay separate.

No new table: block/unblock use the existing ``customers.status`` and the same
``customer_auth.force_logout_at`` session-revocation field the password-reset
flow already uses (0044 onward).
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerStatus


class CustomerActionError(Exception):
    """A block/unblock refused on business-rule grounds (maps to HTTP 409).

    Raised BEFORE any mutation, so the caller's session is left untouched."""


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _status_value(status) -> str:
    return status.value if hasattr(status, "value") else str(status)


def block_customer(db: Session, customer: Customer) -> dict:
    """Set an ACTIVE customer BLOCKED and immediately invalidate live sessions.

    STATUS SEMANTICS (M1 correction). Block is defined ONLY as ``active→blocked``
    (plan §3). We deliberately do **not** block an ``inactive`` or ``suspended``
    customer: there is no column to remember their prior status (no Stage-3
    migration), so blocking them would strand that status and a later unblock
    would wrongly reactivate them. Those statuses are refused with
    :class:`CustomerActionError` (409) and left exactly as they are. Re-blocking
    an already-``blocked`` customer is an idempotent no-op success (and refreshes
    ``force_logout_at``).

    ``customer_deps`` already refuses a BLOCKED customer and honours
    ``force_logout_at``, so setting both stops existing tokens at once and
    refuses further auth. Bookings and payments are untouched — status is an auth
    concern only. Mutates only; the caller commits (atomic with the audit row)."""
    current = customer.status
    if current is CustomerStatus.BLOCKED:
        if customer.auth is not None:
            customer.auth.force_logout_at = _now()
        return {"from_status": "blocked", "to_status": "blocked", "changed": False}
    if current is not CustomerStatus.ACTIVE:
        raise CustomerActionError(
            f"Only an active customer can be blocked (current status: {_status_value(current)}). "
            "Unblock only reverses a block and will not change this status."
        )
    customer.status = CustomerStatus.BLOCKED
    if customer.auth is not None:
        customer.auth.force_logout_at = _now()
    return {"from_status": "active", "to_status": "blocked", "changed": True}


def unblock_customer(db: Session, customer: Customer) -> dict:
    """Reverse a block: ``blocked→active`` ONLY.

    STATUS SEMANTICS (M1 correction). Unblock lifts a block and nothing else. It
    restores login eligibility for a ``blocked`` customer and is otherwise a
    no-op or a refusal — crucially it NEVER reactivates an ``inactive`` or
    ``suspended`` customer (those are not blocked, so unblocking them is refused
    with :class:`CustomerActionError`, 409, leaving the status untouched).
    Unblocking an already-``active`` customer is an idempotent no-op success.

    ``force_logout_at`` is deliberately left as-is, so tokens issued before the
    block stay dead and the customer logs in afresh. Mutates only; caller commits."""
    current = customer.status
    if current is CustomerStatus.ACTIVE:
        return {"from_status": "active", "to_status": "active", "changed": False}
    if current is not CustomerStatus.BLOCKED:
        raise CustomerActionError(
            f"Only a blocked customer can be unblocked (current status: {_status_value(current)}). "
            "Unblock will not reactivate an inactive or suspended customer."
        )
    customer.status = CustomerStatus.ACTIVE
    return {"from_status": "blocked", "to_status": "active", "changed": True}
