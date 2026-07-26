"""partner portal notification triggers — populate partner_notifications

Revision ID: 0018_partner_notif_triggers
Revises: 0017_partner_back_office
Create Date: 2026-07-25

DDL lives in backend/db/partner_portal/back_office/02_notification_triggers.sql.
Additive only — two new trigger functions + triggers on the existing
partner_bookings / service_requests tables. No existing object is modified.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0018_partner_notif_triggers"
down_revision: Union[str, None] = "0017_partner_back_office"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "partner_portal" / "back_office"


def upgrade() -> None:
    op.execute((SQL_DIR / "02_notification_triggers.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        DROP TRIGGER IF EXISTS trg_notify_service_request_status ON service_requests;
        DROP FUNCTION IF EXISTS fn_notify_service_request_status();
        DROP TRIGGER IF EXISTS trg_notify_partner_booking_status ON partner_bookings;
        DROP FUNCTION IF EXISTS fn_notify_partner_booking_status();
    """)
