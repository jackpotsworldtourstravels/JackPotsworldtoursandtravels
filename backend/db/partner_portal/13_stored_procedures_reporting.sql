-- Partner Portal — 13: Ticket enquiry, request history, reporting stored procedures
-- Depends on: 08_views.sql, existing tables flights/hotels/cruises

CREATE OR REPLACE FUNCTION sp_get_ticket_enquiry(
    p_departure    VARCHAR DEFAULT NULL,
    p_arrival       VARCHAR DEFAULT NULL,
    p_date          DATE DEFAULT NULL,
    p_cabin_class   VARCHAR DEFAULT NULL
)
RETURNS TABLE (
    flight_id         INTEGER,
    airline            VARCHAR,
    from_airport         VARCHAR,
    to_airport            VARCHAR,
    departure_time         TIMESTAMP,
    arrival_time              TIMESTAMP,
    cabin_class                 VARCHAR,
    seats_available               INTEGER,
    price                           NUMERIC
) AS $$
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
$$ LANGUAGE plpgsql STABLE;


CREATE OR REPLACE FUNCTION sp_get_request_history(
    p_partner_id  INTEGER,
    p_status       booking_status_enum DEFAULT NULL,
    p_from_date    DATE DEFAULT NULL,
    p_to_date      DATE DEFAULT NULL
)
RETURNS SETOF vw_request_history AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM vw_request_history vh
    WHERE vh.partner_id = p_partner_id
      AND (p_status IS NULL OR vh.status = p_status)
      AND (p_from_date IS NULL OR vh.travel_date >= p_from_date)
      AND (p_to_date IS NULL OR vh.travel_date <= p_to_date)
    ORDER BY vh.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE;


-- Also logs the run to report_generation_log (the audit trail — see
-- 06_payment_report_notification_audit_tables.sql), so the returned rows
-- are never the only record that a report was generated.
CREATE OR REPLACE FUNCTION sp_generate_report(
    p_partner_id               INTEGER,
    p_partner_user_id           INTEGER,
    p_request_date_from          DATE DEFAULT NULL,
    p_request_date_to             DATE DEFAULT NULL,
    p_travel_date_from              DATE DEFAULT NULL,
    p_travel_date_to                  DATE DEFAULT NULL,
    p_passenger_name                    VARCHAR DEFAULT NULL,
    p_service_request_number              VARCHAR DEFAULT NULL,
    p_sector_departure                      VARCHAR DEFAULT NULL,
    p_sector_arrival                          VARCHAR DEFAULT NULL,
    p_export_format                             export_format_enum DEFAULT 'pdf'
)
RETURNS SETOF vw_reports_summary AS $$
BEGIN
    INSERT INTO report_generation_log (partner_id, partner_user_id, filters, export_format)
    VALUES (
        p_partner_id, p_partner_user_id,
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
$$ LANGUAGE plpgsql;
