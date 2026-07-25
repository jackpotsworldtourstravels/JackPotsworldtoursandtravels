# Partner Portal — database scripts

Raw PostgreSQL 17 DDL/PLpgSQL for the new B2B Partner Portal, extending the
**existing** JackPots World Tours & Travels database. Nothing here has been
applied to the live database yet — this is the review artifact before any
backend or frontend code is written (Phase 1, per the project's phased plan).

## What this is not

This is **not** an Alembic migration. It's plain, standalone SQL so it can be
reviewed and run against a scratch/staging database independently of the
Python backend. Once approved, Phase 2/3 will wrap this into a proper Alembic
migration chained after `0014_pricing_coupons.py` (the current head), so it
applies through the same tooling as every other schema change in this project
— not as an ad hoc script against production.

## Prerequisites

- PostgreSQL 17, pointed at the **same** database the existing FastAPI app
  uses (`DATABASE_URL` in `backend/.env`).
- The existing schema must already be migrated (i.e. `alembic upgrade head`
  has been run) — these scripts assume `users`, `roles`, `flights`, `hotels`,
  and `cruises` already exist, and will fail loudly if they don't.

## Running it

```bash
cd backend/db/partner_portal
psql "$DATABASE_URL" -f 00_run_all.sql
```

Or run the numbered files individually, in order — each one lists its
dependencies in its own header comment.

## File order and purpose

| File | Contents |
|---|---|
| `01_types.sql` | Custom `ENUM` types used across every table below |
| `02_reference_tables.sql` | `countries`, `permissions`, `role_permissions` |
| `03_partner_tables.sql` | `partners`, `partner_users`, `partner_otp_requests` |
| `04_booking_tables.sql` | `partner_bookings`, `partner_booking_passengers`, `booking_reference_counters` |
| `05_service_request_tables.sql` | `service_requests` + its 4 type-specific child tables |
| `06_payment_report_notification_audit_tables.sql` | `partner_payments`, `report_generation_log`, `partner_notifications`, `partner_audit_logs` |
| `07_sequences.sql` | The global sequence behind service request numbers |
| `08_views.sql` | `vw_partner_dashboard_stats`, `vw_request_history`, `vw_reports_summary` |
| `09_triggers.sql` | `updated_at` triggers + automatic audit-log triggers |
| `10_stored_procedures_auth_and_reference.sql` | OTP/login lookup, reference-number generation |
| `11_stored_procedures_booking_workflow.sql` | Create → submit → approve/reject → complete |
| `12_stored_procedures_service_requests.sql` | Cancellation, date change, refund, passenger modification |
| `13_stored_procedures_reporting.sql` | Ticket enquiry search, request history, report generation |
| `14_seed_reference_data.sql` | Two new `roles` rows, starter `permissions`, full ISO country list |

## Key design decisions (see the ER diagram artifact for the full writeup)

- **No new database** — everything here extends the existing one.
- **No duplicate catalog** — Ticket Enquiry queries the existing `flights`,
  `hotels`, `cruises` tables directly.
- **No `Customers` table** — not a customer portal; passengers already fully
  capture traveler data.
- **Partner-scoped tables stay separate from the consumer-facing ones** —
  `partner_bookings`/`partner_payments`/`partner_notifications`/
  `partner_audit_logs` are new, parallel tables rather than bolting a second
  workflow onto `bookings`/`payments`/`notifications`/`activity_logs`, which
  the live consumer site depends on.
- **Two reference-number schemes** — booking references reset per partner
  per year via a row-locked counter table; service request numbers are one
  global `SEQUENCE`.
- **Password/OTP verification happens in the app, not SQL** — the stored
  procedures return hashes for the FastAPI layer to check with the same
  `passlib`/bcrypt already used for admin/customer auth.
