# Stage 3 — Database Deployment Preparation Checklist (migration `0095`)

**Project:** JackPots World Tours & Travels · **Module:** B2C Admin Portal (Stage 3 audit infrastructure)
**Date:** 2026-11-13
**Nature:** Documentation + read-only inspection only. **No PostgreSQL connection, no migration executed, no schema/data change, no source/test/migration edit, no deploy/commit/push.** Production readiness is **not** claimed.

### Tag legend
- **[DOCUMENTED]** — evidence already in the repository (file-verified).
- **[TO VERIFY]** — requires staging/database verification (not done here).
- **[DBA ACTION]** — must be performed by an authorized DBA.
- **[APPROVAL REQUIRED]** — requires explicit owner approval before it happens.

**Sources read:** `docs/STAGE_3_FINAL_COMPLETION_REPORT.md`, `docs/STAGE_3_M0_M1_REPORT.md`, `docs/STAGE_3_M2_COMPLETION_REPORT.md`, `docs/STAGE_3_PROGRESS.md`, `backend/alembic/versions/0095_customer_admin_audit_logs.py`.

---

## 1. Migration `0095` — documentation **[DOCUMENTED]**

- **File:** `backend/alembic/versions/0095_customer_admin_audit_logs.py`
- **revision:** `0095_customer_admin_audit_logs` · **down_revision:** `0094_customer_refund_attempts`
- **Single shared Alembic history** (no second history). Hand-written (alembic `env.py` targets the legacy `app.models` Base, so autogenerate does not see `models_customer`).

### 1.1 Table `customer_admin_audit_logs` (19 columns)
`customer_admin_audit_log_id` BIGINT PK (autoincrement) · `admin_user_id` BIGINT **nullable, NO FK** (actor snapshot) · `admin_email` VARCHAR(255) · `admin_name` VARCHAR(150) · `admin_role` VARCHAR(40) · `environment` VARCHAR(8) NOT NULL default `'b2c'` · `action` VARCHAR(100) NOT NULL · `entity_type` VARCHAR(60) · `entity_id` VARCHAR(64) · `outcome` ENUM NOT NULL · `retention_class` VARCHAR(12) NOT NULL default `'ordinary'` · `previous_value` JSONB · `new_value` JSONB · `reason` TEXT · `request_id` VARCHAR(64) · `ip_address` VARCHAR(64) · `browser` VARCHAR(120) · `device` VARCHAR(120) · `created_at` TIMESTAMPTZ NOT NULL default `now()`.

### 1.2 Enum
`CREATE TYPE customer_admin_audit_outcome_enum AS ENUM ('success','failure','denied','partial')` — the migration owns the type (the model column uses `create_type=False`).

### 1.3 Indexes (7 declared + 1 partial-unique)
`ix_customer_admin_audit_logs_request_id (request_id)` · `ix_cust_admin_audit_actor (admin_user_id)` · `ix_cust_admin_audit_entity (entity_type, entity_id)` · `ix_cust_admin_audit_action (action)` · `ix_cust_admin_audit_outcome (outcome)` · `ix_cust_admin_audit_retention (retention_class)` · `ix_cust_admin_audit_created (created_at DESC)` · **partial UNIQUE** `uq_cust_admin_audit_refund_success (entity_type, entity_id) WHERE outcome='success' AND entity_type='customer_refund_attempt'` (one terminal refund-success per attempt; unrelated financial successes not affected).

### 1.4 Append-only trigger & function
- `fn_block_customer_admin_audit_mutation()` (plpgsql) → `RAISE EXCEPTION 'customer_admin_audit_logs is append-only'`.
- `trg_block_customer_admin_audit_mutation BEFORE UPDATE OR DELETE ON customer_admin_audit_logs FOR EACH ROW` → rejects any update/delete.

### 1.5 Dependencies & compatibility **[DOCUMENTED]/[TO VERIFY]**
- **Prerequisite revision** `0094_customer_refund_attempts` must already be applied; chain (files) is `… → 0093 → 0094 → 0095` with a **single head** `0095` **[DOCUMENTED]** (confirmed via Alembic `ScriptDirectory`, file-only, no DB).
- **PostgreSQL-only features:** `JSONB`, `ENUM` type, plpgsql trigger, and the partial (`WHERE`) unique index. Target must be PostgreSQL (SQLite is test-harness only). **[DOCUMENTED]**
- **No `GRANT`/`REVOKE` in the migration** — the INSERT/SELECT-only app-role privilege is a separate **[DBA ACTION]**.
- **Schema-compat:** the DDL must match `app.models_customer.CustomerAdminAuditLog` (M0 readiness performs a column-compat check at runtime). Parity of the 19 columns + 7 named indexes was file-verified locally; full column-type parity on PostgreSQL is **[TO VERIFY]**.
- **Downgrade destroys audit history** → **[APPROVAL REQUIRED]**; never run against a populated environment.

---

## 2. Pre-deployment checklist

| # | Item | Tag |
|---|---|---|
| 2.1 | Full database **backup** taken and a **restore** rehearsed on a scratch instance; backup timestamp + row-count manifest recorded | **[DBA ACTION]** / **[TO VERIFY]** |
| 2.2 | Confirm the DB's **current stamped revision** = `0094_customer_refund_attempts` (`alembic current`) before upgrading | **[DBA ACTION]** / **[TO VERIFY]** |
| 2.3 | Confirm the **migration chain / single head** = `0095` (`alembic heads`, `alembic history`) | **[DOCUMENTED]** (files) / confirm on host **[TO VERIFY]** |
| 2.4 | Confirm the deploying role may `CREATE TYPE / TABLE / INDEX / TRIGGER / FUNCTION` in the target schema | **[DBA ACTION]** |
| 2.5 | Decide the **app-login privilege** plan: grant `INSERT, SELECT` on `customer_admin_audit_logs`; **revoke** `UPDATE, DELETE, TRUNCATE` (table/trigger owned by the DDL role) | **[DBA ACTION]** / **[APPROVAL REQUIRED]** |
| 2.6 | Confirm the enum/table/trigger/function names **do not already exist** (`CREATE TYPE`/`CREATE TRIGGER` are not `IF NOT EXISTS`) | **[TO VERIFY]** |
| 2.7 | Confirm `SMTP_HOST`/`SMTP_FROM_EMAIL` set in the target env (needed for M2.2; unset → 502, no false success) | **[TO VERIFY]** |
| 2.8 | Confirm the scopes (`b2c.customers.manage`, `b2c.communication.send`, `b2c.audit.view`) are granted to the intended operator(s), or super-admin is used | **[DBA ACTION]** / **[TO VERIFY]** |
| 2.9 | Maintenance window / change-ticket approved | **[APPROVAL REQUIRED]** |

---

## 3. Controlled staging deployment sequence

> Run against **staging** first (never production), with no production data. Each step is **[DBA ACTION]** unless noted; the whole sequence is **[APPROVAL REQUIRED]**.

1. **Pre-checks:** §2.1–2.8 complete; backup verified; `alembic current` == `0094...`. **[DBA ACTION]/[TO VERIFY]**
2. **Migration execution (authorized DBA):** `alembic upgrade head` (applies `0095` only). **Do not run here.** **[DBA ACTION]/[APPROVAL REQUIRED]**
3. **Post-migration schema verification** (read-only SQL): table exists with the 19 columns; enum type exists with the 4 labels; all 7 named indexes + the partial-unique index exist; the trigger + function exist. **[TO VERIFY]**
4. **Application readiness verification:** the M0 gate flips **ready without a restart** (lazy re-probe); an authorized `GET /api/admin/b2c-audit` returns **200** (was 503); an audited admin endpoint no longer returns 503 for the gate reason. **[TO VERIFY]**
5. **Audit write verification:** perform one low-risk audited action (e.g. an authorized in-app notification to a test customer) and confirm exactly one SUCCESS row in `customer_admin_audit_logs` with content-free metadata. **[TO VERIFY]**
6. **Audit read verification:** `GET /api/admin/b2c-audit` returns the row (redacted), paginated/filterable; a caller without `b2c.audit.view` is 403. **[TO VERIFY]**
7. **Append-only verification:** a direct `UPDATE`/`DELETE` on a `customer_admin_audit_logs` row **raises** `customer_admin_audit_logs is append-only`. **[TO VERIFY]**
8. **Failure & rollback considerations:** if a post-migration check fails, **do not** proceed to production; investigate. Rollback is `alembic downgrade -1` which **drops the table/trigger/type and destroys any audit rows written since** — gated **[APPROVAL REQUIRED]** and only acceptable on staging; prefer fixing forward. Restore from the §2.1 backup if data integrity is in doubt. **[DBA ACTION]/[APPROVAL REQUIRED]**
   - *Transactional-DDL note (accuracy):* Alembic runs the migration inside a transaction (`env.py` wraps `run_migrations()` in `begin_transaction()`) and PostgreSQL DDL is transactional, so a failure **during** `upgrade()` rolls the whole migration back atomically — the enum/table/indexes/trigger are **not** left half-created. The non-idempotent `CREATE TYPE` / `CREATE TRIGGER` collision risk in §2.6 therefore applies only when the objects already exist from a **prior successful** apply, not from a mid-migration failure; a clean re-run after a rolled-back failure is expected to succeed. **[TO VERIFY]** on the target.

---

## 4. Verification test cases (post-`0095`, on staging)

Each references an existing automated test proven locally **[DOCUMENTED]**; the staging re-run against PostgreSQL is **[TO VERIFY]**.

| Area | Expected on staging | Local evidence [DOCUMENTED] |
|---|---|---|
| Successful audit writes | audited action → one SUCCESS row, atomic with the business write | M0/M1/M2 suites |
| Denied / failed actions | missing scope → 403 + DENIED row; 404/invalid → FAILURE row (independent session) | notify/email/reply + M1 suites |
| Customer block / unblock | ACTIVE→blocked (+force logout); blocked→active; INACTIVE/SUSPENDED→409; idempotent; SUCCESS audit | `test_b2c_customer_admin_actions.py` (21) |
| Password reset | verified-email required; no token/link returned; SMTP-fail invalidates token; sent-but-audit-fail → 500 + anomaly | same suite |
| In-app notifications | one `customer_notifications` row, visible to the customer; metadata-only audit | `test_b2c_communication_notify.py` (11) |
| Email delivery + audit-failure | sent to verified address; SMTP fail → 502; sent-but-audit-fail → 500 + anomaly, not falsely unsent | `test_b2c_communication_email.py` (14) |
| Support-ticket replies | `is_staff` reply; resolved→open only; customer-visible; ticket isolation; no auto email | `test_b2c_communication_ticket_reply.py` (12) |
| Refund audit atomicity | refund SUCCESS + audit commit together; failure holds attempt `processing` for reconciliation; one success per attempt | Stage-2 refund suites |
| Audit read permission | `b2c.audit.view` required; redacted output; no edit/delete endpoint | `test_b2c_audit_api.py` (9) |
| Append-only enforcement | DB `UPDATE`/`DELETE` on an audit row raises | trigger (§1.4) — DB-level, **[TO VERIFY]** |

---

## 5. Summary

- **Files read:** `docs/STAGE_3_FINAL_COMPLETION_REPORT.md`, `docs/STAGE_3_M0_M1_REPORT.md`, `docs/STAGE_3_M2_COMPLETION_REPORT.md`, `docs/STAGE_3_PROGRESS.md`, `backend/alembic/versions/0095_customer_admin_audit_logs.py`.
- **Document created:** this file — `docs/STAGE_3_DATABASE_DEPLOYMENT_CHECKLIST.md`.
- **Confirmations:** migration `0095` remains **UNAPPLIED**; **no** PostgreSQL connection, **no** migration execution, **no** schema/data change, **no** source/test/migration-file edit, **no** deploy/commit/push/merge. The Alembic chain/head was confirmed **offline** from the version files only (no DB). Gaming Tour Packages remain disabled. **Production readiness is not claimed** — the items above are explicitly tagged [TO VERIFY] / [DBA ACTION] / [APPROVAL REQUIRED].

Awaiting explicit approval before any deployment or DBA action.
