"""The demo flight schedule, as the SERVER knows it.

WHY THIS EXISTS (audit finding JP-01). With ``FLIGHT_SUPPLIER=demo`` the flights
are the sample departures board in ``frontend/assets/js/travel-data.js``, and the
fare is a formula of the flight number and the flight's duration. The browser
used to SEND that duration, so a customer could quote the same flight at
``duration_minutes=1`` or ``3000`` and book it for ₹4,130 or ₹35,990. The price
must depend only on things the server decides, so the schedule lives here too and
the duration is read from it, never from the request.

KEEP THIS IN STEP WITH ``SAMPLE_FLIGHTS`` IN ``travel-data.js``.
``backend/tests/test_security_remediation.py`` parses that file and fails if the
two differ, so a flight added to the board without being added here is caught
before it ships rather than refused to a customer.

This is demo data and goes away with the demo supplier. A live supplier prices
from its own offer, re-checked with the supplier before booking; see
``catalogue_flight_admin_service`` for that plan.
"""
from __future__ import annotations

import re

_WS = re.compile(r"\s+")

#: Minutes east of UTC. Only the airports that appear on the board; HYD is the
#: board's single origin (``CONFIG.defaultOrigin``). Same values as airports.js.
_IST = 330
_UTC = {
    "HYD": _IST, "DEL": _IST, "JAI": _IST, "CJB": _IST, "AYJ": _IST, "CCU": _IST,
    "NAG": _IST, "TIR": _IST, "TRV": _IST, "IXU": _IST, "VGA": _IST, "STV": _IST,
    "BLR": _IST, "JED": 180, "MED": 180, "BAH": 180, "BKK": 420,
}
_ORIGIN = "HYD"

#: flight number -> (destination, departure, arrival or None). Mirrors
#: ``SAMPLE_FLIGHTS``. ``None`` arrival means the board shows no arrival time, so
#: there is no duration and the fare formula uses its default.
BOARD: dict[str, tuple[str, str, str | None]] = {
    "AI1806": ("DEL", "05:30", None),
    "AI2860": ("DEL", "07:30", None),
    "6E815": ("JAI", "05:55", None),
    "6E913": ("JAI", "11:50", None),
    "6E6638": ("JAI", "19:30", None),
    "6E6646": ("CJB", "07:20", None),
    "6E468": ("CJB", "10:10", None),
    "6E6424": ("CJB", "14:10", None),
    "6E6308": ("CJB", "18:10", None),
    "6E57": ("MED", "17:40", None),
    "6E6160": ("AYJ", "13:55", None),
    "QP1405": ("DEL", "06:00", "08:15"),
    "IX939": ("JED", "05:05", "08:50"),
    "6E1509": ("BKK", "05:40", "10:55"),
    "6E6494": ("CCU", "05:55", "08:05"),
    "6E7452": ("NAG", "06:00", "07:40"),
    "GF275": ("BAH", "06:05", "08:05"),
    "6E6567": ("TIR", "06:10", "07:20"),
    "6E5278": ("TRV", "06:10", "07:55"),
    "6E7252": ("IXU", "06:15", "07:45"),
    "6E7201": ("VGA", "06:15", "07:15"),
    "6E928": ("STV", "06:20", "07:55"),
    "IX2934": ("BLR", "06:20", "07:55"),
    "6E707": ("DEL", "06:25", "08:45"),
    "6E413": ("BLR", "06:30", "07:50"),
}


def canonical(flight_number: str) -> str:
    """Same fold as ``fare_seed``: the board holds ``6E815``, the browser sends ``6E 815``."""
    return _WS.sub("", str(flight_number or "")).upper()


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def duration_minutes(dest: str, dep: str, arr: str | None) -> int | None:
    """Elapsed time with both ends taken to UTC first; a negative result is next day.

    Identical to ``durationMinutes`` in travel-data.js.
    """
    if arr is None:
        return None
    mins = (_minutes(arr) - _UTC[dest]) - (_minutes(dep) - _UTC[_ORIGIN])
    return mins + 24 * 60 if mins < 0 else mins


def lookup(flight_number: str) -> tuple[bool, int | None]:
    """``(on the board, the server's own duration or None)``."""
    row = BOARD.get(canonical(flight_number))
    if row is None:
        return False, None
    return True, duration_minutes(*row)
