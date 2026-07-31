-- Core schema — reporting/dashboard views
--
-- Named after the template's requested vw_daily_sales / vw_customer_bookings /
-- vw_dashboard_statistics. Every column/filter below is taken directly from
-- the real, already-shipping queries in backend/app/services/admin_service.py
-- (build_reports, _top_items, list_all_bookings) — these views make those
-- queries reusable from plain SQL/pgAdmin, they don't invent new metrics.

CREATE OR REPLACE VIEW vw_daily_sales AS
SELECT
    DATE(p.created_at) AS sale_date,
    COUNT(*) AS payments_count,
    COUNT(DISTINCT p.booking_id) AS bookings_paid,
    COALESCE(SUM(p.amount), 0) AS total_revenue
FROM payments p
WHERE p.status = 'success'
GROUP BY DATE(p.created_at)
ORDER BY sale_date DESC;

CREATE OR REPLACE VIEW vw_customer_bookings AS
SELECT
    u.id AS user_id,
    u.full_name,
    u.email,
    b.id AS booking_id,
    b.booking_type,
    b.item_id,
    b.status,
    b.total_price,
    b.quantity,
    b.travel_date,
    b.coupon_code,
    b.created_at AS booked_at
FROM bookings b
JOIN users u ON u.id = b.user_id
ORDER BY b.created_at DESC;

CREATE OR REPLACE VIEW vw_dashboard_statistics AS
SELECT
    (SELECT COUNT(*) FROM users) AS total_users,
    (SELECT COUNT(*) FROM users WHERE is_active) AS active_users,
    (SELECT COUNT(*) FROM bookings) AS total_bookings,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'success') AS total_revenue,
    (SELECT COUNT(*) FROM bookings WHERE status = 'pending') AS pending_bookings,
    (SELECT COUNT(*) FROM bookings WHERE status = 'confirmed') AS confirmed_bookings,
    (SELECT COUNT(*) FROM bookings WHERE status = 'completed') AS completed_bookings,
    (SELECT COUNT(*) FROM bookings WHERE status = 'cancelled') AS cancelled_bookings,
    (SELECT COUNT(*) FROM flights) AS total_flights,
    (SELECT COUNT(*) FROM hotels) AS total_hotels,
    (SELECT COUNT(*) FROM cruises) AS total_cruises,
    (SELECT COUNT(*) FROM tour_packages) AS total_packages,
    (SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE) AS today_new_users,
    (SELECT COUNT(*) FROM bookings WHERE created_at >= CURRENT_DATE) AS today_bookings,
    (SELECT COALESCE(SUM(amount), 0) FROM payments
        WHERE status = 'success' AND created_at >= CURRENT_DATE) AS today_revenue;
