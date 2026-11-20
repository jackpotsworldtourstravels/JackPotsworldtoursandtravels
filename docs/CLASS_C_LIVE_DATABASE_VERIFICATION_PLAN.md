# Class C Legacy Tables — Live Database Verification & Data-Preservation Plan

**Project:** JackPots World Tours & Travels · **Scope:** the 16 Class C orphaned v1 monolith tables from `docs/LEGACY_DATABASE_TABLE_USAGE_AND_PRESERVATION_REPORT.md`
**Date:** 2026-11-13
**Nature:** READ-ONLY plan. No PostgreSQL connection, no SQL executed, no Alembic, no migrations, no INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER, no code/object change, no commit/deploy. Gaming disabled.

**Labels:** **[REPO-VERIFIED]** from source · **[DBA ACTION]** a DBA runs it (read-only here) · **[LIVE-UNKNOWN]** cannot be known without live-DB inspection.

> **Do not claim any table is empty.** Row counts are [LIVE-UNKNOWN] until a DBA runs the read-only queries on an approved, non-production copy. "Orphaned in application code" (which IS repo-verified) does not imply "empty".

**Class C tables:** `flights`, `hotels`, `cruises`, `tour_packages`, `bookings`, `reviews`, `wishlist`, `notifications`, `support_tickets`, `coupons`, `seasonal_prices`, `discount_campaigns`, `contact_us`, `newsletter`, `activity_logs`, `user_sessions`.

---

## 1. Configured database environments (names only — no secrets) [REPO-VERIFIED]

- **Local/dev & CI:** `DATABASE_URL` (`backend/.env`, example in `backend/.env.example`). Single role; Alembic falls back to it.
- **Staging:** `DATABASE_URL` built by `deploy/staging/docker-compose.staging.yml` from `POSTGRES_*`; `DEPLOYED=true`.
- **Production (self-hosted / Render):** `DATABASE_URL` (+ `RUN_MIGRATIONS_ON_START` on Render); migrations via `MIGRATION_DATABASE_URL` (migration role).
- **One PostgreSQL database per environment** — there is no separate "legacy" database. **All verification runs on a NON-PRODUCTION copy/restore first** ([DBA ACTION]); production is read-only and only with explicit approval.
- Values (hosts, users, passwords, connection strings) are in the secret store / `.env` on each host — **not shown here**.

## 2. Schema-provenance caveat — compare live schema vs Alembic [REPO-VERIFIED + LIVE-UNKNOWN]

The Class C tables are defined in **two** places in the repo:
1. **Alembic** — `0001_initial_schema` (flights, hotels, cruises, tour_packages, bookings, reviews, wishlist, notifications, contact_us, newsletter, activity_logs, roles, users, payments), `0008` (support_tickets), `0009` (user_sessions), `0014` (coupons, seasonal_prices, discount_campaigns). Last altered ~`0004`–`0014`, then frozen.
2. **A parallel raw-SQL schema** — `database/02_shared_tables.sql` / `05_user_tables.sql` / `06_indexes.sql` / `07_constraints.sql` **also creates these tables, their indexes, and at least one FK dependent** (`package_images.package_id → tour_packages(id)`, `database/07_constraints.sql`). Whether `database/*.sql` was ever applied to the live DB (vs Alembic alone) is **[LIVE-UNKNOWN]**.

**Implication:** the live schema's actual shape/owner, and whether FK dependents like `package_images` exist, must be read from the live catalog — do not assume it matches Alembic. The DBA queries below (3.5 FK, 3.6 views, 3.7 triggers, 3.8 routines) are the authoritative source.

## 3. Read-only SQL for a DBA to review [DBA ACTION] (run on an approved copy; nothing here is executed)

```sql
-- 3.1 Existence (expect a row per table that exists)
SELECT c.relname, n.nspname AS schema
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='r' AND c.relname = ANY (ARRAY[
  'flights','hotels','cruises','tour_packages','bookings','reviews','wishlist','notifications',
  'support_tickets','coupons','seasonal_prices','discount_campaigns','contact_us','newsletter',
  'activity_logs','user_sessions']) ORDER BY c.relname;

-- 3.2 Estimated row counts (cheap; planner stats)
SELECT relname, n_live_tup AS est_rows, last_analyze, last_autoanalyze
FROM pg_stat_user_tables WHERE relname = ANY (ARRAY[ ... same list ... ]) ORDER BY relname;

-- 3.3 EXACT counts — ONLY on an approved controlled copy ([APPROVAL REQUIRED]); one per table:
--   SELECT 'bookings' t, count(*) n, max(created_at) newest FROM bookings;   (repeat/UNION per table that exists)

-- 3.4 Table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='r' AND c.relname = ANY (ARRAY[ ... ]) ORDER BY pg_total_relation_size(c.oid) DESC;

-- 3.5 FK dependencies — anything that REFERENCES a Class C table (catches package_images -> tour_packages)
SELECT conrelid::regclass AS dependent_table, conname, confrelid::regclass AS referenced_class_c
FROM pg_constraint
WHERE contype='f' AND confrelid::regclass::text = ANY (ARRAY[ ... same list ... ]);
-- ALSO FKs OUT of each Class C table (what it depends on):
SELECT conrelid::regclass AS class_c_table, conname, confrelid::regclass AS references
FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text = ANY (ARRAY[ ... ]);

-- 3.6 Views / materialized views that read a Class C table
SELECT dependent.relname AS view, dependent.relkind, src.relname AS class_c_table
FROM pg_depend d
JOIN pg_rewrite r ON r.oid=d.objid
JOIN pg_class dependent ON dependent.oid=r.ev_class
JOIN pg_class src ON src.oid=d.refobjid
WHERE src.relname = ANY (ARRAY[ ... ]) AND dependent.relkind IN ('v','m');

-- 3.7 Triggers on Class C tables
SELECT tgrelid::regclass AS table, tgname, tgfoid::regproc AS trigger_function
FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY (ARRAY[ ... ]);

-- 3.8 Stored-procedure / function bodies that reference a Class C table by name
SELECT n.nspname, p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND (
  p.prosrc ILIKE '% flights %' OR p.prosrc ILIKE '% bookings %' OR p.prosrc ILIKE '% reviews %'
  /* …extend for each Class C name; word-boundary care to avoid customer_*/partner_* matches… */ );

-- 3.9 Indexes & constraints per Class C table (document before any future action)
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE tablename = ANY (ARRAY[ ... ]) ORDER BY tablename, indexname;
SELECT conrelid::regclass AS table, conname, contype FROM pg_constraint
WHERE conrelid::regclass::text = ANY (ARRAY[ ... ]) ORDER BY 1,3;

-- 3.10 Schema-vs-Alembic cross-check
SELECT version_num FROM alembic_version;    -- confirm the chain that "should" have created these
-- then compare \d of each table to 0001/0008/0009/0014 (and note any columns from database/*.sql not in Alembic)
```

## 4. Application / dependency references [REPO-VERIFIED]

| Reference type | Finding |
|---|---|
| FastAPI routes / services | **None live.** Only the dead 6-service cluster imports the ORM models; no router/`main` imports those services. |
| Background jobs | **None.** The payment sweep / reconcile run on `models_v2`/`models_customer`, not Class C. |
| Raw SQL / `text()` in app | **None.** The only name match (`models_v2.py:943`) is a partial-index predicate `request_type = 'wishlist'` — a **literal value, not the `wishlist` table**. |
| Stored procedures (`sp_*`) | **None** reference the v1 Class C tables (the partner portal uses `partner_*`/`service_requests`, not `bookings`/`reviews`/etc.). [LIVE confirm via 3.8] |
| Reporting / analytics code | Only the dead `admin_service`/`booking_management_service` (unreachable). No live reporting path. |
| External integrations | **None** (Duffel/Hotelbeds integrations use `customer_*`/live search, not Class C). |
| **Raw-SQL schema `database/*.sql`** | **Defines these tables + indexes + `package_images → tour_packages` FK.** Provenance/deployment state is **[LIVE-UNKNOWN]** — this is the main dependency to resolve (3.5). |

## 5. Historical-data & retention concerns

- **Likely PII / customer-facing content if populated** (treat as HIGH until counted): `contact_us`, `newsletter` (emails), `reviews` (customer text), `bookings` (booking/customer data), `user_sessions` (session/user data), `notifications`. Retention/privacy rules apply; **archive, do not delete, before any decision**.
- **Catalogue / config (MEDIUM):** `flights`, `hotels`, `cruises`, `tour_packages`, `coupons`, `seasonal_prices`, `discount_campaigns`, `wishlist`, `support_tickets`, `activity_logs` — may hold original-era operational data.
- All emptiness/row counts are **[LIVE-UNKNOWN]** until 3.2/3.3.

## 6. Backup & approval checkpoints [DBA ACTION] / [APPROVAL REQUIRED]

1. **No production writes, ever** here — this is verification only.
2. **Existence / estimated counts / sizes / dependencies (3.1, 3.2, 3.4–3.9):** read-only; safe on a **non-production restore**; still owner-notified.
3. **Exact counts (3.3):** [APPROVAL REQUIRED]; run on an approved controlled copy, not production, unless the owner approves a read-only production count.
4. **Before ANY future cleanup (out of scope here):** full backup + per-table archive (`pg_dump -t`) of every Class C table with rows, retained in secured storage; owner sign-off; resolve FK dependents (e.g. `package_images`) first.

## 7. Risks & unknowns

- **R1 — Parallel schema (`database/*.sql`).** The live schema may have been built partly from this raw SQL, not Alembic alone; it adds FK dependents (`package_images`). **Resolve provenance + dependents before treating any table as isolated.** [LIVE-UNKNOWN]
- **R2 — FK dependents.** `package_images → tour_packages` [REPO-VERIFIED in `database/07_constraints.sql`]; others possible (3.5). A Class C table with a live dependent is **not** a clean drop.
- **R3 — Historical PII.** Some tables may hold customer data subject to retention/privacy obligations (§5).
- **R4 — Name collisions excluded.** `users`/`payments`/`service_requests` are **Class A/B (live)**, deliberately **not** in this Class C list — do not confuse them.
- **R5 — Existence not assumed.** A DB could have had a table manually dropped; existence is [LIVE-UNKNOWN] until 3.1.

## 8. Table-by-table verification matrix

Exists / Contains records / dependencies are **[LIVE-UNKNOWN]** (to be filled by §3); Runtime dependency is **[REPO-VERIFIED NO]** for all.

| Table | Exists in live DB | Contains records | Runtime dependency | Database dependency | Historical-data risk | Recommended action |
|---|---|---|---|---|---|---|
| `tour_packages` | UNKNOWN (repo: 0001) | UNKNOWN | **NO** | **YES-candidate** (`package_images` FK, repo) → confirm live | MEDIUM | FURTHER INVESTIGATION (resolve FK) |
| `flights` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN (3.5) | MEDIUM | FURTHER INVESTIGATION |
| `hotels` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN | MEDIUM | FURTHER INVESTIGATION |
| `cruises` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN | MEDIUM | FURTHER INVESTIGATION |
| `bookings` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN (payments FK?) | **HIGH** (booking/customer data) | ARCHIVE REVIEW |
| `reviews` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN | **HIGH** (customer content) | ARCHIVE REVIEW |
| `wishlist` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN | MEDIUM | FURTHER INVESTIGATION |
| `notifications` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN | MEDIUM–HIGH | ARCHIVE REVIEW |
| `support_tickets` | UNKNOWN (0008) | UNKNOWN | NO | UNKNOWN | MEDIUM | FURTHER INVESTIGATION |
| `coupons` | UNKNOWN (0014) | UNKNOWN | NO | UNKNOWN | MEDIUM | FURTHER INVESTIGATION |
| `seasonal_prices` | UNKNOWN (0014) | UNKNOWN | NO | UNKNOWN | MEDIUM | FURTHER INVESTIGATION |
| `discount_campaigns` | UNKNOWN (0014) | UNKNOWN | NO | UNKNOWN | MEDIUM | FURTHER INVESTIGATION |
| `contact_us` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN | **HIGH** (PII: emails/messages) | ARCHIVE REVIEW |
| `newsletter` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN | **HIGH** (PII: emails) | ARCHIVE REVIEW |
| `activity_logs` | UNKNOWN (0001) | UNKNOWN | NO | UNKNOWN | MEDIUM | FURTHER INVESTIGATION |
| `user_sessions` | UNKNOWN (0009) | UNKNOWN | NO | UNKNOWN | MEDIUM–HIGH (session/user) | ARCHIVE REVIEW |

**Default posture for all 16: PRESERVE now** (no drop, no change). Move to **ARCHIVE REVIEW** once a row count confirms data; stay at **FURTHER INVESTIGATION** until §3 (existence, counts, dependents, provenance) is complete. No table is a cleanup candidate until its live state is verified and any FK dependents resolved — a separately-approved step, out of scope here.

## 9. Final recommendation

1. **[DBA ACTION]** On an **approved non-production copy**, run §3.1–3.2 and 3.4–3.9 (existence, estimated counts, sizes, FK/view/trigger/routine/index dependencies) and §3.10 (schema-vs-Alembic). **[APPROVAL REQUIRED]** for 3.3 exact counts.
2. Fill the §8 matrix with the results; **do not label empty without a verified count**.
3. **Resolve R1/R2 first** — confirm whether `database/*.sql` shaped the live schema and enumerate FK dependents (`package_images` etc.).
4. **Archive (don't delete)** any table found non-empty; retain per retention/privacy policy (§5).
5. Any actual removal is a **separate, owner-approved** migration later — never bundled with Stage-3 staging; remove dead ORM code first, tables last.

---

**This plan changed nothing** — read-only; no DB connection, no SQL, no Alembic, no migrations, no data/object change, no code change, no commit/deploy. Gaming Tour Packages remain disabled; no B2B/B2C architecture change; partner-portal SQL/procedures untouched. Row emptiness is asserted nowhere — it is [LIVE-UNKNOWN] pending the DBA's read-only verification.

**Document created:** `docs/CLASS_C_LIVE_DATABASE_VERIFICATION_PLAN.md`.
