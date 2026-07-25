-- Partner Portal — 10: Auth + reference-number stored procedures
-- Depends on: 03_partner_tables.sql, 04_booking_tables.sql, 07_sequences.sql

-- Returns what the application needs to bcrypt-verify a login attempt.
-- Password comparison happens in Python (passlib), matching how the
-- existing admin/customer auth already works — never in SQL.
CREATE OR REPLACE FUNCTION sp_partner_login_lookup(p_email VARCHAR)
RETURNS TABLE (
    partner_user_id  INTEGER,
    partner_id        INTEGER,
    password_hash      VARCHAR,
    status              partner_user_status_enum,
    role_id             INTEGER,
    full_name           VARCHAR
) AS $$
BEGIN
    RETURN QUERY
    SELECT pu.partner_user_id, pu.partner_id, pu.password_hash, pu.status, pu.role_id, pu.full_name
    FROM partner_users pu
    WHERE pu.email = p_email;
END;
$$ LANGUAGE plpgsql STABLE;

-- Called only after the app has confirmed the password matched.
CREATE OR REPLACE FUNCTION sp_partner_record_login(p_partner_user_id INTEGER, p_ip_address VARCHAR)
RETURNS VOID AS $$
DECLARE
    v_partner_id INTEGER;
BEGIN
    UPDATE partner_users SET last_login_at = now() WHERE partner_user_id = p_partner_user_id
    RETURNING partner_id INTO v_partner_id;

    INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description, ip_address)
    VALUES (v_partner_id, p_partner_user_id, 'login_success', 'partner_users', p_partner_user_id, 'Partner login', p_ip_address);
END;
$$ LANGUAGE plpgsql;

-- Issues a new OTP. The app generates the random code and its hash (bcrypt,
-- the same library used for password hashing) and passes the hash in.
CREATE OR REPLACE FUNCTION sp_request_otp(p_partner_user_id INTEGER, p_otp_hash VARCHAR, p_purpose otp_purpose_enum, p_ttl_minutes INTEGER DEFAULT 10)
RETURNS INTEGER AS $$
DECLARE
    v_otp_id INTEGER;
BEGIN
    -- Invalidate any prior unverified OTP of the same purpose for this user.
    UPDATE partner_otp_requests
    SET expires_at = now()
    WHERE partner_user_id = p_partner_user_id AND purpose = p_purpose AND verified_at IS NULL;

    INSERT INTO partner_otp_requests (partner_user_id, otp_hash, purpose, expires_at)
    VALUES (p_partner_user_id, p_otp_hash, p_purpose, now() + (p_ttl_minutes || ' minutes')::interval)
    RETURNING otp_id INTO v_otp_id;

    RETURN v_otp_id;
END;
$$ LANGUAGE plpgsql;

-- Verifies a submitted OTP hash against the latest unverified, unexpired
-- request for that user/purpose. Marks it verified on match; increments
-- attempt_count on mismatch. Locked out after 5 attempts per OTP.
CREATE OR REPLACE FUNCTION sp_verify_otp(p_partner_user_id INTEGER, p_purpose otp_purpose_enum, p_otp_hash VARCHAR)
RETURNS BOOLEAN AS $$
DECLARE
    v_otp_id  INTEGER;
    v_matched BOOLEAN;
BEGIN
    SELECT otp_id, (otp_hash = p_otp_hash)
    INTO v_otp_id, v_matched
    FROM partner_otp_requests
    WHERE partner_user_id = p_partner_user_id
      AND purpose = p_purpose
      AND verified_at IS NULL
      AND expires_at > now()
      AND attempt_count < 5
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_otp_id IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_matched THEN
        UPDATE partner_otp_requests SET verified_at = now() WHERE otp_id = v_otp_id;
        RETURN TRUE;
    ELSE
        UPDATE partner_otp_requests SET attempt_count = attempt_count + 1 WHERE otp_id = v_otp_id;
        RETURN FALSE;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Booking reference: {partner.reference_prefix}{YY}{4-digit sequence, reset
-- per partner per year} — e.g. JP250001. Atomic upsert-increment on the
-- counter table keeps this correct under concurrent requests without a
-- manual SELECT ... FOR UPDATE.
CREATE OR REPLACE FUNCTION sp_generate_booking_reference(p_partner_id INTEGER)
RETURNS VARCHAR AS $$
DECLARE
    v_prefix      VARCHAR(6);
    v_year        SMALLINT := EXTRACT(YEAR FROM CURRENT_DATE)::SMALLINT;
    v_next_value  INTEGER;
BEGIN
    SELECT reference_prefix INTO v_prefix FROM partners WHERE partner_id = p_partner_id;
    IF v_prefix IS NULL THEN
        RAISE EXCEPTION 'Unknown partner_id %', p_partner_id;
    END IF;

    INSERT INTO booking_reference_counters (partner_id, year, last_value)
    VALUES (p_partner_id, v_year, 1)
    ON CONFLICT (partner_id, year) DO UPDATE
        SET last_value = booking_reference_counters.last_value + 1
    RETURNING last_value INTO v_next_value;

    RETURN v_prefix || LPAD((v_year % 100)::TEXT, 2, '0') || LPAD(v_next_value::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- Service request number: SR + 6-digit global sequence — no partner/year
-- scoping, matching the examples given (SR000001, SR000002 ...).
CREATE OR REPLACE FUNCTION sp_generate_service_request_number()
RETURNS VARCHAR AS $$
BEGIN
    RETURN 'SR' || LPAD(nextval('service_request_number_seq')::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;
