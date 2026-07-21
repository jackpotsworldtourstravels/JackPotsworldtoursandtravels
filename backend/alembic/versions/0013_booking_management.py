"""booking management: bookings.updated_at, payments refund tracking

Revision ID: 0013_booking_mgmt
Revises: 0012_inventory_mgmt
Create Date: 2026-07-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0013_booking_mgmt"
down_revision: Union[str, None] = "0012_inventory_mgmt"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("bookings", sa.Column("updated_at", sa.DateTime(), nullable=True))
    op.execute("UPDATE bookings SET updated_at = created_at WHERE updated_at IS NULL")
    op.alter_column("bookings", "updated_at", nullable=False, server_default=sa.func.now())

    op.add_column("payments", sa.Column("refunded_at", sa.DateTime(), nullable=True))
    op.add_column("payments", sa.Column("refund_reference", sa.String(100), nullable=True))


def downgrade() -> None:
    op.drop_column("payments", "refund_reference")
    op.drop_column("payments", "refunded_at")
    op.drop_column("bookings", "updated_at")
