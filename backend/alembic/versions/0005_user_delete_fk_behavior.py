"""fix user deletion: cascade reviews/wishlist/notifications, nullify activity_logs

Bookings/payments intentionally keep RESTRICT (no ondelete) — deleting a user
with existing bookings should be blocked at the application layer, not silently
cascade away financial records.

Revision ID: 0005_user_delete_fk_behavior
Revises: 0004_pkg_month_booking_qty
Create Date: 2026-07-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0005_user_delete_fk_behavior"
down_revision: Union[str, None] = "0004_pkg_month_booking_qty"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CASCADE_TABLES = ["reviews", "wishlist", "notifications"]
_NULLIFY_TABLE = "activity_logs"


def _fk_name(bind, table: str, column: str) -> str:
    insp = sa.inspect(bind)
    for fk in insp.get_foreign_keys(table):
        if column in fk["constrained_columns"]:
            return fk["name"]
    raise RuntimeError(f"no foreign key found on {table}.{column}")


def upgrade() -> None:
    bind = op.get_bind()

    for table in _CASCADE_TABLES:
        name = _fk_name(bind, table, "user_id")
        op.drop_constraint(name, table, type_="foreignkey")
        op.create_foreign_key(name, table, "users", ["user_id"], ["id"], ondelete="CASCADE")

    name = _fk_name(bind, _NULLIFY_TABLE, "user_id")
    op.drop_constraint(name, _NULLIFY_TABLE, type_="foreignkey")
    op.create_foreign_key(name, _NULLIFY_TABLE, "users", ["user_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    bind = op.get_bind()

    for table in _CASCADE_TABLES:
        name = _fk_name(bind, table, "user_id")
        op.drop_constraint(name, table, type_="foreignkey")
        op.create_foreign_key(name, table, "users", ["user_id"], ["id"])

    name = _fk_name(bind, _NULLIFY_TABLE, "user_id")
    op.drop_constraint(name, _NULLIFY_TABLE, type_="foreignkey")
    op.create_foreign_key(name, _NULLIFY_TABLE, "users", ["user_id"], ["id"])
