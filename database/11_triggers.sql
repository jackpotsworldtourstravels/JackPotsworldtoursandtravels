-- =========================================================================
-- 11_triggers.sql
-- Triggers wiring the fn_ functions in 09_functions.sql to their tables.
--
-- v2: trg_audit_partner_users / trg_partner_users_updated_at are renamed
-- and now fire on partner_staff (renamed from partner_users). The other
-- 12 triggers are unaffected (their tables kept their names).
-- =========================================================================

CREATE TRIGGER trg_partner_booking_passengers_updated_at BEFORE UPDATE ON public.partner_booking_passengers FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_audit_partner_bookings AFTER INSERT OR UPDATE ON public.partner_bookings FOR EACH ROW EXECUTE FUNCTION fn_audit_partner_bookings();
CREATE TRIGGER trg_auto_generate_booking_reference BEFORE INSERT ON public.partner_bookings FOR EACH ROW EXECUTE FUNCTION fn_auto_generate_booking_reference();
CREATE TRIGGER trg_notify_partner_booking_status AFTER UPDATE ON public.partner_bookings FOR EACH ROW EXECUTE FUNCTION fn_notify_partner_booking_status();
CREATE TRIGGER trg_partner_bookings_updated_at BEFORE UPDATE ON public.partner_bookings FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_track_booking_status_history AFTER INSERT OR UPDATE ON public.partner_bookings FOR EACH ROW EXECUTE FUNCTION fn_track_booking_status_history();
CREATE TRIGGER trg_audit_partner_staff AFTER INSERT OR UPDATE ON public.partner_staff FOR EACH ROW EXECUTE FUNCTION fn_audit_partner_staff();
CREATE TRIGGER trg_partner_staff_updated_at BEFORE UPDATE ON public.partner_staff FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_partners_updated_at BEFORE UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_audit_service_requests AFTER INSERT OR UPDATE ON public.service_requests FOR EACH ROW EXECUTE FUNCTION fn_audit_service_requests();
CREATE TRIGGER trg_auto_generate_service_request_number BEFORE INSERT ON public.service_requests FOR EACH ROW EXECUTE FUNCTION fn_auto_generate_service_request_number();
CREATE TRIGGER trg_notify_service_request_status AFTER UPDATE ON public.service_requests FOR EACH ROW EXECUTE FUNCTION fn_notify_service_request_status();
CREATE TRIGGER trg_service_requests_updated_at BEFORE UPDATE ON public.service_requests FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_track_service_request_status_history AFTER INSERT OR UPDATE ON public.service_requests FOR EACH ROW EXECUTE FUNCTION fn_track_service_request_status_history();
