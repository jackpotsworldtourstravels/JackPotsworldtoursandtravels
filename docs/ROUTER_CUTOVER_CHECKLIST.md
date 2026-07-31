# Router / Service / Schema Cutover Checklist

Companion to [`DATABASE_REDESIGN_9TABLE.md`](DATABASE_REDESIGN_9TABLE.md) and
[`DATA_MIGRATION_STRATEGY_9TABLE.md`](DATA_MIGRATION_STRATEGY_9TABLE.md).

This is the concrete file-by-file punch list for the last mile of the
cutover: once the new schema exists (`0025`), is backfilled, and verified,
every one of these 102 backend files needs to be re-pointed from the legacy
`app.models`/`app.services` layer to `app.models.target_schema`/
`app.services.target_schema`. This is **not done yet** — rewriting all of it
blind, before the new tables exist in any real environment and without being
able to test against a running app, would be a large, unverifiable change to
a currently-working production system. The new service layer
(`backend/app/services/target_schema/`) is the foundation this work builds
on; this checklist is what's left.

## Why this is listed separately rather than done inline

A full rewrite of every router touches ~40 files across four portals, each
of which currently passes its own verification pass
(`MIGRATION_VERIFICATION_2026.md`). Doing that rewrite without a live
database on the new schema to test against means shipping ~40 files of
unverified changes at once — exactly the kind of large, hard-to-reverse,
unreviewable diff the project's own safety practice (see `0023`'s
deliberate non-application) argues against. The right sequencing is:
apply `0025` → backfill → stand up a staging environment against it → work
through this checklist with the ability to actually run and click through
each portal, the same way `MIGRATION_VERIFICATION_2026.md` did for `0023`.

## Checklist by domain

### Auth (do first — everything else depends on it)

**Staged, not yet wired into `app/main.py`** — verified via `configure_mappers()`,
FastAPI route registration, and OpenAPI schema build (no live database
available locally to go further; real HTTP-request-to-DB verification still
needs a Postgres instance with `0025` applied and backfilled):

- [x] `backend/app/auth/target_schema/security.py` — unified JWT (`user_type` claim replaces the old three-scope/sentinel-sub hack; `hash_password`/`verify_password`/OTP/reset-token helpers reused as-is from the legacy module since they're schema-agnostic)
- [x] `backend/app/auth/target_schema/deps.py` — one `get_current_user` (was three: core/partner/super_admin) + `require_user_type(...)` factory + `require_merchant_role(...)`; consolidates `deps.py` + `partner_deps.py` + `super_admin_deps.py`
- [x] `backend/app/services/target_schema/auth_service.py` — signup/authenticate/tokens/refresh/logout/password-reset + the merchant 3-step OTP login flow (`request_login_otp`/`verify_login_otp`/`merchant_login`), replacing the raw-SQL `sp_partner_login_lookup`/`sp_verify_otp`/`sp_partner_record_login` calls with ORM calls against `ts_users`
- [x] `backend/app/schemas/target_schema/auth.py`, `backend/app/routers/target_schema/auth.py` — one router file exposing both `/api/auth/*` and `/api/partner-auth/*` (same URL surface as today, so the frontend needs no changes at cutover), backed by the unified service/deps above
- [x] Found and fixed 3 real bugs while verifying rather than just writing blind: a SQLAlchemy registry collision from sharing `Base` with the legacy models (fixed with a dedicated `TargetBase`), a `'package'` vs `'tour_package'` enum-value mismatch in the backfill script, and a missing `otp_verified_at` column needed to gate the merchant portal's 3-step login (the original `verify_otp` design cleared OTP state before the password step could check it)
- [ ] `backend/app/routers/super_admin.py` login path — still needs a small follow-up once Super Admin's own signup/seeding is decided (this pass unified the *dependency*, i.e. `require_user_type("super_admin")`, but didn't build a super-admin account creation flow — there's no legacy `partner_users`-style admin UI for it yet)
- [ ] Actually wiring `app/main.py` to include these routers instead of the legacy ones — deferred to the real cutover (requires `0025` applied + backfilled + a live DB to test against, per `DATA_MIGRATION_STRATEGY_9TABLE.md`)

### Customer portal

**Self-service subset staged and verified** (compiles, mappers configure,
FastAPI registers all routes, OpenAPI builds, response-schema aliasing
checked against stand-in objects — no live DB available to go further):

- [x] `backend/app/services/target_schema/booking_service.py` — booking creation with full pricing pipeline (seasonal override → auto campaign discount → optional coupon), atomic inventory decrement/restore, cancel + refund, replacing `booking_service.py` + the customer-facing half of `pricing_service.py`
- [x] `backend/app/services/target_schema/payment_service.py` — gained `validate_coupon`, `apply_discount`, `get_active_campaign_discount`, `get_effective_unit_price` (reads the catalog item's own `seasonal_pricing` JSONB instead of a separate table)
- [x] `backend/app/services/target_schema/service_request_service.py` — `create_subtype_request`'s `parent_request_id` made optional (support tickets have no parent booking; this was a real bug caught while wiring it up) and `create_booking`'s hardcoded `status="pending"` renamed to `request_status` (would have raised `TypeError: multiple values for keyword argument` the moment a caller tried to override it — also caught by actually writing the caller, not just the function)
- [x] `backend/app/services/target_schema/msg_log_service.py` — gained `notify_admins`, `mark_all_read`, `delete_for_user`, `delete_read_for_user`; fixed `mark_read` to verify the notification belongs to the caller (the first draft didn't check ownership at all — any authenticated user could have marked another user's notification read by guessing the id)
- [x] `backend/app/services/target_schema/system_log_service.py` — gained `heartbeat`/`is_user_online`/`end_latest_session`; added a `last_seen_at` column (missing from the original design — needed for the online-user query pattern, which is filtered/ordered, not just informational, so it didn't belong in `log_metadata` JSONB)
- [x] `backend/app/routers/target_schema/bookings.py`, `support_tickets.py`, `notifications.py` — replace `routers/bookings.py`, `support_tickets.py`, `notifications.py`
- [x] `backend/app/routers/target_schema/users.py` — replaces the **self-service half** of `routers/users.py` (`/me`, `/change-password`, `/heartbeat`) only
- [x] `backend/app/schemas/target_schema/booking.py`, `support_ticket.py`, `notification.py`, `user.py`
- [ ] `backend/app/routers/reviews.py`, `wishlist.py`, `backend/app/services/review_service.py`, `wishlist_service.py`, `backend/app/schemas/review.py`, `wishlist.py` — **remove**, not migrate (dropped tables, see `DATABASE_REDESIGN_9TABLE.md` §1)
- [ ] `backend/app/services/inventory_service.py`, `catalog_items.py`, `backend/app/schemas/inventory.py`, `backend/app/models/travel.py` — update to map/read/write the new `seasonal_pricing` JSONB column added by `0025`. **Not done yet, deliberately**: `travel.py` is still imported by the live app, and mapping a column that doesn't exist in the live database yet would break every catalog query at deploy time. Until this happens, `payment_service.get_effective_unit_price` safely no-ops back to the base price (verified: `getattr(item, "seasonal_pricing", None)` returns `None` on the legacy ORM class rather than erroring).
- [ ] `backend/app/services/pricing_service.py` **admin-side CRUD** (campaigns/coupons/seasonal-price management), `customer_service.py`, `routers/customers.py`, the admin half of `routers/users.py`, `payment_management_service.py`/`routers/payment_management.py` — re-scoped to the **Admin portal** pass (they're admin-only endpoints gated by `get_current_admin`, not customer self-service; the original checklist mis-grouped them here)
- [ ] `backend/app/routers/misc.py`, `content.py`, `pricing.py` — not yet reviewed; likely a mix of public catalog/content reads (low risk) and admin pricing CRUD (Admin portal scope) — triage when starting the Admin portal pass

### Admin portal

**Merchant Management staged and verified** (compiles, mappers configure,
routes register — matches all 13 legacy `/api/admin/merchants/*` routes —
response-schema aliasing checked against stand-in objects):

- [x] `backend/app/services/target_schema/merchant_service.py` — gained company_code/reference_prefix auto-generation, `list_paginated` with search/status/date-range/sort, `get_detail` with user/booking/request counts (queried against `ts_users`/`ts_service_requests` instead of raw SQL joins), `delete_merchant` with the same FK-guard semantics, `set_status`
- [x] `backend/app/services/target_schema/user_service.py` — gained `create_merchant_staff`/`update_merchant_staff` (role_type/member_role cross-validation, uniqueness scoped to merchant_staff only — not a global DB constraint, matching the legacy `partner_users`-only scope), `admin_reset_password`
- [x] `backend/app/schemas/target_schema/admin_merchant.py`, `backend/app/routers/target_schema/admin_merchants.py` — replace `schemas/admin_merchant.py` + `routers/admin_merchants.py`
- [x] Two more real mismatches caught while wiring this up (same pattern as the earlier `'package'`/`'tour_package'` bug): the target schema's merchant `status` enum had invented values `pending`/`rejected` that don't exist anywhere in the real system (which only uses `active`/`inactive`/`suspended`, confirmed via `admin_merchant_service.py`'s actual activate/deactivate SQL) — fixed. Separately, `ts_user_status_enum` had an invented `'suspended'` value that neither the legacy customer booleans (`is_active`/`is_blocked`/`is_deleted`) nor the legacy merchant `partner_user_status_enum` (`active`/`inactive`/`blocked`) actually use — the merchant-staff "deactivate" action would have failed writing a status value that was never in either source vocabulary. Fixed to `active`/`inactive`/`blocked`/`deleted`, documented as a real trade-off (collapses 3 independent customer flags into 1 dominant-state column) in `users.py`'s model comment.
- [x] Also resolved a previously-open `DATA_MIGRATION_STRATEGY_9TABLE.md` uncertainty: merchant profile fields (`company_type`, `contact_person`, `address`, etc.) are confirmed real live `partners` columns (not just UI-only) — the backfill script now pulls them instead of leaving them NULL.

**Dashboard/Reports staged and verified** (compiles, mappers configure, 16
routes register matching the legacy `/api/admin/{bookings,payments,contact,
newsletter,reports*,support-tickets,notifications,activity-logs*}` surface,
response-schema aliasing checked against stand-in objects):

- [x] `backend/app/services/target_schema/admin_service.py` (new) — `build_reports`, `monthly_stats`, admin-wide bookings/payments listing, contact-message/newsletter admin views, `update_booking_status`, CSV exports for users/bookings/payments/contact (catalog CSV exports — flights/hotels/cruises/packages — deferred, see below)
- [x] `backend/app/schemas/target_schema/admin_reports.py`, `backend/app/routers/target_schema/admin_reports.py`
- [x] `backend/app/services/target_schema/system_log_service.py` gained `list_activity_logs_paginated`/`list_distinct_actions`/`list_distinct_modules`/updated `list_recent_activity`; `backend/app/services/target_schema/msg_log_service.py` gained `list_by_channel_paginated`, `admin_delete`, `list_all_notifications_paginated`, `send_admin_broadcast`
- [x] **Another real gap caught while porting this screen**: `SystemLog` only had one merged `event` text field — the admin Activity Log screen actually filters on two *separate* fields (`list_distinct_actions`/`list_distinct_modules` run `DISTINCT` queries against them), which a single merged string can't support. Added real `activity_type`/`module`/`status` columns (matching legacy `ActivityLog.action`/`module`/`status`) rather than folding them into `log_metadata` JSONB, consistent with the project's own "filtered fields get real columns" principle — and backfilled all of this session's earlier `log_activity()` call sites (auth, booking, support tickets) to populate them, plus fixed the backfill script's `activity_logs` mapping, which had mistakenly mapped `module` onto `entity_type`.
- [x] Reports intentionally return `today_logins`, `users_online`, `active_sessions` as static `0` rather than wired to real queries — session-listing/online-count admin views weren't ported this pass (see below), so these are honestly-zeroed placeholders, not silently wrong numbers.

**Not yet done** (re-scoped/deferred, tracked here for the next pass):
- [ ] `backend/app/routers/admin.py` remainder — sessions listing (`/sessions`, `/sessions/online`), inventory adjustment endpoints. Its `reviews`/`wishlist` endpoints should be **dropped, not migrated** (see `DATABASE_REDESIGN_9TABLE.md` §1) — don't stage a target-schema equivalent for those.
- [ ] Catalog CSV exports (flights/hotels/cruises/packages) — these operate entirely on the unchanged legacy catalog tables, so the legacy `admin_service.py` functions for them can likely be reused as-is at cutover rather than reimplemented.
- [ ] `backend/app/services/admin_partner_service.py`, `routers/admin_partner_requests.py` — partner booking approval/rejection workflow (distinct from merchant *account* management above); maps onto `service_request_service.update_status` but not yet wired into a router.
- [ ] `backend/app/services/pricing_service.py` **admin-side CRUD** (campaigns/coupons/seasonal-price management), `customer_service.py` (admin customer management/analytics), `routers/customers.py`, the **admin half** of `routers/users.py` (list/create/update/delete any user), `payment_management_service.py`/`routers/payment_management.py`
- [ ] `backend/app/routers/misc.py`, `content.py`, `pricing.py` — not yet triaged

### Merchant (Partner) portal

**Staged and verified** (compiles, mappers configure, 25 routes register
matching the legacy `/api/partner/*` surface except `/countries` — see
below —, response-schema aliasing checked against stand-in objects):

- [x] `backend/app/services/target_schema/merchant_booking_service.py` (new) — replaces `partner_booking_service.py`: dashboard stats, ticket enquiry (reuses the legacy `Flight` catalog table directly), draft-booking creation, add-passenger, submit-for-approval, booking detail, request history, and `verify_reference_belongs_to_merchant` (the RBAC boundary every subtype-request creation depends on, same role `_get_own_booking_or_404`/`_verify_reference_belongs_to_partner` played in the legacy stored-procedure-backed services)
- [x] `backend/app/services/target_schema/merchant_service_request_service.py` (new) — replaces `partner_service_request_service.py`: cancellation/date-change/refund/passenger-modification creation, all ownership-verified, wrapping `service_request_service.create_subtype_request` with `parent_request_id` set to the originating booking
- [x] `backend/app/services/target_schema/merchant_reports_service.py` (new) — replaces `partner_reports_service.py`'s `sp_generate_report` call with ORM filtering over `ts_service_requests`/`ts_passenger_data`, logged via `system_log_service.log_report_generation`
- [x] `backend/app/services/target_schema/msg_log_service.py` gained `count_unread` — legacy `partner_notifications_service.list_notifications` returns `{unread_count, notifications}`; the existing user-scoped `list_for_user`/`mark_read` already work correctly for merchant staff (they're just `ts_users` rows like anyone else)
- [x] `backend/app/schemas/target_schema/merchant_booking.py`, `merchant_service_request.py`, `merchant_reports.py`, `merchant_reference.py`, `merchant_profile.py`
- [x] `backend/app/routers/target_schema/merchant_bookings.py`, `merchant_service_requests.py`, `merchant_profile.py`, `merchant_reports.py` — replace `partner_dashboard.py`, `partner_ticket_enquiry.py`, `partner_bookings.py`, `partner_service_requests.py`, `partner_reports.py`, `partner_profile.py`, `partner_notifications.py`, `partner_reference.py`
- [x] **Another real gap caught while porting this domain**: `ts_request_status_enum` had no `'draft'` value — the merchant ticket-request flow is genuinely multi-step (create draft → add passengers → submit for approval), and `'draft'` is not the same as `'pending'` (already submitted, awaiting an admin). Added `'draft'` to the enum and fixed the `partner_bookings` backfill mapping, which had been silently collapsing `'draft'` into `'pending'` via its `ELSE` branch.
- [x] **A second real gap caught in the same pass**: the `partner_notifications` backfill (written during the auth/customer-portal passes) mapped notifications onto `merchant_id` (the whole company) instead of `user_id` (the specific staff member) — legacy `partner_notifications.partner_user_id` targets one person, not the company broadly. Left as originally written, every staff member would have seen every other staff member's notifications. Fixed.
- [ ] **`/api/partner/countries` was deliberately not built.** Per the design, passport/nationality country now lives on `passenger_data` as a raw ISO-3166-1 alpha-2 code rather than an FK to a `countries` table, so there's no database query to make — but the frontend dropdown still needs *some* list of (code, name) pairs to populate from. Hand-writing a ~195-country list here risked silent errors in passport-adjacent data, which felt like the wrong place to guess. Needs a real ISO-3166 data source (a small vetted static JSON/package) before cutover, not fabricated inline.
- [ ] **Ancillary option pricing (`additional_charge`) was dropped, not carried forward.** The legacy `ancillary_service_catalog` priced each baggage/meal option; embedding these as fixed enum values (per the design) has no natural home for that per-option price, and no verified source for the actual amounts was available while porting this screen. `AncillaryOptionOut` returns `{value, label}` only — if per-option pricing is still needed in the new design, it has to be reintroduced deliberately (e.g. a small static price config), not reconstructed from memory.
- [ ] `RequestHistoryItemOut` dropped `passenger_name`/`destination` display fields the legacy `sp_get_request_history` computed server-side (a multi-passenger booking doesn't reduce to one name) — simplified to the core request fields for this pass; worth revisiting once the frontend contract for this screen is reviewed.

### Super Admin portal
- [ ] `backend/app/services/super_admin_service.py` → becomes a real service over `target_schema/user_service.py` (`user_type='super_admin'`) instead of the current in-memory mock store
- [ ] `backend/app/routers/super_admin.py`, `backend/app/schemas/super_admin.py`

### Cross-cutting
- [ ] `backend/app/models/__init__.py` — swap imports from `app.models.*` to `app.models.target_schema.*` (the actual cutover switch)
- [ ] `backend/app/schemas/pagination.py`, `session.py`, `activity.py`, `misc.py`, `auth.py` — review for any field names tied to legacy column names
- [ ] `backend/db/partner_portal/`, `backend/db/core/` — the ~33 stored procedures / 12 triggers either get rewritten against `ts_*` table names or their logic moves into the Python service layer above (see `DATABASE_REDESIGN_9TABLE.md` §5.3 — this is the dominant remaining effort, larger than the schema or router work combined)
- [ ] Frontend: `admin.js`, `partner-portal.html`/JS, `index.html` JS — every fetch call that reads a field now nested under `details`/`metadata`/`log_metadata` JSONB needs its parsing updated

## Suggested execution order

1. Auth (nothing else works without it).
2. Customer portal (simplest domain, best test bed for the new service layer).
3. Admin portal.
4. Merchant portal (largest, most stored-procedure-dependent).
5. Super Admin portal (smallest, currently mocked so lowest risk).
6. Stored procedure/trigger rewrite in `backend/db/` (can happen in parallel with 2-5 once the table shapes are stable).
7. Frontend payload updates, tracked against each backend domain as it cuts over.

Each step should end with the same kind of live-app verification pass
`MIGRATION_VERIFICATION_2026.md` did for `0023` before moving to the next.
