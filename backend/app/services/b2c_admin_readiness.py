"""B2C admin audit READINESS gate (Stage 3 M0).

Every B2C-admin operation that writes an audit row through
``customer_admin_audit_service.record_in_session`` (or the refund Approach-C
hook) persists that row in the SAME transaction as the business change. If the
``customer_admin_audit_logs`` table is absent (migration 0095 not applied) or
its schema is incompatible, that transaction's commit would FAIL and roll the
whole business operation back with a 500 — correct fail-closed behaviour, but a
poor experience and a money-path hazard (e.g. a refund's provider call made
just before the failing commit).

This gate moves that failure to the DOOR: :func:`require_audit_ready` is a
FastAPI dependency that returns **503** *before any business work runs* when the
audit store is not usable. It does NOT swallow a SUCCESS audit failure and does
NOT weaken atomicity — it refuses an operation that could not be audited.

Scope: applied per-endpoint to the audited B2C-admin operations only. Unaudited
reads (lists, dashboards, analytics) and all B2B functionality are untouched —
B2B audits via the always-present ``audit_logs`` trigger and ``system_logs``,
not this table.

Testability: readiness is evaluated against the ENGINE BOUND TO THE REQUEST'S
session (``db.get_bind()``), so the SQLite test harness (which creates the table)
reads as ready, and a harness that omits the table reads as not-ready — matching
production, where the real Postgres engine is inspected.

Cache correctness (Stage 3 M0 correction): readiness is RE-VALIDATED, not
trusted forever. The probe result is cached only while it is *ready* and only
for :data:`READY_TTL_SECONDS` (0 by default ⇒ every call re-probes). A
not-ready result is never cached, so applying migration 0095 later makes the
next call ready without an application restart; and an audit table dropped after
a prior success makes the very next protected operation fail closed. The cache
is keyed by a WEAK reference to the engine object, so a discarded engine's entry
disappears with it and a recycled ``id()`` can never resurrect a stale result.
"""
from __future__ import annotations

import logging
import threading
import time
import weakref

from fastapi import Depends, HTTPException, status
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.database.session import get_db
from app.models_customer import CustomerAdminAuditLog

logger = logging.getLogger("jackpots.b2c_audit_readiness")

TABLE = CustomerAdminAuditLog.__tablename__
#: Every column the model declares — used for the schema-compatibility check so
#: a half-applied / outdated 0095 also fails closed.
_EXPECTED_COLUMNS = frozenset(c.name for c in CustomerAdminAuditLog.__table__.columns)

#: Positive-cache lifetime, seconds. ``0.0`` (default) RE-VALIDATES on every
#: call, so a table dropped after a prior success makes the next protected
#: operation fail closed. Raise it only to trade a bounded, known window of
#: staleness for fewer catalogue look-ups. A NOT-ready result is never cached at
#: any value, so applying 0095 later always takes effect on the next call.
READY_TTL_SECONDS = 0.0

#: engine -> monotonic time it was last CONFIRMED ready. Weak keys: a discarded
#: engine drops out automatically, so a recycled ``id()`` cannot resurrect a
#: stale "ready". Not-ready engines are never stored here.
_ready_at: "weakref.WeakKeyDictionary[object, float]" = weakref.WeakKeyDictionary()
_last_reason: "weakref.WeakKeyDictionary[object, str]" = weakref.WeakKeyDictionary()
_lock = threading.Lock()


def clear_cache() -> None:
    """Forget all cached readiness. For tests, and safe to call after a migration."""
    with _lock:
        _ready_at.clear()
        _last_reason.clear()


def _cached_ready(bind: object, now: float) -> bool:
    """A live, non-expired *ready* entry for ``bind``? Only consulted when
    ``READY_TTL_SECONDS > 0``; a not-ready engine is never stored, so this can
    only ever return True (a cache HIT on ready) or fall through to a re-probe."""
    try:
        with _lock:
            ts = _ready_at.get(bind)
    except TypeError:  # bind not weak-referenceable / hashable ⇒ do not cache
        return False
    return ts is not None and (now - ts) <= READY_TTL_SECONDS


def _remember(bind: object, ok: bool, why: str, now: float) -> None:
    try:
        with _lock:
            _last_reason[bind] = why
            if ok:
                _ready_at[bind] = now
            else:
                _ready_at.pop(bind, None)  # never cache a not-ready result
    except TypeError:  # bind not weak-referenceable ⇒ simply skip caching
        pass


def _probe(bind: Engine) -> tuple[bool, str]:
    try:
        insp = sa_inspect(bind)
        if not insp.has_table(TABLE):
            return False, f"table {TABLE!r} absent (migration 0095 not applied)"
        cols = {c["name"] for c in insp.get_columns(TABLE)}
        missing = _EXPECTED_COLUMNS - cols
        if missing:
            return False, f"schema incompatible; missing columns: {sorted(missing)}"
        return True, "ready"
    except Exception as exc:  # noqa: BLE001 — DB/audit storage unavailable ⇒ fail closed
        return False, f"audit storage unavailable: {exc}"


def is_ready(bind: Engine) -> bool:
    """True only when the audit table exists on ``bind`` with a compatible schema.

    Fail-closed on any error. Within :data:`READY_TTL_SECONDS` of a
    confirmed-ready probe a cached ready result is reused; otherwise (and ALWAYS
    when the TTL is ``0``) the engine is RE-PROBED. Consequences by design:
    a table removed after a prior success fails closed on the next call; a table
    added later (0095 applied) becomes ready with no restart; the cache only ever
    remembers a ready result, never a not-ready one.
    """
    now = time.monotonic()
    if READY_TTL_SECONDS > 0 and _cached_ready(bind, now):
        return True
    ok, why = _probe(bind)
    _remember(bind, ok, why, now)
    return ok


def reason(bind: Engine) -> str:
    try:
        return _last_reason.get(bind, "unprobed")
    except TypeError:
        return "unprobed"


def assert_ready(bind: Engine) -> None:
    """Raise 503 unless the audit store is usable on ``bind``. Called by the
    audit writer (``record_in_session``) so EVERY in-transaction audited write is
    fail-closed centrally — the business change cannot reach its commit when the
    audit row could not be written. Never swallows, never weakens atomicity."""
    if not is_ready(bind):
        logger.warning("B2C admin audit not ready: %s", reason(bind))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="B2C admin audit unavailable — migration 0095 not applied or schema incompatible.",
        )


def require_audit_ready(db: Session = Depends(get_db)) -> None:
    """Dependency: 503 unless the B2C admin audit store is usable for THIS request.

    Depends on the same ``get_db`` the endpoint uses, so it inspects the exact
    engine the business write would commit to. Returns None on success (adds no
    value to the handler); raises 503 otherwise, before any handler body runs.

    This is a DOOR check: it reduces the window, it does not close it. Paths that
    audit a SUCCESS *after* reading protected data (report preview, attachment
    download) must still persist that audit durably and fail closed if it cannot
    be written — see ``record_independently(required=True)``."""
    bind = db.get_bind()
    if not is_ready(bind):
        logger.warning("B2C admin audit not ready: %s", reason(bind))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="B2C admin audit unavailable — migration 0095 not applied or schema incompatible.",
        )
