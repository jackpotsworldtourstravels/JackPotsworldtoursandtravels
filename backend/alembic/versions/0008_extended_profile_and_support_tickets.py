"""extend users with profile fields, add support_tickets table

Revision ID: 0008_extended_profile
Revises: 0007_wishlist_review_unique
Create Date: 2026-07-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0008_extended_profile"
down_revision: Union[str, None] = "0007_wishlist_review_unique"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("first_name", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("last_name", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("mobile", sa.String(20), nullable=True))
    op.add_column("users", sa.Column("gender", sa.String(20), nullable=True))
    op.add_column("users", sa.Column("dob", sa.Date(), nullable=True))
    op.add_column("users", sa.Column("country", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("state", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("city", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("address", sa.String(300), nullable=True))
    op.add_column("users", sa.Column("profile_photo", sa.String(500), nullable=True))

    op.create_table(
        "support_tickets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("subject", sa.String(200), nullable=False),
        sa.Column("description", sa.String(4000), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="open"),
        sa.Column("priority", sa.String(20), nullable=False, server_default="normal"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_support_tickets_user_id", "support_tickets", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_support_tickets_user_id", table_name="support_tickets")
    op.drop_table("support_tickets")
    for col in ["first_name", "last_name", "mobile", "gender", "dob", "country", "state", "city", "address", "profile_photo"]:
        op.drop_column("users", col)
