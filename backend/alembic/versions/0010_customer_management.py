"""customer management: blocked/verified/soft-delete/force-logout flags on users

Revision ID: 0010_customer_mgmt
Revises: 0009_activity_monitoring
Create Date: 2026-07-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0010_customer_mgmt"
down_revision: Union[str, None] = "0009_activity_monitoring"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("is_blocked", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("users", sa.Column("is_verified", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("users", sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("users", sa.Column("deleted_at", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("force_logout_at", sa.DateTime(), nullable=True))
    op.create_index("ix_users_is_deleted", "users", ["is_deleted"])


def downgrade() -> None:
    op.drop_index("ix_users_is_deleted", table_name="users")
    for col in ["force_logout_at", "deleted_at", "is_deleted", "is_verified", "is_blocked"]:
        op.drop_column("users", col)
