# Stage 3 — Blocker Resolution & Approval Plan

**Project:** JackPots World Tours & Travels · **Module:** B2C Admin Portal (Stage 3: M0, M1, M2.1–M2.3)
**Date:** 2026-11-13
**Nature:** Documentation + read-only inspection only. **No PostgreSQL connection, no migration execution, no source/test/migration edit, no deploy/commit/push, no secrets shown.** Gaming disabled. Stage 4 not started. **Production readiness is NOT claimed.**

**Documents read:** `docs/STAGE_3_FINAL_COMPLETION_REPORT.md`, `docs/STAGE_3_DATABASE_DEPLOYMENT_CHECKLIST.md`, `docs/STAGE_3_STAGING_READINESS_ASSESSMENT.md`, `docs/STAGE_3_PROGRESS.md`.

**Owner key:** DEV = developer · DBA = authorized database administrator · INFRA = infrastructure/admin (env, secrets, scopes) · OWNER = project owner (you).

---

## 1. Blocker register

| # | Blocker | Why it exists | Owner | Exact action required | Dependency (order) | Approval requirement | Completion evidence |
|---|---|---|---|---|---|---|---|
| B1 | **Migration `0095` unapplied** — every audited admin action returns 503 (M0 fail-closed) | The `customer_admin_audit_logs` table does not exist until `0095` runs; it was created-only, never executed | DBA | `alembic upgrade head` (applies `0095` only) on staging | After B3 (backup), B5 (DB/env), B6 (confirm current=`0094`) | **OWNER APPROVAL** + DBA | `alembic_version` = `0095_customer_admin_audit_logs`; table/enum/indexes/trigger present (checklist §6) |
| B2 | **App-role privilege step** (INSERT/SELECT grant; revoke UPDATE/DELETE/TRUNCATE) | The migration deliberately contains no GRANT/REVOKE; privilege model is an out-of-band DBA step | DBA | Grant `INSERT, SELECT` on the table to the app login; revoke `UPDATE, DELETE, TRUNCATE`; table/trigger owned by DDL role | After B1 | **OWNER APPROVAL** + DBA | `information_schema.role_table_grants` shows INSERT/SELECT only; a direct `UPDATE`/`DELETE` RAISEs (append-only) |
| B3 | **Backup + restore rehearsal** not done | No safe recovery point before a schema change | DBA | `pg_dump` the staging DB; rehearse restore on a scratch instance; record manifest | Before B1 | REQUIRES AUTHORIZATION (DBA) | Backup artifact + restore-test log + row-count manifest |
| B4 | **SMTP not configured** (M2.2 email + M1 reset) | `SMTP_HOST`/`SMTP_FROM_EMAIL` unset → `_send` returns False → 502 (no false success) | INFRA | Set `SMTP_HOST/PORT/USERNAME/PASSWORD/USE_TLS/FROM_EMAIL/FROM_NAME` from the secret store | Before test case 7.2/7.7 | REQUIRES AUTHORIZATION (INFRA) | Secrets present (names only); a test email delivers (200 `delivered:true`) |
| B5 | **Staging DB + app not provisioned/deployed; runtime config unset** (`DEPLOYED=true`, `DEBUG=false`, `CORS_ORIGINS`, `FRONTEND_BASE_URL`, `DATABASE_URL`, `JWT_SECRET_KEY`) | No staging environment exists yet at Stage-3 code with correct config | INFRA | Provision PostgreSQL staging + deploy app; set the config/secrets | Before B1/B6 | **OWNER APPROVAL** (deploy) + INFRA | App boots on staging; `DEBUG=false` (reset link not returned by the API); `DEPLOYED=true` |
| B6 | **Confirm current revision = `0094`** before upgrade | Must ensure a clean linear chain head before applying `0095` | DBA | `alembic current` (expect `0094_customer_refund_attempts`); `alembic heads` (expect single head `0095`) | After B5; before B1 | REQUIRES AUTHORIZATION (DBA) | `alembic current` output = `0094...`; single head `0095` |
| B7 | **Operator scope grants** (`b2c.customers.manage`, `b2c.communication.send`, `b2c.audit.view`) | These scopes are in no role default; an operator needs explicit grants (or super-admin) to use the features | INFRA/admin | Grant the scopes to the staging operator account(s), or use a super-admin for verification | After B5 | REQUIRES AUTHORIZATION (INFRA/admin) | Operator reaches the endpoints; a caller without the scope → 403 + DENIED audit |
| B8 | **Authenticated UI verification** of M1/M2 flows never done | No authenticated staging environment existed; verified locally only by code inspection + static tests | DEV + QA | Walk the admin Communication + customer-admin flows in an authenticated browser on staging | After B1, B4, B7 | REQUIRES AUTHORIZATION (access) | Walkthrough notes/screenshots for notify, email, reply, block/unblock, reset; matches §7 expected results |
| B9 | **Application code (M0/M1/M2)** | — | DEV | None — implemented and locally tested | — | — | **READY**; full suite 1781 passed / 44 pre-existing failures / 4 skipped; focused suites green |

> Note: the `0095` **downgrade** destroys the audit table and any rows written since — it is not a routine rollback. Using it is a separate **OWNER APPROVAL** + DBA decision, acceptable on staging only; prefer fixing forward (checklist §3/§5).

## 2. Checks completable WITHOUT database access (already done — DEV)

These require no DB and are **DONE** (evidence in the Stage-3 docs); they de-risk B1 before any DBA action:
- Migration ↔ model parity (19 columns, 7 indexes, enum, trigger) — file-verified.
- Alembic chain/head confirmed **offline** from version files (`0095 → 0094 → 0093`, single head) — no DB.
- Full backend test suite on the SQLite harness: **1781 passed, 44 pre-existing failures, 4 skipped** (no new regressions).
- Static frontend presence tests (compose/email/reply controls + POST paths) — green.
- Config-variable inventory (names only) — complete.
**Status: READY (DEV side).** No further no-DB check is outstanding.

## 3. Correct execution order (dependency-sequenced)

1. **B9 / §2 (DEV, done)** — no-DB pre-checks complete.
2. **B5 (INFRA + OWNER)** — provision staging DB + app; set `DATABASE_URL`, `JWT_SECRET_KEY`, `DEPLOYED=true`, `DEBUG=false`, `CORS_ORIGINS`, `FRONTEND_BASE_URL`.
3. **B4 (INFRA)** — set SMTP secrets.
4. **B3 (DBA)** — backup + restore rehearsal.
5. **B6 (DBA)** — confirm `alembic current` = `0094`, single head `0095`.
6. **B1 (OWNER APPROVAL → DBA)** — `alembic upgrade head`.
7. **B2 (OWNER APPROVAL → DBA)** — grant/revoke privilege step.
8. **B7 (INFRA/admin)** — grant operator scopes.
9. **Readiness confirm (DEV/DBA)** — M0 gate flips without restart; `GET /api/admin/b2c-audit` → 200.
10. **B8 (DEV + QA)** — authenticated UI + application test cases (§7 of the staging assessment), including an SMTP test email and the append-only RAISE check.
11. **Sign-off (OWNER)** — §5.

## 4. Approval / responsibility summary

- **Requires OWNER approval:** B5 (deploy), B1 (apply `0095`), B2 (privilege change), any use of the destructive downgrade, and any later production rollout (out of scope here).
- **Authorized DBA only:** B3 (backup/restore), B6 (revision confirm), B1 (`alembic upgrade head`), B2 (grant/revoke), §6 verification queries.
- **INFRA/admin:** B4 (SMTP), B5 (provisioning/config), B7 (scope grants).
- **DEV/QA:** B9/§2 (done), readiness confirm, B8 (UI + app test cases).

## 5. Final conditions for Stage 3 staging sign-off

All must hold, each with the evidence above:
1. `0095` applied; schema (19 columns, enum, 7 indexes + partial-unique, trigger/function) verified (B1 + checklist §6).
2. App-role privileges correct and append-only enforced — a direct `UPDATE`/`DELETE` RAISEs (B2).
3. Backup taken and restore rehearsed (B3).
4. SMTP working — a test email delivers; no verified email → 422; SMTP down → 502 (B4, §7.2–7.4).
5. `DEPLOYED=true`, `DEBUG=false`, CORS/`FRONTEND_BASE_URL` set; reset link never returned by the API (B5, §7.7).
6. Operator scope enforcement verified — authorized passes; unauthorized → 403 + DENIED (B7, §7.8).
7. M0 readiness flips to ready without restart; `GET /api/admin/b2c-audit` → 200 (§7.10).
8. Authenticated UI verification of notify/email/reply/block/unblock/reset completed and matches expected results (B8, §7).
9. Refund audit atomicity confirmed; Gaming disabled confirmed (§7.11–7.12).

**Only when 1–9 are evidenced is Stage 3 signed off for staging.** This is a **staging** sign-off gate; it is **not** a production-readiness claim, and a production rollout is a separate, later authorization.

---

## 6. Report

- **Inspected (read-only):** `docs/STAGE_3_FINAL_COMPLETION_REPORT.md`, `docs/STAGE_3_DATABASE_DEPLOYMENT_CHECKLIST.md`, `docs/STAGE_3_STAGING_READINESS_ASSESSMENT.md`, `docs/STAGE_3_PROGRESS.md`.
- **Created:** `docs/STAGE_3_BLOCKER_RESOLUTION_PLAN.md` (this file) — a 9-blocker register with owner/action/dependency/approval/evidence, the no-DB checks already complete, the dependency-sequenced execution order, the approval/responsibility split, and the staging sign-off conditions.
- **Confirmations:** no database connection, no migration execution, no source/test/migration-file change, no deploy/commit/push/merge; no secrets exposed; Gaming Tour Packages remain disabled; Stage 4 not started; production readiness not claimed.
