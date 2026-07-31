"""nine-table redesign — replace the 43-object legacy schema

Revision ID: 0023_nine_table_redesign
Revises: 0022_merchant_user_fields
Create Date: 2026-07-29

Collapses the legacy schema (39 business tables + 4 bookkeeping/history
tables, 5 views, 36 stored procedures, 17 enums) into exactly nine tables:

    users, merchants, service_requests, payments, passenger_data,
    communication_settings, msg_logs, system_logs, audit_logs

DDL lives in backend/db/schema_v2/ so it can be reviewed as plain SQL:

    01_drop_legacy_schema.sql   tears down every legacy object
    02_nine_table_schema.sql    creates the nine tables

DESTRUCTIVE. This migration drops every legacy table and the data in it.
The downgrade path recreates nothing — the legacy schema is 22 migrations
of accumulated DDL and is not reconstructible from here. Restore from a
pg_dump taken before upgrading:

    pg_restore -U postgres -h 127.0.0.1 -d jackpotsworldtours \
        --clean --if-exists backup_jackpotsworldtours_pre9table.dump

The application layer (models, routers, services) still targets the legacy
schema and must be rewritten before the API will serve anything beyond
/api/health. See docs/SCHEMA_V2.md for the module-by-module rewrite list.
"""
import json
import os
from pathlib import Path
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0023_nine_table_redesign"
down_revision: Union[str, None] = "0022_merchant_user_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "schema_v2"

# Matches the legacy 0003_seed_admin defaults so the existing admin login
# keeps working across the redesign.
DEFAULT_ADMIN_EMAIL = "admin@jackpotsworldtours.com"
DEFAULT_ADMIN_PASSWORD = "AdminPass#2026"

# Seeded accounts get NO explicit permission codes.
#
# ``users.permissions`` is for *additional* grants on top of whatever the
# role already implies; app/auth/rbac.py owns the baseline for each role and
# is the single source of truth. Seeding a hand-written list here duplicated
# that matrix and then silently overrode it — an earlier version of this
# seed granted the super admin ``payment.manage``, which the spec explicitly
# denies, because a union of role defaults and explicit grants can only ever
# add. Leave these empty; grant extras through the admin API.
ADMIN_PERMISSIONS: list[str] = []
MERCHANT_ADMIN_PERMISSIONS: list[str] = []


def _hash(password: str) -> str:
    """Hash via the app's own helper so seeded logins verify identically."""
    from app.auth.security import hash_password

    return hash_password(password)


def _run_sql_file(name: str) -> None:
    """Execute a hand-written DDL script verbatim.

    Goes through a raw psycopg2 cursor rather than op.execute() or
    exec_driver_sql(). These scripts contain `:` (inside JSONB examples) and
    `%` (inside PL/pgSQL format() calls); op.execute() reads `:word` as a
    SQLAlchemy bind parameter, and any driver-level call that supplies a
    parameter collection makes psycopg2 treat `%` as a placeholder. A cursor
    execute with no parameters at all does neither. Shares the migration's
    connection, so it stays inside the migration transaction.
    """
    sql = (SQL_DIR / name).read_text(encoding="utf-8")
    cursor = op.get_bind().connection.cursor()
    try:
        cursor.execute(sql)
    finally:
        cursor.close()


def upgrade() -> None:
    _run_sql_file("01_drop_legacy_schema.sql")
    _run_sql_file("02_nine_table_schema.sql")
    _seed()


def _seed() -> None:
    """Minimal seed: one platform admin, two demo merchants + their users.

    Deliberately small. The legacy catalog seed (flights/hotels/cruises/
    packages) is not reproduced here because catalog rows now live in
    service_requests as request_type='catalog_item', and re-seeding them
    belongs with the application rewrite that will actually read them.
    """
    conn = op.get_bind()

    admin_email = os.environ.get("ADMIN_SEED_EMAIL", DEFAULT_ADMIN_EMAIL)
    admin_password = os.environ.get("ADMIN_SEED_PASSWORD", DEFAULT_ADMIN_PASSWORD)

    admin_id = conn.execute(
        sa.text(
            """
            INSERT INTO users (role, permissions, full_name, email, phone,
                               password_hash, email_verified, status)
            VALUES ('super_admin', CAST(:perms AS jsonb), 'Platform Administrator',
                    :email, '+91-90000-00000', :pwd, true, 'active')
            RETURNING user_id
            """
        ),
        {
            "perms": json.dumps(ADMIN_PERMISSIONS),
            "email": admin_email,
            "pwd": _hash(admin_password),
        },
    ).scalar_one()

    demo_merchants = [
        {
            "code": "AURORA01",
            "prefix": "AG",
            "name": "Aurora Gaming",
            "company": "Aurora Gaming Studios",
            "type": "gaming_company",
            "email": "jackpotsworldtours.travels@gmail.com",
            "phone": "+91-90000-00001",
            "city": "Bengaluru",
            "user_name": "Aurora Admin",
            "user_email": "jackpotsworldtours.travels@gmail.com",
            "user_pwd": "Aurora@2026",
        },
        {
            "code": "BLUELINE01",
            "prefix": "BL",
            "name": "Blueline Travel",
            "company": "Blueline Corporate Travel",
            "type": "corporate_company",
            "email": "jackpotsworldtours.travels+arjun@gmail.com",
            "phone": "+91-90000-00002",
            "city": "Hyderabad",
            "user_name": "Arjun Menon",
            "user_email": "jackpotsworldtours.travels+arjun@gmail.com",
            "user_pwd": "Blueline@2026",
        },
    ]

    for m in demo_merchants:
        merchant_id = conn.execute(
            sa.text(
                """
                INSERT INTO merchants (merchant_code, merchant_name, company_name,
                                       company_type, email, phone, reference_prefix,
                                       country, country_code, city, status, created_by)
                VALUES (:code, :name, :company, CAST(:ctype AS company_type_enum),
                        :email, :phone, :prefix, 'India', 'IN', :city, 'active', :admin)
                RETURNING merchant_id
                """
            ),
            {
                "code": m["code"],
                "name": m["name"],
                "company": m["company"],
                "ctype": m["type"],
                "email": m["email"],
                "phone": m["phone"],
                "prefix": m["prefix"],
                "city": m["city"],
                "admin": admin_id,
            },
        ).scalar_one()

        conn.execute(
            sa.text(
                """
                INSERT INTO users (merchant_id, role, permissions, full_name, email,
                                   phone, password_hash, otp_enabled, email_verified, status)
                VALUES (:mid, 'merchant_admin', CAST(:perms AS jsonb), :name, :email,
                        :phone, :pwd, true, true, 'active')
                """
            ),
            {
                "mid": merchant_id,
                "perms": json.dumps(MERCHANT_ADMIN_PERMISSIONS),
                "name": m["user_name"],
                "email": m["user_email"],
                "phone": m["phone"],
                "pwd": _hash(m["user_pwd"]),
            },
        )

        conn.execute(
            sa.text(
                "INSERT INTO communication_settings (merchant_id) VALUES (:mid)"
            ),
            {"mid": merchant_id},
        )


def downgrade() -> None:
    """Drop the nine-table schema.

    This does NOT restore the legacy schema — see the module docstring.
    Downgrading leaves an empty public schema; restore from pg_dump.
    """
    for table in (
        "audit_logs",
        "system_logs",
        "msg_logs",
        "communication_settings",
        "passenger_data",
        "payments",
        "service_requests",
        "users",
        "merchants",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")

    op.execute("DROP FUNCTION IF EXISTS fn_write_audit_log() CASCADE")
    op.execute("DROP FUNCTION IF EXISTS fn_set_updated_at() CASCADE")

    for enum in (
        "user_role_enum",
        "user_status_enum",
        "merchant_status_enum",
        "company_type_enum",
        "request_type_enum",
        "request_status_enum",
        "priority_enum",
        "travel_type_enum",
        "payment_type_enum",
        "payment_status_enum",
        "gender_enum",
        "passenger_type_enum",
        "seat_preference_enum",
        "otp_purpose_enum",
        "message_type_enum",
        "message_status_enum",
        "audit_operation_enum",
    ):
        op.execute(f"DROP TYPE IF EXISTS {enum} CASCADE")
