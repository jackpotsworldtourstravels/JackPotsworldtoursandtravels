"""coupon targeting (airline) + usage limits + website flag + author

Revision ID: 0099_coupon_targeting_usage
Revises: 0098_tour_package_enquiry_admin
Create Date: 2026-11-24

Adds admin-managed targeting and usage tracking to ``customer_coupons`` so the
new Offers & Coupons admin screen can do more than the seed script did:

  * ``airline``          — IATA carrier code (e.g. ``6E``); NULL = all airlines.
                           Combined with the existing ``international_only`` this
                           gives the "domestic/international + airline" targeting.
  * ``usage_limit``      — total redemptions allowed; NULL = unlimited.
  * ``times_used``       — redemptions so far (incremented at booking time).
  * ``show_on_website``  — whether the public Offers page / checkout panel lists it.
  * ``created_by``       — admin user id snapshot (no FK: the customer schema never
                           reaches into B2B ``users`` — same rule as 0089/0094/0095).

HAND-WRITTEN: ``alembic/env.py`` autogenerate does not see ``models_customer``,
so this DDL must track ``app.models_customer.CustomerCoupon`` exactly.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0099_coupon_targeting_usage"
down_revision: Union[str, None] = "0098_tour_package_enquiry_admin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "customer_coupons"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("airline", sa.String(length=8), nullable=True))
    op.add_column(TABLE, sa.Column("usage_limit", sa.Integer(), nullable=True))
    op.add_column(
        TABLE,
        sa.Column("times_used", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.add_column(
        TABLE,
        sa.Column("show_on_website", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(TABLE, sa.Column("created_by", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column(TABLE, "created_by")
    op.drop_column(TABLE, "show_on_website")
    op.drop_column(TABLE, "times_used")
    op.drop_column(TABLE, "usage_limit")
    op.drop_column(TABLE, "airline")
