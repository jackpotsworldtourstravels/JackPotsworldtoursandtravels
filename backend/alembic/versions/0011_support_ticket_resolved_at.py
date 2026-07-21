"""add resolved_at to support_tickets

Revision ID: 0011_ticket_resolved_at
Revises: 0010_customer_mgmt
Create Date: 2026-07-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0011_ticket_resolved_at"
down_revision: Union[str, None] = "0010_customer_mgmt"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("support_tickets", sa.Column("resolved_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("support_tickets", "resolved_at")
