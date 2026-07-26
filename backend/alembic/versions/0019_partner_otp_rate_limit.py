"""partner portal OTP rate limiting — 5 requests/hour, 5-minute TTL

Revision ID: 0019_partner_otp_rate_limit
Revises: 0018_partner_notif_triggers
Create Date: 2026-07-25

DDL lives in backend/db/partner_portal/back_office/03_otp_rate_limit.sql.
CREATE OR REPLACE on the existing sp_request_otp — same signature, adds a
rate-limit guard and lowers the default TTL to 5 minutes. No other object
is touched.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0019_partner_otp_rate_limit"
down_revision: Union[str, None] = "0018_partner_notif_triggers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "partner_portal" / "back_office"


def upgrade() -> None:
    op.execute((SQL_DIR / "03_otp_rate_limit.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION sp_request_otp(
            p_partner_user_id INTEGER,
            p_otp_hash VARCHAR,
            p_purpose otp_purpose_enum,
            p_ttl_minutes INTEGER DEFAULT 10
        )
        RETURNS INTEGER AS $$
        DECLARE
            v_otp_id INTEGER;
        BEGIN
            UPDATE partner_otp_requests
            SET expires_at = now()
            WHERE partner_user_id = p_partner_user_id AND purpose = p_purpose AND verified_at IS NULL;

            INSERT INTO partner_otp_requests (partner_user_id, otp_hash, purpose, expires_at)
            VALUES (p_partner_user_id, p_otp_hash, p_purpose, now() + (p_ttl_minutes || ' minutes')::interval)
            RETURNING otp_id INTO v_otp_id;

            RETURN v_otp_id;
        END;
        $$ LANGUAGE plpgsql;
    """)
