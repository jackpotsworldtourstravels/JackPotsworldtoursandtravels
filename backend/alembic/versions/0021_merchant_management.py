"""admin portal merchant management — company_type, role_type, member_role

Revision ID: 0021_merchant_management
Revises: 0020_partner_ancillary_services
Create Date: 2026-07-26

DDL lives in backend/db/partner_portal/back_office/05_merchant_management.sql.
Purely additive: 3 new enums + nullable columns on the existing partners /
partner_users tables (reused as "Merchants" / "Merchant Users" for the Admin
Portal rather than duplicated). No existing object is modified.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0021_merchant_management"
down_revision: Union[str, None] = "0020_partner_ancillary_services"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "partner_portal" / "back_office"


def upgrade() -> None:
    op.execute((SQL_DIR / "05_merchant_management.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        ALTER TABLE partner_users DROP COLUMN IF EXISTS role_type, DROP COLUMN IF EXISTS member_role;
        ALTER TABLE partners
            DROP COLUMN IF EXISTS company_type, DROP COLUMN IF EXISTS contact_person,
            DROP COLUMN IF EXISTS address, DROP COLUMN IF EXISTS city,
            DROP COLUMN IF EXISTS state, DROP COLUMN IF EXISTS country,
            DROP COLUMN IF EXISTS gst_number, DROP COLUMN IF EXISTS pan_number;
        DROP TYPE IF EXISTS merchant_member_role_enum;
        DROP TYPE IF EXISTS merchant_role_type_enum;
        DROP TYPE IF EXISTS merchant_company_type_enum;
    """)
