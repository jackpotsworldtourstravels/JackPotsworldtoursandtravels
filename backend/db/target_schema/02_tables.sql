-- Target 9-table schema — CREATE TABLE
--
-- Staged under ts_ prefixed names so these coexist with the live legacy
-- tables of the same bare names (users, payments, ...) without collision.
-- The final cutover migration renames ts_* -> bare names after the legacy
-- tables are retired. Requires 01_types.sql to have run first.
-- Mirrors backend/app/models/target_schema/*.py exactly.

CREATE TABLE IF NOT EXISTS ts_merchants (
    id                   SERIAL PRIMARY KEY,
    company_code         VARCHAR(32) NOT NULL UNIQUE,
    reference_prefix     VARCHAR(8),
    company_name         VARCHAR(255) NOT NULL,
    company_type         VARCHAR(64),
    contact_person       VARCHAR(255),
    email                VARCHAR(255),
    phone_number         VARCHAR(32),
    address              VARCHAR(300),
    city                 VARCHAR(100),
    state                VARCHAR(100),
    country              VARCHAR(100),
    gst_number           VARCHAR(32),
    pan_number           VARCHAR(32),
    status               ts_merchant_status_enum NOT NULL DEFAULT 'active',
    reference_counters   JSONB NOT NULL DEFAULT '{}',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ts_users (
    id                       SERIAL PRIMARY KEY,
    user_type                ts_user_type_enum NOT NULL,
    merchant_id              INTEGER REFERENCES ts_merchants(id),
    role_type                ts_merchant_role_type_enum,
    member_role              ts_merchant_member_role_enum,
    permissions              JSONB,
    username                 VARCHAR(64) UNIQUE,
    email                    VARCHAR(255) NOT NULL UNIQUE,
    phone_number             VARCHAR(32),
    hashed_password          VARCHAR(255) NOT NULL,
    full_name                VARCHAR(255) NOT NULL,
    gender                   VARCHAR(16),
    dob                      DATE,
    country                  VARCHAR(100),
    state                    VARCHAR(100),
    city                     VARCHAR(100),
    address                  VARCHAR(300),
    otp_hash                 VARCHAR(255),
    otp_purpose              ts_otp_purpose_enum,
    otp_expires_at           TIMESTAMPTZ,
    otp_attempts             SMALLINT NOT NULL DEFAULT 0,
    otp_verified_at          TIMESTAMPTZ,
    reset_token_hash         VARCHAR(255),
    reset_token_expires_at   TIMESTAMPTZ,
    status                   ts_user_status_enum NOT NULL DEFAULT 'active',
    is_verified              BOOLEAN NOT NULL DEFAULT false,
    force_logout_at          TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_ts_users_merchant_staff_has_merchant
        CHECK (user_type != 'merchant_staff' OR merchant_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_ts_users_email ON ts_users(email);

CREATE TABLE IF NOT EXISTS ts_service_requests (
    id                    SERIAL PRIMARY KEY,
    request_number        VARCHAR(32) NOT NULL UNIQUE,
    request_type          ts_request_type_enum NOT NULL,
    channel               ts_channel_enum NOT NULL,
    user_id               INTEGER REFERENCES ts_users(id),
    merchant_id           INTEGER REFERENCES ts_merchants(id),
    parent_request_id     INTEGER REFERENCES ts_service_requests(id),
    item_type             ts_item_type_enum,
    item_id               INTEGER,
    trip_type             ts_trip_type_enum,
    cabin_class            ts_cabin_class_enum,
    departure              VARCHAR(255),
    arrival                VARCHAR(255),
    departure_date         DATE,
    return_date            DATE,
    new_travel_date        DATE,
    quantity                SMALLINT,
    coupon_code             VARCHAR(32),
    total_amount            NUMERIC(12, 2),
    amount_requested        NUMERIC(12, 2),
    status                  ts_request_status_enum NOT NULL DEFAULT 'pending',
    priority                 ts_priority_enum,
    subject                  TEXT,
    description               TEXT,
    reason                    TEXT,
    rejection_reason          TEXT,
    details                   JSONB,
    approved_by               INTEGER REFERENCES ts_users(id),
    rejected_by               INTEGER REFERENCES ts_users(id),
    resolved_by               INTEGER REFERENCES ts_users(id),
    approved_at               TIMESTAMPTZ,
    rejected_at               TIMESTAMPTZ,
    resolved_at               TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ts_payments (
    id                   SERIAL PRIMARY KEY,
    record_type          ts_payment_record_type_enum NOT NULL,
    service_request_id   INTEGER REFERENCES ts_service_requests(id),
    user_id              INTEGER REFERENCES ts_users(id),
    merchant_id          INTEGER REFERENCES ts_merchants(id),
    amount               NUMERIC(12, 2),
    method               VARCHAR(32),
    status               ts_payment_status_enum,
    transaction_ref      VARCHAR(64),
    refund_reference     VARCHAR(64),
    refunded_at          TIMESTAMPTZ,
    code                 VARCHAR(32) UNIQUE,
    discount_type        ts_discount_type_enum,
    discount_value       NUMERIC(8, 2),
    applicable_item_type ts_item_type_enum,
    valid_from           TIMESTAMPTZ,
    valid_until          TIMESTAMPTZ,
    usage_limit          INTEGER,
    used_count           INTEGER NOT NULL DEFAULT 0,
    min_order_amount     NUMERIC(12, 2),
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_ts_payments_transaction_has_amount
        CHECK (record_type != 'transaction' OR amount IS NOT NULL),
    CONSTRAINT ck_ts_payments_reference_has_code
        CHECK (record_type = 'transaction' OR code IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ts_passenger_data (
    id                            SERIAL PRIMARY KEY,
    service_request_id            INTEGER NOT NULL REFERENCES ts_service_requests(id) ON DELETE CASCADE,
    full_name                     VARCHAR(255) NOT NULL,
    gender                        ts_gender_enum,
    passenger_type                ts_passenger_type_enum,
    date_of_birth                 DATE,
    passport_number                VARCHAR(32),
    passport_issue_date             DATE,
    passport_expiry_date            DATE,
    passport_issuing_country        CHAR(2),
    nationality_country             CHAR(2),
    baggage_option                  ts_baggage_option_enum,
    meal_option                     ts_meal_option_enum,
    seat_preference                 VARCHAR(16),
    special_assistance               TEXT,
    special_services                 JSONB,
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_ts_passenger_data_passport_country_iso2
        CHECK (passport_issuing_country IS NULL OR passport_issuing_country ~ '^[A-Z]{2}$'),
    CONSTRAINT ck_ts_passenger_data_nationality_country_iso2
        CHECK (nationality_country IS NULL OR nationality_country ~ '^[A-Z]{2}$')
);
CREATE INDEX IF NOT EXISTS ix_ts_passenger_data_service_request ON ts_passenger_data(service_request_id);

CREATE TABLE IF NOT EXISTS ts_communication_settings (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER REFERENCES ts_users(id) ON DELETE CASCADE,
    merchant_id    INTEGER REFERENCES ts_merchants(id) ON DELETE CASCADE,
    email_enabled     BOOLEAN NOT NULL DEFAULT true,
    sms_enabled       BOOLEAN NOT NULL DEFAULT true,
    whatsapp_enabled  BOOLEAN NOT NULL DEFAULT true,
    push_enabled      BOOLEAN NOT NULL DEFAULT true,
    preferences       JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_ts_communication_settings_exactly_one_owner
        CHECK ((user_id IS NOT NULL) != (merchant_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ts_msg_logs (
    id                      BIGSERIAL PRIMARY KEY,
    channel                 ts_msg_channel_enum NOT NULL,
    direction                ts_msg_direction_enum NOT NULL,
    user_id                  INTEGER REFERENCES ts_users(id) ON DELETE SET NULL,
    merchant_id               INTEGER REFERENCES ts_merchants(id) ON DELETE SET NULL,
    recipient_email            VARCHAR(255),
    recipient_phone             VARCHAR(32),
    subject                      VARCHAR(200),
    message                       TEXT,
    related_entity_type            VARCHAR(32),
    related_entity_id               INTEGER,
    is_read                          BOOLEAN NOT NULL DEFAULT false,
    status                            ts_msg_status_enum,
    sent_at                           TIMESTAMPTZ,
    read_at                           TIMESTAMPTZ,
    created_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ts_msg_logs_user ON ts_msg_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ts_msg_logs_merchant ON ts_msg_logs(merchant_id, created_at);

CREATE TABLE IF NOT EXISTS ts_system_logs (
    id                    BIGSERIAL PRIMARY KEY,
    log_type              ts_log_type_enum NOT NULL,
    user_id                INTEGER REFERENCES ts_users(id) ON DELETE SET NULL,
    entity_type             VARCHAR(32),
    entity_id                INTEGER,
    event                     TEXT,
    old_value                 TEXT,
    new_value                  TEXT,
    activity_type              VARCHAR(60),
    module                      VARCHAR(40),
    status                       VARCHAR(20) NOT NULL DEFAULT 'success',
    ip_address                 VARCHAR(45),
    user_agent                  TEXT,
    session_token_hash            VARCHAR(255),
    session_expires_at             TIMESTAMPTZ,
    logged_out_at                   TIMESTAMPTZ,
    last_seen_at                    TIMESTAMPTZ,
    log_metadata                     JSONB,
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ts_system_logs_created_at ON ts_system_logs(created_at);
CREATE INDEX IF NOT EXISTS ix_ts_system_logs_entity ON ts_system_logs(log_type, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS ts_audit_logs (
    id             BIGSERIAL PRIMARY KEY,
    entity_type    VARCHAR(32) NOT NULL,
    entity_id      INTEGER NOT NULL,
    action         ts_audit_action_enum NOT NULL,
    changed_by     INTEGER REFERENCES ts_users(id) ON DELETE SET NULL,
    old_data       JSONB,
    new_data       JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ts_audit_logs_entity ON ts_audit_logs(entity_type, entity_id);

-- Catalog tables (flights/hotels/cruises/tour_packages) are NOT duplicated —
-- they stay the existing live tables. This is the one schema change applied
-- directly to a legacy table rather than staged under ts_: additive column
-- only, safe to run without affecting current app behavior (SQLAlchemy
-- ignores columns it doesn't map until travel.py is updated at cutover).
ALTER TABLE flights       ADD COLUMN IF NOT EXISTS seasonal_pricing JSONB;
ALTER TABLE hotels        ADD COLUMN IF NOT EXISTS seasonal_pricing JSONB;
ALTER TABLE cruises       ADD COLUMN IF NOT EXISTS seasonal_pricing JSONB;
ALTER TABLE tour_packages ADD COLUMN IF NOT EXISTS seasonal_pricing JSONB;
