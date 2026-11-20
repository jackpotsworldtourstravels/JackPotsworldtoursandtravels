# Admin Portal Assessment — 1. Screen & Navigation Inventory

**Project:** JackPots World Tours & Travels · **Date:** 2026-11-13
**Method:** READ-ONLY static inspection of `frontend/admin/index.html` (2003 lines) + `frontend/assets/js/admin*.js` (32 modules) + `backend/app/main.py` router registration. No app/DB/config change; no migration; no PostgreSQL connection; Gaming disabled.
**Evidence tag:** every row cites the file it was read from. Completion claims are *code-presence* evidence, not runtime/production verification (see doc 5 for that caveat).

## Portal shape
One unified SPA (`frontend/admin/index.html`) with a **B2B MANAGEMENT ⇄ B2C MANAGEMENT mode toggle** (`admin.js:208-227`, `.nav-mode-toggle`). The two modes are not separate pages — they show/hide nav groups. 35 content `<section id="section-*">` panels; a left sidebar of `.nav-group`s with `.nav-item[data-section]` links (`admin.js:183-185` switches the active section). Gaming Tour Packages sub-tree is present but **hidden** (`index.html:353`, `hidden style="display:none"`).

## B2B MANAGEMENT — nav groups & screens
| Group | Screen (section id) | JS module | Primary action(s) |
|---|---|---|---|
| Overview | `reports` (Dashboard) | admin.js / admin-analytics.js | KPI tiles, recent activity |
| Merchant Management | `users` | admin.js | list/create/suspend merchants & staff, reset password |
| Merchant Management | `active-users` | admin.js | live sessions / presence |
| Operations | `ticket-enquiries` (Booking Enquiries) | admin-enquiries.js, admin-enquiry-host.js | review/approve/reject/issue enquiries |
| Operations | `partner-requests` (Approval Queue) | admin-change-requests.js | approve/return merchant booking & service requests |
| Operations | `booking-ops` (Booking Operations) | admin-booking-ops.js | booking lifecycle, documents, notes |
| Operations | `service-requests-mgmt` | admin-change-requests.js | cancellation/date-change/refund sub-requests |
| Operations | `providers` (Provider Management) | admin-providers.js | CRUD suppliers + provider users |
| Manual Booking | `manual-enquiry` | admin-manual-booking.js | raise an enquiry on behalf of a merchant |
| Manual Booking | `manual-request` | admin-manual-booking.js | raise a booking request on behalf of a merchant |
| Payments & Finance | `payments` (Payment Management) | admin-payment-requests.js, admin-customer-payments.js | view/verify/manage B2B payments |
| Payments & Finance | `wallet-desk` | admin-wallet-desk.js | top-up verification + wallet reconciliation |
| Reports & Analytics | `reports-export` | admin.js | build/download B2B reports |
| Reports & Analytics | `analytics` | admin-analytics.js | B2B analytics charts |
| System | `audit` (Audit Logs) | admin-logs.js | read trigger-written `audit_logs` (redacted) |
| System | `system-logs` | admin-logs.js | read `system_logs` activity + system-info |
| Support | `support` (Live Chat — B2B) | admin-live-support.js | B2B support tickets/chat |
| Support | `notifications` | admin-message-delivery.js | broadcast, my notifications, delivery failures |
| Account | `profile` | admin-auth.js | my profile + change password |
| (hidden) | `ticket-enquiries`→`gaming-tour-enquiries` | admin-gaming-enquiries.js | **DISABLED** — gaming queue, nav hidden, API 404 |

## B2C MANAGEMENT — nav groups & screens
| Group | Screen (section id) | JS module | Primary action(s) |
|---|---|---|---|
| Customer Management | `b2c-customers` | admin-b2c-customers.js | list + sensitive detail read (no block/reset — gap) |
| Customer Management | `b2c-bookings` | admin-b2c-bookings.js | list/detail + status change |
| Customer Management | `b2c-refunds` (Cancellations & Refunds) | admin-b2c-refunds.js | maker-checker refund, manual refund, resolve-failed |
| Customer Management | `b2c-reviews` (Reviews & Ratings) | admin-b2c-reviews.js | moderate (approve/reject/reply) |
| Support | `live-support` (Live Chat) | admin-live-support.js | queue, claim, reply, transfer, close, calls (WiFi calling), attachments |
| Support | `b2c-communication` | admin-b2c-communication.js | notifications/tickets/overview (read-only — gap) |
| Payments & Finance | `customer-payments` | admin-customer-payments.js | list + sensitive payment detail read |
| Payments & Finance | `b2c-reconciliation` | admin-b2c-reconciliation.js | verify payment, supplier reservation |
| User Operations | `b2c-activity` | admin-b2c-activity.js | activity log + sessions (read) |
| Catalogue Management | `b2c-cat-flights` | admin-b2c-flights.js | flight-supplier status only (no stored inventory — by design) |
| Catalogue Management | `b2c-cat-hotels` | admin-b2c-hotels.js | hotel + room CRUD |
| Catalogue Management | `b2c-cat-packages` | admin-b2c-packages.js | package + itinerary + departures CRUD |
| Catalogue Management | `b2c-cat-destinations` | admin-b2c-destinations.js | destination + location CRUD, reorder |
| Catalogue Management | (hidden) gaming-new/requests/converted/closed | admin-gaming-enquiries.js | **DISABLED** |
| Reports & Analytics | `b2c-reports` | admin-b2c-reports.js | report preview + export |
| Reports & Analytics | `b2c-analytics` | admin-b2c-analytics.js | B2C analytics |
| Account | `profile` (shared) | admin-auth.js | shared with B2B |

## Counts
- **B2B active screens:** 18 (+1 hidden gaming).
- **B2C active screens:** 15 (+4 hidden gaming sub-screens).
- **Shared:** `profile`.
- **Total content sections:** 35 (`id="section-*"`).
- **Admin JS feature modules:** 32 (`admin*.js`).

See doc 2 for the API/router/service/model/table trace of each screen, doc 3 for functionality verification & gaps, doc 4 for access separation, doc 5 for completion % and the roadmap.
