"""inventory management: cruise cabins, package capacity, low-stock thresholds

Revision ID: 0012_inventory_mgmt
Revises: 0011_ticket_resolved_at
Create Date: 2026-07-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0012_inventory_mgmt"
down_revision: Union[str, None] = "0011_ticket_resolved_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("cruises", sa.Column("cabins_available", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("tour_packages", sa.Column("capacity", sa.Integer(), nullable=False, server_default="0"))
    for table in ["flights", "hotels", "cruises", "tour_packages"]:
        op.add_column(table, sa.Column("low_stock_threshold", sa.Integer(), nullable=False, server_default="5"))

    # Cruises/packages never had a capacity concept before this migration, so every
    # existing row defaults to 0 — backfill a real number so their bookings don't
    # instantly start failing "sold out" the moment availability checks go live.
    op.execute("UPDATE cruises SET cabins_available = 50 WHERE cabins_available = 0")
    op.execute("UPDATE tour_packages SET capacity = 50 WHERE capacity = 0")


def downgrade() -> None:
    for table in ["flights", "hotels", "cruises", "tour_packages"]:
        op.drop_column(table, "low_stock_threshold")
    op.drop_column("tour_packages", "capacity")
    op.drop_column("cruises", "cabins_available")
