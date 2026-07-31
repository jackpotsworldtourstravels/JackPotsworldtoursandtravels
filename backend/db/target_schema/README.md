# `backend/db/target_schema/`

DDL for the approved 9-table redesign — see
[`docs/DATABASE_REDESIGN_9TABLE.md`](../../../docs/DATABASE_REDESIGN_9TABLE.md)
for the full rationale, ER diagram, and column specification.

## Files (run in order — see `00_run_all.sql`)

1. `01_types.sql` — 22 new `ts_*` ENUM types, prefixed to avoid colliding with
   the 13 legacy enum types that stay live until cutover.
2. `02_tables.sql` — the 9 new tables, staged under `ts_` prefixed names
   (`ts_users`, `ts_payments`, ...) so they coexist with the legacy tables of
   the same bare names without collision. Also adds a `seasonal_pricing
   JSONB` column directly to the existing `flights`/`hotels`/`cruises`/
   `tour_packages` tables (additive, harmless to the running app until
   `travel.py` maps it).
3. `03_indexes.sql` — query-pattern indexes beyond the PK/UNIQUE ones created
   inline in `02_tables.sql`.
4. `04_triggers.sql` — `updated_at` maintenance (reuses the existing
   `fn_set_updated_at()`), a generic `fn_ts_audit_row()` writing to
   `ts_audit_logs` for `ts_users`/`ts_merchants`/`ts_service_requests`/
   `ts_payments`, and a status-change logger writing to `ts_system_logs`.

## Why `ts_` prefixed, staged names

The legacy tables `users`, `payments`, etc. are still live and serving the
running application. Creating new tables with the *same* bare names is
impossible without dropping the old ones first — which would break the app
immediately. Instead, the new schema is built alongside the old one under
`ts_` names, so it can be created, backfilled, and verified independently.
The final cutover migration (not part of this PR) does, in one transaction:

1. Rename the legacy tables out of the way (or drop them, once the backfill
   is verified — see `docs/DATA_MIGRATION_STRATEGY_9TABLE.md`).
2. Rename `ts_users` → `users`, `ts_merchants` → `merchants`, etc.
3. Swap the application's model imports from `app.models.*` (legacy) to
   `app.models.target_schema.*`.

Until that cutover runs, nothing in this folder affects the running
application.
