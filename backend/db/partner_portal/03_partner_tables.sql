-- Partner Portal — 03: Partner identity tables
-- Depends on: 01_types.sql, existing `roles` table

CREATE TABLE partners (
    partner_id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_name       VARCHAR(150) NOT NULL,
    company_code       VARCHAR(30) NOT NULL,
    reference_prefix   VARCHAR(6) NOT NULL,
    email              VARCHAR(255) NOT NULL,
    phone_number       VARCHAR(20),
    status             partner_status_enum NOT NULL DEFAULT 'active',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_partners_company_code UNIQUE (company_code),
    CONSTRAINT uq_partners_reference_prefix UNIQUE (reference_prefix),
    CONSTRAINT uq_partners_email UNIQUE (email),
    CONSTRAINT ck_partners_reference_prefix_format CHECK (reference_prefix ~ '^[A-Z0-9]{2,6}$')
);

CREATE TABLE partner_users (
    partner_user_id  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_id       INTEGER NOT NULL REFERENCES partners (partner_id) ON DELETE CASCADE,
    role_id          INTEGER NOT NULL REFERENCES roles (id),
    full_name        VARCHAR(150) NOT NULL,
    email            VARCHAR(255) NOT NULL,
    phone_number     VARCHAR(20),
    password_hash    VARCHAR(255),
    status           partner_user_status_enum NOT NULL DEFAULT 'active',
    last_login_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_partner_users_email UNIQUE (email)
);

CREATE INDEX idx_partner_users_partner_id ON partner_users (partner_id);
CREATE INDEX idx_partner_users_role_id ON partner_users (role_id);

-- OTP codes are always stored hashed (same bcrypt/passlib library the app
-- already uses for passwords) and expire; SQL never sees a plaintext code.
CREATE TABLE partner_otp_requests (
    otp_id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_user_id  INTEGER NOT NULL REFERENCES partner_users (partner_user_id) ON DELETE CASCADE,
    otp_hash         VARCHAR(255) NOT NULL,
    purpose          otp_purpose_enum NOT NULL,
    attempt_count    SMALLINT NOT NULL DEFAULT 0,
    expires_at       TIMESTAMPTZ NOT NULL,
    verified_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_partner_otp_attempt_count CHECK (attempt_count >= 0)
);

CREATE INDEX idx_partner_otp_requests_user_purpose
    ON partner_otp_requests (partner_user_id, purpose, verified_at);
