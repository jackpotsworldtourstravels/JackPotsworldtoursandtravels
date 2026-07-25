-- Partner Portal — 08: Views
-- Depends on: 03-06 (all table files)

CREATE OR REPLACE VIEW vw_partner_dashboard_stats AS
SELECT
    p.partner_id,
    COUNT(pb.booking_id)                                                   AS total_requests,
    COUNT(pb.booking_id) FILTER (WHERE pb.status = 'pending_approval')     AS pending_requests,
    COUNT(pb.booking_id) FILTER (WHERE pb.status = 'approved')             AS approved_requests,
    COUNT(pb.booking_id) FILTER (WHERE pb.status = 'rejected')             AS rejected_requests,
    COUNT(pb.booking_id) FILTER (WHERE pb.status = 'completed')            AS completed_requests,
    COUNT(pb.booking_id) FILTER (WHERE pb.status = 'cancelled')            AS cancelled_requests,
    COUNT(pb.booking_id) FILTER (WHERE pb.created_at::date = CURRENT_DATE) AS today_requests,
    COALESCE(SUM(pb.total_amount) FILTER (
        WHERE pb.created_at::date = CURRENT_DATE AND pb.status <> 'rejected'
    ), 0)                                                                  AS today_revenue
FROM partners p
LEFT JOIN partner_bookings pb ON pb.partner_id = p.partner_id
GROUP BY p.partner_id;

-- Backs the Request History table: one row per (booking, passenger), with
-- the most recent linked service request number if one exists.
CREATE OR REPLACE VIEW vw_request_history AS
SELECT
    pb.booking_id,
    pb.reference_number,
    sr.service_request_number,
    pb.partner_id,
    pbp.passenger_id,
    pbp.full_name                        AS passenger_name,
    pb.travel_type,
    COALESCE(pb.arrival, pb.departure)   AS destination,
    pb.departure_date                    AS travel_date,
    pb.status,
    pb.created_at
FROM partner_bookings pb
JOIN partner_booking_passengers pbp ON pbp.booking_id = pb.booking_id
LEFT JOIN LATERAL (
    SELECT service_request_number
    FROM service_requests
    WHERE booking_id = pb.booking_id
    ORDER BY created_at DESC
    LIMIT 1
) sr ON true;

-- Backs the Reports tab's filters (request date, travel date, passenger,
-- sector, reimbursement amount).
CREATE OR REPLACE VIEW vw_reports_summary AS
SELECT
    pb.partner_id,
    pb.booking_id,
    pb.reference_number,
    pbp.passenger_id,
    pbp.full_name        AS passenger_name,
    sr.service_request_number,
    pb.departure          AS sector_departure,
    pb.arrival             AS sector_arrival,
    pb.created_at::date   AS request_date,
    pb.departure_date      AS travel_date,
    pb.total_amount,
    rr.amount_requested   AS amount_reimbursement,
    pb.status
FROM partner_bookings pb
JOIN partner_booking_passengers pbp ON pbp.booking_id = pb.booking_id
LEFT JOIN service_requests sr ON sr.booking_id = pb.booking_id
LEFT JOIN refund_requests rr ON rr.service_request_id = sr.service_request_id;
