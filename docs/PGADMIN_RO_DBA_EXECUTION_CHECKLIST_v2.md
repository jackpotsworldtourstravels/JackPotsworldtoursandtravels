# pgadmin_ro — Final DBA Execution Checklist (v2, review-corrected)

**Project:** JackPots World Tours & Travels · **DB:** AWS RDS PostgreSQL (production) · **Date:** 2026-11-14
**Supersedes:** `PGADMIN_RO_DBA_EXECUTION_CHECKLIST.md` (original preserved unchanged). v2 folds in the final technical-review corrections (baseline completeness, duplicate-CREATE hazard, RDS IAM auth, post-creation membership check, expanded independent-login test, safer rollback). All prior findings, restrictions, and the approved eight-table scope are retained.

**Purpose:** create a dedicated **read-only** pgAdmin account (`pgadmin_ro`) for the DBA verification package, at least privilege. Instructions only — Claude executed no SQL, did not connect to production, created no role or grant.

**Hard gate:** steps 3–5 are the only writes. **The DBA must obtain the owner's explicit approval before executing them.** Steps 1–2 and 6–9 are read-only.

**Labels:** `[REPO]` verified in repository · `[LIVE-UNKNOWN]` only the live DB confirms (the query produces it on run).

**Standing restrictions (all steps):** do not reset the RDS master password; do not modify `DATABASE_URL`/`MIGRATION_DATABASE_URL`; do not restart the app; do not grant access to sensitive tables; do not use `GRANT ALL`, `ALL TABLES`, or default privileges; **do not revoke any PUBLIC permission without separate approval**; no AWS/security-group/RDS-accessibility change. RDS stays private — connect only through the SSH or SSM tunnel.

Replace `<jackpots_db>` with the real database name throughout.

---

## Step 1 — Pre-change checks (read-only)

```sql
SELECT current_database(), current_user, version();
SELECT version_num FROM alembic_version;        -- note the current revision
```
- Confirm you are on the intended **production** database and connected as the **master/rds_superuser** (the only role that may create roles on RDS — an in-database operation needing no AWS IAM change).
- Confirm a **verified backup/snapshot exists** (a snapshot protects *data*, not the master password — irrelevant here since the password is unchanged, but required policy before any change).

### Step 1b — PUBLIC permission baseline (read-only; capture and SAVE the output)

Captured **before** the role exists, this records what *any* new role already inherits through PUBLIC. Re-run in Step 6 and diff, so a pre-existing PUBLIC permission is never mistaken for one introduced by `pgadmin_ro`.

**Important (v2 correction):** `aclexplode` returns rows only for **explicit** ACL entries. An object whose ACL is **NULL** carries the *built-in default*, which `aclexplode` does **not** emit. For a complete baseline you must capture the NULL-acl defaults too (queries B2b/B3 below), or the Step 6 effective-privilege diff will treat a default-PUBLIC privilege as if `pgadmin_ro` introduced it.

```sql
-- B1. Explicit PUBLIC grants on application tables (grantee 0 = PUBLIC).
SELECT n.nspname, c.relname, c.relkind, a.privilege_type
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
     LATERAL aclexplode(c.relacl) a
WHERE c.relkind IN ('r','p') AND c.relacl IS NOT NULL
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND a.grantee = 0
ORDER BY 1,2,3;
-- Tables default to owner-only (NULL relacl = no PUBLIC access), so the explicit
-- list above is complete for TABLES.

-- B2a. Explicit PUBLIC grants on sequences and functions.
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

-- B2b. NULL-acl FUNCTIONS = DEFAULT EXECUTE to PUBLIC (NOT shown by aclexplode).
--      This is the large, easy-to-miss part of the PUBLIC baseline.
SELECT n.nspname, p.proname, 'function: default PUBLIC EXECUTE' AS note
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.proacl IS NULL AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1,2;

-- B3. Database and schema PUBLIC privileges (explicit ACL rows).
SELECT d.datname, a.privilege_type
FROM pg_database d, LATERAL aclexplode(d.datacl) a
WHERE d.datname='<jackpots_db>' AND a.grantee=0;
SELECT n.nspname, a.privilege_type
FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
WHERE n.nspname='public' AND a.grantee=0;
-- DEFAULTS when the above return NO rows (NULL acl):
--   database NULL datacl  => PUBLIC has CONNECT + TEMP
--   schema  NULL nspacl   => PUBLIC has USAGE (+ CREATE on PG < 15; PG 15+ no CREATE)
-- Record these defaults as part of the baseline.
```
Save B1, B2a, B2b, B3 **and the documented NULL-acl defaults** as the baseline.

## Step 2 — Existing-role check (read-only; HARD STOP if present)

```sql
SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil
FROM pg_roles WHERE rolname = 'pgadmin_ro';
```
- **0 rows** → proceed to Step 3. Record this result: the Step-5 rollback cleanup is permitted **only** because this procedure created the role.
- **1 row** → **STOP.** Do **not** `CREATE` (it would error) and do **not** `ALTER`/`DROP`/overwrite it. Inspect attributes (above), memberships, and privileges:
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

> **Run ONE path only:** either the standalone statement here **or** the Step-5 transaction (which repeats this `CREATE ROLE`). Running both makes the second `CREATE ROLE` fail with "role already exists" and roll the transaction back. The transactional path in Step 5 is recommended.

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
- **RDS auth note (v2):** a `LOGIN` role with no password cannot authenticate **by password**, but if it were a member of `rds_iam` it could authenticate with an **IAM token and no password**. This role is **not** granted `rds_iam`; Step 6f verifies it holds no such membership. (No `trust`/`peer` line applies on RDS.)

## Step 5 — Exact table grants  `[APPROVAL REQUIRED]`

Run Step 6a (existence check) **before** granting; grant only on tables that exist. Standalone grants:
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

### Transaction handling & rollback

`CREATE ROLE` and `GRANT` are transactional in PostgreSQL, so group Steps 3 and 5 into **one** transaction and verify before committing. **This transaction REPLACES the standalone Step 3 `CREATE` and the Step 5 `GRANT` block above — run one path, not both.** The interactive password (Step 4) is a separate client command run **after** commit.

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
-- The transaction is now OPEN and uncommitted. Review the sanity check, then:
--   all eight sel=true AND nothing unexpected  ->  COMMIT;
--   anything wrong                             ->  ROLLBACK;   (leaves no role, no grant)
```
Then set the password separately — **not** inside the transaction, to keep the plaintext out of any scripted statement or log:
```sql
\password pgadmin_ro
```
`\password` issues its own pre-hashed `ALTER ROLE … PASSWORD`; run it after `COMMIT`. Do **not** use `ALTER ROLE … PASSWORD '<plaintext>'` inside the transaction — that would expose the secret.

**Rollback / recovery:**
- Transaction fails or the pre-commit check is wrong → `ROLLBACK;` — nothing persisted, no cleanup.
- Transaction **committed** but `\password` fails or setup is abandoned → the role exists **with no password**, so it cannot authenticate (fail-safe; and it is not in `rds_iam`, per Step 6f). Retry `\password`; or, **only with explicit owner approval** and **only for a role THIS procedure created** (Step 2 returned 0 rows — never a pre-existing role), remove it cleanly:
```sql
-- APPROVAL REQUIRED. Do not run automatically. Only for a role created by THIS procedure.
BEGIN;
  REVOKE ALL ON public.alembic_version, public.flights, public.hotels, public.cruises,
                  public.tour_packages, public.coupons, public.seasonal_prices,
                  public.discount_campaigns FROM pgadmin_ro;
  REVOKE ALL ON SCHEMA public          FROM pgadmin_ro;
  REVOKE ALL ON DATABASE <jackpots_db> FROM pgadmin_ro;
  DROP OWNED BY pgadmin_ro;   -- canonical cleanup of any residual grants in THIS db (none expected)
  DROP ROLE pgadmin_ro;       -- succeeds because pgadmin_ro owns no objects
COMMIT;
```
These statements touch only `pgadmin_ro`'s own grants; no other role's permissions are revoked.

## Step 6 — Effective permission checks (read-only acceptance gate)

> 6a is a **pre-grant** check (Step 5 depends on it); 6b–6f are **post-grant** acceptance checks.

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

-- 6f. (v2) CREATED-role attributes + memberships — the inherited-privilege check.
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolcanlogin, rolconnlimit
FROM pg_roles WHERE rolname='pgadmin_ro';
-- expect: super=f, inherit=f, createrole=f, createdb=f, replication=f,
--         bypassrls=f, canlogin=t, connlimit=3
SELECT g.rolname AS member_of
FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid
WHERE r.rolname='pgadmin_ro';
-- expect: 0 rows — in particular NOT rds_iam, rds_superuser, pg_read_all_data,
--         pg_read_all_stats, or any other role.
```
**Expected:** 6b true-set = the 8 only; 6c empty; 6d all false; 6e `sch_create`/`db_create` false, sequences all false; 6f attributes as noted and memberships empty.

**TEMP note:** `db_temp` will likely be `true` because PUBLIC holds `TEMP` by default. `TEMP` permits only **session-local temporary tables** in the session's own `pg_temp` schema — dropped at disconnect, invisible to others, and **never a write to, or creation of, persistent application data**. It does **not** breach the read-only-on-application-data guarantee. The only lever to remove it is `REVOKE TEMP … FROM PUBLIC` (affects all roles) — **a separate PUBLIC change requiring its own approval**; do not apply it here.

**Baseline diff:** compare `pgadmin_ro`'s effective access (6b/6e + function EXECUTE from Step 7b) against the Step 1b baseline. Every privilege it holds must fall into exactly one of: (a) an **explicit** PUBLIC grant (B1/B2a) ; (b) a **documented NULL-acl default** (B2b function EXECUTE; database CONNECT/TEMP; schema USAGE[/CREATE]); or (c) the **eight SELECT grants + CONNECT + USAGE** created here. The only TABLE `SELECT`s beyond PUBLIC defaults must be the eight. Anything outside (a)/(b)/(c) is an unexpected finding → report; a PUBLIC-origin finding is remedied only with separate approval.

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

-- 7c. SIDE-EFFECT screen of every routine pgadmin_ro can EXECUTE:
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
**Interpretation:**
- `[REPO]` every `sp_*`/`fn_*` is `SECURITY INVOKER`, so a routine `pgadmin_ro` executes runs with **its own** privileges. Table writes (`sp_register_partner`, `sp_create_ticket_request`, …) and sensitive reads (`sp_partner_login_lookup`, `sp_get_*`) fail on `pgadmin_ro`'s empty table privileges.
- **Non-table side effects still execute**: `NOTIFY`/`pg_notify` (a channel message — no data change) and `pg_advisory_*` (a lock) need **no** privilege. `nextval`/`setval` need sequence privileges `pgadmin_ro` lacks (6e confirms) → fail. `dblink`/FDW, large objects, file I/O, `CREATE EXTENSION` need privileges it lacks → fail.
- **Net:** the only reachable side effects are **benign, non-persistent** (a notification, an advisory lock); none modifies or exposes persistent application data. Confirm 7c shows no reachable `fdw_remote`/`file_or_lob`, and 7a is empty.
- **Proposed remedy, reported not applied:** for a strict "execute-nothing" posture, `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` (or apply the role-separation EXECUTE plan) — a PUBLIC change needing separate approval; **not** part of this checklist.

**7c is a SCREENING tool, not proof.** A regex over `pg_proc.prosrc` cannot see:
- **Nested calls** — routine A calls B which writes; A's body shows only the call to B.
- **Dynamic SQL** — `EXECUTE format(...)` / `EXECUTE a_variable` hides the real statement from any static scan.
- **Procedural / external languages** — `prosrc` is readable only for `sql`/`plpgsql`; for `c`/`internal` it is a symbol name, and for untrusted languages (`plpython3u`, `plperlu`, …) it is code this regex cannot parse — such a routine can do almost anything.
- **Extension functions** — the body lives in the extension's shared library, not in `prosrc`.

So 7c flags candidates; it does not clear the rest. Produce the **manual-review list** — routines executable by `pgadmin_ro` that are not plain `sql`/`plpgsql`, are `SECURITY DEFINER`, or use dynamic SQL:
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

## Step 8 — Independent `pgadmin_ro` login test (not `SET ROLE`)  (v2 expanded)

Connect **as pgadmin_ro** through the private tunnel (password at the prompt; RDS stays private):
```bash
psql "host=<rds-endpoint> port=5432 dbname=<jackpots_db> user=pgadmin_ro sslmode=require"
```
Inside that real session run **all** of the following:
```sql
-- (a) ALL EIGHT approved tables must be SELECTable (counts only; no contents needed):
SELECT 'alembic_version' AS t, count(*) FROM alembic_version
UNION ALL SELECT 'flights',            count(*) FROM flights
UNION ALL SELECT 'hotels',             count(*) FROM hotels
UNION ALL SELECT 'cruises',            count(*) FROM cruises
UNION ALL SELECT 'tour_packages',      count(*) FROM tour_packages
UNION ALL SELECT 'coupons',            count(*) FROM coupons
UNION ALL SELECT 'seasonal_prices',    count(*) FROM seasonal_prices
UNION ALL SELECT 'discount_campaigns', count(*) FROM discount_campaigns;

-- (b) sensitive / unapproved reads MUST FAIL (run individually; each errors "permission denied"):
SELECT count(*) FROM users;
SELECT count(*) FROM payments;
SELECT count(*) FROM bookings;
SELECT count(*) FROM user_sessions;
SELECT count(*) FROM contact_us;
-- SELECT count(*) FROM customer_bookings;   -- if present, also permission denied

-- (c) write verbs + schema/db/sequence/function, checked WITHOUT attempting writes
--     (a role may query its own effective privileges):
SELECT has_table_privilege('pgadmin_ro','public.flights','INSERT')  AS ins,   -- false
       has_table_privilege('pgadmin_ro','public.flights','UPDATE')  AS upd,   -- false
       has_table_privilege('pgadmin_ro','public.flights','DELETE')  AS del,   -- false
       has_table_privilege('pgadmin_ro','public.flights','TRUNCATE')AS trunc, -- false
       has_schema_privilege('pgadmin_ro','public','CREATE')         AS sch_create, -- false
       has_database_privilege('pgadmin_ro','<jackpots_db>','CREATE')AS db_create;  -- false

-- (d) structure of a sensitive table via catalog (names/types only, no rows):
SELECT attname FROM pg_attribute
WHERE attrelid='public.users'::regclass AND attnum>0 AND NOT attisdropped;
```
**Pass criteria:** (a) all eight succeed; (b) every sensitive read is denied; (c) all write/create flags false; (d) structure visible, no row data. A real login (not `SET ROLE` from master) is the only thing that exercises `pg_hba`, authentication, the password, `LOGIN`, and `CONNECTION LIMIT`.

## Step 9 — Final acceptance report

Record and hand back:
- **Allowlist:** `alembic_version`, `flights`, `hotels`, `cruises`, `tour_packages`, `coupons`, `seasonal_prices`, `discount_campaigns` + `CONNECT`(db) + `USAGE`(public). Nothing else.
- **Acceptance (all must hold):** 6a 8/8 exist (or grant list reduced accordingly); 6b true-set = exactly those tables; 6c empty; 6d all false; 6e `*_create` false + sequences false; **6f attributes correct + memberships empty (not in `rds_iam`/`rds_superuser`/`pg_read_all_data`)**; 7a empty; 7b no definer-execute risk rows; 7c no reachable remote/file side effect; Step-6 baseline diff delta = exactly the eight SELECT grants; Step 7 manual-review list cleared; Step 8 (a) all eight succeed, (b) sensitive denied, (c) write/create flags false.
- **Findings** `[LIVE-UNKNOWN until run]`: anything from 6c, 6f (unexpected membership), 7a, 7c, or a Step-8 failure. Report to owner; PUBLIC-touching remedies need **separate approval**.
- **Class C census (sensitive tables):** run by the master/DBA, not `pgadmin_ro`; use the **live** timestamp column per the Step-6 schema check — `created_at` for most, **`subscribed_at`** for `newsletter`, **`login_at`** for `user_sessions`, **none** for `roles` (count only). Verify columns live before `MAX(...)`; models may not match the deployed DB.

### Remaining limitations
1. No finding is live-verified until the DBA runs Steps 6–8 against production.
2. Repository models may diverge from the deployed DB — live schema (6a + column checks) governs the grant and census, not the models.
3. PUBLIC `EXECUTE` on functions and PUBLIC `TEMP`/`CONNECT` on the database are live defaults the repo never removed; contained here (no `SECURITY DEFINER`; no table/sequence privileges; TEMP session-local) but not eliminated. Eliminating them is a separate, approval-gated PUBLIC change.
4. Row counts cannot be privilege-limited to exclude contents, so sensitive-table counts stay a DBA/master step (or a reviewed `SECURITY DEFINER` aggregate function), never a SELECT grant.
5. Granting on a partitioned parent cascades to its partitions — none of the 8 is partitioned; 6b catches any that becomes so.
6. Step 7c is static screening only; nested calls, dynamic SQL, and C/untrusted-language or extension routines need the Step 7 manual review before acceptance — a clean 7c scan is not proof of harmlessness.
7. The Step 1b PUBLIC baseline must include the documented NULL-acl defaults (B2b and the DB/schema defaults), or the Step 6 diff will misattribute a default-PUBLIC privilege; the diff compares against explicit grants **plus** those defaults.

---

**Claude executed nothing**: no production SQL, no role, no grant, no connection, no AWS/config change. A clean review does **not** authorize execution. The DBA runs this checklist **only after the owner's separate, explicit approval** of Steps 3–5.
