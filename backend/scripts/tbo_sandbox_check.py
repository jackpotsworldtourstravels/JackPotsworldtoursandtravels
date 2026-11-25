"""Exercise the TBO sandbox end to end and print the step-by-step logs TBO's
certification asks for.

This runs the REAL adapters against whatever hosts/credentials are in the
environment (``backend/.env``). It is the thing to run once TBO has whitelisted
the calling server's public IP.

SAFETY — reads by default, writes only when asked.
  Search / FareRule / FareQuote / PreBook and the static-content lookups are
  reads and run by default. ``Book`` and ``Ticket`` (flights) and ``Book`` /
  ``GenerateVoucher`` (hotels) create test PNRs / vouchers, so they run ONLY
  with ``--book``. That keeps a plain run from leaving test bookings behind while
  still letting you produce the full certification logs when you want them.

USAGE (from the backend/ directory, with backend/.env filled and the IP
whitelisted):

    python -m scripts.tbo_sandbox_check                 # read-only flight+hotel flow
    python -m scripts.tbo_sandbox_check --book          # include Book/Ticket/Voucher
    python -m scripts.tbo_sandbox_check --flights-only
    python -m scripts.tbo_sandbox_check --hotels-only --hotel-codes 1402689,1405349
    python -m scripts.tbo_sandbox_check --date 2026-12-20

Nothing here hardcodes a credential; it reads them from settings. Nothing is
printed that could be a secret — only identifiers, fares and statuses.

Certification sample (from TBO): flights DEL-BOM, 2 Adult + 1 Child + 1 Infant,
return sector; hotels a sample stay on Static Data / New City Ids.
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from typing import Any

from app.integrations.tbo import schemas as fs
from app.integrations.tbo.client import TBOFlightClient
from app.integrations.tbo.exceptions import TBOError
from app.integrations.tbo.shared import TBOSession
from app.integrations.tbo_hotel import schemas as hs
from app.integrations.tbo_hotel.client import TBOHotelClient
from app.integrations.tbo_hotel.exceptions import TBOError as TBOHotelError


def _step(n: str, msg: str = "") -> None:
    print(f"\n=== {n} ===" + (f" {msg}" if msg else ""))


def _ok(msg: str) -> None:
    print(f"  [ok] {msg}")


def _info(msg: str) -> None:
    print(f"  {msg}")


def _fail(msg: str) -> None:
    print(f"  [FAIL] {msg}")


# --------------------------------------------------------------------------- #
# Flights: Authenticate -> Search -> FareRule -> FareQuote -> (SSR) -> Book/Ticket
# --------------------------------------------------------------------------- #

def run_flights(client: TBOFlightClient, *, date: str, ret_date: str, do_book: bool) -> bool:
    _step("FLIGHT", "DEL -> BOM, 2 Adult + 1 Child + 1 Infant, return")
    try:
        resp = client.search(
            segments=[
                {"origin": "DEL", "destination": "BOM", "departure_date": date, "cabin": "economy"},
                {"origin": "BOM", "destination": "DEL", "departure_date": ret_date, "cabin": "economy"},
            ],
            adults=2, children=1, infants=1, journey_type=fs.JOURNEY_RETURN,
        )
    except TBOError as exc:
        _fail(f"Search failed: {exc}")
        return False

    _ok(f"Authenticate + Search  TraceId={resp.trace_id}  results={len(resp.results)}")
    if not resp.results:
        _info("No flights returned for this date — try another --date. (Not necessarily an error.)")
        return True

    first = resp.results[0]
    _info(f"chosen ResultIndex={first.result_index}  IsLCC={first.is_lcc}  "
          f"OfferedFare={first.fare.offered_fare} {first.fare.currency}")

    try:
        client.fare_rule(resp.trace_id, first.result_index)
        _ok("FareRule")
    except TBOError as exc:
        _fail(f"FareRule: {exc}")

    try:
        quote = client.fare_quote(resp.trace_id, first.result_index)
    except TBOError as exc:
        _fail(f"FareQuote failed: {exc}")
        return False
    _ok(f"FareQuote  IsLCC={quote.is_lcc}  OfferedFare={quote.fare.offered_fare} {quote.fare.currency}  "
        f"LastTicketDate={quote.last_ticket_date}  PANatBook={quote.is_pan_required_at_book}")

    try:
        client.ssr(resp.trace_id, first.result_index)
        _ok("SSR (extras)")
    except TBOError as exc:
        _info(f"SSR not available / errored (optional): {exc}")

    if not do_book:
        _info("Stopping before Book/Ticket (read-only run). Re-run with --book to issue a test booking.")
        return True

    # ---- WRITE PHASE (only with --book) -------------------------------- #
    passengers = _sample_pax(quote)
    try:
        if quote.is_lcc:
            _info("IsLCC=True -> Ticket (books + issues in one call)")
            it = client.ticket_lcc(trace_id=resp.trace_id, result_index=first.result_index, passengers=passengers)
        else:
            _info("IsLCC=False -> Book (hold) then Ticket")
            held = client.book(trace_id=resp.trace_id, result_index=first.result_index, passengers=passengers)
            _ok(f"Book  BookingId={held.booking_id}  PNR={held.pnr}  LastTicketDate={held.last_ticket_date}")
            it = client.ticket_non_lcc(trace_id=resp.trace_id, pnr=held.pnr, booking_id=held.booking_id)
    except TBOError as exc:
        _fail(f"Book/Ticket failed: {exc}  (reconcile with GetBookingDetails by TraceId before any retry)")
        return False
    _ok(f"Ticket  BookingId={it.booking_id}  PNR={it.pnr}  "
        f"tickets={[t.ticket_number for t in it.tickets]}")

    try:
        detail = client.get_booking_details(booking_id=it.booking_id)
        _ok(f"GetBookingDetails  Status={detail.status}  Invoice={detail.invoice_no}")
    except TBOError as exc:
        _fail(f"GetBookingDetails: {exc}")
    return True


def _sample_pax(quote) -> list[dict]:
    """A certification-shaped passenger set (2 Adult + 1 Child + 1 Infant)."""
    pax = [
        {"title": "Mr", "first_name": "Rahul", "last_name": "Kumar", "pax_type": "adult",
         "gender": "male", "date_of_birth": "1990-05-10", "is_lead": True,
         "address_line1": "Plot 14, Banjara Hills", "city": "Hyderabad",
         "country_code": "IN", "country_name": "India", "nationality": "IN",
         "mobile": "9876543210", "email": "ops@jackpotsworld.example"},
        {"title": "Mrs", "first_name": "Priya", "last_name": "Kumar", "pax_type": "adult",
         "gender": "female", "date_of_birth": "1992-03-02"},
        {"title": "Miss", "first_name": "Anya", "last_name": "Kumar", "pax_type": "child",
         "gender": "female", "date_of_birth": "2018-07-21"},
        {"title": "Mstr", "first_name": "Veer", "last_name": "Kumar", "pax_type": "infant",
         "gender": "male", "date_of_birth": "2025-01-15"},
    ]
    from app.integrations.tbo import mapper as fmap
    return fmap.passengers_to_book(pax, list(quote.fare_breakdown))


# --------------------------------------------------------------------------- #
# Hotels: (static codes) -> Search -> PreBook -> (Book -> Voucher)
# --------------------------------------------------------------------------- #

def run_hotels(client: TBOHotelClient, *, check_in: str, check_out: str,
               hotel_codes: str | None, do_book: bool) -> bool:
    _step("HOTEL", "sample stay (Static Data / New City Ids)")
    if not hotel_codes:
        hotel_codes = _discover_hotel_codes(client)
        if not hotel_codes:
            _info("No hotel codes to search. Pass --hotel-codes <csv> (TBO static CountryList -> "
                  "CityList -> TBOHotelCodeList), or confirm the static-content host/auth with TBO.")
            return True

    try:
        options = client.search(
            check_in=check_in, check_out=check_out, hotel_codes=hotel_codes,
            guest_nationality="IN", pax_rooms=[{"adults": 2, "children": 0}],
        )
    except TBOHotelError as exc:
        _fail(f"Hotel Search failed: {exc}")
        return False
    _ok(f"Authenticate + Search  hotels={len(options)}")
    if not options:
        _info("No availability for these codes/dates (Status 201). Try other --hotel-codes or --date.")
        return True

    room = next((r for o in options for r in o.rooms if r.booking_code), None)
    if not room:
        _fail("Search returned hotels but no bookable room/BookingCode.")
        return False
    _info(f"chosen HotelCode={options[0].hotel_code}  BookingCode={room.booking_code}  "
          f"TotalFare={room.total_fare} {options[0].currency}")

    try:
        pb = client.prebook(room.booking_code)
    except TBOHotelError as exc:
        _fail(f"PreBook failed: {exc}")
        return False
    _ok(f"PreBook  NetAmount={pb.net_amount} {pb.currency}  "
        f"PassportMandatory={pb.requirement_flags.get('PassportMandatory')}")

    if not do_book:
        _info("Stopping before Book (read-only run). Re-run with --book to create a test booking.")
        return True

    from app.integrations.tbo_hotel import mapper as hmap
    rooms = hmap.rooms_to_book([[
        {"title": "Mr", "first_name": "Rahul", "last_name": "Kumar",
         "mobile": "9876543210", "email": "ops@jackpotsworld.example", "is_lead": True},
        {"title": "Mrs", "first_name": "Priya", "last_name": "Kumar"},
    ]])
    try:
        booking = client.book(
            booking_code=room.booking_code, net_amount=pb.net_amount or room.total_fare,
            guest_nationality="IN", is_voucher_booking=False, rooms=rooms,
        )
    except TBOHotelError as exc:
        _fail(f"Book failed: {exc}  (reconcile with GetBookingDetail before any retry)")
        return False
    _ok(f"Book  BookingId={booking.booking_id}  ConfirmationNo={booking.confirmation_no}  "
        f"Status={booking.status_label}  Voucher={booking.voucher_status}")

    if booking.voucher_status is False and booking.booking_id:
        try:
            v = client.generate_voucher(booking.booking_id)
            _ok(f"GenerateVoucher  Status={v.status_label}  Invoice={v.invoice_number}")
        except TBOHotelError as exc:
            _fail(f"GenerateVoucher: {exc}")
    try:
        d = client.get_booking_detail(booking_id=booking.booking_id)
        _ok(f"GetBookingDetail  Status={d.status_label}  LastCancellationDate={d.last_cancellation_date}")
    except TBOHotelError as exc:
        _fail(f"GetBookingDetail: {exc}")
    return True


def _discover_hotel_codes(client: TBOHotelClient) -> str | None:
    """Try the static CountryList -> CityList -> TBOHotelCodeList chain for India.

    The static-content host's auth scheme is not pinned by the docs, so this is
    best-effort: on any failure it returns None and the caller asks for
    --hotel-codes instead.
    """
    try:
        cities = client.city_list("IN")
        city_rows = cities.get("CityList") or []
        if not city_rows:
            return None
        code = city_rows[0].get("Code")
        hotels = client.hotel_code_list(int(code))
        rows = hotels.get("Hotels") or []
        codes = [str(h.get("HotelCode")) for h in rows[:50] if h.get("HotelCode")]
        return ",".join(codes) or None
    except Exception as exc:  # noqa: BLE001 — static host is uncertain; degrade cleanly
        _info(f"Static code discovery unavailable ({exc}). Supply --hotel-codes instead.")
        return None


# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="TBO sandbox certification runner")
    p.add_argument("--book", action="store_true", help="issue test Book/Ticket/Voucher (writes)")
    p.add_argument("--flights-only", action="store_true")
    p.add_argument("--hotels-only", action="store_true")
    p.add_argument("--date", help="flight outbound / hotel check-in (YYYY-MM-DD); default ~30 days out")
    p.add_argument("--hotel-codes", help="comma-separated TBO hotel codes to search")
    args = p.parse_args(argv)

    if not TBOSession.is_configured():
        print("TBO is not configured. Set TBO_CLIENT_ID, TBO_USERNAME, TBO_PASSWORD and a "
              "whitelisted TBO_END_USER_IP in backend/.env, then re-run.")
        return 2

    base = dt.date.fromisoformat(args.date) if args.date else dt.date.today() + dt.timedelta(days=30)
    out = base.isoformat()
    ret = (base + dt.timedelta(days=5)).isoformat()
    check_out = (base + dt.timedelta(days=2)).isoformat()

    print(f"TBO sandbox check — EndUserIp configured, ClientId set. "
          f"{'WRITE (Book/Ticket) enabled' if args.book else 'read-only'}")

    ok = True
    if not args.hotels_only:
        ok = run_flights(TBOFlightClient(), date=out, ret_date=ret, do_book=args.book) and ok
    if not args.flights_only:
        ok = run_hotels(TBOHotelClient(), check_in=out, check_out=check_out,
                        hotel_codes=args.hotel_codes, do_book=args.book) and ok

    print("\n" + ("All steps completed (see logs above)." if ok else "Some steps FAILED — see [FAIL] lines."))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
