"""extend activity_logs, add user_sessions, add login tracking columns to users

Revision ID: 0009_activity_monitoring
Revises: 0008_extended_profile
Create Date: 2026-07-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0009_activity_monitoring"
down_revision: Union[str, None] = "0008_extended_profile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("activity_logs", sa.Column("activity_type", sa.String(60), nullable=True))
    op.add_column("activity_logs", sa.Column("module", sa.String(40), nullable=True))
    op.add_column("activity_logs", sa.Column("description", sa.String(500), nullable=True))
    op.add_column("activity_logs", sa.Column("reference_id", sa.Integer(), nullable=True))
    op.add_column("activity_logs", sa.Column("browser", sa.String(60), nullable=True))
    op.add_column("activity_logs", sa.Column("device", sa.String(60), nullable=True))
    op.add_column("activity_logs", sa.Column("status", sa.String(20), nullable=False, server_default="success"))
    op.create_index("ix_activity_logs_activity_type", "activity_logs", ["activity_type"])
    op.create_index("ix_activity_logs_module", "activity_logs", ["module"])

    op.add_column("users", sa.Column("last_login_at", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("login_count", sa.Integer(), nullable=False, server_default="0"))

    op.create_table(
        "user_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("login_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("logout_at", sa.DateTime(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("current_page", sa.String(200), nullable=True),
        sa.Column("ip_address", sa.String(50), nullable=True),
        sa.Column("browser", sa.String(60), nullable=True),
        sa.Column("os", sa.String(60), nullable=True),
        sa.Column("device", sa.String(60), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"])
    op.create_index("ix_user_sessions_is_active", "user_sessions", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_user_sessions_is_active", table_name="user_sessions")
    op.drop_index("ix_user_sessions_user_id", table_name="user_sessions")
    op.drop_table("user_sessions")
    op.drop_column("users", "login_count")
    op.drop_column("users", "last_login_at")
    op.drop_index("ix_activity_logs_module", table_name="activity_logs")
    op.drop_index("ix_activity_logs_activity_type", table_name="activity_logs")
    for col in ["status", "device", "browser", "reference_id", "description", "module", "activity_type"]:
        op.drop_column("activity_logs", col)
