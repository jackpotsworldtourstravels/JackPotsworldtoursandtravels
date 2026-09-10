"""The price on the results card is the price the booking quotes.

WHY THIS EXISTS
---------------
The demo fare is a hash of the flight number. Both sides compute it — the
browser for the results list (``demoCommercials`` in ``travel-data.js``) and the
server for every quote and every booking (``flight_fare`` in
``customer_pricing_service.py``) — and the port between them is line-for-line
correct.

It still disagreed, because the two sides were handed the flight number spelt
differently. ``travel-data.js`` holds the raw ``QP1405`` and priced the card
from that; ``prettyFlightNumber`` renders ``QP 1405`` for display, and that
spaced form is what ``booking-api.js`` sends as ``flight_number``. One flight,
two strings, two hashes:

    flight_fare("QP1405",  135) -> 3800 + 680 = 4480    <- advertised
    flight_fare("QP 1405", 135) -> 3550 + 640 = 4190    <- quoted

So every flight advertised one price and booked at another. Nothing caught it
because each side was self-consistent and nothing compared them.

Both sides now canonicalise the seed before hashing — ``fareSeed`` in the
browser, :func:`fare_seed` on the server — and this file is what keeps them
honest. It is the check that would have failed on the original bug.

WHAT IT ASSERTS
---------------
  1. Canonicalisation. ``fare_seed`` folds whitespace and case, is idempotent,
     and leaves an already-canonical number alone.

  2. Spelling does not move the price. For every flight in the sample schedule,
     a set of legitimate spellings — raw, prettified, lower-cased, padded —
     all price identically. This is the property the bug violated, tested
     directly rather than through one hard-coded pair.

  3. The browser still canonicalises. A static read of ``travel-data.js``
     confirming ``demoCommercials`` seeds through ``fareSeed`` and not off its
     raw argument. Half a fix on the server would restore the split silently,
     and this suite cannot execute JavaScript to catch it any other way.

  4. Live, when a server is up: ``POST /api/customer/bookings/quote`` returns
     the same base fare and taxes the sample card advertises, for a real
     sample flight sent the way the browser sends it. This is the end-to-end
     statement of the whole file; 1-3 are what tell you *where* it broke.

REQUIREMENTS
------------
Checks 1-3 are the standard library and the app package — no server, no
browser, no database. Check 4 needs a running API and says so if there is not
one, rather than failing.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services import customer_pricing_service as pricing  # noqa: E402

try:
    from config import BASE
except ImportError:  # run directly from another directory
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from config import BASE

TRAVEL_DATA = ROOT / "frontend" / "assets" / "js" / "travel-data.js"

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  PASS  {message}")
    else:
        print(f"  FAIL  {message}")
        failures.append(message)


# ---------------------------------------------------------------------------
# The sample schedule, read from the file that owns it.
# ---------------------------------------------------------------------------
def sample_flights() -> list[tuple[str, int | None]]:
    """``[(raw flight number, duration minutes or None), ...]``.

    Read out of ``travel-data.js`` rather than copied here, so a row added to
    the schedule is covered without this file being edited. Duration is
    computed the same way ``durationMinutes`` does for the rows that carry an
    arrival — the ones that do not price off the 120-minute default, which is
    exercised by passing ``None`` straight through.
    """
    src = TRAVEL_DATA.read_text(encoding="utf-8")
    block = re.search(r"const SAMPLE_FLIGHTS = \[(.*?)\n  \];", src, re.S)
    if not block:
        sys.exit("FAIL  travel-data.js has no SAMPLE_FLIGHTS block")

    rows: list[tuple[str, int | None]] = []
    for line in block.group(1).splitlines():
        m = re.search(r"no:\s*'([^']+)'", line)
        if not m:
            continue
        dep = re.search(r"dep:\s*'(\d{1,2}):(\d{2})'", line)
        arr = re.search(r"arr:\s*'(\d{1,2}):(\d{2})'", line)
        minutes = None
        if dep and arr:
            d = int(dep.group(1)) * 60 + int(dep.group(2))
            a = int(arr.group(1)) * 60 + int(arr.group(2))
            minutes = (a - d) % (24 * 60)
        rows.append((m.group(1), minutes))
    return rows


def spellings(raw: str) -> list[str]:
    """Legitimate ways this one flight number reaches a fare function.

    ``pretty`` is what ``prettyFlightNumber`` produces and what the browser
    sends to the server — the spelling the bug was actually about. The rest
    are the ordinary noise of a feed: case, and padding.
    """
    m = re.fullmatch(r"([A-Za-z0-9]{2})\s*(\d+)", raw)
    pretty = f"{m.group(1).upper()} {m.group(2)}" if m else raw
    return [raw, pretty, raw.lower(), pretty.lower(), f"  {pretty}  "]


def main() -> int:
    print("== 1. fare_seed canonicalises ==")
    check(pricing.fare_seed("QP 1405") == "QP1405", "a space is folded out")
    check(pricing.fare_seed("qp1405") == "QP1405", "case is folded up")
    check(pricing.fare_seed("  QP\t1405 ") == "QP1405", "padding and tabs go too")
    check(pricing.fare_seed("QP1405") == "QP1405", "an already-canonical number is untouched")
    check(
        pricing.fare_seed(pricing.fare_seed("QP 1405")) == pricing.fare_seed("QP 1405"),
        "canonicalising twice changes nothing",
    )
    check(pricing.fare_seed("") == "" and pricing.fare_seed(None) == "",
          "empty and None do not raise")

    print("\n== 2. spelling does not move the price ==")
    rows = sample_flights()
    check(len(rows) >= 20, f"the sample schedule was read ({len(rows)} flights)")

    split = []
    for raw, minutes in rows:
        fares = {pricing.flight_fare(s, minutes) for s in spellings(raw)}
        if len(fares) != 1:
            priced = {s: pricing.flight_fare(s, minutes) for s in spellings(raw)}
            split.append(f"{raw}: {priced}")
    check(not split, f"all {len(rows)} sample flights price the same under every spelling")
    for line in split[:5]:
        print(f"          {line}")

    # The regression itself, named, so a failure here reads as what it is.
    check(
        pricing.flight_fare("QP1405", 135) == pricing.flight_fare("QP 1405", 135),
        "QP1405 and QP 1405 quote the same fare (the original bug)",
    )

    print("\n== 3. the browser canonicalises too ==")
    js = TRAVEL_DATA.read_text(encoding="utf-8")
    check("function fareSeed(" in js, "travel-data.js defines fareSeed()")
    demo = re.search(r"function demoCommercials\(([^)]*)\)\s*\{(.*?)\n  \}", js, re.S)
    check(demo is not None, "travel-data.js defines demoCommercials()")
    if demo:
        arg = demo.group(1).split(",")[0].strip()
        body = demo.group(2)
        check(f"fareSeed({arg})" in body,
              "demoCommercials() canonicalises its flight number through fareSeed()")
        stray = re.findall(rf"seeded\(\s*{re.escape(arg)}\s*,", body)
        check(not stray,
              f"demoCommercials() seeds nothing off the raw argument "
              f"({len(stray)} raw seed call(s) found)")

    print("\n== 4. the served quote matches the advertised fare ==")
    raw, minutes = next(((r, m) for r, m in rows if m), rows[0])
    base, taxes = pricing.flight_fare(raw, minutes)
    m = re.fullmatch(r"([A-Za-z0-9]{2})\s*(\d+)", raw)
    pretty = f"{m.group(1).upper()} {m.group(2)}" if m else raw

    payload = {
        "flight": {
            "flight_key": f"{raw}-2026-08-08-0",
            "flight_number": pretty,          # exactly what booking-api.js sends
            "duration_minutes": minutes,
            "cabin_class": "economy",
            "is_international": False,
        },
        "passenger_types": ["adult"],
        "seats": [],
        "addons": [],
    }
    req = urllib.request.Request(
        f"{BASE}/api/customer/bookings/quote",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            quote = json.load(res)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"  SKIP  no API at {BASE} ({exc}) — checks 1-3 still ran")
        quote = None

    if quote is not None:
        lines = {ln["label"]: float(ln["amount"]) for ln in quote.get("lines", [])}
        quoted_base = next((v for k, v in lines.items() if k.startswith("Base fare")), None)
        quoted_tax = next((v for k, v in lines.items() if "Tax" in k), None)
        check(quoted_base == float(base),
              f"{pretty}: quoted base {quoted_base} == advertised {float(base)}")
        check(quoted_tax == float(taxes),
              f"{pretty}: quoted taxes {quoted_tax} == advertised {float(taxes)}")
        check(float(quote["total_amount"]) == float(base) + float(taxes),
              f"{pretty}: quoted total {quote['total_amount']} == "
              f"advertised {float(base) + float(taxes)}")

    print()
    if failures:
        print(f"==== {len(failures)} failed ====")
        for f in failures:
            print(f"  FAILED: {f}")
        return 1
    print("==== all passed ====")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
