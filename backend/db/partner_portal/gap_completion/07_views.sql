-- Partner Portal — Gap completion — 07: Views
-- Depends on: Phase 2's tables + existing flights/hotels/cruises (reused,
-- not duplicated — see the "Airlines table" decision in this phase's README).

-- Unfiltered, browsable inventory across all three catalog types in one
-- shape. Complements (doesn't replace) sp_get_ticket_enquiry (Phase 2),
-- which does the parameterized flight search the Ticket Enquiry screen
-- actually calls — this view is for ad hoc/future broad browsing across
-- flights+hotels+cruises together.
CREATE OR REPLACE VIEW vw_ticket_enquiry AS
SELECT 'flight'::VARCHAR AS item_type, f.id AS item_id, f.airline AS name,
       f.from_airport || ' → ' || f.to_airport AS route,
       f.departure_time, f.arrival_time, f.cabin_class,
       f.seats_available AS availability, f.price
FROM flights f
UNION ALL
SELECT 'hotel', h.id, h.name, h.location, NULL, NULL, NULL, h.rooms_available, h.price_per_night
FROM hotels h
UNION ALL
SELECT 'cruise', c.id, c.name, c.departure_port, NULL, NULL, NULL, c.cabins_available, c.price
FROM cruises c;

-- All service requests with their booking/partner context in one row —
-- distinct from vw_request_history (Phase 2), which is passenger-centric
-- (one row per passenger). This is request-centric: one row per service
-- request, useful for a future "all pending service requests" admin screen.
CREATE OR REPLACE VIEW vw_service_requests AS
SELECT
    sr.service_request_id, sr.service_request_number, sr.request_type, sr.status,
    sr.reason, sr.created_at, sr.resolved_at,
    pb.booking_id, pb.reference_number,
    p.partner_id, p.company_name,
    pu.full_name AS requested_by
FROM service_requests sr
JOIN partner_bookings pb ON pb.booking_id = sr.booking_id
JOIN partners p ON p.partner_id = pb.partner_id
JOIN partner_users pu ON pu.partner_user_id = sr.partner_user_id;
