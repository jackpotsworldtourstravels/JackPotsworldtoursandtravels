# `database/` — v2: Fully Domain-Separated PostgreSQL Schema

This folder is a **proposed, documented schema redesign**. Nothing in here
has been applied to the live `jackpotsworldtours` database.

v2 goes beyond v1's Admin/Merchant/User/Shared split: **no table for
authentication, profile, session, or activity data is shared across
portals.** Each domain owns its identity end to end — see
[`DATABASE_STRUCTURE.md`](../DATABASE_STRUCTURE.md) in the project root for
the full ER diagram, rationale, and the complete rename/retirement list.
See [`FIELD_MAPPING.md`](../FIELD_MAPPING.md) for the exhaustive
frontend-field-to-database-column mapping.

## File order (also see `migrate.sql`)

| File | Contents |
|---|---|
| `01_types.sql` | 20 enum types (17 kept, 1 renamed, 3 new) |
| `02_shared_tables.sql` | 22 tables — catalog/reference/public data only, no auth/profile/session/activity |
| `03_admin_tables.sql` | 8 tables — Admin's own auth (`admins`), profile, session, activity log, notifications, and RBAC (`admin_roles`/`admin_permissions`) |
| `04_partner_tables.sql` | 28 tables — Merchant's own auth (`partner_staff`, renamed from `partner_users`), profile, session, activity log, notifications, bookings/service-request workflow, and new financial tables (bank accounts, documents, wallet, commissions, invoices) |
| `05_user_tables.sql` | 12 tables — User's own auth (`users`), profile, session, activity log, notifications, bookings, and new address/passenger tables |
| `06_indexes.sql` / `07_constraints.sql` | All indexes / FKs / unique / check constraints, grouped by domain |
| `08_views.sql` / `09_functions.sql` / `10_procedures.sql` / `11_triggers.sql` | 5 views, 10 trigger functions, 26 procedures, 14 triggers — updated wherever they referenced a renamed table/column |
| `12_seed.sql` | Intentionally empty (one bootstrap note for `admin_roles`) |
| `migrate.sql` | Master script — runs every file above in order |

## The rule this version enforces

No authentication table, profile table, login-history/session table, or
activity-log table is shared across Admin, Merchant, or User. Only
catalog/reference/business data lives in Shared. Every frontend page maps
directly to its own domain's tables. See `DATABASE_STRUCTURE.md` §4 for how
this is verified mechanically against the actual FK graph, not just
asserted.

## What's real vs. provisioned

Every table was checked against the live frontend first. Renamed tables
(`partner_staff`, `user_bookings`, `partner_activity_logs`, etc.) carry
real, live data unchanged. A number of new tables from your target list
have no current frontend form yet — `states`, `cities`, `currencies`,
`languages`, `airports`, `airlines`, `hotel_chains`, `cruise_lines`,
`package_images`, `payment_methods`, `system_settings`,
`partner_bank_accounts`, `partner_documents`, `partner_wallet`(+`_transactions`),
`partner_commissions`, `partner_invoices`, `user_addresses`,
`booking_passengers`, most of `admin_profiles` — these are included as
production-ready scaffolding, not wired to any page. `admin_notifications`
is the one exception that looks provisioned but isn't: it fixes a live bug
where the Admin Portal's notification bell currently reads the same table
the customer portal uses. Full detail in `DATABASE_STRUCTURE.md` §6 and
`FIELD_MAPPING.md`.

## Super Admin Portal is intentionally excluded

Per explicit prior instruction, the Super Admin Portal's own PostgreSQL
objects are being designed and written by the user directly.

## Applying this schema

Still a design deliverable, not an automatic migration. `migrate.sql`
explains how to apply it to a target database when you're ready — not
wired into Alembic, does not touch the live database. See
`DATABASE_STRUCTURE.md` §9 for what an actual cutover would require
(including real backend code changes, not just database changes).
