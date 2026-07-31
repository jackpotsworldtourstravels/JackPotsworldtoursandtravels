#!/usr/bin/env python3
"""
Standalone script to create test user data. Runnable from anywhere:
    backend/venv/Scripts/python.exe scripts/create_test_data.py
"""
import sys
import datetime
from pathlib import Path

# app/ lives under backend/, so point at that - not the repo root.
backend_path = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(backend_path))

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.session import engine
from app.auth.security import hash_password
from app.models.user import User, Role
from app.models.partner import Partner, PartnerUser


def create_test_users():
    """Create test users for development/testing."""
    with Session(engine) as session:
        # Get admin and user roles
        admin_role = session.execute(select(Role).where(Role.name == "admin")).scalar_one_or_none()
        user_role = session.execute(select(Role).where(Role.name == "user")).scalar_one_or_none()

        if not admin_role or not user_role:
            print("[ERROR] Error: Roles not found. Run migrations first.")
            return False

        # Create test ADMIN user
        existing_admin = session.execute(
            select(User).where(User.email == "testadmin@example.com")
        ).scalar_one_or_none()

        if not existing_admin:
            admin = User(
                full_name="Test Admin",
                email="testadmin@example.com",
                hashed_password=hash_password("pass123"),
                role_id=admin_role.id,
                is_active=True,
            )
            session.add(admin)
            print("[OK] Created test ADMIN user: testadmin@example.com / pass123")
        else:
            print("[SKIP] Test ADMIN already exists: testadmin@example.com")

        # Create test CUSTOMER user
        existing_customer = session.execute(
            select(User).where(User.email == "testcustomer@example.com")
        ).scalar_one_or_none()

        if not existing_customer:
            customer = User(
                full_name="Test Customer",
                email="testcustomer@example.com",
                hashed_password=hash_password("pass123"),
                role_id=user_role.id,
                is_active=True,
            )
            session.add(customer)
            print("[OK] Created test CUSTOMER user: testcustomer@example.com / pass123")
        else:
            print("[SKIP] Test CUSTOMER already exists: testcustomer@example.com")

        session.commit()

        # Create test MERCHANT/PARTNER
        existing_partner = session.execute(
            select(Partner).where(Partner.company_code == "TESTM001")
        ).scalar_one_or_none()

        if not existing_partner:
            partner = Partner(
                company_name="Test Merchant Company",
                company_code="TESTM001",
                reference_prefix="TM001",
                # Company contact address; plus-tagged so it stays distinct from
                # the partner user's bare login address below.
                email="jackpotsworldtours.travels+testm001@gmail.com",
                phone_number="+91-9876543210",
                status="active",
                created_at=datetime.datetime.utcnow(),
                updated_at=datetime.datetime.utcnow(),
            )
            session.add(partner)
            session.flush()  # Get the partner_id before creating partner_user

            # Create partner user
            partner_user = PartnerUser(
                partner_id=partner.partner_id,
                full_name="Test Merchant Admin",
                username="testmerchant",
                # Real deliverable inbox, not example.com: partner login emails a
                # 5-minute OTP here and the flow cannot complete without it. This
                # is the BARE address; 08_seed_data.sql gives Meera Iyer a +meera
                # tag so it stays free under uq_partner_users_email.
                email="jackpotsworldtours.travels@gmail.com",
                phone_number="+91-9876543210",
                password_hash=hash_password("pass123"),
                status="active",
                role_type="admin",
                member_role="admin",
                created_at=datetime.datetime.utcnow(),
                updated_at=datetime.datetime.utcnow(),
            )
            session.add(partner_user)
            session.commit()
            print("[OK] Created test MERCHANT: jackpotsworldtours.travels@gmail.com / pass123")
            print(f"   Company: Test Merchant Company (Code: TESTM001)")
        else:
            print("[SKIP] Test MERCHANT already exists: TESTM001")

    print("\n" + "=" * 60)
    print("=== TEST CREDENTIALS")
    print("=" * 60)
    print("\n* ADMIN LOGIN (Backend/Admin Portal):")
    print("   Email: testadmin@example.com")
    print("   Password: pass123")
    print("   Role: Admin")

    print("\n* CUSTOMER LOGIN (Customer Portal):")
    print("   Email: testcustomer@example.com")
    print("   Password: pass123")
    print("   Role: Customer")

    print("\n* MERCHANT LOGIN (Partner/Merchant Portal):")
    print("   Email: jackpotsworldtours.travels@gmail.com")
    print("   Password: pass123")
    print("   Company: Test Merchant Company")
    print("   Role: Merchant Admin")

    print("\n* SUPER ADMIN (NOT created by this script):")
    print("   Credentials are hardcoded in app/services/super_admin_service.py")
    print("   (_DEMO_SUPER_ADMIN) - there is no super_admins table yet, so this")
    print("   script cannot seed one and the password is NOT pass123.")
    print("   Username: superadmin   Password: SuperAdmin@2026")

    print("\n" + "=" * 60)
    return True


if __name__ == "__main__":
    success = create_test_users()
    sys.exit(0 if success else 1)
