-- =========================================================================
-- 08_views.sql
-- Reporting/aggregation views. Unchanged from the live database except
-- vw_service_requests, updated for the partner_users -> partner_staff /
-- partner_user_id -> staff_id rename.
-- =========================================================================

CREATE OR REPLACE VIEW vw_partner_dashboard_stats AS
SELECT p.partner_id,
    count(pb.booking_id) AS total_requests,
    count(pb.booking_id) FILTER (WHERE (pb.status = 'pending_approval'::booking_status_enum)) AS pending_requests,
    count(pb.booking_id) FILTER (WHERE (pb.status = 'approved'::booking_status_enum)) AS approved_requests,
    count(pb.booking_id) FILTER (WHERE (pb.status = 'rejected'::booking_status_enum)) AS rejected_requests,
    count(pb.booking_id) FILTER (WHERE (pb.status = 'completed'::booking_status_enum)) AS completed_requests,
    count(pb.booking_id) FILTER (WHERE (pb.status = 'cancelled'::booking_status_enum)) AS cancelled_requests,
    count(pb.booking_id) FILTER (WHERE ((pb.created_at)::date = CURRENT_DATE)) AS today_requests,
    COALESCE(sum(pb.total_amount) FILTER (WHERE (((pb.created_at)::date = CURRENT_DATE) AND (pb.status <> 'rejected'::booking_status_enum))), (0)::numeric) AS today_revenue
   FROM (partners p
     LEFT JOIN partner_bookings pb ON ((pb.partner_id = p.partner_id)))
  GROUP BY p.partner_id;

CREATE OR REPLACE VIEW vw_reports_summary AS
SELECT pb.partner_id,
    pb.booking_id,
    pb.reference_number,
    pbp.passenger_id,
    pbp.full_name AS passenger_name,
    sr.service_request_number,
    pb.departure AS sector_departure,
    pb.arrival AS sector_arrival,
    (pb.created_at)::date AS request_date,
    pb.departure_date AS travel_date,
    pb.total_amount,
    rr.amount_requested AS amount_reimbursement,
    pb.status
   FROM (((partner_bookings pb
     JOIN partner_booking_passengers pbp ON ((pbp.booking_id = pb.booking_id)))
     LEFT JOIN service_requests sr ON ((sr.booking_id = pb.booking_id)))
     LEFT JOIN refund_requests rr ON ((rr.service_request_id = sr.service_request_id)));

CREATE OR REPLACE VIEW vw_request_history AS
SELECT pb.booking_id,
    pb.reference_number,
    sr.service_request_number,
    pb.partner_id,
    pbp.passenger_id,
    pbp.full_name AS passenger_name,
    pb.travel_type,
    COALESCE(pb.arrival, pb.departure) AS destination,
    pb.departure_date AS travel_date,
    pb.status,
    pb.created_at
   FROM ((partner_bookings pb
     JOIN partner_booking_passengers pbp ON ((pbp.booking_id = pb.booking_id)))
     LEFT JOIN LATERAL ( SELECT service_requests.service_request_number
           FROM service_requests
          WHERE (service_requests.booking_id = pb.booking_id)
          ORDER BY service_requests.created_at DESC
         LIMIT 1) sr ON (true));

-- v2: JOIN partner_users pu ON pu.partner_user_id = sr.partner_user_id
--     -> JOIN partner_staff pu ON pu.staff_id = sr.staff_id
CREATE OR REPLACE VIEW vw_service_requests AS
SELECT sr.service_request_id,
    sr.service_request_number,
    sr.request_type,
    sr.status,
    sr.reason,
    sr.created_at,
    sr.resolved_at,
    pb.booking_id,
    pb.reference_number,
    p.partner_id,
    p.company_name,
    pu.full_name AS requested_by
   FROM (((service_requests sr
     JOIN partner_bookings pb ON ((pb.booking_id = sr.booking_id)))
     JOIN partners p ON ((p.partner_id = pb.partner_id)))
     JOIN partner_staff pu ON ((pu.staff_id = sr.staff_id)));

CREATE OR REPLACE VIEW vw_ticket_enquiry AS
SELECT 'flight'::character varying AS item_type,
    f.id AS item_id,
    f.airline AS name,
    (((f.from_airport)::text || ' → '::text) || (f.to_airport)::text) AS route,
    f.departure_time,
    f.arrival_time,
    f.cabin_class,
    f.seats_available AS availability,
    f.price
   FROM flights f
UNION ALL
 SELECT 'hotel'::character varying AS item_type,
    h.id AS item_id,
    h.name,
    h.location AS route,
    NULL::timestamp without time zone AS departure_time,
    NULL::timestamp without time zone AS arrival_time,
    NULL::character varying AS cabin_class,
    h.rooms_available AS availability,
    h.price_per_night AS price
   FROM hotels h
UNION ALL
 SELECT 'cruise'::character varying AS item_type,
    c.id AS item_id,
    c.name,
    c.departure_port AS route,
    NULL::timestamp without time zone AS departure_time,
    NULL::timestamp without time zone AS arrival_time,
    NULL::character varying AS cabin_class,
    c.cabins_available AS availability,
    c.price
   FROM cruises c;
