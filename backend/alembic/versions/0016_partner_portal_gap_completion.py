"""partner portal gap completion — status history, registration/profile/audit SPs, extra views

Revision ID: 0016_partner_gap
Revises: 0015_partner_portal
Create Date: 2026-07-24

DDL/PLpgSQL lives in backend/db/partner_portal/gap_completion/*.sql, same
pattern as 0015_partner_portal.py. Additive only — does not touch anything
from 0015.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0016_partner_gap"
down_revision: Union[str, None] = "0015_partner_portal"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "partner_portal" / "gap_completion"

UPGRADE_FILES = [
    "01_schema.sql", "02_constraints.sql", "03_indexes.sql", "04_functions.sql",
    "05_stored_procedures.sql", "06_triggers.sql", "07_views.sql", "08_seed_data.sql",
]


def upgrade() -> None:
    for fname in UPGRADE_FILES:
        op.execute((SQL_DIR / fname).read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        DROP TRIGGER IF EXISTS trg_auto_generate_service_request_number ON service_requests;
        DROP TRIGGER IF EXISTS trg_auto_generate_booking_reference ON partner_bookings;
        DROP TRIGGER IF EXISTS trg_track_service_request_status_history ON service_requests;
        DROP TRIGGER IF EXISTS trg_track_booking_status_history ON partner_bookings;
    """)
    op.execute("""
        DROP VIEW IF EXISTS vw_service_requests;
        DROP VIEW IF EXISTS vw_ticket_enquiry;
    """)
    op.execute("""
        DROP FUNCTION IF EXISTS sp_audit_log_entry(integer, integer, varchar, varchar, integer, text, varchar);
        DROP FUNCTION IF EXISTS sp_update_partner_profile(integer, varchar, varchar);
        DROP FUNCTION IF EXISTS sp_get_dashboard_statistics(integer);
        DROP FUNCTION IF EXISTS sp_register_partner(varchar, varchar, varchar, varchar, varchar, varchar, varchar, varchar, varchar);
    """)
    op.execute("""
        DROP FUNCTION IF EXISTS fn_auto_generate_service_request_number();
        DROP FUNCTION IF EXISTS fn_auto_generate_booking_reference();
        DROP FUNCTION IF EXISTS fn_track_service_request_status_history();
        DROP FUNCTION IF EXISTS fn_track_booking_status_history();
    """)
    # Deletes the two seed partners this migration's 08_seed_data.sql created —
    # cascades to their partner_users via the existing ON DELETE CASCADE (0015).
    op.execute("DELETE FROM partners WHERE company_code IN ('AURORA01', 'BLUELINE01');")
    op.execute("""
        DROP TABLE IF EXISTS service_request_status_history;
        DROP TABLE IF EXISTS partner_booking_status_history;
    """)
