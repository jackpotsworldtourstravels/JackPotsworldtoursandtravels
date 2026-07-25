-- Partner Portal — Gap completion — run all scripts in dependency order.
-- Usage: psql "$DATABASE_URL" -f 00_run_all.sql   (run from this directory)
-- Requires the Phase 2 scripts (../01_types.sql .. ../14_seed_reference_data.sql)
-- to already be applied. Wrapped in one transaction: if anything fails,
-- nothing here is applied.

BEGIN;

\i 01_schema.sql
\i 02_constraints.sql
\i 03_indexes.sql
\i 04_functions.sql
\i 05_stored_procedures.sql
\i 06_triggers.sql
\i 07_views.sql
\i 08_seed_data.sql

COMMIT;
