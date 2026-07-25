-- Partner Portal — Gap completion — 05: Stored procedures
-- Depends on: Phase 2's tables/roles + 01-03 of this phase.

-- Partner Registration — admin/Back-Office invoked, NOT public self-service
-- (the portal is invitation-only; there is no public sign-up endpoint).
-- Replaces the ad hoc manual INSERTs used for every test/demo partner
-- created so far in this project with one reusable, transactional call.
CREATE OR REPLACE FUNCTION sp_register_partner(
    p_company_name        VARCHAR,
    p_company_code         VARCHAR,
    p_reference_prefix      VARCHAR,
    p_partner_email           VARCHAR,
    p_phone_number              VARCHAR,
    p_admin_full_name             VARCHAR,
    p_admin_email                   VARCHAR,
    p_admin_password_hash             VARCHAR,
    p_role_name                         VARCHAR DEFAULT 'partner_admin'
)
RETURNS TABLE (partner_id INTEGER, partner_user_id INTEGER) AS $$
DECLARE
    v_partner_id       INTEGER;
    v_role_id          INTEGER;
    v_partner_user_id  INTEGER;
BEGIN
    SELECT id INTO v_role_id FROM roles WHERE name = p_role_name;
    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Role % not found', p_role_name;
    END IF;

    INSERT INTO partners (company_name, company_code, reference_prefix, email, phone_number, status)
    VALUES (p_company_name, p_company_code, p_reference_prefix, p_partner_email, p_phone_number, 'active')
    RETURNING partners.partner_id INTO v_partner_id;

    INSERT INTO partner_users (partner_id, role_id, full_name, email, password_hash, status)
    VALUES (v_partner_id, v_role_id, p_admin_full_name, p_admin_email, p_admin_password_hash, 'active')
    RETURNING partner_users.partner_user_id INTO v_partner_user_id;

    RETURN QUERY SELECT v_partner_id, v_partner_user_id;
END;
$$ LANGUAGE plpgsql;


-- Callable-procedure wrapper around vw_partner_dashboard_stats (Phase 2).
-- The FastAPI service currently reads the view directly; this exists so a
-- future caller (or a different service) has an explicit SP entry point
-- without needing to know the view name.
CREATE OR REPLACE FUNCTION sp_get_dashboard_statistics(p_partner_id INTEGER)
RETURNS TABLE (
    total_requests INTEGER, pending_requests INTEGER, approved_requests INTEGER,
    rejected_requests INTEGER, completed_requests INTEGER, cancelled_requests INTEGER,
    today_requests INTEGER, today_revenue NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT v.total_requests::INTEGER, v.pending_requests::INTEGER, v.approved_requests::INTEGER,
           v.rejected_requests::INTEGER, v.completed_requests::INTEGER, v.cancelled_requests::INTEGER,
           v.today_requests::INTEGER, v.today_revenue
    FROM vw_partner_dashboard_stats v
    WHERE v.partner_id = p_partner_id;
END;
$$ LANGUAGE plpgsql STABLE;


-- Moves the plain UPDATE currently inline in
-- backend/app/services/partner_auth_service.py::update_profile into the
-- database, consistent with "business logic lives in stored procedures."
CREATE OR REPLACE FUNCTION sp_update_partner_profile(
    p_partner_user_id INTEGER, p_full_name VARCHAR DEFAULT NULL, p_phone_number VARCHAR DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    UPDATE partner_users
    SET full_name = COALESCE(p_full_name, full_name), phone_number = COALESCE(p_phone_number, phone_number)
    WHERE partner_user_id = p_partner_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Partner user % not found', p_partner_user_id;
    END IF;
END;
$$ LANGUAGE plpgsql;


-- Generic manual audit-log helper for actions that aren't a plain
-- INSERT/UPDATE on an already-triggered table (e.g. a login event, a viewed
-- report) — sp_partner_record_login (Phase 2) already does this INSERT
-- inline; this gives every other caller the same capability without
-- duplicating the INSERT statement.
CREATE OR REPLACE FUNCTION sp_audit_log_entry(
    p_partner_id      INTEGER,
    p_partner_user_id  INTEGER,
    p_action            VARCHAR,
    p_entity_type         VARCHAR DEFAULT NULL,
    p_entity_id             INTEGER DEFAULT NULL,
    p_description             TEXT DEFAULT NULL,
    p_ip_address                VARCHAR DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    v_audit_id INTEGER;
BEGIN
    INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description, ip_address)
    VALUES (p_partner_id, p_partner_user_id, p_action, p_entity_type, p_entity_id, p_description, p_ip_address)
    RETURNING audit_id INTO v_audit_id;
    RETURN v_audit_id;
END;
$$ LANGUAGE plpgsql;
