-- Core schema — missing indexes
--
-- Migrations 0006/0009 already cover FK, status, and type columns well
-- (ix_bookings_user_id, ix_bookings_status, ix_payments_booking_id,
-- ix_payments_user_id, ix_activity_logs_activity_type, etc.) — verified by
-- reading those migrations before writing this file, so nothing below
-- duplicates an existing index.
--
-- What's missing: every date-range/report query in
-- backend/app/services/admin_service.py (build_reports, today_revenue,
-- today_bookings, today_users) filters or orders by created_at with no
-- supporting index — verified directly against that file's query code.

CREATE INDEX IF NOT EXISTS ix_bookings_created_at ON bookings (created_at);
CREATE INDEX IF NOT EXISTS ix_payments_created_at ON payments (created_at);
CREATE INDEX IF NOT EXISTS ix_users_created_at ON users (created_at);

-- Composite index matching admin_service.build_reports' exact filter pattern:
-- WHERE status = 'success' AND created_at >= [today's start] (total/today revenue).
CREATE INDEX IF NOT EXISTS ix_payments_status_created_at ON payments (status, created_at);
