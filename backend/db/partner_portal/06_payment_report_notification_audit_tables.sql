-- Partner Portal — 06: Payments, reporting, notifications, audit
-- Depends on: 01_types.sql, 03_partner_tables.sql, 04_booking_tables.sql, 05_service_request_tables.sql

CREATE TABLE partner_payments (
    payment_id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id        INTEGER NOT NULL REFERENCES partner_bookings (booking_id),
    amount            NUMERIC(10, 2) NOT NULL,
    method            VARCHAR(30) NOT NULL DEFAULT 'invoice',
    status            VARCHAR(30) NOT NULL DEFAULT 'success',
    transaction_ref   VARCHAR(100) NOT NULL,
    refunded_at       TIMESTAMPTZ,
    refund_reference  VARCHAR(100),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_partner_payments_transaction_ref UNIQUE (transaction_ref),
    CONSTRAINT ck_partner_payments_status CHECK (status IN ('success', 'failed', 'refunded', 'pending'))
);

CREATE INDEX idx_partner_payments_booking_id ON partner_payments (booking_id);

-- Completes the forward reference left open in 05_service_request_tables.sql —
-- refund_requests.payment_id couldn't point at partner_payments before this
-- table existed.
ALTER TABLE refund_requests
    ADD CONSTRAINT fk_refund_requests_payment_id
    FOREIGN KEY (payment_id) REFERENCES partner_payments (payment_id);

-- Report *data* is computed live via the views in 08_views.sql — this table
-- is only the generation audit trail (who ran what filters, when, in what
-- format), never a duplicate copy of report contents.
CREATE TABLE report_generation_log (
    report_id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_id        INTEGER NOT NULL REFERENCES partners (partner_id),
    partner_user_id   INTEGER NOT NULL REFERENCES partner_users (partner_user_id),
    filters           JSONB NOT NULL DEFAULT '{}'::jsonb,
    export_format     export_format_enum NOT NULL,
    generated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_report_generation_log_partner_id ON report_generation_log (partner_id);

CREATE TABLE partner_notifications (
    notification_id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_user_id   INTEGER NOT NULL REFERENCES partner_users (partner_user_id) ON DELETE CASCADE,
    title             VARCHAR(200) NOT NULL,
    message           VARCHAR(2000) NOT NULL,
    is_read           BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_partner_notifications_user_id ON partner_notifications (partner_user_id, is_read);

-- Populated automatically by the triggers in 09_triggers.sql, not just
-- app-level inserts — so login attempts, status changes, etc. are captured
-- even if a future code path forgets to log them explicitly.
CREATE TABLE partner_audit_logs (
    audit_id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    partner_id        INTEGER REFERENCES partners (partner_id),
    partner_user_id   INTEGER REFERENCES partner_users (partner_user_id) ON DELETE SET NULL,
    action            VARCHAR(100) NOT NULL,
    entity_type       VARCHAR(50),
    entity_id         INTEGER,
    description       TEXT,
    ip_address        VARCHAR(50),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_partner_audit_logs_partner_id ON partner_audit_logs (partner_id, created_at);
