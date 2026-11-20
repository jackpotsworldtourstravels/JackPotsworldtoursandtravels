-- =============================================================================
-- Stage B — Least-privilege READ-ONLY role for database verification
-- =============================================================================
-- STATUS: REVIEWABLE ONLY. NOT EXECUTED by Claude.
--
-- This script is for YOUR DBA to review and run manually, as a superuser or the
-- database owner, connected to the ONE target database you choose (dev / staging
-- / production). Claude will not run it, will not create the role, and will not
-- execute any CREATE ROLE / GRANT / ALTER statement.
--
-- Purpose: create a login role that can ONLY issue SELECT statements, so Stage B
-- verification can run without any possibility of a write. It deliberately grants
-- no INSERT/UPDATE/DELETE/DDL and forces read-only transactions as defense in depth.
--
-- Choose the password OUT OF BAND (do not commit it). Supply the connection string
-- to Claude separately; it must never be stored in the repository.
--
-- Usage (example):
--   psql "<superuser connection to the TARGET db>" \
--        -v ro_role=jpw_readonly -v ro_password='<choose-strong>' -v target_db=jackpots_v2 \
--        -f docs/stage-b/00_create_readonly_role.sql
-- (Or paste the statements manually, substituting the names yourself.)
-- =============================================================================

\echo 'REVIEW BEFORE RUNNING. This creates a SELECT-only role in the current database.'

-- 1) Create the login role. No superuser, no createdb, no createrole, no inherit of
--    any privileged role. It starts with NO table privileges at all.
CREATE ROLE :"ro_role" LOGIN PASSWORD :'ro_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- 2) Allow it to connect to this database only.
GRANT CONNECT ON DATABASE :"target_db" TO :"ro_role";

-- 3) Let it see the schema(s). Add any non-public schema the app uses.
GRANT USAGE ON SCHEMA public TO :"ro_role";

-- 4) SELECT on every existing table/view, and read on sequences (for last_value).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"ro_role";
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO :"ro_role";

-- 5) Auto-grant SELECT on anything created later, so the role stays read-only
--    without re-running this. (Applies to objects created by the role that owns
--    the schema; adjust FOR ROLE if objects are created by a different owner.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO :"ro_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO :"ro_role";

-- 6) Belt-and-braces: force every transaction this role opens to be read-only.
--    With only SELECT grants it already cannot write, but this makes an accidental
--    write fail immediately with "cannot execute ... in a read-only transaction".
ALTER ROLE :"ro_role" SET default_transaction_read_only = on;

\echo 'Done. Verify with:  \du :ro_role   and   SELECT has_table_privilege(:''ro_role'', ''customers'', ''INSERT'');  -- expect f'

-- =============================================================================
-- TEARDOWN (run after Stage B is complete, to remove the role cleanly):
-- =============================================================================
--   REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM jpw_readonly;
--   REVOKE SELECT ON ALL SEQUENCES IN SCHEMA public FROM jpw_readonly;
--   REVOKE USAGE ON SCHEMA public FROM jpw_readonly;
--   REVOKE CONNECT ON DATABASE <target_db> FROM jpw_readonly;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM jpw_readonly;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON SEQUENCES FROM jpw_readonly;
--   DROP ROLE jpw_readonly;
-- =============================================================================
