-- =============================================================================
-- Stage B — READ-ONLY verification queries (items 1-10)
-- =============================================================================
-- STATUS: REVIEWABLE ONLY. NOT EXECUTED by Claude.
--
-- Every statement here is SELECT-only. There is no INSERT/UPDATE/DELETE/DDL.
-- Run ONLY with the least-privilege role from 00_create_readonly_role.sql, against
-- the ONE target database you confirm. The whole file is wrapped in a read-only
-- transaction so the server itself rejects any accidental write.
--
-- Usage (example):
--   psql "postgresql://jpw_readonly:<pw>@<host>:5432/<target_db>" \
--        -f docs/stage-b/01_stage_b_readonly_queries.sql
-- =============================================================================

BEGIN TRANSACTION READ ONLY;        -- server rejects any write inside this block
SET LOCAL statement_timeout = '120s';

-- -----------------------------------------------------------------------------
-- 1. B2C TABLE ROW COUNTS  (customer_* + payment_provider_events)
-- -----------------------------------------------------------------------------
-- 1a. Fast approximate counts (planner stats; no table scan):
SELECT relname AS table_name, n_live_tup AS approx_rows
FROM pg_stat_user_tables
WHERE relname LIKE 'customer\_%' ESCAPE '\'
   OR relname = 'payment_provider_events'
ORDER BY relname;

-- 1b. Exact counts, generated for every customer_* table (run the output of this,
--     or use the per-table block your DBA prefers). This SELECT only *emits* SQL:
SELECT string_agg(
         format('SELECT %L AS table_name, count(*) AS exact_rows FROM %I', relname, relname),
         E'\nUNION ALL\n' ORDER BY relname) || ';' AS generated_exact_count_sql
FROM pg_stat_user_tables
WHERE relname LIKE 'customer\_%' ESCAPE '\'
   OR relname = 'payment_provider_events';

-- -----------------------------------------------------------------------------
-- 2. LEGACY TABLE ROW COUNTS + RECENT-WRITE SCAN  (items 2 and 10)
-- -----------------------------------------------------------------------------
-- 2a. Row counts for the dead-cluster tables and the duplicate-name legacy tables.
--     Each is guarded with to_regclass so a missing table yields NULL, not an error.
SELECT 'coupons'            AS table_name, (SELECT count(*) FROM coupons)            AS n WHERE to_regclass('public.coupons')            IS NOT NULL
UNION ALL SELECT 'seasonal_prices',       (SELECT count(*) FROM seasonal_prices)         WHERE to_regclass('public.seasonal_prices')     IS NOT NULL
UNION ALL SELECT 'discount_campaigns',    (SELECT count(*) FROM discount_campaigns)      WHERE to_regclass('public.discount_campaigns')  IS NOT NULL
UNION ALL SELECT 'flights',               (SELECT count(*) FROM flights)                 WHERE to_regclass('public.flights')             IS NOT NULL
UNION ALL SELECT 'hotels',                (SELECT count(*) FROM hotels)                  WHERE to_regclass('public.hotels')              IS NOT NULL
UNION ALL SELECT 'tour_packages',         (SELECT count(*) FROM tour_packages)           WHERE to_regclass('public.tour_packages')       IS NOT NULL
UNION ALL SELECT 'bookings',              (SELECT count(*) FROM bookings)                WHERE to_regclass('public.bookings')            IS NOT NULL
UNION ALL SELECT 'service_requests',      (SELECT count(*) FROM service_requests)        WHERE to_regclass('public.service_requests')    IS NOT NULL
ORDER BY table_name;

-- 2b. Recent-write scan: emits a MAX(updated_at)/MAX(created_at) probe for every
--     legacy table that actually has such a column. Run the emitted SQL to see
--     whether any legacy row was written recently (a sign of a live/out-of-repo writer).
SELECT string_agg(
         format('SELECT %L AS table_name, max(%I) AS last_write FROM %I', c.table_name, c.column_name, c.table_name),
         E'\nUNION ALL\n') || ';' AS generated_recent_write_sql
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN ('coupons','seasonal_prices','discount_campaigns','flights',
                       'hotels','tour_packages','bookings','service_requests')
  AND c.column_name IN ('updated_at','created_at');

-- -----------------------------------------------------------------------------
-- 3. FOREIGN-KEY INTEGRITY  +  boundary-crossing FKs
-- -----------------------------------------------------------------------------
-- 3a. Full FK inventory: child table.column -> parent table.column.
SELECT tc.table_name  AS child_table,
       kcu.column_name AS child_column,
       ccu.table_name  AS parent_table,
       ccu.column_name AS parent_column,
       tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
     ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
     ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
ORDER BY child_table, child_column;

-- 3b. FKs that cross the B2C boundary (one side customer_*, the other not).
--     Expect ZERO rows — the B2C island must be self-contained.
SELECT tc.table_name AS child_table, kcu.column_name, ccu.table_name AS parent_table
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
     ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
     ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  AND ( (tc.table_name LIKE 'customer%') <> (ccu.table_name LIKE 'customer%') )
ORDER BY child_table;

-- -----------------------------------------------------------------------------
-- 4. ORPHAN RECORDS  (every child FK whose parent row is missing)
-- -----------------------------------------------------------------------------
-- Generates one anti-join count per FK from the live FK definitions, so nothing is
-- hardcoded. Run the emitted SQL; every count should be 0.
SELECT string_agg(
         format(
           'SELECT %L AS fk, count(*) AS orphans FROM %I c LEFT JOIN %I p ON c.%I = p.%I WHERE c.%I IS NOT NULL AND p.%I IS NULL',
           tc.constraint_name, tc.table_name, ccu.table_name,
           kcu.column_name, ccu.column_name, kcu.column_name, ccu.column_name),
         E'\nUNION ALL\n') || E'\nORDER BY orphans DESC;' AS generated_orphan_check_sql
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
     ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
     ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  AND tc.table_name LIKE 'customer%';

-- -----------------------------------------------------------------------------
-- 5. DUPLICATE IDENTIFIERS
-- -----------------------------------------------------------------------------
-- 5a. Known business keys on customers (adjust the table name if it differs).
SELECT 'customer_code' AS id, customer_code AS value, count(*) AS n
FROM customers GROUP BY customer_code HAVING count(*) > 1
UNION ALL
SELECT 'email_lower', lower(email), count(*)
FROM customers WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1
UNION ALL
SELECT 'mobile', mobile, count(*)
FROM customers WHERE mobile IS NOT NULL GROUP BY mobile HAVING count(*) > 1;

-- 5b. Every UNIQUE constraint in the schema (so duplicates in any unique key can be
--     checked systematically, not just the three above).
SELECT tc.table_name, tc.constraint_name,
       string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS unique_columns
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
     ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = 'public'
GROUP BY tc.table_name, tc.constraint_name
ORDER BY tc.table_name;

-- -----------------------------------------------------------------------------
-- 6. POSTGRESQL ENUM TYPES  (e.g. customer_*_enum created by migration 0044)
-- -----------------------------------------------------------------------------
SELECT t.typname AS enum_type,
       string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
GROUP BY t.typname
ORDER BY t.typname;

-- -----------------------------------------------------------------------------
-- 7. SEQUENCES  (especially seq_customer_code)
-- -----------------------------------------------------------------------------
SELECT schemaname, sequencename, start_value, increment_by, last_value
FROM pg_sequences
WHERE schemaname = 'public'
ORDER BY sequencename;
-- Explicit spotlight on the customer-code sequence (NULL if not present):
SELECT 'seq_customer_code' AS sequence_name,
       (SELECT last_value FROM pg_sequences WHERE sequencename = 'seq_customer_code') AS last_value;

-- -----------------------------------------------------------------------------
-- 8. INDEXES AND CONSTRAINTS
-- -----------------------------------------------------------------------------
-- 8a. All indexes on customer_* + payment_provider_events.
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND (tablename LIKE 'customer\_%' ESCAPE '\' OR tablename = 'payment_provider_events')
ORDER BY tablename, indexname;

-- 8b. All constraints (PK / UNIQUE / FK / CHECK) on those tables.
SELECT tc.table_name, tc.constraint_type, tc.constraint_name
FROM information_schema.table_constraints tc
WHERE tc.table_schema = 'public'
  AND (tc.table_name LIKE 'customer\_%' ESCAPE '\' OR tc.table_name = 'payment_provider_events')
ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;

-- 8c. CHECK clauses verbatim (enums-as-checks, jsonb guards, etc.).
SELECT rel.relname AS table_name, con.conname AS check_name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE con.contype = 'c' AND n.nspname = 'public'
  AND (rel.relname LIKE 'customer\_%' ESCAPE '\' OR rel.relname = 'payment_provider_events')
ORDER BY table_name, check_name;

-- -----------------------------------------------------------------------------
-- 9. payment_provider_events — row-level ownership / distribution
-- -----------------------------------------------------------------------------
-- Column names below follow the Stage A spec; adjust if the live schema differs
-- (confirm with the §8 index/constraint output first).
SELECT provider, processing_status, count(*) AS n
FROM payment_provider_events
GROUP BY provider, processing_status
ORDER BY provider, processing_status;

-- -----------------------------------------------------------------------------
-- 10. CROSS-IDENTITY LEAK CHECK (customers vs B2B users sharing an email)
-- -----------------------------------------------------------------------------
-- Only meaningful while both tables still co-reside in one DB (pre-split).
SELECT count(*) AS shared_email_rows
FROM users u
WHERE EXISTS (SELECT 1 FROM customers c WHERE lower(c.email) = lower(u.email));

ROLLBACK;   -- nothing to commit in a read-only session; ends the transaction cleanly
-- =============================================================================
-- END — all statements above are SELECT-only.
-- =============================================================================
