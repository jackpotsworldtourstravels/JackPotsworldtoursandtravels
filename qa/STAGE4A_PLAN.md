# Stage 4A — Playwright Browser Automation: Planning Report

**Planning only.** No Stage-4 implementation, no application code change, no commit/push/deploy. This
plan extends the existing `qa/playwright/` scaffold (committed in `478f016`) and the isolated env
(`jpw_qa`@`localhost:5435`, app on `:8099`). It builds on the Stage-2 inventory (400 endpoints, role
map) and the two verified fixes (`f7345ad`). Flight/hotel supplier APIs stay dormant; no real
payments/OTPs/refunds/notifications; local seeded data only; never production.

---

## 0. Surface discovered (evidence base)

| Portal | Shell | View modules (where) | Approx views |
| --- | --- | --- | --- |
| Public B2C site | 34 top-level `*.html` | `assets/js/*` (booking-card, search-widgets, pax/rooms-selector, jw-header, site-footer, account-center, live-chat, webrtc-call, …) | ~34 pages |
| Customer portal | `customer/dashboard.html` (+ index/register/reset) | `customer/js/*` (core, dashboard, password, register) | 5 pages |
| Admin | `admin/index.html` (SPA) | `assets/js/admin-*` + `admin-b2c-*` (~30) | **~30 views** |
| Super Admin | `super-admin/index.html` (SPA) | `assets/js/super-admin-*` (6) | ~4 views |
| Merchant (modern) | `merchant/index.html` (SPA) | `assets/js/partner-*` (+ `mh-*` helpers) | ~11 views |
| Manager | `manager/index.html` (SPA) | `assets/js/manager-portal.js` | ~1–2 views |
| Operations | `operations/index.html` (SPA) | `operations/js/ops-*` (11) | ~10 views |
| Merchant Classic | `merchant-classic/index.html` (SPA) | `merchant-classic/js/classic-*` (21) | **~19 views** — still supported |

Forms are mostly JS-driven cards, not `<form>` tags (flights/hotels have 0 `<form>`); the booking card
(`booking-card.js`) is the single most reused interactive component. Public auth pages
(`login/register/forgot/reset`, `portal-login`, `partner-login`) are the entry points.

Existing coverage to reuse (not rebuild): `tests/js/browser/` CDP suite (23 files, Chromium visual),
`frontend/tests` + `tests/js` node suites (169 cases), the 51-script `verify_*` HTTP E2E, and the
`qa/playwright` scaffold (conftest, 8 viewports, page objects, api_seed fixtures, smoke test).

---

## 1. Complete browser-test inventory (what Stage 4 will build)

Organized as Playwright spec groups under `qa/playwright/e2e/<portal>/`:

- **public/** — landing render + hero, header service-nav, footer links, booking card (flights/hotels/
  packages tabs, pax/rooms selectors, search→results), destinations/package detail, my-bookings,
  policy/SEO pages render, 404, ticket-verify.
- **customer/** — register→OTP(dev-echo)→login→dashboard; profile edit; saved travellers CRUD; wishlist;
  notifications; account-center tabs; guest session + claim; booking draft (demo/seeded data); e-ticket
  view/QR; payment screen in **sandbox/none** (no real charge).
- **admin/** (largest) — login; dashboard/analytics; B2C: customers, bookings (+status), catalogue
  hotels/packages/destinations/flights, reviews, refunds, reconciliation, communication, activity,
  reports/exports; B2B: enquiries, manual-booking, booking-ops queue, change-requests, providers,
  payment-requests, customer-payments, logs, live-support, gaming-enquiries.
- **super_admin/** — login; dashboard; admin management (create/edit/role); RBAC matrix; reports; profile.
- **merchant/** (modern) — login; home/dashboard; service-request + ticket-enquiry; request-history;
  payments; reports; wallet view; live-chat; notifications; profile.
- **manager/** — login; approval queue; approve/reject a booking request.
- **operations/** — login; dashboard; inventory; requests; finance; directory; insight; support; settings.
- **merchant_classic/** — login; dashboard; enquiry(+hotel); booking(+detail/hotel); approvals; holidays;
  visa; wallet; payments; reports; history; passport-ocr; support; account; assistant.
- **cross_portal/** — the X-journeys (below).
- **visual/**, **a11y/** — screenshot baselines and axe scans (Stage-8 wiring, specs authored in 4).

Each spec runs under `@pytest.mark.e2e` + `require_server` so it **skips** (never fails) without the
isolated env.

## 2. Page-by-page / component-by-component coverage matrix (plan)

Status legend: **P1/P2/P3** = implementation priority; coverage asserted per view = render + no console
errors + key interactive controls + (where applicable) an API round-trip.

| Area | Views / modules | Interactive targets | Priority |
| --- | --- | --- | --- |
| Public booking card | booking-card, search-widgets, pax/rooms-selector, search-persist | tab switch, pax stepper, date pick, Search→results, result card | **P1** |
| Public pages/SEO | 34 html, site-footer, jw-header | nav links, footer links, 404, ticket-verify form | P2 |
| Customer auth/account | customer-core/dashboard/register/password, account-center | register/OTP/login/logout, profile save, traveller CRUD, wishlist | **P1** |
| Customer booking + e-ticket | my-bookings, booking-api/store, eticket | open booking, download/view e-ticket, QR | P2 |
| Customer payment (sandbox) | payment screens | initiate → sandbox success/fail/cancel (provider=none/sandbox) | P2 |
| Admin B2C ops | admin-b2c-* (14) | list/filter/sort, detail, status PATCH, moderation, export | **P1** |
| Admin B2B ops | admin-* (16) | enquiry→quote→booking, booking-ops queue/assign, providers CRUD | P2 |
| Super admin | super-admin-* (6) | create admin, edit role, RBAC matrix, reports | P2 |
| Merchant modern | partner-* (11) | service request, ticket enquiry, history filters, wallet, reports | **P1** |
| Manager | manager-portal | approval queue, approve/reject | P2 |
| Operations | ops-* (11) | dashboard, inventory, requests, finance, directory | P3 |
| Merchant Classic | classic-* (21) | enquiry/booking/approvals/wallet/visa/holidays/support | P3 (confirm still shipped) |

A machine-readable `qa/playwright/coverage.json` will be generated at Stage-4 start from a runtime DOM
walk (role/label/testid census per rendered view) to turn this plan into exact leaf-component counts.

## 3. User journey & cross-portal workflow map

Reuses the Stage-2 workflows (`qa/WORKFLOW_INVENTORY.md`), now as UI journeys:
- **Customer:** C1 register→OTP→login · C3 profile/travellers · C4 flight search→assistant→draft ·
  C5 hotel · C6 package · C7 sandbox payment · C8 my-bookings/e-ticket.
- **Admin:** A2 customer mgmt · A3 booking-ops · A6 catalogue CRUD · A7 reviews/comms.
- **Merchant:** M-2 enquiry→quote→booking→approval · M-3 wallet.
- **Cross-portal (the high-value set):**
  - X1 customer booking → appears in admin customer-bookings.
  - X2 admin status change → reflected in customer My Bookings.
  - X3 payment status consistent customer↔admin↔webhook (sandbox).
  - X4 cancellation→refund status consistent customer↔admin.
  - X5 invoice/e-ticket content matches booking record.
  - X6 merchant enquiry→booking→manager/merchant approval→wallet debit.

Each cross-portal spec **seeds via API** (one role) and **asserts in the UI** (another role), using
per-role storage states.

## 4. Playwright architecture & page-object strategy

Build on the existing scaffold:
```
qa/playwright/
  conftest.py            # extend: per-role storage_state fixtures, per-worker data namespace
  viewports.py           # 8 viewports already defined
  pages/                 # BasePage + public + portal shells exist; ADD per-view objects:
    public/  (LandingPage, BookingCard, Results, MyBookings, AuthForms)
    admin/   (AdminShell + view objects: Customers, Bookings, Catalogue, Reviews, ...)
    merchant/, manager/, super_admin/, operations/, classic/
  fixtures/
    api_seed.py          # extend: data builders (customer, enquiry, booking, merchant) via API
    auth.py (new)        # storage_state creation per role
  e2e/<portal>/          # specs (Section 1)
  visual/ a11y/          # Stage-8 specs
```
- **Page objects:** one shell object per SPA + one object per meaningful view; prefer
  `get_by_role/label/text`; add `data-testid` only where a stable hook is missing — proposed as a tiny,
  **separately-approved**, attributes-only frontend change (never auto-applied, not in 4A).
- **Fixtures:** session-scoped per-role `storage_state` (sign in once, reuse the token/cookies) to avoid
  burning the login rate limit (the Stage-3 flake); function-scoped data builders.

## 5. Authentication & role-session strategy

- **Roles:** customer, admin, admin2, super_admin, manager, merchant (modern + classic). Reuse
  `tests/config.py` seeded accounts + the Aurora/Blueline merchants (env-overridable); customer via
  register + **dev-OTP echo** (`OTP_DEV_ECHO=true`) — **no real OTP**.
- **Storage state:** create each role's `storage_state` once per session via the API/login (saved under
  `qa/playwright/.auth/<role>.json`, git-ignored), injected into contexts. This both speeds specs and
  sidesteps the per-IP auth rate limit that caused `verify_customer_portal` flakiness.
- **Mixed login paths:** staff/merchant use `/api/auth/login`+verify-otp; customer uses
  `/api/customer/auth/*`. The 403-on-missing-bearer / 401-on-invalid contract (Finding A1) is asserted
  as-is, not changed.

## 6. Test-data & database-isolation strategy

- **Target:** only `jpw_qa` @ `localhost:5435`, app `:8099`. The fail-closed `qa/scripts/check_db_safety.py`
  gate runs before any suite. Never production, never the other project DBs (5433/5434).
- **Isolation:** each spec/worker namespaces its data (unique emails/refs via a per-worker prefix) and
  builds what it needs through the API (reusing `tests/flows.py` patterns), rather than depending on
  shared rows. Playwright workers kept at 1–2 locally to bound the shared auth rate limit.
- **Cleanup:** per-run DB is disposable (`docker rm` recreates); optional per-spec teardown deletes the
  rows it created. No destructive ops on shared/seed rows. No migrations beyond `upgrade head`.
- **Payments:** `PAYMENT_PROVIDER=none` (or a provider's sandbox with test keys on localhost only) — no
  real charge/refund; `verify_payments`-style safety guard respected.

## 7. Screenshot / video / trace / failure-reporting strategy

- Already configured in `qa/playwright/pytest.ini`: `--screenshot=only-on-failure
  --tracing=retain-on-failure --video=retain-on-failure --output=artifacts` (git-ignored).
- **Report:** pytest-playwright HTML + `--junitxml`/JSON; failures carry screenshot + trace.zip + video +
  console/network dumps (via `collect_console` fixture, extended with network capture).
- **Stage-9 aggregator** merges Playwright JSON + pytest-json + node TAP + axe JSON + Lighthouse JSON into
  `qa/report/index.html` + the coverage matrix.

## 8. Browser & viewport coverage

- **Engines:** Chromium (primary, every PR), Firefox + WebKit (nightly/on-label). The existing CDP
  Chromium suite stays as-is alongside.
- **Viewports (already in `viewports.py`):** desktop 1920×1080 / 1440×900 / 1366×768; tablet 1024×768 /
  768×1024; mobile 430×932 / 390×844 / 360×800. Full 8-viewport sweep on public + each portal shell;
  workflow specs on desktop-1440 + mobile-390 to bound CI time.

## 9. Accessibility & visual-regression strategy

- **a11y (Stage-8 dep `axe-playwright-python`, not installed in 4A):** axe scan per route; record
  violations with page/element/rule-id; start as warnings, gate later.
- **Visual regression:** `expect(page).to_have_screenshot()` per project/viewport; **baselines created
  only from a reviewed, approved render** (a human approves the PNGs in a PR) — never auto-blessed;
  dynamic regions (dates, prices, availability) masked. Baselines committed under
  `qa/playwright/__snapshots__/`.

## 10. CI integration plan

- New GitHub Actions job **`ui-e2e`** (after `backend-tests`): spin up `postgres:18-alpine` service,
  `alembic upgrade head` + seed the role accounts, boot the app, `playwright install chromium`, run
  `qa/playwright -m e2e` with `PYTHONUTF8=1`; upload traces/videos/screenshots as artifacts.
- **Per PR:** Chromium + mobile smoke + the P1 journeys. **Nightly/on-label:** Firefox/WebKit, full
  viewport sweep, visual baselines, a11y. The existing 3 CI jobs are untouched.
- No secrets required (synthetic env + throwaway Postgres), matching the current CI.

## 11. Prioritized implementation roadmap (Stage 4 execution, on approval)

- **4A.1 — Harness hardening:** storage-state auth fixtures, per-worker data namespace, network capture,
  coverage.json DOM-walk generator. (Unblocks everything; removes the rate-limit flake.)
- **4A.2 — P1 smoke across all 7 portals:** each shell loads, authenticates, renders its default view,
  zero console errors. Fast, broad safety net.
- **4A.3 — P1 journeys:** customer register→login→dashboard→booking draft; admin B2C customer/bookings;
  merchant service-request; public booking card.
- **4A.4 — Cross-portal X1–X6** (the highest-value, currently-uncovered set).
- **4A.5 — P2 breadth:** admin B2B, super-admin, manager, remaining customer/merchant views.
- **4A.6 — P3:** operations, merchant-classic (pending "still supported" confirmation).
- **4A.7 — Visual baselines (reviewed) + a11y scans** (Stage-8 deps).
- **4A.8 — CI `ui-e2e` job + Stage-9 report aggregator.**

## Missing coverage & risks

| # | Risk / gap | Impact | Mitigation |
| --- | --- | --- | --- |
| R1 | **Per-IP auth rate limit** (5/min signup, 10/min login) — caused `verify_customer_portal` flake | UI specs that log in repeatedly will 429 and flake | storage-state reuse (log in once/role), ≤2 workers, backoff; do NOT change the limit |
| R2 | **No stable `data-testid` hooks** on many SPA controls | brittle selectors | prefer role/label; propose a separate, approved attributes-only PR for gaps (not in 4A) |
| R3 | **SPA view count underestimated by page count** (admin ~30 views in one html) | plan may undercount specs | coverage.json DOM-walk census before committing counts |
| R4 | **Flight/hotel are demo/seeded, suppliers dormant** | some flows can't complete "real" bookings | assert against seeded/demo data only; never activate Duffel/Hotelbeds |
| R5 | **Payments** must stay sandbox/none | risk of real charge | `PAYMENT_PROVIDER=none`/sandbox-on-localhost, safety guard; never live keys |
| R6 | **Merchant Classic (21 modules) support status** unconfirmed | wasted effort if deprecated | confirm with you before P3 classic specs; modern merchant is primary |
| R7 | **Customer dev-OTP** must stay dev-only | risk of real OTP send | `OTP_DEV_ECHO=true` on isolated env only; never on a deployed host |
| R8 | **Visual baseline churn** (dynamic dates/prices) | false diffs | mask dynamic regions; human-approved baselines only |
| R9 | **CI time** with 3 engines × 8 viewports × many specs | slow PRs | Chromium+mobile per PR, rest nightly |
| R10 | **WebSocket features** (live-chat, voice/webrtc) in-process only without Redis | flaky under parallelism | single worker for those specs, or a throwaway Redis; keep WEB_CONCURRENCY=1 |

## Constraints honored by this plan
No supplier API integration; no real payments/refunds/OTPs/notifications; local seeded data only; never
production; both commits (`f7345ad`, `478f016`) preserved; no app code changed; nothing committed/pushed/
deployed; Stage 4 not implemented. Awaiting approval before any implementation.
