# pgadmin_ro — DBA Execution Checklist V4 (REVISED, structure-inspection account)

**Project:** JackPots World Tours & Travels · **Date:** 2026-11-14
**Supersedes for review:** `…_V4.md`. This is a document correction of V4 applying four review findings — (1) Section 10.2 alias `AS x(table_name)`; (2) Section 10.1 now checks relation kinds `r,p,v,m,f`; (3) Section 5 pgAdmin behavior qualified as *expected, independently testable*; (4) the two PUBLIC-default `EXECUTE` trigger functions retained, with no claim of zero effective function EXECUTE. **V1, V2, V3 and V4 are preserved unchanged** as historical versions. All verified production facts and the full 16-section structure are retained.

**Prepared read-only.** Claude executed no SQL, did not connect to production, created no role or grant. Every production-changing statement is banner-marked; read-only checks are kept separate.

---

## 1. Objective and scope

Create a dedicated login role **`pgadmin_ro`** used through pgAdmin to inspect, read-only:
- database structure; schemas and table names; column names and data types;
- primary keys and foreign keys; indexes and constraints; permitted PostgreSQL metadata.

**Explicitly out of scope / not built here:** reading application table records; monitoring or screening systems; dashboards or monitoring views; customer-activity tracking; audit monitoring; background-job monitoring; any application development. This is **strictly a database-structure inspection account**.

## 2. Verified production environment

| Item | Value |
|---|---|
| Database | `jackpotsworldtours` |
| PostgreSQL | 18.3 |
| AWS region | `ap-south-1` (Mumbai) |
| RDS endpoint | `jackpotsworld-db.cn4gc8gqed90.ap-south-1.rds.amazonaws.com` |
| Port | 5432 |
| Access path | Private, via EC2 + AWS SSM Session Manager (RDS stays private — **do not** make it public) |
| Existing app role | `jpwadmin` (member of `rds_superuser`; owns the application tables) |
| New account | `pgadmin_ro` (does not currently exist) |

## 3. Actual production schema findings (live-verified by the owner)

- **73 application tables** in schema `public`; **1,005 columns** total. All 73 are in `public`.
- The earlier eight-table allowlist was **incorrect**; only `alembic_version` from it exists. It is **not** reused.
- The account is **not** intended to read application table records, so no table is placed on any SELECT allowlist.
- Named tables referenced later (from your findings, not invented): `alembic_version`, `audit_logs`, and the audit-triggered set `merchants, payment_accounts, payments, request_documents, request_notes, service_requests, users, wallet_topups`.

## 4. Security findings (live-verified)

- **Role:** `pgadmin_ro` does not exist. `jpwadmin` is a member of `rds_superuser` and owns the app tables — `pgadmin_ro` must have **no** relationship to it.
- **Database `jackpotsworldtours` ACL:** PUBLIC has `CONNECT` + `TEMPORARY`, **not** `CREATE`; `jpwadmin` has `CONNECT`/`CREATE`/`TEMPORARY`.
- **Schema `public` ACL:** PUBLIC has `USAGE`, **not** `CREATE`; `pg_database_owner` has `CREATE`+`USAGE`. (Consistent with PG 18.3, where PUBLIC lost `CREATE` on `public` in PG 15.)
- **PUBLIC object privileges:** no effective PUBLIC table/view or sequence privileges in `public`. **Two trigger functions carry the default PUBLIC EXECUTE:** `fn_set_updated_at()` and `fn_write_audit_log()`. These are existing application functions — **not modified, not revoked, not re-granted** here.
- **Audit trigger:** `fn_write_audit_log()` is attached to `merchants, payment_accounts, payments, request_documents, request_notes, service_requests, users, wallet_topups` and writes old/new row JSON to `audit_logs`. `pgadmin_ro` is given **no** access to those tables or to `audit_logs`.

## 5. Proposed minimum-privilege role design

**Grants:** exactly two — `CONNECT` on the database and `USAGE` on schema `public`. **Nothing else.** No table SELECT, no sequence, no function EXECUTE grant, no `CREATE`, no `TEMPORARY`, no membership.

**Why no table SELECT is needed.** pgAdmin's object browser, the SQL/DDL reconstruction, and the Dependencies/ERD tools read **`pg_catalog`** (`pg_class`, `pg_attribute`, `pg_constraint`, `pg_index`, `pg_namespace`, …), which is readable by **every** role regardless of table privileges. So all 73 tables' structure — names, columns, types, PKs, FKs, indexes, constraints — is visible from the catalog with **no** data privilege.

**Expected pgAdmin behavior — to be independently verified with `pgadmin_ro` (Sections 11–12), not asserted as fact (revision finding 3):** the claims below describe how pgAdmin is *expected* to behave for a catalog-only role on 18.3. Actual object-browser, DDL, Dependencies and ERD behavior **must be confirmed by logging in as `pgadmin_ro`** and exercising each feature; treat any deviation as a finding, and do **not** add a table grant to "fix" a cosmetic gap without separate approval.
- **Expected visible (verify in Sections 11–12):** the full object tree (databases → schemas → tables/views → columns, keys, indexes, constraints), each object's *Properties* and reconstructed *SQL/DDL*, Dependencies/Dependents, and the ERD built from catalog foreign keys.
- **Expected unavailable by design:** *View/Edit Data*, row counts, and the data grid (any `SELECT` on an application table should return `permission denied`). The *Statistics* tab that queries a table's own stats may be partially blank (needs table privileges or `pg_read_all_stats`, which are **not** granted).
- **`information_schema` caveat (important):** `information_schema` views are **privilege-filtered** — they show a role only the objects it has privileges on. Because `pgadmin_ro` has no table privileges, `information_schema.tables`/`.columns` will appear **empty** to it. This is expected and is **not** a reason to grant table SELECT: pgAdmin uses `pg_catalog` (not `information_schema`) for structure. Hand-written `information_schema` queries should be rewritten against `pg_catalog`.

**Effective function EXECUTE is NOT zero (revision finding 4):** although this checklist grants **no** function EXECUTE, `pgadmin_ro` still **inherits** PostgreSQL's default `EXECUTE`-to-PUBLIC on the two application trigger functions `fn_set_updated_at()` and `fn_write_audit_log()` (and any other function whose `proacl` is NULL). This is existing PUBLIC behavior that this task does not change; it is quantified in Section 10.4 and assessed as harmless in the fn_* note there. Do not describe the role as having zero effective function EXECUTE.

**Note on CONNECT/USAGE redundancy:** PUBLIC already confers `CONNECT` and schema `USAGE`, so `pgadmin_ro` would inherit both even with no grant. They are granted **explicitly** so the account does not silently depend on PUBLIC defaults (which a future hardening might revoke) — not because a direct grant is strictly required today.

## 6. Pre-execution checks  *(READ-ONLY — safe to run now)*

> All queries in this section **read** only; they change nothing. Run as `jpwadmin`/master through the SSM tunnel.

```sql
-- 6.1 Confirm environment.
SELECT current_database(), current_user, version();
```
Purpose: confirm DB `jackpotsworldtours` and PG 18.3. · Reads only. · Needs: none. · Side effects: none. · Expected: database = `jackpotsworldtours`, version 18.3.

```sql
-- 6.2 Does pgadmin_ro already exist?  HARD STOP if it does.
SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolconnlimit
FROM pg_roles WHERE rolname = 'pgadmin_ro';
```
Purpose: existence/attribute check. · Reads only. · Needs: catalog read (any role). · Expected: **0 rows**. If **1 row → STOP**; do not modify or reuse it; report to the owner. Record the 0-row result — it authorizes the Section-14 cleanup later.

```sql
-- 6.3 Baseline: PUBLIC privileges that pgadmin_ro would inherit.
-- 6.3a database-level PUBLIC privileges (grantee 0 = PUBLIC):
SELECT a.privilege_type
FROM pg_database d, LATERAL aclexplode(d.datacl) a
WHERE d.datname = 'jackpotsworldtours' AND a.grantee = 0;        -- expect CONNECT, TEMPORARY (no CREATE)
-- 6.3b schema public PUBLIC privileges:
SELECT a.privilege_type
FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
WHERE n.nspname = 'public' AND a.grantee = 0;                    -- expect USAGE (no CREATE)
-- 6.3c functions with default PUBLIC EXECUTE (NULL proacl):
SELECT n.nspname, p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proacl IS NULL AND n.nspname = 'public'
ORDER BY 1,2;                                                    -- expect fn_set_updated_at, fn_write_audit_log (+ any other app triggers)
```
Purpose: record what `pgadmin_ro` inherits via PUBLIC so Section 10's diff attributes it correctly. · Reads only. · Needs: catalog read. · Expected: as annotated.

## 7. Role creation SQL proposal  `REQUIRES EXPLICIT DBA AND OWNER APPROVAL — DO NOT EXECUTE YET`

```sql
CREATE ROLE pgadmin_ro
  LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 3;
```
Purpose: create the least-privilege login role. · **Changes production.** · Needs: `CREATEROLE` (held by `jpwadmin`/`rds_superuser` — run as master/`jpwadmin`). · Side effects: a new role with **no** password yet (cannot authenticate until Section 8) and **no** object privileges. It is **not** a member of any role and `NOINHERIT` blocks inherited role privileges. · Expected: role exists; Section 10.6 shows all attribute flags false except `LOGIN`.

## 8. Password setup procedure  `REQUIRES EXPLICIT DBA AND OWNER APPROVAL — DO NOT EXECUTE YET`

```text
\password pgadmin_ro
```
Purpose: set the password interactively. · **Changes production** (sets the role's password). · Needs: run as a role that may alter `pgadmin_ro` (master/`jpwadmin`). · Side effects: psql prompts and sends a **pre-hashed** `ALTER ROLE … PASSWORD`; the plaintext never appears on the command line, in shell history, in this document, or in logs. Do **not** hardcode a password or use `ALTER ROLE … PASSWORD '<plaintext>'`. (pgAdmin alternative: role Properties → Definition → Password field.) · Expected: login succeeds in Section 11; until set, RDS password auth refuses the login.

## 9. Minimum required GRANT statements, with justification  `REQUIRES EXPLICIT DBA AND OWNER APPROVAL — DO NOT EXECUTE YET`

```sql
GRANT CONNECT ON DATABASE jackpotsworldtours TO pgadmin_ro;
GRANT USAGE   ON SCHEMA   public             TO pgadmin_ro;
```
- `GRANT CONNECT …` — purpose: allow the account to open the database. · Changes production. · Needs: DB owner or `rds_superuser`. · Side effects: connection permitted (also already available via PUBLIC; explicit for durability). · Expected: `has_database_privilege('pgadmin_ro','jackpotsworldtours','CONNECT')` = true.
- `GRANT USAGE ON SCHEMA public …` — purpose: allow name resolution / object access in `public` for browsing. · Changes production. · Needs: schema owner (`pg_database_owner`) or `rds_superuser`. · Side effects: schema usable (also already via PUBLIC; explicit for durability). · Expected: `has_schema_privilege('pgadmin_ro','public','USAGE')` = true.

**Not granted (and why):** no `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER` on any table (structure comes from `pg_catalog`; records are out of scope); no `ALL PRIVILEGES`, `ALL TABLES`, `ALL SEQUENCES`, or `ALTER DEFAULT PRIVILEGES` (would grant broad/future access); no sequence `USAGE`/`SELECT`/`UPDATE`; **no function `EXECUTE` grant** — note this does **not** make effective EXECUTE zero: the role still inherits PUBLIC's default EXECUTE on `fn_set_updated_at()` and `fn_write_audit_log()` (Section 10.4), which this task leaves unchanged; no `CREATE` on database or schema; no `TEMPORARY` (not needed for inspection — PUBLIC's existing TEMP is left untouched, not extended); no membership in `jpwadmin`, `rds_superuser`, or any role.

## 10. Effective permission verification  *(READ-ONLY — run after Sections 7–9 are approved and executed)*

> Evaluates **effective** privileges (direct + PUBLIC + inherited). Reads only.

```sql
-- 10.1 Effective SELECT on EVERY readable relation in application schemas —
--      ordinary 'r', partitioned 'p', view 'v', materialized view 'm', foreign table 'f' —
--      expect ALL false (no grants, no PUBLIC table privilege). No app data readable.
SELECT n.nspname, c.relname,
       CASE c.relkind WHEN 'r' THEN 'table'
                      WHEN 'p' THEN 'partitioned table'
                      WHEN 'v' THEN 'view'
                      WHEN 'm' THEN 'materialized view'
                      WHEN 'f' THEN 'foreign table' END AS kind,
       has_table_privilege('pgadmin_ro', c.oid, 'SELECT') AS can_select
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','v','m','f')
  AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY can_select DESC, 1,2;              -- expected: zero rows with can_select = true

-- 10.2 Effective SELECT + write verbs on the named sensitive tables — expect all false.
SELECT x.table_name,
  has_table_privilege('pgadmin_ro', x.table_name, 'SELECT') AS sel,
  has_table_privilege('pgadmin_ro', x.table_name, 'INSERT') AS ins,
  has_table_privilege('pgadmin_ro', x.table_name, 'UPDATE') AS upd,
  has_table_privilege('pgadmin_ro', x.table_name, 'DELETE') AS del
FROM unnest(ARRAY['public.users','public.payments','public.merchants',
  'public.service_requests','public.audit_logs','public.wallet_topups'])
     AS x(table_name)
ORDER BY x.table_name;

-- 10.3 Sequence privileges — expect all false.
SELECT n.nspname, c.relname AS seq,
       has_sequence_privilege('pgadmin_ro', c.oid,'USAGE')  AS usage,
       has_sequence_privilege('pgadmin_ro', c.oid,'SELECT') AS sel,
       has_sequence_privilege('pgadmin_ro', c.oid,'UPDATE') AS upd
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;

-- 10.4 Function EXECUTE for pgadmin_ro — expect TRUE only for the two PUBLIC-default
--      trigger functions (effective EXECUTE is NOT zero); no SECURITY DEFINER anywhere.
SELECT n.nspname, p.proname, p.prosecdef AS security_definer,
       has_function_privilege('pgadmin_ro', p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY can_execute DESC, security_definer DESC, 2;

-- 10.5 Database + schema privileges.
SELECT has_database_privilege('pgadmin_ro','jackpotsworldtours','CONNECT') AS db_connect, -- true
       has_database_privilege('pgadmin_ro','jackpotsworldtours','CREATE')  AS db_create,  -- false
       has_database_privilege('pgadmin_ro','jackpotsworldtours','TEMP')    AS db_temp,    -- see note
       has_schema_privilege('pgadmin_ro','public','USAGE')  AS sch_usage,   -- true
       has_schema_privilege('pgadmin_ro','public','CREATE') AS sch_create;  -- false

-- 10.6 Role attributes + memberships.
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolreplication, rolbypassrls, rolcanlogin, rolconnlimit
FROM pg_roles WHERE rolname = 'pgadmin_ro';   -- super/inherit/createrole/createdb/replication/bypassrls = f; canlogin = t; connlimit = 3
SELECT g.rolname AS member_of
FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
WHERE r.rolname = 'pgadmin_ro';               -- expect 0 rows; in particular NOT jpwadmin, rds_superuser, pg_read_all_data, pg_read_all_stats
```
**Expected summary:** 10.1 no `true` across `r/p/v/m/f`; 10.2 all false; 10.3 all false; 10.4 `can_execute` true **only** for `fn_set_updated_at()` and `fn_write_audit_log()` (inherited via PUBLIC — effective EXECUTE is not zero) and `security_definer` false for all; 10.5 `db_connect`/`sch_usage` true, `db_create`/`sch_create` false; 10.6 attributes as noted, memberships empty.

**`db_temp` note:** likely `true` (PUBLIC holds `TEMPORARY`). This permits only session-local temp tables in the connection's own `pg_temp` — never a write to or creation of persistent application data. We do **not** grant it and do **not** revoke PUBLIC's TEMP (a PUBLIC change requiring separate approval).

**fn_* note:** `pgadmin_ro` inheriting PUBLIC EXECUTE on the two trigger functions is harmless: they are `RETURNS trigger` functions that error if invoked directly (they reference `TG_OP`/`NEW`/`OLD`), and as `SECURITY INVOKER` any write they attempt (e.g. `fn_write_audit_log` inserting into `audit_logs`) runs as `pgadmin_ro`, which has no such privilege. We neither grant nor revoke them.

## 11. Independent pgAdmin login testing  *(after Sections 7–9 executed)*

Open the private tunnel with SSM (RDS stays private — no public access, no security-group change):
```bash
aws ssm start-session \
  --region ap-south-1 \
  --target <ec2-instance-id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host="jackpotsworld-db.cn4gc8gqed90.ap-south-1.rds.amazonaws.com",portNumber="5432",localPortNumber="5432"
```
Then point pgAdmin (or psql) at `localhost:5432`, database `jackpotsworldtours`, user `pgadmin_ro`, **SSL mode = require**, password at the prompt. This is a **real, independent login** (not `SET ROLE` from master) — the only thing that exercises `pg_hba`, authentication, the password, `LOGIN`, and `CONNECTION LIMIT`.
Confirm the Section-5 *expected* behavior for real: the object tree expands and shows schemas, all 73 tables, their columns, keys, indexes, and constraints; Properties/SQL, Dependencies and ERD render. Record any feature that does not behave as expected.

## 12. Read-only operation testing (what SHOULD work)  *(as pgadmin_ro)*

Structure inspection via `pg_catalog` — all succeed with no table privilege:
```sql
-- tables in public
SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY 1;
-- columns of one table (structure only, no data)
SELECT a.attname, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull
FROM pg_attribute a WHERE a.attrelid='public.users'::regclass AND a.attnum>0 AND NOT a.attisdropped
ORDER BY a.attnum;
-- primary & foreign keys
SELECT conrelid::regclass AS tbl, conname, contype, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('p','f') ORDER BY 1,2;
-- indexes
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2;
```
Reads only; needs only catalog visibility (every role has it) + schema `USAGE`. Expected: full structure of all 73 tables, including the sensitive ones, **without** exposing any row.
**Note:** `information_schema` queries will return **empty** for application tables (privilege-filtered) — use `pg_catalog` as above.

## 13. Negative permission testing (what MUST fail)  *(as pgadmin_ro)*

```sql
-- Each MUST error "permission denied for table …":
SELECT * FROM users LIMIT 1;
SELECT * FROM payments LIMIT 1;
SELECT * FROM merchants LIMIT 1;
SELECT * FROM service_requests LIMIT 1;
SELECT * FROM audit_logs LIMIT 1;
SELECT * FROM alembic_version;            -- no record access, even here
-- Writes/DDL MUST fail (verify via privilege functions to avoid attempting writes in prod):
SELECT has_table_privilege('pgadmin_ro','public.users','INSERT')  AS ins,   -- false
       has_table_privilege('pgadmin_ro','public.users','UPDATE')  AS upd,   -- false
       has_table_privilege('pgadmin_ro','public.users','DELETE')  AS del,   -- false
       has_schema_privilege('pgadmin_ro','public','CREATE')       AS sch_create, -- false
       has_database_privilege('pgadmin_ro','jackpotsworldtours','CREATE') AS db_create; -- false
```
Expected: every `SELECT * FROM <app table>` denied; all privilege-function flags false. This proves the account cannot read records or write/DDL.

## 14. Rollback procedure  `REQUIRES EXPLICIT DBA AND OWNER APPROVAL — DO NOT EXECUTE YET`

Only with explicit approval, and **only** for a role THIS procedure created (Section 6.2 returned 0 rows — **never** a pre-existing role). **`DROP OWNED BY` is prohibited** (restriction 11; it drops the role's owned objects and revokes its privileges broadly, incl. on shared objects).

```sql
-- (1) PRE-CLEANUP VERIFICATION (READ-ONLY) — the role must own NOTHING.
SELECT c.relkind::text AS kind, n.nspname, c.relname AS name
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relowner=(SELECT oid FROM pg_roles WHERE rolname='pgadmin_ro')
UNION ALL
SELECT 'function', n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.proowner=(SELECT oid FROM pg_roles WHERE rolname='pgadmin_ro')
UNION ALL
SELECT 'schema', n.nspname, NULL FROM pg_namespace n
WHERE n.nspowner=(SELECT oid FROM pg_roles WHERE rolname='pgadmin_ro');
-- EXPECT 0 ROWS. Any row => STOP; do not drop.
SELECT dbid, classid::regclass AS catalog, objid, deptype
FROM pg_shdepend WHERE refobjid=(SELECT oid FROM pg_roles WHERE rolname='pgadmin_ro');
-- EXPECT only deptype 'a' (our grants) in this database. An 'o' (owner) row => STOP.
```
```sql
-- (2) EXPLICIT, SCOPED REVOKES + plain DROP ROLE.  REQUIRES APPROVAL — DO NOT EXECUTE YET
BEGIN;
  REVOKE USAGE   ON SCHEMA   public             FROM pgadmin_ro;
  REVOKE CONNECT ON DATABASE jackpotsworldtours FROM pgadmin_ro;
  DROP ROLE pgadmin_ro;   -- no DROP ROLE ... CASCADE exists; FAILS safely if anything still
                          -- depends on the role. A failure means investigate, never force.
COMMIT;
```
Purpose: remove the account cleanly. · **Changes production.** · Needs: `CREATEROLE`/owner. · Side effects: only `pgadmin_ro`'s own two grants are revoked; no other role, object, or PUBLIC permission is touched. · Expected: role gone; re-running Section 6.2 returns 0 rows.

## 15. DBA approval checklist (tick before executing Sections 7–9)

- [ ] Connected as master/`jpwadmin` on `jackpotsworldtours` (PG 18.3) through the **SSM** tunnel; RDS still private.
- [ ] Section 6.2 returned **0 rows** (`pgadmin_ro` absent) — recorded.
- [ ] Section 6.3 baseline captured (PUBLIC CONNECT/TEMP, schema USAGE, the two PUBLIC-EXECUTE functions).
- [ ] Owner's **separate written approval** obtained for Sections 7, 8, 9.
- [ ] No change to master password, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, triggers, functions, or PUBLIC permissions.
- [ ] Password set via `\password` only; no plaintext in scripts/logs.
- [ ] Post-exec: Section 10 all expectations met; Section 12 structure visible (Section 11 feature check passed); Section 13 record reads denied.

## 16. Final sign-off

- **Scope confirmed:** structure-inspection only; grants limited to `CONNECT` + `USAGE`; no table SELECT, no record access, no writes, no CREATE, no membership. Effective function EXECUTE is **not** zero — the role inherits PUBLIC's default EXECUTE on `fn_set_updated_at()` and `fn_write_audit_log()`, left unchanged.
- **Acceptance (post-execution):** 10.1 no readable relation across `r/p/v/m/f`; 10.2/10.3 all false; 10.4 EXECUTE true only for the two PUBLIC-default trigger functions, no `SECURITY DEFINER`; 10.5 connect/usage true, create false; 10.6 attributes minimal, memberships empty; 11 expected pgAdmin behavior confirmed with `pgadmin_ro`; 12 structure browsable; 13 all record reads denied.
- **Prohibited-action attestation:** this document executed nothing — no production SQL, no role, no grant/revoke, no object/credential/config change, no AWS/security-group/RDS-accessibility change, no `DROP OWNED BY`, no record change.
- **Uncertainty noted:** exact per-feature behaviour of pgAdmin (Statistics tab, and the object-browser/DDL/Dependencies/ERD features in Section 5) on a catalog-only role is version-dependent and **must be confirmed in Section 11** with `pgadmin_ro`; no table grant is added to "fix" a cosmetic gap without separate approval.

**A review verdict is not execution authorization.** Sections 7–9 (and 14) run **only** after the owner's separate written approval. Sections 6, 10, 12, 13 are read-only.
