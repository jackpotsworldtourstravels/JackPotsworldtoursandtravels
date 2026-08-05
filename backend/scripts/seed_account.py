"""Create a local development account, without the password touching a shell history.

    # platform staff
    JPW_SEED_PASSWORD='...' python backend/scripts/seed_account.py \
        --email ops@example.com --name "Ops Admin" --role admin

    # a user under a merchant
    JPW_SEED_PASSWORD='...' python backend/scripts/seed_account.py \
        --email dataop@example.com --name "Data Operator" \
        --role merchant_user --merchant-role data_operator --merchant-id 1

Omit ``JPW_SEED_PASSWORD`` and a strong one is generated and printed once.

WHY THIS EXISTS RATHER THAN A curl COMMAND
The API is the better route when a server is running and you have a token. This
covers the case that is not: seeding a fresh local database, before anyone can
log in to create anyone. It goes through ``account_service``, which is the same
code the endpoints call — so the password is hashed identically, the email
uniqueness rule is the same rule, and the audit entry is the same entry. A
script that INSERTed into ``users`` directly would drift from all three.

WHY THE PASSWORD COMES FROM THE ENVIRONMENT
An argument like ``--password hunter2`` lands in shell history, in ``ps`` output
for every user on the machine, and in any terminal recording. The environment is
not perfect either, but it is not persisted by the shell and not world-readable
per-process. The value is never logged by this script and never echoed back.

THIS IS A DEVELOPMENT TOOL.
It refuses to run against anything that does not look like a local database, so
it cannot be pointed at production by an exported ``DATABASE_URL``. Override
with ``--i-know-this-is-not-local`` if you genuinely mean to, which is
deliberately tedious to type.
"""
import argparse
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from sqlalchemy import select  # noqa: E402

from app.config import settings  # noqa: E402
from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import Merchant, MerchantRole, User, UserRole  # noqa: E402
from app.services import account_service  # noqa: E402

LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1", "host.docker.internal")


def looks_local(url: str) -> bool:
    return any(f"@{h}:" in url or f"@{h}/" in url for h in LOCAL_HOSTS)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--email", required=True)
    p.add_argument("--name", required=True, help="Full name")
    p.add_argument("--phone", default=None)
    p.add_argument(
        "--role", required=True,
        choices=["admin", "manager", "merchant_admin", "merchant_user"],
        help="admin/manager are platform staff; the merchant_* pair need --merchant-id",
    )
    p.add_argument(
        "--merchant-role", default=None,
        choices=[r.value for r in MerchantRole],
        help="Internal role for a merchant user (data_operator, manager, …)",
    )
    p.add_argument("--merchant-id", type=int, default=None)
    p.add_argument("--i-know-this-is-not-local", action="store_true")
    args = p.parse_args()

    url = settings.database_url
    if not looks_local(url) and not args.i_know_this_is_not_local:
        # The host is shown; the credentials in the URL are not.
        host = url.split("@")[-1].split("/")[0] if "@" in url else "?"
        print(f"refusing: {host} does not look like a local database.", file=sys.stderr)
        print("Pass --i-know-this-is-not-local if you really mean it.", file=sys.stderr)
        return 2

    password = os.environ.get("JPW_SEED_PASSWORD") or None
    if password is not None and len(password) < 8:
        print("refusing: JPW_SEED_PASSWORD must be at least 8 characters.", file=sys.stderr)
        return 2

    role = UserRole(args.role)
    is_staff = role in (UserRole.ADMIN, UserRole.MANAGER)

    if not is_staff and args.merchant_id is None:
        print("refusing: a merchant_* role needs --merchant-id.", file=sys.stderr)
        return 2
    if is_staff and (args.merchant_id or args.merchant_role):
        print("refusing: platform staff belong to no merchant.", file=sys.stderr)
        return 2

    db = SessionLocal()
    try:
        if db.execute(select(User).where(User.email == args.email)).scalar_one_or_none():
            print(f"{args.email} already exists — nothing done.")
            return 1

        # The service layer wants an actor for its audit entry. The Super Admin
        # is used because it is the account that legitimately holds this power;
        # nothing about it is modified.
        actor = db.execute(
            select(User).where(User.role == UserRole.SUPER_ADMIN)
        ).scalars().first()
        if actor is None:
            print("refusing: no super admin on this database to attribute this to.",
                  file=sys.stderr)
            return 2

        if is_staff:
            user, issued = account_service.create_admin(
                db, actor, full_name=args.name, email=args.email,
                phone=args.phone, password=password, role=role,
            )
        else:
            if db.get(Merchant, args.merchant_id) is None:
                print(f"refusing: no merchant with id {args.merchant_id}.", file=sys.stderr)
                return 2
            user, issued = account_service.create_merchant_user(
                db, actor, merchant_id=args.merchant_id,
                full_name=args.name, email=args.email, phone=args.phone,
                role=role,
                merchant_role=MerchantRole(args.merchant_role) if args.merchant_role else None,
                password=password,
            )

        print(f"created  {user.email}")
        print(f"  role         {user.role.value}"
              + (f" / {user.merchant_role.value}" if user.merchant_role else ""))
        print(f"  merchant_id  {user.merchant_id}")
        # Echoed ONLY when this script generated it — a password supplied by the
        # caller is one they already have, and reprinting it just puts it on one
        # more screen.
        if password is None:
            print(f"  password     {issued}   <- shown once, not recoverable")
        else:
            print("  password     (the one you supplied)")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
