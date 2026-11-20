# pgadmin_ro — Final DBA Execution Checklist

**Project:** JackPots World Tours & Travels · **DB:** AWS RDS PostgreSQL (production) · **Date:** 2026-11-14

**Purpose:** create a dedicated **read-only** pgAdmin account (`pgadmin_ro`) for the DBA verification package, at least privilege. This document is **instructions only** — Claude did not execute any SQL, did not connect to production, and created no role or grant.

**Hard gate:** steps 3–5 are the only writes. **The DBA must obtain the owner's explicit approval before executing them.** Steps 1–2 and 6–9 are read-only checks.

**Labels:** `[REPO]` verified in repository · `[LIVE-UNKNOWN]` only the live DB confirms (the query produces it on run).

**Standing restrictions (all steps):** do not reset the RDS master password; do not modify `DATABASE_URL`/`MIGRATION_DATABASE_URL`; do not restart the app; do not grant access to sensitive tables; **do not revoke any PUBLIC permission without separate approval**; no AWS/security-group change. RDS stays private — connect only through the SSH or SSM tunnel.

Replace `<jackpots_db>` with the real database name throughout.

---

## Step 1 — Pre-change checks (read-only)

```sql
SELECT current_database(), current_user, version();
SELECT version_num FROM alembic_version;        -- note the current revision
```
- Confirm you are on the intended **production** database and connected as the **master/rds_superuser** (the only role that may create roles on RDS — an in-database operation needing no AWS IAM change).
- Confirm a **verified backup/snapshot exists** (a snapshot protects *data*, not the master password — irrelevant here since the password is unchanged, but required policy before any change).

### Step 1b — PUBLIC permission baseline (read-only; capture and SAVE the output) (correction 2)

Captured **before** the role exists, this records what *any* new role already inherits through PUBLIC. The same set is re-run in Step 6 and diffed, so a pre-existing PUBLIC permission is never mistaken for one introduced by `pgadmin_ro`.

```sql
-- B1. PUBLIC grants on application tables (grantee 0 = PUBLIC).
SELECT n.nspname, c.relname, c.relkind, a.privilege_type
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
     LATERAL aclexplode(c.relacl) a
WHERE c.relkind IN ('r','p') AND c.relacl IS NOT NULL
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND a.grantee = 0
ORDER BY 1,2,3;

-- B2. PUBLIC grants on sequences and functions.
SELECT n.nspname, c.relname AS object, 'sequence' AS kind, a.privilege_type
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, LATERAL aclexplode(c.relacl) a
WHERE c.relkind='S' AND c.relacl IS NOT NULL AND a.grantee=0
  AND n.nspname NOT IN ('pg_catalog','information_schema')
UNION ALL
SELECT n.nspname, p.proname, 'function', a.privilege_type
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, LATERAL aclexplode(p.proacl) a
WHERE p.proacl IS NOT NULL AND a.grantee=0
  AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1,2;
-- NOTE: a function/sequence with acl = NULL carries the BUILT-IN default, which for
-- functions is EXECUTE to PUBLIC (aclexplode shows nothing for NULL). Treat NULL-acl
-- functions as PUBLIC-executable.

-- B3. Database and schema PUBLIC defaults (via acl, since has_*_privilege has no PUBLIC arg).
SELECT d.datname, a.privilege_type
FROM pg_database d, LATERAL aclexplode(d.datacl) a
WHERE d.datname='<jackpots_db>' AND a.grantee=0;      -- datacl NULL => CONNECT+TEMP to PUBLIC
SELECT n.nspname, a.privilege_type
FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
WHERE n.nspname='public' AND a.grantee=0;             -- PG<15: USAGE+CREATE; PG15+: no CREATE
```
Save B1–B3 as the baseline.

## Step 2 — Existing-role check (read-only; HARD STOP if present)

```sql
SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil
FROM pg_roles WHERE rolname = 'pgadmin_ro';
```
- **0 rows** → proceed to Step 3.
- **1 row** → **STOP.** Do **not** `CREATE` (it would error) and do **not** `ALTER`/`DROP`/overwrite it. Inspect its attributes (above), memberships, and privileges:
```sql
SELECT g.rolname AS member_of
FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid
WHERE r.rolname='pgadmin_ro';
SELECT n.nspname, c.relname, has_table_privilege('pgadmin_ro', c.oid,'SELECT') AS can_select
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
  AND has_table_privilege('pgadmin_ro', c.oid,'SELECT') ORDER BY 1,2;
```
  Report findings to the owner and await a decision — never reconcile an existing role automatically.

## Step 3 — Approved role creation  `[APPROVAL REQUIRED]`

```sql
CREATE ROLE pgadmin_ro
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 3;
```

## Step 4 — Password setup (interactive; never echoed/logged)  `[APPROVAL REQUIRED]`

```sql
\password pgadmin_ro
```
- psql prompts and sends a pre-hashed `ALTER ROLE … PASSWORD` — the plaintext never appears on the command line, in shell history, or in a script file. (pgAdmin alternative: role Properties → Definition → Password field.) Until set, RDS password auth refuses the login.

## Step 5 — Exact table grants  `[APPROVAL REQUIRED]`

Run Step 6's existence check **first**; grant only on tables that exist.
```sql
GRANT CONNECT ON DATABASE <jackpots_db> TO pgadmin_ro;
GRANT USAGE   ON SCHEMA   public         TO pgadmin_ro;
GRANT SELECT ON
    public.alembic_version,
    public.flights, public.hotels, public.cruises, public.tour_packages,
    public.coupons, public.seasonal_prices, public.discount_campaigns
  TO pgadmin_ro;
```
**This is the complete allowlist.** No other table, no `ALL TABLES`, no `ALTER DEFAULT PRIVILEGES`, no sequence/function grant.

### Transaction handling & rollback (correction 3)

`CREATE ROLE` and `GRANT` are transactional in PostgreSQL, so group Steps 3 and 5 into **one** transaction and verify before committing. The interactive password (Step 4) is a separate client command run **after** commit.

```sql
BEGIN;
  CREATE ROLE pgadmin_ro
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 3;
  GRANT CONNECT ON DATABASE <jackpots_db> TO pgadmin_ro;
  GRANT USAGE   ON SCHEMA   public         TO pgadmin_ro;
  GRANT SELECT ON
      public.alembic_version, public.flights, public.hotels, public.cruises,
      public.tour_packages, public.coupons, public.seasonal_prices,
      public.discount_campaigns
    TO pgadmin_ro;
  -- in-transaction sanity check (the new grants are visible to THIS session):
  SELECT t, has_table_privilege('pgadmin_ro', t, 'SELECT') AS sel
  FROM unnest(ARRAY['public.alembic_version','public.flights','public.hotels',
    'public.cruises','public.tour_packages','public.coupons',
    'public.seasonal_prices','public.discount_campaigns']) t;
-- All eight sel=true AND nothing unexpected  ->  COMMIT;
-- Anything wrong                             ->  ROLLBACK;   (leaves no role, no grant)
```
Then set the password separately — **not** inside the transaction, to keep the plaintext out of any scripted statement or log:
```sql
\password pgadmin_ro
```
`\password` is a psql client command that issues its own pre-hashed `ALTER ROLE … PASSWORD`; run it after `COMMIT`. Do **not** use `ALTER ROLE … PASSWORD '<plaintext>'` inside the transaction — that would expose the secret.

**Rollback / recovery:**
- Transaction fails or the pre-commit check is wrong → `ROLLBACK;` — nothing persisted, no cleanup.
- Transaction **committed** but `\password` fails or setup is abandoned → the role exists **with no password**, so it cannot authenticate (fail-safe). Retry `\password`; or, **only with explicit owner approval**, remove it cleanly (never automatically, and never a role Step 2 found pre-existing):
```sql
-- APPROVAL REQUIRED. Do not run automatically.
BEGIN;
  REVOKE ALL ON public.alembic_version, public.flights, public.hotels, public.cruises,
                  public.tour_packages, public.coupons, public.seasonal_prices,
                  public.discount_campaigns FROM pgadmin_ro;
  REVOKE ALL ON SCHEMA public       FROM pgadmin_ro;
  REVOKE ALL ON DATABASE <jackpots_db> FROM pgadmin_ro;
  DROP ROLE pgadmin_ro;   -- succeeds because pgadmin_ro owns no objects
COMMIT;
```

## Step 6 — Effective permission checks (read-only acceptance gate)

```sql
-- 6a. The 8 grant-list tables exist (grant only where exists=true).
SELECT t AS proposed_table, to_regclass(t) IS NOT NULL AS exists
FROM unnest(ARRAY['public.alembic_version','public.flights','public.hotels',
  'public.cruises','public.tour_packages','public.coupons',
  'public.seasonal_prices','public.discount_campaigns']) t;

-- 6b. EFFECTIVE SELECT (incl. PUBLIC + inherited) on EVERY ordinary/partitioned
--     table — expect ONLY the 8 to be true; every customer_*, payment, wallet,
--     partner_*, session, users table false.
SELECT n.nspname AS schema, c.relname AS tbl, c.relkind,
       has_table_privilege('pgadmin_ro', c.oid, 'SELECT') AS can_select
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY can_select DESC, 1,2;

-- 6c. Unexpected PUBLIC grants on application tables (grantee 0 = PUBLIC).
SELECT n.nspname, c.relname, a.privilege_type
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
     LATERAL aclexplode(c.relacl) a
WHERE c.relkind IN ('r','p') AND c.relacl IS NOT NULL
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND a.grantee = 0
ORDER BY 1,2,3;

-- 6d. Write verbs on the allowlist — all must be false.
SELECT t,
  has_table_privilege('pgadmin_ro',t,'INSERT')  AS ins,
  has_table_privilege('pgadmin_ro',t,'UPDATE')  AS upd,
  has_table_privilege('pgadmin_ro',t,'DELETE')  AS del,
  has_table_privilege('pgadmin_ro',t,'TRUNCATE')AS trunc
FROM unnest(ARRAY['public.alembic_version','public.flights','public.hotels',
  'public.cruises','public.tour_packages','public.coupons',
  'public.seasonal_prices','public.discount_campaigns']) t ORDER BY 1;

-- 6e. Schema / database / sequence privileges.
SELECT has_schema_privilege('pgadmin_ro','public','USAGE')  AS sch_usage,   -- true
       has_schema_privilege('pgadmin_ro','public','CREATE') AS sch_create,  -- false
       has_database_privilege('pgadmin_ro','<jackpots_db>','CONNECT') AS db_connect, -- true
       has_database_privilege('pgadmin_ro','<jackpots_db>','CREATE')  AS db_create,  -- false
       has_database_privilege('pgadmin_ro','<jackpots_db>','TEMP')    AS db_temp;    -- see note
SELECT n.nspname, c.relname AS seq,
       has_sequence_privilege('pgadmin_ro', c.oid,'USAGE')  AS usage,
       has_sequence_privilege('pgadmin_ro', c.oid,'SELECT') AS sel,
       has_sequence_privilege('pgadmin_ro', c.oid,'UPDATE') AS upd
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;
```
**Expected:** 6b true-set = the 8 only; 6c empty; 6d all false; 6e `sch_create`/`db_create` false, sequences all false.
**TEMP note (correction 2):** `db_temp` will likely be `true` because PUBLIC holds `TEMP` by default. `TEMP` permits only **session-local temporary tables** in the session's own `pg_temp` schema — dropped at disconnect, invisible to others, and **never a write to, or creation of, persistent application data**. It therefore does **not** breach the read-only-on-application-data guarantee. The only lever to remove it is `REVOKE TEMP … FROM PUBLIC` (affects all roles) — **a separate PUBLIC change requiring its own approval**; do not apply it here.

**Baseline diff (correction 2):** re-run the Step 1b PUBLIC-baseline queries now and compare. Every table / function / sequence `pgadmin_ro` can reach must be either (a) in the Step 1b PUBLIC baseline — pre-existing, inherited via PUBLIC, **not** introduced here — or (b) one of the eight explicit SELECT grants. Anything in neither is an unexpected finding → report it; a PUBLIC-origin finding is remedied only with separate approval.

## Step 7 — Function & procedure security checks (read-only)

```sql
-- 7a. ALL SECURITY DEFINER routines (repo expectation: ZERO). Any row => a
--     definer routine added out-of-band => investigate before accepting.
SELECT n.nspname, p.proname, pg_get_userbyid(p.proowner) AS owner,
       pg_get_function_identity_arguments(p.oid) AS args, p.prokind
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;

-- 7b. Effective EXECUTE for pgadmin_ro (incl. PUBLIC). RISK = security_definer
--     true AND can_execute true.
SELECT n.nspname, p.proname, p.prosecdef AS security_definer,
       pg_get_userbyid(p.proowner) AS owner,
       has_function_privilege('pgadmin_ro', p.oid,'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY security_definer DESC, can_execute DESC, 1,2;

-- 7c. SIDE-EFFECT scan of every routine pgadmin_ro can EXECUTE (correction 1):
--     SECURITY INVOKER does NOT mean side-effect-free.
SELECT n.nspname, p.proname,
       (p.prosrc ~* 'pg_notify|[^a-z]notify ')         AS does_notify,
       (p.prosrc ~* 'nextval|setval')                  AS touches_sequence,
       (p.prosrc ~* 'dblink|postgres_fdw')             AS fdw_remote,
       (p.prosrc ~* 'lo_import|lo_export|pg_read_file|pg_write|copy ') AS file_or_lob,
       (p.prosrc ~* 'pg_advisory')                     AS advisory_lock
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND has_function_privilege('pgadmin_ro', p.oid,'EXECUTE')
ORDER BY 1,2;
```
**Interpretation (correction 1):**
- `[REPO]` every `sp_*`/`fn_*` is `SECURITY INVOKER`, so a routine `pgadmin_ro` executes runs with **its own** privileges. Table writes (`sp_register_partner`, `sp_create_ticket_request`, …) and sensitive reads (`sp_partner_login_lookup`, `sp_get_*`) fail on `pgadmin_ro`'s empty table privileges.
- **Non-table side effects still execute**, though: `NOTIFY`/`pg_notify` (emits a channel message — no data change), and `pg_advisory_*` (a session/txn lock) need **no** privilege. `nextval`/`setval` need sequence privileges `pgadmin_ro` lacks (Step 6e confirms) → fail. `dblink`/FDW, large objects, and file I/O need privileges `pgadmin_ro` lacks → fail. `CREATE EXTENSION` needs elevated rights → fail.
- **Net:** the only side effects actually reachable are **benign, non-persistent** (a notification message, an advisory lock). None modifies or exposes persistent application data. Confirm 7c shows no reachable `fdw_remote`/`file_or_lob` succeeding, and that 7a is empty.
- **Proposed remedy, reported not applied (correction 1):** for a strict "execute-nothing" posture, `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` (or apply the role-separation EXECUTE plan). This is a PUBLIC change needing separate approval; it is **not** part of this checklist.

**7c is a SCREENING tool, not proof (correction 1).** A regex over `pg_proc.prosrc` cannot see:
- **Nested calls** — routine A calls B which writes; A's body shows only the call to B.
- **Dynamic SQL** — `EXECUTE format(...)` / `EXECUTE a_variable` hides the real statement from any static scan.
- **Procedural / external languages** — `prosrc` is readable text only for `sql`/`plpgsql`; for `c`/`internal` it is just a symbol name, and for untrusted languages (`plpython3u`, `plperlu`, …) it is code this regex is not built to parse — such a routine can do almost anything.
- **Extension functions** — the body lives in the extension's shared library, not in `prosrc`.

So 7c flags candidates; it does not clear the remainder. Produce the **manual-review list** — routines executable by `pgadmin_ro` that are not plain `sql`/`plpgsql`, are `SECURITY DEFINER`, or use dynamic SQL:
```sql
SELECT n.nspname, p.proname, l.lanname AS language, p.prosecdef AS security_definer,
       (p.prosrc ~* 'execute\s') AS dynamic_sql,
       has_function_privilege('pgadmin_ro', p.oid,'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
JOIN pg_language l ON l.oid=p.prolang
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND has_function_privilege('pgadmin_ro', p.oid,'EXECUTE')
  AND ( l.lanname NOT IN ('sql','plpgsql')   -- C / internal / untrusted languages
        OR p.prosecdef                        -- any definer routine
        OR p.prosrc ~* 'execute\s' )          -- dynamic SQL
ORDER BY 1,2;
```
Each routine returned here gets a human read of its full definition (`pg_get_functiondef(p.oid)`) before acceptance — **reviewed, never executed or modified.** `[REPO]` the known `sp_*`/`fn_*` are `sql`/`plpgsql` and `SECURITY INVOKER`; `[LIVE-UNKNOWN]` whether production holds any C/untrusted-language, definer, or dynamic-SQL routine executable by `pgadmin_ro`.

## Step 8 — Independent `pgadmin_ro` login test (not `SET ROLE`)

Connect **as pgadmin_ro** through the private tunnel (password at the prompt; RDS stays private):
```bash
psql "host=<rds-endpoint> port=5432 dbname=<jackpots_db> user=pgadmin_ro sslmode=require"
```
Inside that real session:
```sql
SELECT version_num FROM alembic_version;   -- succeeds
SELECT count(*) FROM flights;              -- succeeds
SELECT count(*) FROM users;                -- MUST FAIL: permission denied
SELECT count(*) FROM payments;             -- MUST FAIL
SELECT count(*) FROM user_sessions;        -- MUST FAIL
-- structure of a sensitive table via catalog (names/types only, no rows):
SELECT attname FROM pg_attribute
WHERE attrelid='public.users'::regclass AND attnum>0 AND NOT attisdropped;
```
A real login (not `SET ROLE` from master) is the only thing that exercises `pg_hba`, authentication, the password, `LOGIN`, and `CONNECTION LIMIT`.

## Step 9 — Final acceptance report

Record and hand back:
- **Allowlist:** `alembic_version`, `flights`, `hotels`, `cruises`, `tour_packages`, `coupons`, `seasonal_prices`, `discount_campaigns` + `CONNECT`(db) + `USAGE`(public). Nothing else.
- **Acceptance (all must hold):** Step 6b true-set = exactly the 8; 6c empty; 6d all false; 6e `*_create` false + sequences false; 7a empty (no `SECURITY DEFINER`); 7b no definer-execute risk rows; 7c no reachable remote/file side effect; the Step-6 inventory diffed against the Step 1b PUBLIC baseline shows a delta of exactly the eight SELECT grants; the Step 7 manual-review list is cleared; Step 8 sensitive reads denied, approved reads succeed.
- **Findings** `[LIVE-UNKNOWN until run]`: list anything from 6c (PUBLIC table grants), 7a (definer routines), or 7c (remote/file side effects). Any such finding → report to owner; remedies that touch PUBLIC need **separate approval**.
- **Class C census (sensitive tables):** run by the master/DBA, not `pgadmin_ro`; use the **live** timestamp column per Step-6 schema check — `created_at` for most, **`subscribed_at`** for `newsletter`, **`login_at`** for `user_sessions`, and **none** for `roles` (count only). Verify columns live before `MAX(...)`; models may not match the deployed DB.

### Remaining limitations
1. No finding is live-verified until the DBA runs Steps 6–8 against production.
2. Repository models may diverge from the deployed DB — live schema (Step 6a + column checks) governs the grant and census, not the models.
3. PUBLIC `EXECUTE` on functions and PUBLIC `TEMP`/`CONNECT` on the database are live defaults the repo never removed; they are **contained** here (no `SECURITY DEFINER`; no table/sequence privileges; TEMP is session-local) but not eliminated. Eliminating them is a separate, approval-gated PUBLIC change.
4. Row counts cannot be privilege-limited to exclude contents, so sensitive-table counts stay a DBA/master step (or a reviewed `SECURITY DEFINER` aggregate function), never a SELECT grant.
5. Granting on a partitioned parent cascades to its partitions — none of the 8 is partitioned; Step 6b will catch any that becomes so.
6. Step 7c is static screening only; nested calls, dynamic SQL, and C/untrusted-language or extension routines need the Step 7 manual review before acceptance — a clean 7c scan is not proof of harmlessness.

---

**Claude executed nothing**: no production SQL, no role, no grant, no connection, no AWS/config change. The DBA runs this checklist **only after the owner's explicit approval** of Steps 3–5.
