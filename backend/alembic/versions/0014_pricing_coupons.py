"""seasonal pricing, discount campaigns, coupons

Revision ID: 0014_pricing_coupons
Revises: 0013_booking_mgmt
Create Date: 2026-07-21

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0014_pricing_coupons"
down_revision: Union[str, None] = "0013_booking_mgmt"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "seasonal_prices",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("item_type", sa.String(30), nullable=False),
        sa.Column("item_id", sa.Integer(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("override_price", sa.Numeric(10, 2), nullable=False),
        sa.Column("label", sa.String(150), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_seasonal_prices_item", "seasonal_prices", ["item_type", "item_id"])

    op.create_table(
        "discount_campaigns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(150), nullable=False),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("discount_type", sa.String(10), nullable=False),  # percent | flat
        sa.Column("discount_value", sa.Numeric(10, 2), nullable=False),
        sa.Column("applicable_type", sa.String(30), nullable=True),  # null = all booking types
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "coupons",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(40), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("discount_type", sa.String(10), nullable=False),  # percent | flat
        sa.Column("discount_value", sa.Numeric(10, 2), nullable=False),
        sa.Column("applicable_type", sa.String(30), nullable=True),  # null = all booking types
        sa.Column("min_booking_amount", sa.Numeric(10, 2), nullable=True),
        sa.Column("usage_limit", sa.Integer(), nullable=True),  # null = unlimited
        sa.Column("times_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("valid_from", sa.Date(), nullable=False),
        sa.Column("valid_until", sa.Date(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_coupons_code", "coupons", ["code"], unique=True)

    op.add_column("bookings", sa.Column("coupon_code", sa.String(40), nullable=True))
    op.add_column("bookings", sa.Column("discount_amount", sa.Numeric(10, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("bookings", "discount_amount")
    op.drop_column("bookings", "coupon_code")
    op.drop_index("ix_coupons_code", table_name="coupons")
    op.drop_table("coupons")
    op.drop_table("discount_campaigns")
    op.drop_index("ix_seasonal_prices_item", table_name="seasonal_prices")
    op.drop_table("seasonal_prices")
