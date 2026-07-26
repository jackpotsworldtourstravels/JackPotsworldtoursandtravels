-- ============================================================================
-- Admin Portal — Merchant User: username field + phone uniqueness
-- ============================================================================
-- Additive only. "Create User" collects a Username distinct from Email, and
-- the spec's business rules require Username and Phone Number to each be
-- unique (Email already is). No existing column is altered or dropped.
-- ============================================================================

ALTER TABLE partner_users
    ADD COLUMN IF NOT EXISTS username VARCHAR(50);

DO $$ BEGIN
    ALTER TABLE partner_users ADD CONSTRAINT partner_users_username_key UNIQUE (username);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE partner_users ADD CONSTRAINT partner_users_phone_number_key UNIQUE (phone_number);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill the two seeded users so they have a real, distinct username.
UPDATE partner_users SET username = 'meera.iyer' WHERE partner_user_id = 6 AND username IS NULL;
UPDATE partner_users SET username = 'arjun.nair' WHERE partner_user_id = 7 AND username IS NULL;
