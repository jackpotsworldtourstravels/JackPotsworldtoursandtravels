-- Partner Portal — 11: Booking workflow stored procedures
-- Depends on: 04_booking_tables.sql, 10_stored_procedures_auth_and_reference.sql
--
-- Workflow: sp_create_ticket_request (draft) -> sp_add_passenger (repeat) ->
-- sp_submit_request_for_approval (pending_approval) -> sp_approve_request or
-- sp_reject_request -> sp_complete_booking (once the ticket is actually issued).

CREATE OR REPLACE FUNCTION sp_create_ticket_request(
    p_partner_id       INTEGER,
    p_partner_user_id  INTEGER,
    p_travel_type      travel_type_enum,
    p_flight_id        INTEGER,
    p_hotel_id         INTEGER,
    p_cruise_id        INTEGER,
    p_airline_name     VARCHAR,
    p_flight_number    VARCHAR,
    p_trip_type        trip_type_enum,
    p_departure        VARCHAR,
    p_arrival          VARCHAR,
    p_departure_date   DATE,
    p_return_date      DATE,
    p_cabin_class      cabin_class_enum
)
RETURNS TABLE (booking_id INTEGER, reference_number VARCHAR) AS $$
DECLARE
    v_reference   VARCHAR;
    v_booking_id  INTEGER;
BEGIN
    v_reference := sp_generate_booking_reference(p_partner_id);

    INSERT INTO partner_bookings (
        reference_number, partner_id, partner_user_id, travel_type,
        flight_id, hotel_id, cruise_id, airline_name, flight_number, trip_type,
        departure, arrival, departure_date, return_date, cabin_class, status
    ) VALUES (
        v_reference, p_partner_id, p_partner_user_id, p_travel_type,
        p_flight_id, p_hotel_id, p_cruise_id, p_airline_name, p_flight_number, p_trip_type,
        p_departure, p_arrival, p_departure_date, p_return_date, p_cabin_class, 'draft'
    )
    RETURNING partner_bookings.booking_id INTO v_booking_id;

    RETURN QUERY SELECT v_booking_id, v_reference;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sp_add_passenger(
    p_booking_id                   INTEGER,
    p_full_name                    VARCHAR,
    p_gender                       gender_enum,
    p_passenger_type                passenger_type_enum,
    p_passport_issuing_country_id   INTEGER,
    p_passport_number                VARCHAR,
    p_passport_issue_date            DATE,
    p_passport_expiry_date            DATE,
    p_date_of_birth                    DATE,
    p_nationality_country_id            INTEGER,
    p_meal_preference                    VARCHAR DEFAULT NULL,
    p_special_assistance                  TEXT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    v_passenger_id INTEGER;
BEGIN
    INSERT INTO partner_booking_passengers (
        booking_id, full_name, gender, passenger_type,
        passport_issuing_country_id, passport_number, passport_issue_date, passport_expiry_date,
        date_of_birth, nationality_country_id, meal_preference, special_assistance
    ) VALUES (
        p_booking_id, p_full_name, p_gender, p_passenger_type,
        p_passport_issuing_country_id, p_passport_number, p_passport_issue_date, p_passport_expiry_date,
        p_date_of_birth, p_nationality_country_id, p_meal_preference, p_special_assistance
    )
    RETURNING passenger_id INTO v_passenger_id;

    RETURN v_passenger_id;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sp_submit_request_for_approval(p_booking_id INTEGER)
RETURNS VOID AS $$
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
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sp_approve_request(p_booking_id INTEGER, p_approved_by INTEGER, p_total_amount NUMERIC DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
    UPDATE partner_bookings
    SET status = 'approved', approved_by = p_approved_by, approved_at = now(),
        total_amount = COALESCE(p_total_amount, total_amount)
    WHERE booking_id = p_booking_id AND status = 'pending_approval';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % is not pending approval', p_booking_id;
    END IF;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sp_reject_request(p_booking_id INTEGER, p_rejected_by INTEGER, p_reason TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE partner_bookings
    SET status = 'rejected', rejected_by = p_rejected_by, rejected_at = now(), rejection_reason = p_reason
    WHERE booking_id = p_booking_id AND status = 'pending_approval';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % is not pending approval', p_booking_id;
    END IF;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sp_complete_booking(p_booking_id INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE partner_bookings SET status = 'completed' WHERE booking_id = p_booking_id AND status = 'approved';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % is not approved', p_booking_id;
    END IF;
END;
$$ LANGUAGE plpgsql;
