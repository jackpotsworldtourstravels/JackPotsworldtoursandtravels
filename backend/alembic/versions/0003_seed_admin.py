"""seed admin account

Revision ID: 0003_seed_admin
Revises: 0002_seed_content
Create Date: 2026-07-10

"""
import os
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.auth.security import hash_password

revision: str = "0003_seed_admin"
down_revision: Union[str, None] = "0002_seed_content"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Fixed, documented default so this migration is reproducible no matter how
# many times it's applied (fresh DB, or a downgrade/upgrade cycle) — a randomly
# generated password here is unrecoverable once its one-time console print is
# gone, which is exactly what kept breaking admin login. Override via
# ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD env vars for a real deployment.
DEFAULT_ADMIN_EMAIL = "admin@jackpotsworldtours.com"
DEFAULT_ADMIN_PASSWORD = "AdminPass#2026"


def upgrade() -> None:
    conn = op.get_bind()
    admin_role_id = conn.execute(sa.text("SELECT id FROM roles WHERE name = 'admin'")).scalar()
    if admin_role_id is None:
        raise RuntimeError("admin role not found — run 0001_initial migration first")

    admin_email = os.environ.get("ADMIN_SEED_EMAIL", DEFAULT_ADMIN_EMAIL)
    existing = conn.execute(sa.text("SELECT id FROM users WHERE email = :email"), {"email": admin_email}).scalar()
    if existing:
        return

    admin_password = os.environ.get("ADMIN_SEED_PASSWORD", DEFAULT_ADMIN_PASSWORD)

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
                "email": admin_email,
                "hashed_password": hash_password(admin_password),
                "role_id": admin_role_id,
                "is_active": True,
            }
        ],
    )


def downgrade() -> None:
    conn = op.get_bind()
    admin_email = os.environ.get("ADMIN_SEED_EMAIL", DEFAULT_ADMIN_EMAIL)
    conn.execute(sa.text("DELETE FROM users WHERE email = :email"), {"email": admin_email})
