# Database Review Package — pgAdmin 4

Prepared for project-demonstration review of the live PostgreSQL 17 database
behind JackPots World Tours & Travels (core platform + Partner Portal).

## How to use

1. Open pgAdmin 4, connect to the `jackpotsworldtours` database (PostgreSQL 17).
2. Right-click the database → **Query Tool**.
3. **File → Open** and load `DATABASE_REVIEW.sql` for catalog/structure
   inspection, or `SAMPLE_QUERIES.sql` to look at real data.
4. Click into any single statement and press **F5** to run just that one —
   you don't need to run the whole file. Each section is self-contained and
   commented.

You can also browse everything visually in pgAdmin's left-hand object tree:
`Servers → your server → Databases → jackpotsworldtours → Schemas → public →`
then expand **Tables**, **Views**, **Functions**, **Procedures**, **Sequences**.

> **One thing to expect during your demo:** the **Procedures** node in that
> tree will be empty. Every routine in this database — including the ones
> named `sp_something` following the "stored procedure" naming convention
> from the design spec — is implemented as a PostgreSQL `FUNCTION` (called
> with `SELECT sp_xxx(...)`), not a native `PROCEDURE` object (which would
> need `CALL` and doesn't return a value the same way). This was a
> deliberate, consistent choice across the whole schema, not a gap — you'll
> find all 33 of them under **Functions** instead.

## Live object inventory (verified against the running database)

| Object type | Count |
|---|---|
| Tables | 41 |
| Views | 5 |
| Functions (incl. `sp_`/`fn_` convention) | 33 |
| Triggers | 12 |
| Sequences / identity columns | 20 |
| Primary keys | 44 |
| Foreign keys | 50 |
| Check constraints | 11 |
| Unique constraints | 17 |
| Indexes | 92 |
| Enum (custom) types | 12 |

Every object required by the original design spec (18+ stored procedures,
status-history triggers, reference-number-generation triggers, the ticket
enquiry / service request views, etc.) already exists and is applied — this
review found nothing missing to create.

### Partner Portal tables (11)
`partners`, `partner_users`, `partner_bookings`, `partner_booking_passengers`,
`partner_booking_status_history`, `service_requests`,
`service_request_status_history`, `partner_otp_requests`,
`partner_notifications`, `partner_payments`, `partner_audit_logs`

### Partner Portal views (5)
`vw_partner_dashboard_stats`, `vw_reports_summary`, `vw_request_history`,
`vw_service_requests`, `vw_ticket_enquiry`

### Partner Portal functions (25, `sp_` prefix — callable business logic)
`sp_register_partner`, `sp_partner_login_lookup`, `sp_request_otp`,
`sp_verify_otp`, `sp_partner_record_login`, `sp_update_partner_profile`,
`sp_get_dashboard_statistics`, `sp_get_ticket_enquiry`,
`sp_create_ticket_request`, `sp_add_passenger`,
`sp_generate_booking_reference`, `sp_submit_request_for_approval`,
`sp_approve_request`, `sp_reject_request`, `sp_complete_booking`,
`sp_admin_list_partner_bookings`, `sp_get_request_history`,
`sp_create_date_change_request`, `sp_create_refund_request`,
`sp_create_passenger_modification_request`,
`sp_cancel_selected_passengers`, `sp_generate_service_request_number`,
`sp_resolve_service_request`, `sp_generate_report`, `sp_audit_log_entry`

### Trigger functions (8, `fn_` prefix — fire automatically, never called directly)
`fn_set_updated_at`, `fn_audit_partner_bookings`, `fn_audit_partner_users`,
`fn_audit_service_requests`, `fn_track_booking_status_history`,
`fn_track_service_request_status_history`,
`fn_auto_generate_booking_reference`,
`fn_auto_generate_service_request_number`

### Triggers (12)
| Table | Trigger | Fires on |
|---|---|---|
| `partners` | `trg_partners_updated_at` | BEFORE UPDATE |
| `partner_users` | `trg_partner_users_updated_at` | BEFORE UPDATE |
| `partner_users` | `trg_audit_partner_users` | AFTER INSERT/UPDATE |
| `partner_bookings` | `trg_partner_bookings_updated_at` | BEFORE UPDATE |
| `partner_bookings` | `trg_audit_partner_bookings` | AFTER INSERT/UPDATE |
| `partner_bookings` | `trg_track_booking_status_history` | AFTER INSERT/UPDATE |
| `partner_bookings` | `trg_auto_generate_booking_reference` | BEFORE INSERT |
| `partner_booking_passengers` | `trg_partner_booking_passengers_updated_at` | BEFORE UPDATE |
| `service_requests` | `trg_service_requests_updated_at` | BEFORE UPDATE |
| `service_requests` | `trg_audit_service_requests` | AFTER INSERT/UPDATE |
| `service_requests` | `trg_track_service_request_status_history` | AFTER INSERT/UPDATE |
| `service_requests` | `trg_auto_generate_service_request_number` | BEFORE INSERT |

## Files in this folder

- **`DATABASE_REVIEW.sql`** — catalog inspection: tables, columns, PKs, FKs,
  constraints, indexes, sequences, views, functions, triggers, plus an
  object-count sanity check.
- **`SAMPLE_QUERIES.sql`** — one `SELECT` per table (grouped by domain) to
  verify real data, plus a few joined "at a glance" queries useful for a
  live demo (partner + bookings overview, full audit trail for one booking).
- This `README.md`.

## Source of truth for the schema itself

These queries only *inspect* the already-applied database. The actual
`CREATE TABLE` / `CREATE FUNCTION` / `CREATE TRIGGER` SQL that built it lives
in `backend/db/partner_portal/` (three layers: base schema, gap-completion,
back-office) and is tracked by Alembic migrations `0015`–`0017` in
`backend/alembic/versions/`. See the root `README.md` for the full migration
history table.
