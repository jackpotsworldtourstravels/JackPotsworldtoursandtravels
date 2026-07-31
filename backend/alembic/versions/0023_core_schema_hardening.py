"""core schema hardening — updated_at triggers, report indexes, dashboard views

Revision ID: 0023_core_schema_hardening
Revises: 0022_merchant_user_fields
Create Date: 2026-07-27

DDL lives in backend/db/core/*.sql, same pattern as the Partner Portal
migrations (0015-0022). Purely additive: new triggers, one new nullable-then-
backfilled `updated_at` column on flights/hotels/cruises/tour_packages, new
indexes, and new views. No existing table is renamed, no column is dropped,
no data is migrated. Does not touch anything from 0001-0022.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0023_core_schema_hardening"
down_revision: Union[str, None] = "0022_merchant_user_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "core"

UPGRADE_FILES = ["01_triggers.sql", "02_indexes.sql", "03_views.sql"]


def upgrade() -> None:
    for fname in UPGRADE_FILES:
        op.execute((SQL_DIR / fname).read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        DROP VIEW IF EXISTS vw_dashboard_statistics;
        DROP VIEW IF EXISTS vw_customer_bookings;
        DROP VIEW IF EXISTS vw_daily_sales;
    """)
    op.execute("""
        DROP INDEX IF EXISTS ix_payments_status_created_at;
        DROP INDEX IF EXISTS ix_users_created_at;
        DROP INDEX IF EXISTS ix_payments_created_at;
        DROP INDEX IF EXISTS ix_bookings_created_at;
    """)
    op.execute("""
        DROP TRIGGER IF EXISTS trg_tour_packages_updated_at ON tour_packages;
        DROP TRIGGER IF EXISTS trg_cruises_updated_at ON cruises;
        DROP TRIGGER IF EXISTS trg_hotels_updated_at ON hotels;
        DROP TRIGGER IF EXISTS trg_flights_updated_at ON flights;
        ALTER TABLE tour_packages DROP COLUMN IF EXISTS updated_at;
        ALTER TABLE cruises DROP COLUMN IF EXISTS updated_at;
        ALTER TABLE hotels DROP COLUMN IF EXISTS updated_at;
        ALTER TABLE flights DROP COLUMN IF EXISTS updated_at;
        DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
        DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
    """)
    # fn_set_updated_at() is left in place — it's owned by the Partner Portal
    # migration (0015) and is still in use there.
