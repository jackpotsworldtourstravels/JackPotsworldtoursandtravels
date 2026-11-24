"""supplier markups + festival/seasonal discounts

Revision ID: 0100_supplier_markup_festival
Revises: 0099_coupon_targeting_usage
Create Date: 2026-11-24

Two admin-managed pricing tables the customer pricing services read:

  * ``supplier_markups``    — a percentage added to a supplier's base price per
                              service (flight/hotel/package/other). One row per
                              (supplier, service).
  * ``festival_discounts``  — a time-boxed discount taken off the resulting
                              selling price, shown on the site as original vs
                              discounted price.

Both tables being EMPTY is the safe default: no markup row = 0% markup, no active
festival row = no discount, so prices are unchanged until the owner adds config.

HAND-WRITTEN: ``alembic/env.py`` autogenerate does not see ``models_customer``,
so this DDL must track ``SupplierMarkup`` / ``FestivalDiscount`` exactly.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0100_supplier_markup_festival"
down_revision: Union[str, None] = "0099_coupon_targeting_usage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "supplier_markups",
        sa.Column("supplier_markup_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("supplier", sa.String(length=40), nullable=False, server_default=sa.text("'TBO'")),
        sa.Column("service", sa.String(length=20), nullable=False),
        sa.Column("markup_percent", sa.Numeric(5, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("supplier", "service", name="uq_supplier_markup_service"),
    )

    op.create_table(
        "festival_discounts",
        sa.Column("festival_discount_id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("discount_type", sa.String(length=10), nullable=False),
        sa.Column("discount_value", sa.Numeric(12, 2), nullable=False),
        sa.Column("applicable_type", sa.String(length=20), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("show_on_website", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_festival_discounts_active", "festival_discounts", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_festival_discounts_active", table_name="festival_discounts")
    op.drop_table("festival_discounts")
    op.drop_table("supplier_markups")
