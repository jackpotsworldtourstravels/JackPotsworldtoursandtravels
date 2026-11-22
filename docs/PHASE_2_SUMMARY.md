# Phase 2 — Multi-Segment Flight Booking: Implementation Summary

**Date:** 2026-11-20 · **Worktree (isolated, uncommitted):** `phase-2-booking-segments-e6a6b0`
**Scope:** Bug 2 (multi-city) + Bug 5 (round-trip). Nothing committed, pushed, merged or deployed.

## What this phase did
Grew `customer_bookings` from a one-flight model into an **envelope that owns 1..N
segments** (one flight = the N=1 case), wired the frontend booking data flow to the
new multi-segment endpoint, and proved all three journey types end-to-end.

## Fixes made this session
1. **`booking-products.js` — dangling `ROUND_TRIP_HOLD` export removed.** Phase 2 deleted
   the constant (round-trip is now bookable) but still exported the name → ReferenceError
   that broke the whole module at load. Removed from the export; `checkoutHold` (the real
   seam) is unchanged and still exported.
2. **Idempotency fingerprint bug (found via browser E2E, fixed).** `submitFingerprint`
   hashed `ctx.item.id` but NOT `ctx.returnItem`/`ctx.legs`. Before Phase 2 that was safe
   (round-trip was blocked, so the first flight uniquely identified a one-way booking).
   Now a one-way and a round-trip sharing the same outbound flight/date/party in one
   session produced the SAME idempotency key → the server would dedupe the 2nd submit to
   the 1st booking. Added journey shape (`returnItem.id`, `legs[].id`) to the fingerprint.
3. **`flowDraft` exposed on the export** as a test seam (behaviour-neutral), consistent
   with the file's stated export philosophy.
4. **Migration 0096 downgrade safeguard added.** `downgrade()` now counts bookings with
   `journey_type <> 'one_way'` and logs a WARNING naming how many will lose their non-first
   legs before dropping anything (non-destructive; only reads + logs). The lossy case was
   already documented in the docstring and MULTI_SEGMENT_BOOKING.md.

## Evidence
### Browser E2E (real modules, browser pane) — 4/4 PASS
Drove the real `booking-api.js` / `booking-store.js` / `booking-products.js` through
`flowDraft → BookingStore.create → BookingApi → (mock server, faithful per-leg repricing)
→ fromApi → render`, with mocked payment reconcile and disposable **bookable** flights.
- **One-way** → `POST /bookings`, single `flight`, 1 segment, total ₹5,500, confirmed.
- **Round-trip** → `POST /bookings/multi-segment`, 2 ordered segments, total ₹11,000.
- **Multi-city** → `POST /bookings/multi-segment`, 3 ordered segments (HYD→DEL→BOM→GOA),
  total ₹16,500; My Bookings read-back shows all legs ("+2 more", full route).
- **Sample flight stays blocked**: `checkoutHold` holds, `flowDraft` refuses to build;
  a non-sample flight is NOT held.
- Idempotency keys now distinct across the three journeys.

### Backend
- **49 passed**: `test_multi_segment_http.py` (14 real-HTTP, TestClient), plus
  `test_multi_segment_booking.py` + `test_booking_row_name_composition.py`.
- **Full regression: 1,725 passed, 11 skipped, 1 failed.** The one failure,
  `test_every_public_api_route_is_rate_limited`, fails `len(routes) > 40` (discovers 0
  routes) and **fails identically on a clean no-Phase-2 checkout** — a pre-existing broken
  route-discovery test (dedicated `fix-route-discovery-test` branch exists). No Phase 2
  regression.

### Migration 0096 (live, disposable Postgres 18)
- `upgrade head` applied (0094 → 0096); `customer_booking_segments` + `journey_type`
  created; backfill gives each existing booking one index-0 segment.
- `downgrade` fired the safeguard warning ("1 multi-segment booking(s) will lose their
  non-first legs…"), dropped table + column, retained the envelope HYD→GOA summary.
- `re-upgrade` + backfill restored a single segment. Clean round-trip.

## Review findings (data layer ready; display surfaces are the remaining work)
The backend + `fromApi` carry every segment (per-leg itinerary, fare, pnr, status).
These consumers do NOT yet render per-segment detail:
- **Multi-city booking has no customer-interface trigger.** Only `data-tx-book` (one-way)
  and `data-tx-book-trip` (round-trip, passes `returnItem`) exist; nothing passes
  `ctx.legs`/`ctx.segments` to `BookingFlows.open`. The builder + API + backend support
  multi-city (proven), but the UI can't start one yet (code comment: "a FUTURE multi-city
  builder supplies ctx.legs").
- **My Bookings** shows the journey only via title ("+N more") + multi-stop subtitle;
  `my-bookings.js` does not iterate `b.segments` (its `segment` var is a product filter).
- **Confirmation screen & e-ticket/voucher** (`booking-ticket.js`) show the envelope
  summary / envelope PNR only — no per-leg breakdown or per-segment PNR.
- **Multi-segment add-ons** are written only to `segment.addons_json`, not to
  `customer_booking_addons`, so envelope `BookingResponse.addons` is empty for a
  round-trip/multi-city booking (one-way writes both). Seats: first segment's seat maps to
  the per-passenger column; later legs carry none until per-leg selection exists.
- **Segment `status`** is not advanced on confirm/cancel (envelope status is source of
  truth); `segment.status` stays `pending` after a booking is confirmed.
- **Migration downgrade** remains lossy by design for >1-segment bookings (now warned).

## Isolation
All changes confined to `phase-2-booking-segments-e6a6b0` (8 modified, 5 new files),
uncommitted. Other worktrees untouched. Disposable Postgres container removed.

---

## Follow-up wiring (same session) — multi-city trigger + per-segment display

The gaps above are now closed (still uncommitted, same worktree):

- **Multi-city booking trigger** (`travel-explore.js`): each per-leg pick now keeps the
  whole flight (stamped with that leg's date); a **"Book this trip"** CTA appears under the
  leg nav once every leg is chosen (hidden/blocked if any chosen leg is a sample flight).
  Pressing it assembles `ctx.legs` and calls `BookingFlows.open('flight', leg0, { legs })`.
- **Booking flow** (`booking-flows.js`): the flight flow now accepts `legs` — builds
  `ctx.segments` for the review (so it lists every leg; `rvSegments`/`rvTripLabel` already
  handled N segments), sets a multi-city summary title/subtitle, and **prices every leg**
  via the same server quote endpoint and sums them (`mergeQuoteList`), seats/add-ons/coupon
  on the first leg only — matching the backend's own repricing contract.
- **My Bookings** (`my-bookings.js`): the booking detail now renders a **"Flights (N legs)"**
  panel listing each leg with its own route, carrier, date and per-segment PNR.
- **E-ticket** (`booking-ticket.js`): a round-trip/multi-city ticket renders **one route
  block per leg**, each with its own per-segment PNR (pending until a GDS issues one).

### Evidence
- Booking-flow browser E2E still **4/4** (one-way, round-trip, multi-city, sample-block).
- New display harness — **5/5**: multi-city booking has 3 segments; My Bookings detail lists
  all 3 legs; e-ticket renders a route block + PNR per leg; flow review itinerary shows
  every leg (HYD/DEL/BOM/GOA).
- All 7 changed JS files pass `node --check`; the 49 Phase 2 backend tests still pass.

### Still open (not in this scope)
- Per-leg **seat/add-on selection** in the UI (today the UI collects seats/add-ons for the
  first leg only; later legs carry none — the draft and backend already support per-leg).
- Multi-segment add-ons are stored in `segment.addons_json`, not `customer_booking_addons`,
  so envelope `BookingResponse.addons` stays empty for multi-segment bookings.
- Segment-level `status` is not advanced on confirm/cancel (envelope status is source of truth).

---

## Follow-up 2 (same session) — per-leg seats/add-ons + envelope add-on rows

- **Backend**: `create_multi_segment_booking` now writes `CustomerBookingAddon` rows at
  the envelope (aggregated across legs), so a round-trip/multi-city booking's `addons`
  is populated exactly like a one-way's — closing the earlier "envelope addons empty" gap.
  Per-leg detail still lives in each segment's `addons_json`. Two new backend tests
  (per-leg envelope rows; one-way has no duplicate row).
- **Per-leg contract** (`booking-api.js` + `booking-products.js` + `booking-flows.js`):
  new `seatPayloadForLeg` / `addonPayloadForLeg` read per-leg selections; `flowDraft`'s
  multi payload and the multi-city quote now price and submit **each leg's own** seats and
  add-ons (not first-leg-only). Fully backward compatible — a one-way/round-trip flow with
  flat `ctx.seats` / `ctx.addons` is byte-identical.
- **Seat step** (`booking-flows.js`): a **per-leg "Flight" selector** on multi-leg journeys
  — switching legs re-fetches that leg's seat map and edits that leg's seats (`ctx.seatsByLeg`,
  with `ctx.seats` aliased to the active leg so toggles persist per leg).
- **Add-on step** (`booking-products.js`): the per-sector tabs now **actually scope the
  selection** — each add-on is tagged with its sector (leg); `addonsForLeg` filters by it;
  the previously inert **"Apply to all flights"** switch now copies a leg's picks to the
  others. Untagged add-ons default to leg 0, so one-way/round-trip are unchanged.

### Evidence
- New **contract harness — 11/11**: `seat/addonPayloadForLeg` return the right per-leg
  selections; the draft's 3 segments each carry their own seat + add-on (leg0 seat 12A +
  baggage, leg1 none, leg2 seat 7C + meal); one-way flat selections unchanged.
- Booking-flow harness **4/4**, display harness **5/5** still green; all 7 JS files pass
  `node --check`; **51** Phase 2 backend tests pass.
- Not screenshot-verified: the live seat-map-per-leg and add-on-sector UIs need the running
  SPA + catalogue; the data contract they drive is verified above.

### Still open
- Segment-level `status` is not advanced on confirm/cancel (envelope status is source of truth).
