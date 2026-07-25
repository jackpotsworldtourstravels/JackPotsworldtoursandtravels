-- Partner Portal — Gap completion — 03: Indexes
-- Depends on: 01_schema.sql, 02_constraints.sql

CREATE INDEX idx_pbsh_booking_id ON partner_booking_status_history (booking_id, changed_at);
CREATE INDEX idx_srsh_service_request_id ON service_request_status_history (service_request_id, changed_at);
