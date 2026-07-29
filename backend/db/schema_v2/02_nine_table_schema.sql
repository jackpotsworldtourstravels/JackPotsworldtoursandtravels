-- =====================================================================
-- 02_nine_table_schema.sql
-- The nine-table design. Replaces the 43-object legacy schema.
--
--   1. users                   identity, roles, permissions, OTP state
--   2. merchants               B2B partner companies + wallet/credit
--   3. service_requests        catalog, bookings, and every request type
--   4. payments                money movement, discounts, refunds
--   5. passenger_data          travellers attached to a request
--   6. communication_settings  per-merchant channel preferences
--   7. msg_logs                every outbound/inbound message
--   8. system_logs             sessions, activity, report generation
--   9. audit_logs              row-level change history
--
-- Design notes that matter:
--
--  * users <-> merchants is a mutual reference (users.merchant_id and
--    merchants.created_by). merchants is created first without the FK,
--    which is added by ALTER at the end, breaking the cycle.
--
--  * service_requests is self-referencing via parent_request_id. This is
--    load-bearing, not decorative: a cancellation/refund/date-change row
--    points at the booking it modifies, and a booking points at the
--    catalog_item it was made against. Without it the merge of seven
--    legacy tables into one loses the relationships between them.
--
--  * Catalog inventory (legacy flights/hotels/cruises/tour_packages) is
--    stored as service_requests rows with request_type='catalog_item'.
--    See the trade-off note in docs/SCHEMA_V2.md — this is the single
--    biggest compromise the nine-table limit forces.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ENUM types
-- ---------------------------------------------------------------------
CREATE TYPE user_role_enum        AS ENUM ('super_admin', 'admin', 'merchant_admin', 'merchant_user', 'customer');
CREATE TYPE user_status_enum      AS ENUM ('active', 'inactive', 'blocked', 'suspended');
CREATE TYPE merchant_status_enum  AS ENUM ('active', 'inactive', 'suspended');
CREATE TYPE company_type_enum     AS ENUM ('gaming_company', 'corporate_company', 'travel_agency', 'business_partner', 'direct_customer');

CREATE TYPE request_type_enum     AS ENUM (
    'catalog_item',              -- inventory: a flight/hotel/cruise/package on sale
    'booking',
    'ticket_enquiry',
    'cancellation',
    'refund',
    'date_change',
    'passenger_modification',
    'support_ticket',
    'review',
    'wishlist'
);
CREATE TYPE request_status_enum   AS ENUM ('draft', 'submitted', 'pending_approval', 'in_review', 'approved', 'rejected', 'completed', 'cancelled');
CREATE TYPE priority_enum         AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE travel_type_enum      AS ENUM ('flight', 'hotel', 'cruise', 'package');

CREATE TYPE payment_type_enum     AS ENUM ('booking_payment', 'refund', 'wallet_topup', 'adjustment');
CREATE TYPE payment_status_enum   AS ENUM ('pending', 'processing', 'success', 'failed', 'refunded', 'partially_refunded');

CREATE TYPE gender_enum           AS ENUM ('male', 'female', 'other');
CREATE TYPE passenger_type_enum   AS ENUM ('adult', 'child', 'infant');
CREATE TYPE seat_preference_enum  AS ENUM ('window', 'aisle', 'middle', 'front_row', 'exit_row');

CREATE TYPE otp_purpose_enum      AS ENUM ('login', 'password_reset', 'verification');
CREATE TYPE message_type_enum     AS ENUM ('otp', 'email', 'sms', 'whatsapp', 'live_chat', 'push', 'newsletter', 'contact_us', 'notification');
CREATE TYPE message_status_enum   AS ENUM ('queued', 'sent', 'delivered', 'failed', 'read', 'bounced');

CREATE TYPE audit_operation_enum  AS ENUM ('INSERT', 'UPDATE', 'DELETE');


-- ---------------------------------------------------------------------
-- Shared trigger function: keeps updated_at honest without app support.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =====================================================================
-- 2. merchants   (created first: users.merchant_id references it)
--    Absorbs: partners, partner wallet fields, booking_reference_counters
-- =====================================================================
CREATE TABLE merchants (
    merchant_id      BIGSERIAL     PRIMARY KEY,
    merchant_code    VARCHAR(32)   NOT NULL,
    merchant_name    VARCHAR(150)  NOT NULL,
    company_name     VARCHAR(200)  NOT NULL,
    company_type     company_type_enum NOT NULL DEFAULT 'business_partner',
    email            VARCHAR(255)  NOT NULL,
    phone            VARCHAR(30),

    -- Absorbed from booking_reference_counters: each merchant owns its own
    -- reference series, so a counter table is unnecessary.
    reference_prefix VARCHAR(8)    NOT NULL,
    booking_sequence INTEGER       NOT NULL DEFAULT 0,

    wallet_balance   NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit_limit     NUMERIC(14,2) NOT NULL DEFAULT 0,

    country          VARCHAR(100),
    country_code     CHAR(2),
    city             VARCHAR(100),
    address          TEXT,

    status           merchant_status_enum NOT NULL DEFAULT 'active',
    created_by       BIGINT,                       -- FK added after users exists
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT uq_merchants_code   UNIQUE (merchant_code),
    CONSTRAINT uq_merchants_email  UNIQUE (email),
    CONSTRAINT uq_merchants_prefix UNIQUE (reference_prefix),
    CONSTRAINT ck_merchants_wallet_non_negative  CHECK (wallet_balance >= 0),
    CONSTRAINT ck_merchants_credit_non_negative  CHECK (credit_limit  >= 0),
    CONSTRAINT ck_merchants_sequence_non_negative CHECK (booking_sequence >= 0)
);

CREATE INDEX ix_merchants_status       ON merchants (status);
CREATE INDEX ix_merchants_company_type ON merchants (company_type);

CREATE TRIGGER trg_merchants_updated_at
    BEFORE UPDATE ON merchants
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- =====================================================================
-- 1. users
--    Absorbs: users, roles, permissions, role_permissions, partner_users,
--             partner_otp_requests (current state only), user profile fields
-- =====================================================================
CREATE TABLE users (
    user_id       BIGSERIAL    PRIMARY KEY,
    merchant_id   BIGINT       REFERENCES merchants (merchant_id) ON DELETE CASCADE,

    role          user_role_enum NOT NULL DEFAULT 'customer',
    -- Absorbed from permissions + role_permissions. A JSONB array of
    -- permission codes, e.g. ["booking.approve", "reports.export"].
    -- Justified in docs/SCHEMA_V2.md: the alternative needs 2 more tables.
    permissions   JSONB        NOT NULL DEFAULT '[]'::jsonb,

    full_name     VARCHAR(150) NOT NULL,
    email         VARCHAR(255) NOT NULL,
    phone         VARCHAR(30),
    password_hash VARCHAR(255) NOT NULL,

    -- Absorbed from the extended profile columns added by migration 0008
    -- (address, city, dob, gender, passport, preferences, ...). Sparse and
    -- never filtered on, so JSONB rather than 15 mostly-NULL columns.
    profile       JSONB        NOT NULL DEFAULT '{}'::jsonb,

    -- Absorbed from partner_otp_requests. Only the in-flight OTP lives here;
    -- the full history is written to msg_logs.
    otp_enabled      BOOLEAN   NOT NULL DEFAULT false,
    otp_code_hash    VARCHAR(255),
    otp_purpose      otp_purpose_enum,
    otp_expires_at   TIMESTAMPTZ,
    otp_attempts     SMALLINT  NOT NULL DEFAULT 0,
    otp_requested_at TIMESTAMPTZ,

    email_verified BOOLEAN     NOT NULL DEFAULT false,
    status        user_status_enum NOT NULL DEFAULT 'active',
    last_login    TIMESTAMPTZ,
    failed_login_attempts SMALLINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT ck_users_permissions_is_array CHECK (jsonb_typeof(permissions) = 'array'),
    CONSTRAINT ck_users_profile_is_object    CHECK (jsonb_typeof(profile) = 'object'),
    CONSTRAINT ck_users_otp_attempts_sane    CHECK (otp_attempts >= 0),

    -- Enforces the portal boundary in the database rather than trusting the
    -- service layer: merchant users must belong to a merchant, platform
    -- users and retail customers must not.
    CONSTRAINT ck_users_merchant_scope CHECK (
        (role IN ('merchant_admin', 'merchant_user') AND merchant_id IS NOT NULL)
        OR
        (role IN ('super_admin', 'admin', 'customer')  AND merchant_id IS NULL)
    )
);

CREATE INDEX ix_users_merchant_id ON users (merchant_id);
CREATE INDEX ix_users_role        ON users (role);
CREATE INDEX ix_users_status      ON users (status);
CREATE INDEX ix_users_permissions ON users USING GIN (permissions);

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Close the merchants -> users cycle now that users exists.
ALTER TABLE merchants
    ADD CONSTRAINT fk_merchants_created_by
    FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE SET NULL;


-- =====================================================================
-- 3. service_requests
--    Absorbs: flights, hotels, cruises, tour_packages, seasonal_prices,
--             bookings, partner_bookings, service_requests,
--             cancellation_requests, refund_requests, date_change_requests,
--             passenger_modification_requests, support_tickets, reviews,
--             wishlist, partner_booking_status_history,
--             service_request_status_history, ancillary_service_catalog
-- =====================================================================
CREATE TABLE service_requests (
    request_id        BIGSERIAL   PRIMARY KEY,
    request_number    VARCHAR(40) NOT NULL,

    -- Booking -> catalog_item, and cancellation/refund/date_change ->
    -- booking. This is what preserves the seven-table merge.
    parent_request_id BIGINT      REFERENCES service_requests (request_id) ON DELETE CASCADE,

    merchant_id       BIGINT      REFERENCES merchants (merchant_id) ON DELETE CASCADE,
    user_id           BIGINT      REFERENCES users (user_id) ON DELETE SET NULL,

    request_type      request_type_enum NOT NULL,
    booking_reference VARCHAR(40),
    travel_type       travel_type_enum,

    status            request_status_enum NOT NULL DEFAULT 'draft',
    priority          priority_enum       NOT NULL DEFAULT 'normal',

    title             VARCHAR(255),
    remarks           TEXT,

    -- Type-specific payload. For catalog_item: airline/flight_number/route/
    -- departure, or hotel address/amenities/room types, etc. For booking:
    -- the snapshot of those values at purchase time. For date_change:
    -- {"old_date":..., "new_date":...}. Documented per type in
    -- docs/SCHEMA_V2.md.
    travel_details    JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- Absorbs seasonal_prices: base price plus any seasonal//campaign
    -- overrides that applied, as a snapshot.
    pricing           JSONB       NOT NULL DEFAULT '{}'::jsonb,

    quantity          INTEGER     NOT NULL DEFAULT 1,
    total_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,

    -- Inventory fields, meaningful for request_type='catalog_item'.
    available_units   INTEGER,
    low_stock_threshold INTEGER,

    -- Absorbs reviews.rating.
    rating            SMALLINT,

    requested_date    TIMESTAMPTZ NOT NULL DEFAULT now(),
    travel_date       DATE,
    return_date       DATE,

    assigned_admin    BIGINT      REFERENCES users (user_id) ON DELETE SET NULL,
    approved_by       BIGINT      REFERENCES users (user_id) ON DELETE SET NULL,
    approved_at       TIMESTAMPTZ,
    rejection_reason  TEXT,
    completed_at      TIMESTAMPTZ,
    resolved_at       TIMESTAMPTZ,

    -- Absorbs the two *_status_history tables: append-only array of
    -- {from, to, by, at, note} objects.
    status_history    JSONB       NOT NULL DEFAULT '[]'::jsonb,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_service_requests_number UNIQUE (request_number),
    CONSTRAINT ck_sr_quantity_positive    CHECK (quantity > 0),
    CONSTRAINT ck_sr_amount_non_negative  CHECK (total_amount >= 0),
    CONSTRAINT ck_sr_rating_range         CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
    CONSTRAINT ck_sr_details_is_object    CHECK (jsonb_typeof(travel_details) = 'object'),
    CONSTRAINT ck_sr_pricing_is_object    CHECK (jsonb_typeof(pricing) = 'object'),
    CONSTRAINT ck_sr_history_is_array     CHECK (jsonb_typeof(status_history) = 'array'),
    CONSTRAINT ck_sr_date_order           CHECK (
        return_date IS NULL OR travel_date IS NULL OR return_date >= travel_date
    ),
    CONSTRAINT ck_sr_no_self_parent       CHECK (parent_request_id IS NULL OR parent_request_id <> request_id),
    -- Catalog inventory is platform-owned, never merchant-owned.
    CONSTRAINT ck_sr_catalog_has_no_owner CHECK (
        request_type <> 'catalog_item' OR (merchant_id IS NULL AND user_id IS NULL)
    ),
    -- Every request that modifies a booking must name that booking.
    CONSTRAINT ck_sr_modifications_have_parent CHECK (
        request_type NOT IN ('cancellation', 'refund', 'date_change', 'passenger_modification')
        OR parent_request_id IS NOT NULL
    )
);

CREATE INDEX ix_sr_merchant_id   ON service_requests (merchant_id);
CREATE INDEX ix_sr_user_id       ON service_requests (user_id);
CREATE INDEX ix_sr_parent        ON service_requests (parent_request_id);
CREATE INDEX ix_sr_type_status   ON service_requests (request_type, status);
CREATE INDEX ix_sr_booking_ref   ON service_requests (booking_reference);
CREATE INDEX ix_sr_travel_type   ON service_requests (travel_type);
CREATE INDEX ix_sr_travel_date   ON service_requests (travel_date);
CREATE INDEX ix_sr_created_at    ON service_requests (created_at DESC);
CREATE INDEX ix_sr_details_gin   ON service_requests USING GIN (travel_details);
-- Partial index: the catalog is the hottest read path on the public site.
CREATE INDEX ix_sr_catalog_live  ON service_requests (travel_type, status)
    WHERE request_type = 'catalog_item';
-- Absorbs the wishlist UNIQUE constraint from migration 0007.
CREATE UNIQUE INDEX uq_sr_wishlist_once ON service_requests (user_id, parent_request_id)
    WHERE request_type = 'wishlist';
-- Absorbs the reviews UNIQUE constraint from migration 0007.
CREATE UNIQUE INDEX uq_sr_review_once ON service_requests (user_id, parent_request_id)
    WHERE request_type = 'review';

CREATE TRIGGER trg_service_requests_updated_at
    BEFORE UPDATE ON service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- =====================================================================
-- 4. payments
--    Absorbs: payments, partner_payments, coupons, discount_campaigns
-- =====================================================================
CREATE TABLE payments (
    payment_id      BIGSERIAL     PRIMARY KEY,
    merchant_id     BIGINT        REFERENCES merchants (merchant_id) ON DELETE SET NULL,
    request_id      BIGINT        REFERENCES service_requests (request_id) ON DELETE SET NULL,
    user_id         BIGINT        REFERENCES users (user_id) ON DELETE SET NULL,

    amount          NUMERIC(14,2) NOT NULL,
    currency        CHAR(3)       NOT NULL DEFAULT 'INR',
    payment_type    payment_type_enum   NOT NULL,
    payment_method  VARCHAR(50),
    transaction_id  VARCHAR(100),
    payment_status  payment_status_enum NOT NULL DEFAULT 'pending',

    -- Absorbs coupons + discount_campaigns: the code and the resolved
    -- discount are recorded on the payment that consumed them.
    coupon_code     VARCHAR(50),
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_meta   JSONB         NOT NULL DEFAULT '{}'::jsonb,

    refund_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
    refund_reason   TEXT,
    refunded_at     TIMESTAMPTZ,

    paid_date       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT uq_payments_transaction_id UNIQUE (transaction_id),
    CONSTRAINT ck_payments_amount_non_negative   CHECK (amount >= 0),
    CONSTRAINT ck_payments_discount_non_negative CHECK (discount_amount >= 0),
    CONSTRAINT ck_payments_refund_non_negative   CHECK (refund_amount >= 0),
    CONSTRAINT ck_payments_refund_within_amount  CHECK (refund_amount <= amount),
    CONSTRAINT ck_payments_meta_is_object        CHECK (jsonb_typeof(discount_meta) = 'object')
);

CREATE INDEX ix_payments_merchant_id ON payments (merchant_id);
CREATE INDEX ix_payments_request_id  ON payments (request_id);
CREATE INDEX ix_payments_status      ON payments (payment_status);
CREATE INDEX ix_payments_paid_date   ON payments (paid_date DESC);
CREATE INDEX ix_payments_coupon      ON payments (coupon_code) WHERE coupon_code IS NOT NULL;

CREATE TRIGGER trg_payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- =====================================================================
-- 5. passenger_data
--    Absorbs: partner_booking_passengers, cancellation_request_passengers,
--             passenger_special_services, ancillary selections
-- =====================================================================
CREATE TABLE passenger_data (
    passenger_id           BIGSERIAL    PRIMARY KEY,
    request_id             BIGINT       NOT NULL REFERENCES service_requests (request_id) ON DELETE CASCADE,
    merchant_id            BIGINT       REFERENCES merchants (merchant_id) ON DELETE CASCADE,

    title                  VARCHAR(10),
    first_name             VARCHAR(100) NOT NULL,
    last_name              VARCHAR(100) NOT NULL,
    gender                 gender_enum,
    dob                    DATE,
    passenger_type         passenger_type_enum NOT NULL DEFAULT 'adult',

    passport_number        VARCHAR(40),
    passport_issue_country VARCHAR(100),
    passport_issue_date    DATE,
    passport_expiry        DATE,
    nationality            VARCHAR(100),

    seat_preference        seat_preference_enum,
    meal_preference        VARCHAR(100),
    -- Absorbs passenger_special_services + ancillary_service_catalog:
    -- [{"category":"baggage","code":"XBAG20","label":"Extra 20kg","price":1500}]
    special_services       JSONB        NOT NULL DEFAULT '[]'::jsonb,

    -- Absorbs cancellation_request_passengers: per-passenger cancellation
    -- is a flag, not a separate table.
    is_cancelled           BOOLEAN      NOT NULL DEFAULT false,

    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT ck_passenger_services_is_array CHECK (jsonb_typeof(special_services) = 'array'),
    CONSTRAINT ck_passenger_passport_dates    CHECK (
        passport_expiry IS NULL OR passport_issue_date IS NULL OR passport_expiry > passport_issue_date
    )
);

CREATE INDEX ix_passenger_request_id  ON passenger_data (request_id);
CREATE INDEX ix_passenger_merchant_id ON passenger_data (merchant_id);
CREATE INDEX ix_passenger_passport    ON passenger_data (passport_number) WHERE passport_number IS NOT NULL;

CREATE TRIGGER trg_passenger_data_updated_at
    BEFORE UPDATE ON passenger_data
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- =====================================================================
-- 6. communication_settings
-- =====================================================================
CREATE TABLE communication_settings (
    communication_id     BIGSERIAL   PRIMARY KEY,
    merchant_id          BIGINT      NOT NULL REFERENCES merchants (merchant_id) ON DELETE CASCADE,

    email_enabled        BOOLEAN     NOT NULL DEFAULT true,
    sms_enabled          BOOLEAN     NOT NULL DEFAULT false,
    whatsapp_enabled     BOOLEAN     NOT NULL DEFAULT false,
    otp_enabled          BOOLEAN     NOT NULL DEFAULT true,
    notification_enabled BOOLEAN     NOT NULL DEFAULT true,
    preferred_language   VARCHAR(10) NOT NULL DEFAULT 'en',

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One settings row per merchant.
    CONSTRAINT uq_comm_settings_merchant UNIQUE (merchant_id)
);

CREATE TRIGGER trg_comm_settings_updated_at
    BEFORE UPDATE ON communication_settings
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- =====================================================================
-- 7. msg_logs
--    Absorbs: notifications, partner_notifications, newsletter, contact_us,
--             OTP delivery history, email/SMS/WhatsApp/live-chat logs
-- =====================================================================
CREATE TABLE msg_logs (
    message_id     BIGSERIAL    PRIMARY KEY,
    merchant_id    BIGINT       REFERENCES merchants (merchant_id) ON DELETE CASCADE,
    user_id        BIGINT       REFERENCES users (user_id) ON DELETE SET NULL,
    request_id     BIGINT       REFERENCES service_requests (request_id) ON DELETE SET NULL,

    message_type   message_type_enum NOT NULL,
    direction      VARCHAR(10)  NOT NULL DEFAULT 'outbound',

    -- Nullable sender identity covers inbound contact_us / live_chat rows
    -- where the writer has no account.
    sender_name    VARCHAR(150),
    sender_email   VARCHAR(255),

    recipient      VARCHAR(255) NOT NULL,
    subject        VARCHAR(255),
    message        TEXT,

    status         message_status_enum NOT NULL DEFAULT 'queued',
    error_message  TEXT,
    is_read        BOOLEAN      NOT NULL DEFAULT false,

    sent_time      TIMESTAMPTZ,
    delivered_time TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT ck_msg_direction CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT ck_msg_delivery_order CHECK (
        delivered_time IS NULL OR sent_time IS NULL OR delivered_time >= sent_time
    )
);

CREATE INDEX ix_msg_merchant_id ON msg_logs (merchant_id);
CREATE INDEX ix_msg_user_unread ON msg_logs (user_id, is_read);
CREATE INDEX ix_msg_type_status ON msg_logs (message_type, status);
CREATE INDEX ix_msg_created_at  ON msg_logs (created_at DESC);


-- =====================================================================
-- 8. system_logs
--    Absorbs: activity_logs, user_sessions, report_generation_log,
--             login history
-- =====================================================================
CREATE TABLE system_logs (
    log_id        BIGSERIAL    PRIMARY KEY,
    user_id       BIGINT       REFERENCES users (user_id) ON DELETE SET NULL,
    merchant_id   BIGINT       REFERENCES merchants (merchant_id) ON DELETE CASCADE,

    module        VARCHAR(80)  NOT NULL,
    action        VARCHAR(120) NOT NULL,
    description   TEXT,

    ip_address    INET,
    browser       VARCHAR(200),
    device        VARCHAR(120),

    -- Absorbs user_sessions: a login row carries its own session token and
    -- expiry, so an active session is a query rather than a table.
    session_token VARCHAR(255),
    session_expires_at TIMESTAMPTZ,

    status        VARCHAR(30)  NOT NULL DEFAULT 'success',
    -- Named extra_data, not `metadata`: `metadata` is reserved on
    -- SQLAlchemy declarative classes.
    extra_data    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT ck_system_logs_extra_is_object CHECK (jsonb_typeof(extra_data) = 'object')
);

CREATE INDEX ix_syslog_user_id    ON system_logs (user_id);
CREATE INDEX ix_syslog_merchant   ON system_logs (merchant_id);
CREATE INDEX ix_syslog_module     ON system_logs (module, action);
CREATE INDEX ix_syslog_created_at ON system_logs (created_at DESC);
CREATE INDEX ix_syslog_session    ON system_logs (session_token) WHERE session_token IS NOT NULL;


-- =====================================================================
-- 9. audit_logs
--    Absorbs: partner_audit_logs and all row-level change history
-- =====================================================================
CREATE TABLE audit_logs (
    audit_id    BIGSERIAL   PRIMARY KEY,
    table_name  VARCHAR(80) NOT NULL,
    record_id   BIGINT,
    operation   audit_operation_enum NOT NULL,
    old_value   JSONB,
    new_value   JSONB,
    changed_by  BIGINT      REFERENCES users (user_id) ON DELETE SET NULL,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_audit_has_payload CHECK (
        NOT (old_value IS NULL AND new_value IS NULL)
    )
);

CREATE INDEX ix_audit_table_record ON audit_logs (table_name, record_id);
CREATE INDEX ix_audit_changed_by   ON audit_logs (changed_by);
CREATE INDEX ix_audit_changed_at   ON audit_logs (changed_at DESC);


-- =====================================================================
-- Generic audit trigger — attached to the four business tables. Keeps the
-- audit trail working without the 3 bespoke fn_audit_* functions the
-- legacy schema used.
-- =====================================================================
-- The PK column name is passed as TG_ARGV[0] and read out of the row's
-- jsonb projection. Deliberately avoids `format('%I', ...)` + dynamic
-- EXECUTE: a literal `%` in this file would be eaten as a parameter
-- placeholder by the driver when Alembic executes the script, and the
-- jsonb lookup is cheaper than a dynamic query per row anyway.
CREATE OR REPLACE FUNCTION fn_write_audit_log()
RETURNS TRIGGER AS $$
DECLARE
    v_old JSONB;
    v_new JSONB;
    v_record_id BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
        v_new := NULL;
        v_record_id := (v_old ->> TG_ARGV[0])::BIGINT;
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
        v_record_id := (v_new ->> TG_ARGV[0])::BIGINT;
    ELSE
        v_old := NULL;
        v_new := to_jsonb(NEW);
        v_record_id := (v_new ->> TG_ARGV[0])::BIGINT;
    END IF;

    INSERT INTO audit_logs (table_name, record_id, operation, old_value, new_value)
    VALUES (TG_TABLE_NAME, v_record_id, TG_OP::audit_operation_enum, v_old, v_new);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_users
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_write_audit_log('user_id');

CREATE TRIGGER trg_audit_merchants
    AFTER INSERT OR UPDATE OR DELETE ON merchants
    FOR EACH ROW EXECUTE FUNCTION fn_write_audit_log('merchant_id');

CREATE TRIGGER trg_audit_service_requests
    AFTER INSERT OR UPDATE OR DELETE ON service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_write_audit_log('request_id');

CREATE TRIGGER trg_audit_payments
    AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION fn_write_audit_log('payment_id');
