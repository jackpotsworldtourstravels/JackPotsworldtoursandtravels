-- =========================================================================
-- 10_procedures.sql
-- Business-logic "stored procedures" (sp_ prefix) -- implemented as
-- PostgreSQL functions since this project never uses CALL-style PROCEDURE
-- objects.
--
-- v2: 14 of the 26 procedures are updated for the partner_users ->
-- partner_staff / partner_user_id -> staff_id rename and the
-- partner_audit_logs -> partner_activity_logs rename.
-- sp_register_partner is substantively rewritten: it no longer looks up a
-- role from the now-retired shared `roles` table -- it inserts directly
-- into partner_staff with role_type='admin', member_role='admin' (the
-- "company admin" of a newly onboarded merchant, matching the
-- Admin -> Admin mapping already used by ROLE_TYPE_MEMBER_ROLES in the
-- app). sp_partner_login_lookup now returns role_type/member_role instead
-- of a role_id. The other 12 procedures are unaffected and unchanged.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.sp_add_passenger(p_booking_id integer, p_full_name character varying, p_gender gender_enum, p_passenger_type passenger_type_enum, p_passport_issuing_country_id integer, p_passport_number character varying, p_passport_issue_date date, p_passport_expiry_date date, p_date_of_birth date, p_nationality_country_id integer, p_meal_preference character varying DEFAULT NULL::character varying, p_special_assistance text DEFAULT NULL::text, p_baggage_catalog_id integer DEFAULT NULL::integer, p_meal_catalog_id integer DEFAULT NULL::integer, p_seat_preference seat_preference_enum DEFAULT NULL::seat_preference_enum)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_passenger_id INTEGER;
BEGIN
    INSERT INTO partner_booking_passengers (
        booking_id, full_name, gender, passenger_type,
        passport_issuing_country_id, passport_number, passport_issue_date, passport_expiry_date,
        date_of_birth, nationality_country_id, meal_preference, special_assistance,
        baggage_catalog_id, meal_catalog_id, seat_preference
    ) VALUES (
        p_booking_id, p_full_name, p_gender, p_passenger_type,
        p_passport_issuing_country_id, p_passport_number, p_passport_issue_date, p_passport_expiry_date,
        p_date_of_birth, p_nationality_country_id, p_meal_preference, p_special_assistance,
        p_baggage_catalog_id, p_meal_catalog_id, p_seat_preference
    )
    RETURNING passenger_id INTO v_passenger_id;

    RETURN v_passenger_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_admin_list_partner_bookings(p_status booking_status_enum DEFAULT 'pending_approval'::booking_status_enum, p_search character varying DEFAULT NULL::character varying)
 RETURNS TABLE(booking_id integer, reference_number character varying, partner_id integer, company_name character varying, requester_name character varying, travel_type travel_type_enum, departure character varying, arrival character varying, departure_date date, passenger_count bigint, total_amount numeric, status booking_status_enum, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        pb.booking_id, pb.reference_number, pb.partner_id, p.company_name, ps.full_name,
        pb.travel_type, pb.departure, pb.arrival, pb.departure_date,
        (SELECT COUNT(*) FROM partner_booking_passengers pbp WHERE pbp.booking_id = pb.booking_id),
        pb.total_amount, pb.status, pb.created_at
    FROM partner_bookings pb
    JOIN partners p ON p.partner_id = pb.partner_id
    JOIN partner_staff ps ON ps.staff_id = pb.staff_id
    WHERE (p_status IS NULL OR pb.status = p_status)
      AND (p_search IS NULL OR pb.reference_number ILIKE '%' || p_search || '%' OR p.company_name ILIKE '%' || p_search || '%')
    ORDER BY pb.created_at DESC;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_approve_request(p_booking_id integer, p_approved_by integer, p_total_amount numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    UPDATE partner_bookings
    SET status = 'approved', approved_by = p_approved_by, approved_at = now(),
        total_amount = COALESCE(p_total_amount, total_amount)
    WHERE booking_id = p_booking_id AND status = 'pending_approval';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % is not pending approval', p_booking_id;
    END IF;
END;
$function$

-- v2: inserts into partner_activity_logs (renamed from partner_audit_logs),
-- param p_partner_user_id -> p_staff_id.
CREATE OR REPLACE FUNCTION public.sp_log_partner_activity(p_partner_id integer, p_staff_id integer, p_action character varying, p_entity_type character varying DEFAULT NULL::character varying, p_entity_id integer DEFAULT NULL::integer, p_description text DEFAULT NULL::text, p_ip_address character varying DEFAULT NULL::character varying)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_activity_id INTEGER;
BEGIN
    INSERT INTO partner_activity_logs (partner_id, staff_id, action, entity_type, entity_id, description, ip_address)
    VALUES (p_partner_id, p_staff_id, p_action, p_entity_type, p_entity_id, p_description, p_ip_address)
    RETURNING activity_id INTO v_activity_id;
    RETURN v_activity_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_cancel_selected_passengers(p_reference_number character varying, p_passenger_ids integer[], p_reason text, p_staff_id integer)
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_booking_id    INTEGER;
    v_sr_id         INTEGER;
    v_sr_number     VARCHAR;
    v_passenger_id  INTEGER;
BEGIN
    SELECT booking_id INTO v_booking_id FROM partner_bookings WHERE reference_number = p_reference_number;
    IF v_booking_id IS NULL THEN
        RAISE EXCEPTION 'Booking reference % not found', p_reference_number;
    END IF;
    IF array_length(p_passenger_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'At least one passenger must be selected';
    END IF;

    v_sr_number := sp_generate_service_request_number();

    INSERT INTO service_requests (service_request_number, booking_id, staff_id, request_type, reason)
    VALUES (v_sr_number, v_booking_id, p_staff_id, 'cancellation', p_reason)
    RETURNING service_request_id INTO v_sr_id;

    INSERT INTO cancellation_requests (service_request_id) VALUES (v_sr_id);

    FOREACH v_passenger_id IN ARRAY p_passenger_ids LOOP
        INSERT INTO cancellation_request_passengers (service_request_id, passenger_id)
        VALUES (v_sr_id, v_passenger_id);
    END LOOP;

    RETURN v_sr_number;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_complete_booking(p_booking_id integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    UPDATE partner_bookings SET status = 'completed' WHERE booking_id = p_booking_id AND status = 'approved';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % is not approved', p_booking_id;
    END IF;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_create_date_change_request(p_reference_number character varying, p_passenger_id integer, p_new_travel_date date, p_reason text, p_staff_id integer)
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_booking_id  INTEGER;
    v_old_date    DATE;
    v_sr_id       INTEGER;
    v_sr_number   VARCHAR;
BEGIN
    SELECT booking_id, departure_date INTO v_booking_id, v_old_date
    FROM partner_bookings WHERE reference_number = p_reference_number;
    IF v_booking_id IS NULL THEN
        RAISE EXCEPTION 'Booking reference % not found', p_reference_number;
    END IF;

    v_sr_number := sp_generate_service_request_number();

    INSERT INTO service_requests (service_request_number, booking_id, staff_id, request_type, reason)
    VALUES (v_sr_number, v_booking_id, p_staff_id, 'date_change', p_reason)
    RETURNING service_request_id INTO v_sr_id;

    INSERT INTO date_change_requests (service_request_id, passenger_id, old_travel_date, new_travel_date)
    VALUES (v_sr_id, p_passenger_id, v_old_date, p_new_travel_date);

    RETURN v_sr_number;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_create_passenger_modification_request(p_reference_number character varying, p_passenger_id integer, p_field_changed character varying, p_old_value character varying, p_new_value character varying, p_reason text, p_staff_id integer)
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_booking_id  INTEGER;
    v_sr_id       INTEGER;
    v_sr_number   VARCHAR;
BEGIN
    SELECT booking_id INTO v_booking_id FROM partner_bookings WHERE reference_number = p_reference_number;
    IF v_booking_id IS NULL THEN
        RAISE EXCEPTION 'Booking reference % not found', p_reference_number;
    END IF;

    v_sr_number := sp_generate_service_request_number();

    INSERT INTO service_requests (service_request_number, booking_id, staff_id, request_type, reason)
    VALUES (v_sr_number, v_booking_id, p_staff_id, 'passenger_modification', p_reason)
    RETURNING service_request_id INTO v_sr_id;

    INSERT INTO passenger_modification_requests (service_request_id, passenger_id, field_changed, old_value, new_value)
    VALUES (v_sr_id, p_passenger_id, p_field_changed, p_old_value, p_new_value);

    RETURN v_sr_number;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_create_refund_request(p_reference_number character varying, p_amount numeric, p_reason text, p_staff_id integer)
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_booking_id  INTEGER;
    v_sr_id       INTEGER;
    v_sr_number   VARCHAR;
BEGIN
    SELECT booking_id INTO v_booking_id FROM partner_bookings WHERE reference_number = p_reference_number;
    IF v_booking_id IS NULL THEN
        RAISE EXCEPTION 'Booking reference % not found', p_reference_number;
    END IF;

    v_sr_number := sp_generate_service_request_number();

    INSERT INTO service_requests (service_request_number, booking_id, staff_id, request_type, reason)
    VALUES (v_sr_number, v_booking_id, p_staff_id, 'refund', p_reason)
    RETURNING service_request_id INTO v_sr_id;

    INSERT INTO refund_requests (service_request_id, amount_requested)
    VALUES (v_sr_id, p_amount);

    RETURN v_sr_number;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_create_ticket_request(p_partner_id integer, p_staff_id integer, p_travel_type travel_type_enum, p_flight_id integer, p_hotel_id integer, p_cruise_id integer, p_airline_name character varying, p_flight_number character varying, p_trip_type trip_type_enum, p_departure character varying, p_arrival character varying, p_departure_date date, p_return_date date, p_cabin_class cabin_class_enum)
 RETURNS TABLE(booking_id integer, reference_number character varying)
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_reference   VARCHAR;
    v_booking_id  INTEGER;
BEGIN
    v_reference := sp_generate_booking_reference(p_partner_id);

    INSERT INTO partner_bookings (
        reference_number, partner_id, staff_id, travel_type,
        flight_id, hotel_id, cruise_id, airline_name, flight_number, trip_type,
        departure, arrival, departure_date, return_date, cabin_class, status
    ) VALUES (
        v_reference, p_partner_id, p_staff_id, p_travel_type,
        p_flight_id, p_hotel_id, p_cruise_id, p_airline_name, p_flight_number, p_trip_type,
        p_departure, p_arrival, p_departure_date, p_return_date, p_cabin_class, 'draft'
    )
    RETURNING partner_bookings.booking_id INTO v_booking_id;

    RETURN QUERY SELECT v_booking_id, v_reference;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_generate_booking_reference(p_partner_id integer)
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
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
$function$

-- v2: p_partner_user_id -> p_staff_id, report_generation_log column
-- partner_user_id -> staff_id.
CREATE OR REPLACE FUNCTION public.sp_generate_report(p_partner_id integer, p_staff_id integer, p_request_date_from date DEFAULT NULL::date, p_request_date_to date DEFAULT NULL::date, p_travel_date_from date DEFAULT NULL::date, p_travel_date_to date DEFAULT NULL::date, p_passenger_name character varying DEFAULT NULL::character varying, p_service_request_number character varying DEFAULT NULL::character varying, p_sector_departure character varying DEFAULT NULL::character varying, p_sector_arrival character varying DEFAULT NULL::character varying, p_export_format export_format_enum DEFAULT 'pdf'::export_format_enum)
 RETURNS SETOF vw_reports_summary
 LANGUAGE plpgsql
AS $function$
BEGIN
    INSERT INTO report_generation_log (partner_id, staff_id, filters, export_format)
    VALUES (
        p_partner_id, p_staff_id,
        jsonb_build_object(
            'request_date_from', p_request_date_from, 'request_date_to', p_request_date_to,
            'travel_date_from', p_travel_date_from, 'travel_date_to', p_travel_date_to,
            'passenger_name', p_passenger_name, 'service_request_number', p_service_request_number,
            'sector_departure', p_sector_departure, 'sector_arrival', p_sector_arrival
        ),
        p_export_format
    );

    RETURN QUERY
    SELECT * FROM vw_reports_summary rs
    WHERE rs.partner_id = p_partner_id
      AND (p_request_date_from IS NULL OR rs.request_date >= p_request_date_from)
      AND (p_request_date_to IS NULL OR rs.request_date <= p_request_date_to)
      AND (p_travel_date_from IS NULL OR rs.travel_date >= p_travel_date_from)
      AND (p_travel_date_to IS NULL OR rs.travel_date <= p_travel_date_to)
      AND (p_passenger_name IS NULL OR rs.passenger_name ILIKE '%' || p_passenger_name || '%')
      AND (p_service_request_number IS NULL OR rs.service_request_number = p_service_request_number)
      AND (p_sector_departure IS NULL OR rs.sector_departure ILIKE '%' || p_sector_departure || '%')
      AND (p_sector_arrival IS NULL OR rs.sector_arrival ILIKE '%' || p_sector_arrival || '%')
    ORDER BY rs.request_date DESC;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_generate_service_request_number()
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN 'SR' || LPAD(nextval('service_request_number_seq')::TEXT, 6, '0');
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_get_dashboard_statistics(p_partner_id integer)
 RETURNS TABLE(total_requests integer, pending_requests integer, approved_requests integer, rejected_requests integer, completed_requests integer, cancelled_requests integer, today_requests integer, today_revenue numeric)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    SELECT v.total_requests::INTEGER, v.pending_requests::INTEGER, v.approved_requests::INTEGER,
           v.rejected_requests::INTEGER, v.completed_requests::INTEGER, v.cancelled_requests::INTEGER,
           v.today_requests::INTEGER, v.today_revenue
    FROM vw_partner_dashboard_stats v
    WHERE v.partner_id = p_partner_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_get_request_history(p_partner_id integer, p_status booking_status_enum DEFAULT NULL::booking_status_enum, p_from_date date DEFAULT NULL::date, p_to_date date DEFAULT NULL::date)
 RETURNS SETOF vw_request_history
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    SELECT * FROM vw_request_history vh
    WHERE vh.partner_id = p_partner_id
      AND (p_status IS NULL OR vh.status = p_status)
      AND (p_from_date IS NULL OR vh.travel_date >= p_from_date)
      AND (p_to_date IS NULL OR vh.travel_date <= p_to_date)
    ORDER BY vh.created_at DESC;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_get_ticket_enquiry(p_departure character varying DEFAULT NULL::character varying, p_arrival character varying DEFAULT NULL::character varying, p_date date DEFAULT NULL::date, p_cabin_class character varying DEFAULT NULL::character varying)
 RETURNS TABLE(flight_id integer, airline character varying, from_airport character varying, to_airport character varying, departure_time timestamp without time zone, arrival_time timestamp without time zone, cabin_class character varying, seats_available integer, price numeric)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    SELECT f.id, f.airline, f.from_airport, f.to_airport, f.departure_time, f.arrival_time,
           f.cabin_class, f.seats_available, f.price
    FROM flights f
    WHERE (p_departure IS NULL OR f.from_airport ILIKE '%' || p_departure || '%')
      AND (p_arrival IS NULL OR f.to_airport ILIKE '%' || p_arrival || '%')
      AND (p_date IS NULL OR f.departure_time::date = p_date)
      AND (p_cabin_class IS NULL OR f.cabin_class ILIKE p_cabin_class)
    ORDER BY f.departure_time;
END;
$function$

-- v2: FROM partner_users -> FROM partner_staff. RETURNS role_type/
-- member_role instead of role_id (which no longer exists on partner_staff
-- -- see 04_partner_tables.sql header).
CREATE OR REPLACE FUNCTION public.sp_partner_login_lookup(p_email character varying)
 RETURNS TABLE(staff_id integer, partner_id integer, password_hash character varying, status partner_staff_status_enum, role_type merchant_role_type_enum, member_role merchant_member_role_enum, full_name character varying)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    SELECT ps.staff_id, ps.partner_id, ps.password_hash, ps.status, ps.role_type, ps.member_role, ps.full_name
    FROM partner_staff ps
    WHERE ps.email = p_email;
END;
$function$

-- v2: p_partner_user_id -> p_staff_id, partner_users -> partner_staff,
-- partner_audit_logs -> partner_activity_logs.
CREATE OR REPLACE FUNCTION public.sp_partner_record_login(p_staff_id integer, p_ip_address character varying)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_partner_id INTEGER;
BEGIN
    UPDATE partner_staff SET last_login_at = now() WHERE staff_id = p_staff_id
    RETURNING partner_id INTO v_partner_id;

    INSERT INTO partner_activity_logs (partner_id, staff_id, action, entity_type, entity_id, description, ip_address)
    VALUES (v_partner_id, p_staff_id, 'login_success', 'partner_staff', p_staff_id, 'Partner login', p_ip_address);
END;
$function$

-- v2: no longer looks up a role from the retired shared `roles` table.
-- Inserts directly into partner_staff with role_type='admin',
-- member_role='admin' (the company admin of a newly onboarded merchant).
CREATE OR REPLACE FUNCTION public.sp_register_partner(p_company_name character varying, p_company_code character varying, p_reference_prefix character varying, p_partner_email character varying, p_phone_number character varying, p_admin_full_name character varying, p_admin_email character varying, p_admin_password_hash character varying)
 RETURNS TABLE(partner_id integer, staff_id integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_partner_id  INTEGER;
    v_staff_id    INTEGER;
BEGIN
    INSERT INTO partners (company_name, company_code, reference_prefix, email, phone_number, status)
    VALUES (p_company_name, p_company_code, p_reference_prefix, p_partner_email, p_phone_number, 'active')
    RETURNING partners.partner_id INTO v_partner_id;

    INSERT INTO partner_staff (partner_id, full_name, email, password_hash, role_type, member_role, status)
    VALUES (v_partner_id, p_admin_full_name, p_admin_email, p_admin_password_hash, 'admin', 'admin', 'active')
    RETURNING partner_staff.staff_id INTO v_staff_id;

    RETURN QUERY SELECT v_partner_id, v_staff_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_reject_request(p_booking_id integer, p_rejected_by integer, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    UPDATE partner_bookings
    SET status = 'rejected', rejected_by = p_rejected_by, rejected_at = now(), rejection_reason = p_reason
    WHERE booking_id = p_booking_id AND status = 'pending_approval';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % is not pending approval', p_booking_id;
    END IF;
END;
$function$

-- v2: p_partner_user_id -> p_staff_id, partner_otp_requests column
-- partner_user_id -> staff_id.
CREATE OR REPLACE FUNCTION public.sp_request_otp(p_staff_id integer, p_otp_hash character varying, p_purpose otp_purpose_enum, p_ttl_minutes integer DEFAULT 5)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_otp_id INTEGER;
    v_recent_count INTEGER;
BEGIN
    SELECT count(*) INTO v_recent_count
    FROM partner_otp_requests
    WHERE staff_id = p_staff_id
      AND purpose = p_purpose
      AND created_at > now() - interval '1 hour';

    IF v_recent_count >= 5 THEN
        RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED: too many OTP requests for this account in the last hour';
    END IF;

    -- Invalidate any prior unverified OTP of the same purpose for this staff member.
    UPDATE partner_otp_requests
    SET expires_at = now()
    WHERE staff_id = p_staff_id AND purpose = p_purpose AND verified_at IS NULL;

    INSERT INTO partner_otp_requests (staff_id, otp_hash, purpose, expires_at)
    VALUES (p_staff_id, p_otp_hash, p_purpose, now() + (p_ttl_minutes || ' minutes')::interval)
    RETURNING otp_id INTO v_otp_id;

    RETURN v_otp_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_resolve_service_request(p_service_request_id integer, p_status service_request_status_enum, p_resolved_by integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF p_status NOT IN ('approved', 'rejected', 'completed') THEN
        RAISE EXCEPTION 'Cannot resolve a service request to status %', p_status;
    END IF;

    UPDATE service_requests
    SET status = p_status, resolved_by = p_resolved_by, resolved_at = now()
    WHERE service_request_id = p_service_request_id AND status IN ('submitted', 'in_review');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Service request % not found or already resolved', p_service_request_id;
    END IF;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_set_passenger_special_services(p_passenger_id integer, p_catalog_ids integer[])
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    DELETE FROM passenger_special_services WHERE passenger_id = p_passenger_id;

    IF p_catalog_ids IS NOT NULL AND array_length(p_catalog_ids, 1) > 0 THEN
        INSERT INTO passenger_special_services (passenger_id, catalog_id)
        SELECT p_passenger_id, unnest(p_catalog_ids);
    END IF;
END;
$function$

CREATE OR REPLACE FUNCTION public.sp_submit_request_for_approval(p_booking_id integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_passenger_count  INTEGER;
    v_status           booking_status_enum;
BEGIN
    SELECT status INTO v_status FROM partner_bookings WHERE booking_id = p_booking_id;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Booking % not found', p_booking_id;
    END IF;
    IF v_status <> 'draft' THEN
        RAISE EXCEPTION 'Booking % is not in draft status (currently %)', p_booking_id, v_status;
    END IF;

    SELECT COUNT(*) INTO v_passenger_count FROM partner_booking_passengers WHERE booking_id = p_booking_id;
    IF v_passenger_count = 0 THEN
        RAISE EXCEPTION 'Booking % has no passengers', p_booking_id;
    END IF;

    UPDATE partner_bookings SET status = 'pending_approval' WHERE booking_id = p_booking_id;
END;
$function$

-- v2: p_partner_user_id -> p_staff_id, partner_users -> partner_staff.
CREATE OR REPLACE FUNCTION public.sp_update_partner_profile(p_staff_id integer, p_full_name character varying DEFAULT NULL::character varying, p_phone_number character varying DEFAULT NULL::character varying)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    UPDATE partner_staff
    SET full_name = COALESCE(p_full_name, full_name), phone_number = COALESCE(p_phone_number, phone_number)
    WHERE staff_id = p_staff_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Partner staff member % not found', p_staff_id;
    END IF;
END;
$function$

-- v2: p_partner_user_id -> p_staff_id, partner_otp_requests column
-- partner_user_id -> staff_id.
CREATE OR REPLACE FUNCTION public.sp_verify_otp(p_staff_id integer, p_purpose otp_purpose_enum, p_otp_hash character varying)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_otp_id  INTEGER;
    v_matched BOOLEAN;
BEGIN
    SELECT otp_id, (otp_hash = p_otp_hash)
    INTO v_otp_id, v_matched
    FROM partner_otp_requests
    WHERE staff_id = p_staff_id
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
$function$
