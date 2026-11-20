# B2B / B2C **Logical** Separation Plan — Single PostgreSQL Database

**Project:** JackPots World Tours & Travels
**Date:** 2026-11-12
**Status:** **PLANNING ONLY.** No code, config, DB table, migration, or git change has been made or will be made under this document.
**Decision (final, current):** **Keep ONE PostgreSQL database. Separate B2B and B2C completely *within* it — logically, not physically.**

**Supersedes the physical-split documents:**
- `docs/B2C_DATABASE_SEPARATION_PLAN.md` (two physical DBs) — **superseded**
- `docs/STAGE_A_FILE_LEVEL_SPEC.md` (customer_session/alembic_customer/cutover) — **partly superseded** (see §6)
- `docs/STAGE_B_DB_VERIFICATION_REPORT.md` — **reframed** (single-DB integrity scan; see §7)

**Evidence tags:** **[SRC-V]** source-code verified (repo path) · **[NV]** not verified — needs a read-only live-DB query (Stage B).

---

## 1. What changed, and what it means

| Previously proposed (physical split) | Now |
|---|---|
| New physical B2C PostgreSQL database | **Dropped.** One database stays. |
| `CUSTOMER_DATABASE_URL` mandatory independent connection | **Dropped.** One `DATABASE_URL`. |
| Separate B2C engine (`customer_engine`) | **Dropped.** One engine. |
| Separate B2C session factory (`CustomerSessionLocal` / `get_customer_db`) | **Dropped.** One `SessionLocal` / `get_db`. |
| Separate B2C Alembic history (`alembic_customer/`) | **Dropped.** One `alembic/` history. |
| Physical migration of `customer_*` to another DB | **Dropped.** No data moves. |
| Database cutover + physical rollback + maintenance window + logical replication | **Dropped.** No cutover. |

**Kept as the new goal — logical separation inside one DB:**
1. Separate SQLAlchemy model ownership (two `DeclarativeBase`s) — **already true** [SRC-V].
2. Business-specific repositories/services — **already largely true** [SRC-V].
3. Correct API → table mapping — see §4/§5.
4. Environment-specific permissions (B2B vs B2C) — §3.
5. Separate B2B and B2C audit records — §3 (the one surviving Stage-A build item).
6. Protection against accidental cross-business data access — §3 (guard + CI check).

**The key architectural insight:** B2B (`models_v2.Base`) and B2C (`models_customer.Base`) already live on **two independent metadatas bound to the same engine**, with **no cross-`Base` foreign keys** [SRC-V]. The logical separation the new decision asks for is therefore **mostly already present in the schema**; the remaining work is *enforcement and audit*, not restructuring.

---

## 2. Revised architecture (one DB, two logical domains)

```
                    ┌──────────────────────────────────────────┐
                    │        Unified Admin Portal (SPA)         │
                    │   B2B environment ⇄ B2C environment        │
                    │   B2B sidebar          B2C sidebar         │
                    └───────┬────────────────────────┬──────────┘
                            │ one admin login (B2B identity in `users`)
             ┌──────────────▼─────────┐   ┌───────────▼───────────────┐
   B2B domain │ routers/services       │   │ customer_* routers/services│ B2C domain
             │ models_v2.* (Base A)    │   │ models_customer.* (Base B) │
             └──────────────┬─────────┘   └───────────┬───────────────┘
                            │        one get_db        │
                            └────────────┬─────────────┘
                                         ▼
                           ┌────────────────────────────┐
                           │  ONE PostgreSQL database     │
                           │  26 B2B tables (models_v2)   │
                           │  47 B2C tables (models_customer; 46 customer_* + payment_provider_events)
                           │  39 legacy tables (app/models, quarantined — see §5)
                           │  one alembic/ history (alembic_version)
                           │  NO cross-Base FK  ·  NO shared operational tables
                           └────────────────────────────┘
```

- **One engine, one `SessionLocal`, one `get_db`** (unchanged from today).
- **Two model domains** kept apart by their own `Base` metadata, their own service modules, and (new) a cross-access guard.
- **Legacy `app/models/` stays in place, untouched** — not deleted, not renamed (§5).

---

## 3. The logical-separation work (the only real changes, all deferred to implementation)

All items below are **proposals for a later, separately-approved implementation**. Nothing is built here.

### 3.1 Model ownership — already satisfied [SRC-V]
`models_v2.py` declares `class Base(DeclarativeBase)` (Base A) [SRC-V `models_v2.py:41`]; `models_customer.py` declares its own `Base` (Base B) [SRC-V `models_customer.py`]. They never share a metadata, and no FK crosses between them [SRC-V — confirmed by prior trace]. **No change required** beyond keeping them distinct.

### 3.2 Repositories / services — already largely satisfied [SRC-V]
B2C logic lives in `customer_*` services; B2B logic in the B2B services. The six legacy services form a closed dead cluster (§5). **Proposed hardening:** document the boundary; optionally introduce a thin repository layer so no service reaches across domains.

### 3.3 Environment-specific permissions (NEW, proposed)
- One admin login against B2B `users` (JSONB permissions array) [SRC-V `auth/deps.py`].
- Add explicit **B2B vs B2C permission scopes** so a B2B-only admin cannot invoke B2C-admin endpoints and vice versa. Enforced in `auth/rbac.py` / `auth/deps.py`. The Admin Portal environment selector (§ below) maps to these scopes.

### 3.4 Separate audit records (NEW, proposed — the surviving Stage-A item)
- Keep `audit_logs` (B2B) and `customer_audit_logs` (B2C customer self-service) as they are [SRC-V].
- **Add `customer_admin_audit_logs`** on the B2C `Base` for *administrator actions on B2C data*, with an admin identity **snapshot** (no cross-domain FK needed — but here it is simply a same-DB table with no FK to `users`, by design, to keep the domains decoupled). This replaces the current cross-domain write where `admin_cancellations._audit()` writes B2B `audit_logs` while operating on B2C tables [SRC-V `routers/admin_cancellations.py:77`].
- Since there is one DB, this table ships as an ordinary additive migration in the **existing** `alembic/` history (no `alembic_customer/`).

### 3.5 Cross-business access protection (NEW, proposed)
- **CI/static guard:** assert that B2C routers only import/touch `models_customer` and B2C services; B2B routers only `models_v2`; no module imports across the boundary except the deliberate admin-portal seam. Fold into `tests/verify_customer_portal.py` (adapted — **drop** the old "distinct engine URL" assertion; it no longer applies to one DB).
- **No cross-`Base` FK** remains an invariant, now checked within the single DB.
- **Runtime:** B2C-admin endpoints authenticate on B2B identity, then operate on `customer_*` via the same `get_db` session — logically scoped by the models/services they call, not by a second engine.

### 3.6 Admin Portal (preserve, §6 of your brief)
One unified SPA with a **B2B environment selector + B2B sidebar** and a **B2C environment selector + B2C sidebar**; both read/write the same database but each environment is wired to its own domain's endpoints/models. No change to the single-DB wiring; the separation is in the API scopes (§3.3) and the model domains.

---

## 4. API → domain mapping (router registration verified in `main.py`) [SRC-V]

**B2C domain routers** (operate on `models_customer`): `customer_auth`, `customer_profile`, `customer_account`, `customer_recommendations`, `customer_travellers`, `customer_bookings`, `customer_hotel_bookings`, `customer_package_bookings`, `customer_cancellations`, `customer_payment_admin`, `customer_destinations`, `customer_assistant`, `customer_chat`, `admin_chat`, `customer_admin`, `admin_customer_bookings`, `admin_cancellations`, `admin_reconciliation`, `admin_reviews`, `admin_communication`, `admin_user_activity`, `admin_b2c_reports`, `admin_catalogue(+hotels/packages/destinations)`, `eticket` (owner/public).

**B2B domain routers** (operate on `models_v2`): `auth`, `super_admin`, `merchants`, `merchant_team`, `merchant_approvals`, `manager`, `manager_approvals`, `tickets`, `enquiries`, `hotel_enquiries`, `tour_package_enquiries`, `group_bookings`, `profile`, `dashboard`, `reports`, `notifications_v2`, `admin_ops`, `support_tickets`, `documents`, `passport_ocr`, `booking_ops`, `change_requests`, `finance`, `wallet`, `payment_admin`, `providers`, `messages`, `analytics`, `assistant`.

**Confirm per-endpoint before enforcing the guard [NV/§8]:** `payment_webhooks`, `payment_returns` (provider callbacks may touch both B2B `payments` and B2C `payment_provider_events`/`customer_*_payments`), `gaming_tour_enquiries` (B2B `models_v2.GamingTourEnquiry`, stays B2B, gated off), `public` (static/landing).

---

## 5. COMPLETE table ownership inventory

Classification: **B2B** · **B2C** · **Shared-infra** · **Legacy/unused** (dead at code level) · **Confirm** (needs Stage B read-only data check). Per your instruction, **no legacy table is assumed safe to delete** — every legacy entry is *at most* "Legacy/unused (code), data existence = Confirm".

### 5.1 B2B operational — `models_v2.py` (Base A) · 26 tables · all LIVE [SRC-V]

| Table | Business | Model | Used By (service/router) | API | Status |
|---|---|---|---|---|---|
| merchants | B2B | models_v2.Merchant | merchant/admin services | `/api/merchants`, admin | B2B live |
| users | B2B | models_v2.User | auth/deps, all B2B | `/api/auth`, admin | B2B live **(name also mapped by dead legacy `user.py` — same physical table)** |
| service_requests | B2B | models_v2.ServiceRequest | booking_ops, tickets, change_requests | `/api/tickets`, `/api/booking-ops` | B2B live **(name also mapped by dead legacy `partner_service_request.py`)** |
| payments | B2B | models_v2.Payment | payment_admin, finance | `/api/payment-admin`, `/api/finance` | B2B live **(name also mapped by dead legacy `booking.py`)** |
| passenger_data | B2B | models_v2.PassengerData | booking/ticket services | booking-ops | B2B live |
| communication_settings | B2B | models_v2.CommunicationSettings | admin_ops/communication | admin | B2B live |
| merchant_service_access | B2B | models_v2.MerchantServiceAccess | merchant_team | `/api/merchant-team` | B2B live |
| msg_logs | B2B | models_v2 | messages | `/api/messages` | B2B live |
| system_logs | B2B | models_v2 | admin_ops | admin | B2B live |
| audit_logs | B2B | models_v2 | audit_service | admin | B2B live |
| request_documents | B2B | models_v2 | documents | `/api/documents` | B2B live |
| group_booking_imports | B2B | models_v2 | group_bookings | `/api/group-bookings` | B2B live |
| request_notes | B2B | models_v2 | booking_ops/tickets | booking-ops | B2B live |
| payment_accounts | B2B | models_v2 | wallet/finance | `/api/wallet` | B2B live |
| wallet_topups | B2B | models_v2 | wallet | `/api/wallet` | B2B live |
| wallet_transactions | B2B | models_v2 | wallet | `/api/wallet` | B2B live |
| providers | B2B | models_v2 | providers | `/api/providers` | B2B live |
| provider_users | B2B | models_v2 | providers | `/api/providers` | B2B live |
| hotel_enquiries | B2B | models_v2 | hotel_enquiries | `/api/hotel-enquiries` | B2B live |
| hotel_enquiry_rooms | B2B | models_v2 | hotel_enquiries | hotel-enquiries | B2B live |
| hotel_room_children | B2B | models_v2 | hotel_enquiries | hotel-enquiries | B2B live |
| gaming_tour_enquiries | B2B | models_v2.GamingTourEnquiry | gaming_tour_enquiries | gated OFF | B2B live, **disabled** |
| tour_package_enquiries | B2B | models_v2 | tour_package_enquiries | `/api/tour-package-enquiries` | B2B live |
| hotel_booking_guests | B2B | models_v2 | hotel booking services | booking-ops | B2B live |
| passport_ocr_extractions | B2B | models_v2 | passport_ocr | `/api/passport-ocr` | B2B live |
| passport_ocr_field_edits | B2B | models_v2 | passport_ocr | `/api/passport-ocr` | B2B live |

### 5.2 B2C operational — `models_customer.py` (Base B) · 47 tables · all LIVE [SRC-V]

46 `customer_*`-prefixed + `payment_provider_events`. (Correction to earlier "~47 customer_* plus ppe": it is **46 prefixed + 1** = 47 on the B2C Base.)

| Table | Business | Model | Used By | API | Status |
|---|---|---|---|---|---|
| customers | B2C | models_customer.Customer | customer_auth_service | `/api/customer/auth` | B2C live |
| customer_auth | B2C | models_customer | customer_auth_service | customer auth | B2C live |
| customer_identities | B2C | models_customer | account services | customer_account | B2C live |
| customer_profiles | B2C | models_customer | customer_profile | customer_profile | B2C live |
| customer_sessions | B2C | models_customer | customer_auth_service | customer auth | B2C live |
| customer_otps | B2C | models_customer | otp/customer_auth | customer auth | B2C live |
| customer_password_resets | B2C | models_customer | customer_auth_service | customer auth | B2C live |
| customer_audit_logs | B2C | models_customer | customer audit | (self-service trail) | B2C live |
| customer_travellers | B2C | models_customer | customer_travellers | customer_travellers | B2C live |
| customer_bookings | B2C | models_customer | customer_booking_service | customer_bookings | B2C live |
| customer_booking_passengers | B2C | models_customer | booking service | customer_bookings | B2C live |
| customer_booking_addons | B2C | models_customer | booking service | customer_bookings | B2C live |
| customer_booking_payments | B2C | models_customer | payment services | customer_bookings | B2C live |
| customer_cancellation_requests | B2C | models_customer | customer_cancellation_admin_service | customer/admin cancellations | B2C live |
| customer_refund_attempts | B2C | models_customer | customer_refund_service | admin_cancellations | B2C live |
| customer_coupons | B2C | models_customer | customer_pricing_service | customer_bookings | B2C live |
| customer_wishlist | B2C | models_customer | account/recommendations | customer_account | B2C live |
| customer_notifications | B2C | models_customer | notification services | customer | B2C live |
| customer_reviews | B2C | models_customer | admin_reviews | admin_reviews | B2C live |
| customer_support_tickets | B2C | models_customer | support services | customer | B2C live |
| customer_support_messages | B2C | models_customer | support services | customer | B2C live |
| customer_hotels | B2C | models_customer | customer_hotel_catalog_service | customer_hotel_bookings, admin_catalogue_hotels | B2C live |
| customer_hotel_rooms | B2C | models_customer | hotel catalog service | customer_hotel_bookings | B2C live |
| customer_hotel_bookings | B2C | models_customer | customer_hotel_booking_service | customer_hotel_bookings | B2C live |
| customer_hotel_booking_rooms | B2C | models_customer | hotel booking service | customer_hotel_bookings | B2C live |
| customer_hotel_booking_guests | B2C | models_customer | hotel booking service | customer_hotel_bookings | B2C live |
| customer_hotel_booking_addons | B2C | models_customer | hotel booking service | customer_hotel_bookings | B2C live |
| customer_hotel_booking_payments | B2C | models_customer | payment services | customer_hotel_bookings | B2C live |
| customer_destinations | B2C | models_customer | customer catalog services | customer_destinations, admin_catalogue_destinations | B2C live |
| customer_locations | B2C | models_customer | catalog services | customer_destinations | B2C live |
| customer_assistant_sessions | B2C | models_customer | assistant service | customer_assistant | B2C live |
| customer_assistant_messages | B2C | models_customer | assistant service | customer_assistant | B2C live |
| customer_attractions | B2C | models_customer | catalog services | customer_destinations | B2C live |
| customer_packages | B2C | models_customer | customer_package_catalog_service | customer_package_bookings, admin_catalogue_packages | B2C live |
| customer_package_itinerary | B2C | models_customer | package catalog service | customer_package_bookings | B2C live |
| customer_package_hotels | B2C | models_customer | package catalog service | customer_package_bookings | B2C live |
| customer_package_departures | B2C | models_customer | package catalog service | customer_package_bookings | B2C live |
| customer_package_bookings | B2C | models_customer | customer_package_booking_service | customer_package_bookings | B2C live |
| customer_package_booking_travellers | B2C | models_customer | package booking service | customer_package_bookings | B2C live |
| customer_package_booking_addons | B2C | models_customer | package booking service | customer_package_bookings | B2C live |
| customer_package_booking_payments | B2C | models_customer | payment services | customer_package_bookings | B2C live |
| payment_provider_events | **B2C** | models_customer | payment_event_service, trustbrick_provider, customer_payment_admin_service, payment_verification_service | customer_payment_admin, admin_reconciliation | B2C live **(no B2B writer in source; confirm row ownership in Stage B)** |
| customer_conversations | B2C | models_customer | chat_service | customer_chat, admin_chat | B2C live |
| customer_chat_messages | B2C | models_customer | chat_service | customer_chat | B2C live |
| customer_chat_attachments | B2C | models_customer | chat_service | customer_chat | B2C live |
| customer_calls | B2C | models_customer | call_handlers | customer_assistant | B2C live |
| customer_activity | B2C | models_customer | admin_user_activity | admin_user_activity | B2C live |

### 5.3 Legacy — `app/models/` (Base C) · 39 mappings · DEAD at code level [SRC-V]

Imported **only** by the six dead services (`pricing_service, catalog_items, booking_management_service, admin_service, payment_management_service, inventory_service`), which import each other and nothing else imports them; the only live importer of `app/models` is `alembic/env.py` (metadata registration). **Do not delete — data existence per table is "Confirm" via Stage B.**

| Table | Model file | Note | Status |
|---|---|---|---|
| users | user.py | **duplicate name** of live B2B `users` → same physical table; legacy mapper dead | Legacy mapper dead / table is B2B-live |
| payments | booking.py | **duplicate name** of live B2B `payments` → same physical table; legacy mapper dead | Legacy mapper dead / table is B2B-live |
| service_requests | partner_service_request.py | **duplicate name** of live B2B `service_requests`; legacy mapper has **zero importers** repo-wide | Legacy mapper dead / table is B2B-live |
| roles | user.py | RBAC v1 (B2B uses JSONB permissions on `users`) | Legacy/unused · Confirm data |
| permissions | reference.py | RBAC v1, unused | Legacy/unused · Confirm data |
| role_permissions | reference.py | RBAC v1, unused | Legacy/unused · Confirm data |
| flights | travel.py | v1 catalogue; B2C searches live supplier (Duffel) | Legacy/unused · Confirm data |
| hotels | travel.py | v1 catalogue; B2C uses `customer_hotels` | Legacy/unused · Confirm data |
| cruises | travel.py | v1 catalogue; no live equivalent | Legacy/unused · Confirm data |
| tour_packages | travel.py | v1 catalogue; B2C uses `customer_packages` | Legacy/unused · Confirm data |
| coupons | pricing.py | v1 pricing; B2C uses `customer_coupons` | Legacy/unused · Confirm data |
| seasonal_prices | pricing.py | v1 pricing | Legacy/unused · Confirm data |
| discount_campaigns | pricing.py | v1 pricing | Legacy/unused · Confirm data |
| ancillary_service_catalog | reference.py | v1 reference | Legacy/unused · Confirm data |
| countries | reference.py | v1 reference | Legacy/unused · Confirm data |
| bookings | booking.py | v1 bookings; B2B uses `service_requests`, B2C uses `customer_bookings` | Legacy/unused · Confirm data |
| contact_us | misc.py | v1 landing form | Legacy/unused · Confirm data |
| newsletter | misc.py | v1 newsletter | Legacy/unused · Confirm data |
| reviews | misc.py | v1 reviews; B2C uses `customer_reviews` | Legacy/unused · Confirm data |
| wishlist | misc.py | v1; B2C uses `customer_wishlist` | Legacy/unused · Confirm data |
| notifications | misc.py | v1; B2C uses `customer_notifications` | Legacy/unused · Confirm data |
| activity_logs | misc.py | v1; B2C uses `customer_activity` | Legacy/unused · Confirm data |
| user_sessions | misc.py | v1; B2C uses `customer_sessions` | Legacy/unused · Confirm data |
| support_tickets | misc.py | v1; live B2B uses `service_requests`, B2C uses `customer_support_tickets` | Legacy/unused · Confirm data |
| partners | partner.py | v1 partner portal | Legacy/unused · Confirm data |
| partner_users | partner.py | v1 partner portal | Legacy/unused · Confirm data |
| partner_otp_requests | partner.py | v1 partner portal | Legacy/unused · Confirm data |
| partner_payments | partner_misc.py | v1 | Legacy/unused · Confirm data |
| report_generation_log | partner_misc.py | v1 | Legacy/unused · Confirm data |
| partner_notifications | partner_misc.py | v1 | Legacy/unused · Confirm data |
| partner_audit_logs | partner_misc.py | v1 | Legacy/unused · Confirm data |
| booking_reference_counters | partner_booking.py | v1 | Legacy/unused · Confirm data |
| partner_bookings | partner_booking.py | v1 | Legacy/unused · Confirm data |
| partner_booking_passengers | partner_booking.py | v1 | Legacy/unused · Confirm data |
| cancellation_requests | partner_service_request.py | v1 | Legacy/unused · Confirm data |
| cancellation_request_passengers | partner_service_request.py | v1 | Legacy/unused · Confirm data |
| date_change_requests | partner_service_request.py | v1 | Legacy/unused · Confirm data |
| refund_requests | partner_service_request.py | v1 | Legacy/unused · Confirm data |
| passenger_modification_requests | partner_service_request.py | v1 | Legacy/unused · Confirm data |

### 5.4 Shared infrastructure

| Table | Business | Note | Status |
|---|---|---|---|
| alembic_version | Shared-infra | One migration-version table for the single `alembic/` history | Shared-infra |

> There are **no shared operational tables**: B2B and B2C each own their rows; `payment_provider_events` is B2C-owned (not shared). **Avoiding duplication:** the only name collisions (`users`, `payments`, `service_requests`) are dead legacy mappers over existing B2B tables — no new duplicate tables are introduced by this plan.

### 5.5 Inventory totals
- **B2B live:** 26 · **B2C live:** 47 (46 `customer_*` + `payment_provider_events`) · **Legacy mappings:** 39 (36 legacy-only physical tables + 3 dead mappers over B2B tables) · **Shared-infra:** 1 (`alembic_version`).
- **Distinct physical tables (code-derived):** ≈ 26 + 47 + 36 + 1 = **110**. Exact live-DB table list = **[NV]** (Stage B §8).

---

## 6. Revised Stage A (what survives, what is dropped)

**Dropped entirely** (physical-split only): `backend/app/database/customer_session.py`, `customer_engine`, `CustomerSessionLocal`, `get_customer_db`, `customer_database_url`/`effective_customer_database_url`/pool keys, `alembic_customer.ini`, `alembic_customer/`, the baseline-from-dump, every `get_db`→`get_customer_db` router swap, the two-session admin pattern, and all of Stage A §6/§7 data migration + cutover + rollback.

**Survives, re-scoped to one DB:**
- `CustomerAdminAuditLog` + `customer_admin_audit_logs` (Stage A §4) → shipped as an **ordinary additive migration in the existing `alembic/`**.
- Router domain classification (Stage A §2.4 / §4 here) → used for the **access guard and admin-portal scopes**, not for session swaps.
- `verify_customer_portal.py` boundary assertions (Stage A §8) → keep router-ownership + no-cross-`Base`-FK checks; **drop** the "distinct engine URL" check.
- Gaming fail-closed flag (unchanged; stays disabled until you authorize).

---

## 7. Revised Stage B (read-only verification — still needed, reframed)

Stage B is **still valuable** for a single DB — to confirm integrity and to classify the legacy tables' *data* before any future retirement — but it is no longer sizing a physical move.

- The read-only queries in `docs/stage-b/01_stage_b_readonly_queries.sql` apply **unchanged** (row counts, FK integrity, orphans, duplicates, enums, sequences, indexes, `payment_provider_events` distribution, legacy recent-write scan).
- The **access prerequisites are unchanged**: a least-privilege read-only role (`docs/stage-b/00_create_readonly_role.sql`) and a confirmed target DB. No read-only account exists yet; the only credential is the `postgres` superuser [SRC-V]. **Still halted on that.**
- What Stage B now informs: (a) legacy-table data existence → the retirement workstream; (b) current integrity baseline; **not** a migration manifest.

---

## 8. Open items needing your confirmation (planning)

1. **Per-endpoint domain review** of `payment_webhooks`, `payment_returns`, `eticket`, `public`, `gaming_tour_enquiries` before enforcing the cross-access guard (do any touch both domains?). [NV]
2. **Audit table shape:** dedicated `customer_admin_audit_logs` (recommended) vs. extending `customer_audit_logs`.
3. **Permission model:** confirm B2B vs B2C admin scopes and how the Admin Portal selector maps to them.
4. **Stage B target DB + read-only account** (unchanged blocker).
5. **Legacy data:** confirm (Stage B) before any retirement proposal — nothing deleted now.

---

## 9. Preservation & restriction confirmation

Preserved (by design, no change): B2B merchant operations · B2C customer operations · HDFC gateway · TrustBrick pilot routing · Duffel · booking & refund workflows · customer authentication. Gaming Packages remain **disabled** until you authorize. **One database only — no second database created or proposed.**

No code modified · no configuration modified · no database table/object created or altered · no migration generated or run · no data moved · no git action · no deploy · no payment/refund initiated · no legacy model/table/record removed or renamed. **This document is planning text only.**

**Awaiting your approval of this revised single-database logical-separation architecture and the table ownership mapping before any implementation step.**
