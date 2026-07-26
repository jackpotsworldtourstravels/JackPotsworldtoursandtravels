-- ============================================================================
-- Admin Portal — Merchant Management
-- ============================================================================
-- Reuses the existing partners / partner_users tables ("Merchant" is the
-- Admin Portal's label for a partner company) rather than creating parallel
-- merchants/merchant_users tables, per explicit instruction not to duplicate
-- them. Purely additive: new enums + nullable columns only. No existing
-- column, constraint, trigger, or stored procedure is modified.
-- ============================================================================

DO $$ BEGIN
    CREATE TYPE merchant_company_type_enum AS ENUM
        ('gaming_company', 'corporate_company', 'travel_agency', 'business_partner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE merchant_role_type_enum AS ENUM ('admin', 'user', 'maker', 'checker');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE merchant_member_role_enum AS ENUM
        ('admin', 'user', 'data_operator', 'request_ticket', 'cancellation_ticket', 'supervisor', 'manager');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partners
    ADD COLUMN IF NOT EXISTS company_type    merchant_company_type_enum,
    ADD COLUMN IF NOT EXISTS contact_person   VARCHAR(150),
    ADD COLUMN IF NOT EXISTS address          VARCHAR(255),
    ADD COLUMN IF NOT EXISTS city             VARCHAR(100),
    ADD COLUMN IF NOT EXISTS state            VARCHAR(100),
    ADD COLUMN IF NOT EXISTS country          VARCHAR(100),
    ADD COLUMN IF NOT EXISTS gst_number       VARCHAR(20),
    ADD COLUMN IF NOT EXISTS pan_number       VARCHAR(15);

ALTER TABLE partner_users
    ADD COLUMN IF NOT EXISTS role_type    merchant_role_type_enum,
    ADD COLUMN IF NOT EXISTS member_role  merchant_member_role_enum;

-- Backfill the two already-seeded demo companies so the new "Company Type"
-- breakdown has real data rather than nulls, matching their existing names.
UPDATE partners SET company_type = 'gaming_company'    WHERE company_code = 'AURORA01'   AND company_type IS NULL;
UPDATE partners SET company_type = 'corporate_company' WHERE company_code = 'BLUELINE01' AND company_type IS NULL;
UPDATE partner_users SET role_type = 'admin', member_role = 'admin'
    WHERE role_type IS NULL AND partner_user_id IN (SELECT partner_user_id FROM partner_users pu JOIN roles r ON r.id = pu.role_id WHERE r.name = 'partner_admin');
UPDATE partner_users SET role_type = 'user', member_role = 'user'
    WHERE role_type IS NULL AND partner_user_id IN (SELECT partner_user_id FROM partner_users pu JOIN roles r ON r.id = pu.role_id WHERE r.name = 'partner_staff');
