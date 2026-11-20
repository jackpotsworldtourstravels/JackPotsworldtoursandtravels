# Final Database Schema-Source Reconciliation (repository-only)

**Project:** JackPots World Tours & Travels
**Date:** 2026-11-13
**Nature:** Repository inspection only. No PostgreSQL connection, no SQL executed, no Alembic/migrations, no code/SQL change, no table/data change, no deploy/commit. Gaming disabled.

**Labels:** **[REPO-VERIFIED]** read in source · **[INFERENCE]** reasoned from repo evidence (not a live fact) · **[LIVE-UNKNOWN]** needs live-DB inspection. **No SQL file is claimed to have been executed in production** — deployment of the raw-SQL schemas is [LIVE-UNKNOWN].

**Three schema-definition sources:**
1. `backend/alembic/versions/` — the application's migrations (automated path).
2. `backend/db/partner_portal/*.sql` — a partner-module raw-SQL bootstrap (`00_run_all.sql`; `01_types`→`13_stored_procedures_reporting`).
3. `database/*.sql` — a large full-schema raw-SQL definition (`migrate.sql`; `01_types`→`12_seed`).

---

## 0. Headline findings

- **There is NO single authoritative, automated initialization path for the whole schema.** [REPO-VERIFIED] The only thing the deploy pipeline / entrypoint runs is **Alembic** (`deploy/migrate.sh` / `docker-entrypoint.sh`). **Neither raw-SQL source is applied by deploy, Dockerfile, or CI.** Both have manual orchestrators (`partner_portal/00_run_all.sql`, `database/migrate.sql`).
- **Alembic manages the live application schema** — the v1 monolith (`0001`–`0014`), the B2B redesign (`models_v2`), and the B2C `customer_*` set (`0044`→`0095`).
- **The partner portal is live via `sp_*`** [REPO-VERIFIED app call sites] → its schema (tables + `sp_*` + triggers + views) **must have been applied out-of-band at least once** [INFERENCE]; source is `partner_portal/*.sql` and/or `database/*.sql` ([LIVE-UNKNOWN] which).
- **`database/*.sql` diverges from the live app** — it defines a B2C design with **`user_*`** tables (`user_bookings`, `user_profiles`, `user_reviews`, …), plus `admins` and geo tables (`airlines`, `airports`, `cities`, `states`), which do **not** match the running app's **`customer_*`** (B2C) and `models_v2` (B2B). [REPO-VERIFIED naming mismatch] → **[INFERENCE] `database/*.sql` is a design/reference monolith, not the deployed runtime schema.**

## 1. Consolidated table inventory (by source) [REPO-VERIFIED]

- **Alembic** (`create_table` across versions): the **v1 monolith** (`users`, `roles`, `flights`, `hotels`, `cruises`, `tour_packages`, `bookings`, `payments`, `contact_us`, `newsletter`, `reviews`, `wishlist`, `notifications`, `activity_logs`, `support_tickets`, `user_sessions`, `coupons`, `seasonal_prices`, `discount_campaigns`); the **B2B redesign** (`merchants`, `users`, `service_requests`, `payments`, `providers`, `provider_users`, wallet set, `*_enquiries`, `passport_ocr_*`, logging/audit — 26 `models_v2` tables); the **B2C set** (~48 `customer_*` + `payment_provider_events` + `customer_admin_audit_logs`).
- **partner_portal/*.sql** (19 tables): `partners`, `partner_users`, `partner_otp_requests`, `partner_bookings`, `partner_booking_passengers`, `booking_reference_counters`, `service_requests`, `cancellation_requests`, `cancellation_request_passengers`, `date_change_requests`, `refund_requests`, `passenger_modification_requests`, `partner_payments`, `report_generation_log`, `partner_notifications`, `partner_audit_logs`, `countries`, `permissions`, `role_permissions`.
- **database/*.sql** (~70 tables): the partner set above **plus** `admins`/`admin_*`, geo (`airlines`, `airports`, `cities`, `states`, `countries`, `currencies`, `languages`), catalogue (`flights`, `hotels`, `hotel_chains`, `cruises`, `cruise_lines`, `tour_packages`, `package_images`, `ancillary_service_catalog`, `payment_methods`), pricing (`coupons`, `seasonal_prices`, `discount_campaigns`), `contact_us`, `newsletter`, `audit_logs`, `system_settings`, extended partner (`partner_staff`, `partner_wallet(_transactions)`, `partner_invoices`, `partner_commissions`, `partner_documents`, `partner_bank_accounts`, `partner_profiles`, `partner_sessions`, status-history), and a **`user_*` B2C family** (`users`, `user_profiles`, `user_addresses`, `user_bookings`, `user_payments`, `user_reviews`, `user_wishlist`, `user_notifications`, `user_support_tickets`, `user_sessions`, `user_activity_logs`).

## 2. Source-by-source matrix (where each table is defined)

| Group | Alembic | partner_portal | database/*.sql | Note |
|---|---|---|---|---|
| B2C `customer_*` (live) | **Yes** | no | **no** (uses `user_*` instead) | **Only Alembic** — the live B2C schema |
| B2B `models_v2` (merchants, wallet, providers, enquiries, passport_ocr) | **Yes** | no | partial (`partners`-style, different) | Alembic is live |
| Partner module (`partners`, `partner_users`, `service_requests`, cancellation/refund/date-change, `partner_bookings`, `report_generation_log`, `partner_*`) | `service_requests`/`payments` names only | **Yes** | **Yes** | **Multi-source** → see §5 conflicts |
| v1 monolith (`flights`,`hotels`,`cruises`,`tour_packages`,`bookings`,`reviews`,`wishlist`,`notifications`,`support_tickets`,`coupons`,`seasonal_prices`,`discount_campaigns`,`contact_us`,`newsletter`,`activity_logs`,`user_sessions`,`roles`) | **Yes** (0001/0008/0009/0014) | no | **Yes** | **Alembic + database/*.sql** |
| Reference (`countries`,`permissions`,`role_permissions`,`ancillary_service_catalog`) | no | `countries`,`permissions`,`role_permissions` | **Yes** (all) | partner_portal + database |
| `admins`/`admin_*`, geo (`airlines`,`airports`,`cities`,`states`,`currencies`,`languages`), `user_*` B2C, `package_images`, `system_settings`, extended partner (`partner_staff`,`partner_wallet`,…) | no | no | **Yes only** | **database/*.sql ONLY** → almost certainly not deployed (app uses `customer_*`, not `user_*`) [INFERENCE] |

- **Multiple sources:** the partner module, the v1 monolith, and reference tables.
- **Single source — Alembic only:** the live `customer_*` B2C + most of `models_v2` B2B. **These are the deployed app schema.**
- **Single source — database/*.sql only:** `user_*`, `admins`, geo, extended-partner, `package_images`, `system_settings` → a parallel design, not matched by any live code [INFERENCE].

## 3. Foreign-key dependency matrix (notable / cross-table) [REPO-VERIFIED]

Full per-column FKs number in the hundreds; the authoritative sources are the model files and the `*/07_constraints.sql`. Key points:
- **B2C (`customer_*`, Alembic):** self-contained FK island — every FK targets another `customer_*` table or `customers`; **no FK into B2B.** [REPO-VERIFIED]
- **B2B (`models_v2`, Alembic):** FKs stay within the B2B set (e.g. `payments`→`service_requests`, `provider_users`→`providers`, wallet→`merchants`); **no FK into `customer_*`.** [REPO-VERIFIED]
- **v1 monolith:** no **live** model declares a FK into it. **But** `database/07_constraints.sql` defines **`package_images.package_id → tour_packages(id)`** and other intra-database FKs → within that source there ARE dependents. [REPO-VERIFIED]
- **partner_portal / database partner module:** extensive internal FKs (bookings→partners, passengers→bookings, service_requests→partners/users, status-history→requests). Self-consistent within each source.
- **database/*.sql `user_*` family:** internal FKs (`user_*`→`users`, bookings→flights/hotels) — self-consistent but **isolated to that non-deployed design** [INFERENCE].
- **No FK crosses between the three sources' distinct sets** except via the shared/duplicated table names (§5), where which physical object a FK binds to is **[LIVE-UNKNOWN]**.

## 4. Views, triggers, stored procedures, indexes

- **Views [REPO-VERIFIED]** (partner_portal `08_views` / database `08_views`): `vw_partner_dashboard_stats`, `vw_reports_summary`, `vw_request_history`, `vw_service_requests`, `vw_ticket_enquiry`.
- **Triggers [REPO-VERIFIED]:** partner/database — `trg_audit_*`, `trg_auto_generate_booking_reference`, `trg_auto_generate_service_request_number`, `trg_*_updated_at`, `trg_track_*_status_history`, `trg_notify_*`; Alembic — `trg_block_customer_admin_audit_mutation` (`0095`). Trigger functions `fn_*` live in `database/09_functions.sql`, `partner_portal/09_triggers.sql`, and `0095`.
- **Stored procedures [REPO-VERIFIED]:** `sp_*` defined in **both** `database/10_procedures.sql` (**26**) **and** `partner_portal/10–13` (**19**) — overlapping definitions (§5). The app calls 21 of them; the live set must exist for the partner portal to work [INFERENCE].
- **Indexes [REPO-VERIFIED]:** per-source (`*/06_indexes.sql` for raw SQL; inline in Alembic migrations). The `customer_admin_audit_logs` indexes + partial-unique are in `0095`.

## 5. Duplicate / conflicting definitions [REPO-VERIFIED definitions / LIVE-UNKNOWN which is deployed]

- **`service_requests`** — defined in **Alembic (`models_v2`)**, **partner_portal/05**, **and database/*.sql**. Three definitions; column shapes may differ. The `sp_*` operate on it and `models_v2` maps it. **Which physical definition is live is [LIVE-UNKNOWN].** Highest-priority ambiguity.
- **Partner module tables** (`partners`, `partner_users`, `partner_bookings`, `partner_payments`, `cancellation_requests`, `refund_requests`, `report_generation_log`, `booking_reference_counters`, `partner_notifications`, `partner_audit_logs`) — defined in **both** partner_portal/*.sql **and** database/*.sql. Duplicate module; possibly divergent columns. [LIVE-UNKNOWN which applied]
- **`sp_*`** — in **both** `database/10_procedures.sql` (26) and `partner_portal/10–13` (19). Overlapping procedure bodies; a maintenance conflict and a "which was loaded" ambiguity.
- **Reference tables** (`countries`, `permissions`, `role_permissions`) — partner_portal **and** database.
- **v1 monolith** (`flights`, `hotels`, …, `coupons`, `contact_us`, `user_sessions`, `users`, `payments`, `audit_logs`) — Alembic **and** database/*.sql (different shapes likely).
- **B2C naming conflict** — Alembic/live uses **`customer_*`**; database/*.sql uses **`user_*`** for the same concepts. These are **mutually exclusive designs**; applying database/*.sql to the live DB would create a **divergent, duplicate** B2C schema. [REPO-VERIFIED / INFERENCE]

## 6. Initialization & migration ordering [REPO-VERIFIED]

- **Alembic (automated, the app's path):** linear chain `0001`→`0095`; run by `deploy/migrate.sh` (migration role) / `docker-entrypoint.sh` (opt-in) / `redeploy.sh`. Fail-closed without `MIGRATION_DATABASE_URL` on deployed hosts.
- **partner_portal (manual):** `00_run_all.sql` orders `01_types`→`02_reference`→`03_partner`→`04_booking`→`05_service_request`→`06_payment/…`→`07_sequences`→`08_views`→`09_triggers`→`10–13 procedures`. **Not invoked by deploy/CI** [REPO-VERIFIED].
- **database/*.sql (manual):** `migrate.sql` orders `01_types`→`02_shared`→`03_admin`→`04_partner`→`05_user`→`06_indexes`→`07_constraints`→`08_views`→`09_functions`→`10_procedures`→`11_triggers`→`12_seed`. **Not invoked by deploy/CI** [REPO-VERIFIED].
- **Execution-order dependency across sources is undefined** — nothing sequences "Alembic then partner_portal" or resolves the duplicate definitions. [REPO-VERIFIED absence] This is the core gap.

## 7. Unresolved questions for the DBA [LIVE-UNKNOWN]

1. **Which raw-SQL source (if any) was applied to each environment** — `partner_portal/*.sql`, `database/*.sql`, both, or neither? (Confirm by listing live objects: `partner_*`, `user_*`, `admins`, `airlines`.)
2. **Which definition of `service_requests` / `countries` / `permissions` / `payments` / `users` is live**, and its exact columns, vs each source.
3. **Which `sp_*` set is deployed** (the 26 from `database/10` or the 19 from `partner_portal/10–13`) and whether their bodies match what `sp_*`-calling code expects.
4. **Do any `user_*`/`admins`/geo tables from `database/*.sql` exist in the live DB** (if so, likely orphaned/unused, since the app uses `customer_*`)?
5. **Does the live DB match the Alembic head (`0095`)**, and were any objects created outside Alembic (owner, provenance)?

## 8. Recommended authoritative schema-management approach [INFERENCE / recommendation]

1. **Alembic = single source of truth for the APPLICATION schema** (B2B `models_v2` + B2C `customer_*` + the v1 leftovers). Keep it the only automated init/upgrade path.
2. **Partner portal = the authoritative PARTNER-MODULE schema**, applied out-of-band today. **Document its manual apply in the official init runbook**, and (separately approved, later) **fold the partner objects into Alembic** as an explicitly-managed baseline so there is one upgrade path. Until then, pin **one** source for `sp_*` (prefer `partner_portal/10–13` or `database/10`, not both) to end the duplication.
3. **`database/*.sql` = deprecate / quarantine as a design artifact.** Do **not** apply it to any live database — its `user_*`/`admins` design conflicts with the live `customer_*`/`models_v2` and would create divergent duplicates. Mark it clearly as non-authoritative (or move to a `design/` archive) in a separate, owner-approved change.
4. **Resolve the collision tables** (`service_requests`, `users`, `payments`, `countries`, …) by confirming the live definition (§7) before any schema change; never drop/alter a table whose live provenance is unconfirmed.
5. **Preserve all data; keep Gaming disabled.** No source is applied, deleted, or altered as part of this review.

---

**This reconciliation changed nothing** — repository inspection only; no DB connection, no SQL, no Alembic/migrations, no code/SQL/table/data change, no deploy/commit. All B2B/B2C data and architecture preserved; Gaming Tour Packages remain disabled. No SQL file is asserted to have run in production — deployment of the raw-SQL schemas is [LIVE-UNKNOWN].

**Document created:** `docs/FINAL_DATABASE_SCHEMA_SOURCE_RECONCILIATION.md`.
