-- Target 9-table schema — triggers
--
-- updated_at maintenance reuses fn_set_updated_at() (already defined by
-- backend/db/partner_portal/09_triggers.sql / backend/db/core/01_triggers.sql).
-- A new generic fn_ts_audit_row() replaces the legacy fn_audit_partner_bookings/
-- fn_audit_partner_users pair with one function parameterized by entity_type,
-- covering the same audit scope (bookings/service_requests, users) plus
-- merchants and payments, which previously had no audit trail at all.

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ts_users_updated_at ON ts_users;
CREATE TRIGGER trg_ts_users_updated_at
    BEFORE UPDATE ON ts_users
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_ts_merchants_updated_at ON ts_merchants;
CREATE TRIGGER trg_ts_merchants_updated_at
    BEFORE UPDATE ON ts_merchants
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_ts_service_requests_updated_at ON ts_service_requests;
CREATE TRIGGER trg_ts_service_requests_updated_at
    BEFORE UPDATE ON ts_service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_ts_payments_updated_at ON ts_payments;
CREATE TRIGGER trg_ts_payments_updated_at
    BEFORE UPDATE ON ts_payments
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_ts_passenger_data_updated_at ON ts_passenger_data;
CREATE TRIGGER trg_ts_passenger_data_updated_at
    BEFORE UPDATE ON ts_passenger_data
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE OR REPLACE FUNCTION fn_ts_audit_row()
RETURNS TRIGGER AS $$
DECLARE
    v_entity_type TEXT := TG_ARGV[0];
    v_entity_id INTEGER;
BEGIN
    v_entity_id := COALESCE(NEW.id, OLD.id);
    INSERT INTO ts_audit_logs (entity_type, entity_id, action, old_data, new_data, created_at)
    VALUES (
        v_entity_type,
        v_entity_id,
        lower(TG_OP)::ts_audit_action_enum,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
        CASE WHEN TG_OP IN ('UPDATE', 'INSERT') THEN to_jsonb(NEW) ELSE NULL END,
        now()
    );
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ts_users_audit ON ts_users;
CREATE TRIGGER trg_ts_users_audit
    AFTER INSERT OR UPDATE OR DELETE ON ts_users
    FOR EACH ROW EXECUTE FUNCTION fn_ts_audit_row('user');

DROP TRIGGER IF EXISTS trg_ts_merchants_audit ON ts_merchants;
CREATE TRIGGER trg_ts_merchants_audit
    AFTER INSERT OR UPDATE OR DELETE ON ts_merchants
    FOR EACH ROW EXECUTE FUNCTION fn_ts_audit_row('merchant');

DROP TRIGGER IF EXISTS trg_ts_service_requests_audit ON ts_service_requests;
CREATE TRIGGER trg_ts_service_requests_audit
    AFTER INSERT OR UPDATE OR DELETE ON ts_service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_ts_audit_row('service_request');

DROP TRIGGER IF EXISTS trg_ts_payments_audit ON ts_payments;
CREATE TRIGGER trg_ts_payments_audit
    AFTER INSERT OR UPDATE OR DELETE ON ts_payments
    FOR EACH ROW EXECUTE FUNCTION fn_ts_audit_row('payment');

-- Status-change entries into ts_system_logs (replaces partner_booking_status_history
-- / service_request_status_history) — fires only when status actually changes.
CREATE OR REPLACE FUNCTION fn_ts_log_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO ts_system_logs (log_type, entity_type, entity_id, old_value, new_value, created_at)
        VALUES ('status_change', 'service_request', NEW.id, OLD.status::TEXT, NEW.status::TEXT, now());
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ts_service_requests_status_log ON ts_service_requests;
CREATE TRIGGER trg_ts_service_requests_status_log
    AFTER UPDATE ON ts_service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_ts_log_status_change();
