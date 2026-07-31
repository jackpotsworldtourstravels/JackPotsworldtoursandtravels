# Test Credentials Guide

This document contains all test user credentials for development and testing.

## Quick Reference

| Role | Email | Password | Purpose |
|------|-------|----------|---------|
| **Admin** | `testadmin@example.com` | `pass123` | Backend admin portal, user management |
| **Customer** | `testcustomer@example.com` | `pass123` | Customer-facing travel booking portal |
| **Merchant** | `jackpotsworldtours.travels@gmail.com` | `pass123` | Partner/merchant portal (company: TESTM001) — **requires OTP, see caveat** |
| **Super Admin** | `superadmin` | `SuperAdmin@2026` | **NOT seedable — hardcoded, not `pass123`** |

### Two caveats that break "just log in"

1. **Super Admin is not `pass123` and cannot be seeded.** There is no `super_admins`
   table. The credentials are a hardcoded in-memory dict, `_DEMO_SUPER_ADMIN` in
   `backend/app/services/super_admin_service.py`. To change the password you must
   edit that file — no migration or env var affects it.

2. **Merchant login is a 3-step OTP flow, not email+password.** `POST /api/partner-auth/login`
   rejects you unless a `login` OTP was already verified. The OTP is emailed via SMTP
   to the partner user's address, so you must be able to read that inbox. The seeded
   merchant uses the project's real Gmail address `jackpotsworldtours.travels@gmail.com`
   directly. Because `uq_partner_users_email` makes that string exclusive, the demo
   seed `backend/db/partner_portal/gap_completion/08_seed_data.sql` was changed to give
   Meera Iyer (Aurora Gaming Studios) a `+meera` tag instead — the two accounts cannot
   both hold the bare address. Do **not** point a partner user at an `example.com`
   address: the OTP will never arrive and the account becomes impossible to log into.

---

## Account Types & Access

### 1. Admin User
- **Email**: `testadmin@example.com`
- **Password**: `pass123`
- **Role**: Admin
- **Access**: 
  - Admin dashboard
  - User management
  - Reports & analytics
  - System configuration
- **Database**: `users` table (role_id = 2 for admin)

### 2. Customer User
- **Email**: `testcustomer@example.com`
- **Password**: `pass123`
- **Role**: Customer
- **Access**:
  - Customer portal
  - Booking management
  - Wishlist & reviews
  - Payment processing
- **Database**: `users` table (role_id = 1 for user)

### 3. Merchant User
- **Login email**: `jackpotsworldtours.travels@gmail.com` (this is the
  address the OTP is sent to — `partner_users.email`)
- **Password**: `pass123`
- **Company**: Test Merchant Company
- **Company contact email**: `jackpotsworldtours.travels+testm001@gmail.com`
  (`partners.email` — a separate column, not used for authentication)
- **Company Code**: `TESTM001`
- **Company Prefix**: `TM001`
- **Role Type**: admin
- **Member Role**: admin
- **Access**:
  - Partner/merchant portal
  - Booking management
  - Service requests
  - Admin functions for the merchant
- **Database**: 
  - `partners` table (company_code = 'TESTM001')
  - `partner_users` table (role_type = 'admin', member_role = 'admin')

### 4. Super Admin User
- **Type**: JWT-based; authenticated against a hardcoded in-memory dict, no DB record
- **Username**: `superadmin` (or email `superadmin@jackpotsworldtours.com`)
- **Password**: `SuperAdmin@2026` — **not `pass123`**
- **Source**: `_DEMO_SUPER_ADMIN` in `backend/app/services/super_admin_service.py`
- **Access**: System-level administration
- **Note**: The whole super-admin service layer is a mock store that resets on every
  backend restart. Admins created through it are not persisted.

---

## Creating Test Data

### Option 1: Using Migration (Recommended for Development)

```bash
cd backend
alembic upgrade head
```

The migration `0026_test_data_users.py` will automatically create all test users.

### Option 2: Using Standalone Script

Idempotent — safe to re-run; it skips accounts that already exist.

```bash
backend/venv/Scripts/python.exe scripts/create_test_data.py
```

### Option 3: Manual Database Insertion

If you need to create additional test accounts or modify existing ones:

```sql
-- Create test admin
INSERT INTO roles (id, name) VALUES (1, 'user'), (2, 'admin') 
ON CONFLICT (name) DO NOTHING;

-- Hash password "pass123" using bcrypt: $2b$12$... (example)
-- Use: from app.auth.security import hash_password; print(hash_password('pass123'))

INSERT INTO users (full_name, email, hashed_password, role_id, is_active, created_at, updated_at)
VALUES (
    'Test Admin',
    'testadmin@example.com',
    '$2b$12$...[bcrypt_hash_of_pass123]...',
    2,
    true,
    NOW(),
    NOW()
)
ON CONFLICT (email) DO NOTHING;
```

---

## Super Admin Setup

There is no env var, CLI flag, or migration that sets super-admin credentials —
`app/config.py` has no super-admin settings at all. Authentication goes through
`authenticate_super_admin()`, which compares against the hardcoded
`_DEMO_SUPER_ADMIN` dict (plaintext password, marked with a `# TODO` to move to a
real bcrypt-hashed `super_admins` table).

To change the password, edit `backend/app/services/super_admin_service.py`:

```python
_DEMO_SUPER_ADMIN = {
    "username": "superadmin",
    "email": "superadmin@jackpotsworldtours.com",
    "password": "SuperAdmin@2026",   # <-- change here
    ...
}
```

---

## API Testing Examples

### Admin Login

```bash
curl -X POST "http://localhost:8000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testadmin@example.com",
    "password": "pass123"
  }'
```

### Customer Login

Path is `/api/auth/user/login`, and the body field is `identifier` (email **or** mobile).

```bash
curl -X POST "http://localhost:8000/api/auth/user/login" \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "testcustomer@example.com",
    "password": "pass123"
  }'
```

### Merchant Login — three steps

The router prefix is `/api/partner-auth`. Step 3 fails with 400 ("Please verify the
OTP sent to your email first") unless steps 1 and 2 completed, so email+password alone
is not enough.

```bash
curl -X POST "http://localhost:8000/api/partner-auth/otp/request" \
  -H "Content-Type: application/json" \
  -d '{"email": "jackpotsworldtours.travels@gmail.com"}'
```

```bash
curl -X POST "http://localhost:8000/api/partner-auth/otp/verify" \
  -H "Content-Type: application/json" \
  -d '{"email": "jackpotsworldtours.travels@gmail.com", "otp": "123456"}'
```

```bash
curl -X POST "http://localhost:8000/api/partner-auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "jackpotsworldtours.travels@gmail.com", "password": "pass123"}'
```

OTPs expire after 5 minutes (`OTP_TTL_MINUTES`) and are rate limited per account.

**Each OTP is good for exactly one login.** A second `POST /login` without a fresh
OTP returns 400, even inside the 15-minute verification window — the row is marked
`consumed_at` as login claims it (migration `0027_partner_otp_single_use`). Re-run
steps 1 and 2 for every login.

---

## Resetting Test Data

### Remove Test Users

```bash
# Using migration rollback
cd backend
alembic downgrade -1

# Then upgrade again to recreate
alembic upgrade head
```

### Or manually in database

```sql
-- partner_users.partner_id is ON DELETE CASCADE, so removing the partner
-- removes its users too.
DELETE FROM partners WHERE company_code = 'TESTM001';
DELETE FROM users WHERE email IN ('testadmin@example.com', 'testcustomer@example.com');
```

---

## Security Notes

⚠️ **Important**: These credentials are for **development and testing only**.

- ✅ Use in local development
- ✅ Use in staging/test environments
- ❌ **DO NOT** use in production
- ❌ **DO NOT** commit real production credentials to version control

For production:
1. Generate strong, unique passwords
2. Store credentials in secure vaults (AWS Secrets Manager, HashiCorp Vault, etc.)
3. Use environment variables or secret management systems
4. Rotate passwords regularly
5. Enable MFA where possible

---

## Troubleshooting

### "Invalid or expired token" error
- Check token hasn't expired (default: 30 minutes for access tokens)
- Verify you're using the correct `Bearer` prefix in the Authorization header

### "User not found" error
- Ensure test users were created by running migration or script
- Check database connection is working: `psql $DATABASE_URL`

### Password mismatch
- Test credentials always use `pass123`
- Ensure password is hashed with bcrypt (not plain text)
- Use `hash_password()` function from `app.auth.security`

### "Database constraint violation"
- Test users might already exist
- Use `ON CONFLICT DO NOTHING` when inserting to avoid duplicates
- Or delete existing records first using SQL above

---

## Additional Test Data

To create additional test users (different roles, merchant accounts, etc.):

1. **For additional customers**: Use the customer signup endpoint or insert directly into `users` table
2. **For additional merchants**: Create partner in `partners` table, then add partner_users
3. **For different merchant roles**: Use `role_type` and `member_role` enums in `partner_users`

Available merchant roles:
- `role_type`: `admin`, `user`
- `member_role`: `admin`, `user`, `data_operator`, `request_ticket`, `cancellation_ticket`, `supervisor`, `manager`

---

## Files Modified

- `backend/alembic/versions/0026_test_data_users.py` - Migration file
- `scripts/create_test_data.py` - Standalone script
- `TEST_CREDENTIALS.md` - This file
