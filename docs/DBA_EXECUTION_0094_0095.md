# DBA Execution Package — migrations 0094 + 0095 (production)

**DB:** `jackpotsworldtours` (AWS RDS PostgreSQL 18, ap-south-1) · **Prepared:** 2026-11-15
**Run as the migration/owner role via the approved SSM tunnel. Nothing here is executed by Claude.**
**Code state:** commits `48a0942` (Stage-1B RBAC + Stage-2 audit) and `1e7cd98` (B2 refund guard) are in place; migration files `0094`/`0095` are unchanged.

**Migration facts (verified from the files; not rewritten):**
- `0094_customer_refund_attempts` — down_revision `0093_traveller_middle_name`. Creates `customer_refund_attempts`: FK `cancellation_ref → customer_cancellation_requests.cancellation_ref ON DELETE RESTRICT`; uniques `uq_refund_attempt_idempotency`, `uq_refund_attempt_number`; checks `ck_refund_attempt_amount_positive`, `ck_refund_attempt_status`, `ck_refund_attempt_payment_table`; partial-unique `uq_refund_attempt_provider_refund` (WHERE provider_refund_id IS NOT NULL), `uq_refund_attempt_one_in_flight` (WHERE status IN ('pending','processing')); indexes `ix_refund_attempt_payment`, `ix_refund_attempt_status`.
- `0095_customer_admin_audit_logs` — down_revision `0094`. `CREATE TYPE customer_admin_audit_outcome_enum` (**no IF NOT EXISTS**); table `customer_admin_audit_logs`; 7 indexes (`ix_customer_admin_audit_logs_request_id`, `ix_cust_admin_audit_actor/entity/action/outcome/retention`, `ix_cust_admin_audit_created` DESC); partial-unique `uq_cust_admin_audit_refund_success` (WHERE outcome='success' AND entity_type='customer_refund_attempt'); function `fn_block_customer_admin_audit_mutation` + trigger `trg_block_customer_admin_audit_mutation` (BEFORE UPDATE OR DELETE, append-only). **Issues no GRANT/REVOKE** — that is the separate step in §5.

---

## 0. Connect (SSM; RDS stays private)
```bash
aws ssm start-session --region ap-south-1 --target <ec2-instance-id>
# on the host:
cd <app-dir>/backend
# migration/owner credential must be set (NOT the runtime role); from backend/.env.migration:
#   export MIGRATION_DATABASE_URL=postgresql+psycopg2://<owner_role>:<pw>@<rds-endpoint>:5432/jackpotsworldtours
# Alembic reads settings.alembic_url = MIGRATION_DATABASE_URL (fail-closed when DEPLOYED and unset).
```

## 1. Pre-migration checklist (STOP if any item fails)
- [ ] **Backup/snapshot taken and verified** — record snapshot id: ____________
- [ ] **Connected as the owner role** (not the runtime role); SSM tunnel confirmed; RDS not public.
- [ ] **Current version = 0093**: `alembic current` → expect `0093_traveller_middle_name (head: no)` **OR** run the read-only pre-check (`prod_0094_0095_verification.sql`): `version_num = 0093…`.
- [ ] **0094/0095 objects ABSENT** (partial-migration detection): `to_regclass` NULL for both tables; **enum `customer_admin_audit_outcome_enum` ABSENT**; trigger/function absent; no partial indexes.
- [ ] **FK parent present**: `to_regclass('public.customer_cancellation_requests')` is non-NULL.
- [ ] **STOP conditions:** head ≠ 0093; either table/enum/trigger/index partially present; or `alembic current` disagrees with object presence (stamp ≠ schema). Investigate before proceeding — do **not** upgrade over a partial state (0095's `CREATE TYPE` will fail on a leftover enum).

## 2. Apply 0094 (refund attempts) — SEPARATE STEP
```bash
alembic upgrade 0094_customer_refund_attempts
```
**Expected:** creates `customer_refund_attempts` + its constraints/indexes; `alembic current` → `0094_customer_refund_attempts`. Verify (read-only):
```sql
SELECT version_num FROM alembic_version;                                   -- 0094_customer_refund_attempts
SELECT to_regclass('public.customer_refund_attempts');                     -- non-NULL
SELECT conname, contype FROM pg_constraint
 WHERE conrelid='public.customer_refund_attempts'::regclass ORDER BY 2,1;  -- 2 unique + 1 pk + 3 check + 1 fk
SELECT indexname FROM pg_indexes WHERE tablename='customer_refund_attempts' ORDER BY 1;
--   expect: ix_refund_attempt_payment, ix_refund_attempt_status,
--           uq_refund_attempt_one_in_flight, uq_refund_attempt_provider_refund (+ pk/unique index names)
```
**STOP** if any constraint/index is missing.

## 3. Apply 0095 (admin audit logs) — SEPARATE STEP
```bash
alembic upgrade 0095_customer_admin_audit_logs
```
**Expected:** creates the enum, table, 7 indexes, the partial-unique, the function + append-only trigger; `alembic current` → `0095_customer_admin_audit_logs`. Verify (read-only):
```sql
SELECT version_num FROM alembic_version;                                   -- 0095_customer_admin_audit_logs
SELECT to_regclass('public.customer_admin_audit_logs');                    -- non-NULL
SELECT typname FROM pg_type WHERE typname='customer_admin_audit_outcome_enum';          -- 1 row
SELECT indexname FROM pg_indexes WHERE tablename='customer_admin_audit_logs' ORDER BY 1;
--   expect 9 rows: the 8 indexes 0095 creates (6 ix_* b-tree, ix_cust_admin_audit_created DESC,
--   and the partial-unique uq_cust_admin_audit_refund_success) PLUS the primary-key index
--   customer_admin_audit_logs_pkey (implicit from the BIGINT PK).
SELECT proname FROM pg_proc WHERE proname='fn_block_customer_admin_audit_mutation';      -- 1 row
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname='trg_block_customer_admin_audit_mutation'; -- 1 row, enabled 'O'
```
**STOP** if the enum, trigger, function, or any index is missing.

## 4. Append-only enforcement — verify by catalog (read-only); optional safe functional test

A row-level `BEFORE UPDATE OR DELETE` trigger does **not** fire for a statement that
matches no rows, so an `UPDATE … WHERE false` proves nothing. Verify from the catalog
(read-only); run the functional test only inside a transaction that is rolled back, so
**no production data changes**.

```sql
-- (a) Trigger attached, enabled, BEFORE, row-level, on UPDATE and DELETE (read-only):
SELECT tgname,
       tgrelid::regclass      AS on_table,
       tgenabled              AS enabled,       -- 'O' = enabled
       (tgtype & 1)  <> 0     AS is_row_level,  -- expect t
       (tgtype & 2)  <> 0     AS is_before,     -- expect t
       (tgtype & 16) <> 0     AS on_update,     -- expect t
       (tgtype & 8)  <> 0     AS on_delete,     -- expect t
       pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgname = 'trg_block_customer_admin_audit_mutation' AND NOT tgisinternal;

-- (b) Function exists and raises the append-only exception (inspect the body):
SELECT proname, pg_get_functiondef(oid) AS definition
FROM pg_proc WHERE proname = 'fn_block_customer_admin_audit_mutation';
--   body must contain: RAISE EXCEPTION 'customer_admin_audit_logs is append-only'
```

```sql
-- (c) OPTIONAL functional proof — DISPOSABLE ROW, inside a transaction, ALWAYS rolled back.
--     Run as the OWNER (who HAS update/delete), so it is the TRIGGER — not a permission —
--     that blocks the mutation. Nothing persists.
BEGIN;
  INSERT INTO public.customer_admin_audit_logs (action, outcome)
  VALUES ('migration.appendonly_selftest', 'success');   -- throwaway; entity_type NULL avoids the
                                                          -- refund-success partial-unique index
  -- The next statement MUST raise 'customer_admin_audit_logs is append-only':
  UPDATE public.customer_admin_audit_logs
     SET reason = 'should fail'
   WHERE action = 'migration.appendonly_selftest';
ROLLBACK;   -- discards BOTH the test INSERT and the blocked UPDATE — no row is left behind
-- After ROLLBACK, confirm nothing persisted:
SELECT count(*) FROM public.customer_admin_audit_logs
 WHERE action = 'migration.appendonly_selftest';         -- expect 0
```
Expected: (a) one trigger row with all four flags true, enabled `O`; (b) the function body shows the `RAISE EXCEPTION`; (c) the `UPDATE` errors with the append-only message and the post-rollback count is `0`. (A `DELETE … WHERE action='migration.appendonly_selftest'` inside the same rolled-back transaction is an equivalent check.)

## 5. Runtime-role GRANT/REVOKE for 0095 (SEPARATE; owner role)
The migration grants nothing. Apply, as the owner, on the **runtime application role** (the role the app's `DATABASE_URL` uses):
```sql
GRANT  INSERT, SELECT             ON public.customer_admin_audit_logs TO <runtime_role>;
REVOKE UPDATE, DELETE, TRUNCATE   ON public.customer_admin_audit_logs FROM <runtime_role>;
```
Verify:
```sql
SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_schema='public' AND table_name='customer_admin_audit_logs'
   AND grantee='<runtime_role>' ORDER BY 2;         -- expect ONLY INSERT, SELECT
```
**Note:** if the runtime role is a superuser/`rds_superuser` (e.g. the app still connects as the master user), `REVOKE` cannot restrict it — append-only then rests entirely on the trigger (which blocks even superusers, since it RAISEs). The GRANT/REVOKE is meaningful only once a non-superuser runtime role is in use. The runtime role also needs normal DML on `customer_refund_attempts`; confirm it has it.

## 6. Post-migration acceptance
- [ ] `alembic current` = `0095_customer_admin_audit_logs`.
- [ ] §2 + §3 verification queries all return the expected objects.
- [ ] §4 trigger + function verified from the catalog (flags BEFORE/row-level/UPDATE/DELETE true, enabled; body raises append-only); if the optional §4(c) disposable-row test was run, the UPDATE errored and the post-rollback count is 0.
- [ ] §5 grants show INSERT+SELECT only for the runtime role (or the superuser caveat is documented).
- [ ] App health re-checked (the M0 readiness gate now passes; audited B2C-admin operations no longer 503).

## Rollback note
`0095`/`0094` `downgrade` **drops** these objects; 0095's downgrade **destroys audit history**. Prefer a forward fix; downgrade only under the same approval as any destructive operation, after a backup.

---

**Order is fixed: pre-checks → 0094 → verify → 0095 → verify → grants → acceptance.** Stop at the first failed pre-check or unexpected schema. Claude executed nothing; no production connection, no migration, no DDL/DML, no permission or code change; commits, backup branch, and the 139 uncommitted files are untouched.
