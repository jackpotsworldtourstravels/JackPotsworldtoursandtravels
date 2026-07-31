-- Target 9-table schema — supplementary indexes
-- (PK/UNIQUE indexes and a few high-traffic ones are already created inline
-- by 02_tables.sql; this file adds the remaining query-pattern indexes.)

CREATE INDEX IF NOT EXISTS ix_ts_service_requests_type_status
    ON ts_service_requests(request_type, status);
CREATE INDEX IF NOT EXISTS ix_ts_service_requests_user
    ON ts_service_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ts_service_requests_merchant
    ON ts_service_requests(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ts_service_requests_parent
    ON ts_service_requests(parent_request_id);
CREATE INDEX IF NOT EXISTS ix_ts_service_requests_item
    ON ts_service_requests(item_type, item_id);

CREATE INDEX IF NOT EXISTS ix_ts_payments_service_request
    ON ts_payments(service_request_id);
CREATE INDEX IF NOT EXISTS ix_ts_payments_user
    ON ts_payments(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ts_payments_merchant
    ON ts_payments(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ts_payments_record_type_status
    ON ts_payments(record_type, status);

CREATE INDEX IF NOT EXISTS ix_ts_users_merchant
    ON ts_users(merchant_id);
CREATE INDEX IF NOT EXISTS ix_ts_users_user_type
    ON ts_users(user_type);

-- Online-user tracking (log_type='session', logged_out_at IS NULL, last_seen_at >= cutoff)
CREATE INDEX IF NOT EXISTS ix_ts_system_logs_session_activity
    ON ts_system_logs(user_id, last_seen_at) WHERE log_type = 'session' AND logged_out_at IS NULL;

-- Admin Activity Log screen filters by module/activity_type
CREATE INDEX IF NOT EXISTS ix_ts_system_logs_activity_module
    ON ts_system_logs(module) WHERE log_type = 'activity';
CREATE INDEX IF NOT EXISTS ix_ts_system_logs_activity_type
    ON ts_system_logs(activity_type) WHERE log_type = 'activity';
