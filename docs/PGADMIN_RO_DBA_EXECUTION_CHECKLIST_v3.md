# pgadmin_ro — Final DBA Execution Checklist (v3, review-corrected)

**Project:** JackPots World Tours & Travels · **DB:** AWS RDS PostgreSQL (production, **PostgreSQL 18.3**) · **Date:** 2026-11-14
**Supersedes:** `…_v2.md` (preserved) and `…_CHECKLIST.md` (original, preserved). v3 adds two review corrections on top of v2:
- **Removed `DROP OWNED BY pgadmin_ro`** from the rollback — it is a broad command, not a narrow cleanup — and replaced it with an ownership/dependency pre-check + explicit scoped `REVOKE`s + a plain `DROP ROLE` whose non-cascading failure is the safety net.
- **Corrected the ACL defaults to PostgreSQL 18.3**: PUBLIC has **USAGE only** on `public` (no CREATE since PG 15, via an *explicit* ACL), `datacl` NULL ⇒ CONNECT+TEMP→PUBLIC, `proacl` NULL ⇒ EXECUTE→PUBLIC; baseline now separates built-in defaults from actual production ACLs.

All prior findings, restrictions, and the approved eight-table scope are retained. Instructions only — Claude executed no SQL, did not connect to production, created no role or grant.

**Hard gate:** steps 3–5 are the only writes. **The DBA must obtain the owner's separate, explicit approval before executing them.** A review verdict is **not** execution authorization. Steps 1–2 and 6–9 are read-only.

**Labels:** `[REPO]` verified in repository · `[LIVE-UNKNOWN]` only the live DB confirms.

**Standing restrictions (all steps):** do not reset the RDS master password; do not modify `DATABASE_URL`/`MIGRATION_DATABASE_URL`; do not restart the app; do not grant access to sensitive tables; do not use `GRANT ALL`, `ALL TABLES`, or default privileges; **do not revoke any PUBLIC permission without separate approval**; no AWS/security-group/RDS-accessibility change. RDS stays private — connect only through the SSH or SSM tunnel.

Replace `<jackpots_db>` with the real database name throughout.

---

## PostgreSQL 18.3 default-ACL reference (built-in defaults vs actual ACLs)

A column's ACL being **NULL** means "no explicit grants recorded — the built-in default applies"; `aclexplode` returns **no rows** for a NULL ACL. The built-in defaults on 18.3 are:

| Object (NULL acl) | Built-in default on PG 18.3 |
|---|---|
| **Table / sequence** (`relacl` NULL) | owner only — **no PUBLIC access** |
| **Function / procedure** (`proacl` NULL) | **EXECUTE → PUBLIC** |
| **Database** (`datacl` NULL) | **CONNECT + TEMP → PUBLIC** |
| **Schema** (`nspacl` NULL) | owner only — no PUBLIC access |

**The `public` schema is the special case:** on PG 15+ (so 18.3) it ships with an **explicit, non-NULL** ACL granting PUBLIC **USAGE only** — `CREATE` for PUBLIC was removed in PG 15 — and the schema is owned by `pg_database_owner`. So `nspacl` for `public` is normally populated and visible to `aclexplode`; **do not assume PUBLIC holds CREATE on `public`.** Any `CREATE`-to-PUBLIC row on `public`, or any PUBLIC grant beyond these defaults on any object, is a **production customization** to record as a finding — never assumed, always read from the live catalog.

The baseline below therefore captures **actual ACLs** (`aclexplode`) **and** the NULL-acl built-in defaults from the table above; the Step 6 diff compares `pgadmin_ro`'s effective privileges against both.

## Step 1 — Pre-change checks (read-only)

```sql
SELECT current_database(), current_user, version();   -- confirm PostgreSQL 18.3
SELECT version_num FROM alembic_version;               -- note the current revision
```
- Confirm you are on the intended **production** database and connected as the **master/rds_superuser** (the only role that may create roles on RDS — an in-database operation needing no AWS IAM change).
- Confirm a **verified backup/snapshot exists** (a snapshot protects *data*, not the master password — irrelevant here since the password is unchanged, but required policy before any change).

### Step 1b — PUBLIC permission baseline (read-only; capture and SAVE the output)

Captured **before** the role exists; re-run in Step 6 and diffed, so a pre-existing PUBLIC permission is never mistaken for one introduced by `pgadmin_ro`. Record both the query output **and** the applicable NULL-acl defaults from the 18.3 table above.

```sql
-- B1. Explicit PUBLIC grants on application tables (grantee 0 = PUBLIC).
SELECT n.nspname, c.relname, c.relkind, a.privilege_type
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
     LATERAL aclexplode(c.relacl) a
WHERE c.relkind IN ('r','p') AND c.relacl IS NOT NULL
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND a.grantee = 0
ORDER BY 1,2,3;
-- Tables default to owner-only (NULL relacl = no PUBLIC access), so this explicit
-- list is complete for TABLES; a row here is a non-default PUBLIC grant => note it.

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
SELECT n.nspname, p.proname, 'function: default PUBLIC EXECUTE' AS note
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.proacl IS NULL AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1,2;

-- B3. Database and schema PUBLIC privileges (ACTUAL acl rows).
SELECT d.datname, a.privilege_type
FROM pg_database d, LATERAL aclexplode(d.datacl) a
WHERE d.datname='<jackpots_db>' AND a.grantee=0;
--  NO rows => datacl is NULL => built-in default: PUBLIC has CONNECT + TEMP.
SELECT n.nspname, a.privilege_type
FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
WHERE n.nspname='public' AND a.grantee=0;
--  On 18.3 expect exactly: USAGE (and NOT CREATE). A CREATE row => a non-default
--  customization to flag. NO rows (NULL nspacl) is unusual on 18.3 and should be
--  investigated, not assumed to mean USAGE+CREATE.
```
Save B1, B2a, B2b, B3 **and** the 18.3 NULL-acl defaults as the baseline.

## Step 2 — Existing-role check (read-only; HARD STOP if present)

```sql
SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil
FROM pg_roles WHERE rolname = 'pgadmin_ro';
```
- **0 rows** → proceed to Step 3. **Record this result** — the Step-5 cleanup is permitted *only* because this procedure created the role.
- **1 row** → **STOP.** Do **not** `CREATE` and do **not** `ALTER`/`DROP`/overwrite it. Inspect attributes, memberships, privileges (queries below) and report to the owner; never reconcile an existing role automatically.
```sql
SELECT g.rolname AS member_of
FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid
WHERE r.rolname='pgadmin_ro';
SELECT n.nspname, c.relname, has_table_privilege('pgadmin_ro', c.oid,'SELECT') AS can_select
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
  AND has_table_privilege('pgadmin_ro', c.oid,'SELECT') ORDER BY 1,2;
```

## Step 3 — Approved role creation  `[APPROVAL REQUIRED]`

> **Run ONE path only:** the standalone statement here **or** the Step-5 transaction (which repeats this `CREATE ROLE`). Running both makes the second `CREATE ROLE` fail with "role already exists" and roll the transaction back. The transactional path is recommended.

```sql
CREATE ROLE pgadmin_ro
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 3;
```

## Step 4 — Password setup (interactive; never echoed/logged)  `[APPROVAL REQUIRED]`

```sql
\password pgadmin_ro
```
- psql prompts and sends a pre-hashed `ALTER ROLE … PASSWORD` — plaintext never reaches the command line, shell history, or a script file. (pgAdmin alternative: role Properties → Definition → Password field.) Until set, RDS password auth refuses the login.
- **RDS auth note:** a `LOGIN` role with no password cannot authenticate **by password**, but a member of `rds_iam` could authenticate with an **IAM token and no password**. This role is **not** granted `rds_iam`; Step 6f verifies it holds no such membership. No `trust`/`peer` line applies on RDS.

## Step 5 — Exact table grants  `[APPROVAL REQUIRED]`

Run Step 6a (existence check) **before** granting; grant only on tables that exist. Standalone grants:
```sql
GRANT CONNECT ON DATABASE <jackpots_db> TO pgadmin_ro;
GRANT USAGE   ON SCHEMA   public         TO pgadmin_ro;   -- (USAGE is also a PUBLIC default
                                                          --  on 18.3; this makes it explicit)
GRANT SELECT ON
    public.alembic_version,
    public.flights, public.hotels, public.cruises, public.tour_packages,
    public.coupons, public.seasonal_prices, public.discount_campaigns
  TO pgadmin_ro;
```
**This is the complete allowlist.** No other table, no `ALL TABLES`, no `ALTER DEFAULT PRIVILEGES`, no sequence/function grant.

### Transaction handling

`CREATE ROLE` and `GRANT` are transactional in PostgreSQL, so group Steps 3 and 5 into **one** transaction and verify before committing. **This transaction REPLACES the standalone Step 3 `CREATE` and the Step 5 `GRANT` block — run one path, not both.** The password (Step 4) is a separate client command run **after** commit.

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
  SELECT t, has_table_privilege('pgadmin_ro', t, 'SELECT') AS sel
  FROM unnest(ARRAY['public.alembic_version','public.flights','public.hotels',
    'public.cruises','public.tour_packages','public.coupons',
    'public.seasonal_prices','public.discount_campaigns']) t;
-- Transaction is OPEN and uncommitted. Review the sanity check, then:
--   all eight sel=true AND nothing unexpected  ->  COMMIT;
--   anything wrong                             ->  ROLLBACK;   (leaves no role, no grant)
```
Then set the password separately:
```sql
\password pgadmin_ro
```
Do **not** use `ALTER ROLE … PASSWORD '<plaintext>'` inside the transaction — it would expose the secret.

### Rollback / recovery (v3: safe cleanup, no `DROP OWNED BY`)

- Transaction fails or the pre-commit check is wrong → `ROLLBACK;` — nothing persisted, no cleanup.
- Transaction **committed** but `\password` fails or setup is abandoned → the role exists **with no password**, so it cannot authenticate (fail-safe; and it is not in `rds_iam`, per Step 6f). Retry `\password`; or, to remove it, use the procedure below.

**Why NOT `DROP OWNED BY pgadmin_ro`:** in the current database `DROP OWNED BY` **drops every object the role owns** and **revokes every privilege granted to the role**, and it also removes the role's privileges on **shared objects** (databases, tablespaces, configuration parameters). It is a broad, cascading cleanup — **not** a narrow "remove our grants" command. If the role name were wrong, or the role had ever been made the owner of any object, `DROP OWNED BY` would silently destroy those objects. It is therefore excluded.

**Approved cleanup — only with explicit owner approval, and only for a role THIS procedure created (Step 2 returned 0 rows; never a pre-existing role):**
```sql
-- (1) PRE-CLEANUP VERIFICATION (read-only). The role must own NOTHING.
SELECT c.relkind::text AS kind, n.nspname, c.relname AS name
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname='pgadmin_ro')
UNION ALL
SELECT 'function', n.nspname, p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname='pgadmin_ro')
UNION ALL
SELECT 'schema', n.nspname, NULL
FROM pg_namespace n
WHERE n.nspowner = (SELECT oid FROM pg_roles WHERE rolname='pgadmin_ro');
-- EXPECT 0 ROWS. Any row => the role owns an object => STOP and investigate; do NOT drop.

-- Dependencies recorded on the role across the cluster (deptype 'a' = our grants).
SELECT dbid, classid::regclass AS catalog, objid, deptype
FROM pg_shdepend WHERE refobjid = (SELECT oid FROM pg_roles WHERE rolname='pgadmin_ro');
-- EXPECT only 'a' (ACL/grant) rows in THIS database. An 'o' (owner) row => STOP.

-- (2) EXPLICIT, SCOPED REVOKES + plain DROP ROLE (NO cascade; its failure is the safety net).
BEGIN;
  REVOKE ALL ON public.alembic_version, public.flights, public.hotels, public.cruises,
                  public.tour_packages, public.coupons, public.seasonal_prices,
                  public.discount_campaigns FROM pgadmin_ro;
  REVOKE ALL ON SCHEMA public          FROM pgadmin_ro;
  REVOKE ALL ON DATABASE <jackpots_db> FROM pgadmin_ro;
  DROP ROLE pgadmin_ro;   -- there is no DROP ROLE ... CASCADE; this FAILS if anything still
                          -- depends on the role. A failure means investigate, never force.
COMMIT;
```
These statements affect **only** `pgadmin_ro`'s own grants and name only the eight approved objects — no other role's permissions and no unrelated object are touched. If `DROP ROLE` errors, do not override it: resolve the reported dependency (or leave the passwordless, unusable role in place) and report to the owner.

## Step 6 — Effective permission checks (read-only acceptance gate)

> 6a is a **pre-grant** check (Step 5 depends on it); 6b–6f are **post-grant** acceptance checks.

```sql
-- 6a. The 8 grant-list tables exist (grant only where exists=true).
SELECT t AS proposed_table, to_regclass(t) IS NOT NULL AS exists
FROM unnest(ARRAY['public.alembic_version','public.flights','public.hotels',
  'public.cruises','public.tour_packages','public.coupons',
  'public.seasonal_prices','public.discount_campaigns']) t;

-- 6b. EFFECTIVE SELECT (incl. PUBLIC + inherited) on EVERY ordinary/partitioned table —
--     expect ONLY the 8 true; every customer_*, payment, wallet, partner_*, session,
--     users table false.
SELECT n.nspname AS schema, c.relname AS tbl, c.relkind,
       has_table_privilege('pgadmin_ro', c.oid, 'SELECT') AS can_select
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY can_select DESC, 1,2;

-- 6c. Unexpected PUBLIC grants on application tables.
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
       has_schema_privilege('pgadmin_ro','public','CREATE') AS sch_create,  -- MUST be false on 18.3
       has_database_privilege('pgadmin_ro','<jackpots_db>','CONNECT') AS db_connect, -- true
       has_database_privilege('pgadmin_ro','<jackpots_db>','CREATE')  AS db_create,  -- false
       has_database_privilege('pgadmin_ro','<jackpots_db>','TEMP')    AS db_temp;    -- see note
SELECT n.nspname, c.relname AS seq,
       has_sequence_privilege('pgadmin_ro', c.oid,'USAGE')  AS usage,
       has_sequence_privilege('pgadmin_ro', c.oid,'SELECT') AS sel,
       has_sequence_privilege('pgadmin_ro', c.oid,'UPDATE') AS upd
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;

-- 6f. CREATED-role attributes + memberships — the inherited-privilege check.
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
**Expected:** 6b true-set = the 8 only; 6c empty; 6d all false; 6e `sch_create`/`db_create` false (on 18.3 PUBLIC has no CREATE on `public`, so `sch_create` must be false), sequences all false; 6f attributes as noted and memberships empty.

**TEMP note:** `db_temp` will likely be `true` (PUBLIC `TEMP` default). `TEMP` permits only **session-local temporary tables** in the session's own `pg_temp` schema — dropped at disconnect, invisible to others, **never a write to, or creation of, persistent application data**. It does not breach the read-only guarantee. Removing it means `REVOKE TEMP … FROM PUBLIC` (all roles) — **separate approval**; not applied here.

**Baseline diff:** compare `pgadmin_ro`'s effective access (6b/6e + function EXECUTE from Step 7b) against the Step 1b baseline. Every privilege it holds must fall into exactly one of: (a) an **explicit** PUBLIC grant (B1/B2a/B3); (b) an **18.3 NULL-acl default** (function EXECUTE; database CONNECT/TEMP; schema `public` USAGE); or (c) the **eight SELECT grants + CONNECT + USAGE** created here. The only TABLE `SELECT`s beyond PUBLIC defaults must be the eight. Anything else is an unexpected finding → report; a PUBLIC-origin finding is remedied only with separate approval.

## Step 7 — Function & procedure security checks (read-only)

```sql
-- 7a. ALL SECURITY DEFINER routines (repo expectation: ZERO). Any row => out-of-band => investigate.
SELECT n.nspname, p.proname, pg_get_userbyid(p.proowner) AS owner,
       pg_get_function_identity_arguments(p.oid) AS args, p.prokind
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;

-- 7b. Effective EXECUTE for pgadmin_ro (incl. PUBLIC). RISK = security_definer true AND can_execute true.
SELECT n.nspname, p.proname, p.prosecdef AS security_definer,
       pg_get_userbyid(p.proowner) AS owner,
       has_function_privilege('pgadmin_ro', p.oid,'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY security_definer DESC, can_execute DESC, 1,2;

-- 7c. SIDE-EFFECT screen of every routine pgadmin_ro can EXECUTE (SECURITY INVOKER != side-effect-free).
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
- `[REPO]` every `sp_*`/`fn_*` is `SECURITY INVOKER`, so a routine `pgadmin_ro` executes runs with **its own** privileges. Table writes and sensitive reads inside them fail on `pgadmin_ro`'s empty table privileges.
- **Non-table side effects still execute:** `NOTIFY`/`pg_notify` (a channel message) and `pg_advisory_*` (a lock) need **no** privilege. `nextval`/`setval` need sequence privileges it lacks (6e) → fail. `dblink`/FDW, large objects, file I/O, `CREATE EXTENSION` need privileges it lacks → fail.
- **Net:** only **benign, non-persistent** side effects (a notification, an advisory lock) are reachable; none modifies or exposes persistent application data. Confirm 7c shows no reachable `fdw_remote`/`file_or_lob`, and 7a is empty.
- **Remedy, reported not applied:** a strict "execute-nothing" posture = `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` — a PUBLIC change needing separate approval; not part of this checklist.

**7c is a SCREENING tool, not proof.** A regex over `pg_proc.prosrc` cannot see **nested calls**, **dynamic SQL** (`EXECUTE format(...)`), **procedural/external languages** (`prosrc` is a symbol name for `c`/`internal`; untrusted-language code is unparsed), or **extension function bodies**. Produce the **manual-review list**:
```sql
SELECT n.nspname, p.proname, l.lanname AS language, p.prosecdef AS security_definer,
       (p.prosrc ~* 'execute\s') AS dynamic_sql,
       has_function_privilege('pgadmin_ro', p.oid,'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
JOIN pg_language l ON l.oid=p.prolang
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND has_function_privilege('pgadmin_ro', p.oid,'EXECUTE')
  AND ( l.lanname NOT IN ('sql','plpgsql') OR p.prosecdef OR p.prosrc ~* 'execute\s' )
ORDER BY 1,2;
```
Each routine returned gets a human read of `pg_get_functiondef(p.oid)` before acceptance — reviewed, never executed or modified. `[REPO]` the known `sp_*`/`fn_*` are `sql`/`plpgsql` and `SECURITY INVOKER`; `[LIVE-UNKNOWN]` whether production holds any C/untrusted-language, definer, or dynamic-SQL routine executable by `pgadmin_ro`.

## Step 8 — Independent `pgadmin_ro` login test (not `SET ROLE`)

Connect **as pgadmin_ro** through the private tunnel (password at the prompt; RDS stays private):
```bash
psql "host=<rds-endpoint> port=5432 dbname=<jackpots_db> user=pgadmin_ro sslmode=require"
```
Inside that real session run **all** of:
```sql
-- (a) ALL EIGHT approved tables must be SELECTable:
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

-- (c) write verbs + schema/db privileges, checked WITHOUT attempting writes:
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
**Pass criteria:** (a) all eight succeed; (b) every sensitive read denied; (c) all write/create flags false; (d) structure visible, no row data. A real login (not `SET ROLE`) is the only thing that exercises `pg_hba`, authentication, the password, `LOGIN`, and `CONNECTION LIMIT`.

## Step 9 — Final acceptance report

- **Allowlist:** `alembic_version`, `flights`, `hotels`, `cruises`, `tour_packages`, `coupons`, `seasonal_prices`, `discount_campaigns` + `CONNECT`(db) + `USAGE`(public). Nothing else.
- **Acceptance (all must hold):** 6a 8/8 exist (or list reduced); 6b true-set = exactly those; 6c empty; 6d all false; 6e `sch_create` false (18.3: no PUBLIC CREATE on `public`), `db_create` false, sequences false; 6f attributes correct + memberships empty (not `rds_iam`/`rds_superuser`/`pg_read_all_data`); 7a empty; 7b no definer-execute risk rows; 7c no reachable remote/file side effect; Step-6 baseline diff delta = exactly the eight SELECT grants; Step 7 manual-review list cleared; Step 8 (a) all eight succeed, (b) sensitive denied, (c) write/create flags false.
- **Findings** `[LIVE-UNKNOWN until run]`: anything from 6c, 6f, 7a, 7c, a Step-8 failure, or a non-default PUBLIC ACL (e.g. a CREATE-to-PUBLIC on `public`). Report to owner; PUBLIC-touching remedies need **separate approval**.
- **Class C census (sensitive tables):** run by master/DBA, not `pgadmin_ro`; use the **live** timestamp column — `created_at` for most, **`subscribed_at`** for `newsletter`, **`login_at`** for `user_sessions`, **none** for `roles` (count only). Verify columns live before `MAX(...)`.

### Remaining limitations
1. No finding is live-verified until the DBA runs Steps 6–8 against production.
2. Repository models may diverge from the deployed DB — live schema governs the grant and census.
3. PUBLIC `EXECUTE` on functions and PUBLIC `TEMP`/`CONNECT` on the database (and `USAGE` on `public`) are 18.3 defaults the repo never removed; contained here (no `SECURITY DEFINER`; no table/sequence privileges; TEMP session-local) but not eliminated — removal is a separate, approval-gated PUBLIC change.
4. Row counts cannot be privilege-limited to exclude contents; sensitive-table counts stay a DBA/master step, never a SELECT grant.
5. Granting on a partitioned parent cascades to its partitions — none of the 8 is partitioned; 6b catches any that becomes so.
6. Step 7c is static screening only; nested calls, dynamic SQL, and C/untrusted-language or extension routines need the Step 7 manual review — a clean 7c scan is not proof.
7. The Step 1b baseline must combine actual ACLs with the 18.3 NULL-acl defaults; the Step 6 diff compares against both. Do not assume PUBLIC has CREATE on `public` — on 18.3 it does not.
8. Cleanup never uses `DROP OWNED BY` (which drops owned objects and revokes privileges broadly, incl. on shared objects). It uses an ownership/dependency pre-check, explicit scoped `REVOKE`s, and a plain `DROP ROLE` whose non-cascading failure is the safety net; it is approval-gated and never run against a pre-existing role.

---

**Claude executed nothing**: no production SQL, no role, no grant, no connection, no AWS/config change. **A clean review does NOT authorize execution.** The DBA runs this checklist **only after the owner's separate, explicit approval** of Steps 3–5.
