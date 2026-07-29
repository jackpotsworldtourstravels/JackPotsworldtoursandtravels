-- =====================================================================
-- 01_drop_legacy_schema.sql
-- Drops every legacy object in the `public` schema so the nine-table
-- design can be created from a clean slate.
--
-- `alembic_version` is deliberately preserved — Alembic is mid-transaction
-- when this runs and updates that row on completion; dropping it would
-- abort the migration.
--
-- Order matters: views depend on tables, tables depend on types, and
-- trigger functions are referenced by triggers that vanish with their
-- tables. Everything is dropped CASCADE so residual dependencies from the
-- 22 legacy migrations cannot block the teardown.
-- =====================================================================

DO $$
DECLARE
    r RECORD;
BEGIN
    -- 1. Views (vw_partner_dashboard_stats, vw_reports_summary, ...)
    FOR r IN
        SELECT table_name
        FROM information_schema.views
        WHERE table_schema = 'public'
    LOOP
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.table_name);
    END LOOP;

    -- 2. Base tables, except Alembic's own bookkeeping table.
    FOR r IN
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name <> 'alembic_version'
    LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.table_name);
    END LOOP;

    -- 3. Stored procedures and trigger functions (sp_*, fn_*).
    --    Filtered to objects not owned by an extension.
    FOR r IN
        SELECT p.oid::regprocedure AS signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.objid = p.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.signature);
    END LOOP;

    -- 4. Legacy ENUM types (booking_status_enum, travel_type_enum, ...).
    FOR r IN
        SELECT t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typtype = 'e'
    LOOP
        EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
    END LOOP;
END $$;
