# Missing Test Coverage Report — Stage 2

Three kinds of gap: (A) endpoints with **no mapped automated test**, (B) areas covered **only by
E2E scripts that cannot run as fast isolated tests** and cannot run here at all until the Option-A
env exists, and (C) **whole QA capabilities that do not exist yet** (cross-browser, visual baselines,
accessibility, page performance, API fuzzing, security scan, consolidated report).

## A. Endpoints with no mapped test (48) — the true coverage holes

| Router | Count | Endpoints | Severity |
| --- | ---: | --- | --- |
| `admin_catalogue_destinations.py` | 7 | destinations + locations CRUD | **High** — write path, admin data integrity |
| `admin_catalogue_packages.py` | 7 | packages, itinerary, departures CRUD | **High** |
| `admin_catalogue_hotels.py` | 5 | hotels + rooms CRUD | **High** |
| `hotel_enquiries.py` | 7 | hotel enquiry submit/review/respond, direct booking | **High** — customer-facing write path |
| `admin_customer_bookings.py` | 4 | list/counts/detail/status PATCH | **High** — booking status mutation |
| `admin_reviews.py` | 4 | review moderation list/detail/analytics/PATCH | Medium |
| `gaming_tour_enquiries.py` | 4 | customer submit + admin review/respond | Medium |
| `admin_user_activity.py` | 3 | summary/logs/sessions (audit) | Medium |
| `profile.py` | 3 | staff `/api/profile` get/put/heartbeat | Medium |
| `admin_catalogue.py` | 2 | flight supplier view, catalogue images | Low |
| `customer_admin.py` | 2 | admin view of customers list/detail | Medium |

**Priority 1 for Stage 3 tests:** admin catalogue CRUD (21 endpoints) and admin customer-booking
status mutation (4) — these are write/mutation paths with zero automated coverage, the highest risk.

## B. Fast-test gaps — covered only by live-server E2E (213 endpoints)

These areas have an E2E `verify_*` script but **no fast pytest**, so a regression only surfaces when
the full live suite runs. Worth back-filling with isolated pytest (API-level, against the Option-A DB):

| Area (router) | Endpoints | Only coverage today |
| --- | ---: | --- |
| `tickets.py` | 23 | `verify_api`, `verify_passenger_lookup` |
| `admin_chat.py` | 15 | `verify_live_chat`, `verify_support_center` |
| `support_tickets.py` | 13 | `verify_support_center` |
| `merchants.py` | 12 | `verify_merchant_*` |
| `customer_chat.py` | 10 | `verify_live_chat` |
| `wallet.py` | 10 | `verify_cr4a/b/c` |
| `booking_ops.py` | 9 | `verify_m1*`, `verify_booking_completion` |
| `change_requests.py` | 9 | `verify_m3` |
| `group_bookings.py` | 9 | `verify_group_booking` |
| `providers.py` | 8 | `verify_providers` |
| (others) | ~95 | `auth`, `enquiries`, `manager*`, `merchant_*`, `finance`, `documents`, `notifications`, `analytics`, `reports`, `dashboard`, `admin_*` |

All of section B is currently **BLOCKED** in this session (no live backend). The Option-A env is the
unblock; once it exists, `tests/run_all.py` should run green and this column becomes executable.

## C. Missing QA capabilities (no code exists)

| Capability | Status | Proposed owner (stage) |
| --- | --- | --- |
| Cross-browser E2E (Firefox/WebKit) | none — CDP is Chromium only | Playwright, Stage 3 |
| Screenshot visual-regression baselines | none — CDP asserts pixels-as-numbers, not images | Playwright `toHaveScreenshot`, Stage 4 |
| Responsive E2E on the 8 required viewports | partial (CDP responsive-*), not the full page set | Playwright projects, Stage 4 |
| Accessibility (axe-core) | none | axe-core + Playwright, Stage 8 |
| Page performance (Lighthouse, LCP/CLS/INP) | none | Lighthouse CI, Stage 8 |
| API property/fuzz testing (Schemathesis on `/openapi.json`) | none | Schemathesis, Stage 6 |
| Security scan (OWASP ZAP baseline) | none (guards + RBAC unit only) | ZAP baseline, Stage 8 |
| Explicit IDOR / cross-tenant tests (merchant↔merchant, customer↔customer) | none | pytest API, Stage 6 |
| Consolidated HTML + JSON QA report & coverage matrix | none | report aggregator, Stage 9 |

## D. Cross-portal consistency (Phase-7)

No single test asserts a record created in one portal appears correctly in another (customer booking
→ admin view → merchant record → invoice/e-ticket content). Pieces exist inside separate `verify_*`
scripts but not as end-to-end consistency assertions. This is a **GAP** and a primary Stage-5 target.

## E. Recommended Stage-3+ test-build priority

1. **Admin catalogue CRUD** pytest (21 endpoints, section A) — highest risk, zero coverage.
2. **Admin customer-booking status + hotel/gaming enquiry** pytest (section A write paths).
3. **Stand up Option-A env** and get `tests/run_all.py` green (unblocks 213 endpoints / section B).
4. **Playwright scaffold** + smoke E2E for the 7 cross-portal workflows (section D).
5. **Schemathesis** over `/openapi.json` (section C, API fuzz) against the Option-A DB.
6. **axe-core + Lighthouse** on the public B2C pages and each portal shell.
7. **ZAP baseline** + explicit IDOR tests.
8. **Consolidated report** aggregating pytest + node + Playwright + axe + Lighthouse into HTML/JSON.
