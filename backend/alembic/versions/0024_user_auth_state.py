"""add password-reset and force-logout state to users

Revision ID: 0024_user_auth_state
Revises: 0023_nine_table_redesign
Create Date: 2026-07-29

The nine-table design covers identity, role, and OTP, but the application
also needs three pieces of auth state that have nowhere to live:

* ``reset_token_hash`` / ``reset_token_expires_at`` — the forgot-password
  flow. Looked up by hash, so it needs a real indexed column rather than a
  key inside the ``profile`` JSONB.
* ``force_logout_at`` — JWTs are stateless, so logout and the admin
  "force logout" action work by moving this timestamp forward and rejecting
  any token issued before it. Without it, logout cannot revoke a token.
* ``login_count`` — shown in the admin customer view.

Additive only: four nullable/defaulted columns on an existing table. Adds no
tables, so the nine-table constraint still holds.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0024_user_auth_state"
down_revision: Union[str, None] = "0023_nine_table_redesign"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("reset_token_hash", sa.String(64), nullable=True))
    op.add_column(
        "users",
        sa.Column("reset_token_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users", sa.Column("force_logout_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users",
        sa.Column("login_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )

    # Partial: only a handful of rows have a live reset token at any moment.
    op.create_index(
        "ix_users_reset_token",
        "users",
        ["reset_token_hash"],
        unique=False,
        postgresql_where=sa.text("reset_token_hash IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_users_reset_token", table_name="users")
    op.drop_column("users", "login_count")
    op.drop_column("users", "force_logout_at")
    op.drop_column("users", "reset_token_expires_at")
    op.drop_column("users", "reset_token_hash")
