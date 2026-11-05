# Business Workflow Inventory — Stage 2

Each workflow lists the portal(s), the step sequence, the APIs touched, and the existing coverage
(and whether that coverage can run here). "BLOCKED" means an E2E script exists but needs the
Option-A live env to execute.

## Customer workflows

### C1 — Register → verify OTP → sign in
Portal: Public/Customer. Steps: register → OTP (dev-echo on test host, **no real SMS/email**) →
login → token. APIs: `/api/customer/auth/{register,verify,login,refresh,logout}`.
Coverage: `verify_customer_portal.py`, `verify_guest_session.py` (E2E, BLOCKED); `test_google_auth.py` (unit, green).

### C2 — Guest "continue as guest" session
Steps: start guest session → browse/search → convert on sign-in. APIs: `/api/customer/auth/guest`.
Coverage: `verify_guest_session.py` (E2E, BLOCKED).

### C3 — Profile + saved travellers + account center
Steps: update profile → add/edit traveller (middle name, contact separation) → wishlist/notifications.
APIs: `/api/customer/profile`, `/api/customer/travellers/*`, `/api/customer/account/*`.
Coverage: `test_saved_traveller_*` (unit, green), `saved-travellers*` JS (green), `verify_customer_portal` (E2E, BLOCKED).

### C4 — Flight search → assistant → booking
Steps: search (airports, pax, dates) → results → assistant/voice refine → select → passenger details →
booking draft. APIs: `/api/customer/assistant`, flight search/booking under `/api/customer/*`.
Coverage: `test_flight_conversation.py`, `test_travel_assistant_voice.py` (unit, green); `round-trip`, `flight-filters`,
`travel-assistant` CDP+JS (green); `verify_travel_assistant_routing.py` (E2E, BLOCKED).

### C5 — Hotel search → room select → booking
APIs: `/api/customer/hotel-bookings/*`, `/api/customer/hotel-catalog`.
Coverage: `test_hotel_provider_images.py`, `test_hotel_trust_signals.py` (unit); CDP hotel results (green); E2E BLOCKED.

### C6 — Package catalogue → departure → booking
APIs: `/api/customer/package-bookings/*`, `/api/customer/package-catalog`.
Coverage: `test_package_departures.py` (unit); `verify_package_catalogue.py` (E2E, BLOCKED).

### C7 — Payment (sandbox/mock only)
Steps: initiate → gateway (sandbox) → success/fail/cancel → status sync → webhook.
**No real payments** — provider default `none`; sandbox requires explicit opt-in + customer allowlist.
APIs: customer payment endpoints, `/api/webhooks/*`, `/api/payment-returns`.
Coverage: extensive unit (`test_payment_*`, `test_sandbox_*`, `test_*_test_key_guard`) green; `verify_payments.py`,
`verify_trustbrick_payments.py` E2E BLOCKED.

### C8 — My Bookings → e-ticket / PDF / QR
APIs: `/api/customer/bookings`, `/api/tickets/*`, eticket owner/public routers.
Coverage: `test_eticket.py` (unit, green); `verify_m2/m7` E2E BLOCKED.

### C9 — Cancellation → refund visibility
APIs: `/api/customer/cancellations`, change-requests.
Coverage: `verify_m3.py` (E2E, BLOCKED). **Fast-test GAP.**

### C10 — Reviews / support tickets / live chat / travel assistant
APIs: `/api/customer/chat`, `/api/support/*`, reviews.
Coverage: `verify_live_chat.py`, `verify_voice_calls.py`, `verify_support_center.py` (E2E, BLOCKED).

## Admin workflows

### A1 — Admin sign-in + dashboard + analytics
APIs: `/api/auth`, `/api/dashboard`, `/api/analytics`, `/api/admin/b2c-reports`.
Coverage: `verify_m6.py` (E2E, BLOCKED). Fast-test GAP.

### A2 — Customer management (list/view/bookings/status)
APIs: `/api/admin/customers`, `/api/admin/customer-bookings/*`.
Coverage: **GAP** (no mapped test).

### A3 — Booking operations (queue, assign, notes, references) — M1
APIs: `/api/admin/booking-ops/*`, `/api/admin/ops/*`.
Coverage: `verify_m1.py`, `verify_m1_concurrency.py`, `verify_booking_completion.py` (E2E, BLOCKED).

### A4 — Cancellation & reschedule review — M3
APIs: `/api/admin/cancellations`, change-requests.
Coverage: `verify_m3.py` (E2E, BLOCKED).

### A5 — Payment desk / requests / reconciliation
APIs: `/api/admin/payment*`, `/api/admin/reconciliation`, customer-payment-admin.
Coverage: `verify_cr4d.py`, `verify_payment_requests.py` (E2E, BLOCKED); sandbox/identity guards unit green.

### A6 — Catalogue administration (hotels / packages / destinations CRUD)
APIs: `/api/admin/catalogue/*` (21 endpoints).
Coverage: **GAP** — highest-value untested admin surface.

### A7 — Review moderation / communication logs / user-activity audit
APIs: `/api/admin/reviews`, `/api/admin/communication`, `/api/admin/user-activity/*`.
Coverage: communication → `verify_m5` (BLOCKED); reviews + user-activity → **GAP**.

### A8 — Merchant management
APIs: `/api/admin/merchants/*`.
Coverage: `verify_merchant_no_approval.py`, `verify_merchant_ui_parity.py` (E2E, BLOCKED).

### A9 — Providers (suppliers bought FROM) + finance + reports + chat desk
APIs: `/api/admin/providers`, `/api/finance`, `/api/reports`, `/api/admin/chat`.
Coverage: `verify_providers`, `verify_m4`, `verify_m6`, `verify_support_center`/live-chat (E2E, BLOCKED).

### A10 — Super-admin: RBAC, admin management, role matrix
APIs: `/api/super-admin/*`.
Coverage: `test_rbac.py` (unit, green); portal E2E GAP.

## Merchant workflows

### M-1 — Merchant sign-in + dashboard (modern + classic shells)
APIs: `/api/merchant/*`, `/api/auth`.
Coverage: `verify_merchant_ui_parity.py` (E2E, BLOCKED).

### M-2 — Enquiry → quotation → booking request → approval
APIs: `/api/enquiries`, `/api/bookings/*`, `/api/merchant/approvals`, `/api/manager/*`.
Coverage: `verify_cr3.py` (merchant self-approve), `verify_cr2.py`/`verify_manager_approval.py` (manager sign-off),
`verify_cr5.py` (quotation), `verify_manual_booking_unquoted.py` (E2E, BLOCKED).

### M-3 — Wallet: balance, ledger, add money, credit limit, auto-debit at ticket issue
APIs: `/api/merchant/wallet`, `/api/wallet/*`.
Coverage: `verify_cr4a/b/c.py` (E2E, BLOCKED).

### M-4 — Booking history, ticket delivery, invoice/report downloads — M7
APIs: `/api/merchant/*`, eticket, documents.
Coverage: `verify_m7.py` (E2E, BLOCKED).

### M-5 — Team management + merchant-tenant isolation
APIs: `/api/merchant/team/*`.
Coverage: `verify_merchant_team`-related in parity (E2E, BLOCKED). **Explicit cross-tenant IDOR test = GAP.**

## Cross-portal consistency workflows (Phase-7 targets, mostly BLOCKED/GAP)

| Flow | Assertion | Coverage |
| --- | --- | --- |
| X1 | Customer booking appears in admin customer-bookings | partial via `verify_api`/`verify_m*`; GAP end-to-end |
| X2 | Admin-approved change reflected in customer booking detail | GAP |
| X3 | Payment status consistent across customer + admin + webhook | unit guards green; cross-portal E2E BLOCKED |
| X4 | Cancellation/refund status consistent customer↔admin | `verify_m3` BLOCKED |
| X5 | Invoice/e-ticket content matches booking record | `verify_m2` BLOCKED |
| X6 | Merchant wallet debit matches ticket-issue event | `verify_cr4b` BLOCKED |
