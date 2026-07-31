"""Test data: admin, superadmin, and merchant users

Revision ID: 0026_test_data_users
Revises: 0025_target_schema_9table
Create Date: 2026-07-30

"""
import datetime
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.auth.security import hash_password

revision: str = "0026_test_data_users"
down_revision: Union[str, None] = "0025_target_schema_9table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


users_table = sa.table(
    "users",
    sa.column("full_name", sa.String),
    sa.column("email", sa.String),
    sa.column("hashed_password", sa.String),
    sa.column("role_id", sa.Integer),
    sa.column("is_active", sa.Boolean),
)


def upgrade() -> None:
    conn = op.get_bind()

    # Create test ADMIN user
    admin_role_id = conn.execute(sa.text("SELECT id FROM roles WHERE name = 'admin'")).scalar()
    if admin_role_id is None:
        raise RuntimeError("admin role not found")

    # Check if admin test user already exists
    existing_admin = conn.execute(
        sa.text("SELECT id FROM users WHERE email = :email"),
        {"email": "testadmin@example.com"}
    ).scalar()

    if not existing_admin:
        op.bulk_insert(
            users_table,
            [
                {
                    "full_name": "Test Admin",
                    "email": "testadmin@example.com",
                    "hashed_password": hash_password("pass123"),
                    "role_id": admin_role_id,
                    "is_active": True,
                }
            ],
        )

    # Create test CUSTOMER user
    user_role_id = conn.execute(sa.text("SELECT id FROM roles WHERE name = 'user'")).scalar()
    if user_role_id is None:
        raise RuntimeError("user role not found")

    existing_customer = conn.execute(
        sa.text("SELECT id FROM users WHERE email = :email"),
        {"email": "testcustomer@example.com"}
    ).scalar()

    if not existing_customer:
        op.bulk_insert(
            users_table,
            [
                {
                    "full_name": "Test Customer",
                    "email": "testcustomer@example.com",
                    "hashed_password": hash_password("pass123"),
                    "role_id": user_role_id,
                    "is_active": True,
                }
            ],
        )

    # Create test MERCHANT/PARTNER
    existing_partner = conn.execute(
        sa.text("SELECT partner_id FROM partners WHERE company_code = :code"),
        {"code": "TESTM001"}
    ).scalar()

    if not existing_partner:
        partners_table = sa.table(
            "partners",
            sa.column("company_name", sa.String),
            sa.column("company_code", sa.String),
            sa.column("reference_prefix", sa.String),
            sa.column("email", sa.String),
            sa.column("phone_number", sa.String),
            sa.column("status", sa.String),
            sa.column("created_at", sa.DateTime),
            sa.column("updated_at", sa.DateTime),
        )
        op.bulk_insert(
            partners_table,
            [
                {
                    "company_name": "Test Merchant Company",
                    "company_code": "TESTM001",
                    "reference_prefix": "TM001",
                    # Company contact address; distinct plus-tag from the partner
                    # user's (+testmerchant) so the two mailboxes stay tellable apart.
                    "email": "jackpotsworldtours.travels+testm001@gmail.com",
                    "phone_number": "+91-9876543210",
                    "status": "active",
                    "created_at": datetime.datetime.utcnow(),
                    "updated_at": datetime.datetime.utcnow(),
                }
            ],
        )

        # Get the inserted partner ID
        partner_id = conn.execute(
            sa.text("SELECT partner_id FROM partners WHERE company_code = :code"),
            {"code": "TESTM001"}
        ).scalar()

        # Create partner user
        partner_users_table = sa.table(
            "partner_users",
            sa.column("partner_id", sa.Integer),
            sa.column("full_name", sa.String),
            sa.column("username", sa.String),
            sa.column("email", sa.String),
            sa.column("phone_number", sa.String),
            sa.column("password_hash", sa.String),
            sa.column("status", sa.String),
            sa.column("role_type", sa.String),
            sa.column("member_role", sa.String),
            sa.column("created_at", sa.DateTime),
            sa.column("updated_at", sa.DateTime),
        )
        op.bulk_insert(
            partner_users_table,
            [
                {
                    "partner_id": partner_id,
                    "full_name": "Test Merchant Admin",
                    "username": "testmerchant",
                    # Real deliverable inbox, not example.com: partner login emails
                    # a 5-minute OTP here and the flow cannot complete without it
                    # (see app/services/partner_auth_service.py). Note this is the
                    # BARE address — 08_seed_data.sql (migration 0016) was changed
                    # to give Meera Iyer a +meera tag so this one stays free.
                    # Both must stay distinct: uq_partner_users_email.
                    "email": "jackpotsworldtours.travels@gmail.com",
                    "phone_number": "+91-9876543210",
                    "password_hash": hash_password("pass123"),
                    "status": "active",
                    "role_type": "admin",
                    "member_role": "admin",
                    "created_at": datetime.datetime.utcnow(),
                    "updated_at": datetime.datetime.utcnow(),
                }
            ],
        )


def downgrade() -> None:
    conn = op.get_bind()
    # partner_users.partner_id is ON DELETE CASCADE, so dropping the partner
    # takes its users with it — don't match users by an email prefix, which
    # silently stopped matching once the seed moved to a plus-addressed inbox.
    conn.execute(sa.text("DELETE FROM partners WHERE company_code = :code"), {"code": "TESTM001"})
    # Delete test users
    conn.execute(sa.text("DELETE FROM users WHERE email IN (:admin, :customer)"),
                 {"admin": "testadmin@example.com", "customer": "testcustomer@example.com"})
