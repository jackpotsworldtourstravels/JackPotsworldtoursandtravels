# Live PostgreSQL Schema-Provenance Verification Package

**Project:** JackPots World Tours & Travels
**Date:** 2026-11-13
**Reference docs:** `FINAL_DATABASE_SCHEMA_SOURCE_RECONCILIATION.md`, `CLASS_C_LIVE_DATABASE_VERIFICATION_PLAN.md`, `LEGACY_DATABASE_TABLE_USAGE_AND_PRESERVATION_REPORT.md`, `POSTGRESQL_DBA_HANDOVER_AND_EXECUTION_RUNBOOK.md`

---

## 0. Scope boundary — read this first

**No live-database finding in this document is marked VERIFIED IN LIVE DATABASE, because this session cannot connect to any PostgreSQL environment.** I have no database connection, I will not read or expose connection strings, and I will not connect to production/staging to run queries — even read-only queries against live infrastructure are elevated access the task itself says to **stop and request separate approval** for. I have fabricated **no** live results.

What this document *is*: a **DBA-runnable verification package**. For each of the 9 objectives it gives (a) the exact **read-only** query, (b) the **evidence** it produces, (c) the **repository-verified baseline** to compare the live output against, and (d) the **classification** to assign once run. Until a credentialed DBA runs it against a backed-up environment, every live item stands at **REQUIRES DBA APPROVAL**.

**Classification legend:** `LIVE` = VERIFIED IN LIVE DATABASE · `REPO` = VERIFIED IN REPOSITORY · `ABSENT` = NOT PRESENT · `INCONCLUSIVE` · `APPROVAL` = REQUIRES DBA APPROVAL (run against the live DB). **A repository SQL file existing is never evidence it was executed in a database.**

## 1. Safety preconditions (the DBA confirms before running anything)

1. **Verified backup first** — take and *restore-test* a dump (or confirm a point-in-time snapshot) of each environment before any session. Record the backup id in the report.
2. Open a session as a **read-only / least-privilege** role; ideally `SET default_transaction_read_only = on; SET statement_timeout = '30s';` at the top.
3. **Do not** run either raw-SQL orchestrator (`backend/db/partner_portal/00_run_all.sql`, `database/migrate.sql`), **no** `alembic upgrade/downgrade`, **no** CREATE/ALTER/DROP, **no** CREATE OR REPLACE of any `sp_*`, **no** GRANT/REVOKE, **no** row changes, **no** service restart/deploy.
4. Every query below is `SELECT`-only against `pg_catalog` / `information_schema` or `count(*)`. If any check needs elevated privileges or would modify data → **stop and request approval**.

## 2. Configured environments (names only — REPO)

From repository config, **not** a live inventory (no secrets read):
- `render.yaml` → service **`jackpotsworld`**, with env keys `DATABASE_URL` and `DEPLOYED` (values not inspected). **[REPO]**
- `deploy/docker-compose.yml` + `deploy/redeploy.sh` → a self-hosted/Docker Postgres target using `DATABASE_URL` / `MIGRATION_DATABASE_URL`. **[REPO]**
- `backend/.env` (gitignored) → local development DB. **[REPO — existence of the config path only]**

**The actual hostnames, DB names and the number of live environments are `APPROVAL`** — confirm with the owner/DBA which environments exist and run the pack in each.

---

## 3. Verification objectives — query pack

> Run per environment. Paste each query's raw output into the per-environment report and assign the classification.

### Item 1 — DB name, environment, current Alembic revision
```sql
SELECT current_database(), current_user, version();
SELECT version_num FROM alembic_version;          -- expected single row
```
- **Evidence:** the database name; the `alembic_version.version_num` string.
- **Baseline [REPO]:** repository Alembic **head = `0095_customer_admin_audit_logs`** (down_revision `0094_customer_refund_attempts`; no later file references `0095`). Environment identity is read from app config `DEPLOYED` — not derivable here.
- **Classify:** `version_num = 0095…` → `LIVE` (DB is at repo head). Older → `LIVE` but **behind head** (note the gap; do **not** upgrade). No `alembic_version` table → `INCONCLUSIVE` (DB not Alembic-managed, or different regime). Until run: **`APPROVAL`**.

### Item 2 — Existing schemas and tables
```sql
SELECT nspname FROM pg_namespace
 WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1;
SELECT table_schema, table_name FROM information_schema.tables
 WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')
 ORDER BY 1,2;
```
- **Evidence:** full schema + table list.
- **Classify each table** against §3 Items 3–8 below. Until run: **`APPROVAL`**.

### Item 3 — Which table families exist (`customer_*`, B2B `models_v2`, partner-portal, `user_*`)
```sql
SELECT
  count(*) FILTER (WHERE tablename LIKE 'customer_%')              AS customer_tables,
  count(*) FILTER (WHERE tablename LIKE 'partner_%')               AS partner_tables,
  count(*) FILTER (WHERE tablename LIKE 'user_%')                  AS user_tables,
  count(*) FILTER (WHERE tablename IN
    ('merchants','providers','provider_users','service_requests')) AS b2b_core_sample
FROM pg_tables WHERE schemaname='public';
-- then list them:
SELECT tablename FROM pg_tables WHERE schemaname='public'
  AND (tablename LIKE 'customer_%' OR tablename LIKE 'partner_%'
       OR tablename LIKE 'user_%'  OR tablename LIKE 'admin_%') ORDER BY 1;
```
- **Baseline [REPO]:** the live app expects **`customer_*`** (≈48 B2C tables, Alembic) and **`models_v2`** B2B tables to exist; the **partner-portal** tables are expected to exist (the app calls their `sp_*` at runtime). The **`user_*`** / `admins` / geo family exists **only** in `database/*.sql` and is **not** referenced by any live code.
- **Classify:**
  - `customer_*` present → `LIVE` (live B2C). Absent → `INCONCLUSIVE`/escalate (would contradict the running app).
  - `partner_*` present → `LIVE`; this is the strongest live signal that a partner raw-SQL source was applied (Item 9).
  - **`user_*` present → `LIVE` but flag as divergent/likely-orphaned** (evidence `database/*.sql` was applied here). **`user_*` absent → `ABSENT`** — strong evidence `database/*.sql` was **not** applied as the runtime schema. Until run: **`APPROVAL`**.

### Item 4 — Actual definitions of collision tables (`users`, `payments`, `service_requests`, `countries`, `permissions`)
```sql
SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('users','payments','service_requests','countries','permissions')
ORDER BY table_name, ordinal_position;
```
- **Evidence:** the live column shape of each collision table.
- **Baseline [REPO]:** each of these is defined in **more than one** source with potentially different columns (`service_requests` in `models_v2`, `partner_portal/05`, and `database/*.sql`; `users`/`payments` in Alembic `0001`→`models_v2` **and** `database/05`; `countries`/`permissions` in `partner_portal/02` **and** `database`). Compare the live columns to each source file to decide which was applied.
- **Classify:** column set matches `models_v2` / Alembic → that source is `LIVE` for that table; matches a partner/`database` file → that source is `LIVE`. No exact match → `INCONCLUSIVE` (hand-modified or merged). Until run: **`APPROVAL`**.

### Item 5 — Installed stored procedures (compare both sources)
```sql
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       l.lanname, p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
JOIN pg_language  l ON l.oid=p.prolang
WHERE n.nspname='public' AND p.proname LIKE 'sp_%'
ORDER BY p.proname, args;
-- full body of any one proc to diff against the repo file:
-- SELECT pg_get_functiondef('public.sp_request_otp'::regproc);   -- adjust if overloaded
```
- **Evidence:** every installed `sp_*` with its **exact argument signature** and `SECURITY INVOKER/DEFINER`.
- **Baseline [REPO]:** two divergent source sets (see Appendix A):
  - **`database/10_procedures.sql` — 26 `public.sp_*`**, auth/booking procs keyed on **`p_staff_id`**, `sp_request_otp(..., p_ttl_minutes DEFAULT 5)`.
  - **`backend/db/partner_portal/` — the base `10–13` set (19) PLUS `back_office/` and `gap_completion/` subfolders**, auth/booking procs keyed on **`p_partner_user_id`**, `sp_request_otp(..., DEFAULT 10)`, and **internal duplicate signatures** (`sp_request_otp`, `sp_add_passenger` each defined twice with different arg lists).
  - **All `sp_*` in both sources are `SECURITY INVOKER`** (no `SECURITY DEFINER`).
- **Classify:** live arg lists using `p_staff_id` → `database/10` is the applied source; `p_partner_user_id` → `partner_portal`. A `prosecdef=true` anywhere → `INCONCLUSIVE`/escalate (diverges from repo). Procs present but matching neither body → `INCONCLUSIVE`. Until run: **`APPROVAL`**.

### Item 6 — Foreign keys, views, triggers, indexes, constraints
```sql
-- FKs
SELECT conrelid::regclass AS table, conname,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace
ORDER BY 1,2;
-- views
SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY 1;
-- triggers
SELECT event_object_table, trigger_name, action_timing, event_manipulation
FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY 1,2;
-- indexes
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2;
-- check/unique/pk constraints
SELECT conrelid::regclass AS table, contype, conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('c','u','p')
ORDER BY 1,2;
```
- **Baseline [REPO]:** B2C FKs stay within `customer_*`; B2B FKs within `models_v2`; **no FK crosses B2B↔B2C**. Expected views `vw_partner_dashboard_stats`, `vw_reports_summary`, `vw_request_history`, `vw_service_requests`, `vw_ticket_enquiry`. Expected trigger `trg_block_customer_admin_audit_mutation` on `customer_admin_audit_logs` (from `0095`) **iff** Item 1 shows head ≥ 0095, plus partner `trg_*`.
- **Classify:** `trg_block_customer_admin_audit_mutation` present → `LIVE` (0095 applied). `vw_*` present → `LIVE` (a partner raw-SQL source applied). Until run: **`APPROVAL`**.

### Item 7 — Class C v1 tables: existence and historical rows
```sql
SELECT c.relname AS table,
       (SELECT count(*) FROM pg_class x WHERE x.relname=c.relname AND x.relkind='r') AS exists_flag
FROM (VALUES ('flights'),('hotels'),('cruises'),('tour_packages'),('bookings'),('reviews'),
             ('wishlist'),('notifications'),('support_tickets'),('coupons'),('seasonal_prices'),
             ('discount_campaigns'),('contact_us'),('newsletter'),('activity_logs'),
             ('user_sessions'),('roles')) AS c(relname);
-- for each that EXISTS, row count + newest record (read-only):
-- SELECT count(*) AS rows, max(created_at) AS newest FROM flights;   -- repeat per table
```
- **Baseline [REPO]:** Class C tables were created by Alembic `0001`/`0008`/`0009`/`0014` and are **not read by any live path**; **no live FK references them**. **Emptiness is unknown from the repo** — a production DB that ran `0001` onward *has* these tables and they may hold historical rows.
- **Classify:** exists + `rows>0` → `LIVE` with historical data → **archive before any future cleanup; do not drop**. Exists + `rows=0` → `LIVE` empty. Missing → `ABSENT`. **Never assume empty.** Until run: **`APPROVAL`**.

### Item 8 — Does `package_images` reference `tour_packages`?
```sql
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype='f' AND conrelid='public.package_images'::regclass;   -- errors if table absent
```
- **Baseline [REPO]:** defined **only** in `database/07_constraints.sql:28` — `fk_package_images_package FOREIGN KEY (package_id) REFERENCES tour_packages(id) ON DELETE CASCADE`. `package_images` is a **`database/*.sql`-only** table (not in Alembic or partner_portal).
- **Classify:** `package_images` exists with that FK → `LIVE` **and** proof `database/*.sql` was applied here (see Item 9). Table absent (regclass error) → `ABSENT` → evidence `database/*.sql` was **not** applied. Until run: **`APPROVAL`**.

### Item 9 — Which raw-SQL bootstrap sources appear to have been applied
Decision matrix, driven by the live results of Items 3/5/6/8:

| Live observation | Inference about applied source | Classify |
|---|---|---|
| `partner_*` tables + partner `sp_*` + `vw_*` present | A partner raw-SQL source **was** applied out-of-band | `LIVE` (source applied) |
| partner `sp_*` arg lists use `p_partner_user_id` | the **`partner_portal/*.sql`** tree is the applied partner source | `LIVE` |
| partner `sp_*` arg lists use `p_staff_id` | the **`database/10_procedures.sql`** tree is the applied partner source | `LIVE` |
| `user_*` / `admins` / `airlines` / `package_images` present | **`database/*.sql`** was applied (full monolith) | `LIVE` — flag divergence |
| `user_*` / `package_images` absent, but `customer_*` present | `database/*.sql` **not** applied as runtime schema; Alembic governs the app | `ABSENT` for `database/*.sql` |
| `alembic_version` present at 0095 | **Alembic** is the applied/automated path | `LIVE` |

- **Baseline [REPO]:** **nothing in `deploy/`, `Dockerfile`, or CI applies either raw-SQL orchestrator** — only Alembic runs automatically. So any partner tables/procs in a live DB were applied **manually**; which tree is a live question answered by the signatures above. Until run: **`APPROVAL`**.

---

## 4. Per-environment report template (DBA fills in)

Copy this block per environment; paste raw query output as evidence.

```
Environment: __________ (render 'jackpotsworld' / docker / local)
Backup verified: yes/no — backup id: __________   Session role: __________ (read-only? y/n)

Item 1  DB name / alembic head : <output>                          → LIVE | behind | INCONCLUSIVE
Item 2  schemas / table count  : <output>                          → LIVE
Item 3  customer_*/partner_*/user_* present : <counts+list>        → LIVE | ABSENT(user_*)
Item 4  collision table columns match which source : <per table>   → LIVE(source) | INCONCLUSIVE
Item 5  sp_* count + signatures + secdef : <output>                → LIVE(partner_portal|database) | INCONCLUSIVE
Item 6  FKs / views / triggers (0095 trigger?) : <output>          → LIVE
Item 7  Class C exists + row counts + newest : <per table>         → LIVE(has data) | LIVE(empty) | ABSENT
Item 8  package_images FK -> tour_packages : <output>              → LIVE | ABSENT
Item 9  applied-source inference : <from matrix>                   → LIVE | ABSENT per source
```

## Appendix A — `sp_*` source inventory (REPO, for diffing)

**`database/10_procedures.sql` — 26 `public.sp_*`:** `sp_add_passenger`, `sp_admin_list_partner_bookings`, `sp_approve_request`, `sp_cancel_selected_passengers`, `sp_complete_booking`, `sp_create_date_change_request`, `sp_create_passenger_modification_request`, `sp_create_refund_request`, `sp_create_ticket_request`, `sp_generate_booking_reference`, `sp_generate_report`, `sp_generate_service_request_number`, `sp_get_dashboard_statistics`, `sp_get_request_history`, `sp_get_ticket_enquiry`, `sp_log_partner_activity`, `sp_partner_login_lookup`, `sp_partner_record_login`, `sp_register_partner`, `sp_reject_request`, `sp_request_otp`, `sp_resolve_service_request`, `sp_set_passenger_special_services`, `sp_submit_request_for_approval`, `sp_update_partner_profile`, `sp_verify_otp`. Auth keyed on **`p_staff_id`**; `sp_request_otp(... p_ttl_minutes DEFAULT 5)`.

**`backend/db/partner_portal/` — base `10–13` (19) + `back_office/` + `gap_completion/`:** base set includes `sp_partner_login_lookup`, `sp_partner_record_login`, `sp_request_otp`, `sp_verify_otp`, `sp_generate_booking_reference`, `sp_generate_service_request_number`, `sp_create_ticket_request`, `sp_add_passenger`, `sp_submit_request_for_approval`, `sp_approve_request`, `sp_reject_request`, `sp_complete_booking`, `sp_cancel_selected_passengers`, `sp_create_date_change_request`, `sp_create_refund_request`, `sp_create_passenger_modification_request`, `sp_get_ticket_enquiry`, `sp_get_request_history`, `sp_generate_report`; subfolders add `sp_admin_list_partner_bookings`, `sp_resolve_service_request`, `sp_register_partner`, `sp_get_dashboard_statistics`, `sp_update_partner_profile`, `sp_audit_log_entry`, `sp_set_passenger_special_services`, and **re-define** `sp_request_otp` and `sp_add_passenger`. Auth keyed on **`p_partner_user_id`**; `sp_request_otp(... DEFAULT 10)`.

**Key divergences to resolve against the live DB:** (a) auth/record-login/OTP arg name `p_staff_id` (database) vs `p_partner_user_id` (partner_portal); (b) OTP TTL default 5 vs 10; (c) partner_portal defines some procs twice across subfolders. The live `pg_get_function_identity_arguments` output (Item 5) tells you which tree is installed.

---

**This package changed nothing** — repository inspection only; no DB connection, no SQL executed, no migrations, no schema/data/grant change, no deploy, no commit. All queries supplied are read-only and are to be run by a credentialed DBA against a **backed-up** environment. No repository SQL file is asserted to have been executed in any database; applied-source conclusions are reached **only** from live `pg_catalog` evidence once the pack is run. Gaming Tour Packages remain disabled.

**Document created:** `docs/LIVE_SCHEMA_PROVENANCE_VERIFICATION_PACKAGE.md`.
