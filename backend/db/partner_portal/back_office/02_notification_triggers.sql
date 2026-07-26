-- ============================================================================
-- Partner Portal — notification-generating triggers (additive only)
-- ============================================================================
-- Populates the previously-unused `partner_notifications` table. Does NOT
-- modify any existing trigger, function, or table — these are new objects
-- only, firing on the same partner_bookings/service_requests tables that
-- already exist, alongside (not instead of) the existing status-history
-- triggers.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_notify_partner_booking_status()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status = 'approved' THEN
            INSERT INTO partner_notifications (partner_user_id, title, message)
            VALUES (
                NEW.partner_user_id, 'Booking Approved',
                'Booking ' || NEW.reference_number || ' has been approved.'
            );
        ELSIF NEW.status = 'rejected' THEN
            INSERT INTO partner_notifications (partner_user_id, title, message)
            VALUES (
                NEW.partner_user_id, 'Booking Rejected',
                'Booking ' || NEW.reference_number || ' was rejected.' ||
                CASE WHEN NEW.rejection_reason IS NOT NULL THEN ' Reason: ' || NEW.rejection_reason ELSE '' END
            );
        ELSIF NEW.status = 'pending_approval' THEN
            INSERT INTO partner_notifications (partner_user_id, title, message)
            VALUES (
                NEW.partner_user_id, 'Booking Pending Approval',
                'Booking ' || NEW.reference_number || ' has been submitted and is awaiting approval.'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_partner_booking_status
    AFTER UPDATE ON partner_bookings
    FOR EACH ROW EXECUTE FUNCTION fn_notify_partner_booking_status();


CREATE OR REPLACE FUNCTION fn_notify_service_request_status()
RETURNS TRIGGER AS $$
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
        INSERT INTO partner_notifications (partner_user_id, title, message)
        VALUES (
            NEW.partner_user_id,
            v_label || ' ' || initcap(NEW.status),
            'Service request ' || NEW.service_request_number || ' (' || v_label || ') is now ' || NEW.status || '.'
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_service_request_status
    AFTER UPDATE ON service_requests
    FOR EACH ROW EXECUTE FUNCTION fn_notify_service_request_status();
