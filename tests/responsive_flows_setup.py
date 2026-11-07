"""Provision the throwaway accounts the signed-in responsive flow tests use, and print their session tokens as JSON.

    DATABASE_URL=postgresql+psycopg2://.../jackpots_payfix_tmp python tests/responsive_flows_setup.py

WHY THIS IS NOT A GENERAL SEEDER
It creates two B2C customers and one platform admin with fake details, and mints their tokens straight from the
application's own signing code (the same route tests/payfix.py takes). So it refuses, with no override, to touch
any database that is not on loopback AND whose name does not say it is disposable ("tmp" or "test"): a run
against the development database, let alone anything remote, exits before it writes a row.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.config import settings  # noqa: E402

url = urllib.parse.urlparse(settings.database_url.replace("+psycopg2", ""))
name = (url.path or "").lstrip("/")
if url.hostname not in {"127.0.0.1", "localhost", "::1"} or not any(w in name for w in ("tmp", "test")):
    print(f"refusing: {url.hostname}/{name} is not a loopback, disposable (tmp/test) database.", file=sys.stderr)
    sys.exit(2)

from sqlalchemy import or_, select  # noqa: E402

from app.auth.security import (  # noqa: E402
    create_access_token, create_customer_access_token, create_customer_refresh_token,
)
from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import User, UserRole  # noqa: E402
from app.models_customer import Customer  # noqa: E402
from app.services import account_service  # noqa: E402
from app.services.customer_auth_service import next_customer_code  # noqa: E402

db = SessionLocal()
out = {}


def customer(email, full_name, mobile):
    row = db.execute(select(Customer).where(or_(Customer.email == email, Customer.mobile == mobile))).scalars().first()
    if row is not None and row.email != email:   # an earlier run used another address for this test account
        row.email = email
        db.commit()
    if row is None:
        row = Customer(customer_code=next_customer_code(db), full_name=full_name, email=email, mobile=mobile)
        db.add(row)
        db.commit()
    return {"id": row.customer_id, "name": row.full_name, "email": row.email,
            "access": create_customer_access_token(row.customer_id),
            "refresh": create_customer_refresh_token(row.customer_id)}


out["customer"] = customer("responsive.one@example.com", "Responsive Tester", "+919900001001")
out["other"] = customer("responsive.two@example.com", "Second Tester", "+919900001002")

admin = db.execute(select(User).where(User.email == "responsive.agent@example.com")).scalar_one_or_none()
if admin is None:
    actor = db.execute(select(User).where(User.role == UserRole.SUPER_ADMIN)).scalars().first()
    if actor is None:
        print("refusing: no super admin on this database to attribute the agent account to.", file=sys.stderr)
        sys.exit(2)
    admin, _ = account_service.create_admin(db, actor, full_name="Responsive Agent", email="responsive.agent@example.com",
                                            phone=None, password="Throwaway-Pass-1!")
    db.commit()
out["admin"] = {"id": admin.user_id, "access": create_access_token(admin.user_id)}
print(json.dumps(out))
