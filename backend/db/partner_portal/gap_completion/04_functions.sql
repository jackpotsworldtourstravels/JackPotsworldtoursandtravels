-- Partner Portal — Gap completion — 04: Reusable trigger functions
-- Depends on: 01-03 (this phase), and Phase 2's sp_generate_booking_reference /
-- sp_generate_service_request_number (../10_stored_procedures_auth_and_reference.sql).
--
-- These are the fn_* functions bound to tables by 06_triggers.sql. Kept
-- separate from the sp_* business-operation procedures in 05, matching the
-- distinction already established in Phase 2 (fn_ = trigger handler,
-- sp_ = explicitly called by the application).

CREATE OR REPLACE FUNCTION fn_track_booking_status_history()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO partner_booking_status_history (booking_id, old_status, new_status, changed_by_partner_user_id)
        VALUES (NEW.booking_id, NULL, NEW.status, NEW.partner_user_id);
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO partner_booking_status_history (booking_id, old_status, new_status, changed_by_admin_id, changed_by_partner_user_id)
        VALUES (
            NEW.booking_id, OLD.status, NEW.status,
            COALESCE(NEW.approved_by, NEW.rejected_by),
            CASE WHEN NEW.approved_by IS NULL AND NEW.rejected_by IS NULL THEN NEW.partner_user_id END
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_track_service_request_status_history()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO service_request_status_history (service_request_id, old_status, new_status, changed_by_partner_user_id)
        VALUES (NEW.service_request_id, NULL, NEW.status, NEW.partner_user_id);
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO service_request_status_history (service_request_id, old_status, new_status, changed_by_admin_id, changed_by_partner_user_id)
        VALUES (
            NEW.service_request_id, OLD.status, NEW.status, NEW.resolved_by,
            CASE WHEN NEW.resolved_by IS NULL THEN NEW.partner_user_id END
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Safety nets, not the primary code path: sp_create_ticket_request and
-- sp_cancel_selected_passengers/sp_create_date_change_request/etc. (Phase 2)
-- already generate and pass these values explicitly before INSERT. These
-- BEFORE INSERT triggers only fire if a future code path inserts directly
-- and leaves the column NULL — existing behavior is unchanged either way.

CREATE OR REPLACE FUNCTION fn_auto_generate_booking_reference()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.reference_number IS NULL THEN
        NEW.reference_number := sp_generate_booking_reference(NEW.partner_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_auto_generate_service_request_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.service_request_number IS NULL THEN
        NEW.service_request_number := sp_generate_service_request_number();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
