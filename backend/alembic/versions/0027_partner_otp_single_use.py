"""make partner login OTPs single-use

Revision ID: 0027_partner_otp_single_use
Revises: 0026_test_data_users
Create Date: 2026-07-30

Before this, partner login checked only that *a* verified 'login' OTP existed
within the last 15 minutes and never marked it spent. One OTP verification
therefore opened a 15-minute window in which email+password alone logged in
repeatedly — the second factor was per-window, not per-login.

Adds partner_otp_requests.consumed_at. app/services/partner_auth_service.py
now claims the row atomically (UPDATE ... RETURNING) on successful login, so
each OTP authorizes exactly one login. The column is nullable with no
backfill: existing rows read as unconsumed, which at worst honours OTPs
already verified in the 15 minutes before deploy.

Password reset is unaffected — sp_verify_otp only ever matches rows with
verified_at IS NULL, so that flow was already single-use.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0027_partner_otp_single_use"
down_revision: Union[str, None] = "0026_test_data_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "partner_otp_requests",
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Mirrors the widened index in db/partner_portal/03_partner_tables.sql so a
    # rebuild from the DDL and an upgrade from migrations agree.
    op.drop_index("idx_partner_otp_requests_user_purpose", table_name="partner_otp_requests")
    op.create_index(
        "idx_partner_otp_requests_user_purpose",
        "partner_otp_requests",
        ["partner_user_id", "purpose", "verified_at", "consumed_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_partner_otp_requests_user_purpose", table_name="partner_otp_requests")
    op.create_index(
        "idx_partner_otp_requests_user_purpose",
        "partner_otp_requests",
        ["partner_user_id", "purpose", "verified_at"],
    )
    op.drop_column("partner_otp_requests", "consumed_at")
