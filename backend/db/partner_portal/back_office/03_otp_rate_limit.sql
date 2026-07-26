-- ============================================================================
-- Partner Portal — OTP request rate limiting (additive change to sp_request_otp)
-- ============================================================================
-- CREATE OR REPLACE keeps the exact same signature/callers; it only adds a
-- rate-limit guard before the existing invalidate-then-insert logic, and
-- lowers the default TTL from 10 to 5 minutes to match the new production
-- OTP policy. No other object is touched.
-- ============================================================================

CREATE OR REPLACE FUNCTION sp_request_otp(
    p_partner_user_id INTEGER,
    p_otp_hash VARCHAR,
    p_purpose otp_purpose_enum,
    p_ttl_minutes INTEGER DEFAULT 5
)
RETURNS INTEGER AS $$
DECLARE
    v_otp_id INTEGER;
    v_recent_count INTEGER;
BEGIN
    SELECT count(*) INTO v_recent_count
    FROM partner_otp_requests
    WHERE partner_user_id = p_partner_user_id
      AND purpose = p_purpose
      AND created_at > now() - interval '1 hour';

    IF v_recent_count >= 5 THEN
        RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED: too many OTP requests for this account in the last hour';
    END IF;

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
