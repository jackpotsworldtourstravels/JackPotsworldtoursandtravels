# Phase 2 — Flights depth (in progress)

**Date:** 2026-11-26 · Branch `claude/jackpots-world-mmt-integration-0518cf` (Phase 1 checkpoint `547e93c` preserved).

## 1. Audit: current flight stack
- **Supplier switch** (`flight_supplier_service.py`): `demo` (default, client-side sample data) | `duffel` (real adapter, dormant — no token) | `tbo` (now ported — see §3).
- **Existing flow is already mature** (`customer_bookings.py`, `customer_booking_service.py`, `schemas/customer_booking.py`):
  one-way / round-trip / multi-city (`MultiSegmentBookingCreate`, segment table migration 0096), seat selection, add-ons (baggage/meals/services), full passenger details, price breakdown + markup/festival, coupons, checkout + reconcile (Razorpay/HDFC), PNR honest-null, My Trips with per-leg segments.
- **Advanced search filters + sorting** already exist client-side (`flight-filters.js`, `filter-engine.js`) — time/stops/airline/price/duration/baggage/refundable, plus the Phase 1-era fare-type facet (disabled-with-reason until supplier data).

### Gaps vs. the Phase 2 brief
| Feature | Before Phase 2 | Status |
|---|---|---|
| One-way / round-trip / multi-city | ✅ exists | keep |
| Filters + sorting | ✅ client-side | keep (fare-family facet pending real data) |
| **GST information** | ❌ absent | ✅ **done this increment** |
| Fare families + fare rules | ❌ absent | pending (TBO FareQuote/FareRule) |
| Seat maps | endpoint exists (demo) | TBO seat/SSR wiring pending |
| Meals / baggage / ancillaries | ✅ add-ons (demo) | TBO SSR wiring pending |
| Passenger details | ✅ exists | keep |
| Price breakdown + fare revalidation | ✅ breakdown; ✅ `revalidate_offer_tbo` (FareQuote) | booking-path wiring pending |
| Booking / ticketing / cancellation | ✅ internal flow | TBO Book/Ticket/Cancel wiring pending |
| My Trips | ✅ exists | keep |

## 2. Critical honesty note — no live TBO data in this branch
This branch had **no TBO adapter**; per your decision it was **ported from `claude/epic-sutherland-097651`** (commit cherry-picked as `2b5093d`, its migration renumbered `0101→0103`). The adapter is **client/schema/mapper-complete** for the whole Air spine, but:
- **No TBO credentials, no sandbox hosts, no IP whitelist** → no live TBO call can be made or verified (documented in `docs/TEKTRAVELS_INTEGRATION_STATUS.md`).
- The customer booking **flow still runs on `demo`**; selecting `FLIGHT_SUPPLIER=tbo` **fails closed at checkout** until the booking-path wiring lands.
- Therefore Phase 2 builds the **features + TBO parameter mapping** (testable with mocked payloads, like the 27 existing adapter tests); **live supplier data is gated on ops**, not code.

## 3. Feature → actual TBO Air API mapping (requirement 4)
Based on the ported adapter (`app/integrations/tbo/`) and `docs/TEKTRAVELS_FLIGHT_API_SPEC.pdf`. These are the TBO methods the adapter already exposes:

| Phase 2 feature | TBO API | Handle / key fields |
|---|---|---|
| Search (1-way/RT/multi-city) | **Search** | `Segments[]` (Origin, Destination, FlightCabinClass, PreferredDepartureTime); `JourneyType` 1=OneWay 2=Return 3=MultiStop; `TraceId` + `ResultIndex` identify an offer |
| Filters/sorting | (client-side over Search results) | `IsLCC`, `Stops`, `AirlineCode`, `Fare.PublishedFare`, `Duration`, baggage in `FareBreakdown` |
| Fare rules | **FareRule** | `TraceId` + `ResultIndex` → `FareRuleDetail` (cancellation/date-change rules text) |
| Fare families / revalidation / price breakdown | **FareQuote** | `TraceId` + `ResultIndex` → re-priced `Fare` (`BaseFare`, `Tax`, `OtherCharges`), `IsPriceChanged`, `IsLCC`; fare-family variants in the FareQuote response |
| Seat map + meals + baggage | **SSR** | `TraceId` + `ResultIndex` → `SeatDynamic` (seat map), `MealDynamic`, `Baggage` arrays |
| Passenger + **GST** | **Book** / **Ticket** | `Passengers[]` (Title, FirstName, LastName, PaxType, DateOfBirth, Passport*, Gender); **GST**: `GSTCompanyAddress`, `GSTCompanyContactNumber`, `GSTCompanyName`, `GSTNumber`, `GSTCompanyEmail` ← our `gst_*` columns map 1:1 |
| Booking (LCC vs non-LCC) | **Book** then **Ticket** (non-LCC) / **Ticket** direct (LCC) | branch on FareQuote `IsLCC`; `PNR`, `BookingId` returned |
| Retrieve | **GetBookingDetails** | `BookingId` / `PNR` |
| Cancellation | **SendChangeRequest** + **GetChangeRequestStatus** + **GetCancellationCharges** | `ChangeRequestId`; charges before confirm |

## 3b. Mock-tested vs. live-TBO-verified (explicit separation)
Everything in §4 items 1–2 below is **mock-tested** — proven against the
documented TBO contracts and canned payloads, exactly like the adapter's own unit
tests. **Nothing is live-TBO-verified**: TBO sandbox access (hosts + IP whitelist
+ credentials) is unavailable, so in this environment `tbo_available()` is False
and every TBO booking operation **fails closed**. The demo supplier is the default
and is unchanged.

## 4. Done in Phase 2 so far
1. **TBO adapter ported** (`2b5093d`): `integrations/tbo/` (flight) + `integrations/tbo_hotel/` (Phase 3), supplier switches, migration `0103`, 27 adapter tests. Migration chain relinearised to a single head.
2. **GST information** (commit `ab98682`): `gst_*` columns (migration `0104`), `GstInput`/`GstResponse` with GSTIN validation, persistence on one-way + multi-segment, traveller-step UI, confirmation/ticket display, 9 tests. Maps 1:1 to TBO Book GST fields.
3. **TBO booking-path integration — items 2–5** (this increment): `tbo_flight_booking_service` (pure orchestration) + `tbo_reservation_service` (DB-aware resolver), fail-closed behind the supplier switch.
   - **Item 2 — fare families & rules:** `fare_quote()` (re-priced fare + `IsLCC`/refundable/required-field flags + fare-family breakdown + price-change guard) and `fare_rules()` (FareRule verbatim), routed via `flight_supplier_service.fare_rules()`.
   - **Item 3 — SSR / ancillaries:** `ancillaries()` maps SSR → `{seats, meals, baggage, unsupported}`; an un-returned group is named unsupported, never invented. Routed via `flight_supplier_service.seat_map()` under `tbo`.
   - **Item 4 — Book / Ticket / GetBookingDetails:** `reserve()` = FareQuote → LCC `Ticket` or Non-LCC `Book`→`Ticket` → `GetBookingDetails`. **Idempotent** (reconciles, never re-books, when an order id exists; write-timeout resolves via GetBookingDetails(TraceId), never a retry). `resolve_reservation()` reserves a HELD booking and confirms it through the existing `complete_reservation` — the payment path is untouched; `supplier_guard` now supports `tbo` and maps its exceptions.
   - **Item 5 — cancellation & reconciliation:** `request_cancellation()` (SendChangeRequest → ChangeRequestId) and `reconcile_cancellation()` (GetChangeRequestStatus → refund settled only on TBO status 4 / `RefundedAmount`).
   - **Tests:** 17 orchestration (success/failure/timeout/retry/duplicate/price-change/LCC vs Non-LCC/cancel/reconcile) + 7 DB resolver (confirmed/held/fail-closed/supplier-error/idempotent/demo-not-tbo/passenger-map). Mock-only.

## 5. Remaining Phase 2 work (next: items 6–8)
- **Item 6 — payment-to-ticketing verification:** trace capture→hold→reserve→confirm end-to-end.
- **Item 7 — one-way / round-trip / multi-city** flow coverage through the TBO path.
- **Item 8 — full regression + limitations doc.**
- **Live-only (ops-blocked):** the automatic post-capture trigger for `resolve_reservation` activates when TBO creds/hosts/IP land; forwarding GST into the live TBO Book body; fare-family UI on the fare rail.

## 6. Limitations (explicit)
- No fabricated supplier data: demo flights remain clearly sample; preview facets stay disabled-with-reason until real data backs them.
- Live TBO flights require ops: sandbox base URLs, server IP whitelisting, and sandbox credentials. Until then, TBO is unavailable and the app runs on `demo` exactly as before.
- Migrations `0103`/`0104` verified on SQLite via tests; run up/down on disposable Postgres before deploy.

**Not deployed. Phase 2 lands as commits after `547e93c`, separate from Phase 1.**
