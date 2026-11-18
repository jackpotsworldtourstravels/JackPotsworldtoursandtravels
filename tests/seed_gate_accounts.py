"""Seed the operator accounts the verification suite signs in as — TEST ONLY.

WHY THIS EXISTS
`tests/config.py` names an ADMIN (non-super), a second ADMIN, a platform
MANAGER and a MERCHANT. The Alembic seed migrations create only the SUPER admin
(`0003`) and the merchant-admin accounts of `0023`; the non-super ADMIN, ADMIN2
and MANAGER roles the `verify_*` suite logs into are created by nothing. A fresh
`alembic upgrade head` therefore cannot authenticate most of the suite, and the
run collapses into login 401s that look like regressions and are not.

This makes the disposable test database match `tests/config.py` deterministically:
run it ONCE after `alembic upgrade head`, before starting the server.

    DATABASE_URL=postgresql+psycopg2://…@localhost:…/…_test python tests/seed_gate_accounts.py

WHAT IT DOES NOT DO
  * It changes NO application code and NO migration, and adds NO permission it
    was not already going to get: permissions are role-derived (auth/rbac.py
    `effective_permissions`), so setting `role` correctly is the whole grant.
    No auth or authz check is weakened.
  * It uses the TEST-ONLY credentials already in `tests/config.py` (public,
    reproducible dev values — never a production secret).
  * It REFUSES to run against anything but a local, disposable database. The
    DATABASE_URL is parsed with SQLAlchemy's own URL parser and the gate checks
    the PARSED host against a loopback allowlist (localhost / 127.0.0.1 / ::1)
    and the PARSED database name against a *_test / *_qa suffix. Because the
    check is on parsed components — never a substring of the raw string — a
    loopback name hidden in the username, password, path or query string cannot
    spoof it, and a malformed, host-less, name-less or non-PostgreSQL URL is
    refused rather than waved through. Every parse/validation failure fails
    closed: it refuses before any engine or connection is built.

LIMITATION — port forwarding / tunnels are UNDETECTABLE by URL parsing
    A loopback address can still be forwarded to a remote database (an SSH
    tunnel, `kubectl port-forward`, socat, a /etc/hosts alias pointing
    "localhost" elsewhere). URL parsing cannot see through that: `localhost:5432`
    may terminate anywhere. This gate is a guard rail against the obvious
    mistake — a production/RDS URL left in the environment — NOT proof the
    database is physically local. Only ever run this seeder against a DATABASE_URL
    you KNOW names a disposable, throwaway test database.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # import only for the type annotation; no runtime cost
    from sqlalchemy.engine import URL

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND = REPO_ROOT / "backend"
for p in (str(REPO_ROOT), str(BACKEND)):
    if p not in sys.path:
        sys.path.insert(0, p)


# Only these PARSED hostnames are accepted. Matching is on the host component
# SQLAlchemy returns, compared exactly (case-insensitively) — never a substring
# of the raw URL — so a loopback name in the credentials/path/query cannot spoof
# the check. `::1` is the IPv6 loopback (SQLAlchemy strips the `[...]` brackets).
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


class _UnsafeDatabaseURL(Exception):
    """DATABASE_URL does not name a local, disposable *_test / *_qa database."""


def _validate_local_test_url(raw: str) -> "URL":
    """Parse `raw` and return the SQLAlchemy URL iff it names a local, disposable
    PostgreSQL *_test / *_qa database. Raise `_UnsafeDatabaseURL` otherwise.

    Fails CLOSED by construction: a malformed URL, an unsupported scheme, a
    missing host, a non-loopback host, or a missing / non-disposable database
    name is a refusal. No input path returns normally except a URL that passes
    every check, and the credentials, port, path and query components are never
    consulted for the host decision, so they cannot spoof it.
    """
    from sqlalchemy import make_url
    from sqlalchemy.exc import ArgumentError

    if not raw or not raw.strip():
        raise _UnsafeDatabaseURL("DATABASE_URL is empty")

    try:
        url = make_url(raw)
    except (ArgumentError, ValueError) as exc:  # malformed / unparseable
        raise _UnsafeDatabaseURL(f"DATABASE_URL did not parse ({exc})") from exc

    # Scheme must be a PostgreSQL backend (postgresql, postgresql+psycopg2, …).
    # get_backend_name() drops the DBAPI suffix; the legacy `postgres://` alias
    # (backend "postgres") and any other scheme are refused.
    backend = url.get_backend_name()
    if backend != "postgresql":
        raise _UnsafeDatabaseURL(
            f"unsupported scheme {url.drivername!r} (only postgresql is allowed)"
        )

    # Host: the PARSED host, matched exactly against the loopback allowlist.
    host = (url.host or "").strip().lower()
    if not host:
        raise _UnsafeDatabaseURL("DATABASE_URL has no host")
    if host not in _LOCAL_HOSTS:
        raise _UnsafeDatabaseURL(
            f"host {url.host!r} is not a loopback host {sorted(_LOCAL_HOSTS)}"
        )

    # Database name must announce itself disposable.
    name = (url.database or "").strip()
    if not name:
        raise _UnsafeDatabaseURL("DATABASE_URL has no database name")
    if not (name.endswith("_test") or name.endswith("_qa")):
        raise _UnsafeDatabaseURL(
            f"database {name!r} is not a disposable *_test / *_qa database"
        )

    return url


def _refuse_non_local() -> str:
    """Return the DATABASE_URL after validating it, or exit hard.

    Called as the FIRST statement of `main()`, so a refusal happens before the
    sqlalchemy/app imports and before `create_engine()` — no engine is created
    and no connection is attempted against a URL that fails the gate. A seeder
    that writes users must never be one exported variable away from a real
    database. See `_validate_local_test_url` and the module docstring's
    LIMITATION note (tunnels/port-forwards are not detectable here).
    """
    raw = os.environ.get("DATABASE_URL", "")
    try:
        _validate_local_test_url(raw)
    except _UnsafeDatabaseURL as exc:
        sys.exit(
            f"seed_gate_accounts REFUSED: {exc}. This seeder only runs against a "
            "local, disposable *_test / *_qa PostgreSQL database and never against "
            "production or RDS."
        )
    return raw


def main() -> int:
    url = _refuse_non_local()

    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import sessionmaker

    import importlib.util

    from app.auth.security import hash_password
    from app.models_v2 import (
        CompanyType,
        Merchant,
        MerchantRole,
        MerchantStatus,
        User,
        UserRole,
        UserStatus,
    )

    # Load the ROOT tests/config.py by path. A bare ``from tests import config``
    # is ambiguous — ``backend/tests`` is also a package named ``tests`` — so the
    # file is loaded directly to guarantee it is THIS suite's account model.
    spec = importlib.util.spec_from_file_location("gate_test_config", Path(__file__).with_name("config.py"))
    c = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c)

    engine = create_engine(url)
    Session = sessionmaker(bind=engine, expire_on_commit=False)

    # (config entry, UserRole, is_merchant)
    STAFF = [
        (c.ADMIN, UserRole.ADMIN, False),
        (c.ADMIN2, UserRole.ADMIN, False),
        (c.MANAGER, UserRole.MANAGER, False),
    ]
    created, updated = [], []

    with Session() as db:
        # --- an ACTIVE merchant for the MERCHANT account to belong to --------
        # Reuse one the seed migrations already made; only build a minimal one
        # if a fresh DB has none. Either way it is a real, tradeable company, so
        # the merchant-portal login's "company must be ACTIVE" check is honoured
        # rather than bypassed.
        merchant = db.scalar(
            select(Merchant).where(Merchant.status == MerchantStatus.ACTIVE).order_by(Merchant.merchant_id)
        )
        if merchant is None:
            merchant = Merchant(
                merchant_code="TESTMERCH01",
                merchant_name="Gate Test Travel",
                company_name="Gate Test Travel Pvt Ltd",
                company_type=CompanyType.TRAVEL_AGENCY,
                email="merchant-company@example.test",
                reference_prefix="GTB",
                status=MerchantStatus.ACTIVE,
            )
            db.add(merchant)
            db.flush()
            created.append(f"merchant company #{merchant.merchant_id} (none existed)")

        def upsert(entry, role: UserRole, *, merchant_id=None, merchant_role=None):
            email, password, _portal = entry
            row = db.scalar(select(User).where(User.email == email))
            fields = dict(
                full_name=email.split("@")[0].replace(".", " ").title(),
                role=role,
                merchant_id=merchant_id,
                merchant_role=merchant_role,
                permissions=[],            # role-derived; no extra grants
                password_hash=hash_password(password),
                status=UserStatus.ACTIVE,
                email_verified=True,
                otp_enabled=True,
            )
            if row is None:
                db.add(User(email=email, **fields))
                created.append(f"{email} ({role.value})")
            else:
                # Self-heal an account that exists with the wrong role/password/status
                # so a re-run is deterministic regardless of prior state.
                for k, v in fields.items():
                    setattr(row, k, v)
                updated.append(f"{email} ({role.value})")

        for entry, role, _ in STAFF:
            upsert(entry, role)
        upsert(c.MERCHANT, UserRole.MERCHANT_ADMIN,
               merchant_id=merchant.merchant_id, merchant_role=MerchantRole.MANAGER)

        db.commit()

    print("seed_gate_accounts: done")
    for label in created:
        print(f"  created  {label}")
    for label in updated:
        print(f"  updated  {label}")
    print(f"  SUPER admin ({c.SUPER[0]}) is created by migration 0003 — left as-is.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
