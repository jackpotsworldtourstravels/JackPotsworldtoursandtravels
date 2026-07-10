"""seed admin account

Revision ID: 0003_seed_admin
Revises: 0002_seed_content
Create Date: 2026-07-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.auth.security import hash_password

revision: str = "0003_seed_admin"
down_revision: Union[str, None] = "0002_seed_content"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ADMIN_EMAIL = "admin@jackpotsworldtours.com"
ADMIN_PASSWORD = "AdminPass#2026"


def upgrade() -> None:
    conn = op.get_bind()
    admin_role_id = conn.execute(sa.text("SELECT id FROM roles WHERE name = 'admin'")).scalar()
    if admin_role_id is None:
        raise RuntimeError("admin role not found — run 0001_initial migration first")

    existing = conn.execute(sa.text("SELECT id FROM users WHERE email = :email"), {"email": ADMIN_EMAIL}).scalar()
    if existing:
        return

    users_table = sa.table(
        "users",
        sa.column("full_name", sa.String),
        sa.column("email", sa.String),
        sa.column("hashed_password", sa.String),
        sa.column("role_id", sa.Integer),
        sa.column("is_active", sa.Boolean),
    )
    op.bulk_insert(
        users_table,
        [
            {
                "full_name": "JackPots Admin",
                "email": ADMIN_EMAIL,
                "hashed_password": hash_password(ADMIN_PASSWORD),
                "role_id": admin_role_id,
                "is_active": True,
            }
        ],
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM users WHERE email = :email"), {"email": ADMIN_EMAIL})
