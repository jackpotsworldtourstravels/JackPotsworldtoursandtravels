-- Partner Portal — 05: Service request tables (parent + type-specific children)
-- Depends on: 01_types.sql, 03_partner_tables.sql, 04_booking_tables.sql
-- References existing table: users (resolved_by)

CREATE TABLE service_requests (
    service_request_id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    service_request_number  VARCHAR(20) NOT NULL,
    booking_id               INTEGER NOT NULL REFERENCES partner_bookings (booking_id),
    partner_user_id          INTEGER NOT NULL REFERENCES partner_users (partner_user_id),
    request_type             service_request_type_enum NOT NULL,
    status                   service_request_status_enum NOT NULL DEFAULT 'submitted',
    reason                   TEXT,
    resolved_by              INTEGER REFERENCES users (id),
    resolved_at              TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_service_requests_number UNIQUE (service_request_number)
);

CREATE INDEX idx_service_requests_booking_id ON service_requests (booking_id);
CREATE INDEX idx_service_requests_partner_user_id ON service_requests (partner_user_id);
CREATE INDEX idx_service_requests_status ON service_requests (status);

-- One parent row per request type, PK = FK to keep it a strict 1:1 extension
-- of service_requests rather than a nullable column pile-up on the parent.

CREATE TABLE cancellation_requests (
    service_request_id  INTEGER PRIMARY KEY REFERENCES service_requests (service_request_id) ON DELETE CASCADE
);

CREATE TABLE cancellation_request_passengers (
    service_request_id  INTEGER NOT NULL REFERENCES cancellation_requests (service_request_id) ON DELETE CASCADE,
    passenger_id         INTEGER NOT NULL REFERENCES partner_booking_passengers (passenger_id),
    PRIMARY KEY (service_request_id, passenger_id)
);

CREATE TABLE date_change_requests (
    service_request_id  INTEGER PRIMARY KEY REFERENCES service_requests (service_request_id) ON DELETE CASCADE,
    passenger_id          INTEGER NOT NULL REFERENCES partner_booking_passengers (passenger_id),
    old_travel_date        DATE NOT NULL,
    new_travel_date         DATE NOT NULL,
    CONSTRAINT ck_date_change_requests_dates_differ CHECK (old_travel_date <> new_travel_date)
);

-- payment_id FK is added in 06_payment_report_notification_audit_tables.sql,
-- once partner_payments exists — see that file for the ALTER TABLE.
CREATE TABLE refund_requests (
    service_request_id  INTEGER PRIMARY KEY REFERENCES service_requests (service_request_id) ON DELETE CASCADE,
    amount_requested      NUMERIC(10, 2) NOT NULL,
    payment_id             INTEGER,
    CONSTRAINT ck_refund_requests_amount_positive CHECK (amount_requested > 0)
);

-- Named in the Service Request tabs but not called out as its own table in
-- the original table list — added here for symmetry with the other three
-- request types, so passenger-detail edits get the same audit-friendly shape.
CREATE TABLE passenger_modification_requests (
    service_request_id  INTEGER PRIMARY KEY REFERENCES service_requests (service_request_id) ON DELETE CASCADE,
    passenger_id          INTEGER NOT NULL REFERENCES partner_booking_passengers (passenger_id),
    field_changed          VARCHAR(60) NOT NULL,
    old_value               VARCHAR(255),
    new_value                VARCHAR(255)
);
