-- Partner Portal — Gap completion — 02: Constraints
-- Depends on: 01_schema.sql (this file's tables) + the Phase 2 tables these reference.

-- ---------- partner_booking_status_history ----------
ALTER TABLE partner_booking_status_history
    ADD CONSTRAINT pk_partner_booking_status_history PRIMARY KEY (history_id);

ALTER TABLE partner_booking_status_history
    ADD CONSTRAINT fk_pbsh_booking_id
    FOREIGN KEY (booking_id) REFERENCES partner_bookings (booking_id) ON DELETE CASCADE;

ALTER TABLE partner_booking_status_history
    ADD CONSTRAINT fk_pbsh_changed_by_admin_id
    FOREIGN KEY (changed_by_admin_id) REFERENCES users (id);

ALTER TABLE partner_booking_status_history
    ADD CONSTRAINT fk_pbsh_changed_by_partner_user_id
    FOREIGN KEY (changed_by_partner_user_id) REFERENCES partner_users (partner_user_id);

ALTER TABLE partner_booking_status_history
    ADD CONSTRAINT ck_pbsh_status_actually_changed
    CHECK (old_status IS NULL OR old_status <> new_status);

-- ---------- service_request_status_history ----------
ALTER TABLE service_request_status_history
    ADD CONSTRAINT pk_service_request_status_history PRIMARY KEY (history_id);

ALTER TABLE service_request_status_history
    ADD CONSTRAINT fk_srsh_service_request_id
    FOREIGN KEY (service_request_id) REFERENCES service_requests (service_request_id) ON DELETE CASCADE;

ALTER TABLE service_request_status_history
    ADD CONSTRAINT fk_srsh_changed_by_admin_id
    FOREIGN KEY (changed_by_admin_id) REFERENCES users (id);

ALTER TABLE service_request_status_history
    ADD CONSTRAINT fk_srsh_changed_by_partner_user_id
    FOREIGN KEY (changed_by_partner_user_id) REFERENCES partner_users (partner_user_id);

ALTER TABLE service_request_status_history
    ADD CONSTRAINT ck_srsh_status_actually_changed
    CHECK (old_status IS NULL OR old_status <> new_status);
