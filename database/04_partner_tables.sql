-- =========================================================================
-- 04_partner_tables.sql
-- Merchant ("My Partner") Portal domain. Owns its OWN authentication
-- (partner_staff), profile, session, and activity data -- no table here is
-- shared with Admin or User.
--
-- v2 changes from v1:
--   - partner_users -> partner_staff (renamed per your target list). Its
--     `role_id` FK into the now-retired shared `roles` table is DROPPED --
--     `role_type`/`member_role` (added in migration 0021) already fully
--     capture the Admin/User/Maker-Checker hierarchy the UI actually uses
--     (see ROLE_TYPE_MEMBER_ROLES in admin_merchant.py), so the shared-role
--     lookup was vestigial once that migration landed.
--   - partner_audit_logs -> partner_activity_logs (renamed for naming
--     consistency with admin_activity_logs / user_activity_logs).
--   - Every column that referenced `partner_users.partner_user_id` is
--     renamed `staff_id` to match: partner_bookings, partner_otp_requests,
--     service_requests, report_generation_log, partner_notifications,
--     partner_activity_logs, partner_booking_status_history,
--     service_request_status_history.
--   - partners' extended onboarding fields (contact_person, address, city,
--     state, country, gst_number, pan_number, company_type -- added in
--     migration 0021) are split out into a new partner_profiles table,
--     matching the Admin/User domain 3NF pattern. This is a REAL split
--     of real, live-used columns, not a new invention.
--   - partner_sessions, partner_bank_accounts, partner_documents,
--     partner_wallet(+transactions), partner_commissions, partner_invoices
--     are NEW per your target list. None have current frontend forms --
--     see FIELD_MAPPING.md for exactly which columns are wired to a real
--     page today vs. provisioned for a future one.
--   - Every table not in your literal list but load-bearing for existing
--     functionality is KEPT UNCHANGED: partner_otp_requests (the
--     production OTP login system), booking_reference_counters,
--     ancillary_service_catalog + passenger_special_services (baggage/
--     meal/special-service selection), service_requests and its 4 subtype
--     tables (cancellation/date-change/refund/passenger-modification
--     workflow), partner_payments, report_generation_log,
--     partner_booking_status_history, service_request_status_history.
--     Dropping any of these would break a feature built and approved
--     earlier in this project.
-- =========================================================================

CREATE TABLE partners (
    partner_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_name VARCHAR(150) NOT NULL,
    company_code VARCHAR(30) NOT NULL,
    reference_prefix VARCHAR(6) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20),
    status partner_status_enum NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Split out of `partners` (see file header) -- real columns, real onboarding
-- form (Admin Portal > Merchant Management > Onboard Merchant).
CREATE TABLE partner_profiles (
    partner_id INTEGER PRIMARY KEY,
    company_type merchant_company_type_enum,
    contact_person VARCHAR(150),
    address VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100),
    gst_number VARCHAR(20),
    pan_number VARCHAR(15)
);

-- Renamed from partner_users (see file header).
CREATE TABLE partner_staff (
    staff_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_id INTEGER NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20),
    username VARCHAR(50),
    password_hash VARCHAR(255),
    role_type merchant_role_type_enum,
    member_role merchant_member_role_enum,
    status partner_staff_status_enum NOT NULL DEFAULT 'active',
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NEW -- provisioned. Mirrors admin_sessions/user_sessions; today's login
-- activity is only recorded as a 'login_success' row in
-- partner_activity_logs, not a dedicated session table.
CREATE TABLE partner_sessions (
    id SERIAL PRIMARY KEY,
    staff_id INTEGER NOT NULL,
    login_at TIMESTAMP NOT NULL DEFAULT now(),
    logout_at TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT now(),
    ip_address VARCHAR(50),
    browser VARCHAR(60),
    os VARCHAR(60),
    device VARCHAR(60),
    is_active BOOLEAN NOT NULL DEFAULT true
);

-- KEPT (real, unchanged) -- the production email-OTP login/reset system.
CREATE TABLE partner_otp_requests (
    otp_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id INTEGER NOT NULL,
    otp_hash VARCHAR(255) NOT NULL,
    purpose otp_purpose_enum NOT NULL,
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- KEPT (real, unchanged).
CREATE TABLE booking_reference_counters (
    partner_id INTEGER NOT NULL,
    year SMALLINT NOT NULL,
    last_value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (partner_id, year)
);

CREATE TABLE partner_bookings (
    booking_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reference_number VARCHAR(20) NOT NULL,
    partner_id INTEGER NOT NULL,
    staff_id INTEGER NOT NULL,
    travel_type travel_type_enum NOT NULL,
    flight_id INTEGER,
    hotel_id INTEGER,
    cruise_id INTEGER,
    airline_name VARCHAR(100),
    flight_number VARCHAR(20),
    trip_type trip_type_enum,
    departure VARCHAR(150) NOT NULL,
    arrival VARCHAR(150) NOT NULL,
    departure_date DATE NOT NULL,
    return_date DATE,
    cabin_class cabin_class_enum,
    status booking_status_enum NOT NULL DEFAULT 'draft',
    total_amount NUMERIC(10,2),
    approved_by INTEGER,
    rejected_by INTEGER,
    approved_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE partner_booking_passengers (
    passenger_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id INTEGER NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    id_type VARCHAR(30) NOT NULL DEFAULT 'passport',
    gender gender_enum NOT NULL,
    passenger_type passenger_type_enum NOT NULL,
    passport_issuing_country_id INTEGER NOT NULL,
    passport_number VARCHAR(30) NOT NULL,
    passport_issue_date DATE NOT NULL,
    passport_expiry_date DATE NOT NULL,
    date_of_birth DATE NOT NULL,
    nationality_country_id INTEGER NOT NULL,
    meal_preference VARCHAR(80),
    special_assistance TEXT,
    baggage_catalog_id INTEGER,
    meal_catalog_id INTEGER,
    seat_preference seat_preference_enum,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ancillary_service_catalog (
    catalog_id SERIAL PRIMARY KEY,
    category ancillary_category_enum NOT NULL,
    code VARCHAR(40) NOT NULL,
    label VARCHAR(80) NOT NULL,
    additional_charge NUMERIC(10,2) NOT NULL DEFAULT 0,
    display_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE passenger_special_services (
    id SERIAL PRIMARY KEY,
    passenger_id INTEGER NOT NULL,
    catalog_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_requests (
    service_request_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    service_request_number VARCHAR(20) NOT NULL,
    booking_id INTEGER NOT NULL,
    staff_id INTEGER NOT NULL,
    request_type service_request_type_enum NOT NULL,
    status service_request_status_enum NOT NULL DEFAULT 'submitted',
    reason TEXT,
    resolved_by INTEGER,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cancellation_requests (
    service_request_id INTEGER NOT NULL,
    PRIMARY KEY (service_request_id)
);

CREATE TABLE cancellation_request_passengers (
    service_request_id INTEGER NOT NULL,
    passenger_id INTEGER NOT NULL,
    PRIMARY KEY (service_request_id, passenger_id)
);

CREATE TABLE date_change_requests (
    service_request_id INTEGER NOT NULL,
    passenger_id INTEGER NOT NULL,
    old_travel_date DATE NOT NULL,
    new_travel_date DATE NOT NULL,
    PRIMARY KEY (service_request_id)
);

CREATE TABLE refund_requests (
    service_request_id INTEGER NOT NULL,
    amount_requested NUMERIC(10,2) NOT NULL,
    payment_id INTEGER,
    PRIMARY KEY (service_request_id)
);

CREATE TABLE passenger_modification_requests (
    service_request_id INTEGER NOT NULL,
    passenger_id INTEGER NOT NULL,
    field_changed VARCHAR(60) NOT NULL,
    old_value VARCHAR(255),
    new_value VARCHAR(255),
    PRIMARY KEY (service_request_id)
);

CREATE TABLE partner_payments (
    payment_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id INTEGER NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    method VARCHAR(30) NOT NULL DEFAULT 'invoice',
    status VARCHAR(30) NOT NULL DEFAULT 'success',
    transaction_ref VARCHAR(100) NOT NULL,
    refunded_at TIMESTAMPTZ,
    refund_reference VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report_generation_log (
    report_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_id INTEGER NOT NULL,
    staff_id INTEGER NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}',
    export_format export_format_enum NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE partner_notifications (
    notification_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL,
    message VARCHAR(2000) NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Renamed from partner_audit_logs (see file header).
CREATE TABLE partner_activity_logs (
    activity_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_id INTEGER,
    staff_id INTEGER,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id INTEGER,
    description TEXT,
    ip_address VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE partner_booking_status_history (
    history_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id INTEGER NOT NULL,
    old_status booking_status_enum,
    new_status booking_status_enum NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    changed_by_admin_id INTEGER,
    changed_by_staff_id INTEGER
);

CREATE TABLE service_request_status_history (
    history_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    service_request_id INTEGER NOT NULL,
    old_status service_request_status_enum,
    new_status service_request_status_enum NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    changed_by_admin_id INTEGER,
    changed_by_staff_id INTEGER
);

-- NEW -- provisioned, no current UI in either portal.
CREATE TABLE partner_bank_accounts (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL,
    account_holder_name VARCHAR(150) NOT NULL,
    bank_name VARCHAR(150) NOT NULL,
    account_number VARCHAR(34) NOT NULL,
    ifsc_code VARCHAR(15),
    is_primary BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- NEW -- provisioned, no current UI.
CREATE TABLE partner_documents (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL,
    document_type VARCHAR(60) NOT NULL,
    file_url VARCHAR(500) NOT NULL,
    uploaded_at TIMESTAMP NOT NULL DEFAULT now()
);

-- NEW -- provisioned, no current UI.
CREATE TABLE partner_wallet (
    partner_id INTEGER PRIMARY KEY,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- NEW -- provisioned, no current UI.
CREATE TABLE partner_wallet_transactions (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL,
    transaction_type wallet_transaction_type_enum NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    reference VARCHAR(150),
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- NEW -- provisioned, no current UI.
CREATE TABLE partner_commissions (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL,
    booking_id INTEGER,
    commission_rate NUMERIC(5,2),
    commission_amount NUMERIC(10,2) NOT NULL,
    status commission_status_enum NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- NEW -- provisioned, no current UI. Distinct from partner_payments
-- (which records the actual payment transaction against a booking):
-- this is the formal invoice document/record.
CREATE TABLE partner_invoices (
    id SERIAL PRIMARY KEY,
    partner_id INTEGER NOT NULL,
    booking_id INTEGER,
    invoice_number VARCHAR(30) NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    status invoice_status_enum NOT NULL DEFAULT 'unpaid',
    issued_at TIMESTAMP NOT NULL DEFAULT now(),
    due_at DATE
);
