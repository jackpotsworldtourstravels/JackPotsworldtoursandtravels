# Local vs Production Database Audit — pgadmin_ro & structural comparison

**Project:** JackPots World Tours & Travels · **Date:** 2026-11-14
**Scope:** audit the EXISTING local and production databases; verify `pgadmin_ro`; compare structures. No database, table, role, migration, or config was created or changed.

**Evidence basis.** The **local** figures are **live-verified by me** just now, read-only, through the application's own configured SQLAlchemy engine (it loads `backend/.env` in-process, so no password was seen or printed; only `pg_catalog` `SELECT`s were run). The **production** figures were **executed by the DBA and relayed by the owner** — I did not connect to production. Statuses: PASS / FAIL / NOT VERIFIED / REQUIRES APPROVAL.

---

## 1. Local database audit  — **PASS (live-verified, read-only)**

| Property | Value (live) |
|---|---|
| Host / port | `127.0.0.1` : `5432` (confirmed local before connecting) |
| Database | **`jackpots_v2`** |
| Connected as | `postgres` |
| Server version | **PostgreSQL 17.10** |
| Alembic head | **`0093_traveller_middle_name`** |
| Non-system schemas | 1 (`public`) |
| Tables (public, `r`/`p`) | **73** |
| Views / matviews | 0 |
| Columns (public) | **1005** |
| Indexes (public) | **279** |
| Constraints (public, all) | 284 |
| Primary + foreign keys | **185** |
| Sequences (public) | 89 |
| Functions PUBLIC can EXECUTE | **2** |
| `SECURITY DEFINER` functions | **0** |
| Login roles | `postgres`, `admin_portal`, `sms_forwarder_app` |
| `pgadmin_ro` present | **No** (0) |
| `jpwadmin` present | **No** (0) |

Application functionality unaffected — only read-only catalog queries were run; the running local dev server was not touched.

## 2. Production database audit  — **NOT VERIFIED by me (DBA-relayed)**

| Property | Value (relayed / stated) | Status |
|---|---|---|
| Database | `jackpotsworldtours` | stated |
| Engine / region | AWS RDS PostgreSQL 18, `ap-south-1` | stated |
| Tables (public) | 73 | relayed PASS |
| Columns | 1005 | relayed PASS |
| Indexes | 279 | relayed PASS |
| Primary + foreign keys | 185 | relayed PASS |
| Functions PUBLIC can EXECUTE | 2 (both SECURITY INVOKER) | relayed PASS |
| **Alembic head (live)** | **not reported** | **NOT VERIFIED** |
| App login / restricted login | `jpwadmin` / `pgadmin_ro` | stated |

I did not connect to RDS; these are not independently verified here.

## 3. Structural comparison (local vs production)  — **parity PASS; migration head FLAGGED**

| Dimension | Local (live) | Production (relayed) | Finding |
|---|---|---|---|
| Tables (public) | 73 | 73 | **MATCH** |
| Columns | 1005 | 1005 | **MATCH** |
| Indexes | 279 | 279 | **MATCH** |
| Primary + foreign keys | 185 | 185 | **MATCH** |
| PUBLIC-EXECUTE functions | 2 | 2 | **MATCH** |
| `SECURITY DEFINER` functions | 0 | NOT VERIFIED | local 0; prod unconfirmed |
| **Alembic head** | **0093** | not reported (earlier assumed 0095) | **DISCREPANCY to reconcile** |
| Database name | `jackpots_v2` | `jackpotsworldtours` | differ (environment) |
| Server major version | 17.10 | 18 | differ (environment) |
| Roles | postgres/admin_portal/sms_forwarder_app | jpwadmin/pgadmin_ro | differ (environment) |

**Key finding — migration status.** Local is at **`0093`**, and I confirmed the `0094` table (`customer_refund_attempts`) and `0095` table (`customer_admin_audit_logs`) + its trigger are **absent** locally. Because `0094`/`0095` each add a table, the identical 73-table count on both sides strongly implies **production is also at `0093` (i.e., `0094`/`0095` are NOT applied in production either)** — the repository head is `0095`, so **both deployments appear to be two migrations behind the repo.** This is an **inference** from the matching counts; confirm by running on production:
```sql
SELECT version_num FROM alembic_version;     -- read-only; expected to show whether prod is 0093 or 0095
SELECT to_regclass('public.customer_refund_attempts'), to_regclass('public.customer_admin_audit_logs');
```
Status: **NOT VERIFIED (production head)** — do not assume local and production are identical on migration level until this is read live. (Structural *counts* do match, which is reassuring for parity.)

## 4. Read-only account verification (`pgadmin_ro`)

- **Production `pgadmin_ro`** — **PASS (DBA-relayed):** LOGIN; no SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS; `CONNECT` + `USAGE` granted; schema `CREATE` denied; table `SELECT` denied; `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` denied; sequence access denied; no role memberships; records unreadable; catalog metadata (names, columns, indexes, PKs/FKs, constraints) readable via `pg_catalog`.
- **Local `pgadmin_ro`** — **N/A / NOT APPLICABLE:** the role does **not exist** in the local DB (local uses `postgres`/`admin_portal`/`sms_forwarder_app`). No local verification of `pgadmin_ro` is possible, and none should be created here.

## 5. Security findings

| Area | Finding | Status |
|---|---|---|
| Unnecessary privileges (`pgadmin_ro`, prod) | only `CONNECT` + `USAGE` | PASS (relayed) |
| `SECURITY DEFINER` — local | **0** in `public` (live) — supports the expectation that the two PUBLIC-EXECUTE functions are INVOKER | PASS (local) |
| `SECURITY DEFINER` — production | not reported | NOT VERIFIED (run the cluster-wide sweep) |
| PUBLIC privileges | DB `CONNECT`+`TEMPORARY`, schema `USAGE`, EXECUTE on 2 trigger functions — pre-existing defaults, both environments | REQUIRES APPROVAL to change (out of scope) |
| Metadata → data path | none: no table SELECT, no usable function path, TEMP is session-local | PASS (prod contingent on the definer sweep) |
| Local DB exposure | local connects as `postgres` (superuser) — expected for local dev, not a production concern | informational |

## 6. Outstanding issues & recommended next steps

1. **[NOT VERIFIED] Confirm production's live Alembic head** and the presence/absence of `customer_refund_attempts` / `customer_admin_audit_logs` (queries in §3). This resolves whether production is at `0093` or `0095` and whether `0094`/`0095` are a pending deployment — **do not run migrations as part of this audit; surface the gap for a separate, approved decision.**
2. **[NOT VERIFIED] Production `SECURITY DEFINER` sweep** (`10.4c'` in `pgadmin_ro_readonly_verification_V3.sql`) and the explicit-grant PUBLIC-EXECUTE sweep (`6.3d`) — local shows 0 definers and 2 PUBLIC-EXEC functions, but production must be confirmed on its own.
3. **[NOT VERIFIED] App-connection role on production** — secret-free check: `SELECT usename, count(*) FROM pg_stat_activity WHERE datname='jackpotsworldtours' GROUP BY 1;` (confirms `jpwadmin` without revealing the connection string).
4. **[REQUIRES APPROVAL]** Any change to PUBLIC `EXECUTE`/`TEMPORARY`, or applying `0094`/`0095` to either environment — all out of scope here and left untouched.

---

**Preservation attestation:** no database, table, record, role, role membership, migration, backend config, deployment, AWS networking, or security group was created, modified, migrated, restarted, or exposed. The local audit was read-only via the app's own engine; no password/secret was printed; `jpwadmin` and production were not touched; no duplicate database, infrastructure, or pgAdmin connection was created. All production statuses rest on DBA-relayed output or are marked NOT VERIFIED.
