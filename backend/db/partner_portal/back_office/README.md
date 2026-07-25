# Partner Portal — Back Office

Two stored procedures closing the gap flagged since the original design review: there was no
way for Back Office to actually act on a pending partner booking or service request beyond
calling the SQL functions directly.

- **`sp_admin_list_partner_bookings(p_status, p_search)`** — the queue behind the Booking
  Approvals tab in `admin.html`'s new Partner Requests section. Joins in `company_name` and the
  requester's name, which no partner-scoped view exposes (they're correctly scoped to one
  partner and have no reason to).
- **`sp_resolve_service_request(p_service_request_id, p_status, p_resolved_by)`** — the one
  status transition `service_requests` never had a procedure for. Every existing service-request
  creation procedure only ever inserts at `status='submitted'`; nothing before this could move it
  to `approved`/`rejected`/`completed`.

Booking approve/reject reuse the existing `sp_approve_request` / `sp_reject_request` from Phase 2
— those already existed, they just had no caller. Service-request *listing* reuses the existing
`vw_service_requests` view (gap_completion) directly — no new listing procedure needed there.

Run: `psql "$DATABASE_URL" -f 00_run_all.sql` from this directory (after Phase 2 and
gap_completion are applied).
