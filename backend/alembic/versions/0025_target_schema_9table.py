"""target schema — 9-table redesign, staged alongside the legacy schema

Revision ID: 0025_target_schema_9table
Revises: 0024_partner_role_type_auth
Create Date: 2026-07-28

DDL lives in backend/db/target_schema/*.sql — see
docs/DATABASE_REDESIGN_9TABLE.md for the full design.

Purely additive and reversible: creates 9 new tables under ts_ prefixed
names (ts_users, ts_merchants, ts_service_requests, ts_payments,
ts_passenger_data, ts_communication_settings, ts_msg_logs, ts_system_logs,
ts_audit_logs) plus 22 new ts_* enum types and their triggers, and adds one
nullable `seasonal_pricing` JSONB column to each of the 4 existing catalog
tables (flights/hotels/cruises/tour_packages).

Does NOT touch, rename, or drop any of the 41 legacy tables. The running
application keeps using app.models.* (legacy) unchanged after this migration
runs — nothing here is imported by the live model graph
(app/models/target_schema/ is a separate, unwired package). This is
deliberately NOT the cutover migration: renaming ts_* -> bare names and
retiring the legacy tables is a separate, explicitly-confirmed step once the
data backfill (docs/DATA_MIGRATION_STRATEGY_9TABLE.md) has been run and
verified.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0025_target_schema_9table"
down_revision: Union[str, None] = "0024_partner_role_type_auth"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "target_schema"

UPGRADE_FILES = ["01_types.sql", "02_tables.sql", "03_indexes.sql", "04_triggers.sql"]


def upgrade() -> None:
    for fname in UPGRADE_FILES:
        op.execute((SQL_DIR / fname).read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        DROP TRIGGER IF EXISTS trg_ts_service_requests_status_log ON ts_service_requests;
        DROP FUNCTION IF EXISTS fn_ts_log_status_change();
        DROP TRIGGER IF EXISTS trg_ts_payments_audit ON ts_payments;
        DROP TRIGGER IF EXISTS trg_ts_service_requests_audit ON ts_service_requests;
        DROP TRIGGER IF EXISTS trg_ts_merchants_audit ON ts_merchants;
        DROP TRIGGER IF EXISTS trg_ts_users_audit ON ts_users;
        DROP FUNCTION IF EXISTS fn_ts_audit_row();
        DROP TRIGGER IF EXISTS trg_ts_passenger_data_updated_at ON ts_passenger_data;
        DROP TRIGGER IF EXISTS trg_ts_payments_updated_at ON ts_payments;
        DROP TRIGGER IF EXISTS trg_ts_service_requests_updated_at ON ts_service_requests;
        DROP TRIGGER IF EXISTS trg_ts_merchants_updated_at ON ts_merchants;
        DROP TRIGGER IF EXISTS trg_ts_users_updated_at ON ts_users;
        -- fn_set_updated_at() is left in place — owned by the Partner Portal
        -- migration (0015) and still in use there and by 0023.
    """)
    op.execute("""
        ALTER TABLE tour_packages DROP COLUMN IF EXISTS seasonal_pricing;
        ALTER TABLE cruises DROP COLUMN IF EXISTS seasonal_pricing;
        ALTER TABLE hotels DROP COLUMN IF EXISTS seasonal_pricing;
        ALTER TABLE flights DROP COLUMN IF EXISTS seasonal_pricing;
    """)
    op.execute("""
        DROP TABLE IF EXISTS ts_audit_logs CASCADE;
        DROP TABLE IF EXISTS ts_system_logs CASCADE;
        DROP TABLE IF EXISTS ts_msg_logs CASCADE;
        DROP TABLE IF EXISTS ts_communication_settings CASCADE;
        DROP TABLE IF EXISTS ts_passenger_data CASCADE;
        DROP TABLE IF EXISTS ts_payments CASCADE;
        DROP TABLE IF EXISTS ts_service_requests CASCADE;
        DROP TABLE IF EXISTS ts_users CASCADE;
        DROP TABLE IF EXISTS ts_merchants CASCADE;
    """)
    op.execute("""
        DROP TYPE IF EXISTS ts_audit_action_enum;
        DROP TYPE IF EXISTS ts_log_type_enum;
        DROP TYPE IF EXISTS ts_msg_status_enum;
        DROP TYPE IF EXISTS ts_msg_direction_enum;
        DROP TYPE IF EXISTS ts_msg_channel_enum;
        DROP TYPE IF EXISTS ts_meal_option_enum;
        DROP TYPE IF EXISTS ts_baggage_option_enum;
        DROP TYPE IF EXISTS ts_passenger_type_enum;
        DROP TYPE IF EXISTS ts_gender_enum;
        DROP TYPE IF EXISTS ts_discount_type_enum;
        DROP TYPE IF EXISTS ts_payment_status_enum;
        DROP TYPE IF EXISTS ts_payment_record_type_enum;
        DROP TYPE IF EXISTS ts_priority_enum;
        DROP TYPE IF EXISTS ts_request_status_enum;
        DROP TYPE IF EXISTS ts_cabin_class_enum;
        DROP TYPE IF EXISTS ts_trip_type_enum;
        DROP TYPE IF EXISTS ts_item_type_enum;
        DROP TYPE IF EXISTS ts_channel_enum;
        DROP TYPE IF EXISTS ts_request_type_enum;
        DROP TYPE IF EXISTS ts_merchant_status_enum;
        DROP TYPE IF EXISTS ts_otp_purpose_enum;
        DROP TYPE IF EXISTS ts_merchant_member_role_enum;
        DROP TYPE IF EXISTS ts_merchant_role_type_enum;
        DROP TYPE IF EXISTS ts_user_status_enum;
        DROP TYPE IF EXISTS ts_user_type_enum;
    """)
