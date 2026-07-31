# Database Architecture Review — 2026-07-27

This is the consolidated answer to a full "enterprise database architecture
review": current-state analysis, problems found, the already-approved target
architecture, folder structure, migration order, every file path touched, and
the newly generated SQL for the one real gap this review found. It
deliberately **references** two existing documents instead of re-deriving
them, so nothing here contradicts work already done and approved.

## A. Current database analysis

- **Live database**: PostgreSQL 17, `jackpotsworldtours`, managed entirely by
  Alembic (`backend/alembic/versions/`, head `0022` before this review,
  `0023` after). Verified live object count per
  [`backend/db/db_review/README.md`](../backend/db/db_review/README.md): 41
  tables, 5 views, 33 functions, 12 triggers, 92 indexes, 12 enum types.
- **Two schema layers by design, not by accident**:
  - **Core** (migrations `0001`-`0014`): `users`/`roles`, `flights`, `hotels`,
    `cruises`, `tour_packages`, `bookings`, `payments`, `reviews`, `wishlist`,
    `notifications`, `activity_logs`, `support_tickets`, `coupons`,
    `discount_campaigns`, `seasonal_prices`, `contact_us`, `newsletter`. Built
    as plain SQLAlchemy/Alembic DDL; business rules mostly live in the Python
    service layer (`backend/app/services/`).
  - **Partner Portal** (migrations `0015`-`0022`): `partners`,
    `partner_users`, `partner_bookings`, `service_requests` + 4 subtypes,
    `partner_payments`, `partner_notifications`, `partner_audit_logs`,
    merchant-management fields, etc. Built as hand-written SQL/PLpgSQL under
    [`backend/db/partner_portal/`](../backend/db/partner_portal), with real
    business logic pushed into `sp_*` functions and 12 triggers. Already
    reviewed with a dedicated pgAdmin package
    (`backend/db/db_review/`) that found **nothing missing** in this domain.
  - **Super Admin Portal**: explicitly out of scope — per standing project
    instruction, its database is being designed by the project owner directly
    (`backend/app/services/super_admin_service.py` is still a mock/in-memory
    stub, no real table exists).
- **An already-approved target architecture exists and has not been applied**:
  [`docs/DATABASE_STRUCTURE.md`](DATABASE_STRUCTURE.md) +
  [`docs/FIELD_MAPPING.md`](FIELD_MAPPING.md) +
  [`database/`](../database/README.md) define a fully domain-separated v2
  schema (70 tables: 22 Shared / 8 Admin / 28 Merchant / 12 User — no auth,
  profile, session, or activity-log table shared across domains), with a
  complete rename/retirement list, ER diagram, and index strategy. It is a
  reviewed proposal only; `docs/DATABASE_STRUCTURE.md` §9 lists exactly what
  a cutover requires, including backend code changes beyond the database.

## B. Problems found (this review's actual new findings)

The Partner Portal domain was already reviewed and found clean. The core
domain had not been reviewed to the same standard. Concretely, verified
against `backend/app/models/*.py` and `backend/app/services/admin_service.py`:

| Problem | Detail |
|---|---|
| `updated_at` is application-only on `users`/`bookings` | Set via SQLAlchemy `onupdate=` in Python, no DB trigger — any row updated outside the ORM (raw SQL, a future script) silently keeps a stale timestamp. Partner Portal tables all have a real trigger for this. |
| No update-tracking at all on admin-edited inventory | `flights`, `hotels`, `cruises`, `tour_packages` have `created_at` but **no `updated_at` column whatsoever**, despite being directly edited by admins (price, availability, ratings) — there is no way to tell when a price or stock level last changed. |
| No `created_at` index on date-filtered report queries | `admin_service.build_reports()` filters/orders `bookings`, `payments`, and `users` by `created_at` (today's revenue, today's bookings, recent lists) with no supporting index — migrations `0006`/`0009` indexed FK/status/type columns but not date columns. |
| No reusable SQL views for admin dashboard metrics | Every dashboard number in `build_reports()` is computed ad hoc in Python on each request; there was no `vw_daily_sales` / `vw_customer_bookings` / `vw_dashboard_statistics` equivalent to inspect the same numbers directly in SQL/pgAdmin. |
| Naming inconsistency, shared RBAC, `admins`/`users` overlap | Already fully identified and solved in `docs/DATABASE_STRUCTURE.md` (§1, §5) — **not re-solved here** to avoid contradicting that design. Listed as a deferred decision (§D below). |

Tables reviewed and found **not** to need `updated_at`: `payments`,
`reviews`, `coupons`, `discount_campaigns`, `support_tickets`, `contact_us`,
`newsletter`, `notifications`, `activity_logs`, `wishlist`, `user_sessions` —
each is append-only or already tracks its own lifecycle timestamp (e.g.
`support_tickets.resolved_at`). Adding the column there would not correspond
to any real update path today.

## C. Improved architecture

The target architecture is `docs/DATABASE_STRUCTURE.md` (v2, domain-separated)
— this review does not propose an alternative. What this review adds is
purely additive hardening of the **current, live** schema so it matches the
same quality bar (triggers, indexes, views) the Partner Portal domain already
has, without pre-empting the larger, already-designed cutover.

## D. Recommended folder structure

```
backend/db/
├── README.md                 -- NEW: manifest, execution order, folder map
├── core/                     -- NEW
│   ├── 00_run_all.sql
│   ├── 01_triggers.sql
│   ├── 02_indexes.sql
│   ├── 03_views.sql
│   └── README.md
├── partner_portal/            -- unchanged, already professionally organized
│   ├── gap_completion/
│   └── back_office/
└── db_review/                 -- unchanged, inspection package
```

`database/` (top-level, the v2 proposal) and `docs/DATABASE_STRUCTURE.md` /
`docs/FIELD_MAPPING.md` are unchanged by this review.

## E. Migration execution order

```
0001_initial_schema ... 0022_merchant_user_fields   (already applied, unchanged)
0023_core_schema_hardening                          (NEW — this review)
```

`0023` depends only on the core tables existing (`0001`-`0014`) and on
`fn_set_updated_at()` already existing (created by `0015_partner_portal`) —
it does not depend on `0016`-`0022`, but sits after them in the chain since
Alembic requires a single linear `down_revision` history.

## F. Every SQL file path (this review)

```
backend/db/core/00_run_all.sql
backend/db/core/01_triggers.sql
backend/db/core/02_indexes.sql
backend/db/core/03_views.sql
backend/db/core/README.md
backend/db/README.md
backend/alembic/versions/0023_core_schema_hardening.py
docs/DATABASE_REVIEW_2026.md   (this file)
```

## G. Generated SQL for missing objects

See [`backend/db/core/01_triggers.sql`](../backend/db/core/01_triggers.sql),
[`02_indexes.sql`](../backend/db/core/02_indexes.sql), and
[`03_views.sql`](../backend/db/core/03_views.sql) — full detail, including
why each object was added, in [`backend/db/core/README.md`](../backend/db/core/README.md).
Summary:

- **Triggers**: `trg_users_updated_at`, `trg_bookings_updated_at` (reuse
  existing `fn_set_updated_at`); new `updated_at` column + trigger on
  `flights`, `hotels`, `cruises`, `tour_packages`.
- **Indexes**: `ix_bookings_created_at`, `ix_payments_created_at`,
  `ix_users_created_at`, `ix_payments_status_created_at` (composite).
- **Views**: `vw_daily_sales`, `vw_customer_bookings`, `vw_dashboard_statistics`.

All of it is additive only — no renames, no drops, no data migration.

## H. Files modified/added by this review

**Added (all new, nothing existing was modified or moved):**
`backend/db/core/00_run_all.sql`, `01_triggers.sql`, `02_indexes.sql`,
`03_views.sql`, `README.md`; `backend/db/README.md`;
`backend/alembic/versions/0023_core_schema_hardening.py`;
`docs/DATABASE_REVIEW_2026.md`.

## Explicitly deferred, not executed by this review

1. **The v2 domain-separation cutover** (table renames, `admins` split from
   `users`, retiring shared `roles`/`permissions`) — fully designed in
   `docs/DATABASE_STRUCTURE.md` §9, needs backend code changes beyond the
   database, and is a hard-to-reverse rename against live data. Requires a
   separate, explicit go-ahead.
2. **Super Admin Portal** — untouched, per standing project instruction.
3. **Running `0023` against the live database** — the migration is generated
   and ready (`alembic upgrade head`), but was not executed against
   `backend/.env`'s configured database as part of this review; that's a
   separate action requiring explicit confirmation since it touches a live,
   data-bearing system.

*(Incidental, out-of-scope observation: the root `README.md`'s "Migration
history" table currently lists only up to `0017`, missing `0018`-`0022` — a
pre-existing gap unrelated to this review, left as-is since updating it was
not part of the approved scope.)*
