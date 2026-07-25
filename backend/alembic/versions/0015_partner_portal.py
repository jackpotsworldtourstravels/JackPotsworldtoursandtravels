"""partner portal — tables, views, triggers, stored procedures

Revision ID: 0015_partner_portal
Revises: 0014_pricing_coupons
Create Date: 2026-07-24

The DDL/PLpgSQL itself lives in backend/db/partner_portal/*.sql — the
reviewed, approved artifact — rather than being duplicated here. This
migration is the thin wrapper that lets `alembic upgrade head` apply it on
a fresh database, and lets `alembic downgrade` cleanly remove it.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0015_partner_portal"
down_revision: Union[str, None] = "0014_pricing_coupons"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "partner_portal"

UPGRADE_FILES = [
    "01_types.sql",
    "02_reference_tables.sql",
    "03_partner_tables.sql",
    "04_booking_tables.sql",
    "05_service_request_tables.sql",
    "06_payment_report_notification_audit_tables.sql",
    "07_sequences.sql",
    "08_views.sql",
    "09_triggers.sql",
    "10_stored_procedures_auth_and_reference.sql",
    "11_stored_procedures_booking_workflow.sql",
    "12_stored_procedures_service_requests.sql",
    "13_stored_procedures_reporting.sql",
    "14_seed_reference_data.sql",
]


def upgrade() -> None:
    for fname in UPGRADE_FILES:
        op.execute((SQL_DIR / fname).read_text(encoding="utf-8"))


def downgrade() -> None:
    # Reverse dependency order: functions/triggers/views before the tables
    # they reference, child tables before parents, then types last.
    op.execute("""
        DROP FUNCTION IF EXISTS sp_generate_report(integer, integer, date, date, date, date, varchar, varchar, varchar, varchar, export_format_enum);
        DROP FUNCTION IF EXISTS sp_get_request_history(integer, booking_status_enum, date, date);
        DROP FUNCTION IF EXISTS sp_get_ticket_enquiry(varchar, varchar, date, varchar);
        DROP FUNCTION IF EXISTS sp_create_passenger_modification_request(varchar, integer, varchar, varchar, varchar, text, integer);
        DROP FUNCTION IF EXISTS sp_create_refund_request(varchar, numeric, text, integer);
        DROP FUNCTION IF EXISTS sp_create_date_change_request(varchar, integer, date, text, integer);
        DROP FUNCTION IF EXISTS sp_cancel_selected_passengers(varchar, integer[], text, integer);
        DROP FUNCTION IF EXISTS sp_complete_booking(integer);
        DROP FUNCTION IF EXISTS sp_reject_request(integer, integer, text);
        DROP FUNCTION IF EXISTS sp_approve_request(integer, integer, numeric);
        DROP FUNCTION IF EXISTS sp_submit_request_for_approval(integer);
        DROP FUNCTION IF EXISTS sp_add_passenger(integer, varchar, gender_enum, passenger_type_enum, integer, varchar, date, date, date, integer, varchar, text);
        DROP FUNCTION IF EXISTS sp_create_ticket_request(integer, integer, travel_type_enum, integer, integer, integer, varchar, varchar, trip_type_enum, varchar, varchar, date, date, cabin_class_enum);
        DROP FUNCTION IF EXISTS sp_generate_service_request_number();
        DROP FUNCTION IF EXISTS sp_generate_booking_reference(integer);
        DROP FUNCTION IF EXISTS sp_verify_otp(integer, otp_purpose_enum, varchar);
        DROP FUNCTION IF EXISTS sp_request_otp(integer, varchar, otp_purpose_enum, integer);
        DROP FUNCTION IF EXISTS sp_partner_record_login(integer, varchar);
        DROP FUNCTION IF EXISTS sp_partner_login_lookup(varchar);
    """)

    op.execute("""
        DROP TRIGGER IF EXISTS trg_audit_partner_users ON partner_users;
        DROP TRIGGER IF EXISTS trg_audit_service_requests ON service_requests;
        DROP TRIGGER IF EXISTS trg_audit_partner_bookings ON partner_bookings;
        DROP TRIGGER IF EXISTS trg_service_requests_updated_at ON service_requests;
        DROP TRIGGER IF EXISTS trg_partner_booking_passengers_updated_at ON partner_booking_passengers;
        DROP TRIGGER IF EXISTS trg_partner_bookings_updated_at ON partner_bookings;
        DROP TRIGGER IF EXISTS trg_partner_users_updated_at ON partner_users;
        DROP TRIGGER IF EXISTS trg_partners_updated_at ON partners;
        DROP FUNCTION IF EXISTS fn_audit_partner_users();
        DROP FUNCTION IF EXISTS fn_audit_service_requests();
        DROP FUNCTION IF EXISTS fn_audit_partner_bookings();
        DROP FUNCTION IF EXISTS fn_set_updated_at();
    """)

    op.execute("""
        DROP VIEW IF EXISTS vw_reports_summary;
        DROP VIEW IF EXISTS vw_request_history;
        DROP VIEW IF EXISTS vw_partner_dashboard_stats;
    """)

    op.execute("DROP SEQUENCE IF EXISTS service_request_number_seq;")

    op.execute("""
        DROP TABLE IF EXISTS partner_audit_logs;
        DROP TABLE IF EXISTS partner_notifications;
        DROP TABLE IF EXISTS report_generation_log;
        DROP TABLE IF EXISTS partner_payments CASCADE;
        DROP TABLE IF EXISTS passenger_modification_requests;
        DROP TABLE IF EXISTS refund_requests;
        DROP TABLE IF EXISTS date_change_requests;
        DROP TABLE IF EXISTS cancellation_request_passengers;
        DROP TABLE IF EXISTS cancellation_requests;
        DROP TABLE IF EXISTS service_requests;
        DROP TABLE IF EXISTS booking_reference_counters;
        DROP TABLE IF EXISTS partner_booking_passengers;
        DROP TABLE IF EXISTS partner_bookings;
        DROP TABLE IF EXISTS partner_otp_requests;
        DROP TABLE IF EXISTS partner_users;
        DROP TABLE IF EXISTS partners;
        DROP TABLE IF EXISTS role_permissions;
        DROP TABLE IF EXISTS permissions;
        DROP TABLE IF EXISTS countries;
    """)

    op.execute("DELETE FROM roles WHERE name IN ('partner_admin', 'partner_staff');")

    op.execute("""
        DROP TYPE IF EXISTS export_format_enum;
        DROP TYPE IF EXISTS service_request_status_enum;
        DROP TYPE IF EXISTS service_request_type_enum;
        DROP TYPE IF EXISTS booking_status_enum;
        DROP TYPE IF EXISTS passenger_type_enum;
        DROP TYPE IF EXISTS gender_enum;
        DROP TYPE IF EXISTS cabin_class_enum;
        DROP TYPE IF EXISTS trip_type_enum;
        DROP TYPE IF EXISTS travel_type_enum;
        DROP TYPE IF EXISTS otp_purpose_enum;
        DROP TYPE IF EXISTS partner_user_status_enum;
        DROP TYPE IF EXISTS partner_status_enum;
    """)
