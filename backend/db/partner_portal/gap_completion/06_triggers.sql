-- Partner Portal — Gap completion — 06: Triggers
-- Depends on: 04_functions.sql (this phase)

CREATE TRIGGER trg_track_booking_status_history
    AFTER INSERT OR UPDATE ON partner_bookings
    FOR EACH ROW EXECUTE FUNCTION fn_track_booking_status_history();

CREATE TRIGGER trg_track_service_request_status_history
    AFTER INSERT OR UPDATE ON service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_track_service_request_status_history();

CREATE TRIGGER trg_auto_generate_booking_reference
    BEFORE INSERT ON partner_bookings
    FOR EACH ROW EXECUTE FUNCTION fn_auto_generate_booking_reference();

CREATE TRIGGER trg_auto_generate_service_request_number
    BEFORE INSERT ON service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_auto_generate_service_request_number();
