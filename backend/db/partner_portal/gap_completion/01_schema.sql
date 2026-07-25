-- Partner Portal — Gap completion — 01: Schema (bare tables, no constraints)
-- ADDITIVE ONLY. Depends on the Phase 2 schema already applied
-- (../01_types.sql .. ../14_seed_reference_data.sql) — does not modify,
-- drop, or recreate anything from that phase. Primary/foreign keys, uniques,
-- and checks are added separately in 02_constraints.sql.
--
-- Two new tables: structured, queryable status-transition history for
-- bookings and service requests. partner_audit_logs (Phase 2) already
-- records these transitions as free-text descriptions; these tables add a
-- typed old_status/new_status shape a future "status timeline" UI can query
-- directly instead of parsing audit-log text.

CREATE TABLE partner_booking_status_history (
    history_id                  INTEGER GENERATED ALWAYS AS IDENTITY,
    booking_id                  INTEGER NOT NULL,
    old_status                  booking_status_enum,
    new_status                  booking_status_enum NOT NULL,
    changed_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    changed_by_admin_id         INTEGER,
    changed_by_partner_user_id  INTEGER
);

CREATE TABLE service_request_status_history (
    history_id                  INTEGER GENERATED ALWAYS AS IDENTITY,
    service_request_id          INTEGER NOT NULL,
    old_status                  service_request_status_enum,
    new_status                  service_request_status_enum NOT NULL,
    changed_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    changed_by_admin_id         INTEGER,
    changed_by_partner_user_id  INTEGER
);
