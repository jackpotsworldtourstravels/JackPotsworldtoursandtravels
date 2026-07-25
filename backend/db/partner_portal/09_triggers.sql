-- Partner Portal — 09: Trigger functions + triggers
-- Depends on: 03-06 (all table files)

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_partners_updated_at
    BEFORE UPDATE ON partners
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_partner_users_updated_at
    BEFORE UPDATE ON partner_users
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_partner_bookings_updated_at
    BEFORE UPDATE ON partner_bookings
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_partner_booking_passengers_updated_at
    BEFORE UPDATE ON partner_booking_passengers
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_service_requests_updated_at
    BEFORE UPDATE ON service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


CREATE OR REPLACE FUNCTION fn_audit_partner_bookings()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
        VALUES (NEW.partner_id, NEW.partner_user_id, 'booking_created', 'partner_bookings', NEW.booking_id,
                'Booking ' || NEW.reference_number || ' created with status ' || NEW.status);
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
        VALUES (NEW.partner_id, NEW.partner_user_id, 'booking_status_changed', 'partner_bookings', NEW.booking_id,
                'Booking ' || NEW.reference_number || ' moved from ' || OLD.status || ' to ' || NEW.status);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_partner_bookings
    AFTER INSERT OR UPDATE ON partner_bookings
    FOR EACH ROW EXECUTE FUNCTION fn_audit_partner_bookings();


CREATE OR REPLACE FUNCTION fn_audit_service_requests()
RETURNS TRIGGER AS $$
DECLARE
    v_partner_id INTEGER;
BEGIN
    SELECT partner_id INTO v_partner_id FROM partner_bookings WHERE booking_id = NEW.booking_id;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
        VALUES (v_partner_id, NEW.partner_user_id, 'service_request_created', 'service_requests', NEW.service_request_id,
                NEW.service_request_number || ' (' || NEW.request_type || ') submitted');
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
        VALUES (v_partner_id, NEW.partner_user_id, 'service_request_status_changed', 'service_requests', NEW.service_request_id,
                NEW.service_request_number || ' moved from ' || OLD.status || ' to ' || NEW.status);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_service_requests
    AFTER INSERT OR UPDATE ON service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_audit_service_requests();


CREATE OR REPLACE FUNCTION fn_audit_partner_users()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
        VALUES (NEW.partner_id, NEW.partner_user_id, 'partner_user_created', 'partner_users', NEW.partner_user_id,
                NEW.full_name || ' (' || NEW.email || ') added');
    ELSIF TG_OP = 'UPDATE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.role_id IS DISTINCT FROM OLD.role_id) THEN
        INSERT INTO partner_audit_logs (partner_id, partner_user_id, action, entity_type, entity_id, description)
        VALUES (NEW.partner_id, NEW.partner_user_id, 'partner_user_updated', 'partner_users', NEW.partner_user_id,
                'Status/role changed for ' || NEW.email);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_partner_users
    AFTER INSERT OR UPDATE ON partner_users
    FOR EACH ROW EXECUTE FUNCTION fn_audit_partner_users();
