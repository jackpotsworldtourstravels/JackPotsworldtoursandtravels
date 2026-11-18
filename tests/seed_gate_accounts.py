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
  * It REFUSES to run against anything but a local, disposable database, so it
    can never touch production or RDS.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND = REPO_ROOT / "backend"
for p in (str(REPO_ROOT), str(BACKEND)):
    if p not in sys.path:
        sys.path.insert(0, p)


def _refuse_non_local() -> str:
    """Return the DATABASE_URL, or exit hard if it is not a local test DB.

    The same structural gate `qa/playwright/fixtures/db.py` uses: a host that
    cannot be production, and a database name that announces itself disposable.
    A seeder that writes users must never be one exported variable away from a
    real database.
    """
    url = os.environ.get("DATABASE_URL", "")
    low = url.lower()
    host_ok = ("@localhost:" in low) or ("@127.0.0.1:" in low) or ("@localhost/" in low)
    name = low.rstrip("/").rsplit("/", 1)[-1].split("?")[0]
    db_ok = name.endswith("_test") or name.endswith("_qa") or name in ("ci_test",)
    if not (host_ok and db_ok):
        sys.exit(
            "seed_gate_accounts REFUSED: DATABASE_URL is not a local, disposable "
            f"*_test / *_qa database (got host_ok={host_ok}, db='{name}'). "
            "This seeder never runs against production or RDS."
        )
    return url


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
