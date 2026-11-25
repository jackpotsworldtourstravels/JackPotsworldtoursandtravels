# TBO / TekTravels integration — status & staging

**Goal:** make TBO/TekTravels the **sole live supplier** for flights and hotels,
in a safe order — build + verify against the TBO sandbox, **then** retire the
demo/Duffel flight paths and the catalogue/Hotelbeds hotel path. The app must
never go dark: nothing existing is removed until TBO is working.

_Branch: `claude/epic-sutherland-097651`. Contracts used:
`docs/TEKTRAVELS_FLIGHT_API_INTEGRATION_GUIDE.docx` (19 APIs),
`docs/TEKTRAVELS_HOTEL_API_INTEGRATION_GUIDE.docx` (14 methods),
`docs/TEKTRAVELS_FLIGHT_API_SPEC.pdf`._

## ✅ Built in this change (adapter-complete, dormant)

| Area | What landed |
|---|---|
| Shared auth | `backend/app/integrations/tbo/shared.py` — the **only** place TBO credentials are read. Authenticate + day-scoped TokenId cache (one token serves flights **and** hotels), the HTTP core (read-retry / write-no-retry), and `is_configured()`. |
| Flight adapter | `backend/app/integrations/tbo/` — `exceptions`, `shared`, `schemas`, `client` (the Air-service spine: Search, FareRule, FareQuote, SSR, Book, Ticket, GetBookingDetails, ReleasePNRRequest, SendChangeRequest, GetChangeRequestStatus, GetCancellationCharges, GetAgencyBalance), `mapper`. LCC/Non-LCC branch read from the **FareQuote** `IsLCC`. |
| Hotel adapter | `backend/app/integrations/tbo_hotel/` — `exceptions`, `schemas`, `client` (4 host bases: shared, lite Search/PreBook, classic Book/Voucher/cancel, static content), `mapper`. Voucher-vs-hold branch from `IsVoucherBooking`. |
| Flight switch | `flight_supplier_service.py` — added `tbo` provider, `tbo_available()`, a TBO search branch, and `revalidate_offer_tbo()` (FareQuote re-price + price-change guard). Default **stays `demo`**. |
| Hotel switch (new) | `hotel_supplier_service.py` — the hotel analogue that did not exist before. `catalogue` (default, = today's DB catalogue, **unchanged**) \| `tbo`. |
| DB migration | `0101_hotel_supplier_references.py` — 10 additive **nullable** columns on `customer_hotel_bookings` (supplier, supplier_booking_id, supplier_confirmation_no, supplier_booking_code, supplier_status, voucher_status, supplier_net_amount, supplier_currency, last_cancellation_date, change_request_id) + a partial unique index on `supplier_booking_id`. **Tested up → down → up on PostgreSQL 18** (matches prod). Flight bookings already had `supplier_*` columns (migration 0086). |
| Config | `config.py` — `tbo_client_id/username/password/end_user_ip` (all **None** by default → a fresh checkout is "not configured" → demo/catalogue stay), `tbo_timeout_seconds`, five host-base settings, and `hotel_supplier` (default `catalogue`). Credentials read from env/secret store, **never hardcoded**. |
| Admin desk | `catalogue_flight_admin_service.py` — TBO flipped to `integrated: True`, `configured` reflecting whether creds are set. |
| Tests | `tests/test_tbo_flight_adapter.py` + `tests/test_tbo_hotel_adapter.py` — **27 tests, all green**, with mocked payloads. No network, no real credentials. Existing flight-guard + Duffel tests still green (82). Full suite still collects (2964). |

Default behaviour is **unchanged**: `FLIGHT_SUPPLIER=demo`, `HOTEL_SUPPLIER=catalogue`.
With no credentials set, TBO is simply unavailable.

## ⛔ BLOCKED — needs two inputs before live sandbox verification

1. **Sandbox base URLs** — the exact sandbox hosts from the **Postman collection
   TBO issues with the account** (not yet shared). The code defaults the five
   host-base settings to the documented **production** hosts; for sandbox they
   must be overridden in `backend/.env` (`TBO_SHARED_BASE_URL`, `TBO_AIR_BASE_URL`,
   `TBO_HOTEL_SEARCH_BASE_URL`, `TBO_HOTEL_BOOK_BASE_URL`, `TBO_HOTEL_STATIC_BASE_URL`).
2. **IP whitelisting** — TBO rejects every call whose `EndUserIp` is not
   whitelisted. The calling server's public IP must be registered with TBO and
   set as `TBO_END_USER_IP`.

Until both are in place, no live call can be made or verified; the adapters are
proven only against the documented contracts and recorded/mocked payloads.

To activate for sandbox once unblocked, set in `backend/.env`:
`TBO_CLIENT_ID` (sandbox value — **differs from production**), `TBO_USERNAME`,
`TBO_PASSWORD`, `TBO_END_USER_IP`, the five host bases, then
`FLIGHT_SUPPLIER=tbo` / `HOTEL_SUPPLIER=tbo`.

Certification sample flows to log (from the guides): flights
`Authenticate → Search → FareRule → FareQuote → SSR → Book → Ticket →
GetBookingDetails`; hotels `Authenticate → Search → PreBook → Book →
GetBookingDetail`.

## ⏭ Staged — only after sandbox verification + explicit approval

1. **Booking-path wiring.** Search is wired into the switches. The end-to-end
   booking path (FareQuote revalidation + Book/Ticket, and the hotel
   PreBook→Book→GenerateVoucher path) into `supplier_guard` /
   `payment_verification_*` — including mapping TBO exceptions to the guard's
   refusal codes and the `(TraceId|ResultIndex)` offer-handle scheme — is a
   live-phase task. **Until it is done, selecting `FLIGHT_SUPPLIER=tbo` fails
   closed at checkout** (it does not serve an unverified booking flow).
2. **Hotel re-platform — a design decision for you.** Hotels run off the DB
   catalogue today; TBO is live availability. Choose:
   - **(a) Catalogue as fallback** — try TBO first, fall back to the catalogue
     when TBO has no result / is down. Safer; keeps the existing product.
   - **(b) Full cutover** — TBO is the only hotel source; retire the catalogue
     hotel product (and the dormant Hotelbeds sync).
   This change does **not** remove the catalogue — that is held for your call.
3. **Retire the other suppliers (final step).** Only after (1) and (2) and a
   green sandbox run: remove the `demo`/Duffel flight paths and the
   catalogue/Hotelbeds hotel path so TBO is the sole supplier.

## How to verify this change locally

```powershell
cd backend
python -m pytest tests/test_tbo_flight_adapter.py tests/test_tbo_hotel_adapter.py -q
```

Migration up/down was verified on `postgres:18-alpine` (upgrade head → downgrade
0100 → upgrade head; all 10 columns + the partial unique index add and drop
cleanly).
