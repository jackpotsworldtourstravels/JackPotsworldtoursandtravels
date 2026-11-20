# Admin Portal — DBA & Staging Final Readiness Review

**Project:** JackPots World Tours & Travels · **Scope:** DBA privilege model + staging readiness for Stage 3 (audit infra + role separation)
**Date:** 2026-11-13
**Nature:** READ-ONLY. **No PostgreSQL connection, no query, no role creation, no GRANT/REVOKE, no migration execution, no deploy/commit/push, no app-code change.** No secrets shown. **Not a production-readiness claim.**

**Labels:** **[VERIFIED]** = observed in repository source · **[PROPOSED]** = recommended, not applied · **[UNRESOLVED/LIVE]** = needs confirmation against the live DB/DBA.

**Docs reviewed:** `STAGE_3_DATABASE_ROLE_SEPARATION_FINAL_SPECIFICATION.md`, `STAGE_3_DATABASE_PRIVILEGE_VALIDATION_REVIEW.md`, `STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md`, `STAGE_3_DATABASE_DEPLOYMENT_CHECKLIST.md`, `STAGE_3_FINAL_PRE_DEPLOYMENT_REVIEW.md` (+ `backend/alembic/versions/0095_…py`, `deploy/*`, `backend/app/config.py` for grounding).

---

## 1. Role privilege matrix

| Capability | `migration_role` (DDL/owner) | `runtime_role` (app, least-privilege) | Source |
|---|---|---|---|
| Login attrs | LOGIN; owns schema objects | LOGIN, **NOSUPERUSER, NOINHERIT** | spec §0 [VERIFIED intent] |
| Alembic / DDL (CREATE/ALTER/DROP table, index, sequence, enum, trigger, function) | **Yes** (runs `alembic upgrade head`; owns the objects) | **No** | spec §0/§11 |
| Object ownership + rollback (destructive downgrade) | **Yes** (owns `0095` objects; owner-approved) | No | 0095 + checklist |
| `USAGE ON SCHEMA public` | n/a (owner) | **GRANT** | spec §3.1 [PROPOSED] |
| Tables SELECT/INSERT/UPDATE/DELETE (B2B + B2C: customers, bookings, payments/refunds, support/comms, catalogue) | owner | **GRANT on ALL TABLES** | spec §3.1 [PROPOSED] |
| Sequences USAGE, SELECT (serial/BIGSERIAL PKs incl. 0095) | owner | **GRANT on ALL SEQUENCES** | spec §3.1 [PROPOSED] |
| `customer_admin_audit_logs` | owner (+ append-only trigger still blocks its own UPDATE/DELETE) | **INSERT, SELECT ONLY** — `UPDATE, DELETE, TRUNCATE` **REVOKED** | spec §7 / audit-SQL §4 [PROPOSED] |
| Stored functions (`sp_*`) | owner | `REVOKE EXECUTE … FROM PUBLIC`, then **EXECUTE on exactly the ~24 app-called `sp_*`** (signature-qualified) | spec §3–§6 [PROPOSED] |
| `sp_register_partner` (writes an admin password hash) | owner | **NOT granted** (security-sensitive) | spec §3 [VERIFIED unused] |
| Trigger functions `fn_*` (incl. `fn_write_audit_log`, `fn_block_customer_admin_audit_mutation`) | owner | **No EXECUTE grant** (PG doesn't check EXECUTE for trigger-fired functions) | spec §3 [VERIFIED] |
| Default privileges for future objects | — | `ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role … GRANT …` so later migrations' tables/sequences inherit; `REVOKE EXECUTE … FROM PUBLIC` on future functions | validation §(default privileges) [PROPOSED] |

## 2. SQL review findings

- **[VERIFIED] Runtime data ops:** the app does ORM `SELECT/INSERT/UPDATE/DELETE` across B2B (`models_v2`, legacy `app.models`) and B2C (`models_customer`); explicit commits. Audit writes are **INSERT-only**, reads **SELECT-only** — **no audit `UPDATE`/`DELETE` exists in code** (`customer_admin_audit_service`). Matches the INSERT/SELECT-only audit-table model.
- **[VERIFIED] Over-grant withdrawn:** the earlier plan's `GRANT EXECUTE ON ALL FUNCTIONS … TO :runtime_role` is **not least-privilege** — it would expose `sp_register_partner` (admin-password-hash writer) and all trigger `fn_*`. Correct model is `REVOKE EXECUTE … FROM PUBLIC` + routine-level grants on exactly the invoked `sp_*`.
- **[CRITICAL / LIVE] The current configured login is the database owner/superuser** in both local and staging (staging `POSTGRES_USER` is the container's owner+superuser of the DB). **An owner/superuser bypasses object-level `GRANT`/`REVOKE`** — so the §7 audit REVOKEs are **inert** until the app connects as a *separate, non-owner, non-superuser* `runtime_role`. Today the repo defines **no such role**.
- **[VERIFIED] Audit-table protection is layered:** the append-only trigger `trg_block_customer_admin_audit_mutation` (`BEFORE UPDATE OR DELETE`, fires for **every** role incl. owner/superuser) is the **hard** guard; the `REVOKE UPDATE, DELETE, TRUNCATE` is **defence-in-depth** that only bites for a non-owner runtime role. `TRUNCATE` remains owner-only regardless. `REVOKE ALL … FROM PUBLIC` closes `PUBLIC` grants.
- **[VERIFIED] No `CREATE ROLE`/`GRANT`/`REVOKE` anywhere in `deploy/`, `database/`, `backend/alembic/`.** Every privilege action is an out-of-band DBA step, all marked `[APPROVAL REQUIRED]`; `sp_*` **signatures are [UNRESOLVED]** until confirmed against the live catalog.
- **Ordering requirement:** the audit-table `REVOKE` (§7) must run **after** the schema-wide §3.1 grant, else the blanket grant re-adds UPDATE/DELETE to the audit table.

## 3. Migration 0095 — preconditions & verification

- **Dependencies [VERIFIED]:** `down_revision = 0094_customer_refund_attempts`; single head `0095`; chain `… → 0093 → 0094 → 0095`. `0094` must be applied first. PostgreSQL required (JSONB, ENUM, plpgsql trigger, partial-unique index).
- **Creates [VERIFIED]:** enum `customer_admin_audit_outcome_enum (success,failure,denied,partial)`; table `customer_admin_audit_logs` (19 columns; `admin_user_id` BIGINT, **no FK**); 7 indexes (`…_request_id`, `ix_cust_admin_audit_actor/entity/action/outcome/retention`, `…_created` DESC); partial-unique `uq_cust_admin_audit_refund_success (entity_type, entity_id) WHERE outcome='success' AND entity_type='customer_refund_attempt'`; function + `BEFORE UPDATE OR DELETE` trigger. No GRANT/REVOKE in the migration (out-of-band DBA).
- **Audit-readiness dependency [VERIFIED]:** M0 gate fails closed (503) until `0095` is applied; applying it flips readiness true with no restart.
- **Must be supplied [LIVE]:** `MIGRATION_DATABASE_URL` (fail-closed on deployed hosts) owned by `migration_role`.
- **Rollback risk [VERIFIED]:** `downgrade()` drops trigger → function → table → type and **destroys all audit rows** — owner-approved, staging-only; prefer fix-forward.

## 4. Missing DBA decisions (must be made before staging sign-off)

1. **Create the two roles** — `migration_role` (owner/DDL) and `runtime_role` (non-owner, NOSUPERUSER, NOINHERIT). **Names owner-provided; not in the repo.** `[APPROVAL REQUIRED]` — **the single biggest prerequisite.**
2. **Point the app at `runtime_role`** (not the owner/`POSTGRES_USER`) via `DATABASE_URL`; point Alembic at `migration_role` via `MIGRATION_DATABASE_URL`. Without this split the least-privilege model (and the audit REVOKEs) are **inert**.
3. **Approve + run** the §3.1 schema grants, the routine-level `sp_*` EXECUTE grants (signatures confirmed against the live catalog — **[UNRESOLVED]**), the §7 audit REVOKEs (after §3.1), and `ALTER DEFAULT PRIVILEGES`.
4. **Audit retention durations** (business/legal) — still open from Stage 2; no auto-deletion by default.
5. **Who gets the `b2c.*` scopes** (`b2c.customers.manage`, `b2c.communication.send`, `b2c.audit.view`) — access policy (owner).

## 5. Staging readiness

| Area | State | Label |
|---|---|---|
| Application code (Stage 1/2/3, safeguards, R1/R2/R3) | implemented; backend suite **1847 passed, 0 failed, 4 skipped** | **[VERIFIED] READY** |
| Migration/runtime credential separation + fail-closed | config + scripts + tests in place | **[VERIFIED] READY (code)** |
| Two DB roles created | not defined in repo | **BLOCKER [LIVE/DBA]** |
| App connects as non-owner runtime role | currently owner/superuser | **BLOCKER [LIVE/DBA]** |
| `0095` applied + grants/REVOKEs run | not applied | **BLOCKER [APPROVAL/DBA]** |
| Backup + restore rehearsal | procedure documented | **[LIVE/DBA]** |
| Staging env vars (`DEPLOYED=true`, `DEBUG=false`, CORS, `FRONTEND_BASE_URL`) | compose-forced/documented | **[LIVE] set on host** |
| SMTP (M2.2 + reset; else 502/503) | documented; must be configured | **BLOCKER until set [LIVE]** |
| Admin scope grants | mechanism ready; recipients undecided | **[APPROVAL] [LIVE]** |
| Staging access restriction (HTTP basic auth: `STAGING_BASIC_AUTH_USER/HASH`) | in `stack.env` | **[LIVE] set on host** |
| Authenticated browser verification (M1/M2 flows) | never run (no authed env) | **BLOCKER [LIVE]** |

## 6. Go / No-Go

**Overall: NO-GO for staging sign-off** until the live/DBA prerequisites are met — specifically (a) the two roles exist, (b) the app connects as the **non-owner** `runtime_role`, (c) `0095` + the §3/§4/§7 grants/REVOKEs are applied with the §6 verification evidence, (d) SMTP + scopes + backup are in place, and (e) authenticated UI verification passes.

**What IS ready [VERIFIED]:** the application code, the migration/runtime URL separation, the fail-closed safeguards, R1/R2/R3 corrections, and `0095` itself (offline-validated). The privilege model and SQL are fully specified and reviewed.

**Critical risk to flag:** with the **current owner/superuser login**, the object-level privilege model is **inert** — only the append-only trigger protects `customer_admin_audit_logs`. A genuine least-privilege staging **requires the role split first** (decisions §4.1–§4.2). Until then, "INSERT/SELECT-only runtime" is a design, not an enforced state.

**This review changed nothing** — read-only. No DB connection/query, no role creation, no GRANT/REVOKE, no migration execution, no deploy/commit/push, no app-code change; all existing work preserved; Gaming Tour Packages remain disabled; production readiness not claimed.

**Document created:** `docs/ADMIN_PORTAL_DBA_AND_STAGING_FINAL_READINESS.md`.
