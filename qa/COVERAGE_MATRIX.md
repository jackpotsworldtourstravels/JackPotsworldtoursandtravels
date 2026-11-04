# Application Coverage Matrix — Stage 2

Status legend: **PASS** = green automated coverage exists and ran green at baseline ·
**PARTIAL** = some layers covered, notable holes · **BLOCKED** = coverage exists but can't run
here (needs live server/seeded DB — unblocked by Option-A env) · **GAP** = no mapped automated
test · **NOT TESTED** = no coverage and not exercised.

The columns are the test layers: **PyU** = pytest unit (SQLite, fast) · **E2E** = `verify_*.py`
HTTP scripts · **JS** = node:test frontend · **CDP** = browser UI (visual/responsive) ·
**a11y/Perf/Sec** = accessibility / performance / security (none exist yet).

## Portal rollup

| Portal | Endpoints | Primary existing coverage | Status |
| --- | ---: | --- | --- |
| Public B2C site | 4 (+static) | CDP responsive/visual, SEO verify_*, JS component tests | PARTIAL |
| Customer | 114 | Strong PyU (payments, travellers, wishlist, assistant) + E2E | PARTIAL |
| Admin | 145 | E2E (`verify_m*`, cr*) + RBAC unit; catalogue CRUD uncovered | PARTIAL / GAP |
| Super-admin | 17 | `test_rbac.py` unit | PARTIAL |
| Manager | 10 | E2E (`verify_cr2`, `verify_manager_approval`) | BLOCKED |
| Merchant | 25 | E2E (`verify_cr3/4*`, merchant parity, wallet) | BLOCKED |
| Webhook | 1 | PyU (`test_payment_webhook_router`) + E2E trustbrick | PARTIAL |

## Feature-area matrix

| # | Feature area | PyU | E2E | JS | CDP | a11y | Perf | Sec | Overall |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| 1 | Customer auth / OTP / Google / guest | ✅ | ✅ | – | – | ✗ | ✗ | ◑ | PARTIAL |
| 2 | Customer profile / account center | ◑ | ✅ | ✅ | – | ✗ | ✗ | ✗ | PARTIAL |
| 3 | Saved travellers / passenger lookup | ✅ | ✅ | ✅ | – | ✗ | ✗ | ✗ | PASS* |
| 4 | Wishlist / recently viewed / reviews | ✅ | ◑ | ✅ | – | ✗ | ✗ | ✗ | PARTIAL |
| 5 | Flight search + conversation/assistant | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ | PASS* |
| 6 | Hotel search / booking / provider images | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ | PARTIAL |
| 7 | Package catalogue / departures | ✅ | ✅ | – | ✅ | ✗ | ✗ | ✗ | PARTIAL |
| 8 | Enquiry → quotation → booking (B2B) | – | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 9 | Hotel / gaming enquiries | ✗ | ✗ | – | – | ✗ | ✗ | ✗ | **GAP** |
| 10 | Group bookings (spreadsheet) | – | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 11 | Payments (B2C gateway, sandbox guards) | ✅ | ✅ | ✅ | – | ✗ | ✗ | ✅ | PASS* |
| 12 | Payment providers (TrustBrick/HDFC/Razorpay) | ✅ | ✅ | ✅ | – | ✗ | ✗ | ✅ | PASS* |
| 13 | Webhooks / returns / payment sweep | ✅ | ✅ | – | – | ✗ | ✗ | ◑ | PARTIAL |
| 14 | Wallet / ledger / credit (merchant) | – | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 15 | Booking operations (M1 queue/assign) | – | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 16 | E-ticket / invoice / confirmation PDFs | ✅ | ✅ | – | – | ✗ | ✗ | ✗ | PARTIAL |
| 17 | Cancellation & reschedule (M3) | ✗ | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 18 | Refunds / payment requests | ◑ | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 19 | Finance / billing (M4) | – | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 20 | Notifications / communication (M5) | ◑ | ✅ | – | – | ✗ | ✗ | ✗ | PARTIAL |
| 21 | Analytics / reports / dashboard (M6) | ✗ | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 22 | Merchant onboarding / team / parity | ✗ | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 23 | Manager approval (CR-2) | ✗ | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 24 | Providers (suppliers we buy from) | ✗ | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 25 | Admin catalogue CRUD (hotels/pkgs/dest) | ✗ | ✗ | – | – | ✗ | ✗ | ✗ | **GAP** |
| 26 | Admin customer mgmt / bookings / reviews | ✗ | ✗ | – | – | ✗ | ✗ | ✗ | **GAP** |
| 27 | Admin user-activity / audit | ✗ | ✗ | – | – | ✗ | ✗ | ✗ | **GAP** |
| 28 | Live chat / chat desk | – | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 29 | Voice calls / call management (CR-10) | – | ✅ | ✅ | – | ✗ | ✗ | ✗ | BLOCKED |
| 30 | Support center / tickets | ✗ | ✅ | – | – | ✗ | ✗ | ✗ | BLOCKED |
| 31 | Passport OCR / documents / storage | ◑ | ✅ | ✅ | – | ✗ | ✗ | ✗ | PARTIAL |
| 32 | RBAC / roles / permissions | ✅ | ✅ | – | – | ✗ | ✗ | ◑ | PARTIAL |
| 33 | SEO (canonical/OG/JSON-LD/footer) | – | ✅ | – | ✅ | – | – | – | BLOCKED |
| 34 | Responsive / layout / visual | – | ✅ | – | ✅ | ✗ | ✗ | – | PARTIAL |
| 35 | Profile (staff `/api/profile`) | ✗ | ✗ | – | – | ✗ | ✗ | ✗ | **GAP** |

Legend within cells: ✅ covered · ◑ partially covered · ✗ not covered · – not applicable.
`PASS*` = green at the fast-test baseline we ran; the E2E portion is BLOCKED until the live env exists.

## Cross-cutting status

| Capability | State |
| --- | --- |
| Cross-browser (Firefox/WebKit) | **GAP** — CDP is Chromium-only |
| Screenshot visual-regression baselines | **GAP** — CDP asserts measurements, not image diffs |
| OpenAPI property/fuzz testing (Schemathesis) | **GAP** |
| Accessibility (axe-core) | **GAP** — none |
| Page performance (Lighthouse) | **GAP** — none |
| Load (k6/locust) | locust exists, staging-only, **not run** |
| Security scan (OWASP ZAP) | **GAP** — guards/RBAC tested, no scan |
| Consolidated HTML+JSON QA report | **GAP** |
| Live-server E2E executable here | **BLOCKED** → Option-A env (see `LOCAL_ENV_SETUP_PLAN.md`) |
