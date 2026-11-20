# PostgreSQL Role Implementation — DBA Package

**Project:** JackPots World Tours & Travels · **Scope:** two-role (migration/owner + runtime/app) least-privilege setup on the single Stage-3 database
**Date:** 2026-11-13
**Nature:** Repository inspection + documentation only. **No PostgreSQL connection, no SQL executed, no role created, no GRANT/REVOKE, no Alembic, no deploy/commit/push, no app-code change.** No secrets. **Not a production-readiness claim.**

**Labels:** **[REPO-VERIFIED]** observed in repo source (file cited) · **[LIVE]** confirm against the live catalog before applying (possible drift) · **[APPROVAL REQUIRED]** owner/DBA sign-off before running · **[PLACEHOLDER]** value the DBA supplies (never invented here).

**Docs read:** `ADMIN_PORTAL_DBA_AND_STAGING_FINAL_READINESS.md`, `STAGE_3_DATABASE_ROLE_SEPARATION_FINAL_SPECIFICATION.md`, `STAGE_3_DATABASE_PRIVILEGE_VALIDATION_REVIEW.md`, `STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md` (+ `database/10_procedures.sql`, `backend/alembic/versions/0095_…py`, `backend/app/` call sites for grounding).

> **CRITICAL PRECONDITION [REPO-VERIFIED + LIVE].** The repository defines **no** roles and **no** GRANT/REVOKE; today the app connects as the database **owner/superuser** (staging `POSTGRES_USER` is the container's owner+superuser). An owner/superuser **bypasses object-level GRANT/REVOKE**, so this entire package is only *effective* once (a) the two roles below exist and (b) the application's `DATABASE_URL` points at the **non-owner** runtime role. Until then the append-only **trigger** is the only thing protecting the audit table. Role names are **[PLACEHOLDER]** — the DBA supplies them; `:"migration_role"` / `:"runtime_role"` are psql variables below.

---

## 1. Complete permission inventory

| Object class | `migration_role` (owner) | `runtime_role` (app) | Source |
|---|---|---|---|
| Schema `public` | owns | `USAGE` | spec §3.1 [REPO-VERIFIED need] |
| All tables (B2B `models_v2` + legacy `app.models` + B2C `models_customer`) | owns | `SELECT, INSERT, UPDATE, DELETE` **except** the audit table (see §3) | app does ORM CRUD across all three layers [REPO-VERIFIED] |
| All sequences (serial/BIGSERIAL PKs incl. `0095`) | owns | `USAGE, SELECT` | INSERTs consume owned sequences [REPO-VERIFIED] |
| Enum/composite types | owns | **no grant needed** — `USAGE` on a type is only restricted if revoked from `PUBLIC`, which this package does not do | audit-SQL §3 note [REPO-VERIFIED] |
| Stored functions `sp_*` | owns | `EXECUTE` on exactly the invoked set (§2); all others revoked from `PUBLIC` | §2 |
| Trigger functions `fn_*` (incl. `fn_write_audit_log`, `fn_block_customer_admin_audit_mutation`) | owns | **no EXECUTE grant** — PostgreSQL does not check EXECUTE for trigger-fired functions | spec §3 [REPO-VERIFIED] |
| `0095` objects (table, enum, 7 indexes, partial-unique, trigger, function) | **owned by whoever runs `alembic upgrade head`** → must be `migration_role` | INSERT/SELECT only on the table (§3) | 0095 + audit-SQL §2 |
| Future objects (later migrations) | owns | inherit via `ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role"` | validation §default-privs [PROPOSED] |

## 2. Stored-function verification (`database/10_procedures.sql`)

**[REPO-VERIFIED]:** `database/10_procedures.sql` defines **26** `public.sp_*` functions; **none** declares `SECURITY DEFINER` → all are PostgreSQL-default **SECURITY INVOKER** (run with the *caller's* privileges, so `runtime_role` also needs the §1 table/sequence grants, and EXECUTE on any nested function). No `PROCEDURE`s. Signatures below are the creating definitions — **[LIVE] confirm no drift on the deployed catalog before granting** (PG resolves functions by input-type list; defaults omitted).

**Granted to `runtime_role` — called by the app** [REPO-VERIFIED call sites in `backend/app/services/*`]:

| Function (type-only signature) | R/W | Nested calls | Why runtime needs EXECUTE |
|---|---|---|---|
| `sp_partner_login_lookup(character varying)` | read | — | partner auth lookup |
| `sp_partner_record_login(integer, character varying)` | write | — | record login |
| `sp_request_otp(integer, character varying, otp_purpose_enum, integer)` | write | — | OTP issue |
| `sp_verify_otp(integer, otp_purpose_enum, character varying)` | write | — | OTP verify |
| `sp_update_partner_profile(integer, character varying, character varying)` | write | — | profile update |
| `sp_get_dashboard_statistics(integer)` | read | — | dashboard |
| `sp_get_request_history(integer, booking_status_enum, date, date)` | read | — | history |
| `sp_get_ticket_enquiry(character varying, character varying, date, character varying)` | read | — | enquiry |
| `sp_create_ticket_request(integer, integer, travel_type_enum, integer, integer, integer, character varying, character varying, trip_type_enum, character varying, character varying, date, date, cabin_class_enum)` | write | **`sp_generate_booking_reference`, `sp_generate_service_request_number`** | booking create |
| `sp_add_passenger(integer, character varying, gender_enum, passenger_type_enum, integer, character varying, date, date, date, integer, character varying, text, integer, integer, seat_preference_enum)` | write | [LIVE confirm] | add passenger |
| `sp_set_passenger_special_services(integer, integer[])` | write | — | passenger SSR |
| `sp_submit_request_for_approval(integer)` | write | — | submit |
| `sp_approve_request(integer, integer, numeric)` | write | — | checker approve |
| `sp_reject_request(integer, integer, text)` | write | — | checker reject |
| `sp_resolve_service_request(integer, service_request_status_enum, integer)` | write | — | resolve SR |
| `sp_admin_list_partner_bookings(booking_status_enum, character varying)` | read | — | admin list |
| `sp_generate_report(integer, integer, date, date, date, date, character varying, character varying, character varying, character varying, export_format_enum)` | read | — | reporting |
| `sp_cancel_selected_passengers(character varying, integer[], text, integer)` | write | [LIVE confirm] | cancel |
| `sp_create_date_change_request(character varying, integer, date, text, integer)` | write | — | date change |
| `sp_create_refund_request(character varying, numeric, text, integer)` | write | — | refund req |
| `sp_create_passenger_modification_request(character varying, integer, character varying, character varying, character varying, text, integer)` | write | — | pax modify |
| `sp_generate_booking_reference(integer)` | write | — | **nested** in create-ticket (INVOKER caller needs EXECUTE on inner) |
| `sp_generate_service_request_number()` | write | — | **nested only** (same reason) |

**NOT granted to `runtime_role`** [REPO-VERIFIED unused by the app]:
- `sp_register_partner(character varying ×5, …)` — **security-sensitive: writes an admin password hash. Must never be runtime-executable.**
- `sp_log_partner_activity(...)`, `sp_complete_booking(integer)` — not called by the app.
- All trigger `fn_*` — need no EXECUTE grant.

## 3. Audit-table protection — `customer_admin_audit_logs`

- **Runtime: `INSERT, SELECT` only.** `UPDATE, DELETE, TRUNCATE` **revoked**. [REPO-VERIFIED: the writer `customer_admin_audit_service` only INSERTs/SELECTs — no audit UPDATE/DELETE in code.]
- **Append-only trigger** `trg_block_customer_admin_audit_mutation` (`BEFORE UPDATE OR DELETE`, `fn_block_customer_admin_audit_mutation()` → RAISE) fires for **every** role incl. owner/superuser — the **hard** guard (created by `0095`). [REPO-VERIFIED]
- **Owner/superuser bypass risk** [REPO-VERIFIED + LIVE]: an owner/superuser bypasses the REVOKEs; the REVOKEs only *bite* for the **non-owner** `runtime_role`. `TRUNCATE` is owner-only regardless. So the INSERT/SELECT-only model is **meaningful only when the app connects as `runtime_role`** (the precondition).
- **Ownership model effectiveness:** `0095` objects are owned by `migration_role` (whoever runs Alembic). `runtime_role` is a distinct non-owner, so the §3 REVOKEs are effective for it, and the trigger covers the owner. **Do not** `REVOKE … FROM :"migration_role"` (an owner cannot be stripped of its own object privileges).

## 4. DBA SQL package (proposed — all `[APPROVAL REQUIRED]`)

> Run as a superuser / the DB owner. Replace every `:"…"` placeholder; **do not** invent role names. **[LIVE] confirm `sp_*` signatures against the catalog first** (§5.4). Nothing here is executed by this package.

```sql
-- 0. Roles -------------------------------------------------------------------
CREATE ROLE :"migration_role" LOGIN PASSWORD :'migration_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;  -- owner/DDL  [APPROVAL REQUIRED][PLACEHOLDER pw]
CREATE ROLE :"runtime_role"   LOGIN PASSWORD :'runtime_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;  -- app  [APPROVAL REQUIRED][PLACEHOLDER pw]
-- (Both LOGIN; neither SUPERUSER/CREATEDB/CREATEROLE; runtime also NOINHERIT. The
--  migration role needs only ownership of this DB's schema/objects — granted by
--  making it the schema/object owner below, not by CREATEDB/CREATEROLE.)

-- 1. Schema ownership --------------------------------------------------------
ALTER SCHEMA public OWNER TO :"migration_role";            -- [APPROVAL REQUIRED]
-- Existing objects were created by the current owner; reassign so the migration
-- role owns them (confirm current owner on the live catalog first — [LIVE]):
REASSIGN OWNED BY :"current_owner" TO :"migration_role";   -- [APPROVAL REQUIRED][PLACEHOLDER current_owner]

-- 2. Runtime: schema + table + sequence privileges ---------------------------
GRANT USAGE ON SCHEMA public TO :"runtime_role";                                        -- [APPROVAL REQUIRED]
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO :"runtime_role"; -- [APPROVAL REQUIRED]
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role"; -- [APPROVAL REQUIRED]

-- 3. Functions: revoke blanket PUBLIC EXECUTE, then grant exactly the invoked set
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;                            -- [APPROVAL REQUIRED]
GRANT EXECUTE ON FUNCTION public.sp_partner_login_lookup(character varying)                                   TO :"runtime_role";  -- [APPROVAL REQUIRED][LIVE sig]
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
GRANT EXECUTE ON FUNCTION public.sp_generate_booking_reference(integer)                                       TO :"runtime_role";  -- merchant_service + nested
GRANT EXECUTE ON FUNCTION public.sp_generate_service_request_number()                                         TO :"runtime_role";  -- nested only
-- NOT granted (verified unused / sensitive): sp_register_partner, sp_log_partner_activity, sp_complete_booking, all fn_* triggers.

-- 4. Audit-table restriction (AFTER the §2 blanket table grant) --------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.customer_admin_audit_logs FROM :"runtime_role"; -- [APPROVAL REQUIRED]
REVOKE ALL                       ON TABLE public.customer_admin_audit_logs FROM PUBLIC;          -- [APPROVAL REQUIRED]
-- INSERT, SELECT remain. (Do NOT revoke from the owner/migration_role; the trigger guards it.)

-- 5. Default privileges for FUTURE objects (created by migration_role) -------
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO :"runtime_role"; -- [APPROVAL REQUIRED]
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA public GRANT USAGE, SELECT                 ON SEQUENCES TO :"runtime_role"; -- [APPROVAL REQUIRED]
ALTER DEFAULT PRIVILEGES FOR ROLE :"migration_role" IN SCHEMA public REVOKE EXECUTE                      ON FUNCTIONS FROM PUBLIC;          -- [APPROVAL REQUIRED]
-- NOTE: a future audit-like table would again need its own UPDATE/DELETE/TRUNCATE REVOKE (default privileges grant them).
```

## 5. Verification queries (read-only; run AFTER applying §4)

```sql
-- 5.1 role attributes
SELECT rolname, rolsuper, rolinherit, rolcanlogin FROM pg_roles WHERE rolname IN (:'migration_role', :'runtime_role');
-- expect runtime: rolsuper=f, rolinherit=f, rolcanlogin=t

-- 5.2 object ownership (0095 objects owned by migration_role)
SELECT relname, pg_get_userbyid(relowner) AS owner FROM pg_class
WHERE relname IN ('customer_admin_audit_logs') ;  -- expect owner = migration_role

-- 5.3 table & sequence privileges for runtime (spot-check a few tables)
SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
WHERE grantee = :'runtime_role' ORDER BY table_name, privilege_type;

-- 5.4 function EXECUTE privileges (and confirm signatures/drift)
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege(:'runtime_role', p.oid, 'EXECUTE') AS can_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname LIKE 'sp\_%' ORDER BY p.proname;
-- expect can_exec = t ONLY for the §2 granted set; f for sp_register_partner/sp_log_partner_activity/sp_complete_booking

-- 5.5 audit-table restriction
SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_name='customer_admin_audit_logs' AND grantee=:'runtime_role';
-- expect EXACTLY: INSERT, SELECT  (no UPDATE/DELETE/TRUNCATE)
SELECT has_table_privilege(:'runtime_role','public.customer_admin_audit_logs','UPDATE') AS can_update; -- expect f

-- 5.6 default privileges
SELECT defaclobjtype, defaclacl FROM pg_default_acl d JOIN pg_roles r ON r.oid=d.defaclrole
WHERE r.rolname=:'migration_role';

-- 5.7 migration revision after deploy
SELECT version_num FROM alembic_version;   -- expect 0095_customer_admin_audit_logs
```

## 6. Implementation sequence

1. **Preconditions (§8).** Backup + restore rehearsal; confirm current owner and `sp_*` signatures on the live catalog ([LIVE]).
2. **Create roles** (§4.0) and set passwords from the secret store ([PLACEHOLDER]).
3. **Ownership** (§4.1): make `migration_role` the schema/object owner (`REASSIGN OWNED`).
4. **Apply `0095`** as `migration_role` (`MIGRATION_DATABASE_URL`) — fail-closed; owns the audit objects.
5. **Runtime grants** (§4.2) → **function grants** (§4.3) → **audit REVOKE** (§4.4, *after* §4.2) → **default privileges** (§4.5).
6. **Point the app** `DATABASE_URL` at `runtime_role`; Alembic `MIGRATION_DATABASE_URL` at `migration_role`.
7. **Verify** (§5) — all expectations met.
8. **App smoke + readiness**: audited actions succeed; `GET /api/admin/b2c-audit` returns 200; an attempted audit `UPDATE`/`DELETE` RAISEs.

## 7. Rollback considerations

- Role/grant changes are reversible with `REVOKE`/`DROP ROLE` (drop needs ownership reassigned/objects dropped first) — **[APPROVAL REQUIRED]**.
- If the role split must be backed out, revert the app `DATABASE_URL` to the prior owner login (the app keeps working; least-privilege is simply not enforced) — the append-only trigger still protects the audit table.
- `0095` downgrade is destructive (drops the audit table + rows) — owner-approved, staging-only; prefer fix-forward.
- Take a privilege snapshot (run §5 queries and save output) before changes so the prior state is restorable.

## 8. Preconditions

- Backup taken + restore rehearsed. **[LIVE/DBA]**
- Current DB owner identified; `sp_*` signatures confirmed against the live catalog (§5.4). **[LIVE]**
- `0094` applied; chain head `0095`. **[REPO-VERIFIED chain / LIVE current revision]**
- Role names + passwords provided from the secret store. **[PLACEHOLDER]**
- `MIGRATION_DATABASE_URL` (migration role) and runtime `DATABASE_URL` (runtime role) prepared, kept separate (never in the app's `backend/.env` for the migration credential). **[REPO-VERIFIED mechanism]**

## 9. DBA sign-off checklist

- [ ] Roles created with correct attributes (§5.1). **[APPROVAL REQUIRED]**
- [ ] `migration_role` owns schema + `0095` objects (§5.2). 
- [ ] Runtime has table/sequence privileges; **no DDL** (§5.3).
- [ ] Runtime has EXECUTE on exactly the §2 set; **not** `sp_register_partner`/`sp_log_partner_activity`/`sp_complete_booking`/`fn_*` (§5.4).
- [ ] Audit table: runtime `INSERT, SELECT` only; UPDATE/DELETE RAISE/denied (§5.5); trigger present.
- [ ] Default privileges set so future objects inherit (§5.6); future audit-like tables re-REVOKED.
- [ ] App connects as **runtime_role** (not owner/superuser); Alembic as **migration_role**.
- [ ] `alembic_version = 0095…` (§5.7); readiness flips; smoke passes.
- [ ] Backup + rollback snapshot retained.

---

**Verified-repo vs live:** function signatures, call sites, security mode, the audit writer's INSERT/SELECT-only behaviour, the trigger, and the migration chain are **[REPO-VERIFIED]**; the current DB owner, catalog signature match, role existence, and effective grants are **[LIVE]** — confirm before/after applying. **This package changed nothing** (read-only); no DB connection, no SQL run, no roles, no GRANT/REVOKE, no Alembic, no deploy/commit; Gaming Tour Packages remain disabled; not a production-readiness claim.

**Document created:** `docs/POSTGRESQL_ROLE_IMPLEMENTATION_DBA_PACKAGE.md`.
