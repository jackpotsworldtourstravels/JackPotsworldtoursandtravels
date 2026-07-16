"""add tour_packages.available_month and bookings.quantity

Revision ID: 0004_pkg_month_booking_qty
Revises: 0003_seed_admin
Create Date: 2026-07-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004_pkg_month_booking_qty"
down_revision: Union[str, None] = "0003_seed_admin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SEED_MONTHS = {
    1: "July",
    2: "June",
    3: "February",
    4: "December",
}


def upgrade() -> None:
    op.add_column("tour_packages", sa.Column("available_month", sa.String(20), nullable=True))
    op.add_column(
        "bookings", sa.Column("quantity", sa.Integer(), nullable=False, server_default="1")
    )

    conn = op.get_bind()
    for package_id, month in _SEED_MONTHS.items():
        conn.execute(
            sa.text("UPDATE tour_packages SET available_month = :month WHERE id = :id"),
            {"month": month, "id": package_id},
        )


def downgrade() -> None:
    op.drop_column("bookings", "quantity")
    op.drop_column("tour_packages", "available_month")
