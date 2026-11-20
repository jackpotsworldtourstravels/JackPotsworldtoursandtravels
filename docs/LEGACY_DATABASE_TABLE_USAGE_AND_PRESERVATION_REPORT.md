# Legacy Database Tables — Usage & Preservation Report

**Project:** JackPots World Tours & Travels · **Scope:** the legacy `app/models/` layer and non-`customer_`-prefixed tables
**Date:** 2026-11-13
**Nature:** READ-ONLY. No PostgreSQL connection, no SQL, no migrations, no table/data change, no app-code change, no deploy/commit. Gaming disabled.

**Labels:** **[REPO-VERIFIED]** from source · **[LIVE]** needs live-DB inspection (row data / which physical object).

**Headline correction to earlier "legacy = dead" shorthand:** the legacy **ORM models** in `app/models/` are almost all unused, **but many of the tables they name are LIVE** — either the **partner portal** (served by raw-SQL stored procedures, not the ORM) or the **B2B core** (`users`/`payments`, evolved in place). Only a distinct **v1 monolith set** is genuinely orphaned. The three classes are below. **"Unused in application code" is NOT the same as "empty in the database"** — the production DB has run every migration, so these tables exist and may hold historical rows ([LIVE]).

---

## 1. ORM-usage map [REPO-VERIFIED]

`app/models/` submodules imported anywhere in `app/`:
- **Imported only by the dead 6-service cluster** (`admin_service`, `booking_management_service`, `catalog_items`, `pricing_service`, `payment_management_service`, `inventory_service` — none of which is imported by any router/`main`/script/test): `user`, `booking`, `travel`, `misc`, `pricing`.
- **Imported by nobody:** `partner`, `partner_booking`, `partner_misc`, `partner_service_request`, `reference`.
- `alembic/env.py` imports `app.models` only to register the legacy Base's metadata for autogenerate.

So **no live application path uses the legacy ORM classes.** Table liveness is determined separately (below), because some tables are reached via **stored procedures**, not the ORM.

## 2. Table provisioning regimes [REPO-VERIFIED]

- **Alembic** (`backend/alembic/versions/`): created the **v1 monolith** in `0001_initial_schema` + a few follow-ups (`0008`, `0009`, `0014`), and the current B2B redesign / B2C (`models_v2`, `models_customer`).
- **Raw SQL bootstrap** (`backend/db/partner_portal/*.sql`, run outside Alembic): creates the **partner-portal** tables and the `sp_*` functions + triggers. These are **live at runtime** — `partner_booking_service` / `partner_auth_service` execute `text("SELECT … sp_*(…)")` against them.

## 3. Legacy table classification & per-table report

### Class A — LIVE via the partner portal (raw-SQL bootstrap + `sp_*`); ORM mirror unused → **DO NOT clean up**

| Table | Legacy ORM model (unused) | Created by | Used by current code | FK refs | Modified by current migrations | Historical records | Overlap |
|---|---|---|---|---|---|---|---|
| `partners` | `partner.py:Partner` | partner SQL `03_` | **Yes — via `sp_*`** | internal (partner schema) | no (not in Alembic) | **Yes (live)** | B2B partner portal |
| `partner_users` | `partner.py:PartnerUser` | `03_` | Yes — `sp_partner_login_lookup`/`record_login` | internal | no | Yes (live) | B2B |
| `partner_otp_requests` | `partner.py:PartnerOTPRequest` | `03_` | Yes — `sp_request_otp`/`verify_otp` | internal | no | Yes (live) | B2B auth |
| `service_requests` | `partner_service_request.py:ServiceRequest` **and** `models_v2` | `05_` (partner SQL) | **Yes — `sp_*`** | internal | no | Yes (live) | B2B bookings — **[LIVE] which physical object the two mappings share must be confirmed** |
| `cancellation_requests`, `cancellation_request_passengers`, `date_change_requests`, `refund_requests`, `passenger_modification_requests` | `partner_service_request.py:*` | `05_` | Yes — `sp_cancel_selected_passengers`/`sp_create_*_request` | internal | no | Yes (live) | B2B service requests |
| `partner_bookings`, `partner_booking_passengers`, `booking_reference_counters` | `partner_booking.py:*` | `04_` | Yes — `sp_create_ticket_request`/`sp_add_passenger`/`sp_generate_booking_reference` | internal | no | Yes (live) | B2B bookings |
| `partner_payments`, `report_generation_log`, `partner_notifications`, `partner_audit_logs` | `partner_misc.py:*` | `06_` | Yes — `sp_generate_report` etc. | internal | no | Yes (live) | B2B payments/reports/audit |
| `countries`, `permissions`, `role_permissions`, `ancillary_service_catalog` | `reference.py:*` | `02_` (partner SQL) | Yes — reference data for `sp_*` | referenced by partner tables | no | Yes (live) | B2B reference |

### Class B — LIVE B2B core (collision names); stale ORM mirror in `app/models/` → **DO NOT clean up the tables**

| Table | Legacy ORM model (stale) | Created by | Used by current code | FK refs | Modified by current migrations | Historical records | Overlap |
|---|---|---|---|---|---|---|---|
| `users` | `user.py:User` (stale) | `0001` (evolved in place; **not** dropped by `0023`) | **Yes — as `models_v2.User`** (auth/RBAC) | live (merchant staff) | evolved early; stable | Yes (live) | **IS** the B2B users table — the legacy model is a duplicate mapping |
| `payments` | `booking.py:Payment` (stale) | `0001` (evolved) | Yes — current payment paths use `models_v2.Payment` / `customer_*_payments` | live | — | Yes (live) | the legacy model is a stale mirror |
| `roles` | `user.py:Role` | `0001` | **No** — RBAC moved to `users.permissions` JSONB (legacy `roles`/`permissions`/`role_permissions` tables not read by `auth/deps`) | — | no | possibly | superseded by `users.permissions` |

> `users`/`payments` **tables** are live B2B objects; only their **legacy `app/models` mappings** are stale duplicates (the removable part — a code-only concern, never a table drop). `service_requests` (Class A) and these share the owner/superuser caveat of the collision names — the exact physical ownership is **[LIVE/UNRESOLVED]**.

### Class C — Orphaned v1 monolith (Alembic `0001`/`0008`/`0009`/`0014`, frozen ~`0014`); ORM imported only by the dead cluster; no live use; no live FK → **eventual cleanup candidates (separately approved)**

| Table | Original model | Created by | Used by current code | FK refs (live) | Modified by current migrations | Could hold historical records | Overlaps current functionality |
|---|---|---|---|---|---|---|---|
| `flights`, `hotels`, `cruises`, `tour_packages` | `travel.py` | `0001` (+`0004`/`0012` early alters) | No (dead cluster only) | none live | No (frozen after ~`0012`) | **Yes** (original catalogue) | superseded by `customer_hotels`/`customer_packages`/`customer_destinations` + Duffel search |
| `bookings` | `booking.py:Booking` | `0001` (+`0004`/`0013`) | No | none live | No | Yes | superseded by `customer_bookings` (B2C) / `service_requests` (B2B) |
| `reviews` | `misc.py:Review` | `0001` | No | none live | No | Yes | superseded by `customer_reviews` |
| `wishlist` | `misc.py:Wishlist` | `0001` | No | none live | No | Yes | superseded by `customer_wishlist` |
| `notifications` | `misc.py:Notification` | `0001` | No | none live | No | Yes | superseded by `customer_notifications` |
| `support_tickets` | `misc.py:SupportTicket` | `0008` (+`0011`) | No | none live | No | Yes | superseded by `customer_support_tickets` |
| `coupons`, `seasonal_prices`, `discount_campaigns` | `pricing.py` | `0014` | No (dead cluster only) | none live | No | Yes | superseded by `customer_coupons` + `customer_pricing_service` |
| `contact_us`, `newsletter` | `misc.py` | `0001` | No | none live | No | Yes | landing-site enquiries (now emailed) |
| `activity_logs`, `user_sessions` | `misc.py` | `0001` / `0009` | No | none live | No | Yes | superseded by `customer_activity` / `customer_sessions` + `users.permissions`/sessions |

## 4. Unused-in-code vs empty-in-database [REPO-VERIFIED / LIVE]

- **[REPO-VERIFIED] Unused in application code:** every legacy `app/models/` ORM class (Classes A/B/C) — no live import.
- **[REPO-VERIFIED] But the TABLES are not uniformly unused:** Class A (partner portal) and Class B (`users`/`payments`) are **actively used at runtime** (via `sp_*` / `models_v2`). Class C has **no live reader**.
- **[LIVE] Emptiness is unknown from the repo.** The production DB has applied `0001`→`0095`, so every Class-C table **exists**; whether it holds rows (historical records from the original app era, ~first launch through the redesign) must be checked read-only (`SELECT count(*)`, `max(created_at)`). Do not assume empty.

## 5. No shared tables; no cross-coupling [REPO-VERIFIED]

- **No live (non-legacy) model declares a ForeignKey into any Class-C v1 table** — nothing current is referentially coupled to them.
- Class C tables are **separate objects** from the current B2B/B2C tables they functionally resemble (e.g., `reviews` ≠ `customer_reviews`); there is **no shared table** and **no B2B↔B2C data mixing**.

## 6. Recommendations

**Preserve historical data (before anything):**
1. **[LIVE, read-only]** Row-count + newest-timestamp every Class-C table; export/archive any with rows (e.g., `pg_dump -t` to secured storage) **before** considering removal. Keep the archive regardless of the cleanup decision.
2. **Never touch Class A or Class B tables** — they are live (partner portal via `sp_*`; B2B `users`/`payments`). Dropping them would break the partner portal / auth.
3. **Keep the partner-portal schema (raw-SQL bootstrap) as-is** — it holds live operational data and is managed outside Alembic; document this second regime rather than "fixing" it.

**Eventual, separately-approved cleanup candidates (Class C only):**
- After archive + an owner-approved decision: the orphaned v1 monolith tables (`flights`, `hotels`, `cruises`, `tour_packages`, `bookings`, `reviews`, `wishlist`, `notifications`, `support_tickets`, `coupons`, `seasonal_prices`, `discount_campaigns`, `contact_us`, `newsletter`, `activity_logs`, `user_sessions`, `roles`) and their dead ORM models + the dead 6-service cluster.
- **Sequencing:** remove the **dead ORM code first** (a code-only PR, no table change), confirm nothing breaks, then — much later, separately approved, after the live archive — drop the tables via a dedicated migration. **Do not bundle this with Stage-3 staging.**

**Resolve before any model removal:**
- **[LIVE/UNRESOLVED]** the `users` / `payments` / `service_requests` collision: confirm on the live catalog which physical object each live path uses (`models_v2` vs partner SQL) so the stale `app/models` **mappings** can be removed without risk to the **tables**.

**Unaffected / standing:** Gaming Tour Packages remain disabled (`gaming_tour_enquiries` is a B2B `models_v2` table, not part of this legacy layer; retain it and its rows).

## 7. Repository-verified vs live-DB

- **[REPO-VERIFIED]:** ORM import map; creating migrations (`0001`/`0008`/`0009`/`0014`) / partner-SQL bootstrap source; the dead-cluster isolation; live `sp_*` usage by partner services; no live FK into Class-C tables; no current migration modifies Class-C tables (frozen ~`0014`); `0023` does not drop/recreate `users`/`payments`.
- **[LIVE]:** row counts / emptiness of every legacy table; which physical object the collision names resolve to; whether any out-of-band SQL altered them.

---

**This report changed nothing** — read-only; no DB connection, no SQL, no migrations, no table/data change, no app-code change, no deploy/commit; no B2B/B2C data merged. Gaming Tour Packages remain disabled.

**Document created:** `docs/LEGACY_DATABASE_TABLE_USAGE_AND_PRESERVATION_REPORT.md`.
