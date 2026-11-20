# pgadmin_ro — Final Production Read-Only Verification Report

**Project:** JackPots World Tours & Travels · **Date:** 2026-11-14
**Database:** `jackpotsworldtours` · **Engine:** AWS RDS PostgreSQL 18 · **Region:** `ap-south-1`
**Roles:** app user `jpwadmin` · restricted inspection user `pgadmin_ro`

**Evidence basis (read this first).** The live checks were **executed by the DBA**; their outputs were **relayed to me by the owner**. I did **not** connect to production or run any SQL — so every PASS below rests on DBA-executed output as reported, not on anything I ran. Where no output was provided, the item is **NOT VERIFIED** (not assumed). No secrets (passwords, JWT, API keys, AWS creds) are printed. Nothing in this task created, changed, restarted, or exposed any production resource.

**Status legend:** PASS (executed and output confirms) · FAIL · NOT VERIFIED (no executed output seen) · REQUIRES APPROVAL (a change needing separate sign-off).

---

## 1. Existing production environment

| Item | Value |
|---|---|
| Database | `jackpotsworldtours` (existing — not recreated) |
| Engine / region | AWS RDS PostgreSQL 18, `ap-south-1` |
| App user | `jpwadmin` (member of `rds_superuser`; owns the app tables) — unchanged |
| Inspection user | `pgadmin_ro` (created earlier) |
| Backend | existing FastAPI/Python app; runtime engine uses `DATABASE_URL` only (`backend/app/database/session.py`) |
| Access | private via EC2 + SSM; RDS not public — unchanged |

No duplicate database, environment, or connection was created in this task.

## 2. Work already completed (reported by the owner, executed by the DBA)

Role created with `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`; `CONNECT` on the DB and `USAGE` on `public` granted; table SELECT denied; INSERT/UPDATE/DELETE/TRUNCATE denied; sequence access denied; no role memberships; application records unreadable; catalog metadata accessible; **73** public relation names, **279** index definitions, **185** PK/FK metadata rows, column metadata via `pg_catalog`; independent `psql` login as `pgadmin_ro`; SSL confirmed; `information_schema.tables/columns/table_constraints` returned **zero rows** (expected under the restricted privileges); **two** trigger functions hold default PUBLIC EXECUTE and both are SECURITY INVOKER.

## 3. Verification results

### Task 2 — Restricted account
| Check | Status | Basis |
|---|---|---|
| Current database / current user | PASS | DBA output (6.1) |
| Login + role attributes (NOINHERIT/NOSUPERUSER/…) | PASS | DBA output (10.6) |
| Database `CONNECT` granted | PASS | DBA output |
| Schema `USAGE` granted | PASS | DBA output |
| Schema `CREATE` denied | PASS | DBA output (`sch_create` false) |
| Table `SELECT` denied (all app tables) | PASS | DBA output (10.1 / 13 record reads denied) |
| `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` denied | PASS | DBA output (13(c) write sweep) |
| Sequence `USAGE`/`SELECT`/`UPDATE` denied | PASS | DBA output (10.3) |
| No role memberships | PASS | DBA output (10.6 — zero rows) |
| No access to application data | PASS | DBA output (record reads denied) |

### Task 3 — Structure inspection (via `pg_catalog`, since `information_schema` is privilege-filtered)
| Can inspect | Status | Basis |
|---|---|---|
| Public table/relation names (73) | PASS | DBA output |
| Column names + data types | PASS | DBA output (`pg_attribute`/`format_type`) |
| Indexes (279 definitions) | PASS | DBA output (`pg_indexes`) |
| Primary keys + foreign keys (185 rows) | PASS | DBA output (`pg_constraint`) |
| Constraints / object metadata | PASS | DBA output (`pg_catalog`) |
| `information_schema` empty under restriction | PASS (expected) | DBA output — documented behavior, not a defect |

### Task 4 — Production application unaffected
| Check | Status | Basis |
|---|---|---|
| No service restarted / reconfigured | PASS | nothing in this work touches the app container; creating a role does not affect running sessions |
| App connection independent of `pgadmin_ro` | PASS | repo: runtime engine uses `DATABASE_URL` (the `jpwadmin` runtime credential), never `pgadmin_ro` |
| App still uses `jpwadmin` on `jackpotsworldtours` | NOT VERIFIED (by me) | owner-stated + repo-consistent; a safe live confirmation is `SELECT usename, count(*) FROM pg_stat_activity WHERE datname='jackpotsworldtours' GROUP BY 1;` (shows the app sessions' role **without** revealing the connection string) |

No connection secret is read or printed to establish this.

## 4. Remaining issues / items to close
- **Full `SECURITY DEFINER` sweep (10.4c′) — NOT VERIFIED.** The owner confirmed the **two** PUBLIC-EXECUTE trigger functions are SECURITY INVOKER (10.4b′ = PASS), but the broader check "is there **any** `SECURITY DEFINER` function in `public`?" was not reported. Run V3 `10.4c'` (expected 0 rows) to close it.
- **Explicit-grant PUBLIC-EXECUTE sweep (6.3d) — NOT VERIFIED.** The default-case finding (exactly two functions via NULL ACL) is consistent with the report; the V3 `6.3d` result (which also catches any *explicit* `GRANT EXECUTE … TO PUBLIC`) was not reported. Run it to confirm the count is exactly those two with no explicit PUBLIC grants.
- **pgAdmin GUI structure-browse — NOT VERIFIED.** An independent `psql` login was confirmed; the pgAdmin **object browser / Properties / DDL / Dependencies / ERD** on a catalog-only role (checklist Section 11) was not reported. Confirm in pgAdmin if that is the intended client.

## 5. Security observations (Task 5)
| Area | Finding | Status |
|---|---|---|
| Unnecessary privileges | Only `CONNECT` + `USAGE` held; no table/sequence/function grant | PASS |
| PUBLIC privileges | PUBLIC holds DB `CONNECT`+`TEMPORARY`, schema `USAGE`, and default `EXECUTE` on the two trigger functions — **pre-existing defaults inherited by all roles**, not introduced for `pgadmin_ro` | REQUIRES APPROVAL to change (out of scope; do not revoke here) |
| SECURITY DEFINER functions | the two PUBLIC-EXECUTE functions are INVOKER (good); cluster-wide definer sweep not yet reported | NOT VERIFIED (run 10.4c′) |
| Default privileges | no `ALTER DEFAULT PRIVILEGES` added; PUBLIC function EXECUTE is the built-in default, unchanged | PASS |
| Metadata → data path | none: no table SELECT; the two inheritable functions are `RETURNS trigger` (error on direct call) and, as INVOKER, any write runs as `pgadmin_ro` and is denied; `TEMP` is session-local only | PASS (contingent on 10.4c′ confirming no definer function opens such a path) |

**Effective function EXECUTE is not zero** — `pgadmin_ro` inherits PUBLIC EXECUTE on `fn_set_updated_at()` and `fn_write_audit_log()`; verified SECURITY INVOKER, left unchanged. Do not alter these without a separate security analysis and explicit approval.

## 6. Is `pgadmin_ro` ready for production structure inspection?
**PASS — ready for structure inspection, with two read-only confirmations outstanding.** The relayed DBA output shows the account can read catalog metadata (names, columns, indexes, PKs/FKs, constraints) while being denied all record reads, writes, DDL, sequence access, and role memberships — exactly the intended posture. Readiness is **fully** closed once `10.4c'` (no `SECURITY DEFINER`) and `6.3d` (no explicit PUBLIC-EXECUTE beyond the two defaults) are run and return as expected; if pgAdmin (not psql) is the client, also confirm the Section-11 browse.

## 7. Task 1 + recommended changes requiring approval
- **Task 1 — existing pgAdmin connection:** NOT VERIFIED — no evidence of a configured pgAdmin production connection was provided (only a `psql` login). **Do not auto-create** another database or connection. If a dedicated restricted pgAdmin **client connection** is wanted, that is a pgAdmin-side config the owner sets (host via the SSM tunnel, user `pgadmin_ro`, SSL require) — it needs **no** database change; say the word and I'll give the field-by-field setup. A separate *restricted DB connection object* is unnecessary — `pgadmin_ro` already is the restriction.
- **REQUIRES APPROVAL (none applied):**
  - Revoking PUBLIC `EXECUTE` on the two trigger functions (or `REVOKE EXECUTE … FROM PUBLIC` broadly) — only after a separate security analysis.
  - Revoking PUBLIC `TEMPORARY` on the database — a cluster-wide PUBLIC change.
  - Neither is required for structure inspection; both are left unchanged.

---

**Preservation attestation:** no production database, environment, table, migration, backend config, data, role membership, security group, or RDS network setting was created, changed, restarted, or exposed by this task; `jpwadmin` is untouched; no duplicate infrastructure was created; no secret was printed. All PASS statuses rest on DBA-executed output as relayed; items without seen output are marked NOT VERIFIED. Any production change awaits explicit approval.
