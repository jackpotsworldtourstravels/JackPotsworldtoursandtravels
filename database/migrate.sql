-- =========================================================================
-- migrate.sql
-- =========================================================================
-- Master script for the v2 fully-domain-separated schema (no table is
-- shared for authentication, profile, session, or activity data across
-- Admin / Merchant / User). Runs every file in this folder in the correct
-- dependency order: types first, then tables (shared before the domains
-- that reference it -- Admin before Merchant, since Merchant's
-- approved_by/rejected_by/resolved_by FKs point at admins(id)), then
-- indexes/constraints, then views/functions/procedures/triggers (which
-- reference the tables), then the empty seed file last.
--
-- This script is NOT applied automatically by this project. Run it
-- yourself, deliberately, against a target database:
--   psql -U postgres -d <target_database> -f migrate.sql
--
-- Do not run this against the live `jackpotsworldtours` database unless
-- you have already decided to cut over to this redesigned schema -- see
-- DATABASE_STRUCTURE.md for the full picture and migration considerations
-- first.
-- =========================================================================

\i 01_types.sql
\i 02_shared_tables.sql
\i 03_admin_tables.sql
\i 04_partner_tables.sql
\i 05_user_tables.sql
\i 06_indexes.sql
\i 07_constraints.sql
\i 08_views.sql
\i 09_functions.sql
\i 10_procedures.sql
\i 11_triggers.sql
\i 12_seed.sql
