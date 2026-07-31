# Data Migration Strategy — 41 Legacy Tables → 9-Table Target Schema

Companion to [`DATABASE_REDESIGN_9TABLE.md`](DATABASE_REDESIGN_9TABLE.md).
Covers how existing data moves from the legacy tables into `ts_*` once
migration `0025_target_schema_9table` has created the new (empty) tables.

**This has not been run.** The backfill script
(`backend/db/target_schema/05_backfill.sql`) is a first draft to run against
a **copy** of the production database first, not production directly.

## Phase 0 — Preconditions

1. `0025_target_schema_9table` applied (creates empty `ts_*` tables).
2. Full database backup / snapshot taken immediately before any backfill run.
3. Backfill rehearsed end-to-end against a restored copy of production data,
   not synthetic data — row counts and spot-checks (§4) must be verified
   against that copy before it's ever run against the real database.

## Phase 1 — One open verification item before the script can be trusted

The backfill script encodes a best-effort mapping from the live schema as
verified against `backend/app/models/*.py`. One mapping could not be fully
verified from the model files alone and is marked `-- VERIFY:` inline in the
script — resolve it against the live database before running the script for
real:

1. **`roles.name` → `ts_users.user_type`.** The legacy `roles` table stores
   free-form role names (seeded by migration `0001`/`0002`), not a fixed
   enum. The script maps by pattern (`ILIKE '%admin%'` etc.) — confirm the
   actual seeded role names (`SELECT name FROM roles;`) match this pattern
   before trusting the mapping, and adjust the `CASE` expression if not.

**Resolved** (was previously an open item, now confirmed): merchant profile
fields (`company_type`, `contact_person`, `address`, `city`, `state`,
`country`, `gst_number`, `pan_number`) — not in the `Partner` SQLAlchemy
model, but confirmed as real live `partners` columns by reading
`backend/app/services/admin_merchant_service.py`'s raw-SQL `INSERT INTO
partners (..., company_type, contact_person, address, city, state, country,
gst_number, pan_number, ...)`. The backfill's `ts_merchants` INSERT has been
updated to pull them. Also caught in the same pass: an earlier draft of the
target schema invented merchant statuses `pending`/`rejected` that don't
exist anywhere in the real system (which only ever uses
`active`/`inactive`/`suspended`, per the same file's activate/deactivate
actions) — `ts_merchant_status_enum` has been corrected to match.

## Phase 2 — Backfill order (respects FK dependencies)

1. `ts_merchants` ← `partners`
2. `ts_users` ← `users` (customer/admin/super_admin) + `partner_users`
   (merchant_staff)
3. `ts_service_requests` ← `bookings`, `support_tickets`, `partner_bookings`,
   `service_requests`+4 subtypes (in that order, so booking rows exist
   before subtype rows set `parent_request_id`)
4. `ts_passenger_data` ← `partner_booking_passengers`
5. `ts_payments` ← `payments`, `partner_payments`, `discount_campaigns`,
   `coupons`
6. `ts_communication_settings` — no legacy source (new concept); seed one
   default row per existing user/merchant with all channels enabled
7. `ts_msg_logs` ← `notifications`, `partner_notifications`, `contact_us`,
   `newsletter`
8. `ts_system_logs` ← `activity_logs`, `user_sessions`,
   `report_generation_log`, `partner_booking_status_history`,
   `service_request_status_history`
9. `ts_audit_logs` ← `partner_audit_logs`
10. Catalog tables (`flights`/`hotels`/`cruises`/`tour_packages`) ←
    `seasonal_prices`, grouped into each row's new `seasonal_pricing` JSONB
    array by matching `item_type`/`item_id`

`reviews` and `wishlist` are not migrated (dropped by design decision, see
`DATABASE_REDESIGN_9TABLE.md` §1). If that decision is reversed later, their
data is still sitting untouched in the legacy tables until those are
actually dropped, so nothing is lost by deferring.

## Phase 3 — Idempotency and re-run safety

Every INSERT in the backfill script is written as
`INSERT ... SELECT ... WHERE NOT EXISTS (...)` keyed on a natural identifier
carried over from the source row (e.g. legacy `users.id` stored temporarily
alongside the new row, or matched by `email`), so the script can be re-run
after fixing a mapping issue without creating duplicates. **Recommendation:**
add a temporary `legacy_id INTEGER` column to each `ts_*` table during the
backfill/verification window (not part of the final schema) to make
row-for-row reconciliation queries trivial; drop it as the last step before
cutover.

## Phase 4 — Verification before cutover

For each of the 41 legacy tables, the row count of legacy rows should equal
the row count of corresponding `ts_*` rows (accounting for merges — e.g.
`bookings` + `partner_bookings` count should equal `ts_service_requests
WHERE request_type = 'booking'` count). Spot-check a sample of real rows
(not just counts) field-by-field, the same way `MIGRATION_VERIFICATION_2026.md`
verified migration `0023` against the live app — through real API calls
against a staging environment pointed at the new schema, not just SQL.

## Phase 5 — Cutover (separate, explicit approval required)

1. Final backfill run against production (preceded by a fresh backup).
2. Verify row counts and spot-checks (§4) against the freshly backfilled
   production data.
3. Swap `backend/app/models/__init__.py` and all routers/services to import
   from `app.models.target_schema` instead of `app.models`.
4. Deploy, verify every workflow end-to-end (mirroring
   `MIGRATION_VERIFICATION_2026.md`'s test matrix) against production.
5. Only after that verification passes: rename `ts_*` tables to their bare
   target names, and drop the legacy tables in a follow-up migration. This
   last step is irreversible and must not be combined with step 3 — keep a
   rollback path (legacy tables still present, renamed but not dropped)
   available for at least one full business cycle before actually dropping
   anything.

## Rollback plan

At any point before Phase 5 step 5, rollback is simply "stop, keep using the
legacy schema" — the `ts_*` tables are additive and can be dropped
(`0025` downgrade) without affecting the running app. After step 5 renames
tables, rollback requires restoring from the pre-cutover backup taken in
Phase 5 step 1.
