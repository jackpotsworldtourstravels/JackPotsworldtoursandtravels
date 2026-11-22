"""Multi-segment flight booking — end-to-end verification (Bugs 2 & 5).

Runs against a DISPOSABLE PostgreSQL test database only (the *_test / *_qa gate
is the same one seed_gate_accounts uses). Nothing is committed to the database:
the whole run is rolled back at the end.

    DATABASE_URL=postgresql+psycopg2://…@localhost:…/…_test \
    JWT_SECRET_KEY=… python tests/verify_multi_segment.py

What it proves:
  * one-way, round-trip and multi-city all book through one booking + N segments;
  * the envelope total equals the SUM of the per-segment server-priced totals;
  * a payment for the exact total confirms the booking;
  * a payment for anything less (e.g. only the first leg) does NOT confirm it —
    i.e. "payment equals the server total across ALL segments" is enforced.
"""
from __future__ import annotations

import datetime as dt
import os
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

# This script prints arrows (→) in its itinerary labels. On a Windows console the
# default code page is cp1252, which cannot encode them and would crash the run
# AFTER the checks have already passed. Force UTF-8 so the output is portable.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):  # pragma: no cover - non-reconfigurable stream
        pass


def _validate_local_test_url() -> None:
    from sqlalchemy import make_url
    raw = os.environ.get("DATABASE_URL", "")
    try:
        url = make_url(raw)
    except Exception:
        sys.exit("verify_multi_segment REFUSED: DATABASE_URL did not parse.")
    host = (url.host or "").lower()
    name = url.database or ""
    if host not in {"localhost", "127.0.0.1", "::1"} or not (name.endswith("_test") or name.endswith("_qa")):
        sys.exit("verify_multi_segment REFUSED: only a local *_test / *_qa database is allowed.")


_validate_local_test_url()

from app.database.session import SessionLocal  # noqa: E402
from app.models_customer import (  # noqa: E402
    Customer,
    CustomerBookingPayment,
    CustomerPaymentStatus,
)
from app.services import customer_booking_service as svc  # noqa: E402
from app.services import payment_verification_flight_service as verify  # noqa: E402

PASS = 0
FAIL = 0


def check(label: str, cond: bool) -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}")


def flight(fn: str, origin: str, dest: str, date: dt.date, *, intl: bool = False) -> dict:
    return {
        "flight_key": f"KEY-{fn}-{origin}{dest}",
        "flight_number": fn,
        "duration_minutes": 125,
        "airline": "IndiGo",
        "cabin_class": "economy",
        "origin_code": origin, "origin_city": origin,
        "destination_code": dest, "destination_city": dest,
        "travel_date": date,
        "departure_time": "08:00", "arrival_time": "10:05",
        "duration_label": "2h 05m", "stops": 0,
        "is_international": intl,
    }


def party() -> list[dict]:
    return [{
        "traveller_type": "adult", "title": "Mr",
        "first_name": "Multi", "last_name": "Segment",
        "gender": "male", "date_of_birth": "1990-01-01",
        "is_contact": True, "mobile": "+919800000000", "email": "mseg@example.com",
    }]


def seg_sum(booking, field: str = "total_amount") -> Decimal:
    return sum((Decimal(str(getattr(s, field))) for s in booking.segments), Decimal("0"))


def captured_payment(db, booking, amount: Decimal) -> CustomerBookingPayment:
    pay = CustomerBookingPayment(
        customer_booking_id=booking.customer_booking_id,
        method="card",
        status=CustomerPaymentStatus.CAPTURED.value,
        amount=amount,
        currency=booking.currency,
    )
    db.add(pay)
    db.flush()
    return pay


def main() -> int:
    d0 = dt.date.today() + dt.timedelta(days=25)
    with SessionLocal() as db:
        cust = Customer(
            customer_code="MSEGTEST",
            full_name="Multi Segment Test",
            email="mseg-verify@example.com",
            mobile="+919812300099",
            status="active", email_verified=True, mobile_verified=True,
        )
        db.add(cust)
        db.flush()

        print("== one-way (via create_booking) ==")
        b1 = svc.create_booking(db, cust, {"flight": flight("6E815", "HYD", "DEL", d0), "passengers": party()})
        db.flush()
        check("one-way writes exactly one segment", len(b1.segments) == 1)
        check("one-way journey_type is one_way", b1.journey_type == "one_way")
        check("one-way envelope total == its segment total", Decimal(str(b1.total_amount)) == seg_sum(b1))

        print("== round-trip (2 segments) ==")
        b2 = svc.create_multi_segment_booking(db, cust, {
            "segments": [
                {"flight": flight("6E913", "HYD", "DEL", d0)},
                {"flight": flight("6E6638", "DEL", "HYD", d0 + dt.timedelta(days=7))},
            ],
            "passengers": party(),
        })
        db.flush()
        check("round-trip writes two segments", len(b2.segments) == 2)
        check("round-trip journey_type is round_trip", b2.journey_type == "round_trip")
        check("round-trip summary origin=HYD, destination=HYD", b2.origin_code == "HYD" and b2.destination_code == "HYD")
        check("round-trip envelope total == sum of segment totals", Decimal(str(b2.total_amount)) == seg_sum(b2))
        check("round-trip total is more than either leg alone",
              Decimal(str(b2.total_amount)) > Decimal(str(b2.segments[0].total_amount)))

        print("== multi-city (3 segments) ==")
        b3 = svc.create_multi_segment_booking(db, cust, {
            "segments": [
                {"flight": flight("6E468", "HYD", "DEL", d0)},
                {"flight": flight("6E6494", "DEL", "BOM", d0 + dt.timedelta(days=3))},
                {"flight": flight("6E707", "BOM", "GOA", d0 + dt.timedelta(days=6))},
            ],
            "passengers": party(),
        })
        db.flush()
        check("multi-city writes three segments", len(b3.segments) == 3)
        check("multi-city journey_type is multi_city", b3.journey_type == "multi_city")
        check("multi-city summary origin=HYD, destination=GOA", b3.origin_code == "HYD" and b3.destination_code == "GOA")
        check("multi-city segment order preserved HYD→DEL→BOM→GOA",
              [s.origin_code for s in b3.segments] == ["HYD", "DEL", "BOM"]
              and [s.destination_code for s in b3.segments] == ["DEL", "BOM", "GOA"])
        check("multi-city envelope total == sum of segment totals", Decimal(str(b3.total_amount)) == seg_sum(b3))

        print("== payment must equal the server total across ALL segments ==")
        # Correct, full payment confirms the round-trip.
        pay_ok = captured_payment(db, b2, Decimal(str(b2.total_amount)))
        confirmed = verify.confirm_booking(db, pay_ok, b2)
        db.flush()
        db.refresh(b2)
        check("exact full payment confirms the round-trip", confirmed and b2.status == "confirmed")

        # A payment for only the first leg must NOT confirm the multi-city booking.
        first_leg = Decimal(str(b3.segments[0].total_amount))
        check("one leg is less than the whole journey (sanity)", first_leg < Decimal(str(b3.total_amount)))
        pay_short = captured_payment(db, b3, first_leg)
        confirmed_short = verify.confirm_booking(db, pay_short, b3)
        db.flush()
        db.refresh(b3)
        check("under-payment (one leg) does NOT confirm multi-city", confirmed_short is False)
        check("multi-city stays pending after under-payment", b3.status == "pending")

        # And the exact total does confirm it.
        pay_full = captured_payment(db, b3, Decimal(str(b3.total_amount)))
        confirmed_full = verify.confirm_booking(db, pay_full, b3)
        db.flush()
        db.refresh(b3)
        check("exact full payment then confirms multi-city", confirmed_full and b3.status == "confirmed")

        print("== cancellation compatibility ==")
        svc.cancel(db, b1)
        db.flush()
        db.refresh(b1)
        check("a booking cancels (envelope-level) and keeps its segments",
              b1.status == "cancelled" and len(b1.segments) == 1)

        db.rollback()  # disposable run — leave the database as we found it

    print(f"\n==== {PASS} passed, {FAIL} failed ====")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
