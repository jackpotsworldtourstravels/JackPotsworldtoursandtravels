-- Partner Portal — run all scripts in dependency order.
-- Usage: psql "$DATABASE_URL" -f 00_run_all.sql   (run from this directory)
-- Wrapped in a single transaction: if anything fails, nothing is applied.

BEGIN;

\i 01_types.sql
\i 02_reference_tables.sql
\i 03_partner_tables.sql
\i 04_booking_tables.sql
\i 05_service_request_tables.sql
\i 06_payment_report_notification_audit_tables.sql
\i 07_sequences.sql
\i 08_views.sql
\i 09_triggers.sql
\i 10_stored_procedures_auth_and_reference.sql
\i 11_stored_procedures_booking_workflow.sql
\i 12_stored_procedures_service_requests.sql
\i 13_stored_procedures_reporting.sql
\i 14_seed_reference_data.sql

COMMIT;
