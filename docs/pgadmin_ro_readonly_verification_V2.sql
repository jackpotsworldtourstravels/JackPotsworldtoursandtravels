-- =====================================================================
-- pgadmin_ro — READ-ONLY verification queries  (V2)
-- Project: JackPots World Tours & Travels · DB: jackpotsworldtours (PG 18.3)
-- Run by the DBA as jpwadmin/master over the SSM tunnel. SELECT-only: nothing
-- here creates, grants, revokes, or changes anything. Paste the outputs back.
--
-- V2 CHANGE: Section 6.3 now finds EVERY function PUBLIC can effectively EXECUTE —
--   both the default case (proacl IS NULL) AND explicit ACL entries that grant
--   EXECUTE to PUBLIC (grantee 0). The old 6.3c (NULL-proacl only) is kept as a
--   labelled subset; new 6.3d is the authoritative, complete check. The SECURITY
--   DEFINER checks (10.4a'/b'/c') are unchanged. PART B is unchanged.
--
-- IMPORTANT SEQUENCING:
--   PART A runs NOW — the role pgadmin_ro does NOT yet exist, so these queries
--          do not call has_*_privilege('pgadmin_ro', ...). They answer the live
--          PUBLIC-EXECUTE and SECURITY DEFINER questions.
--   PART B must run ONLY AFTER Section 7 of the checklist creates pgadmin_ro.
--          Every PART B query calls has_*_privilege('pgadmin_ro', ...), which
--          ERRORS with "role \"pgadmin_ro\" does not exist" until the role exists.
-- =====================================================================


-- =====================================================================
-- PART A — RUN NOW (role-independent; safe, read-only)
-- =====================================================================

-- 6.1 Confirm environment (expect database=jackpotsworldtours, PostgreSQL 18.3).
SELECT current_database(), current_user, version();

-- 6.2 Role existence — EXPECT 0 ROWS. If 1 row, STOP (do not modify/reuse).
SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolconnlimit
FROM pg_roles WHERE rolname = 'pgadmin_ro';

-- 6.3a Database-level PUBLIC privileges — EXPECT: CONNECT, TEMPORARY (no CREATE).
SELECT a.privilege_type
FROM pg_database d, LATERAL aclexplode(d.datacl) a
WHERE d.datname = 'jackpotsworldtours' AND a.grantee = 0
ORDER BY 1;

-- 6.3b Schema public PUBLIC privileges — EXPECT: USAGE (no CREATE).
SELECT a.privilege_type
FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
WHERE n.nspname = 'public' AND a.grantee = 0
ORDER BY 1;

-- 6.3c (SUBSET — default only) Functions whose EXECUTE-to-PUBLIC comes from the
--      built-in default (proacl IS NULL). Retained for transparency; it does NOT
--      catch functions with an EXPLICIT PUBLIC EXECUTE grant — use 6.3d for the
--      complete picture.
SELECT n.nspname, p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proacl IS NULL AND n.nspname = 'public'
ORDER BY 1,2;

-- 6.3d (CORRECTED / AUTHORITATIVE) EVERY public-schema function PUBLIC can
--      effectively EXECUTE — default (NULL proacl) OR an explicit ACL entry
--      granting EXECUTE to PUBLIC (grantee 0). This is role-independent and
--      complete; an explicit REVOKE of PUBLIC EXECUTE correctly excludes a
--      function here.
--      EXPECT EXACTLY TWO ROWS: fn_set_updated_at, fn_write_audit_log (both via
--      'default (NULL acl)'). Any ADDITIONAL row, or any row sourced from an
--      'explicit PUBLIC EXECUTE grant', => FLAG for DBA investigation
--      (read it with pg_get_functiondef(oid)); do NOT silently accept it.
SELECT n.nspname,
       p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       CASE WHEN p.proacl IS NULL THEN 'default (NULL acl)'
            ELSE 'explicit PUBLIC EXECUTE grant' END AS public_execute_source
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (
        p.proacl IS NULL
        OR EXISTS (
             SELECT 1 FROM aclexplode(p.proacl) a
             WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           )
      )
ORDER BY public_execute_source, p.proname;

-- 10.4a' (role-independent) EVERY public function: security type + language + acl state.
--      EXPECT: security_definer = false for every row. Any true => FLAG.
SELECT n.nspname, p.proname,
       p.prosecdef AS security_definer,
       l.lanname   AS language,
       (p.proacl IS NULL) AS acl_null_default_public_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public'
ORDER BY p.prosecdef DESC, p.proname;

-- 10.4b' (role-independent) VERIFY the two trigger functions are SECURITY INVOKER.
--      EXPECT both rows: security_definer = false, is_security_invoker = true, language = plpgsql.
SELECT p.proname,
       p.prosecdef        AS security_definer,
       (NOT p.prosecdef)  AS is_security_invoker,
       l.lanname          AS language
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public'
  AND p.proname IN ('fn_set_updated_at','fn_write_audit_log')
ORDER BY p.proname;

-- 10.4c' (role-independent) ANY SECURITY DEFINER function in public.
--      EXPECT 0 ROWS. Any row => FLAG for DBA investigation (do NOT alter it).
SELECT n.nspname, p.proname,
       pg_get_userbyid(p.proowner) AS owner,
       pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
ORDER BY 1,2;


-- =====================================================================
-- PART B — DO NOT RUN YET. Run ONLY after checklist Section 7 creates pgadmin_ro.
-- Each query references pgadmin_ro and will error until the role exists.
-- These are the effective-permission + negative tests (10.1–10.6, 13a–13c).
-- (UNCHANGED from the previous version.)
-- =====================================================================

-- 10.1 Effective SELECT on every readable relation in public — EXPECT no true.
SELECT n.nspname, c.relname,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table'
                      WHEN 'v' THEN 'view'  WHEN 'm' THEN 'materialized view'
                      WHEN 'f' THEN 'foreign table' END AS kind,
       has_table_privilege('pgadmin_ro', c.oid, 'SELECT') AS can_select
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname = 'public'
ORDER BY can_select DESC, 1,2;

-- 10.2 SELECT + write verbs on named sensitive tables — EXPECT all false.
SELECT x.table_name,
  has_table_privilege('pgadmin_ro', x.table_name, 'SELECT') AS sel,
  has_table_privilege('pgadmin_ro', x.table_name, 'INSERT') AS ins,
  has_table_privilege('pgadmin_ro', x.table_name, 'UPDATE') AS upd,
  has_table_privilege('pgadmin_ro', x.table_name, 'DELETE') AS del
FROM unnest(ARRAY['public.users','public.payments','public.merchants',
  'public.service_requests','public.audit_logs','public.wallet_topups']) AS x(table_name)
ORDER BY x.table_name;

-- 10.3 Sequence privileges — EXPECT all false.
SELECT n.nspname, c.relname AS seq,
       has_sequence_privilege('pgadmin_ro', c.oid,'USAGE')  AS usage,
       has_sequence_privilege('pgadmin_ro', c.oid,'SELECT') AS sel,
       has_sequence_privilege('pgadmin_ro', c.oid,'UPDATE') AS upd
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname = 'public' ORDER BY 1,2;

-- 10.4 Function EXECUTE FOR pgadmin_ro — EXPECT true only for the two trigger functions.
SELECT n.nspname, p.proname, p.prosecdef AS security_definer,
       has_function_privilege('pgadmin_ro', p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY can_execute DESC, security_definer DESC, 2;

-- 10.5 Database + schema privileges.
SELECT has_database_privilege('pgadmin_ro','jackpotsworldtours','CONNECT') AS db_connect, -- true
       has_database_privilege('pgadmin_ro','jackpotsworldtours','CREATE')  AS db_create,  -- false
       has_database_privilege('pgadmin_ro','jackpotsworldtours','TEMP')    AS db_temp,    -- likely true (PUBLIC)
       has_schema_privilege('pgadmin_ro','public','USAGE')  AS sch_usage,   -- true
       has_schema_privilege('pgadmin_ro','public','CREATE') AS sch_create;  -- false

-- 10.6 Role attributes + memberships.
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolcanlogin, rolconnlimit
FROM pg_roles WHERE rolname = 'pgadmin_ro';
SELECT g.rolname AS member_of
FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
WHERE r.rolname = 'pgadmin_ro';     -- EXPECT 0 rows

-- 13(c) Full write-privilege sweep across every public relation — EXPECT 0 rows.
SELECT n.nspname, c.relname, c.relkind,
       has_table_privilege('pgadmin_ro', c.oid,'INSERT')   AS ins,
       has_table_privilege('pgadmin_ro', c.oid,'UPDATE')   AS upd,
       has_table_privilege('pgadmin_ro', c.oid,'DELETE')   AS del,
       has_table_privilege('pgadmin_ro', c.oid,'TRUNCATE') AS trunc
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
  AND ( has_table_privilege('pgadmin_ro', c.oid,'INSERT')
     OR has_table_privilege('pgadmin_ro', c.oid,'UPDATE')
     OR has_table_privilege('pgadmin_ro', c.oid,'DELETE')
     OR has_table_privilege('pgadmin_ro', c.oid,'TRUNCATE') )
ORDER BY 1,2;
-- (13a/13b record-read denials run as pgadmin_ro in an independent login — Section 11/13.)
