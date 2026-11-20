# Stage 3 — Staging Readiness Assessment

**Project:** JackPots World Tours & Travels · **Module:** B2C Admin Portal (Stage 3: M0, M1, M2.1–M2.3)
**Date:** 2026-11-13
**Nature:** Read-only repository inspection + documentation. **No database connection, no migration execution, no schema/data change, no source/test/migration edit, no deploy/commit/push.** No secret values are shown. **Staging/production readiness is NOT claimed** — the items below require actual verification on a staging environment.

### Status labels
- **READY** — present/implemented in the repo; nothing further needed in-repo.
- **BLOCKED** — cannot proceed until a dependency (config/env) is satisfied.
- **REQUIRES AUTHORIZATION** — needs explicit owner/DBA authorization before it happens.

**Files inspected:** `docs/STAGE_3_FINAL_COMPLETION_REPORT.md`, `docs/STAGE_3_DATABASE_DEPLOYMENT_CHECKLIST.md`, `docs/STAGE_3_PROGRESS.md`, `backend/alembic/versions/0095_customer_admin_audit_logs.py` (+ `backend/app/config.py` for config-variable names only).

---

## 1. Staging environment requirements

| # | Requirement | Status |
|---|---|---|
| 1.1 | **PostgreSQL** instance for staging (the migration uses `JSONB`, an `ENUM` type, a plpgsql trigger, and a partial/`WHERE` unique index — PostgreSQL-only; SQLite is test-harness only). A disposable/non-production DB with **no production data**. | **REQUIRES AUTHORIZATION** (provision) |
| 1.2 | Application runtime deployed to staging (FastAPI backend + the static admin frontend) at the current Stage-3 code. | **REQUIRES AUTHORIZATION** (deploy) |
| 1.3 | Reachable **SMTP** server/relay for M2.2 email and M1 password-reset emails. | **BLOCKED** until configured (§2) |
| 1.4 | Alembic able to run against the staging DB with a role that can create schema objects (§4). | **REQUIRES AUTHORIZATION** (DBA) |
| 1.5 | **Redis** — only for the pre-existing live-chat/WiFi-calling features; **not required** for M2.1/M2.2/M2.3. `redis_url` is optional. | **READY** (N/A to Stage-3 comms) |
| 1.6 | Application code for M0/M1/M2 | **READY** (local, tested; see §7) |

## 2. Configuration variables & secrets (names only — NO values shown)

Set from the environment's secret store / `.env`; **never** commit values. `[SECRET]` must come from the secret manager.

| Env var | Purpose (Stage 3 relevance) | Secret? | Status |
|---|---|---|---|
| `DATABASE_URL` | the single Postgres DB (B2B + B2C) | **[SECRET]** (contains credentials) | **REQUIRES AUTHORIZATION** |
| `JWT_SECRET_KEY` | admin/customer token signing | **[SECRET]** | **REQUIRES AUTHORIZATION** |
| `DEPLOYED` | must be **true** on staging (governs OTP delivery, demo-payment lock, doc behaviour) | no | **BLOCKED** until set true |
| `DEBUG` | must be **false** on staging (prevents debug-only disclosures e.g. reset links) | no | **BLOCKED** until set false |
| `CORS_ORIGINS` | staging admin/frontend origins | no | **BLOCKED** until set |
| `FRONTEND_BASE_URL` | staging base URL (used to build reset-email links) | no | **BLOCKED** until set |
| `SMTP_HOST` | email transport (M2.2 + M1 reset) | no | **BLOCKED** until set |
| `SMTP_PORT` | email transport | no | **BLOCKED** until set |
| `SMTP_USERNAME` | SMTP auth | **[SECRET]** | **BLOCKED** until set |
| `SMTP_PASSWORD` | SMTP auth | **[SECRET]** | **BLOCKED** until set |
| `SMTP_USE_TLS` | SMTP transport security | no | **BLOCKED** until set |
| `SMTP_FROM_EMAIL` | sender address (if unset, `_send` returns False → 502, no false success) | no | **BLOCKED** until set |
| `SMTP_FROM_NAME` | sender display name | no | **BLOCKED** until set |
| `PAYMENT_PROVIDER`, `PAYMENT_ENVIRONMENT` | pre-existing payment config; **not** required by M0/M1/M2 comms — leave at the environment's existing/non-live staging values; **do not** point at live | varies | **REQUIRES AUTHORIZATION** (unchanged) |
| `REDIS_URL` | optional; live-chat only, not Stage-3 comms | **[SECRET]** if used | **READY** (optional) |

> Also required before the audited endpoints work at all: the operator account must hold the explicit scopes `b2c.customers.manage` (M1), `b2c.communication.send` (M2), `b2c.audit.view` (audit read) — or be super-admin. Granting these is a **DBA/admin ACTION** / **REQUIRES AUTHORIZATION**.

## 3. Database backup & recovery prerequisites

| # | Item | Status |
|---|---|---|
| 3.1 | Full logical **backup** (`pg_dump`) of the staging DB taken immediately before applying `0095`; timestamp + per-table row-count manifest recorded. | **REQUIRES AUTHORIZATION** (DBA) |
| 3.2 | **Restore rehearsed** on a scratch instance so recovery is proven, not assumed. | **REQUIRES AUTHORIZATION** (DBA) |
| 3.3 | Recovery path documented: if integrity is in doubt, restore from 3.1; the migration downgrade (`alembic downgrade -1`) **destroys the audit table and any rows written since** and is gated. | **REQUIRES AUTHORIZATION** (DBA) |
| 3.4 | Note: Alembic + Postgres run the migration transactionally, so a mid-`upgrade()` failure rolls back atomically (nothing half-created). | **READY** (documented) / **[TO VERIFY]** on target |

## 4. DBA permissions & responsibilities

- Role able to `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX`, `CREATE FUNCTION`, `CREATE TRIGGER` in the target schema (to run `0095`). **REQUIRES AUTHORIZATION**
- Run `alembic upgrade head` (applies `0095` only). **REQUIRES AUTHORIZATION**
- **Privilege model (separate from the migration file):** table/trigger/function owned by the DDL role; the **application login** granted **`INSERT, SELECT`** on `customer_admin_audit_logs`, with **`UPDATE, DELETE, TRUNCATE` revoked** (append-only is also enforced by the trigger). **REQUIRES AUTHORIZATION**
- Run the §6 verification queries; own backup/restore (§3) and any rollback decision. **REQUIRES AUTHORIZATION**

## 5. Staging deployment runbook (step-by-step)

> Entire sequence is **REQUIRES AUTHORIZATION**; run on **staging only**, no production data. Nothing here is executed by this assessment.

1. Provision/confirm the staging PostgreSQL DB and app runtime (§1). 
2. Set all required config/secrets (§2) from the secret store; confirm `DEPLOYED=true`, `DEBUG=false`, SMTP set.
3. **Backup** the staging DB and rehearse restore (§3).
4. Confirm the DB's current stamped revision is `0094_customer_refund_attempts` (`alembic current`) and the chain head is `0095` (`alembic heads`).
5. **Apply the migration:** `alembic upgrade head` (authorized DBA).
6. Apply the DBA **privilege step** (§4 grant/revoke).
7. **Post-migration schema verification** (§6 queries): table/columns/enum/indexes/partial-unique/trigger all present.
8. **Application readiness:** restart not required — the M0 gate re-probes; confirm an authorized `GET /api/admin/b2c-audit` returns **200** (not 503).
9. **Application-level tests** (§7): run the M1 and M2 flows; confirm expected results and audit rows.
10. **Append-only check** (§6): a direct `UPDATE`/`DELETE` on an audit row raises.
11. Record results; **do not** proceed to production without explicit sign-off (separate authorization).

## 6. Post-migration verification queries (read-only, for the authorized DBA)

> Provided for the DBA to run on staging **after** `0095`. Read-only/inspection; not executed here.

```sql
-- 6.1 revision applied
SELECT version_num FROM alembic_version;                     -- expect 0095_customer_admin_audit_logs

-- 6.2 table + 19 columns
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'customer_admin_audit_logs' ORDER BY ordinal_position;   -- expect 19 rows

-- 6.3 enum labels
SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'customer_admin_audit_outcome_enum' ORDER BY e.enumsortorder;  -- success,failure,denied,partial

-- 6.4 indexes (7 named + 1 partial-unique)
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'customer_admin_audit_logs' ORDER BY indexname;
--   expect: ix_customer_admin_audit_logs_request_id, ix_cust_admin_audit_actor/entity/action/outcome/retention,
--           ix_cust_admin_audit_created (created_at DESC),
--           uq_cust_admin_audit_refund_success UNIQUE ... WHERE (outcome='success' AND entity_type='customer_refund_attempt')

-- 6.5 append-only trigger + function present
SELECT tgname FROM pg_trigger WHERE tgrelid = 'customer_admin_audit_logs'::regclass AND NOT tgisinternal;
SELECT proname FROM pg_proc WHERE proname = 'fn_block_customer_admin_audit_mutation';

-- 6.6 append-only enforced (EXPECT AN ERROR, not a row change):
-- UPDATE customer_admin_audit_logs SET reason='x' WHERE customer_admin_audit_log_id = <id>;  -- must RAISE
```

## 7. Application-level staging test cases & expected results

Each is proven by an automated test locally **[DOCUMENTED]**; the staging re-run on PostgreSQL with real auth is **[TO VERIFY]**.

| # | Case | Expected result |
|---|---|---|
| 7.1 | Authorized in-app notification (`POST .../notify`) | 200; one `customer_notifications` row visible to the customer; one SUCCESS audit (metadata-only) |
| 7.2 | Authorized email (`POST .../email`), SMTP up | 200 `delivered:true` to the customer's verified address; SUCCESS audit (metadata-only) |
| 7.3 | Email, no verified email | 422; nothing sent; FAILURE audit |
| 7.4 | Email, SMTP down | 502; FAILURE audit; no false success |
| 7.5 | Authorized ticket reply (`POST .../tickets/{id}/reply`) | 200; `is_staff` message on the correct ticket, visible to the customer; resolved→open only; SUCCESS audit |
| 7.6 | Customer block / unblock | ACTIVE→blocked (+force logout) / blocked→active; INACTIVE/SUSPENDED→409; SUCCESS audit |
| 7.7 | Password reset, verified email | 200; reset email delivered; no token/link in the response; SUCCESS audit |
| 7.8 | Any audited action **without** the required scope | 403 + DENIED audit; no mutation/send |
| 7.9 | Audit read (`GET /api/admin/b2c-audit`) | authorized → 200 redacted/paginated; without `b2c.audit.view` → 403 |
| 7.10 | Readiness before/after apply | before `0095`: audited actions → 503; after: → normal (no restart) |
| 7.11 | Refund audit atomicity | a succeeded refund carries exactly one success audit; an audit failure holds the attempt `processing` for reconciliation |
| 7.12 | Gaming disabled | gaming remains disabled across surfaces (`test_gaming_fail_closed` green) |

## 8. Blockers & dependencies

| Item | Label |
|---|---|
| Migration `0095` not yet applied (all audited actions 503 until applied) | **REQUIRES AUTHORIZATION** (DBA) |
| DBA privilege step (INSERT/SELECT grant + revoke) | **REQUIRES AUTHORIZATION** (DBA) |
| Staging PostgreSQL + app runtime provisioning/deploy | **REQUIRES AUTHORIZATION** |
| SMTP configuration (M2.2 + M1 reset) | **BLOCKED** until set |
| `DEPLOYED=true`, `DEBUG=false`, CORS/FRONTEND_BASE_URL set | **BLOCKED** until set |
| Operator scope grants (`b2c.customers.manage`, `b2c.communication.send`, `b2c.audit.view`) | **REQUIRES AUTHORIZATION** |
| Authenticated browser (UI) verification of M1/M2 flows | **BLOCKED** until a staging env with the above exists (never done locally) |
| Backup + restore rehearsal | **REQUIRES AUTHORIZATION** (DBA) |
| Application code (M0/M1/M2) | **READY** (local, tested) |

---

## 9. Summary

- **Files inspected:** `docs/STAGE_3_FINAL_COMPLETION_REPORT.md`, `docs/STAGE_3_DATABASE_DEPLOYMENT_CHECKLIST.md`, `docs/STAGE_3_PROGRESS.md`, `backend/alembic/versions/0095_customer_admin_audit_logs.py` (+ `backend/app/config.py` for variable names only).
- **Document created:** `docs/STAGE_3_STAGING_READINESS_ASSESSMENT.md`.
- **Top blockers:** `0095` unapplied + DBA privilege step (**REQUIRES AUTHORIZATION**); SMTP + `DEPLOYED`/`DEBUG`/CORS/`FRONTEND_BASE_URL` not set (**BLOCKED**); staging DB/app provisioning (**REQUIRES AUTHORIZATION**); authenticated UI verification pending (**BLOCKED**). Application code is **READY** (local, tested).
- **Confirmations:** no database connection, no migration execution, no schema/data change, no source/test/migration-file edit, no deploy/commit/push/merge; no secret values shown; Gaming Tour Packages remain disabled; Stage 4 not started. **Staging/production readiness is NOT claimed** — all staging items require actual verification.
