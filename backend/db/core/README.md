# Core schema — hardening scripts

Raw PostgreSQL 17 DDL/PLpgSQL that closes the gaps found when the core
schema (migrations `0001`-`0014`: `users`, `bookings`, `payments`, `flights`,
`hotels`, `cruises`, `tour_packages`, `reviews`, `wishlist`, `notifications`,
`activity_logs`, `support_tickets`, `coupons`, `discount_campaigns`,
`seasonal_prices`, `contact_us`, `newsletter`) was reviewed against the same
standard already applied to the Partner Portal (`backend/db/partner_portal/`).
See [`docs/DATABASE_REVIEW_2026.md`](../../../docs/DATABASE_REVIEW_2026.md)
for the full analysis.

Wrapped into Alembic migration
[`0023_core_schema_hardening`](../../alembic/versions/0023_core_schema_hardening.py),
the same way `backend/db/partner_portal/**` is wrapped into `0015`-`0022` —
this is not a standalone script meant to be run outside that migration.

## What this is (and isn't)

Purely additive: new triggers, one new column per table (with a `DEFAULT`,
so existing rows backfill automatically), and new indexes/views. **No table
is renamed, no column is dropped, no existing data is migrated.** The
already-designed, larger domain-separation redesign
(`docs/DATABASE_STRUCTURE.md`) — which does rename/retire tables — is a
separate, deliberately deferred decision; nothing here overlaps with it.

## File order and purpose

| File | Contents |
|---|---|
| `01_triggers.sql` | `fn_set_updated_at` reused from Partner Portal; adds `BEFORE UPDATE` triggers to `users`/`bookings` (closing the gap where `updated_at` was only set by the ORM); adds a new `updated_at` column + trigger to `flights`/`hotels`/`cruises`/`tour_packages`, which had no update-tracking at all despite being admin-edited inventory |
| `02_indexes.sql` | `created_at` indexes on `bookings`/`payments`/`users`, plus a composite `(status, created_at)` index on `payments` matching the exact filter `admin_service.build_reports` already runs for revenue-by-date-range |
| `03_views.sql` | `vw_daily_sales`, `vw_customer_bookings`, `vw_dashboard_statistics` — built from the real columns/filters in `admin_service.py`, not speculative |

## Why other core tables aren't touched here

`payments`, `reviews`, `coupons`, `discount_campaigns`, `support_tickets`,
`contact_us`, `newsletter`, `notifications`, `activity_logs`, `wishlist`, and
`user_sessions` are append-only, or already track their own lifecycle
timestamp (e.g. `support_tickets.resolved_at`). Adding an `updated_at`
trigger to them wouldn't correspond to any real update path in the app today,
so it was deliberately left out rather than added for symmetry alone.
