# PR: MakeMyTrip-style marketplace — Phase 1 (Service Registry) + Phase 2 (Flights/TBO)

> Draft PR description. **Not opened and not merged** — awaiting approval.
> Base: `main` · Head: `claude/jackpots-world-mmt-integration-0518cf` · Base commit `a50027a`.

## Summary
Two controlled phases of a MakeMyTrip-style marketplace, built on the premium JackPots World identity, with a hard honesty rule throughout: **no fabricated supplier data, and no live supplier claimed without verification.** The demo flight supplier and the DB hotel/package catalogues remain the default and are unchanged; everything TBO is behind a credential-gated switch that **fails closed**.

## Phase 1 — Global Admin Service Registry
The architectural backbone: one customer-facing service registry with admin control and backend enforcement.
- `ServiceRegistry` model + seed of 11 services (flights, hotels, villas, packages, trains, buses, cabs, activities, visa, forex, insurance).
- Admin API `/api/admin/services` (list / patch / reorder) behind new scopes `b2c.services.view` / `b2c.services.manage`; every write audited (fail-closed `CustomerAdminAuditLog`).
- Controls: enable/disable (master), nav + homepage visibility, order, maintenance mode (+ message), provider + honest integration status (live/preview/enquiry/coming_soon).
- Public `GET /api/services` feed drives the customer service navigation dynamically (`service-directory.js`, with a static fallback).
- Enforcement on flight/hotel/package **search + new-booking** endpoints (disabled → 403, maintenance → 503, missing row → fail-open); **existing bookings (view/pay/cancel/reconcile) are never gated.**
- Admin Service Management screen in the admin SPA.
- `MerchantServiceAccess` (B2B per-merchant entitlement) left untouched.
- Adopted the frontend preview foundation (6 new service pages + marketplace shell + nav/footer), all stamped PREVIEW and enquiry-handoff.

## Phase 2 — Flights depth (TBO)
- **TBO adapter ported** from `epic-sutherland` — full Air spine (Search/FareRule/FareQuote/SSR/Book/Ticket/GetBookingDetails/Cancel) + hotel adapter (Phase 3 groundwork).
- **GST** business-invoice details end-to-end (capture → persist → confirmation/ticket), mapped 1:1 to TBO `Book` GST params.
- **TBO booking-path integration (items 2–5)**: fare families & rules, SSR/ancillaries, Book/Ticket/GetBookingDetails (idempotent, write-timeout → GetBookingDetails not retry), cancellation + reconciliation — all **fail-closed, mock-tested**.
- **Lifecycle verification (items 6–7)**: full PENDING → capture → held → reserve+ticket → CONFIRMED transition with the payment staying CAPTURED throughout; one-way / round-trip / multi-city all reach ticketed.

## Commit hashes (on top of base `a50027a`)
| Commit | Scope |
|---|---|
| `547e93c` | Phase 1 — service registry + admin management |
| `2b5093d` | Phase 2 — TBO flight+hotel adapter port |
| `ab98682` | Phase 2 — GST end-to-end |
| `6907fa0` | Phase 2 — TBO booking-path (items 2–5) |
| `afd5bf7` | Phase 2 — payment-to-ticketing + journey-type verification (items 6–8) |

## Database migrations (additive, nullable; single linear chain)
`0100 → 0101 → 0102 → 0103 → 0104` (single head). New in this PR:
- **`0102_service_registry`** — `service_registry` table + seed of 11 services (all enabled).
- **`0103_hotel_supplier_references`** — 10 nullable supplier/voucher columns on `customer_hotel_bookings` (Phase 3 groundwork; came with the port).
- **`0104_flight_booking_gst`** — 5 nullable `gst_*` columns on `customer_bookings`.

**Verified up → down → up on PostgreSQL 18** (disposable container, matching prod): full chain upgrades; registry seeds 11 rows; 5 GST + 3 hotel columns present; downgrade `0104→0101` drops them cleanly; re-upgrade re-seeds. Also green on the SQLite test engine.

## Test results — four distinct verification categories

### 1. Backend automated tests (SQLite engine)
- **Full backend regression: 3094 passed, 33 skipped, 0 failed.**
- **64 new tests**: service registry (16) + admin services HTTP/RBAC/audit/gate (15) + GST (9) + TBO flight adapter (27, ported) + TBO hotel adapter (ported) + TBO orchestration (17) + TBO DB resolver (7) + payment-to-ticketing & journey types (4).
- TBO scenarios: success, failure, timeout, retry, duplicate/idempotent, price-change, LCC vs Non-LCC, cancel, reconcile, fail-closed.

### 2. PostgreSQL migration verification (real PG18, not SQLite)
- Disposable `postgres:18-alpine` (matches prod). **Full chain `upgrade head` succeeds**; `service_registry` seeds 11 rows in order; 5 `gst_*` + 10 hotel supplier columns present.
- **`downgrade 0104 → 0101` drops them cleanly**; **re-`upgrade head` re-seeds** → up/down/up proven for `0102`, `0103`, `0104`.

### 3. Browser / UI tests (live app, desktop 1440 + mobile 390)
Driven against a live stack (uvicorn + PG18 + seeded admin/customer; `FLIGHT_SUPPLIER=demo`, no payment gateway). **All scenarios passed at both widths; no defects found.**
| Scenario | Result |
|---|---|
| Homepage + dynamic service nav | ✅ nav built from live `GET /api/services` (11 services) at 1440 & 390 |
| 6 preview service pages (buses/trains/cabs/villas/forex/insurance) | ✅ marketplace shell, PREVIEW stamps, honest "supplier integration preview" notice |
| Flights search + results | ✅ "SAMPLE SCHEDULE" badge; demo results client-side |
| Flights traveller flow | ✅ reached the Traveller Details step |
| Admin Service Management | ✅ screen renders (KPIs, 11 rows, toggles/order/maintenance/integration); **live**: disable buses → removed from public feed, maintenance trains → listed+flagged, both restored |
| GST input + validation | ✅ card renders, toggle reveals fields, GSTIN forced uppercase, server-side GSTIN validation (tested); responsive single-column at 390 |

**Browser/UI NOT exercised end-to-end:** GST **submission → confirmation → ticket display** was not driven live, because it needs a captured payment and the test env has **no payment gateway configured** (and production payments are out of scope). The GST ticket/confirmation *rendering* (`gstBlockHtml`) and the `gst` block on `BookingResponse` are covered by backend tests; the flight **results-card → fare** click path was exercised programmatically (demo flight) rather than by clicking a result card. All 12 changed JS files pass `node --check`.

### 4. Live TBO verification — **STILL BLOCKED**
No live TBO call of any kind was made or verified. Sandbox hosts + whitelisted server IP + credentials are unavailable, so `tbo_available()` is False and every TBO op fails closed. All TBO functionality is **mock-tested only (category 1)**, never TBO-verified.

### Screenshots captured (this session)
Homepage (1440 + 390), Buses preview (1440), Admin Service Management (1440 + 390), Flights results (1440), GST card open (1440 + 390). Saved in the session's browser tool-results.

## Pre-PR audit results (10 checks)
1. ✅ Migrations `0101–0104` form one valid **linear** chain (single head `0104`).
2. ✅ Up/down verified on **PostgreSQL 18**, not only SQLite.
3. ✅ No changes to payment-provider code, the hotel booking service, or merchant/existing-admin code — modified existing files gained only enforcement deps, GST, and TBO routing (backward-compatible).
4. ✅ RBAC scopes present and in **no role default** (super admin implicit; others explicit grant).
5. ✅ Registry enable/disable + maintenance enforcement correct (403/503/fail-open), tested.
6. ✅ TBO cannot activate demo as real data or claim unverified bookings — `demo` default, `tbo_available()` requires selection **and** credentials, `_is_ticketed` requires real BookingId + success + every ticket number, demo search returns an explicit `provider:"demo"` envelope.
7. ✅ GST persisted (one-way + multi-segment) and displayed (confirmation/ticket), tested.
8. ✅ Payment/ticketing/cancellation/refund states consistent — confirm path untouched; resolver uses the existing `complete_reservation`; refund settled only on TBO status 4; money stays captured through a hold.
9. ✅ Existing bookings remain accessible — enforcement deps only on search + create, never on view/pay/cancel/reconcile.
10. ✅ Browser/UI verified on the **live app at 1440 + 390** — homepage dynamic nav, 6 preview pages, flights search + traveller flow, Admin Service Management (incl. live enable/disable/maintenance against the feed), and the GST form; no defects. One gap: GST **submission→confirmation→ticket** not driven live (needs a payment gateway; out of scope) — covered by backend tests instead.

## Known limitations
- **No live TBO** in this branch: sandbox hosts + whitelisted server IP + credentials are unavailable, so `tbo_available()` is False and every TBO operation fails closed. Everything TBO is **mock-tested, not TBO-verified.**
- The **automatic post-capture trigger** for `resolve_reservation` is intentionally not auto-enabled (gated on live verification); the resolver is built, idempotent and tested.
- GST is stored + mapped but **not yet forwarded into the live TBO `Book` body**; fare-family/SSR data is returned by the service layer but **not yet surfaced in the flight UI**.
- Phase 2 service pages beyond flights/hotels/packages remain **preview/enquiry** (buses/trains/cabs/villas/activities/visa/forex/insurance) — no live supplier.

## TBO live-verification requirements (ops)
Before TBO can be switched on and certified:
1. **Sandbox base URLs** from TBO's Postman collection → `TBO_SHARED_BASE_URL`, `TBO_AIR_BASE_URL`, `TBO_HOTEL_*_BASE_URL`.
2. **Server public IP whitelisted** with TBO → `TBO_END_USER_IP`.
3. **Sandbox credentials** → `TBO_CLIENT_ID`, `TBO_USERNAME`, `TBO_PASSWORD`.
4. Then `FLIGHT_SUPPLIER=tbo` (and/or `HOTEL_SUPPLIER=tbo`) and run the certification flows (Authenticate → Search → FareRule → FareQuote → SSR → Book → Ticket → GetBookingDetails). See `docs/TEKTRAVELS_INTEGRATION_STATUS.md`.

## Deployment
1. Merge to `main` (do **not** change supplier env vars — `FLIGHT_SUPPLIER` stays `demo`, `HOTEL_SUPPLIER` stays `catalogue`).
2. Run `alembic upgrade head` (applies `0102`, `0103`, `0104` — all additive/nullable; the registry seeds itself enabled, so storefront behaviour is unchanged on apply).
3. Grant `b2c.services.view` / `b2c.services.manage` to the admins who should manage services (they are in no role default).
4. No supplier credentials are added; TBO stays dormant/fail-closed until ops completes the live-verification steps above.

## Rollback
- **Code:** revert the five commits (or the merge). The migrations are backward-safe to leave in place (all columns nullable; registry unused by the old code).
- **Schema (if required):** `alembic downgrade 0101_customer_notif_prefs` drops `service_registry`, the 5 `gst_*` columns and the 10 hotel supplier columns — verified clean on PostgreSQL 18. Because every added column is nullable and the registry is additive, a code-only rollback without a schema downgrade is also safe.
- No data migration is destructive; no existing row is modified by any of the three migrations.
