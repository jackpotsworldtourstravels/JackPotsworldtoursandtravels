# PostgreSQL Role Separation — DBA Handover & Execution Runbook

**Project:** JackPots World Tours & Travels · **For:** the DBA implementing role separation + staging prep (Stage 3)
**Date:** 2026-11-13
**This document is instructions only.** It was prepared read-only: no PostgreSQL connection, no SQL executed, no role created, no GRANT/REVOKE, no Alembic, no deploy/commit. Nothing here runs by itself — **you (the DBA) run it, after the approvals noted.**

### How to read the tags
- **[REPO-VERIFIED]** — a fact confirmed in the application source; safe to rely on.
- **[DBA ACTION]** — a step you perform.
- **[LIVE VERIFY]** — you must confirm this against the live database before proceeding (it may differ from the repo).
- **[APPROVAL REQUIRED]** — do not run until the owner has approved this specific step.

### Golden rules (do not deviate)
1. **Runtime uses a NON-OWNER role.** The app must connect as `runtime_role`, never the DB owner/superuser — otherwise every REVOKE below is bypassed and this work is cosmetic.
2. **Migrations use the DEDICATED migration role.** Alembic connects as `migration_role` (owner/DDL) via `MIGRATION_DATABASE_URL`.
3. **No blanket EXECUTE grant.** Never `GRANT EXECUTE ON ALL FUNCTIONS … TO runtime_role`. Grant only the listed routines (Step 7).
4. **Never grant runtime EXECUTE on `sp_register_partner`** (it writes an admin password hash). Also never grant `sp_log_partner_activity`, `sp_complete_booking`, or any trigger `fn_*`.
5. **Audit table runtime access = INSERT + SELECT only.** `UPDATE`/`DELETE`/`TRUNCATE` must be revoked; the append-only trigger is the hard guard.
6. **Verify live `sp_*` signatures before granting** (Step 7 pre-check) — PostgreSQL identifies functions by argument-type list.
7. **Verify PUBLIC-privilege dependencies before revoking** (Step 7 pre-check) — another login may rely on PUBLIC.
8. **Keep Gaming Tour Packages disabled** throughout (no action needed; just do not enable them).

> Role names below are **approved placeholders**: `migration_role` and `runtime_role` (psql variables `:"migration_role"` / `:"runtime_role"`). Substitute your real names consistently; **do not reuse the same role across staging and production.** Passwords come from the secret store — never commit them.

---

## 1. Architecture & the two-role design [REPO-VERIFIED]

- **One PostgreSQL database.** B2B tables (`models_v2` Base) and B2C tables (`models_customer` Base) share it (logical separation, one Alembic history, head `0095`).
- **Two roles:**
  - **`migration_role`** — owner/DDL. Owns the schema and all objects; runs `alembic upgrade head`. Used ONLY by the separate migration step.
  - **`runtime_role`** — restricted app login. `LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT`. DML on tables, `USAGE/SELECT` on sequences, `EXECUTE` on exactly the functions the app calls. No DDL. **The app connects as this role.**
- **Runtime vs migration URLs:** the app engine (`backend/app/database/session.py`) uses `DATABASE_URL`; Alembic (`backend/alembic/env.py`) uses `settings.alembic_url` = `MIGRATION_DATABASE_URL`. On a deployed host, migrations **fail closed** without `MIGRATION_DATABASE_URL`.

## 2. Preconditions (before any change)

- [DBA ACTION] Take a full `pg_dump` backup; rehearse a restore on a scratch instance; record a per-table row-count manifest.
- [DBA ACTION] Save a **privilege snapshot**: run the Step 10 verification queries now (pre-change) and keep the output for rollback comparison.
- [LIVE VERIFY] Confirm the current schema/object **owner** (needed for `REASSIGN OWNED`).
- [LIVE VERIFY] Confirm Alembic current revision = `0094_customer_refund_attempts` and chain head = `0095`.
- [LIVE VERIFY] Confirm the **exact `sp_*` signatures** on the live catalog match this runbook (Step 10.4 query) — repo source is `database/10_procedures.sql` [REPO-VERIFIED], but confirm no drift.
- [LIVE VERIFY] Confirm **no other login depends on `PUBLIC`** EXECUTE or PUBLIC table grants before the REVOKEs.
- [DBA ACTION] Obtain role names + passwords from the secret store. [APPROVAL REQUIRED] to create roles.

## 3. Exact execution order

1. Preconditions (Step 2) complete. [DBA ACTION]/[LIVE VERIFY]
2. **Create roles** (Step 4). [APPROVAL REQUIRED]
3. **Reassign ownership** to `migration_role` (Step 5). [APPROVAL REQUIRED]
4. **Apply migration `0095`** as `migration_role` (Step 9). [APPROVAL REQUIRED]
5. **Runtime grants:** schema → tables → sequences (Step 6). [APPROVAL REQUIRED]
6. **Function EXECUTE:** `REVOKE … FROM PUBLIC` (after the PUBLIC pre-check), then the exact routine grants (Step 7). [APPROVAL REQUIRED]
7. **Audit-table restriction** (Step 8) — run AFTER Step 6's table grant. [APPROVAL REQUIRED]
8. **Default privileges** (Step 9b). [APPROVAL REQUIRED]
9. **Point the app** `DATABASE_URL` → `runtime_role`; Alembic `MIGRATION_DATABASE_URL` → `migration_role` (Step 11). [DBA ACTION]
10. **Verify** (Step 10) — all expectations met. [LIVE VERIFY]
11. App smoke + readiness check. [DBA ACTION]

## 4. Role creation SQL [APPROVAL REQUIRED]

```sql
-- Run as a superuser. Passwords from the secret store (placeholders).
CREATE ROLE :"migration_role" LOGIN PASSWORD :'migration_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;             -- owner/DDL
CREATE ROLE :"runtime_role"   LOGIN PASSWORD :'runtime_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;   -- app
```

## 5. Schema / object ownership [APPROVAL REQUIRED] / [LIVE VERIFY]

```sql
ALTER SCHEMA public OWNER TO :"migration_role";
-- Reassign existing objects from the current owner (confirm its name first — [LIVE VERIFY]):
REASSIGN OWNED BY :"current_owner" TO :"migration_role";
```

## 6. Runtime table & sequence permissions [APPROVAL REQUIRED]

```sql
GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO :"runtime_role";
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";
```
Note [REPO-VERIFIED]: the app uses `nextval()` (a built-in) in raw SQL — covered by the sequence `USAGE` above; unaffected by the PUBLIC revoke in Step 7.

## 7. Routine EXECUTE permissions [APPROVAL REQUIRED]

**Pre-checks first:** [LIVE VERIFY] confirm the signatures below against the live catalog (Step 10.4); [LIVE VERIFY] confirm no other login relies on PUBLIC EXECUTE.

```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;   -- no blanket grant; selective below
-- App-called (21) + nested (2). Signatures are the creating definitions in database/10_procedures.sql [REPO-VERIFIED].
GRANT EXECUTE ON FUNCTION public.sp_partner_login_lookup(character varying)                                   TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_partner_record_login(integer, character varying)                          TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_request_otp(integer, character varying, otp_purpose_enum, integer)        TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_verify_otp(integer, otp_purpose_enum, character varying)                  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_update_partner_profile(integer, character varying, character varying)     TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_get_dashboard_statistics(integer)                                         TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_get_request_history(integer, booking_status_enum, date, date)             TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_get_ticket_enquiry(character varying, character varying, date, character varying) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_create_ticket_request(integer, integer, travel_type_enum, integer, integer, integer, character varying, character varying, trip_type_enum, character varying, character varying, date, date, cabin_class_enum) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_add_passenger(integer, character varying, gender_enum, passenger_type_enum, integer, character varying, date, date, date, integer, character varying, text, integer, integer, seat_preference_enum) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_set_passenger_special_services(integer, integer[])                        TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_submit_request_for_approval(integer)                                      TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_approve_request(integer, integer, numeric)                                TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_reject_request(integer, integer, text)                                    TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_resolve_service_request(integer, service_request_status_enum, integer)    TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_admin_list_partner_bookings(booking_status_enum, character varying)       TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_generate_report(integer, integer, date, date, date, date, character varying, character varying, character varying, character varying, export_format_enum) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_cancel_selected_passengers(character varying, integer[], text, integer)   TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_create_date_change_request(character varying, integer, date, text, integer) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_create_refund_request(character varying, numeric, text, integer)          TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_create_passenger_modification_request(character varying, integer, character varying, character varying, character varying, text, integer) TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.sp_generate_booking_reference(integer)                                       TO :"runtime_role";  -- nested in create-ticket + fn_auto_generate_* trigger
GRANT EXECUTE ON FUNCTION public.sp_generate_service_request_number()                                         TO :"runtime_role";  -- nested (triggers on runtime DML)
```
**NEVER granted to `runtime_role`** [REPO-VERIFIED unused, and confirmed not nested by any granted function/trigger]:
`sp_register_partner(...)` (**writes an admin password hash**), `sp_log_partner_activity(...)`, `sp_complete_booking(integer)`, and all trigger `fn_*` (incl. `fn_write_audit_log`, `fn_block_customer_admin_audit_mutation`, `fn_auto_generate_*`, `fn_audit_*`).

## 8. Audit-table append-only protection [APPROVAL REQUIRED] — run AFTER Step 6

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.customer_admin_audit_logs FROM :"runtime_role";
REVOKE ALL                       ON TABLE public.customer_admin_audit_logs FROM PUBLIC;
-- INSERT, SELECT remain for runtime.
```
[REPO-VERIFIED] The app writes this table INSERT-only and reads SELECT-only (no audit UPDATE/DELETE in code). The append-only trigger `trg_block_customer_admin_audit_mutation` (fires `BEFORE UPDATE OR DELETE` for **every** role, owner included) is the hard guard; the REVOKEs are defence-in-depth that bite for the non-owner `runtime_role`. **Do not** REVOKE from `migration_role`/owner (an owner cannot be stripped of its own object privileges — the trigger constrains it).

## 9. Migration 0095 — prerequisites & execution [APPROVAL REQUIRED]

Prereqs [REPO-VERIFIED unless noted]: `0094` applied [LIVE VERIFY current revision]; PostgreSQL (JSONB, ENUM, plpgsql trigger, partial-unique index); run as `migration_role`; `MIGRATION_DATABASE_URL` set (fail-closed otherwise). Creates: enum `customer_admin_audit_outcome_enum (success,failure,denied,partial)`; table `customer_admin_audit_logs` (19 cols; `admin_user_id` BIGINT, no FK); 7 indexes + the partial-unique `uq_cust_admin_audit_refund_success`; function + `BEFORE UPDATE OR DELETE` trigger. It issues **no** GRANT/REVOKE (that's Steps 6–8).

```sql
-- As migration_role, via the separate step (NOT the app container):
-- cd backend && alembic upgrade head        (MIGRATION_DATABASE_URL in the environment)
```
Rollback of `0095` is **destructive** (drops the audit table + its rows) — owner-approved, staging-only; prefer fix-forward.

### 9b. Default privileges for future objects [APPROVAL REQUIRED]

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA public GRANT USAGE, SELECT                 ON SEQUENCES TO :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA public REVOKE EXECUTE                      ON FUNCTIONS FROM PUBLIC;
```
**Standing rule:** a FUTURE append-only table (like `customer_admin_audit_logs`) will inherit UPDATE/DELETE from the default privileges above — each such table needs its own `REVOKE UPDATE, DELETE, TRUNCATE … FROM :"runtime_role"` plus an append-only trigger in its migration.

## 10. Read-only verification SQL [LIVE VERIFY] (run after Steps 4–9b)

```sql
-- 10.1 role attributes
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin
FROM pg_roles WHERE rolname IN (:'migration_role', :'runtime_role');
-- runtime: rolsuper=f, rolcreatedb=f, rolcreaterole=f, rolinherit=f, rolcanlogin=t

-- 10.2 ownership (0095 table owned by migration_role)
SELECT relname, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname='customer_admin_audit_logs';

-- 10.3 runtime table/sequence privileges (spot-check)
SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
WHERE grantee=:'runtime_role' ORDER BY table_name, privilege_type;

-- 10.4 function EXECUTE + signatures (confirm the granted set and catch drift)
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege(:'runtime_role', p.oid, 'EXECUTE') AS can_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname LIKE 'sp\_%' ORDER BY p.proname;
-- can_exec = t ONLY for the Step 7 set; f for sp_register_partner / sp_log_partner_activity / sp_complete_booking

-- 10.5 audit-table restriction
SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_name='customer_admin_audit_logs' AND grantee=:'runtime_role';     -- EXACTLY: INSERT, SELECT
SELECT has_table_privilege(:'runtime_role','public.customer_admin_audit_logs','UPDATE') AS can_update;  -- f

-- 10.6 default privileges
SELECT defaclobjtype, defaclacl FROM pg_default_acl d JOIN pg_roles r ON r.oid=d.defaclrole WHERE r.rolname=:'migration_role';

-- 10.7 migration revision
SELECT version_num FROM alembic_version;   -- 0095_customer_admin_audit_logs
```

## 11. Application configuration [DBA ACTION]

- **`DATABASE_URL`** (app, `backend/.env` / host env) → **`runtime_role`** (least-privilege). This is what makes the REVOKEs effective.
- **`MIGRATION_DATABASE_URL`** (migration step only) → **`migration_role`**. Keep it in the protected `backend/.env.migration` (gitignored, `chmod 600`) or a transient secret — **never** in `backend/.env` (the app container's env_file). On deployed hosts the migration fails closed without it.
- Keep `DEPLOYED=true`, `DEBUG=false`, CORS/`FRONTEND_BASE_URL`, and SMTP set per the staging runbook.

## 12. Backup & rollback

- **Backup:** Step 2 `pg_dump` + verified restore + privilege snapshot (Step 10 output pre-change).
- **Rollback of grants/roles:** `REVOKE`/`DROP ROLE` (a role can be dropped only after `REASSIGN OWNED`/objects handled). **Ordering:** if you back out, switch the app `DATABASE_URL` **back to the owner first**, THEN revoke/drop — revoking runtime grants while the app still points at `runtime_role` breaks the app.
- **Emergency fallback:** reverting the app to the owner login restores service but **also restores excessive runtime privileges** (by design); the append-only trigger still guards the audit table. Re-establish the split afterward.
- **`0095` downgrade:** destructive (drops audit data) — owner-approved, staging-only.

## 13. DBA sign-off checklist

- [ ] Backup taken + restore rehearsed; pre-change privilege snapshot saved. [DBA ACTION]
- [ ] Roles created with correct attributes (10.1). [APPROVAL REQUIRED]
- [ ] `migration_role` owns schema + `0095` objects (10.2); `0095` applied as `migration_role`.
- [ ] Runtime has table/sequence privileges; **no DDL** (10.3).
- [ ] Runtime EXECUTE on exactly the Step 7 set; **not** `sp_register_partner`/`sp_log_partner_activity`/`sp_complete_booking`/`fn_*` (10.4). [LIVE VERIFY signatures]
- [ ] `REVOKE EXECUTE … FROM PUBLIC` run only after confirming no other login needs it. [LIVE VERIFY]
- [ ] Audit table: runtime `INSERT, SELECT` only; UPDATE/DELETE RAISE (10.5); trigger present.
- [ ] Default privileges set (10.6); future append-only tables flagged for their own REVOKE + trigger.
- [ ] App `DATABASE_URL` → `runtime_role`; Alembic `MIGRATION_DATABASE_URL` → `migration_role` (non-owner runtime enforced).
- [ ] `alembic_version = 0095…` (10.7); audit readiness flips to ready; app smoke passes.
- [ ] Gaming Tour Packages remain disabled.

---

**Separation of concerns in this runbook:** sections marked [REPO-VERIFIED] are facts from the application source; [DBA ACTION] are steps you run; [LIVE VERIFY] must be confirmed against the live database; [APPROVAL REQUIRED] need the owner's go-ahead. **This handover changed nothing** — documentation only; no DB connection, no SQL, no roles, no GRANT/REVOKE, no Alembic, no deploy/commit; all existing work preserved; Gaming Tour Packages disabled; not a production-readiness claim.

**Document created:** `docs/POSTGRESQL_DBA_HANDOVER_AND_EXECUTION_RUNBOOK.md`.
