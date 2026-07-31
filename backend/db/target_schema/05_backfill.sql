-- Target 9-table schema — data backfill (FIRST DRAFT, NOT YET RUN)
--
-- See docs/DATA_MIGRATION_STRATEGY_9TABLE.md for the full strategy, phase
-- order, and the one open "-- VERIFY:" item below that must be confirmed
-- against the live database before this is trusted against real data.
-- Run only against a restored COPY of production first.
--
-- Idempotent via natural-key ON CONFLICT / NOT EXISTS guards — safe to
-- re-run after fixing a mapping issue.

BEGIN;

-- ============================================================
-- Phase 2.1 — ts_merchants <- partners
-- ============================================================
-- company_type/contact_person/address/city/state/country/gst_number/pan_number
-- aren't on the Partner SQLAlchemy model but are real live `partners` columns
-- (confirmed via admin_merchant_service.py's raw-SQL INSERT) — pulled here.
INSERT INTO ts_merchants (company_code, reference_prefix, company_name, company_type, contact_person,
                           email, phone_number, address, city, state, country, gst_number, pan_number,
                           status, created_at, updated_at)
SELECT p.company_code, p.reference_prefix, p.company_name, p.company_type, p.contact_person,
       p.email, p.phone_number, p.address, p.city, p.state, p.country, p.gst_number, p.pan_number,
       p.status, p.created_at, p.updated_at
FROM partners p
ON CONFLICT (company_code) DO NOTHING;

-- ============================================================
-- Phase 2.2a — ts_users <- users (customer/admin/super_admin)
-- ============================================================
-- VERIFY: role -> user_type mapping below is a pattern guess. Confirm actual
-- seeded role names with `SELECT name FROM roles;` and adjust the CASE if
-- they don't match. super_admin has no legacy source (mock store today, per
-- DATABASE_REVIEW_2026.md) — no rows will match that branch until a real
-- super_admin table/flag exists to migrate from.
INSERT INTO ts_users (user_type, email, phone_number, hashed_password, full_name, gender, dob,
                       country, state, city, address, reset_token_hash, reset_token_expires_at,
                       status, is_verified, force_logout_at, created_at, updated_at)
SELECT
    CASE
        WHEN r.name ILIKE '%super%admin%' THEN 'super_admin'
        WHEN r.name ILIKE '%admin%' THEN 'admin'
        ELSE 'customer'
    END,
    u.email, u.mobile, u.hashed_password,
    COALESCE(u.full_name, TRIM(CONCAT(u.first_name, ' ', u.last_name))),
    u.gender, u.dob, u.country, u.state, u.city, u.address,
    u.reset_token_hash, u.reset_token_expires_at,
    CASE
        WHEN u.is_deleted THEN 'deleted'
        WHEN u.is_blocked THEN 'blocked'
        WHEN NOT u.is_active THEN 'inactive'
        ELSE 'active'
    END,
    u.is_verified, u.force_logout_at, u.created_at, u.updated_at
FROM users u
JOIN roles r ON r.id = u.role_id
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- Phase 2.2b — ts_users <- partner_users (merchant_staff)
-- ============================================================
-- VERIFY: a customer/admin and a merchant staff member sharing the same
-- email would collide on ts_users' single global UNIQUE(email) constraint.
-- Legacy users.email and partner_users.email are uniquely constrained
-- independently today, so cross-table collisions are possible. Run
-- `SELECT email FROM users INTERSECT SELECT email FROM partner_users;`
-- before this step and resolve any hits manually.
INSERT INTO ts_users (user_type, merchant_id, role_type, member_role, username, email, phone_number,
                       hashed_password, full_name, status, created_at, updated_at)
SELECT 'merchant_staff', m.id, pu.role_type, pu.member_role, pu.username, pu.email, pu.phone_number,
       COALESCE(pu.password_hash, ''), pu.full_name,
       CASE pu.status WHEN 'blocked' THEN 'blocked' WHEN 'inactive' THEN 'inactive' ELSE 'active' END,
       pu.created_at, pu.updated_at
FROM partner_users pu
JOIN partners p ON p.partner_id = pu.partner_id
JOIN ts_merchants m ON m.company_code = p.company_code
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- Phase 2.3a — ts_service_requests <- bookings (customer channel)
-- ============================================================
INSERT INTO ts_service_requests (request_number, request_type, channel, user_id, item_type, item_id,
                                  quantity, coupon_code, total_amount, status, departure_date,
                                  created_at, updated_at)
SELECT 'BK-' || b.id, 'booking', 'customer', tu.id,
       -- legacy bookings.booking_type uses 'package'; ts_item_type_enum uses
       -- the more descriptive 'tour_package' (matches the tour_packages table name)
       (CASE b.booking_type WHEN 'package' THEN 'tour_package' ELSE b.booking_type END)::ts_item_type_enum,
       b.item_id, b.quantity, b.coupon_code, b.total_price,
       CASE b.status WHEN 'confirmed' THEN 'confirmed' WHEN 'cancelled' THEN 'cancelled' ELSE 'pending' END,
       b.travel_date, b.created_at, b.updated_at
FROM bookings b
JOIN users u ON u.id = b.user_id
JOIN ts_users tu ON tu.email = u.email
ON CONFLICT (request_number) DO NOTHING;

-- ============================================================
-- Phase 2.3b — ts_service_requests <- support_tickets (customer channel)
-- ============================================================
INSERT INTO ts_service_requests (request_number, request_type, channel, user_id, subject, description,
                                  status, priority, resolved_at, created_at, updated_at)
SELECT 'ST-' || st.id, 'support_ticket', 'customer', tu.id, st.subject, st.description,
       CASE st.status WHEN 'resolved' THEN 'resolved' WHEN 'closed' THEN 'completed' ELSE 'pending' END,
       CASE st.priority WHEN 'high' THEN 'high' WHEN 'urgent' THEN 'urgent' WHEN 'low' THEN 'low' ELSE 'medium' END,
       st.resolved_at, st.created_at, st.created_at
FROM support_tickets st
JOIN users u ON u.id = st.user_id
JOIN ts_users tu ON tu.email = u.email
ON CONFLICT (request_number) DO NOTHING;

-- ============================================================
-- Phase 2.3c — ts_service_requests <- partner_bookings (merchant channel)
-- ============================================================
INSERT INTO ts_service_requests (request_number, request_type, channel, user_id, merchant_id, item_type,
                                  item_id, trip_type, cabin_class, departure, arrival, departure_date,
                                  return_date, status, total_amount, approved_by, rejected_by,
                                  approved_at, rejected_at, rejection_reason, created_at, updated_at)
SELECT pb.reference_number, 'booking', 'merchant', tpu.id, m.id,
       pb.travel_type::ts_item_type_enum,
       COALESCE(pb.flight_id, pb.hotel_id, pb.cruise_id),
       pb.trip_type::TEXT::ts_trip_type_enum, pb.cabin_class::TEXT::ts_cabin_class_enum,
       pb.departure, pb.arrival, pb.departure_date, pb.return_date,
       CASE pb.status
           WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected'
           WHEN 'completed' THEN 'completed' WHEN 'cancelled' THEN 'cancelled'
           WHEN 'pending_approval' THEN 'pending' WHEN 'draft' THEN 'draft' ELSE 'pending'
       END,
       pb.total_amount,
       tapprover.id, trejecter.id, pb.approved_at, pb.rejected_at, pb.rejection_reason,
       pb.created_at, pb.updated_at
FROM partner_bookings pb
JOIN partner_users pu ON pu.partner_user_id = pb.partner_user_id
JOIN ts_users tpu ON tpu.email = pu.email
JOIN partners p ON p.partner_id = pb.partner_id
JOIN ts_merchants m ON m.company_code = p.company_code
LEFT JOIN users uapprover ON uapprover.id = pb.approved_by
LEFT JOIN ts_users tapprover ON tapprover.email = uapprover.email
LEFT JOIN users urejecter ON urejecter.id = pb.rejected_by
LEFT JOIN ts_users trejecter ON trejecter.email = urejecter.email
ON CONFLICT (request_number) DO NOTHING;

-- ============================================================
-- Phase 2.3d — ts_service_requests <- service_requests + 4 subtypes (merchant channel)
-- parent_request_id resolved via the originating partner_bookings.reference_number.
-- ============================================================
INSERT INTO ts_service_requests (request_number, request_type, channel, user_id, merchant_id,
                                  parent_request_id, status, reason, resolved_by, resolved_at,
                                  details, created_at, updated_at)
SELECT
    sr.service_request_number, sr.request_type::TEXT::ts_request_type_enum, 'merchant', tpu.id, m.id,
    tparent.id,
    CASE sr.status
        WHEN 'submitted' THEN 'pending' WHEN 'in_review' THEN 'pending'
        WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' WHEN 'completed' THEN 'completed'
        ELSE 'pending'
    END,
    sr.reason, tresolver.id, sr.resolved_at,
    jsonb_strip_nulls(jsonb_build_object(
        'passenger_ids', (
            SELECT jsonb_agg(tpd.id) FROM cancellation_request_passengers crp
            JOIN partner_booking_passengers pbp ON pbp.passenger_id = crp.passenger_id
            JOIN ts_passenger_data tpd ON tpd.service_request_id = tparent.id
                AND tpd.full_name = pbp.full_name AND tpd.passport_number = pbp.passport_number
            WHERE crp.service_request_id = sr.service_request_id
        ),
        'old_travel_date', dcr.old_travel_date, 'new_travel_date', dcr.new_travel_date,
        'amount_requested', rr.amount_requested,
        'field_changed', pmr.field_changed, 'old_value', pmr.old_value, 'new_value', pmr.new_value
    )),
    sr.created_at, sr.updated_at
FROM service_requests sr
JOIN partner_bookings pb ON pb.booking_id = sr.booking_id
JOIN ts_service_requests tparent ON tparent.request_number = pb.reference_number
JOIN partner_users pu ON pu.partner_user_id = sr.partner_user_id
JOIN ts_users tpu ON tpu.email = pu.email
JOIN partners p ON p.partner_id = pb.partner_id
JOIN ts_merchants m ON m.company_code = p.company_code
LEFT JOIN users uresolver ON uresolver.id = sr.resolved_by
LEFT JOIN ts_users tresolver ON tresolver.email = uresolver.email
LEFT JOIN date_change_requests dcr ON dcr.service_request_id = sr.service_request_id
LEFT JOIN refund_requests rr ON rr.service_request_id = sr.service_request_id
LEFT JOIN passenger_modification_requests pmr ON pmr.service_request_id = sr.service_request_id
ON CONFLICT (request_number) DO NOTHING;

-- ============================================================
-- Phase 2.4 — ts_passenger_data <- partner_booking_passengers
-- (must run after 2.3c so the parent ts_service_requests row exists)
-- ============================================================
INSERT INTO ts_passenger_data (service_request_id, full_name, gender, passenger_type, date_of_birth,
                                passport_number, passport_issue_date, passport_expiry_date,
                                passport_issuing_country, nationality_country, meal_option,
                                special_assistance, created_at, updated_at)
SELECT tsr.id, pbp.full_name, pbp.gender::TEXT::ts_gender_enum, pbp.passenger_type::TEXT::ts_passenger_type_enum,
       pbp.date_of_birth, pbp.passport_number, pbp.passport_issue_date, pbp.passport_expiry_date,
       ci.iso2, cn.iso2,
       NULL, -- meal_preference was free text; VERIFY mapping onto the fixed ts_meal_option_enum set
       pbp.special_assistance, pbp.created_at, pbp.updated_at
FROM partner_booking_passengers pbp
JOIN partner_bookings pb ON pb.booking_id = pbp.booking_id
JOIN ts_service_requests tsr ON tsr.request_number = pb.reference_number
LEFT JOIN countries ci ON ci.country_id = pbp.passport_issuing_country_id
LEFT JOIN countries cn ON cn.country_id = pbp.nationality_country_id
WHERE NOT EXISTS (
    SELECT 1 FROM ts_passenger_data tpd
    WHERE tpd.service_request_id = tsr.id AND tpd.passport_number = pbp.passport_number
);

-- ============================================================
-- Phase 2.5 — ts_payments <- payments, partner_payments, discount_campaigns, coupons
-- ============================================================
INSERT INTO ts_payments (record_type, service_request_id, user_id, amount, method, status,
                          transaction_ref, refund_reference, refunded_at, created_at, updated_at)
SELECT 'transaction', tsr.id, tu.id, pay.amount, pay.method, pay.status::TEXT::ts_payment_status_enum,
       pay.transaction_ref, pay.refund_reference, pay.refunded_at, pay.created_at, pay.created_at
FROM payments pay
JOIN bookings b ON b.id = pay.booking_id
JOIN ts_service_requests tsr ON tsr.request_number = 'BK-' || b.id
JOIN users u ON u.id = pay.user_id
JOIN ts_users tu ON tu.email = u.email
WHERE NOT EXISTS (SELECT 1 FROM ts_payments tp WHERE tp.transaction_ref = pay.transaction_ref);

INSERT INTO ts_payments (record_type, service_request_id, merchant_id, amount, method, status,
                          transaction_ref, refund_reference, refunded_at, created_at, updated_at)
SELECT 'transaction', tsr.id, m.id, pp.amount, pp.method, pp.status::TEXT::ts_payment_status_enum,
       pp.transaction_ref, pp.refund_reference, pp.refunded_at, pp.created_at, pp.created_at
FROM partner_payments pp
JOIN partner_bookings pb ON pb.booking_id = pp.booking_id
JOIN ts_service_requests tsr ON tsr.request_number = pb.reference_number
JOIN partners p ON p.partner_id = pb.partner_id
JOIN ts_merchants m ON m.company_code = p.company_code
WHERE NOT EXISTS (SELECT 1 FROM ts_payments tp WHERE tp.transaction_ref = pp.transaction_ref);

-- 'package' -> 'tour_package' mapping, same reasoning as the bookings insert above.
INSERT INTO ts_payments (record_type, code, discount_type, discount_value, applicable_item_type,
                          valid_from, valid_until, is_active, created_at, updated_at)
SELECT 'discount_campaign', 'CAMPAIGN-' || dc.id, dc.discount_type::ts_discount_type_enum, dc.discount_value,
       (CASE dc.applicable_type WHEN 'package' THEN 'tour_package' ELSE dc.applicable_type END)::ts_item_type_enum,
       dc.start_date, dc.end_date, dc.is_active, dc.created_at, dc.created_at
FROM discount_campaigns dc
ON CONFLICT (code) DO NOTHING;

INSERT INTO ts_payments (record_type, code, discount_type, discount_value, applicable_item_type,
                          min_order_amount, usage_limit, used_count, valid_from, valid_until, is_active,
                          created_at, updated_at)
SELECT 'coupon', c.code, c.discount_type::ts_discount_type_enum, c.discount_value,
       (CASE c.applicable_type WHEN 'package' THEN 'tour_package' ELSE c.applicable_type END)::ts_item_type_enum,
       c.min_booking_amount, c.usage_limit, c.times_used, c.valid_from, c.valid_until, c.is_active,
       c.created_at, c.created_at
FROM coupons c
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- Phase 2.6 — ts_communication_settings (no legacy source, seed defaults)
-- ============================================================
INSERT INTO ts_communication_settings (user_id, created_at, updated_at)
SELECT tu.id, now(), now() FROM ts_users tu
WHERE NOT EXISTS (SELECT 1 FROM ts_communication_settings cs WHERE cs.user_id = tu.id);

INSERT INTO ts_communication_settings (merchant_id, created_at, updated_at)
SELECT tm.id, now(), now() FROM ts_merchants tm
WHERE NOT EXISTS (SELECT 1 FROM ts_communication_settings cs WHERE cs.merchant_id = tm.id);

-- ============================================================
-- Phase 2.7 — ts_msg_logs <- notifications, partner_notifications, contact_us, newsletter
-- ============================================================
INSERT INTO ts_msg_logs (channel, direction, user_id, subject, message, is_read, created_at)
SELECT 'notification', 'outbound', tu.id, n.title, n.message, n.is_read, n.created_at
FROM notifications n
JOIN users u ON u.id = n.user_id
JOIN ts_users tu ON tu.email = u.email;

-- user_id (the specific staff member), not merchant_id (the whole company):
-- legacy partner_notifications.partner_user_id targets one staff member, not
-- the merchant broadly — using merchant_id here would have silently made
-- every staff member's notifications visible to every other staff member.
INSERT INTO ts_msg_logs (channel, direction, user_id, subject, message, is_read, created_at)
SELECT 'notification', 'outbound', tpu.id, pn.title, pn.message, pn.is_read, pn.created_at
FROM partner_notifications pn
JOIN partner_users pu ON pu.partner_user_id = pn.partner_user_id
JOIN ts_users tpu ON tpu.email = pu.email;

INSERT INTO ts_msg_logs (channel, direction, recipient_email, subject, message, created_at)
SELECT 'contact_form', 'inbound', cu.email, cu.subject, cu.message, cu.created_at
FROM contact_us cu;

INSERT INTO ts_msg_logs (channel, direction, recipient_email, created_at)
SELECT 'newsletter', 'inbound', nl.email, nl.subscribed_at
FROM newsletter nl;

-- ============================================================
-- Phase 2.8 — ts_system_logs <- activity_logs, user_sessions, report_generation_log
-- ============================================================
INSERT INTO ts_system_logs (log_type, user_id, event, ip_address, activity_type, module, status, entity_id, created_at)
SELECT 'activity', tu.id, COALESCE(al.description, al.action), al.ip_address, al.action, al.module,
       COALESCE(al.status, 'success'), al.reference_id, al.created_at
FROM activity_logs al
LEFT JOIN users u ON u.id = al.user_id
LEFT JOIN ts_users tu ON tu.email = u.email;

INSERT INTO ts_system_logs (log_type, user_id, ip_address, logged_out_at, last_seen_at, log_metadata, created_at)
SELECT 'session', tu.id, us.ip_address, us.logout_at, us.last_seen_at,
       jsonb_build_object('current_page', us.current_page, 'browser', us.browser, 'os', us.os, 'device', us.device),
       us.login_at
FROM user_sessions us
JOIN users u ON u.id = us.user_id
JOIN ts_users tu ON tu.email = u.email;

INSERT INTO ts_system_logs (log_type, user_id, log_metadata, created_at)
SELECT 'report_generation', tpu.id, jsonb_build_object('filters', rgl.filters, 'export_format', rgl.export_format),
       rgl.generated_at
FROM report_generation_log rgl
JOIN partner_users pu ON pu.partner_user_id = rgl.partner_user_id
JOIN ts_users tpu ON tpu.email = pu.email;

-- ============================================================
-- Phase 2.9 — ts_audit_logs <- partner_audit_logs
-- ============================================================
INSERT INTO ts_audit_logs (entity_type, entity_id, action, changed_by, old_data, created_at)
SELECT COALESCE(pal.entity_type, 'unknown'), COALESCE(pal.entity_id, 0), 'update', tpu.id,
       jsonb_build_object('action', pal.action, 'description', pal.description, 'ip_address', pal.ip_address),
       pal.created_at
FROM partner_audit_logs pal
LEFT JOIN partner_users pu ON pu.partner_user_id = pal.partner_user_id
LEFT JOIN ts_users tpu ON tpu.email = pu.email;

-- ============================================================
-- Phase 2.10 — catalog seasonal_pricing <- seasonal_prices
-- ============================================================
UPDATE flights f SET seasonal_pricing = agg.pricing
FROM (
    SELECT item_id, jsonb_agg(jsonb_build_object(
        'start_date', start_date, 'end_date', end_date, 'override_price', override_price, 'label', label
    )) AS pricing
    FROM seasonal_prices WHERE item_type = 'flight' AND is_active GROUP BY item_id
) agg WHERE agg.item_id = f.id;

UPDATE hotels h SET seasonal_pricing = agg.pricing
FROM (
    SELECT item_id, jsonb_agg(jsonb_build_object(
        'start_date', start_date, 'end_date', end_date, 'override_price', override_price, 'label', label
    )) AS pricing
    FROM seasonal_prices WHERE item_type = 'hotel' AND is_active GROUP BY item_id
) agg WHERE agg.item_id = h.id;

UPDATE cruises c SET seasonal_pricing = agg.pricing
FROM (
    SELECT item_id, jsonb_agg(jsonb_build_object(
        'start_date', start_date, 'end_date', end_date, 'override_price', override_price, 'label', label
    )) AS pricing
    FROM seasonal_prices WHERE item_type = 'cruise' AND is_active GROUP BY item_id
) agg WHERE agg.item_id = c.id;

UPDATE tour_packages tp SET seasonal_pricing = agg.pricing
FROM (
    SELECT item_id, jsonb_agg(jsonb_build_object(
        'start_date', start_date, 'end_date', end_date, 'override_price', override_price, 'label', label
    )) AS pricing
    FROM seasonal_prices WHERE item_type = 'package' AND is_active GROUP BY item_id
) agg WHERE agg.item_id = tp.id;

COMMIT;

-- reviews and wishlist are intentionally not migrated — see
-- DATABASE_REDESIGN_9TABLE.md §1 ("What changed from the previous draft").
