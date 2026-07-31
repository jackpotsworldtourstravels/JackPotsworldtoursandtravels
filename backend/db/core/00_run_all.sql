-- Core schema hardening — run all scripts in order.
-- Usage: psql "$DATABASE_URL" -f 00_run_all.sql   (run from this directory)
-- Wrapped in a single transaction: if anything fails, nothing is applied.
--
-- Prerequisites: the existing core schema must already be migrated
-- (alembic upgrade head through 0022) — these scripts assume users,
-- bookings, payments, flights, hotels, cruises, tour_packages already exist.

BEGIN;

\i 01_triggers.sql
\i 02_indexes.sql
\i 03_views.sql

COMMIT;
