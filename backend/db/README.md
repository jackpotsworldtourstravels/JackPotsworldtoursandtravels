# `backend/db/` — raw SQL source, by domain

Everything the live `jackpotsworldtours` PostgreSQL 17 database actually runs
is plain SQL/PLpgSQL under this folder, wrapped into Alembic migrations one
folder at a time. **Alembic is still the only supported way to apply any of
it** (`python -m alembic upgrade head` from `backend/`) — these folders exist
so the DDL/PLpgSQL can be reviewed and run standalone against a scratch
database, not as a replacement for the migration chain.

The core schema (migrations `0001`-`0014`, plain SQLAlchemy/Alembic DDL —
tables, columns, indexes, defined directly in Python, no separate `.sql`
files) isn't listed below for that reason; only the folders that ship raw SQL
are.

## Folders, in execution order

| Folder | Alembic revision(s) | Contents |
|---|---|---|
| [`core/`](core/README.md) | `0023_core_schema_hardening` | `updated_at` triggers, report indexes, dashboard views for the core (non-Partner-Portal) schema |
| [`partner_portal/`](partner_portal/README.md) | `0015_partner_portal` | Partner Portal base: tables, views, triggers, stored procedures |
| `partner_portal/gap_completion/` | `0016_partner_portal_gap_completion` | Status-history tables, more stored procedures/views, sample seed data |
| `partner_portal/back_office/` | `0017`-`0022` | Back office stored procedures, notification triggers, OTP rate limiting, ancillary services, merchant management |
| [`db_review/`](db_review/README.md) | *(none — inspection only)* | pgAdmin catalog-inspection queries and sample-data `SELECT`s against the already-applied schema |

## Full migration-to-folder map

See the root [`README.md`](../../README.md#database-migrations) for the
complete Alembic revision history (`0001`-`0022`). `0023_core_schema_hardening`
is the newest revision, described in [`core/README.md`](core/README.md).

## What is deliberately not here

The domain-separated v2 redesign (table renames, splitting `admins` out of
`users`, retiring the shared `roles`/`permissions` tables) lives entirely
under the top-level [`database/`](../../database/README.md) folder and
[`docs/DATABASE_STRUCTURE.md`](../../docs/DATABASE_STRUCTURE.md) — it is a
reviewed proposal, not applied to the live database, and is out of scope for
`backend/db/` until a cutover is explicitly decided. The Super Admin Portal's
database is designed separately by the project owner and has no files under
`backend/db/` at all.
