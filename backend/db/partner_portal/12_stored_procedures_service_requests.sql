-- Partner Portal — 12: Service request stored procedures
-- Depends on: 05_service_request_tables.sql, 10_stored_procedures_auth_and_reference.sql

CREATE OR REPLACE FUNCTION sp_cancel_selected_passengers(
    p_reference_number  VARCHAR,
    p_passenger_ids      INTEGER[],
    p_reason              TEXT,
    p_partner_user_id     INTEGER
)
RETURNS VARCHAR AS $$
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

    INSERT INTO service_requests (service_request_number, booking_id, partner_user_id, request_type, reason)
    VALUES (v_sr_number, v_booking_id, p_partner_user_id, 'cancellation', p_reason)
    RETURNING service_request_id INTO v_sr_id;

    INSERT INTO cancellation_requests (service_request_id) VALUES (v_sr_id);

    FOREACH v_passenger_id IN ARRAY p_passenger_ids LOOP
        INSERT INTO cancellation_request_passengers (service_request_id, passenger_id)
        VALUES (v_sr_id, v_passenger_id);
    END LOOP;

    RETURN v_sr_number;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sp_create_date_change_request(
    p_reference_number  VARCHAR,
    p_passenger_id        INTEGER,
    p_new_travel_date      DATE,
    p_reason                TEXT,
    p_partner_user_id       INTEGER
)
RETURNS VARCHAR AS $$
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

    INSERT INTO service_requests (service_request_number, booking_id, partner_user_id, request_type, reason)
    VALUES (v_sr_number, v_booking_id, p_partner_user_id, 'date_change', p_reason)
    RETURNING service_request_id INTO v_sr_id;

    INSERT INTO date_change_requests (service_request_id, passenger_id, old_travel_date, new_travel_date)
    VALUES (v_sr_id, p_passenger_id, v_old_date, p_new_travel_date);

    RETURN v_sr_number;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sp_create_refund_request(
    p_reference_number  VARCHAR,
    p_amount              NUMERIC,
    p_reason               TEXT,
    p_partner_user_id      INTEGER
)
RETURNS VARCHAR AS $$
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

    INSERT INTO service_requests (service_request_number, booking_id, partner_user_id, request_type, reason)
    VALUES (v_sr_number, v_booking_id, p_partner_user_id, 'refund', p_reason)
    RETURNING service_request_id INTO v_sr_id;

    INSERT INTO refund_requests (service_request_id, amount_requested)
    VALUES (v_sr_id, p_amount);

    RETURN v_sr_number;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION sp_create_passenger_modification_request(
    p_reference_number  VARCHAR,
    p_passenger_id        INTEGER,
    p_field_changed        VARCHAR,
    p_old_value              VARCHAR,
    p_new_value               VARCHAR,
    p_reason                   TEXT,
    p_partner_user_id          INTEGER
)
RETURNS VARCHAR AS $$
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

    INSERT INTO service_requests (service_request_number, booking_id, partner_user_id, request_type, reason)
    VALUES (v_sr_number, v_booking_id, p_partner_user_id, 'passenger_modification', p_reason)
    RETURNING service_request_id INTO v_sr_id;

    INSERT INTO passenger_modification_requests (service_request_id, passenger_id, field_changed, old_value, new_value)
    VALUES (v_sr_id, p_passenger_id, p_field_changed, p_old_value, p_new_value);

    RETURN v_sr_number;
END;
$$ LANGUAGE plpgsql;
