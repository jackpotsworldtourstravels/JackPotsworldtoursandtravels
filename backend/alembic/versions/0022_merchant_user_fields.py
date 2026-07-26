"""admin portal merchant user — username field + phone uniqueness

Revision ID: 0022_merchant_user_fields
Revises: 0021_merchant_management
Create Date: 2026-07-26

DDL lives in backend/db/partner_portal/back_office/06_merchant_user_fields.sql.
Additive only: one new nullable+unique column, one new unique constraint on
an existing column. No existing object is modified.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0022_merchant_user_fields"
down_revision: Union[str, None] = "0021_merchant_management"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "partner_portal" / "back_office"


def upgrade() -> None:
    op.execute((SQL_DIR / "06_merchant_user_fields.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        ALTER TABLE partner_users DROP CONSTRAINT IF EXISTS partner_users_phone_number_key;
        ALTER TABLE partner_users DROP CONSTRAINT IF EXISTS partner_users_username_key;
        ALTER TABLE partner_users DROP COLUMN IF EXISTS username;
    """)
