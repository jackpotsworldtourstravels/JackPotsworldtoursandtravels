"""partner portal passenger ancillary services — baggage/meal/seat/special services

Revision ID: 0020_partner_ancillary_services
Revises: 0019_partner_otp_rate_limit
Create Date: 2026-07-25

DDL lives in backend/db/partner_portal/back_office/04_ancillary_services.sql.
Purely additive: 2 new enums, 1 new catalog table (+ seed prices), 1 new
join table, 3 new nullable columns on partner_booking_passengers, and a
CREATE OR REPLACE on sp_add_passenger that only appends optional trailing
parameters. No existing object is modified in a breaking way.
"""
from pathlib import Path
from typing import Sequence, Union

from alembic import op

revision: str = "0020_partner_ancillary_services"
down_revision: Union[str, None] = "0019_partner_otp_rate_limit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SQL_DIR = Path(__file__).resolve().parents[2] / "db" / "partner_portal" / "back_office"


def upgrade() -> None:
    op.execute((SQL_DIR / "04_ancillary_services.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute("""
        DROP FUNCTION IF EXISTS sp_set_passenger_special_services(INTEGER, INTEGER[]);

        CREATE OR REPLACE FUNCTION sp_add_passenger(
            p_booking_id INTEGER,
            p_full_name VARCHAR,
            p_gender gender_enum,
            p_passenger_type passenger_type_enum,
            p_passport_issuing_country_id INTEGER,
            p_passport_number VARCHAR,
            p_passport_issue_date DATE,
            p_passport_expiry_date DATE,
            p_date_of_birth DATE,
            p_nationality_country_id INTEGER,
            p_meal_preference VARCHAR DEFAULT NULL,
            p_special_assistance TEXT DEFAULT NULL
        )
        RETURNS INTEGER AS $$
        DECLARE
            v_passenger_id INTEGER;
        BEGIN
            INSERT INTO partner_booking_passengers (
                booking_id, full_name, gender, passenger_type,
                passport_issuing_country_id, passport_number, passport_issue_date, passport_expiry_date,
                date_of_birth, nationality_country_id, meal_preference, special_assistance
            ) VALUES (
                p_booking_id, p_full_name, p_gender, p_passenger_type,
                p_passport_issuing_country_id, p_passport_number, p_passport_issue_date, p_passport_expiry_date,
                p_date_of_birth, p_nationality_country_id, p_meal_preference, p_special_assistance
            )
            RETURNING passenger_id INTO v_passenger_id;
            RETURN v_passenger_id;
        END;
        $$ LANGUAGE plpgsql;

        DROP TABLE IF EXISTS passenger_special_services;
        ALTER TABLE partner_booking_passengers
            DROP COLUMN IF EXISTS baggage_catalog_id,
            DROP COLUMN IF EXISTS meal_catalog_id,
            DROP COLUMN IF EXISTS seat_preference;
        DROP TABLE IF EXISTS ancillary_service_catalog;
        DROP TYPE IF EXISTS ancillary_category_enum;
        DROP TYPE IF EXISTS seat_preference_enum;
    """)
