# Admin Portal — Complete Functional Audit (B2B + B2C)

**Date:** 2026‑11‑13 · **Read‑only.** No code changed, no PostgreSQL connection, no migration run, no deploy/commit/push. Gaming Tour Packages disabled; single‑database architecture preserved. **Production readiness is not claimed.** Nothing is marked "tested" merely because code exists (see the evidence rule).

**Builds on** the five prior read‑only assessment docs (`docs/assessment/01‑05`) and **reconciles them with this session's Stage‑3 work (M0/M1/M2)**, which post‑dates them: the 2026‑11‑13 scorecard still showed Customers and Communication as view/read‑only and the B2C audit as the only gap — M1 and M2 have since closed the first two in code (with tests), and M0 added the audit readiness gate. The audit **table** remains undeployed (0095 unapplied).

## Evidence rule & classification
A status rests on *named evidence*: a frontend file, a router/endpoint, a service, a model/table, a permission dependency, and — for "tested" — an **automated test that actually runs in the suite**. The full backend suite was executed earlier this session: **1744 passed, 44 failed, 4 skipped**; the 44 failures are entirely in `test_token_revocation.py` (22) and `test_admin_supplier_reservation_http.py` (22). Integration `tests/verify_*.py` scripts require a **live server + live DB** and were **not run** here, so they do not support a "tested" mark.

- **IMPLEMENTED AND TESTED** — code present **and** covered by an automated test that passes in the suite (unit/HTTP on SQLite; not browser/live‑DB E2E).
- **IMPLEMENTED BUT NOT FULLY TESTED** — code present; only a live‑server `verify_*` script and/or no dedicated automated test; not exercised here.
- **PARTIALLY IMPLEMENTED** — some actions/paths present, others missing or UI‑only.
- **MISSING** — no backend.
- **BLOCKED BY DEPLOYMENT** — code + tests exist but the feature is inert at runtime until migration 0095 (+ DBA grants) is applied.
- **SECURITY ISSUE** — a posture/verification concern (not necessarily an exploited hole).

**Method limit (honest):** the admin UI is a single 2,007‑line SPA (`frontend/admin/index.html`) loading ~40 JS modules. Screen→module→endpoint wiring is evidenced by the `data-section` nav targets, the module names, and the router surface. **Exhaustive per‑button handler tracing was not performed for every one of ~35 screens** — representative actions are cited; where a handler name is not quoted it was not individually verified (not invented).

---

## Part 1 — B2B screens (18)
Frontend: `frontend/admin/index.html` sections + `assets/js/admin.js` (+ enquiry/booking/manual‑booking/live‑support modules). Auth: `auth/deps.get_current_user` (core admin token) + `rbac.require(...)`/`deps.require_permission`. B2B audit: `audit_logs` DB trigger (`fn_write_audit_log`) + `system_logs`.

| # | Screen (section) | Endpoint / Router | Service → Tables | Perms | Status | Evidence |
|---|---|---|---|---|---|---|
| 1 | Dashboard (`reports`) | /api/dashboard · dashboard | dashboard_service → service_requests, payments | admin | IMPLEMENTED, NOT FULLY TESTED | code present (doc 2/3); no dedicated pytest; chart.js tiles in index.html |
| 2 | Merchants (`users`) | /api/merchants,/merchant-team,/super-admin · merchants, merchant_team, super_admin | merchant_service, user_service → merchants, users, merchant_service_access | super_admin/admin, assert_same_merchant | IMPLEMENTED, NOT FULLY TESTED | lifecycle code present; authz in test_rbac/test_admin_permissions; no merchant‑CRUD pytest |
| 3 | Active Users | /api/admin/* · admin_ops/dashboard | session_service → system_logs | admin | IMPLEMENTED, NOT FULLY TESTED | code present; no dedicated pytest |
| 4 | Booking Enquiries (`ticket-enquiries`) | /api/enquiries,/tickets,/hotel-enquiries,/tour-package-enquiries · enquiries,tickets,hotel_enquiries,tour_package_enquiries | enquiry/ticket services → service_requests, hotel_enquiries, passenger_data | admin/manager | IMPLEMENTED, NOT FULLY TESTED | verify_api/verify_direct_booking (live‑server only) |
| 5 | Approval Queue (`partner-requests`) | /api/merchant-approvals,/manager-approvals,/change-requests · … | approval/change services → service_requests, request_notes | manager/admin | IMPLEMENTED, NOT FULLY TESTED | code present; no dedicated pytest |
| 6 | Booking Operations (`booking-ops`) | /api/booking-ops · booking_ops | booking/ticket services → service_requests, request_documents, request_notes | admin | IMPLEMENTED, NOT FULLY TESTED | verify_booking_completion (live‑server) |
| 7 | Service Request Mgmt (`service-requests-mgmt`) | /api/change-requests,/booking-ops · … | change_request service → service_requests | admin | IMPLEMENTED, NOT FULLY TESTED | code present |
| 8 | Providers (`providers`) | /api/providers · providers | provider_service → providers, provider_users | admin | IMPLEMENTED, NOT FULLY TESTED | CRUD present; no dedicated pytest |
| 9 | Manual Booking (`manual-request`/`manual-enquiry`) | /api/tickets,/enquiries · tickets, enquiries | ticket service → service_requests, passenger_data | admin | IMPLEMENTED, NOT FULLY TESTED | verify_group_booking/verify_direct_booking (live‑server); admin-manual-booking.js |
| 10 | Payment Management (`payments`) | /api/payment-admin · payment_admin | payment_admin_service → payments | admin, payment perms | IMPLEMENTED, NOT FULLY TESTED (payment guards tested) | payment‑guard pytest cover safety; mgmt CRUD not unit‑tested |
| 11 | Wallet Desk (`wallet-desk`) | /api/wallet · wallet | wallet/finance → payment_accounts, wallet_topups, wallet_transactions | admin | IMPLEMENTED, NOT FULLY TESTED | `drift` reconciliation is the documented post‑deploy check (deploy/README) |
| 12 | Reports Export (`reports-export`) | /api/reports · reports | reports + export_service → payments, service_requests | admin | IMPLEMENTED, NOT FULLY TESTED | csv/xlsx/pdf code; verify_* only |
| 13 | Analytics (`analytics`) | /api/analytics · analytics | analytics_service | admin | IMPLEMENTED, NOT FULLY TESTED | code present |
| 14 | Audit Logs (`audit`) | /api/super-admin/audit-logs · super_admin | audit_service (read) → audit_logs | super_admin | IMPLEMENTED, NOT FULLY TESTED | redaction‑on‑read code; trigger `fn_write_audit_log` |
| 15 | System Logs (`system-logs`) | /api/admin/*,/super-admin/system-info · admin_ops, super_admin | activity/system_info → system_logs | admin/super_admin | IMPLEMENTED, NOT FULLY TESTED | request‑id correlation covered by test_request_id_correlation |
| 16 | Support B2B (`support`) | /api/support-tickets,/messages · support_tickets, messages | ticket/message services → service_requests, msg_logs | admin | IMPLEMENTED, NOT FULLY TESTED | code present |
| 17 | Notifications (`notifications`) | /api/notifications,/admin/messages/failed · notifications_v2, messages | notification/delivery → msg_logs, communication_settings | admin | IMPLEMENTED, NOT FULLY TESTED | delivery‑failure path; no dedicated pytest |
| 18 | Profile (`profile`) | /api/auth,/profile · auth, profile | auth_service, user_service → users | authenticated | IMPLEMENTED, NOT FULLY TESTED | change‑password code; auth covered indirectly |

**B2B cross‑cutting SECURITY/TEST flags:**
- **`test_token_revocation.py` — 22 failing.** Token/session revocation underpins logout, force‑logout and (B2C) block. Failing tests here are a real "not‑green" area → defect D1.
- **`test_admin_supplier_reservation_http.py` — 22 failing.** Reconciliation supplier‑reservation attestation path → defect D2.
- Authorization itself **is** tested (`test_rbac.py`, `test_admin_permissions.py` pass).

---

## Part 2 — B2C screens (17 active + Gaming disabled)
Frontend: `frontend/admin/index.html` B2C `data-section`s + per‑area modules (`assets/js/admin-b2c-*.js`). Auth: `require_scope(b2c.*)` / `require_b2c_access()` / `get_current_b2c_admin`. Audit: `customer_admin_audit_service` → `customer_admin_audit_logs` (**append‑only; table created only by migration 0095, still unapplied**). **M0 readiness gate (`require_audit_ready`) means every audited B2C mutation/sensitive‑read returns 503 until 0095 is applied** — so those rows are simultaneously "tested in code" and "BLOCKED BY DEPLOYMENT at runtime."

| # | Screen | Frontend JS | Endpoint / Router | Service → Tables | Perms | Audit action | Status | Evidence |
|---|---|---|---|---|---|---|---|---|
| 1 | Customers (`b2c-customers`) | admin-b2c-customers.js | /api/admin/customers · customer_admin | customer_admin_service, customer_admin_account_service, customer_auth_service → customers, customer_auth, customer_password_resets | b2c.customers.view / **b2c.customers.manage** | view_detail; **block/unblock/reset_password_initiated** | **IMPLEMENTED AND TESTED** (M1) · runtime BLOCKED BY DEPLOYMENT | test_b2c_customer_admin_actions.py (21 pass): block/unblock/reset, 422 no‑verified‑email, 409 status rules, 403+DENIED, 503 when table absent |
| 2 | Bookings (`b2c-bookings`) | admin-b2c-bookings.js | /api/admin/customer-bookings · admin_customer_bookings | customer_booking_admin_service → customer_*_bookings | b2c.customers.view | booking.view_detail, booking.update | IMPLEMENTED, PARTLY TESTED · runtime BLOCKED BY DEPLOYMENT | list/detail/status code; audited read gated by readiness |
| 3 | Cancellations & Refunds (`b2c-refunds`) | admin-b2c-refunds.js | /api/admin/cancellations · admin_cancellations | customer_cancellation_admin_service, customer_refund_service → customer_cancellation_requests, customer_refund_attempts | require(REFUND_*) + require_b2c_access | refund.execute/authorize/manual/resolve_failed/reconcile | **IMPLEMENTED AND TESTED** · refund hooks runtime BLOCKED BY DEPLOYMENT (readiness on refund endpoints) | test_customer_refunds(.py/_http/_postgres) pass; maker‑checker + Approach‑C |
| 4 | Reviews & Ratings (`b2c-reviews`) | admin-b2c-reviews.js | /api/admin/reviews · admin_reviews | review admin service → customer_reviews | b2c scope | review.moderate | IMPLEMENTED, NOT FULLY TESTED · runtime BLOCKED BY DEPLOYMENT | moderate/approve/reject/reply code; no dedicated pytest |
| 5 | Live Chat / WiFi calling (`live-support`) | admin-live-support.js, webrtc-call.js | /api/admin/chat + WS · admin_chat | customer_chat_service, call_service, chat_gateway/broker → customer_conversations, _chat_messages, _chat_attachments, customer_calls | get_current_b2c_admin | chat.claim/transfer/set_status, attachment_send, document.download | IMPLEMENTED AND TESTED (isolation) · attachment paths runtime BLOCKED BY DEPLOYMENT | test_admin_chat_b2c_isolation.py pass; verify_live_chat/verify_call_management (live‑server) for behaviour |
| 6 | Communication (`b2c-communication`) | admin-b2c-communication.js | /api/admin/communication · admin_communication | communication service, customer notify/email/ticket → customer_notifications, customer_support_tickets | b2c.customers.view / **b2c.communication.send** | communication.send (in‑app/email), communication.reply | **IMPLEMENTED AND TESTED** (M2) · runtime BLOCKED BY DEPLOYMENT | 3 audited POST endpoints (admin_communication.py:161/227/323); test_b2c_communication_email/notify/ticket_reply.py pass |
| 7 | Customer Payments (`customer-payments`) | admin-b2c-* (payments view) | /api/admin/customer-payments · customer_payment_admin | customer_payment_admin_service, payment_event_service → customer_*_payments, payment_provider_events | b2c.payments.verify / view | payment.view_detail | IMPLEMENTED, NOT FULLY TESTED · runtime BLOCKED BY DEPLOYMENT | sensitive read audited; payment identity tests cover provider mapping |
| 8 | Reconciliation (`b2c-reconciliation`) | admin-b2c-reconciliation.js | /api/admin/reconciliation · admin_reconciliation | customer_payment_admin_service, supplier_guard → payment_provider_events | b2c.payments.verify | payment.verify, booking.supplier_reservation | **IMPLEMENTED, TESTS FAILING** · runtime BLOCKED BY DEPLOYMENT | test_admin_supplier_reservation_http.py — 22 FAILING (defect D2) |
| 9 | User Activity (`b2c-activity`) | admin-b2c-activity.js | /api/admin/user-activity · admin_user_activity | customer_activity_admin_service → customer_activity | b2c scope | (read) | IMPLEMENTED, NOT FULLY TESTED | read‑only; not audited‑gated |
| 10 | Catalogue — Flights (`b2c-cat-flights`) | admin-b2c-flights.js | /api/admin/catalogue · admin_catalogue | catalogue_flight_admin_service → (none stored; live Duffel) | b2c.catalogue.manage | (status read) | BY DESIGN (status‑only) | doc 3; no stored inventory |
| 11 | Catalogue — Hotels (`b2c-cat-hotels`) | admin-b2c-hotels.js | /api/admin/catalogue/hotels · admin_catalogue_hotels | catalogue_hotel_admin_service → customer_hotels, _hotel_rooms | b2c.catalogue.manage | catalogue.create/update | IMPLEMENTED, NOT FULLY TESTED · runtime BLOCKED BY DEPLOYMENT | CRUD code; no dedicated pytest |
| 12 | Catalogue — Packages (`b2c-cat-packages`) | admin-b2c-packages.js | /api/admin/catalogue/packages · admin_catalogue_packages | catalogue_package_admin_service → customer_packages, _itinerary, _departures | b2c.catalogue.manage | catalogue.create/update | IMPLEMENTED, NOT FULLY TESTED · runtime BLOCKED BY DEPLOYMENT | package_departures/month‑validation tests cover rules partially |
| 13 | Catalogue — Destinations (`b2c-cat-destinations`) | admin-b2c-destinations.js | /api/admin/catalogue/destinations · admin_catalogue_destinations | catalogue_destination_admin_service → customer_destinations, _locations, _attractions | b2c.catalogue.manage | catalogue.create/update | IMPLEMENTED, NOT FULLY TESTED · runtime BLOCKED BY DEPLOYMENT | CRUD + reorder code |
| 14 | B2C Reports (`b2c-reports`) | admin-b2c-reports.js | /api/admin/b2c-reports · admin_b2c_reports | reports + export_service | b2c.reports.view/export + customer.view | report.preview, report.export | IMPLEMENTED, PARTLY TESTED · runtime BLOCKED BY DEPLOYMENT | preview durable‑audit tested in test_b2c_admin_readiness.py; export not unit‑tested |
| 15 | B2C Analytics (`b2c-analytics`) | admin-b2c-analytics.js | /api/admin/b2c-analytics · admin_b2c_reports | analytics | b2c.reports.view + customer.view | (read) | IMPLEMENTED, NOT FULLY TESTED | code present |
| 16 | B2C Admin Audit trail | (audit view) | /api/admin/b2c-audit · b2c_audit | customer_admin_audit_service → customer_admin_audit_logs | b2c.audit.view | (reads trail) | **IMPLEMENTED AND TESTED** · **BLOCKED BY DEPLOYMENT** | test_b2c_audit_api/events/readiness pass; table needs 0095 |
| 17 | Email communication | admin-b2c-communication.js | /api/admin/communication (email send) | SMTP email service → customer_support_tickets/notifications | b2c.communication.send | communication.send(email) | **IMPLEMENTED AND TESTED** (M2) · runtime BLOCKED BY DEPLOYMENT | test_b2c_communication_email.py pass (incl. SMTP‑failure handling) |
| — | Gaming Tour (hidden) | admin-gaming-enquiries.js | /api/admin/gaming-tour-enquiries · gaming_tour_enquiries | gaming_tour_enquiry_service → gaming_tour_enquiries | (404 gate) | n/a | DISABLED BY DESIGN | test_gaming_fail_closed.py pass; nav hidden; API 404; data preserved |

### Coverage of the 18 requested domains (roll‑up)
Dashboard ✔(B2B) · Merchant management ✔(B2B) · Customer management ✔(B2C, M1 tested) · Flights ✔(by‑design status‑only) · Hotels/Packages ✔(B2C CRUD) · Tour packages ✔ · Booking management ✔(both) · Payments ✔(both) · Refunds ✔(B2C hardened+tested) · Reconciliation ⚠(tests failing — D2) · Reviews ✔(B2C) · Support tickets ✔(both) · Live chat & calling ✔(B2C, isolation tested) · Notifications ✔(both) · Email communication ✔(M2 tested) · Audit logs ✔(B2B live; B2C blocked on 0095) · Reports ✔(both) · User & role management ✔(RBAC tested).

---

## Part 3 — Prioritized Defect Register

| ID | Issue | Affected screen | Frontend file | Backend file | API endpoint | Severity | Recommended fix | Regression tests required |
|---|---|---|---|---|---|---|---|---|
| D1 | `test_token_revocation.py` — 22 tests failing; token/force‑logout revocation not green (underpins logout + M1 block force‑logout) | Profile / Auth / B2C Customers (block) | admin/index.html (login/session) | app/auth/security.py, auth/deps.py, services/auth_service.py, customer_auth_service.py | /api/auth/*, force_logout paths | **High** | Diagnose the 22 failures (pre‑existing); fix the revocation logic or the tests; confirm block's `force_logout_at` truly invalidates live tokens | Re‑green test_token_revocation.py; add a block→token‑rejected E2E |
| D2 | `test_admin_supplier_reservation_http.py` — 22 tests failing; reconciliation supplier‑reservation attestation path not green | Reconciliation | admin-b2c-reconciliation.js | app/routers/admin_reconciliation.py, services/supplier_guard, customer_payment_admin_service | /api/admin/reconciliation/* | **High** | Diagnose the 22 failures; fix attestation/idempotency or update tests; confirm no double‑confirm | Re‑green the file; add idempotent‑resolution assertion |
| D3 | B2C admin audit table undeployed (0095 unapplied) → **all** audited B2C mutations/sensitive reads return 503 at runtime (M0 readiness gate) | All audited B2C screens (customers, bookings, refunds, catalogue, reviews, payments, reconciliation, reports, chat attachments, communication) | admin-b2c-*.js | alembic/versions/0095_customer_admin_audit_logs.py, services/b2c_admin_readiness.py | all `require_audit_ready` endpoints | **High (deployment)** | Apply 0095 + DBA grants on the single Postgres DB (separate approval); verify append‑only trigger + readiness flips true | Post‑deploy: audit‑write smoke on each area; append‑only UPDATE/DELETE rejection |
| D4 | Runtime connects as DB **owner/superuser**; no least‑privilege runtime role (audit REVOKEs inert; blast radius = whole DB) | Whole portal (infra) | — | app/database/session.py, deploy/staging/docker-compose.staging.yml | — | **Medium (SECURITY)** | Implement role separation per docs/STAGE_3_DATABASE_ROLE_SEPARATION_FINAL_SPECIFICATION.md (migration vs runtime roles) | Privilege verification checklist; B2B/B2C smoke under restricted role |
| D5 | Admin nav **not scope‑filtered** — B2B‑only admins see B2C items and get 403s on use (UI only; backend enforces) | Sidebar nav | assets/js/admin.js | — | — | **Low (UX)** | Filter sidebar by `/api/auth/me` role + `b2c.*` grants (Track B) | verify_customer_portal nav assertions; a B2B‑only‑admin nav test |
| D6 | Operational provisioning — existing non‑super admins need explicit `b2c.*` grants or B2C screens 403 after Stage 1 | All B2C screens | — | app/auth/rbac.py (ROLE_PERMISSIONS) | — | **Medium (ops)** | Grant `b2c.*` to intended operators (data step, no migration); confirm super‑admin is the only all‑access seed | Permission‑isolation tests already cover the boundary |
| D7 | Verify the **production super‑admin seed password was rotated** (repo ships a default seed mechanism; `ADMIN_SEED_PASSWORD`/random‑on‑first‑boot) | Auth/Profile | — | backend seed + backend.staging.env.example | — | **Medium (SECURITY, verify)** | Confirm (out‑of‑band, no secrets) the live super‑admin and demo merchant logins are not repo defaults; rotate if so | N/A (ops verification) |
| D8 | No dedicated automated tests for most **B2B** screens (merchant CRUD, dashboard, wallet, providers, booking‑ops, reports, analytics, notifications, support) — only live‑server `verify_*` | All B2B screens | admin/index.html | app/routers/* (B2B) | B2B endpoints | **Medium** | Add HTTP‑level pytest (SQLite harness) for the core B2B mutations, or run `tests/run_all.py` against a staging server and record results | New B2B pytest; recorded verify_* run |
| D9 | No KYC/AML/sanctions screening module (both domains) — only payment‑provider/supplier guards | (none) | — | — | — | **Low/Scope** | Scope separately if the business requires screening | N/A until scoped |
| D10 | Cosmetic gaming web residuals (e.g. `packages.html` footer / search‑tab link to the redirecting gaming page) | Public pages (not admin) | frontend/packages.html, booking-card.js | — | — | **Low (cosmetic)** | Remove residual links; gaming stays functionally disabled | verify_footer; link check |

---

## Part 4 — Top 10 highest‑priority issues (ranked)
1. **D3 — Deploy migration 0095 (+ DBA grants).** The entire B2C audit layer and every audited B2C action are inert (503) until this runs. Highest value‑for‑effort; needs DB‑execution approval.
2. **D1 — Fix token‑revocation failures (22).** Security‑adjacent; block/force‑logout correctness depends on it.
3. **D2 — Fix reconciliation supplier‑reservation failures (22).** Money‑path attestation must be green before staging sign‑off.
4. **D4 — Database role separation (least privilege).** Removes the owner/superuser runtime posture; makes the audit REVOKEs meaningful.
5. **D7 — Verify/rotate the production super‑admin (and demo) credentials.** Cheap, high‑impact security verification.
6. **D6 — Provision `b2c.*` grants** to the intended operators so B2C screens are usable post‑Stage‑1.
7. **D8 — Add B2B automated test coverage** (or record a green `tests/run_all.py` against staging) so "tested" is evidenced, not assumed.
8. **D5 — Scope‑filter the admin nav** (Track B) so B2B‑only admins don't hit 403 walls.
9. **D10 — Remove cosmetic gaming residuals** on public pages.
10. **D9 — Decide on a screening/KYC module** (scope separately if required).

## Part 5 — Recommended implementation order
1. **Deploy enablement (approval‑gated):** D3 (apply 0095 + grants on the single DB) → immediately exercise each audited B2C area on staging (closes the "BLOCKED BY DEPLOYMENT" status).
2. **Green the suite:** D1 then D2 — drive the two failing test files to green (they are the only non‑green areas); add the block→token‑rejected and idempotent‑reconcile assertions.
3. **Security hardening:** D4 (role separation per the final spec) and D7 (credential verification/rotation), then D6 (grant provisioning).
4. **Test‑evidence & UX:** D8 (B2B automated coverage / recorded verify run), then D5 (nav scope‑filter).
5. **Cleanup/scope:** D10 (cosmetic residuals), D9 (screening — scope separately).

Rationale: unblock the already‑built, already‑tested B2C value first (D3), then restore a fully green suite (D1/D2) before any sign‑off, then reduce security blast radius (D4/D7/D6), then raise test evidence and polish UX, and finally cleanup and net‑new scope.

---

*Read‑only audit. Statuses rest on named repository evidence; "tested" means an automated test that runs in the suite (unit/HTTP on SQLite), not browser/live‑DB E2E — those (`tests/verify_*.py`) were not run here. No code/DB/migration/deploy changes; single database preserved; Gaming disabled; Stage 4 not started; production readiness not claimed. Nothing marked tested on the basis of code existence alone, and no missing functionality or test result was invented (gaps and failing‑test counts are stated as found).*
