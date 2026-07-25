-- Partner Portal — Back Office — run all scripts.
-- Usage: psql "$DATABASE_URL" -f 00_run_all.sql   (run from this directory)
-- Requires Phase 2 (../*.sql) and gap_completion (../gap_completion/*.sql) already applied.

BEGIN;

\i 01_stored_procedures.sql

COMMIT;
