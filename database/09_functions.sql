-- =========================================================================
-- 09_functions.sql
-- Trigger functions and small utilities (fn_ prefix).
--
-- v2: 7 of the 10 functions are updated for the partner_users ->
-- partner_staff / partner_user_id -> staff_id rename and the
-- partner_audit_logs -> partner_activity_logs rename. fn_audit_partner_users
-- is renamed fn_audit_partner_staff to match the table it triggers on.
-- The other 3 (fn_auto_generate_booking_reference,
-- fn_auto_generate_service_request_number, fn_set_updated_at) are
-- unaffected and unchanged.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.fn_audit_partner_bookings()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO partner_activity_logs (partner_id, staff_id, action, entity_type, entity_id, description)
        VALUES (NEW.partner_id, NEW.staff_id, 'booking_created', 'partner_bookings', NEW.booking_id,
                'Booking ' || NEW.reference_number || ' created with status ' || NEW.status);
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO partner_activity_logs (partner_id, staff_id, action, entity_type, entity_id, description)
        VALUES (NEW.partner_id, NEW.staff_id, 'booking_status_changed', 'partner_bookings', NEW.booking_id,
                'Booking ' || NEW.reference_number || ' moved from ' || OLD.status || ' to ' || NEW.status);
    END IF;
    RETURN NEW;
END;
$function$

-- Renamed from fn_audit_partner_users (trigger now fires on partner_staff).
CREATE OR REPLACE FUNCTION public.fn_audit_partner_staff()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO partner_activity_logs (partner_id, staff_id, action, entity_type, entity_id, description)
        VALUES (NEW.partner_id, NEW.staff_id, 'partner_staff_created', 'partner_staff', NEW.staff_id,
                NEW.full_name || ' (' || NEW.email || ') added');
    ELSIF TG_OP = 'UPDATE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.role_type IS DISTINCT FROM OLD.role_type OR NEW.member_role IS DISTINCT FROM OLD.member_role) THEN
        INSERT INTO partner_activity_logs (partner_id, staff_id, action, entity_type, entity_id, description)
        VALUES (NEW.partner_id, NEW.staff_id, 'partner_staff_updated', 'partner_staff', NEW.staff_id,
                'Status/role changed for ' || NEW.email);
    END IF;
    RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.fn_audit_service_requests()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_partner_id INTEGER;
BEGIN
    SELECT partner_id INTO v_partner_id FROM partner_bookings WHERE booking_id = NEW.booking_id;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO partner_activity_logs (partner_id, staff_id, action, entity_type, entity_id, description)
        VALUES (v_partner_id, NEW.staff_id, 'service_request_created', 'service_requests', NEW.service_request_id,
                NEW.service_request_number || ' (' || NEW.request_type || ') submitted');
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO partner_activity_logs (partner_id, staff_id, action, entity_type, entity_id, description)
        VALUES (v_partner_id, NEW.staff_id, 'service_request_status_changed', 'service_requests', NEW.service_request_id,
                NEW.service_request_number || ' moved from ' || OLD.status || ' to ' || NEW.status);
    END IF;
    RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.fn_auto_generate_booking_reference()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.reference_number IS NULL THEN
        NEW.reference_number := sp_generate_booking_reference(NEW.partner_id);
    END IF;
    RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.fn_auto_generate_service_request_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.service_request_number IS NULL THEN
        NEW.service_request_number := sp_generate_service_request_number();
    END IF;
    RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.fn_notify_partner_booking_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status = 'approved' THEN
            INSERT INTO partner_notifications (staff_id, title, message)
            VALUES (
                NEW.staff_id, 'Booking Approved',
                'Booking ' || NEW.reference_number || ' has been approved.'
            );
        ELSIF NEW.status = 'rejected' THEN
            INSERT INTO partner_notifications (staff_id, title, message)
            VALUES (
                NEW.staff_id, 'Booking Rejected',
                'Booking ' || NEW.reference_number || ' was rejected.' ||
                CASE WHEN NEW.rejection_reason IS NOT NULL THEN ' Reason: ' || NEW.rejection_reason ELSE '' END
            );
        ELSIF NEW.status = 'pending_approval' THEN
            INSERT INTO partner_notifications (staff_id, title, message)
            VALUES (
                NEW.staff_id, 'Booking Pending Approval',
                'Booking ' || NEW.reference_number || ' has been submitted and is awaiting approval.'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.fn_notify_service_request_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_label VARCHAR(60);
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status IN ('approved', 'rejected', 'completed') THEN
        v_label := CASE NEW.request_type
            WHEN 'cancellation' THEN 'Cancellation'
            WHEN 'date_change' THEN 'Date Change'
            WHEN 'refund' THEN 'Refund Request'
            WHEN 'passenger_modification' THEN 'Passenger Modification'
            ELSE 'Service Request'
        END;
        INSERT INTO partner_notifications (staff_id, title, message)
        VALUES (
            NEW.staff_id,
            v_label || ' ' || initcap(NEW.status),
            'Service request ' || NEW.service_request_number || ' (' || v_label || ') is now ' || NEW.status || '.'
        );
    END IF;
    RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.fn_track_booking_status_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO partner_booking_status_history (booking_id, old_status, new_status, changed_by_staff_id)
        VALUES (NEW.booking_id, NULL, NEW.status, NEW.staff_id);
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO partner_booking_status_history (booking_id, old_status, new_status, changed_by_admin_id, changed_by_staff_id)
        VALUES (
            NEW.booking_id, OLD.status, NEW.status,
            COALESCE(NEW.approved_by, NEW.rejected_by),
            CASE WHEN NEW.approved_by IS NULL AND NEW.rejected_by IS NULL THEN NEW.staff_id END
        );
    END IF;
    RETURN NEW;
END;
$function$

CREATE OR REPLACE FUNCTION public.fn_track_service_request_status_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO service_request_status_history (service_request_id, old_status, new_status, changed_by_staff_id)
        VALUES (NEW.service_request_id, NULL, NEW.status, NEW.staff_id);
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO service_request_status_history (service_request_id, old_status, new_status, changed_by_admin_id, changed_by_staff_id)
        VALUES (
            NEW.service_request_id, OLD.status, NEW.status, NEW.resolved_by,
            CASE WHEN NEW.resolved_by IS NULL THEN NEW.staff_id END
        );
    END IF;
    RETURN NEW;
END;
$function$
