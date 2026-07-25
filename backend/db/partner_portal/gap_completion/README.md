# Partner Portal — gap completion

This folder is **additive only** — it extends the Phase 2 database
(`../01_types.sql` through `../14_seed_reference_data.sql`, already applied
to the live database and in production use through Phase 3/4) with the
handful of items a later request asked for that weren't already built.
Nothing in `../` is modified, dropped, or recreated.

## Decisions carried over from the review before writing this

- **No separate Airlines table.** Ticket Enquiry keeps querying the existing
  `flights` table directly (Phase 2 decision, still in effect) — reusing the
  live catalog instead of a second, divergence-prone copy of it.
- **No self-service partner registration.** The portal stays invitation-only.
  `sp_register_partner` below is a Back-Office/admin tool for onboarding a
  new partner company, not a public sign-up endpoint — there's still no
  `POST /api/partner-auth/register` route, and none is planned.

## What's actually new here

| File | Adds |
|---|---|
| `01_schema.sql` | `partner_booking_status_history`, `service_request_status_history` |
| `02_constraints.sql` | PK/FK/CHECK for those two tables |
| `03_indexes.sql` | Lookup indexes for those two tables |
| `04_functions.sql` | 4 trigger functions (status history + reference-number safety nets) |
| `05_stored_procedures.sql` | `sp_register_partner`, `sp_get_dashboard_statistics`, `sp_update_partner_profile`, `sp_audit_log_entry` |
| `06_triggers.sql` | Binds the 4 functions in `04` to `partner_bookings` / `service_requests` |
| `07_views.sql` | `vw_ticket_enquiry` (browsable flights+hotels+cruises), `vw_service_requests` (request-centric, vs. Phase 2's passenger-centric `vw_request_history`) |
| `08_seed_data.sql` | 2 sample partner companies via `sp_register_partner` (Countries/Roles/Permissions were already seeded in Phase 2 — not repeated here) |

## Running it

```bash
cd backend/db/partner_portal/gap_completion
psql "$DATABASE_URL" -f 00_run_all.sql
```

Requires Phase 2's scripts to already be applied (they are, on the project's
live database).

## Everything from the original request that's a no-op here

Most of the requested stored procedures/functions/triggers/views already
exist from Phase 2 and are not touched: `sp_partner_login_lookup` /
`sp_partner_record_login` (Partner Login), `sp_generate_booking_reference`,
`sp_generate_service_request_number`, `sp_create_ticket_request`,
`sp_add_passenger`, `sp_submit_request_for_approval`, `sp_approve_request`,
`sp_reject_request`, `sp_cancel_selected_passengers`,
`sp_create_date_change_request`, `sp_create_refund_request`,
`sp_get_ticket_enquiry`, `sp_get_request_history`, `sp_generate_report`,
`trg_set_updated_at` (automatic timestamps), `trg_audit_partner_bookings` /
`trg_audit_service_requests` / `trg_audit_partner_users` (audit logging),
`vw_partner_dashboard_stats`, `vw_request_history`, `vw_reports_summary`, and
190 seeded countries + partner_admin/partner_staff roles + 12 permissions.
