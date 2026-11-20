> **⚠ SUPERSEDED (2026-11-12):** The architecture decision changed to **one PostgreSQL database with logical B2B/B2C separation** (no second physical database). This physical-split plan is retained for history only. The authoritative plan is **`docs/B2C_LOGICAL_SEPARATION_PLAN.md`**.

# B2B / B2C Physical Database Separation — Technical Implementation Plan (v2)

**Project:** JackPots World Tours & Travels
**Approved for:** architecture planning & read-only investigation only — **NOT implementation.**
**Status:** No code, config, schema, migration, database, or git change has been made. Nothing below has been executed.
**Supersedes:** v1 of this document. Incorporates your four approved decisions and a deeper read-only dependency trace.
**Date:** 2026-11-12
**Evidence tags:** **[V]** Verified in repo (path/line) · **[P]** Partial (found, not exhaustively traced) · **[NV]** Not Verified — must be confirmed at implementation (e.g. anything needing a live DB query, which planning does not do).

---

## Headline change since v1 — the "ambiguous" tables are a DEAD legacy cluster, not a live B2C dependency

A precise, import-level trace (not substring matching) establishes:

- The six tables you flagged — `coupons`, `seasonal_prices`, `discount_campaigns`, `flights`, `hotels`, `tour_packages` — are defined on the **legacy `app/models/` layer** and are used **only** by six services: `pricing_service`, `catalog_items`, `booking_management_service`, `admin_service`, `payment_management_service`, `inventory_service`. [V — `app/models/pricing.py`, `app/models/travel.py`; import lines below]
- **None of those six services is imported by any router, by `main.py`, by any script, job, or test.** They import only each other. [V — whole-repo grep over `backend`, `scripts`, `qa`, `loadtest`, `tests` returned no external importer; `main.py` has zero references]
- The **live B2C** booking/pricing/catalogue path uses its **own** tables and services: `customer_pricing_service` → `CustomerCoupon`; `customer_catalog_service` / `customer_hotel_catalog_service` / `customer_package_catalog_service` → `customer_hotels` / `customer_packages` / `customer_destinations`. [V — `services/customer_pricing_service.py:34-35`, `routers/customer_bookings.py:45`]

**Therefore:** B2C has **zero runtime dependency** on the legacy tables. The physical split needs **no cross-DB reads, no shared-table copy, and no synchronization mechanism** for these six tables. They simply **stay in the B2B database, untouched**, as quarantined legacy, pending the Decision-4 workstream. This removes the single biggest risk identified in v1.

> One honesty caveat carried forward: planning cannot query the live DB, so I cannot confirm these legacy tables are empty or that no *out-of-repo* process writes them. That runtime confirmation is an explicit task in the Decision-4 workstream (§6) and an unresolved question (§11).

---

## 1. Final proposed architecture

```
                         ┌──────────────────────────────────────────┐
                         │         Unified Admin Portal (SPA)        │
                         │     frontend/admin/index.html (exists)    │
                         │        B2B toggle   │   B2C toggle        │
                         └─────────┬───────────┴────────────┬────────┘
                                   │ (one admin login, B2B identity)  │
                ┌──────────────────▼─────────┐     ┌────────▼───────────────────┐
   AUTH always  │  B2B API (routers/services)│     │  B2C API (customer_* svcs) │
   on B2B id →  │  models_v2.*  (Base A)      │     │  models_customer.* (Base B)│
                │  get_db  ──────────────┐   │     │  get_customer_db ───────┐  │
                └────────────────────────┼───┘     └─────────────────────────┼──┘
                                         ▼                                    ▼
                              ┌─────────────────────┐            ┌──────────────────────┐
                              │  B2B PostgreSQL DB   │            │  B2C PostgreSQL DB    │
                              │  (EXISTING, in place)│            │  (NEW, provisioned)   │
                              │  26 models_v2 tables │            │  ~47 customer_* tables│
                              │  + legacy app/models │   NO       │  + payment_provider_  │
                              │    (dead, quarantined)│  CROSS-DB │    events             │
                              │  alembic/ (95 revs)  │  FK/QUERY  │  alembic_customer/    │
                              └─────────────────────┘            └──────────────────────┘
```

- **Two engines, two pools, two session factories, two Alembic histories.** B2B keeps the incumbent database and connection untouched; B2C is extracted into a new physical PostgreSQL database.
- **Admin identity stays B2B-only.** B2C-admin requests use a second session for operational data; the admin is never copied into the B2C DB (§5).
- **No automatic fallback, no cross-DB FK, no cross-DB query** — enforced structurally (separate `Base` metadatas) and in CI (`tests/verify_customer_portal.py`, extended).

---

## 2. Table ownership matrix

### 2.1 The six flagged tables — per-table analysis (your Decision-1 eight questions)

| # | Table | 1. DB now / model | 2. B2B services | 3. B2C services | 4. Frontend pages | 5. Ownership | 6. B2C needs own copy? | 7. API vs sync | 8. Migration/consistency risk |
|---|---|---|---|---|---|---|---|---|---|
| a | `coupons` | shared DB; `app/models/pricing.py:Coupon` (legacy Base); created mig `0014_pricing_coupons` [V] | `pricing_service` only — **dead, no router** [V] | **none** — B2C uses `CustomerCoupon`/`customer_coupons` [V `customer_pricing_service.py:34`] | none via live API (coupon endpoints hit `customer_pricing_service`) [V] | **Legacy/dead** (superseded by `customer_coupons`) | Already has it (`customer_coupons`) | Neither — not shared live data | **None for the split.** Risk only if the dead cluster is revived |
| b | `seasonal_prices` | shared; `app/models/pricing.py:SeasonalPrice` (legacy); mig `0014` [V] | `pricing_service` only — dead [V] | none [V] | none live | **Legacy/dead** | No (B2C pricing is self-contained in `customer_pricing_service`) | Neither | None for split |
| c | `discount_campaigns` | shared; `app/models/pricing.py:DiscountCampaign` (legacy); mig `0014` [V] | `pricing_service` only — dead [V] | none [V] | none live | **Legacy/dead** | No | Neither | None for split |
| d | `flights` | shared; `app/models/travel.py:Flight` (legacy) [V] | `catalog_items`,`inventory_service`,`booking_management_service`,`admin_service` — all dead [V] | **none** — B2C flights use live supplier search (Duffel) + `customer_bookings`, no stored `flights` table [V] | `flights.html` served via customer_* APIs/static, not legacy `flights` [P] | **Legacy/dead** | No (B2C has no equivalent stored catalogue; it searches live) | Neither | None for split |
| e | `hotels` | shared; `app/models/travel.py:Hotel` (legacy) [V] | same dead cluster [V] | **none** — B2C uses `customer_hotels` via `customer_hotel_catalog_service` [V] | `hotels.html` via `customer_hotels` APIs | **Legacy/dead** | Already has it (`customer_hotels`) | Neither | None for split |
| f | `tour_packages` | shared; `app/models/travel.py:TourPackage` (legacy) [V] | same dead cluster [V] | **none** — B2C uses `customer_packages` via `customer_package_catalog_service` [V] | `packages.html` via `customer_packages` APIs | **Legacy/dead** | Already has it (`customer_packages`) | Neither | None for split |

**Safest ownership architecture (recommended):** all six remain **B2B-DB-resident dead legacy**; **do not migrate, do not copy, do not duplicate business logic.** B2C already owns independent equivalents. No authenticated-API or sync mechanism is required because there is no live cross-environment read. This fully satisfies "B2C booking/pricing/customer workflows must not depend on direct B2B database access" — they already don't.

### 2.2 Environment ownership summary

| Set | Count | Base / file | Target DB | Action |
|---|---|---|---|---|
| B2B operational | 26 | `models_v2.py` (Base A) | **B2B (stays)** | None |
| Legacy v1 (incl. the 6 above) | ~39 | `app/models/` (Base C) | **B2B (stays, quarantined)** | None in split; trace in Decision-4 workstream |
| B2C operational | ~47 `customer_*` + `payment_provider_events` | `models_customer.py` (Base B) | **B2C (migrate)** | Physical move (§7) |

---

## 3. API & service dependency mapping

**Live B2C router → service → model (all on `models_customer`, all currently `get_db`):** [V — `main.py`, router import lines]

| Router (prefix) | Live service | Models | → session after split |
|---|---|---|---|
| `customer_auth` | `customer_auth_service` | `customers,customer_auth,customer_otps,…` | `get_customer_db` |
| `customer_profile`,`customer_account`,`customer_travellers` | account services | `customer_profiles,customer_identities,customer_travellers` | `get_customer_db` |
| `customer_bookings` | `customer_pricing_service`, booking svcs | `customer_bookings,…,CustomerCoupon` | `get_customer_db` |
| `customer_hotel_bookings` | `customer_hotel_pricing_service` | `customer_hotel_*` | `get_customer_db` |
| `customer_package_bookings` | `customer_package_pricing_service` | `customer_package_*` | `get_customer_db` |
| `customer_cancellations` | `customer_cancellation_admin_service` | `customer_cancellation_requests,customer_refund_attempts` | `get_customer_db` |
| `customer_payment_admin` | `customer_payment_admin_service`,`payment_event_service` | `customer_*_payments,payment_provider_events` | `get_customer_db` |
| `customer_chat`,`customer_assistant` | chat/assistant svcs | `customer_conversations,…,customer_calls` | `get_customer_db` |
| `customer_destinations`,`customer_recommendations` | catalog svcs | `customer_destinations,customer_locations,customer_attractions` | `get_customer_db` |
| **`admin_customer_bookings`** | `customer_booking_admin_service` | `customer_*` | **2-session** (auth B2B + data B2C) |
| **`admin_cancellations`** | `customer_cancellation_admin_service` | `customer_*` (+ today B2B `audit_logs`) | **2-session**; audit → B2C (§5) |
| **`admin_reconciliation`** | `customer_payment_admin_service` | `customer_*`,`payment_provider_events` | **2-session** |
| **`admin_reviews`,`admin_communication`,`admin_user_activity`,`admin_b2c_reports`** | `customer_*_admin_service` | `customer_*` | **2-session** |
| **`admin_catalogue`(+hotels/packages/destinations)** | `catalogue_*_admin_service` | `customer_hotels/packages/destinations` | **2-session** |
| `customer_admin` | `customer_admin_service` | `customers,customer_auth` | **2-session** |

**Stays on B2B `get_db` (do NOT swap):** all `models_v2`-backed routers — `auth,super_admin,merchants,merchant_team,merchant_approvals,manager,manager_approvals,enquiries,hotel_enquiries,tour_package_enquiries,group_bookings,booking_ops,change_requests,finance,wallet,payment_admin,providers,dashboard,reports,admin_ops,support_tickets,tickets,messages,analytics,documents,passport_ocr`.

**⚠ Mixed/confirm per-endpoint (§11):** `gaming_tour_enquiries` (uses **B2B** `models_v2.GamingTourEnquiry` — stays B2B, see §8 gaming), `eticket` (owner/public), `public`. Route each endpoint by the `Base` of the model it touches. [P]

---

## 4. Database separation design

- **Config:** add `customer_database_url: str` to `backend/app/config.py` (sibling of `database_url` at line 9). No change to `database_url`. [V — `config.py:9`]
- **Engines/sessions:** keep `backend/app/database/session.py` (B2B `engine`,`SessionLocal`,`get_db`,`Base`). Add `backend/app/database/customer_session.py` → `customer_engine`,`CustomerSessionLocal`,`get_customer_db`, binding `models_customer.Base` to `customer_engine`.
- **Repositories:** introduce explicit B2C repository/session boundaries so no B2C query can run on the B2B session (lint/CI guard in §9).
- **Alembic (independent histories):**
  - B2B: existing `backend/alembic/` stays. **Note:** its `env.py` sets `target_metadata = app.database.session.Base.metadata` and imports `app/models` only — i.e. autogenerate currently sees **only legacy** tables; `models_v2`/`models_customer` migrations are hand-written. [V — `alembic/env.py:7-8,15`] Leave B2B as-is.
  - B2C: new `backend/alembic_customer/` with its own `env.py` → `target_metadata = models_customer.Base.metadata`, URL = `customer_database_url`, its own `alembic_version` in the B2C DB, and a **squashed baseline** migration built from the ~9 existing customer migrations (`0044,0053,0054,0055,0061,0079,0086,0089,0094`). [V — migration list]
- **No fallback:** two independent engines (no shared default); add per-engine startup health checks; a B2C DB outage returns 503 for B2C endpoints and must never read B2B.
- **No cross-DB FK:** already true (B2C FK island is self-contained; B2B has no FK to `customer_*`). [V] Enforce via separate metadatas + extended `verify_customer_portal.py`.

---

## 5. Authentication & audit architecture (Decision 2)

**Authentication (unchanged identity store):** admin/staff identity lives only in B2B `users` (permissions are a JSONB array on `users`; legacy `permissions`/`role_permissions` tables are unused). [V — `auth/deps.py:17,37,75-89`] A B2C-admin request:
1. **Auth session (B2B):** `get_current_admin` validates the token against B2B `users` via `get_db`. [V — `auth/deps.py:30-50`]
2. **Operational session (B2C):** the endpoint reads/writes `customer_*` via `get_customer_db`.
The admin identity is **never written into the B2C DB as data**; only an **identifier + snapshot** goes into B2C audit rows (below). No cross-DB FK.

**Audit (Decision 2 approved):**
- The existing `customer_audit_logs` is the **customer's own** trail (fields: `customer_id,customer_code,action,module,description,ip,browser,device,status,created_at`) — **no admin actor fields.** [V — `models_customer.py:312-335`] Keep it for customer self-service actions.
- **Add a dedicated B2C table `customer_admin_audit_logs`** (B2C DB) for **administrator** actions on B2C data. Columns (proposed): `id`, `admin_user_id` (plain `BigInteger`, **no FK** to B2B `users`), `admin_identity_snapshot` (email/name/role captured at write time), `environment='b2c'`, `action`, `record_type`, `record_id`, `before`/`after` (JSON, secrets excluded), `reason`, `outcome`, `ip`, `created_at`. This preserves full audit history for sensitive operations with no cross-DB FK.
- **Migration of current behaviour:** `admin_cancellations._audit()` today writes B2B `audit_logs` while operating on B2C refund tables. [V — `routers/admin_cancellations.py:77`] Post-split, B2C-admin audit writes go to `customer_admin_audit_logs` (B2C), eliminating the cross-DB write. B2B `audit_logs` remains for B2B-only actions.

> Confirm point (§11): whether you prefer the dedicated `customer_admin_audit_logs` table (recommended) or extending `customer_audit_logs` with admin columns. Your Decision-2 wording ("a separate `customer_audit_logs` table … administrator identifier and identity snapshot") is satisfied by either; the dedicated table keeps the customer trail clean.

---

## 6. Legacy dependency report (Decision 4 — read-only trace)

**Three layers:**
| Layer | File | Base | Live? | Evidence |
|---|---|---|---|---|
| B2B | `models_v2.py` | A | **LIVE** | used by `auth/deps.py`, all B2B routers/services [V] |
| B2C | `models_customer.py` | B | **LIVE** | used by all `customer_*` routers/services [V] |
| Legacy v1 | `app/models/` | C | **DEAD at code level** | see below |

**Duplicate-table-name verdicts:**
| Table | Legacy (dead) | Live | Evidence |
|---|---|---|---|
| `users` | `app/models/user.py:User` — imported only by dead cluster (`admin_service`,`booking_management_service`,`payment_management_service`) + `__init__` | `models_v2.User` | [V — `auth/deps.py:17` uses `models_v2.User`; legacy importers are all dead-cluster] |
| `payments` | `app/models/booking.py:Payment` — only dead cluster | `models_v2.Payment` (B2B) + `customer_*_payments` (B2C) | [V] |
| `service_requests` | `app/models/partner_service_request.py:ServiceRequest` — **imported by nothing at all** | `models_v2.ServiceRequest` | [V — zero importers repo-wide] |

**Dead legacy service cluster (unreferenced by any router/main/script/job/test):** `admin_service`, `booking_management_service`, `catalog_items`, `payment_management_service`, `pricing_service`, `inventory_service`. They import each other and the legacy models; nothing else imports them. [V — whole-repo grep] The only live importer of `app/models` is `alembic/env.py:8` (metadata registration).

**Recommendation (respecting "do not delete"):** **do not delete** any legacy model, table, or record. Quarantine: leave them in the B2B DB, and in a follow-up workstream (a) run a **read-only** row-count + `updated_at` scan on the six tables and the legacy `users`/`payments`/`service_requests` to confirm no live writes [NV — needs DB], (b) document the dead cluster, (c) only then propose (separately, for your approval) whether to retire it. None of this is part of the physical split.

---

## 7. Migration & rollback procedure (Decision 3 — controlled maintenance window)

**B2B stays operational throughout** (its DB is never migrated; only `customer_*` tables are dropped from it at the very end, post-verification, against a backup).

1. **Backup plan:** full `pg_dump` (schema+data) of the shared DB; plus per-table dumps of every `customer_*` table + `payment_provider_events`; verify a **test restore** into a scratch instance; record a per-table row-count manifest.
2. **Pre-migration validation:** provision the new B2C PostgreSQL DB; apply the B2C squashed baseline (schema only); confirm schema matches `models_customer.Base.metadata`; confirm app boots against two DBs in staging.
3. **B2C data migration sequence (parents→children, from the FK map):** `customers` → auth/profile/identity/session/otp/reset/audit → `customer_travellers` → destinations/locations/attractions → `customer_hotels`→rooms → `customer_packages`→itinerary/hotels/departures → `customer_bookings`→passengers/addons/payments → cancellation_requests → refund_attempts → `customer_hotel_bookings`→rooms/guests/addons/payments → `customer_package_bookings`→travellers/addons/payments → coupons/wishlist/notifications/reviews → support_tickets→messages → conversations→chat_messages→attachments; calls → assistant_sessions→messages → activity → `payment_provider_events`. [V — FK order from `models_customer.py`]
4. **Foreign-key validation:** after load, assert zero orphans for every child→parent FK; re-create/validate FKs in the B2C DB.
5. **Record-count comparison:** per-table B2C counts == source manifest, for all ~47 tables.
6. **Data integrity checks:** PK/unique parity; checksum/sample compare on `customer_bookings`, all `*_payments`, `customer_refund_attempts`; reset identity sequences to `max(id)+1`.
7. **Application cutover sequence:** (a) enter B2C maintenance (freeze B2C writes; B2B stays live); (b) final delta sync; (c) set `customer_database_url`; (d) deploy code with `get_customer_db` + 2-session admin endpoints + B2C audit; (e) run `verify_customer_portal.py` + smoke tests; (f) exit maintenance.
8. **Rollback plan:** `customer_*` tables remain intact in the B2B DB until B2C is verified. On failure: revert config/code to single-DB path → system runs exactly as today; drop & rebuild B2C DB from backup. No B2B impact at any point.
9. **B2B continuity verification:** merchant/B2B smoke tests before, during, after; confirm B2B DB connections and row counts unchanged.
10. **B2C maintenance-window requirements:** window length scales with `customer_*` data volume [NV — unknown in planning]; schedule low-traffic; status page for B2C site/app; B2B unaffected.

**Logical-replication assessment:** Postgres logical replication of the `customer_*` tables could cut B2C downtime to a brief cutover (near-zero) by pre-syncing before the window. **Advantage is real but modest** given the self-contained island and presumed moderate data volume, and it adds setup/monitoring complexity and sequence/identity-handling care. **Recommendation: default to the controlled maintenance window; hold logical replication as an option only if the measured window (from step 1 counts) proves unacceptably long.**

---

## 8. File-by-file implementation sequence (proposed — nothing executed)

**Independent quick win — Gaming fail-closed (can land anytime; keep disabled until you authorize):**
- `backend/app/config.py` — add `gaming_tour_packages_enabled: bool = False` (fail-closed).
- `backend/app/routers/gaming_tour_enquiries.py` — gate public `POST /api/customer/gaming-tour-enquiries` + admin endpoints behind the flag (503/404 when off).
- `frontend/gaming-packages.html`, `frontend/admin/index.html:341-355`, `frontend/sitemap.xml`/`robots.txt` — hide/disable gaming surfaces.
- Retain `gaming_tour_enquiries` table/rows (no delete). `GamingTourEnquiry` stays on B2B Base/DB. [V]

**Stage A — B2C DB scaffolding (no data, no routing change):**
1. `backend/app/config.py` — add `customer_database_url`.
2. `backend/app/database/customer_session.py` (new) — `customer_engine`, `CustomerSessionLocal`, `get_customer_db`.
3. `backend/alembic_customer/` (new) — `env.py` (target `models_customer.Base.metadata`, URL `customer_database_url`), `alembic_customer.ini`, squashed baseline migration.
4. `backend/app/models_customer.py` — add `CustomerAdminAuditLog`; new baseline covers it.
5. Startup health checks for both engines in `backend/app/main.py` (fail-closed B2C).

**Stage B — routing swap (deploys with cutover, §7 step 7):**
6. Swap `Depends(get_db)` → `Depends(get_customer_db)` in all **customer_*** routers (§3 list).
7. Admin-on-B2C routers (`admin_customer_bookings, admin_cancellations, admin_reconciliation, admin_reviews, admin_communication, admin_user_activity, admin_b2c_reports, admin_catalogue*, customer_admin`): keep `get_current_admin` on B2B `get_db`; add `get_customer_db` for data; route operational audit to `customer_admin_audit_logs`.
8. Per-endpoint review of `eticket`, `public`, `gaming_tour_enquiries` (§11).

**Stage C — data migration** (§7). **Stage D — verification + gated drop of `customer_*` from B2B DB** (post-verify, against backup).

---

## 9. Testing & acceptance criteria

- **Routing:** automated test/lint asserts **no `customer_*` router imports `get_db`**; all use `get_customer_db`. B2B routers unchanged.
- **No fallback:** a B2C query against a DB lacking `customer_*` fails fast (no silent B2B read).
- **No cross-DB FK/query:** extend `tests/verify_customer_portal.py` to assert the boundary; separate `Base` metadatas.
- **Data parity:** per-table row-count parity (manifest == B2C); zero FK orphans; checksum match on bookings/payments/refunds.
- **Auth/audit:** B2C-admin endpoints authenticate on B2B, operate on B2C, and write `customer_admin_audit_logs` (B2C) with admin id + snapshot; no cross-DB FK exists.
- **B2B regression (continuity):** full B2B/merchant suite passes **unchanged**; B2B DB untouched.
- **Gaming:** disabled across public API, page, admin, sitemap/SEO when flag off (fail-closed when unset).
- **Preservation:** HDFC config untouched; TrustBrick routing untouched (confirm its `payment_provider_events` writes bind to `get_customer_db`); Duffel untouched; no real payment/refund; no TBO invention; no migration executed; no deploy/push.

**Acceptance:** all above green in staging with two DBs, `verify_customer_portal.py` passing, and a rehearsed rollback demonstrated.

---

## 10. Preservation & restriction checklist (your mandatory items)

B2B DB & merchant portal preserved (never migrated) ✓ · B2C records preserved (copy-verify-then-drop) ✓ · Gaming disabled until you authorize ✓ · HDFC config untouched ✓ · TrustBrick routing untouched ✓ · Duffel preserved ✓ · No TBO invention ✓ · No real payment/refund ✓ · No migration executed ✓ · No deploy/push ✓. **This document changed no source, config, DB, migration, or git file.**

---

## 11. Unresolved questions (need your confirmation / a DB-connected step)

1. **[NV]** Confirm, via a **read-only** row-count + `updated_at` scan, that the six legacy tables (and legacy `users`/`payments`/`service_requests`) hold no actively-written rows before any quarantine. Cannot be done in planning.
2. **Audit table shape:** dedicated `customer_admin_audit_logs` (recommended) vs. extending `customer_audit_logs` with admin columns — confirm.
3. **`payment_provider_events`:** it sits on the B2C Base and is written by `trustbrick_provider`/`payment_event_service`; confirm **no B2B payment path** writes it, so it moves cleanly to B2C (its event writers must bind to `get_customer_db`). [P]
4. **`eticket`/`public`/`gaming_tour_enquiries` endpoints:** per-endpoint DB routing (some may touch B2B models) — confirm the endpoint-by-endpoint map.
5. **Reference/content tables inside the B2C island** (`customer_destinations`,`customer_locations`,`customer_attractions`,`customer_hotels` catalogue): confirm they are B2C-owned content (seeded by `scripts/seed_packages.py`, `scripts/sync_hotelbeds_catalogue.py`) and need no B2B linkage. [P]
6. **Maintenance-window length:** depends on `customer_*` data volume — size it from the step-1 manifest.

---

**This is architecture planning only. No implementation, migration, or deployment has been or will be performed until you give explicit approval.**

**Next, on your word (still planning, no execution):** I can produce the Stage-A file-level diffs as a reviewable spec (config keys, `customer_session.py` contents, `alembic_customer/env.py`, `CustomerAdminAuditLog` columns) and the extended `verify_customer_portal.py` assertions — presented for approval, not applied.
