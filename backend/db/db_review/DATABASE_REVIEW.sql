-- ============================================================================
-- JackPots World Tours & Travels — Database Review Script
-- ============================================================================
-- Purpose : Inspect every object in the live PostgreSQL 17 database from
--           pgAdmin 4's Query Tool, for project-demonstration review.
-- How to use in pgAdmin 4:
--   1. Open pgAdmin 4 -> connect to the "jackpotsworldtours" database.
--   2. Right-click the database -> Query Tool.
--   3. Open this file (File -> Open -> DATABASE_REVIEW.sql).
--   4. Click into any one section below and press F5 (or highlight a block
--      and press F5) to run just that section. You do not need to run the
--      whole file at once — each section is independent and read-only.
-- Nothing in this file modifies data or schema. It is 100% SELECT / catalog
-- inspection queries.
-- ============================================================================


-- ============================================================================
-- SECTION 0 — Server / database identity
-- ============================================================================
SELECT version();
SELECT current_database() AS database_name, current_user AS connected_as;


-- ============================================================================
-- SECTION 1 — List all tables (with row counts and size)
-- ============================================================================
SELECT
    c.relname                                   AS table_name,
    pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
    c.reltuples::bigint                          AS approx_row_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY c.relname;

-- Exact row counts for the Partner Portal tables specifically
SELECT 'partners' AS table_name, count(*) FROM partners
UNION ALL SELECT 'partner_users', count(*) FROM partner_users
UNION ALL SELECT 'partner_bookings', count(*) FROM partner_bookings
UNION ALL SELECT 'partner_booking_passengers', count(*) FROM partner_booking_passengers
UNION ALL SELECT 'partner_booking_status_history', count(*) FROM partner_booking_status_history
UNION ALL SELECT 'service_requests', count(*) FROM service_requests
UNION ALL SELECT 'service_request_status_history', count(*) FROM service_request_status_history
UNION ALL SELECT 'partner_otp_requests', count(*) FROM partner_otp_requests
UNION ALL SELECT 'partner_notifications', count(*) FROM partner_notifications
UNION ALL SELECT 'partner_payments', count(*) FROM partner_payments
UNION ALL SELECT 'partner_audit_logs', count(*) FROM partner_audit_logs
ORDER BY 1;


-- ============================================================================
-- SECTION 2 — Describe the structure of every table (data dictionary)
-- ============================================================================
-- One row per column, across the whole database. Filter this by table_name
-- in pgAdmin's results grid, or copy the WHERE clause below for a single table.
SELECT
    c.table_name,
    c.ordinal_position                     AS "#",
    c.column_name,
    c.data_type ||
        COALESCE('(' || c.character_maximum_length || ')', '') AS data_type,
    c.is_nullable,
    c.column_default,
    (c.is_identity = 'YES')                AS is_identity
FROM information_schema.columns c
WHERE c.table_schema = 'public'
ORDER BY c.table_name, c.ordinal_position;

-- Describe ONE table only — change 'partner_bookings' to any table name:
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'partner_bookings'
ORDER BY ordinal_position;


-- ============================================================================
-- SECTION 3 — Primary keys
-- ============================================================================
SELECT
    tc.table_name,
    tc.constraint_name,
    string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS pk_columns
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
GROUP BY tc.table_name, tc.constraint_name
ORDER BY tc.table_name;


-- ============================================================================
-- SECTION 4 — Foreign key relationships
-- ============================================================================
SELECT
    tc.table_name        AS child_table,
    kcu.column_name       AS child_column,
    ccu.table_name        AS parent_table,
    ccu.column_name        AS parent_column,
    tc.constraint_name,
    rc.update_rule,
    rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
ORDER BY tc.table_name, kcu.column_name;

-- Foreign keys pointing INTO the Partner Portal tables only:
SELECT
    tc.table_name AS child_table, kcu.column_name AS child_column,
    ccu.table_name AS parent_table, ccu.column_name AS parent_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  AND (tc.table_name LIKE 'partner%' OR tc.table_name LIKE 'service_request%')
ORDER BY tc.table_name;


-- ============================================================================
-- SECTION 5 — Other constraints (CHECK, UNIQUE, NOT NULL)
-- ============================================================================
-- CHECK constraints, with the actual boolean expression enforced
SELECT
    tc.table_name,
    tc.constraint_name,
    cc.check_clause
FROM information_schema.table_constraints tc
JOIN information_schema.check_constraints cc
    ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.table_schema
WHERE tc.constraint_type = 'CHECK' AND tc.table_schema = 'public'
  AND tc.constraint_name NOT LIKE '%_not_null'
ORDER BY tc.table_name;

-- UNIQUE constraints
SELECT
    tc.table_name,
    tc.constraint_name,
    string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS unique_columns
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = 'public'
GROUP BY tc.table_name, tc.constraint_name
ORDER BY tc.table_name;

-- Enum / custom types used by CHECK-style column constraints
SELECT
    t.typname AS enum_name,
    string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS allowed_values
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
GROUP BY t.typname
ORDER BY t.typname;


-- ============================================================================
-- SECTION 6 — Indexes
-- ============================================================================
SELECT
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- Indexes on the Partner Portal tables only:
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND (tablename LIKE 'partner%' OR tablename LIKE 'service_request%')
ORDER BY tablename, indexname;


-- ============================================================================
-- SECTION 7 — Sequences / identity columns
-- ============================================================================
SELECT sequence_name, data_type, start_value, increment
FROM information_schema.sequences
WHERE sequence_schema = 'public'
ORDER BY sequence_name;

-- Which column each identity sequence belongs to, and its current value:
SELECT
    c.table_name,
    c.column_name,
    pg_get_serial_sequence(c.table_name, c.column_name) AS owning_sequence
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND pg_get_serial_sequence(c.table_name, c.column_name) IS NOT NULL
ORDER BY c.table_name;


-- ============================================================================
-- SECTION 8 — Views
-- ============================================================================
SELECT table_name AS view_name
FROM information_schema.views
WHERE table_schema = 'public'
ORDER BY table_name;

-- Full SQL definition of every view:
SELECT viewname, definition
FROM pg_views
WHERE schemaname = 'public'
ORDER BY viewname;


-- ============================================================================
-- SECTION 9 — Functions & Stored Procedures
-- ============================================================================
-- NOTE: every routine in this database is implemented as a PostgreSQL
-- FUNCTION (invoked as "SELECT sp_xxx(...)"), including the ones named with
-- the sp_ ("stored procedure") naming convention used throughout the design
-- docs. None are native PostgreSQL PROCEDURE objects (which would be
-- invoked with CALL and support transaction control). This means in
-- pgAdmin's object tree, ALL of them appear under
-- Schemas > public > Functions — the "Procedures" node will be empty by
-- design, not because anything is missing.
SELECT
    p.proname                                     AS routine_name,
    pg_get_function_identity_arguments(p.oid)      AS parameters,
    pg_get_function_result(p.oid)                  AS returns,
    CASE WHEN p.proname LIKE 'sp\_%' THEN 'stored procedure (sp_ convention)'
         WHEN p.proname LIKE 'fn\_%' THEN 'trigger/helper function (fn_ convention)'
         ELSE 'function' END                       AS category
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY category, p.proname;

-- Full source code of one routine — change the name to inspect any of them:
SELECT prosrc FROM pg_proc WHERE proname = 'sp_get_dashboard_statistics';


-- ============================================================================
-- SECTION 10 — Triggers
-- ============================================================================
SELECT
    c.relname                       AS table_name,
    t.tgname                        AS trigger_name,
    pg_get_triggerdef(t.oid)        AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
ORDER BY c.relname, t.tgname;
-- NOTE: information_schema.triggers (the "standard" view) lists one ROW per
-- event for multi-event triggers (e.g. "AFTER INSERT OR UPDATE" shows
-- twice), which double-counts. The pg_trigger query above is the accurate,
-- deduplicated count — 12 real triggers as of this review.


-- ============================================================================
-- SECTION 11 — Object count summary (sanity check against the design spec)
-- ============================================================================
SELECT 'Tables'                AS object_type, count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname='public'
UNION ALL
SELECT 'Views',                 count(*) FROM information_schema.views WHERE table_schema='public'
UNION ALL
SELECT 'Functions/Procedures',  count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
UNION ALL
SELECT 'Triggers (deduped)',    count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public'
UNION ALL
SELECT 'Sequences',             count(*) FROM information_schema.sequences WHERE sequence_schema='public'
UNION ALL
SELECT 'Primary Keys',          count(DISTINCT constraint_name) FROM information_schema.table_constraints WHERE constraint_type='PRIMARY KEY' AND table_schema='public'
UNION ALL
SELECT 'Foreign Keys',          count(DISTINCT constraint_name) FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='public'
UNION ALL
SELECT 'Check Constraints',     count(DISTINCT constraint_name) FROM information_schema.table_constraints WHERE constraint_type='CHECK' AND table_schema='public' AND constraint_name NOT LIKE '%_not_null'
UNION ALL
SELECT 'Unique Constraints',    count(DISTINCT constraint_name) FROM information_schema.table_constraints WHERE constraint_type='UNIQUE' AND table_schema='public'
UNION ALL
SELECT 'Indexes',               count(*) FROM pg_indexes WHERE schemaname='public'
UNION ALL
SELECT 'Enum Types',            count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e';
