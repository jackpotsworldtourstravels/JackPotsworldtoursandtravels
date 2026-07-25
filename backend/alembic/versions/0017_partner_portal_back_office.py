"""partner portal back office — admin booking queue + service request resolution

Revision ID: 0017_partner_back_office
Revises: 0016_partner_gap
Create Date: 2026-07-24

DDL lives in backend/db/partner_portal/back_office/*.sql. Additive only.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0017_partner_back_office"
down_revision: Union[str, None] = "0016_partner_gap"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "partner_portal" / "back_office"


def upgrade() -> None:
    op.execute((SQL_DIR / "01_stored_procedures.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        DROP FUNCTION IF EXISTS sp_resolve_service_request(integer, service_request_status_enum, integer);
        DROP FUNCTION IF EXISTS sp_admin_list_partner_bookings(booking_status_enum, varchar);
    """)
