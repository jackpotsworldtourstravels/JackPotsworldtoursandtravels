# Page → Component → API Map — Stage 2

Built from the `<script src>` graph of each page plus router prefixes. The portal dashboards are
**single-page shells**: one `index.html` loads many JS *view* modules (e.g. `ops-*`, `super-admin-*`,
`classic-*`, `mh-*`). Exhaustive per-widget enumeration (every button/input/modal with its state
machine) is a **runtime** job and is deferred to Stage 4, where a Playwright+axe DOM walk emits the
leaf-component list per rendered view. This map is the structural skeleton that walk will fill in.

## Shared UI components (used across pages)

| Component / module | Location | Role |
| --- | --- | --- |
| `jw-header.js`, `site-footer.js`, `hero-shell.js` | assets/js | Global chrome, nav, hero |
| `booking-card.js`, `search-widgets.js` | assets/js | The shared search/booking card (flights+hotels+results) |
| `pax-selector.js`, `rooms-selector.js`, `search-persist.js` | assets/js | Passenger/room pickers, search state persistence |
| `profile-menu.js`, `notification-bell.js`, `account-center.js` | assets/js | Signed-in header widgets |
| `toast.js`, `spinner.js`, `confirm-dialog.js`, `focus-trap.js` | components/ | Reusable dialogs/feedback |
| `live-chat.js`, `webrtc-call.js` | assets/js | Live chat + voice calling widgets |
| `auth.js`, `api.js`, `formatters.js` | assets/js, shared/ | Token handling, fetch wrapper, formatting |
| `booking-api.js`, `booking-store.js` | assets/js | My-bookings data layer |

## Public B2C site (34 pages + static)

| Page | Key view modules | API prefixes used |
| --- | --- | --- |
| `index.html` (10 forms) | search-widgets, booking-card, pax/rooms-selector, hero-shell, destinations | `/api/customer/*` search, `/api/public/*`, `/api/contact`, `/api/newsletter` |
| `flights.html` | booking-card, search-widgets, airports, search-persist | `/api/customer/assistant`, flight search/booking under `/api/customer/*` |
| `hotels.html` | booking-card, search-widgets, destinations | `/api/customer/hotel-*`, `/api/hotel/enquiries` |
| `packages.html`, `package.html` | jw-products, destination-images, hotel-image-map | `/api/customer/package-*`, `/api/customer/destinations` |
| `destinations.html`, `destination*.html`, `location.html`, `activities.html` | destination/location-images | `/api/customer/destinations/*` |
| `my-bookings.html` | booking-api, booking-store, account-center, live-chat, webrtc-call | `/api/customer/bookings`, `/api/customer/hotel-bookings`, `/api/customer/package-bookings`, `/api/tickets/*`, `/api/customer/chat` |
| `login/register/forgot/reset` | jw-header shells + customer auth forms | `/api/customer/auth/*` |
| `gaming-packages.html`, `visa.html`, `cruises.html` | enquiry forms | `/api/customer/gaming-tour-enquiries`, enquiry endpoints |
| policy/SEO pages (`about`, `faqs`, `contact-us`, `*-policy`, `404`, `ticket-verify`) | static + footer | `/api/tickets/verify` (ticket-verify), `/api/contact` |

## Customer portal (`frontend/customer/`)

| Page | Modules | API |
| --- | --- | --- |
| `customer/dashboard.html` | customer-core, customer-dashboard | `/api/customer/account/*`, `/api/customer/profile`, `/api/customer/travellers`, `/api/customer/recommendations`, `/api/customer/bookings*` |
| `customer/index.html`, `register/forgot/reset` | customer auth | `/api/customer/auth/*` |

## Admin SPA (`frontend/admin/index.html`, 51 modules)

Views: `admin.js` (shell) + admin-auth, admin-live-support, booking-enquiry-core, plus catalogue,
customers, bookings, payments, cancellations, reviews, communication, reports views.
APIs: the entire `/api/admin/*` surface (145 endpoints) + `/api/analytics`, `/api/reports`,
`/api/dashboard`, `/api/documents`, `/api/webhooks` (admin reconciliation).

## Merchant SPAs

| Shell | Modules | API |
| --- | --- | --- |
| `merchant/index.html` (modern) | partner-shared, mh-visuals/filters/autocomplete, hotel-image-map | `/api/merchant/*` (approvals, team, wallet), `/api/bookings/*`, `/api/enquiries` |
| `merchant-classic/index.html` | classic-shell, classic-dashboard/enquiry/booking/holidays/visa, merchant-api | same `/api/merchant/*` + enquiry/booking endpoints |

## Manager / Super-admin / Operations SPAs

| Shell | Modules | API |
| --- | --- | --- |
| `manager/index.html` | manager-portal | `/api/manager/*` (approvals) |
| `super-admin/index.html` | super-admin-dashboard/admin-management/reports/profile | `/api/super-admin/*` (RBAC, admin mgmt) |
| `operations/index.html` | ops-dashboard/inventory/requests/finance/directory/insight/support/settings | `/api/admin/*` operational subset, `/api/finance`, `/api/wallet`, `/api/providers` |

## Notes

- `login.html`/`register.html` load only the header shell; the auth form logic is inlined or pulled
  from `jw-system.js` — flagged for the Stage-4 DOM walk to confirm the actual form wiring.
- The B2C booking card is the single most reused interactive component (flights, hotels, results,
  landing) and already has the richest CDP coverage (`summary-card`, `booking-width`, `round-trip`).
