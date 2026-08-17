"""merchant service access — which travel products a merchant may use

Revision ID: 0045_merchant_service_access
Revises: 0042_group_booking_import
Create Date: 2026-08-13

RE-PARENTED 2026-08-15: originally written against 0044_customer_portal,
which has since been reverted in full (customer portal backed out; see that
revert commit). Chained onto 0042_group_booking_import instead — the new
true head — so the migration graph resolves after both changes land
together. Nothing in this migration ever touched a customer_* table, so the
revert has no effect on what upgrade()/downgrade() actually do here.

WHAT THIS IS FOR
The Hotel module (and, later, Visa) must be something an Admin can grant or
withhold per merchant, independently of Flights. Nothing in the nine-table
schema expresses "which products can this company use" — ``merchants`` has
no such column, and ``users.permissions`` governs *actions within* a portal
(who may approve, who may issue), not *which product a whole company sees*.
That is a genuinely new concept, not a re-exposure of RBAC.

WHY A TABLE AND NOT A JSONB COLUMN ON ``merchants``
Three booleans on ``merchants`` would work today, but this follows the
``communication_settings`` precedent instead: a small satellite table, one
concern, FK-cascaded to the merchant. One row per ``(merchant_id,
service_code)`` rather than one row per merchant keeps the set of services
open — Visa ships in this same migration as a row that is simply always
``false`` for now, and a fourth product later is an INSERT, not a new column
and not a migration touching every existing merchant row's shape.

WHY THE BACKFILL IS NOT OPTIONAL
``enquiry_service.create()`` is about to start calling
``service_access_service.assert_enabled()`` before it will raise a Flight
enquiry. Every merchant that exists before this migration runs has no rows
in this table at all; without the backfill below, the very first Flight
enquiry any of them tries to raise after deploy would 403. So ``upgrade()``
seeds Flights=true / Hotels=false / Visa=false for every existing merchant
in the same transaction that creates the table — this migration is not
purely additive in the way 0042 was, and that is deliberate.

BACKWARD COMPATIBILITY
One new enum type, one new table, and one data backfill confined to the new
table. No existing column, constraint, or index is touched. ``downgrade()``
drops what ``upgrade()`` created.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0045_merchant_service_access"
down_revision: Union[str, None] = "0042_group_booking_import"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    service_code = postgresql.ENUM(
        "flights",
        "hotels",
        "visa",
        name="service_code_enum",
        create_type=False,
    )
    service_code.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "merchant_service_access",
        sa.Column("service_access_id", sa.BigInteger, primary_key=True),
        sa.Column(
            "merchant_id",
            sa.BigInteger,
            sa.ForeignKey("merchants.merchant_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("service_code", service_code, nullable=False),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    op.create_unique_constraint(
        "uq_merchant_service_access", "merchant_service_access",
        ["merchant_id", "service_code"],
    )
    op.create_index(
        "ix_merchant_service_access_merchant", "merchant_service_access", ["merchant_id"]
    )

    # Seed every existing merchant: Flights on (nobody loses what already
    # works), Hotels and Visa off (new products start opt-in). See the module
    # docstring — skipping this backfill would 403 every merchant's next
    # Flight enquiry.
    op.execute(
        """
        INSERT INTO merchant_service_access (merchant_id, service_code, enabled)
        SELECT merchant_id, 'flights', true FROM merchants
        """
    )
    op.execute(
        """
        INSERT INTO merchant_service_access (merchant_id, service_code, enabled)
        SELECT merchant_id, 'hotels', false FROM merchants
        """
    )
    op.execute(
        """
        INSERT INTO merchant_service_access (merchant_id, service_code, enabled)
        SELECT merchant_id, 'visa', false FROM merchants
        """
    )


def downgrade() -> None:
    op.drop_index("ix_merchant_service_access_merchant", table_name="merchant_service_access")
    op.drop_constraint(
        "uq_merchant_service_access", "merchant_service_access", type_="unique"
    )
    op.drop_table("merchant_service_access")
    postgresql.ENUM(name="service_code_enum").drop(op.get_bind(), checkfirst=True)
