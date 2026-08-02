"""Passenger auto-fill — `GET /api/passengers/lookup`.

WHAT THIS PROTECTS

The endpoint saves a merchant retyping a traveller it has booked before. It is
three lines of service code and two ways of being a serious bug, so both are
asserted here rather than reasoned about:

1. **IT IS A TENANT BOUNDARY.** A passport number is short, structured and
   guessable, and the reply is a named person's date of birth and nationality.
   Scoped wrongly, this is a people-search endpoint with an authentication check
   in front of it. The test signs in as a *different real merchant* and asks for
   a passport it does not own — a bogus number would prove nothing.
2. **IT WRITES NOTHING.** "Do not create duplicate passenger records" is
   satisfied by the lookup being incapable of creating one: the row count for
   the passport is asserted unchanged across a lookup, and the response is
   asserted to carry **no `id`** — that field would name a `passenger_data` row
   on another booking, and handing it to a form filling in a different booking
   is how a traveller gets moved between bookings.

Also covered: the most recent record wins (a renewed passport must not be
undone by a two-year-old row), a miss is a 200 rather than a 404, and staff
accounts — which have no merchant — get nothing.
"""
import datetime
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MERCHANT, Checker, H, login  # noqa: E402

check = Checker()
mtok = login(*MERCHANT)
atok = login(*ADMIN)

TRAVEL = datetime.date.today() + datetime.timedelta(days=60)
EXPIRY = TRAVEL + datetime.timedelta(days=900)
# Unique per run: the suite runs repeatedly against the same database, and a
# passport shared with a previous run would make "most recent wins" untestable.
PASSPORT = f"Z{datetime.datetime.now():%H%M%S}9"


def lookup(number, token=None):
    return requests.get(f"{BASE}/api/passengers/lookup?passport_number={number}",
                        headers=H(token or mtok))


# --------------------------------------------------------------- 1. a miss
print("\n=== 1. An unknown passport is a normal answer, not an error ===")

r = lookup(PASSPORT)
check("an unrecognised passport returns 200", r.status_code == 200,
      f"{r.status_code} {r.text[:200]}")
check("...with found:false", r.json().get("found") is False, r.text[:200])
check("...and no traveller's details", not r.json().get("first_name"), r.text[:200])

r = lookup("AB")
check("a stub too short to be a passport is refused outright", r.status_code == 422,
      f"{r.status_code} {r.text[:150]}")


# ------------------------------------------------------------- 2. a real hit
print("\n=== 2. A traveller this merchant has booked comes back ===")

booking = requests.post(f"{BASE}/api/bookings/direct", headers=H(mtok), json={
    "trip_type": "one_way",
    "origin": "HYD", "origin_city": "Hyderabad",
    "destination": "DXB", "destination_city": "Dubai",
    "airline": "Emirates", "flight_number": "EK525",
    "travel_date": str(TRAVEL), "preferred_time": "09:30",
    "travel_class": "Economy",
    "passenger_count": 1, "adults": 1,
    "international": True,
    "contact": {"name": "Ops", "email": "ops@demotravel.example", "phone": "+919845012345"},
    "passengers": [{
        "title": "Ms", "first_name": "Anjali", "last_name": "Verma",
        "passenger_type": "adult", "gender": "female", "dob": "1991-04-17",
        "nationality": "Indian", "passport_number": PASSPORT,
        "passport_issue_country": "India", "passport_expiry": str(EXPIRY),
        "seat_preference": "window", "meal_preference": "veg",
    }],
})
check("a booking carrying the traveller was created", booking.status_code == 201,
      f"{booking.status_code} {booking.text[:250]}")

r = lookup(PASSPORT)
body = r.json() if r.status_code == 200 else {}
check("the passport is now found", body.get("found") is True, r.text[:250])
for field, expected in [
    ("title", "Ms"), ("first_name", "Anjali"), ("last_name", "Verma"),
    ("gender", "female"), ("dob", "1991-04-17"), ("nationality", "Indian"),
    ("passport_issue_country", "India"), ("passport_expiry", str(EXPIRY)),
    ("seat_preference", "window"), ("meal_preference", "veg"),
]:
    check(f"...{field} comes back", body.get(field) == expected,
          f"{body.get(field)!r} != {expected!r}")
check("...and it says when the traveller was last used", bool(body.get("last_used")),
      str(body.get("last_used")))

# Case and whitespace: a merchant pasting from a scan gets what it typed back.
r = lookup(PASSPORT.lower())
check("the match is case-insensitive", r.json().get("found") is True, r.text[:150])


# ------------------------------------------ 3. it returns facts, not a row id
print("\n=== 3. A lookup is a read, and cannot become a write ===")

check("THE RESPONSE CARRIES NO ROW ID — nothing can be moved between bookings",
      "id" not in body, str(sorted(body)))

with SessionLocal() as db:
    before = db.execute(text(
        "SELECT COUNT(*) FROM passenger_data WHERE upper(passport_number) = :p"),
        {"p": PASSPORT}).scalar_one()
for _ in range(3):
    lookup(PASSPORT)
with SessionLocal() as db:
    after = db.execute(text(
        "SELECT COUNT(*) FROM passenger_data WHERE upper(passport_number) = :p"),
        {"p": PASSPORT}).scalar_one()
check("three lookups create no passenger rows", after == before, f"{before} -> {after}")


# ------------------------------------------------------- 4. most recent wins
print("\n=== 4. The newest record wins, so a correction is not undone ===")

r = requests.post(f"{BASE}/api/bookings/direct", headers=H(mtok), json={
    "trip_type": "one_way",
    "origin": "HYD", "origin_city": "Hyderabad",
    "destination": "DXB", "destination_city": "Dubai",
    "airline": "Emirates", "flight_number": "EK525",
    "travel_date": str(TRAVEL), "preferred_time": "09:30",
    "travel_class": "Economy",
    "passenger_count": 1, "adults": 1, "international": True,
    "contact": {"name": "Ops", "email": "ops@demotravel.example", "phone": "+919845012345"},
    # Married name and a renewed passport — the two reasons this rule exists.
    "passengers": [{
        "title": "Ms", "first_name": "Anjali", "last_name": "Nair",
        "passenger_type": "adult", "gender": "female", "dob": "1991-04-17",
        "nationality": "Indian", "passport_number": PASSPORT,
        "passport_issue_country": "India",
        "passport_expiry": str(EXPIRY + datetime.timedelta(days=365)),
    }],
})
check("a second booking updates the traveller", r.status_code == 201,
      f"{r.status_code} {r.text[:200]}")

body2 = lookup(PASSPORT).json()
check("the lookup returns the NEWER surname", body2.get("last_name") == "Nair",
      str(body2.get("last_name")))
check("...and the NEWER expiry",
      body2.get("passport_expiry") == str(EXPIRY + datetime.timedelta(days=365)),
      str(body2.get("passport_expiry")))


# ----------------------------------------------------- 5. the tenant boundary
print("\n=== 5. A merchant can only find its OWN travellers ===")

rival = flows.rival_merchant(atok)
r = lookup(PASSPORT, token=rival["token"])
check(f"another merchant ({rival['company']}) gets 200, not an error",
      r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...AND FINDS NOTHING — the passport is not theirs",
      r.json().get("found") is False, r.text[:250])
check("...leaking no name", not r.json().get("first_name"), r.text[:250])

# The reverse direction, so the test cannot pass by the endpoint simply being
# broken for the rival: it must find a traveller of its own.
own = requests.post(f"{BASE}/api/bookings/direct", headers=H(rival["token"]), json={
    "trip_type": "one_way",
    "origin": "DEL", "origin_city": "Delhi",
    "destination": "BOM", "destination_city": "Mumbai",
    "airline": "IndiGo", "flight_number": "6E888",
    "travel_date": str(TRAVEL), "preferred_time": "11:00",
    "travel_class": "Economy", "passenger_count": 1, "adults": 1,
    "contact": {"name": "Rival Ops", "email": "ops@rival.example", "phone": "+919845000000"},
    "passengers": [{"title": "Mr", "first_name": "Rival", "last_name": "Traveller",
                    "passenger_type": "adult", "passport_number": f"R{PASSPORT[1:]}"}],
})
if check("the rival can raise its own booking", own.status_code == 201,
         f"{own.status_code} {own.text[:200]}"):
    r = lookup(f"R{PASSPORT[1:]}", token=rival["token"])
    check("...and finds its own traveller", r.json().get("found") is True, r.text[:200])
    r = lookup(f"R{PASSPORT[1:]}")
    check("...which OUR merchant cannot see", r.json().get("found") is False, r.text[:200])

# Staff have no merchant_id. The endpoint must be inert for them rather than
# unscoped — an admin able to sweep this would be the worst version of the bug.
r = lookup(PASSPORT, token=atok)
check("a staff account cannot use it as a directory",
      r.status_code in (401, 403) or r.json().get("found") is False,
      f"{r.status_code} {r.text[:200]}")

r = requests.get(f"{BASE}/api/passengers/lookup?passport_number={PASSPORT}")
check("...and it is not open to an anonymous caller", r.status_code in (401, 403),
      f"{r.status_code} {r.text[:150]}")


sys.exit(check.report())
