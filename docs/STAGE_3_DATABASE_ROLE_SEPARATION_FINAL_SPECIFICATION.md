# Stage 3 — Database Role Separation: Final Consolidated Specification

**Supersedes** `docs/STAGE_3_DATABASE_ROLE_SEPARATION_IMPLEMENTATION_PLAN.md` and `docs/STAGE_3_DATABASE_PRIVILEGE_VALIDATION_REVIEW.md` by reconciling them into one corrected spec. Where they differ, **this document is authoritative** (notably the EXECUTE model — see §3).

**Not implemented.** This is a specification only. **Role separation has NOT been implemented.** No PostgreSQL connection was made, no SQL executed, no roles created, no source/Docker/config/migration changes made, no deploy/commit/push. No secrets. No role names or signatures invented.

**Labels:** **[VERIFIED]** observed in repository source · **[PROPOSED]** recommended change, not applied · **[DBA VERIFICATION REQUIRED]** confirm against the live catalog before relying on it · **[APPROVAL REQUIRED]** explicit owner approval before executing. Gaming Tour Packages remains **disabled**; Stage 4 not started. All existing B2B and B2C database operations must be preserved (§6).

**Placeholders (environment config — not in repo; do not invent):**
```
:migration_role   -- owner/DDL login that runs Alembic (CREATE + ownership)
:runtime_role     -- restricted app login: LOGIN, NOSUPERUSER, NOINHERIT, DML-only
:db               -- target database (staging ${POSTGRES_DB}; production from backend/.env)
```

---

## 1. Current state **[VERIFIED]**
- One `DATABASE_URL` feeds both Alembic (`backend/alembic/env.py` → `settings.database_url`) and the runtime engine (`backend/app/database/session.py`). `backend/app/config.py` defines `database_url` (env `DATABASE_URL`).
- `deploy/docker-entrypoint.sh` runs `alembic upgrade head` then `gunicorn` on **every** container start (the `Dockerfile` `CMD`) — migration and runtime share one account.
- Staging binds that account to `POSTGRES_USER` (owner/superuser of `${POSTGRES_DB}`, per `deploy/staging/docker-compose.staging.yml`); production's role is in `backend/.env` (not in repo → placeholder).
- No `CREATE ROLE`/`GRANT`/`REVOKE` exists anywhere in `deploy/`, `database/`, or `backend/alembic/`. No dedicated least‑privilege role exists today.

## 2. Application database operations **[VERIFIED]**
- ORM `SELECT/INSERT/UPDATE/DELETE` across B2B (`app/models_v2.py`, legacy `app.models`) and B2C (`app/models_customer.py`); `autocommit=False`, explicit commits.
- Raw stored‑**function** calls via `text("SELECT …")` (partner/merchant modules — §3).
- Audit writes (`customer_admin_audit_service`) are `INSERT` only; reads are `SELECT`. No audit `UPDATE`/`DELETE`.
- **No runtime DDL or `TRUNCATE`** anywhere in `app/`.
- PKs are serial/`BIGSERIAL` (incl. `0095`), so `INSERT`s consume owned sequences.

## 3. Runtime privilege model (CORRECTED) **[PROPOSED]**
The implementation plan's `GRANT EXECUTE ON ALL FUNCTIONS` is **withdrawn** — it over‑grants (exposes `sp_register_partner`, which writes an admin password hash, and all trigger `fn_*`). Correct model:

**3.1 Tables / schema / sequences** `[APPROVAL REQUIRED]`
```sql
GRANT USAGE ON SCHEMA public TO :runtime_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO :runtime_role;
GRANT USAGE, SELECT                  ON ALL SEQUENCES  IN SCHEMA public TO :runtime_role;
```
(Schema‑wide table DML is deliberate — it preserves every current and future B2B/B2C table operation without hand‑listing dozens of tables. The audit‑table exception in §7 is applied *after* this.)

**3.2 Functions — revoke PUBLIC, then grant only what the app invokes** `[APPROVAL REQUIRED]`
```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
-- then GRANT EXECUTE on exactly the routines in §4 (and nothing else).
```
Rationale **[VERIFIED]**: every `sp_*` is a `FUNCTION` (no PROCEDUREs) and `SECURITY INVOKER` (no `SECURITY DEFINER` anywhere), so (a) it runs with `:runtime_role`'s own table/sequence privileges (covered by 3.1), and (b) nested function calls need EXECUTE on the inner function too (§5). Trigger `fn_*` functions need **no** EXECUTE grant (PostgreSQL does not check EXECUTE for trigger‑fired functions).

## 4. Verified runtime function grants (signature‑qualified) **[VERIFIED in `database/10_procedures.sql`] / [DBA VERIFICATION REQUIRED: confirm identical in the deployed catalog]**
All are invoked by `backend/app` (grep‑verified). Signatures are the argument‑type lists from `database/10_procedures.sql`; the functions are created by the Alembic chain (`0015_partner_portal.py`, `0017_partner_portal_back_office.py`, `0019_partner_otp_rate_limit.py`, `0020_partner_ancillary_services.py`) — confirm the deployed signatures match (`\df public.sp_*`). `[APPROVAL REQUIRED]` to grant.

```sql
GRANT EXECUTE ON FUNCTION public.sp_admin_list_partner_bookings(booking_status_enum, varchar)                 TO :runtime_role; -- admin_partner_service
GRANT EXECUTE ON FUNCTION public.sp_approve_request(integer, integer, numeric)                                TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_reject_request(integer, integer, text)                                    TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_resolve_service_request(integer, service_request_status_enum, integer)    TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_partner_login_lookup(varchar)                                             TO :runtime_role; -- partner_auth_service
GRANT EXECUTE ON FUNCTION public.sp_verify_otp(integer, otp_purpose_enum, varchar)                            TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_request_otp(integer, varchar, otp_purpose_enum, integer)                  TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_update_partner_profile(integer, varchar, varchar)                         TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_partner_record_login(integer, varchar)                                    TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_get_dashboard_statistics(integer)                                         TO :runtime_role; -- partner_booking_service
GRANT EXECUTE ON FUNCTION public.sp_get_request_history(integer, booking_status_enum, date, date)             TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_get_ticket_enquiry(varchar, varchar, date, varchar)                       TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_create_ticket_request(integer, integer, travel_type_enum, integer, integer, integer, varchar, varchar, trip_type_enum, varchar, varchar, date, date, cabin_class_enum) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_add_passenger(integer, varchar, gender_enum, passenger_type_enum, integer, varchar, date, date, date, integer, varchar, text, integer, integer, seat_preference_enum) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_set_passenger_special_services(integer, integer[])                        TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_submit_request_for_approval(integer)                                      TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_generate_report(integer, integer, date, date, date, date, varchar, varchar, varchar, varchar, export_format_enum) TO :runtime_role; -- partner_reports_service
GRANT EXECUTE ON FUNCTION public.sp_cancel_selected_passengers(varchar, integer[], text, integer)             TO :runtime_role; -- partner_service_request_service
GRANT EXECUTE ON FUNCTION public.sp_create_date_change_request(varchar, integer, date, text, integer)         TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_create_refund_request(varchar, numeric, text, integer)                    TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_create_passenger_modification_request(varchar, integer, varchar, varchar, varchar, text, integer) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_generate_booking_reference(integer)                                       TO :runtime_role; -- merchant_service (and nested in sp_create_ticket_request)
GRANT EXECUTE ON FUNCTION public.sp_generate_service_request_number()                                         TO :runtime_role; -- NESTED ONLY (§5)
```
**Explicitly NOT granted** (verified unused by the app; least privilege): `sp_register_partner(...)` — **security‑sensitive (writes an admin password hash); must not be executable by `:runtime_role`** — `sp_log_partner_activity(...)`, `sp_complete_booking(integer)`, and every trigger `fn_*` (incl. `fn_write_audit_log`, `fn_block_customer_admin_audit_mutation`).

## 5. Nested‑call tracing **[VERIFIED] / [DBA VERIFICATION REQUIRED]**
Because the functions are SECURITY INVOKER, EXECUTE is needed on anything they call internally. Verified in `database/10_procedures.sql`:
- `sp_cancel_selected_passengers`, `sp_create_date_change_request`, `sp_create_passenger_modification_request`, `sp_create_refund_request` → call **`sp_generate_service_request_number()`** (added to §4, nested‑only).
- `sp_create_ticket_request` → calls `sp_generate_booking_reference(integer)` (already in §4).
**Remaining unresolved dependency:** confirm the two leaf generators (`sp_generate_service_request_number`, `sp_generate_booking_reference`) do not themselves invoke further routines requiring EXECUTE. **[DBA VERIFICATION REQUIRED]** (`\sf`/body review on the deployed catalog).

## 6. Preserving existing B2B & B2C operations **[VERIFIED requirement]**
- Schema‑wide table DML (3.1) + sequence grants ⇒ all ORM CRUD in both domains continues. Missing either → `42501` at runtime.
- Routine‑level EXECUTE (4) covers the partner/merchant stored‑function flows; omitting any (or the nested generator) breaks that B2B flow — the §10 checklist verifies each.
- B2C audit INSERT path unaffected (INSERT remains after the §7 REVOKE); M0 readiness gate behaviour unchanged.
- No table/mapping/structure change; transactions and commit semantics are identity‑only changes. Gaming remains disabled.

## 7. Audit‑table INSERT/SELECT‑only **[PROPOSED] / [APPROVAL REQUIRED]**
After 3.1's schema‑wide grant, restrict `customer_admin_audit_logs`:
```sql
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.customer_admin_audit_logs FROM :runtime_role;
REVOKE ALL                      ON TABLE public.customer_admin_audit_logs FROM PUBLIC;
-- INSERT, SELECT remain. (Per docs/STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md.)
```
The append‑only trigger `trg_block_customer_admin_audit_mutation` (fires `BEFORE UPDATE OR DELETE` for every role, owner/superuser included) is the owner‑proof guard; it does not block `INSERT`. The REVOKEs only *bite* for a non‑owner `:runtime_role` (§8).

## 8. Ownership & runtime restrictions **[PROPOSED] / [DBA VERIFICATION REQUIRED]**
- All migration‑created objects (tables, the `customer_admin_audit_outcome_enum` type, indexes, partial‑unique index, the audit trigger + `fn_block_customer_admin_audit_mutation`, and the partner `sp_*`) are owned by **`:migration_role`**.
- `:runtime_role` is **never** an owner, is **`NOSUPERUSER`**, **`NOINHERIT`**, and **not a member of** `:migration_role`. This is what makes §7's REVOKEs effective; a superuser or owner login bypasses all object ACLs (the trigger would then be the only control).

## 9. PUBLIC privileges & role‑membership risks **[VERIFIED risk] / [PROPOSED]**
- **PUBLIC** holds `EXECUTE` on functions by default and may hold table privileges in some clusters. Revoke: §3.2 (`EXECUTE … FROM PUBLIC`) and §7 (`ALL … FROM PUBLIC` on the audit table); verify no residual PUBLIC grants (§10).
- **Inheritance:** if `:runtime_role` is a superuser or inherits a privileged/owner role, every grant/revoke here is void. Verify role attributes and memberships (§10).

## 10. DBA verification checklist (read‑only; run on the target cluster) **[DBA VERIFICATION REQUIRED]**
1. **Routine type & signature:** `\df public.sp_*` — confirm each §4 routine is a **FUNCTION** with the exact argument types shown; capture overloads. Confirm **no** `SECURITY DEFINER` (`SELECT proname, prosecdef FROM pg_proc WHERE proname LIKE 'sp\_%';` → `prosecdef = f`).
2. **Routine existence in the deployed (Alembic‑built) DB** for every §4 function.
3. **Nested calls:** review bodies of the four `sp_create_*`/`sp_cancel_*`, plus the two leaf generators, for any further routine calls (§5).
4. **Effective table privileges:** `information_schema.role_table_grants` for `:runtime_role` — DML on app tables; **INSERT, SELECT only** on `customer_admin_audit_logs`; `has_table_privilege(...)` booleans for UPDATE/DELETE/TRUNCATE = false.
5. **Sequence privileges:** `has_sequence_privilege(:runtime_role, <seq>, 'USAGE')` = true for serial‑PK sequences.
6. **Function privileges:** `has_function_privilege(:runtime_role, '<sig>', 'EXECUTE')` = true for each §4 routine; **false** for `sp_register_partner`, `sp_log_partner_activity`, `sp_complete_booking`, and `fn_*` triggers; and **false for PUBLIC** on functions generally.
7. **Ownership:** `pg_class.relowner` / `pg_proc.proowner` = `:migration_role` for the §8 objects.
8. **Role attributes/membership:** `pg_roles` (`rolsuper=f`, `rolinherit`, `rolcanlogin=t`) and `pg_auth_members` (not a member of `:migration_role`).
9. **Audit immutability:** in a transaction you `ROLLBACK`, attempt `DELETE`/`UPDATE` on a known audit row → expect `ERROR: customer_admin_audit_logs is append-only`.
10. **Default privileges:** `pg_default_acl` reflects §11's settings (no blanket EXECUTE to PUBLIC or runtime).

## 11. Changes eventually required **[PROPOSED] — none applied here**
- **Database (DBA):** create `:migration_role` + `:runtime_role` per environment `[APPROVAL REQUIRED]`; set ownership (§8); apply §3/§4/§7 grants; set default privileges (below).
- **Config/code (FastAPI/Alembic):** add `alembic_database_url` setting (env **`MIGRATION_DATABASE_URL`**) in `backend/app/config.py`; in `backend/alembic/env.py` use it when present else fall back to `settings.database_url`. `backend/app/database/session.py` unchanged (runtime uses `DATABASE_URL`). `[APPROVAL REQUIRED]`
- **Docker:** make `deploy/docker-entrypoint.sh` serve‑only (remove `alembic upgrade head`); migrations move to a separate approved step/service. Single‑service hosts get a migrate‑then‑exit init. `[APPROVAL REQUIRED]`
- **Environment:** add `MIGRATION_DATABASE_URL` (migration creds) alongside the least‑privilege `DATABASE_URL` (runtime creds), per environment; never share across environments; never in git.
- **Deployment:** introduce the release/migration phase ahead of app start; update `redeploy.sh`/runbook; keep migrations `[APPROVAL REQUIRED]`.
- **Default privileges (future objects):** `[APPROVAL REQUIRED]`
  ```sql
  ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO :runtime_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO :runtime_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  -- Do NOT blanket-grant EXECUTE to :runtime_role; grant EXECUTE per new runtime-invoked routine.
  ```
  Standing rules: a future append‑only table must re‑revoke UPDATE/DELETE/TRUNCATE; a new runtime‑invoked `sp_*` gets an explicit routine‑level GRANT in its own rollout.

## 12. Implementation order & regression testing **[PROPOSED] / [APPROVAL REQUIRED]**
**Order:** (1) DBA runs §10 verification on current catalog to lock signatures. (2) Create roles (§8). (3) Apply §3/§4/§7 grants + default privileges as `:migration_role`/owner `[APPROVAL REQUIRED]`. (4) Land the config/env.py change (§11). (5) Point Alembic at `MIGRATION_DATABASE_URL`, app at the runtime `DATABASE_URL`. (6) Make the entrypoint serve‑only + separate migrate step. (7) Deploy to **staging first**; run the regression below; then mirror to production with its own roles. Each migration/deploy step `[APPROVAL REQUIRED]`.

**Regression strategy (staging):**
- **Backend suite** green (same baseline: the two pre‑existing unrelated failing files only).
- **B2B smoke:** partner login (`sp_partner_login_lookup`/OTP), dashboard, booking create → add passenger → submit → admin approve/reject, service‑request create/cancel/date‑change/refund, report generate, merchant booking‑reference — each exercises a §4 grant; a missing grant surfaces as `42501`.
- **B2C smoke:** customer list/detail, M1 block/unblock/password‑reset, M2 communication, and an audit write — confirm audit `INSERT` works and `UPDATE`/`DELETE` are refused.
- **Negative checks:** `:runtime_role` cannot `UPDATE/DELETE` audit rows, cannot `EXECUTE sp_register_partner`, and cannot run DDL.
- **Boot:** app starts serve‑only against an already‑migrated schema; health/readiness green; Gaming confirmed disabled.
- **Rollback rehearsal:** repoint `DATABASE_URL` to the single role + restore entrypoint/env from git returns to the current behaviour with no data impact (distinct from the destructive `0095.downgrade()`, separately `[APPROVAL REQUIRED]`).

---

*Consolidated from the two prior documents. VERIFIED items are observed in repository source; PROPOSED/DBA‑VERIFICATION/APPROVAL items are not implemented. **Role separation has not been implemented.** No DB connection, no SQL, no roles, no source/Docker/config/migration edits, no deploy/commit/push, no secrets; no role names or signatures invented (signatures are quoted from `database/10_procedures.sql` and still require catalog confirmation). Gaming Tour Packages disabled; Stage 4 not started.*
