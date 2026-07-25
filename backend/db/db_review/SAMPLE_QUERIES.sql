-- ============================================================================
-- JackPots World Tours & Travels — Sample Data Verification Queries
-- ============================================================================
-- Purpose: one quick SELECT per table so you can eyeball real data for every
-- table during your project demo. Run any single statement in pgAdmin 4's
-- Query Tool (click into it, press F5). All read-only, all LIMIT-capped.
-- ============================================================================


-- ============================================================================
-- CORE PLATFORM — Catalog / Content
-- ============================================================================
SELECT * FROM countries      ORDER BY country_id           LIMIT 20;
SELECT * FROM flights        ORDER BY id            DESC    LIMIT 20;
SELECT * FROM hotels         ORDER BY id            DESC    LIMIT 20;
SELECT * FROM cruises        ORDER BY id            DESC    LIMIT 20;
SELECT * FROM tour_packages  ORDER BY id            DESC    LIMIT 20;
SELECT * FROM seasonal_prices ORDER BY id           DESC    LIMIT 20;

-- ============================================================================
-- CORE PLATFORM — Users, Roles & Access
-- ============================================================================
SELECT * FROM users            ORDER BY id            DESC LIMIT 20;
SELECT * FROM roles            ORDER BY id;
SELECT * FROM permissions      ORDER BY permission_id;
SELECT * FROM role_permissions ORDER BY role_id, permission_id;
SELECT * FROM user_sessions    ORDER BY id            DESC LIMIT 20;
SELECT * FROM activity_logs    ORDER BY id            DESC LIMIT 20;

-- ============================================================================
-- CORE PLATFORM — Bookings, Payments & Pricing
-- ============================================================================
SELECT * FROM bookings                   ORDER BY id       DESC LIMIT 20;
SELECT * FROM payments                   ORDER BY id       DESC LIMIT 20;
SELECT * FROM booking_reference_counters ORDER BY partner_id, year;
SELECT * FROM coupons                    ORDER BY id       DESC LIMIT 20;
SELECT * FROM discount_campaigns         ORDER BY id       DESC LIMIT 20;

-- ============================================================================
-- CORE PLATFORM — Post-booking customer requests
-- ============================================================================
SELECT * FROM cancellation_requests            ORDER BY service_request_id DESC LIMIT 20;
SELECT * FROM cancellation_request_passengers  ORDER BY service_request_id DESC LIMIT 20;
SELECT * FROM date_change_requests             ORDER BY service_request_id DESC LIMIT 20;
SELECT * FROM passenger_modification_requests  ORDER BY service_request_id DESC LIMIT 20;
SELECT * FROM refund_requests                  ORDER BY service_request_id DESC LIMIT 20;

-- ============================================================================
-- CORE PLATFORM — Engagement / Support
-- ============================================================================
SELECT * FROM reviews         ORDER BY id  DESC LIMIT 20;
SELECT * FROM wishlist        ORDER BY id  DESC LIMIT 20;
SELECT * FROM notifications   ORDER BY id  DESC LIMIT 20;
SELECT * FROM support_tickets ORDER BY id  DESC LIMIT 20;
SELECT * FROM contact_us      ORDER BY id  DESC LIMIT 20;
SELECT * FROM newsletter      ORDER BY id  DESC LIMIT 20;


-- ============================================================================
-- PARTNER PORTAL — Identity & Access
-- ============================================================================
SELECT * FROM partners           ORDER BY partner_id;
SELECT * FROM partner_users      ORDER BY partner_user_id;
SELECT * FROM partner_otp_requests ORDER BY otp_id DESC LIMIT 20;
SELECT * FROM partner_audit_logs   ORDER BY audit_id DESC LIMIT 30;

-- ============================================================================
-- PARTNER PORTAL — Bookings
-- ============================================================================
SELECT * FROM partner_bookings             ORDER BY booking_id    DESC LIMIT 20;
SELECT * FROM partner_booking_passengers   ORDER BY passenger_id  DESC LIMIT 20;
SELECT * FROM partner_booking_status_history ORDER BY history_id  DESC LIMIT 20;
SELECT * FROM partner_payments             ORDER BY payment_id    DESC LIMIT 20;
SELECT * FROM partner_notifications        ORDER BY notification_id DESC LIMIT 20;

-- ============================================================================
-- PARTNER PORTAL — Service Requests (cancellation / date-change / refund / etc.)
-- ============================================================================
SELECT * FROM service_requests               ORDER BY service_request_id DESC LIMIT 20;
SELECT * FROM service_request_status_history ORDER BY history_id         DESC LIMIT 20;

-- ============================================================================
-- PARTNER PORTAL — Reporting
-- ============================================================================
SELECT * FROM report_generation_log ORDER BY report_id DESC LIMIT 20;


-- ============================================================================
-- VIEWS — pull directly from each view to confirm they resolve correctly
-- ============================================================================
SELECT * FROM vw_partner_dashboard_stats LIMIT 20;
SELECT * FROM vw_reports_summary          LIMIT 20;
SELECT * FROM vw_request_history          LIMIT 20;
SELECT * FROM vw_service_requests         LIMIT 20;
SELECT * FROM vw_ticket_enquiry           LIMIT 20;


-- ============================================================================
-- JOINED "at a glance" queries — most useful for a live demo
-- ============================================================================

-- Every partner company with its users and a booking count
SELECT
    p.company_name, p.company_code, p.status,
    pu.full_name AS user_name, pu.email, pu.status AS user_status,
    (SELECT count(*) FROM partner_bookings pb WHERE pb.partner_id = p.partner_id) AS total_bookings
FROM partners p
JOIN partner_users pu ON pu.partner_id = p.partner_id
ORDER BY p.company_name, pu.full_name;

-- Full booking detail with passengers and current status, newest first
SELECT
    pb.reference_number, pb.status, pb.travel_type, pb.departure, pb.arrival,
    pb.departure_date, p.company_name, pu.full_name AS requested_by,
    (SELECT count(*) FROM partner_booking_passengers pp WHERE pp.booking_id = pb.booking_id) AS passenger_count
FROM partner_bookings pb
JOIN partners p ON p.partner_id = pb.partner_id
JOIN partner_users pu ON pu.partner_user_id = pb.partner_user_id
ORDER BY pb.created_at DESC
LIMIT 20;

-- Full status-change audit trail for one booking — change the reference number:
SELECT h.*, pb.reference_number
FROM partner_booking_status_history h
JOIN partner_bookings pb ON pb.booking_id = h.booking_id
WHERE pb.reference_number = 'AU260002'
ORDER BY h.changed_at;

-- System-wide table sanity check: is any table unexpectedly empty?
SELECT relname AS table_name, n_live_tup AS estimated_rows
FROM pg_stat_user_tables
ORDER BY n_live_tup ASC, relname;
