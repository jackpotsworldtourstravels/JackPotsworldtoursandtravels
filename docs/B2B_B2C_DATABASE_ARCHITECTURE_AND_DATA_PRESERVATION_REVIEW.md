# B2B / B2C Database Architecture & Data-Preservation Review

**Project:** JackPots World Tours & Travels · **Approved architecture:** ONE PostgreSQL database, logically separated B2B and B2C models/tables.
**Date:** 2026-11-13
**Nature:** READ-ONLY. No PostgreSQL connection, no SQL, no migrations, no data change, no app-code change, no deploy/commit. Gaming disabled.

**Labels:** **[REPO-VERIFIED]** from source (file cited) · **[LIVE]** requires live-DB inspection (row data / deployed state).

**Inspected:** `backend/app/models_v2.py` (B2B Base), `backend/app/models_customer.py` (B2C Base), legacy `backend/app/models/` (v1), `backend/app/database/session.py`, `backend/alembic/env.py` + `alembic/versions/*`, `database/*.sql`, `backend/db/*`, B2B & B2C routers/services.

> **Naming note:** this repo keeps the two model layers as **single files** `models_v2.py` and `models_customer.py` (not directories). They declare **separate `DeclarativeBase`s**, which is what makes B2B and B2C logically independent.

---

## 1. Database architecture [REPO-VERIFIED]

- **One PostgreSQL database** — a single `database_url` (`backend/app/config.py`); no second DB URL.
- **One runtime engine / session factory / `get_db`** — `backend/app/database/session.py` (`engine`, `SessionLocal`, `get_db`). Alembic uses its own short-lived NullPool engine via `settings.alembic_url` (`env.py`) — not a second app engine.
- **Two model Bases** — `models_v2.Base` (B2B) and `models_customer.Base` (B2C); legacy `app/models` is a third (v1) Base, dead (see §4).
- **One Alembic history** — single linear chain, head `0095_customer_admin_audit_logs`.
- **Schema layout:** **one `public` schema, two separate table SETS** — there are **no separate PostgreSQL schemas** ([REPO-VERIFIED]: no `CREATE SCHEMA` in any migration; all objects unqualified → `public`). B2B tables and B2C `customer_*` tables coexist in `public`, kept apart by name prefix and by the separate Bases.

```
                         ONE PostgreSQL database  (schema: public)
   ┌───────────────────────────────────────┬───────────────────────────────────────┐
   │ B2B table set  (models_v2.Base)        │ B2C table set  (models_customer.Base)  │
   │ 26 tables: merchants, users,           │ 48 tables: customers, customer_*,      │
   │ service_requests, payments, wallet_*,  │ payment_provider_events,               │
   │ providers, *_enquiries, passport_ocr_* │ customer_admin_audit_logs              │
   │  ▲ no FK crosses the line ▼            │  ▲ self-contained FK island ▼          │
   └───────────────────────────────────────┴───────────────────────────────────────┘
        one engine / SessionLocal / get_db  (runtime: DATABASE_URL)
        one Alembic history (head 0095; Alembic: MIGRATION_DATABASE_URL)
   (legacy app/models v1 tables also live in public but are DEAD — §4)
```

## 2. B2B table inventory (`models_v2.py`, 26 tables) [REPO-VERIFIED]

PK pattern: single-column `BigInteger` surrogate (serial/identity). Full columns are defined in `models_v2.py`; key relationships below.

| Table | PK | Key FKs / relationships | Feature area |
|---|---|---|---|
| `merchants` | merchant_id | — (root of the merchant/partner tree) | Merchant accounts |
| `users` | user_id | → `merchants` (merchant staff) | Admin/merchant staff + RBAC (`users.permissions` JSONB) |
| `service_requests` | id | → `merchants`, `users` | B2B booking enquiries/requests/approvals |
| `payments` | id | → `service_requests` | B2B payments |
| `passenger_data` | id | → `service_requests` | Passengers on B2B bookings |
| `communication_settings` | id | → `merchants` | B2B comms config |
| `merchant_service_access` | id | → `merchants` | Service access toggles |
| `msg_logs` / `system_logs` / `audit_logs` | id | (actor/user refs) | B2B logging / Super-Admin audit (`fn_write_audit_log`) |
| `request_documents` / `request_notes` | id | → `service_requests` | Docs/notes on requests |
| `group_booking_imports` | id | → `service_requests` | Group import |
| `payment_accounts` / `wallet_topups` / `wallet_transactions` | id | → `merchants` / `payment_accounts` | B2B wallet ledger |
| `providers` / `provider_users` | id | `provider_users` → `providers` | Supplier/provider mgmt |
| `hotel_enquiries` / `hotel_enquiry_rooms` / `hotel_room_children` / `hotel_booking_guests` | id | rooms → enquiries | B2B hotel enquiry capture |
| `tour_package_enquiries` | id | plain `customer_name` column (no FK to customers) | B2B tour-package enquiries |
| `gaming_tour_enquiries` | id | plain `customer_name` column (no FK) | **Gaming** enquiry queue — **disabled** feature |
| `passport_ocr_extractions` / `passport_ocr_field_edits` | id | → `request_documents` | Passport OCR |

**Note:** the `*_enquiries` rows deliberately store `customer_name` as plain text, **not** a FK to `customers` [REPO-VERIFIED `models_v2.py`] — so no B2B table references the B2C `customers` table.

## 3. B2C table inventory (`models_customer.py`, 48 tables) [REPO-VERIFIED]

PK pattern: single-column `BigInteger`. **Self-contained FK island** — every FK targets another `customer_*` table or `customers`; **none targets a B2B table** [REPO-VERIFIED].

| Group | Tables | Feature |
|---|---|---|
| Identity & auth | `customers`, `customer_auth`, `customer_identities`, `customer_profiles`, `customer_sessions`, `customer_otps`, `customer_password_resets`, `customer_audit_logs` | Customer accounts, passwordless/OTP sign-in, the customer's own audit trail |
| Travellers & flight bookings | `customer_travellers`, `customer_bookings`, `customer_booking_passengers`, `customer_booking_addons`, `customer_booking_payments`, `customer_cancellation_requests`, `customer_refund_attempts` | Flight booking + cancellation/refund |
| Hotels | `customer_hotels`, `customer_hotel_rooms`, `customer_hotel_bookings`, `customer_hotel_booking_rooms`, `customer_hotel_booking_guests`, `customer_hotel_booking_addons`, `customer_hotel_booking_payments` | Hotel catalogue + booking |
| Packages | `customer_packages`, `customer_package_itinerary`, `customer_package_hotels`, `customer_package_departures`, `customer_package_bookings`, `customer_package_booking_travellers`, `customer_package_booking_addons`, `customer_package_booking_payments` | Holiday packages |
| Content / geo / assistant | `customer_destinations`, `customer_locations`, `customer_attractions`, `customer_assistant_sessions`, `customer_assistant_messages` | Destinations, AI assistant |
| Chat / calls / activity | `customer_conversations`, `customer_chat_messages`, `customer_chat_attachments`, `customer_calls`, `customer_activity` | Live chat / WiFi calling / activity |
| Support & commerce | `customer_support_tickets`, `customer_support_messages`, `customer_reviews`, `customer_wishlist`, `customer_notifications`, `customer_coupons` | Support, reviews, wishlist, notifications, coupons |
| Payments / audit | `payment_provider_events`, `customer_admin_audit_logs` | Provider webhook/events; **B2C admin audit (append-only, `0095`)** |

## 4. Shared table inventory & legacy layer

- **Genuinely shared OPERATIONAL tables between B2B and B2C: NONE.** [REPO-VERIFIED — `comm` of the two Bases' table-name sets is empty; no overlap.] The only thing B2B and B2C share is the **physical database and the `public` schema**.
- **Name collisions are NOT B2B↔B2C overlap.** `users`, `payments`, `service_requests` exist in **both `models_v2` (B2B, live) and the legacy `app/models` (v1)** — a B2B-internal duplication. The **legacy `app/models` layer is dead** (its services `admin_service`/`booking_management_service`/`catalog_items`/`pricing_service`/`payment_management_service`/`inventory_service` are imported by no router/main/script/test — [REPO-VERIFIED earlier in this project's audit]). Legacy tables (`bookings`, `reviews`, `wishlist`, `notifications`, `support_tickets`, `flights`, `hotels`, `tour_packages`, `cruises`, `coupons`, `seasonal_prices`, `discount_campaigns`, `partners`, …) are a pre-redesign set, **not** the current B2C store and **not** referenced by live B2C code.

## 5. Existing vs newly introduced tables (B2C) [REPO-VERIFIED]

- The **current B2C implementation uses NEW tables** — the `customer_*` island — **introduced from migration `0044` onward**, not a reuse of the legacy general tables (`bookings`/`reviews`/etc.). The names are distinct, so the two sets never collide and the customer migrations never touch the legacy tables.
- **No "older B2C" customer_* tables were replaced:** each customer migration **creates** its tables (upgrade) and **drops** them only on **downgrade** (standard Alembic reverse) — confirmed the `drop_table("customer…")` calls are all inside `downgrade()`, mirroring the `create_table` in `upgrade()`.

## 6. Data-preservation assessment [REPO-VERIFIED]

- **No migration copies, merges, or deletes B2C row data, and none moves data between B2B and B2C.** There is no `INSERT … SELECT`, no `DELETE`, and no cross-table/environment transfer on `customer_*` tables in any migration.
- **Two in-place, additive back-fills exist** (new-column population on existing rows — **no data loss, same table, B2C-only**):
  - `0083_package_catalogue.py`: `UPDATE customer_packages SET destination = name WHERE destination IS NULL` — fills a new `destination` column from the existing `name`.
  - `0090_customer_review_moderation.py`: `UPDATE customer_reviews SET status = 'approved'` — defaults existing reviews to `approved` when the moderation `status` column was added (so prior reviews stay visible).
  Both are safe schema-evolution back-fills; neither removes or relocates data.
- **No B2C↔B2B overlap** and **no cross-Base FK** [REPO-VERIFIED], so a future physical split (if ever chosen) would not break referential integrity — but that is out of scope; the approved architecture is one DB.
- **[LIVE]** Whether any given table currently holds rows, and whether the deployed schema matches these migrations, requires live inspection (read-only `count(*)` / `\d`) — not done here.

## 7. Migration history (B2C schema) [REPO-VERIFIED]

The `customer_*` schema is built across the single Alembic chain, notably: `0044_customer_portal` (identity/auth core), `0053_customer_flight_booking`, `0054_customer_account_center` (reviews/notifications/wishlist/support), `0055_customer_hotel_system`, `0056_customer_package_system`, `0061_flight_package_idempotency`, `0079_guest_customers`, `0083_package_catalogue` (+back-fill §6), `0086_supplier_references`, `0089_customer_cancellations`, `0090_customer_review_moderation` (+back-fill §6), `0094_customer_refund_attempts`, `0095_customer_admin_audit_logs` (append-only audit; unapplied). Each is create-on-upgrade / drop-on-downgrade.

## 8. Risks & recommendations

- **R1 — Legacy `app/models` v1 layer (dead but present).** The duplicate `users`/`payments`/`service_requests` and the unused catalogue/pricing tables are a **confusion/footgun** risk (someone could edit or grant on the wrong `users`). **Recommend:** a separate, read-only dependency-trace workstream before any removal; **do not delete** now (may hold historical rows — [LIVE]). Not a blocker for staging.
- **R2 — Data preservation on `0095`/staging.** Before applying `0095` or provisioning staging, take a backup (customer_* tables especially) so the additive history is recoverable. The two back-fills (§6) are already applied in any DB past `0083`/`0090`; re-running is prevented by Alembic versioning.
- **R3 — "Shared" is only physical.** Because B2B and B2C share one `public` schema, a blanket grant/REVOKE touches both sets — see the DBA runbook (grants are schema-wide with an audit-table exception); keep that in mind for any future per-set privilege tightening.
- **R4 — Gaming.** `gaming_tour_enquiries` (B2B Base) retains historical rows and stays **disabled** (fail-closed flag); do not drop its table or enable the feature.

## 9. Repository-verified vs live-DB

- **[REPO-VERIFIED]:** table inventories, PK/FK patterns, Base separation, no B2B↔B2C overlap, no cross-Base FK, single engine/session/`get_db`, single Alembic history, `public`-schema-only layout, create/drop-on-downgrade pattern, the two additive back-fills, legacy layer dead.
- **[LIVE]:** actual row counts and whether legacy tables hold data; the deployed schema's exact state and current `alembic_version`; confirmation that no out-of-band SQL altered the tables.

---

**This review changed nothing** — read-only; no DB connection, no SQL, no migrations, no data/table change, no app-code change, no deploy/commit. All existing data and functionality preserved; Gaming Tour Packages remain disabled.

**Document created:** `docs/B2B_B2C_DATABASE_ARCHITECTURE_AND_DATA_PRESERVATION_REVIEW.md`.
