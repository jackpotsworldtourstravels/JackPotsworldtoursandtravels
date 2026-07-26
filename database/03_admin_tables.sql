-- =========================================================================
-- 03_admin_tables.sql
-- Admin domain. Owns its OWN authentication, profile, session, activity,
-- notification, and RBAC data -- no table here is shared with Merchant or
-- User. `admins` replaces the `users` rows that used to carry
-- roles.name = 'admin' (the original "mixing" problem).
--
-- v2 changes from v1:
--   - admins.role_id now points at the new admin_roles table (not the
--     retired shared `roles` table).
--   - admin_profiles (NEW): extended profile fields split out for
--     symmetry with partner_profiles/user_profiles. admin.html's own
--     Profile tab currently only edits full_name (kept on `admins`) and
--     password -- phone_number/designation/profile_photo are provisioned
--     for a future profile-detail screen, not yet in the UI.
--   - admin_notifications (NEW, but NOT purely provisioned): admin.html
--     already has a live notification bell (`notifBellBtn` /
--     loadNotifBell()) that currently calls the SAME `/api/notifications`
--     endpoint the customer portal uses -- i.e. today an admin's
--     notifications and a customer's notifications are the same table,
--     keyed off the same shared `users.id`. That is another instance of
--     the exact identity-mixing this redesign fixes. admin_notifications
--     gives the admin bell its own domain-scoped backing table.
--   - admin_roles / admin_permissions / admin_role_permissions (NEW):
--     replaces the retired shared `roles`/`permissions`/`role_permissions`
--     for the Admin domain specifically. Today there is exactly one admin
--     role ('admin'); this schema is ready for more without another
--     migration.
-- =========================================================================

CREATE TABLE admin_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL
);

CREATE TABLE admin_permissions (
    id SERIAL PRIMARY KEY,
    permission_key VARCHAR(80) NOT NULL,
    description VARCHAR(200)
);

CREATE TABLE admin_role_permissions (
    admin_role_id INTEGER NOT NULL,
    admin_permission_id INTEGER NOT NULL,
    PRIMARY KEY (admin_role_id, admin_permission_id)
);

CREATE TABLE admins (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    hashed_password VARCHAR(255) NOT NULL,
    role_id INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    reset_token_hash VARCHAR(255),
    reset_token_expires_at TIMESTAMP,
    last_login_at TIMESTAMP,
    login_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Provisioned -- see file header. One row per admin.
CREATE TABLE admin_profiles (
    admin_id INTEGER PRIMARY KEY,
    phone_number VARCHAR(20),
    designation VARCHAR(100),
    profile_photo VARCHAR(500)
);

CREATE TABLE admin_sessions (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    login_at TIMESTAMP NOT NULL DEFAULT now(),
    logout_at TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT now(),
    ip_address VARCHAR(50),
    browser VARCHAR(60),
    os VARCHAR(60),
    device VARCHAR(60),
    is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE admin_activity_logs (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER,
    action VARCHAR(200) NOT NULL,
    activity_type VARCHAR(60),
    module VARCHAR(40),
    description VARCHAR(500),
    reference_id INTEGER,
    ip_address VARCHAR(50),
    browser VARCHAR(60),
    device VARCHAR(60),
    status VARCHAR(20) NOT NULL DEFAULT 'success',
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Real, live functionality -- see file header (currently backed by the
-- shared `notifications` table via the admin's `users` row; this is its
-- proper domain-scoped home).
CREATE TABLE admin_notifications (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL,
    message VARCHAR(2000) NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);
