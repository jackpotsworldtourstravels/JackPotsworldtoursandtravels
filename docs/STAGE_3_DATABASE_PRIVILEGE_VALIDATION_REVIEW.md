# Stage 3 — Database Privilege Validation Review (least‑privilege accuracy)

**Purpose.** Validate the privilege grants proposed in `docs/STAGE_3_DATABASE_ROLE_SEPARATION_IMPLEMENTATION_PLAN.md` against what the application *actually* does, and correct any over‑ or under‑grant — with special focus on the partner stored routines and EXECUTE privileges.

**Status.** Read‑only inspection and documentation. No PostgreSQL connection, no SQL executed, no roles created, no source/Docker/config/migration edits, no deploy/commit/push. No secrets. No role names invented (placeholders where unknown). Gaming Tour Packages left disabled; Stage 4 not started.

**Labels.** **[VERIFIED]** observed in repo source · **[PROPOSED]** recommended grant/change · **[UNRESOLVED]** needs confirmation (e.g. exact catalog signature on the live DB).

**Placeholder:** `:runtime_role` = the restricted application login (non‑owner, `NOSUPERUSER`, `NOINHERIT`). `:migration_role` = the owner/DDL login. Real names are environment config, **not in the repo**.

---

## Headline correction
The implementation plan's `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :runtime_role` is **not least‑privilege and should not be used.** It would grant EXECUTE on routines the app never calls — including **`sp_register_partner`** (writes an admin password hash) and every **trigger function** (`fn_*`), which never need an EXECUTE grant. **[VERIFIED]** Replace it with `REVOKE EXECUTE … FROM PUBLIC` + **routine‑level GRANTs on exactly the functions the app invokes** (§3–§6).

---

## 1. Existing B2B & B2C table operations **[VERIFIED]**
- The app performs ORM `SELECT/INSERT/UPDATE/DELETE` across B2B (`app/models_v2.py`, legacy `app.models`) and B2C (`app/models_customer.py`) tables; `autocommit=False` with explicit commits. No runtime DDL/`TRUNCATE` exists in `app/`.
- ⇒ Runtime needs table DML on the application tables, which the plan's **schema‑wide** `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` covers, **plus** the audit‑table exception (§8). This part of the plan is correct. **[VERIFIED need] / [PROPOSED grant]**

## 2. Sequence privileges for INSERT **[VERIFIED need] / [PROPOSED]**
- PKs are serial/`BIGSERIAL`‑style (e.g. `0095` `BigInteger … autoincrement`), so `INSERT`s advance owned sequences. Stored functions that insert (e.g. `sp_add_passenger`, `sp_create_*`) are **SECURITY INVOKER** (§4), so they too consume sequences **as `:runtime_role`**.
- ⇒ `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :runtime_role` is required and correct. Missing it breaks `INSERT` in both domains.

## 3. The four stored routines in `admin_partner_service.py` **[VERIFIED]**
All four exist as **FUNCTIONs** (not PROCEDUREs), created by the Alembic chain (`0015_partner_portal.py` / `0017_partner_portal_back_office.py`; mirrored in `database/10_procedures.sql`). Called via `SELECT …`. Signatures (from `database/10_procedures.sql`; confirm identical in the creating migration — **[UNRESOLVED]** overload signatures):
| Routine | Kind | Signature |
|---|---|---|
| `sp_admin_list_partner_bookings` | FUNCTION | `(booking_status_enum, character varying)` |
| `sp_approve_request` | FUNCTION | `(integer, integer, numeric)` |
| `sp_reject_request` | FUNCTION | `(integer, integer, text)` |
| `sp_resolve_service_request` | FUNCTION | `(integer, service_request_status_enum, integer)` |

## 4. FUNCTION vs PROCEDURE, and SECURITY mode **[VERIFIED]**
- **Every** `sp_*` routine the app uses is `CREATE OR REPLACE FUNCTION` — there are **no** PostgreSQL `PROCEDURE`s. (So `GRANT EXECUTE ON FUNCTION …`, invoked by `SELECT`, is the correct grant; `CALL`/`GRANT … ON PROCEDURE` does not apply.)
- **No `SECURITY DEFINER` appears anywhere** in `database/` or `backend/alembic/`. ⇒ all routines are the default **`SECURITY INVOKER`**: they run with `:runtime_role`'s own privileges. Consequences: (a) no privilege escalation via these functions — they cannot read/write anything `:runtime_role` could not already; (b) the runtime role must itself hold the table/sequence DML the function bodies perform (covered by §1–§2); (c) **nested** function calls require EXECUTE on the inner function too (§5).

## 5. Is `GRANT EXECUTE ON ALL FUNCTIONS` sufficient/appropriate? **No. [VERIFIED]**
- **Over‑grant (security):** it would make `sp_register_partner` (writes `p_admin_password_hash`), and any future sensitive routine, executable by the runtime account — unnecessary and risk‑increasing.
- **Redundant for triggers:** trigger functions (`fn_audit_*`, `fn_notify_*`, `fn_set_updated_at`, `fn_track_*`, `fn_auto_generate_*`, `fn_write_audit_log`, `fn_block_customer_admin_audit_mutation`) are fired by triggers; PostgreSQL does **not** check EXECUTE on a trigger function. Granting EXECUTE on them confers nothing useful.
- **Partly moot by default:** PostgreSQL grants `EXECUTE` on new functions to `PUBLIC` by default, so under the status quo everything "works" — least privilege requires the opposite move (revoke from PUBLIC, then grant the specific set).
- **Correct approach:** `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`, then `GRANT EXECUTE` on exactly the routines in §7.

## 6. Does granting EXECUTE on every routine create unnecessary privilege? **Yes. [VERIFIED]**
Routines **present but not invoked by the app** (directly or via nesting) — **do not grant**:
- **`sp_register_partner`** — partner onboarding; writes an admin password hash. **Security‑sensitive: must NOT be executable by `:runtime_role`.** (Confirmed not called in `backend/app`.)
- `sp_log_partner_activity`, `sp_complete_booking` — not found as app calls nor as nested calls. Exclude. **[UNRESOLVED]** confirm no indirect use before relying on exclusion in production.
- All trigger `fn_*` functions — excluded (see §5).

## 7. Exact permissions the runtime account needs **[PROPOSED — least privilege]**
**Tables:** `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :runtime_role;` then the audit exception (§8).
**Sequences:** `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :runtime_role;`
**Schema:** `GRANT USAGE ON SCHEMA public TO :runtime_role;`
**Functions:** `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;` then `GRANT EXECUTE` on **only** the functions below.

**Functions the app invokes — EXECUTE required** (directly called, verified by `grep` of `backend/app`):
`sp_admin_list_partner_bookings`, `sp_approve_request`, `sp_reject_request`, `sp_resolve_service_request` (admin_partner); `sp_partner_login_lookup`, `sp_verify_otp`, `sp_request_otp`, `sp_update_partner_profile`, `sp_partner_record_login` (partner_auth); `sp_get_dashboard_statistics`, `sp_get_request_history`, `sp_get_ticket_enquiry`, `sp_create_ticket_request`, `sp_add_passenger`, `sp_set_passenger_special_services`, `sp_submit_request_for_approval` (partner_booking); `sp_generate_report` (partner_reports); `sp_cancel_selected_passengers`, `sp_create_date_change_request`, `sp_create_refund_request`, `sp_create_passenger_modification_request` (partner_service_request); `sp_generate_booking_reference` (merchant).

**Nested‑call addition — also required** (invoked *inside* the above, SECURITY INVOKER): **`sp_generate_service_request_number`** (called by `sp_cancel_selected_passengers`, `sp_create_date_change_request`, `sp_create_passenger_modification_request`, `sp_create_refund_request`); `sp_generate_booking_reference` is nested in `sp_create_ticket_request` and is already in the direct list. **[VERIFIED nested]**

Illustrative grants (one per function, signature‑qualified; confirm signatures against the creating migration — **[UNRESOLVED]**). `[APPROVAL REQUIRED]`:
```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;                                   -- [APPROVAL REQUIRED]
GRANT EXECUTE ON FUNCTION public.sp_admin_list_partner_bookings(booking_status_enum, varchar) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_approve_request(integer, integer, numeric)                 TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_reject_request(integer, integer, text)                     TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_resolve_service_request(integer, service_request_status_enum, integer) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_partner_login_lookup(varchar)                              TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_verify_otp(integer, otp_purpose_enum, varchar)             TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_request_otp(integer, varchar, otp_purpose_enum, integer)   TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_update_partner_profile(integer, varchar, varchar)          TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_partner_record_login(integer, varchar)                     TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_get_dashboard_statistics(integer)                          TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_get_request_history(integer, booking_status_enum, date, date) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_get_ticket_enquiry(varchar, varchar, date, varchar)        TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_create_ticket_request(integer, integer, travel_type_enum, integer, integer, integer, varchar, varchar, trip_type_enum, varchar, varchar, date, date, cabin_class_enum) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_add_passenger(/* confirm full signature */)               TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_set_passenger_special_services(integer, integer[])         TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_submit_request_for_approval(integer)                       TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_generate_report(/* confirm full signature */)              TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_cancel_selected_passengers(varchar, integer[], text, integer) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_create_date_change_request(varchar, integer, date, text, integer) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_create_refund_request(varchar, numeric, text, integer)     TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_create_passenger_modification_request(varchar, integer, varchar, varchar, varchar, text, integer) TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_generate_booking_reference(integer)                        TO :runtime_role;
GRANT EXECUTE ON FUNCTION public.sp_generate_service_request_number()                          TO :runtime_role;  -- nested
-- NOT granted (verified unused): sp_register_partner(...), sp_log_partner_activity(...), sp_complete_booking(integer),
--                                and all trigger fn_* functions.
```

## 8. Audit‑table INSERT/SELECT‑only enforcement **[VERIFIED intent] / [PROPOSED grant]**
- Runtime writes audit rows with `INSERT` and reads with `SELECT` only; no `UPDATE`/`DELETE` of audit rows anywhere in the app. ⇒ after the schema‑wide table grant, **revoke** the rest on the audit table:
  `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.customer_admin_audit_logs FROM :runtime_role;` and `REVOKE ALL … FROM PUBLIC;` (per `docs/STAGE_3_DATABASE_AUDIT_PRIVILEGES_SQL_REVIEW.md`).
- The append‑only trigger `trg_block_customer_admin_audit_mutation` enforces immutability even against the owner/superuser; `INSERT` is unaffected. The REVOKEs only *bite* because `:runtime_role` is a non‑owner (§ below).

## 9. PUBLIC privileges and inherited role membership **[VERIFIED risk] / [PROPOSED]**
- **PUBLIC:** by default PUBLIC holds `EXECUTE` on functions (and may hold table privileges in some clusters). Least privilege requires `REVOKE EXECUTE ON ALL FUNCTIONS … FROM PUBLIC` and `REVOKE ALL ON … FROM PUBLIC` on the audit table; verify no residual PUBLIC grants remain.
- **Inheritance:** `:runtime_role` must be `NOSUPERUSER`, **not** a member of `:migration_role`/owner, and ideally `NOINHERIT`. If it is a superuser or inherits from a privileged role, every grant/revoke above is bypassed. Verify role attributes and memberships (§12 of the role‑separation plan; `pg_roles`, `pg_auth_members`).

## 10. Default privileges for future tables, sequences and routines **[PROPOSED] / [DBA ACTION]**
Set `ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public` so future migration‑created objects are covered — but **correct the functions line** vs the implementation plan:
```sql
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES  TO :runtime_role;  -- [APPROVAL REQUIRED]
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :runtime_role;                 -- [APPROVAL REQUIRED]
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;                            -- [APPROVAL REQUIRED]
-- Do NOT add a blanket default GRANT EXECUTE ON FUNCTIONS TO :runtime_role — grant EXECUTE per new routine as it is added (keeps §5/§6 least privilege intact).
```
Standing rules: (a) a future **append‑only** table must re‑`REVOKE UPDATE, DELETE, TRUNCATE` explicitly (the table default grants full DML); (b) a new runtime‑invoked `sp_*` must get an explicit routine‑level `GRANT EXECUTE` in the same migration/rollout.

---

## Security‑sensitive functions — must NOT be executable by `:runtime_role`
- **`sp_register_partner(…, p_admin_password_hash …)`** — creates a partner + admin login; not called by the app. **Exclude.** **[VERIFIED not called]**
- Credential/OTP functions that **are** needed at runtime and so **must** be granted, but are safe because they are SECURITY INVOKER (no escalation): `sp_partner_login_lookup` (returns `password_hash`), `sp_request_otp`, `sp_verify_otp`, `sp_partner_record_login`. Grant these; rely on the application's own auth logic and `:runtime_role` already having SELECT on the underlying tables.
- All trigger `fn_*` functions — no EXECUTE grant (trigger‑invoked).

## Unresolved questions **[UNRESOLVED]**
1. **Exact catalog signatures.** The GRANTs must match the deployed functions' argument types exactly (overloads). Signatures above are from `database/10_procedures.sql`; confirm they match the Alembic‑created definitions (`0015`, `0017`, `0019`, `0020`) on the target DB (`\df public.sp_*`). Two signatures are marked `/* confirm */`.
2. **`fn_write_audit_log` references in `backend/app`** (`audit_service.py`, `super_admin.py`, `models_v2.py`) — treated as trigger DDL / schema references, not direct calls (it is a trigger function: `FOR EACH ROW EXECUTE FUNCTION fn_write_audit_log('pk')`). Confirm no code path invokes it as a plain function; if confirmed (expected), **no** EXECUTE grant is needed.
3. **`sp_log_partner_activity` / `sp_complete_booking`** — not observed as direct or nested calls; confirm truly unused before excluding in production (a missed call surfaces as a runtime `42501`).
4. **Deeper nesting.** Verified one level of nested calls (`sp_generate_service_request_number`, `sp_generate_booking_reference`). Confirm those leaf functions do not themselves call further routines needing EXECUTE.

---

*Prepared read‑only. VERIFIED = observed in repository source; PROPOSED = recommended, not applied; UNRESOLVED = confirm against the live catalog. No DB connection, no SQL executed, no roles created, no source/Docker/config/migration edits, no deploy/commit/push, no secrets. No role names invented. Gaming Tour Packages disabled; Stage 4 not started. Not a production‑readiness claim.*
