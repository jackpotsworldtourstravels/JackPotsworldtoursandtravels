"""What a flight costs to add things to: seat maps, baggage, meals, services.

WHY THIS EXISTS AT ALL. Until now the browser built its own seat map and knew
its own add-on prices (``booking-data.js``), which meant the client decided what
a seat cost and the server had no opinion. A page that can author its own prices
cannot be allowed to author a booking, so this module takes that authority back:
the seat map and the SSR catalogue are served, the client renders what it is
given, and :mod:`customer_pricing_service` re-prices every line at booking time
against these tables rather than trusting the totals it is sent.

THIS IS A STAND-IN, AND SAYS SO. There is no GDS, no airline SSR feed and no
inventory system behind this portal yet. The numbers below are the ones the B2C
demo has always shown, moved server-side unchanged; the seat occupancy is
derived from the flight's own id so a given flight looks the same on every load
rather than rearranging itself between the results page and the summary.

When a real supplier lands, it replaces the bodies of :func:`seat_map` and
:func:`addons` and nothing else moves — the routers, the pricing service and the
whole frontend are already reading through this seam.
"""
from __future__ import annotations

from decimal import Decimal

#: 3-3 narrow-body, which is what every aircraft in the sample data is.
SEAT_LETTERS = ("A", "B", "C", "D", "E", "F")
SEAT_TYPE = {"A": "window", "B": "middle", "C": "aisle",
             "D": "aisle", "E": "middle", "F": "window"}
DEFAULT_ROWS = 30

#: Rows with legroom. Airlines will not seat an infant in one, and the
#: traveller/seat validation below enforces that rather than leaving it to
#: be discovered at the gate.
EXIT_ROWS = (1, 14, 15)

CABIN_CLASSES = [
    {"id": "economy", "label": "Economy", "multiplier": 1.0},
    {"id": "premium", "label": "Premium Economy", "multiplier": 1.6},
    {"id": "business", "label": "Business", "multiplier": 2.9},
    {"id": "first", "label": "First", "multiplier": 4.2},
]

TITLES = ["Mr", "Ms", "Mrs", "Dr", "Mstr"]
GENDERS = ["Male", "Female", "Other"]
#: Enough to be credible in a dropdown without pretending to be ISO 3166.
NATIONALITIES = [
    "India", "United Arab Emirates", "Saudi Arabia", "Singapore", "Thailand",
    "United Kingdom", "United States", "Australia", "Canada", "Germany",
    "France", "Malaysia", "Sri Lanka", "Nepal", "Qatar", "Oman", "Bahrain",
    "Kuwait", "Maldives", "Indonesia",
]

#: Airlines a frequent-flyer number can belong to. Same list the sample
#: itineraries are drawn from, so the dropdown never offers a carrier the
#: portal cannot actually sell.
FREQUENT_FLYER_AIRLINES = [
    "Air India", "IndiGo", "Vistara", "SpiceJet", "Akasa Air",
    "Emirates", "Qatar Airways", "Singapore Airlines", "Etihad Airways",
    "British Airways", "Lufthansa", "Thai Airways", "Malaysia Airlines",
]

#: Included in every fare. Shown so the traveller can see what they already
#: have before being sold more of it.
INCLUDED_BAGGAGE = [
    {"code": "cabin7", "name": "Cabin baggage", "allowance": "7 kg",
     "description": "One cabin bag per traveller.", "included": True},
    {"code": "checkin15", "name": "Check-in baggage", "allowance": "15 kg",
     "description": "One checked bag per traveller.", "included": True},
]


def _seeded(key: str, salt: str) -> float:
    """FNV-1a, ported bit-for-bit from ``booking-data.js``.

    Kept identical on purpose: the seat map a customer saw before this service
    existed is the seat map they see after it, so moving the authority to the
    server is not also a visible change of aircraft.
    """
    h = 2166136261
    s = f"{key}|{salt}"
    for ch in s:
        h ^= ord(ch)
        # JS does Math.imul(h, 16777619), a signed 32-bit multiply. Masking to
        # 32 bits gives the same bit pattern; the JS `>>> 0` at the end is the
        # unsigned read this already is.
        h = (h * 16777619) & 0xFFFFFFFF
    return (h % 100000) / 100000


def seat_map(flight_key: str, rows: int = DEFAULT_ROWS) -> dict:
    """The aircraft, its seats, and which of them are taken.

    ``flight_key`` is the itinerary's own id. Occupancy is derived from it so
    the same flight always presents the same cabin.
    """
    out_rows = []
    total = rows or DEFAULT_ROWS
    for r in range(1, total + 1):
        exit_row = r in EXIT_ROWS
        seats = []
        for letter in SEAT_LETTERS:
            seat_id = f"{r}{letter}"
            seat_type = SEAT_TYPE[letter]
            # ~38% taken, clustered toward the front the way a real load is.
            bias = 0.55 - (r / total) * 0.34
            occupied = _seeded(flight_key, "seat" + seat_id) < bias
            price = 350 if seat_type == "window" else 300 if seat_type == "aisle" else 150
            if exit_row:
                price += 450
            if r <= 4:
                price += 200
            seats.append({
                "id": seat_id, "row": r, "letter": letter, "type": seat_type,
                "occupied": occupied, "price": price, "exit": exit_row,
                # An exit row is the one place a seat can be unavailable to a
                # particular traveller rather than to everyone.
                "infant_allowed": not exit_row,
            })
        out_rows.append({"row": r, "exit": exit_row, "seats": seats})

    return {
        "aircraft": "Airbus A320neo",
        "layout": "3-3",
        "rows": out_rows,
        "legend": [
            {"state": "available", "label": "Available"},
            {"state": "selected", "label": "Selected"},
            {"state": "occupied", "label": "Occupied"},
            {"state": "paid", "label": "Paid"},
        ],
    }


def seat_price(flight_key: str, seat_id: str, rows: int = DEFAULT_ROWS) -> Decimal | None:
    """Price of one seat, or ``None`` if it is not a seat on this aircraft.

    The booking path prices seats through here rather than believing the
    number the browser posts.
    """
    for row in seat_map(flight_key, rows)["rows"]:
        for seat in row["seats"]:
            if seat["id"] == seat_id:
                return Decimal(str(seat["price"]))
    return None


def seat_is_occupied(flight_key: str, seat_id: str, rows: int = DEFAULT_ROWS) -> bool:
    for row in seat_map(flight_key, rows)["rows"]:
        for seat in row["seats"]:
            if seat["id"] == seat_id:
                return bool(seat["occupied"])
    return False


def seat_allows_infant(flight_key: str, seat_id: str, rows: int = DEFAULT_ROWS) -> bool:
    for row in seat_map(flight_key, rows)["rows"]:
        for seat in row["seats"]:
            if seat["id"] == seat_id:
                return bool(seat["infant_allowed"])
    return True


#: The sellable extras, grouped the way the Add-ons step presents them.
#:
#: ``per`` decides how the quantity is derived: 'passenger' multiplies by the
#: party size, 'booking' is charged once however many are travelling. Pricing
#: reads this rather than the client's word for it.
_FLIGHT_ADDONS = {
    "baggage": [
        {"code": "bag5", "name": "Extra baggage 5 kg", "price": 900,
         "description": "Added to your 15 kg check-in allowance.", "per": "passenger"},
        {"code": "bag10", "name": "Extra baggage 10 kg", "price": 1600,
         "description": "Added to your 15 kg check-in allowance.", "per": "passenger"},
        {"code": "bag15", "name": "Extra baggage 15 kg", "price": 2300,
         "description": "Added to your 15 kg check-in allowance.", "per": "passenger"},
    ],
    "meal": [
        {"code": "meal_veg", "name": "Vegetarian meal", "price": 450,
         "description": "Hot vegetarian meal served on board.", "per": "passenger"},
        {"code": "meal_nonveg", "name": "Non-vegetarian meal", "price": 550,
         "description": "Hot non-vegetarian meal served on board.", "per": "passenger"},
        {"code": "meal_special", "name": "Special meal", "price": 450,
         "description": "Jain, diabetic, gluten-free and child meals.", "per": "passenger"},
    ],
    "service": [
        {"code": "wheelchair", "name": "Wheelchair assistance", "price": 0,
         "description": "Complimentary — requested with the airline.", "per": "passenger"},
        {"code": "priority", "name": "Priority boarding", "price": 600,
         "description": "Board ahead of general boarding groups.", "per": "passenger"},
        {"code": "legroom", "name": "Extra legroom", "price": 850,
         "description": "Seat with additional pitch, subject to availability.",
         "per": "passenger"},
        {"code": "lounge", "name": "Lounge access", "price": 1100,
         "description": "Departure lounge, two hours before boarding.", "per": "passenger"},
        {"code": "insurance", "name": "Travel insurance", "price": 899,
         "description": "Trip cancellation and medical cover.", "per": "passenger"},
        {"code": "transfer", "name": "Airport transfer", "price": 1250,
         "description": "Private cab to or from the airport.", "per": "booking"},
    ],
}


def addons(product_type: str = "flight") -> dict:
    """The add-on catalogue for a product.

    Only flights are wired to a booking backend so far; the other products
    still run through the browser's own demo data, and asking here for one of
    them returns an empty catalogue rather than a wrong one.
    """
    if product_type != "flight":
        return {"included_baggage": [], "baggage": [], "meal": [], "service": []}
    return {
        "included_baggage": list(INCLUDED_BAGGAGE),
        "baggage": list(_FLIGHT_ADDONS["baggage"]),
        "meal": list(_FLIGHT_ADDONS["meal"]),
        "service": list(_FLIGHT_ADDONS["service"]),
    }


def find_addon(code: str, product_type: str = "flight") -> dict | None:
    """Look one add-on up by code, whichever group it belongs to.

    Returns a copy carrying its ``addon_type``, which is what the booking rows
    are keyed on.
    """
    catalogue = addons(product_type)
    for group in ("baggage", "meal", "service"):
        for item in catalogue[group]:
            if item["code"] == code:
                return {**item, "addon_type": group}
    return None


def reference_lists() -> dict:
    """Everything the traveller form's dropdowns are built from."""
    return {
        "titles": TITLES,
        "genders": GENDERS,
        "nationalities": NATIONALITIES,
        "cabin_classes": CABIN_CLASSES,
        "frequent_flyer_airlines": FREQUENT_FLYER_AIRLINES,
    }
