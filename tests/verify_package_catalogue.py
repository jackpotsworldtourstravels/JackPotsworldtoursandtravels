"""The tour-package journey: three shelves, filters the database applies, and a page per trip.

WHAT CHANGED, AND WHY IT NEEDED CHANGING

Tour Packages was a grid of seven tiles. There was no category step, no filter
that the catalogue could answer, and no page for a package — "Explore Package"
opened the booking card straight from a tile, so a traveller decided on a
name, a day count and a from-price. Migration 0083 gave a package a
destination, a night count, a shelf (domestic / pilgrimage / international), a
hotel standard, a rating with its source, highlights, exclusions, a day-by-day
table and a hotels table; this script protects the API that serves them.

WHAT THIS SCRIPT PROTECTS

1. **The three shelves are always three.** Pilgrimage has nothing on it today
   and is still returned, with a count of zero. A missing tile would say the
   company does not run pilgrimages; a wrong count would be worse.

2. **A filter is applied by the database and narrows honestly.** Every row
   that comes back for `trip_type=domestic` really is domestic; every row for
   `max_price=X` really is at or under X; `month=YYYY-MM` returns only
   packages with a live departure in that month, checked against the
   departures the API itself lists.

3. **A filter that names something we do not have returns nothing** rather
   than quietly widening to everything. This is the failure mode that puts
   trips departing in June under a heading that says March.

4. **The facets only offer what exists.** Every destination, month and hotel
   standard offered by /packages/facets returns a non-empty list when it is
   used as a filter — so the rail cannot present a dead end.

5. **A score is never served without its source** (0082's rule, applied to
   packages by 0083). No package carries a rating today, so the assertion is
   that none arrives with one half filled in.

6. **The detail endpoint answers with the new lists**, empty or not, and the
   two prices it reports agree with the departures it lists: `price_next` is
   the soonest departure's price, not the cheapest or the shelf's.

7. **An unknown shelf is rejected, not ignored** — the same argument 0069's
   category made: a typo must not fall through to "everything".

RUN IT AGAINST A LIVE SERVER, with migration 0083 applied:

    JPW_BASE=http://127.0.0.1:8000 python tests/verify_package_catalogue.py
"""
import datetime as dt
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))

import minihttp as requests  # noqa: E402

from config import BASE, Checker  # noqa: E402

check = Checker()
PKG = f"{BASE}/api/customer/packages"
TODAY = dt.date.today().isoformat()


def get(url):
    r = requests.get(url)
    return r.status_code, (r.json() if r.status_code == 200 else r.text[:200])


print(f"\nBASE={BASE}")

# ---------------------------------------------------------------------------
print("\n== 1. The three shelves, counts and all ==")
# ---------------------------------------------------------------------------
code, tiles = get(f"{PKG}/trip-types?category=holiday")
check("GET /packages/trip-types answers", code == 200, str(tiles)[:160])
if code != 200:
    sys.exit(check.report())

kinds = [t["trip_type"] for t in tiles]
check("  all three shelves are returned",
      kinds == ["domestic", "pilgrimage", "international"], str(kinds))
check("  every count is a number, including the empty shelf",
      all(isinstance(t["count"], int) and t["count"] >= 0 for t in tiles), str(tiles))

code, everything = get(f"{PKG}?category=holiday")
check("GET /packages answers", code == 200, str(everything)[:160])
total = len(everything)
check("  the tile counts add up to the unfiltered list",
      sum(t["count"] for t in tiles) == total,
      f"tiles={sum(t['count'] for t in tiles)} list={total}")

# ---------------------------------------------------------------------------
print("\n== 2. Each filter narrows, and every row it returns satisfies it ==")
# ---------------------------------------------------------------------------
for tile in tiles:
    kind, n = tile["trip_type"], tile["count"]
    code, rows = get(f"{PKG}?category=holiday&trip_type={kind}")
    check(f"trip_type={kind} returns its {n}", code == 200 and len(rows) == n,
          f"{code} got {len(rows) if code == 200 else rows}")
    if code == 200:
        check(f"  every row really is {kind}",
              all(r["trip_type"] == kind for r in rows),
              str([r.get("trip_type") for r in rows]))

if everything:
    prices = sorted(float(r["priceFrom"]) for r in everything)
    cap = prices[len(prices) // 2]
    code, rows = get(f"{PKG}?category=holiday&max_price={cap}")
    check(f"max_price={cap:.0f} excludes the dearer trips",
          code == 200 and all(float(r["priceFrom"]) <= cap for r in rows),
          str([r["priceFrom"] for r in rows])[:160])
    check("  and it did narrow the list", code == 200 and len(rows) < total,
          f"{len(rows)} of {total}")

    code, rows = get(f"{PKG}?category=holiday&max_days=4")
    check("max_days=4 excludes the longer trips",
          code == 200 and all(r["days"] <= 4 for r in rows),
          str([r["days"] for r in rows]))

    dest = everything[0]["destination"]
    if dest:
        code, rows = get(f"{PKG}?category=holiday&destination={dest.lower()}")
        check(f"destination={dest.lower()} matches case-insensitively",
              code == 200 and rows and all(r["destination"] == dest for r in rows),
              str([r.get("destination") for r in rows]))

# ---------------------------------------------------------------------------
print("\n== 3. The month filter is answered from real departures ==")
# ---------------------------------------------------------------------------
code, facets = get(f"{PKG}/facets?category=holiday")
check("GET /packages/facets answers", code == 200, str(facets)[:160])

if code == 200 and facets["months"]:
    month = facets["months"][0]["value"]
    code, rows = get(f"{PKG}?category=holiday&month={month}")
    check(f"month={month} returns the {facets['months'][0]['count']} the facet promised",
          code == 200 and len(rows) == facets["months"][0]["count"],
          f"got {len(rows) if code == 200 else rows}")
    if code == 200:
        # Checked against what the API ITSELF says each package departs on -
        # not against a calendar, and not against the same query that produced
        # the rows.
        ok = True
        for r in rows:
            c2, detail = get(f"{PKG}/{r['id']}")
            dates = [d["date"] for d in (detail.get("departures") or [])] if c2 == 200 else []
            if not any(d.startswith(month) and d >= TODAY for d in dates):
                ok = False
        check("  and every one of them really departs that month", ok)

    # A month with no departures must come back empty, not full.
    far = "2099-01"
    code, rows = get(f"{PKG}?category=holiday&month={far}")
    check("a month nothing departs in returns nothing",
          code == 200 and rows == [], f"{code} {str(rows)[:120]}")

# ---------------------------------------------------------------------------
print("\n== 4. The rail cannot offer a dead end ==")
# ---------------------------------------------------------------------------
if code == 200 and facets:
    dead = []
    for d in facets["destinations"]:
        c, rows = get(f"{PKG}?category=holiday&destination={d['value']}")
        if c != 200 or len(rows) != d["count"]:
            dead.append(("destination", d["value"]))
    for h in facets["hotel_categories"]:
        c, rows = get(f"{PKG}?category=holiday&hotel_category={h['value']}")
        if c != 200 or len(rows) != h["count"]:
            dead.append(("hotel", h["value"]))
    check("every facet value returns exactly the count it advertises", not dead, str(dead))

    check("the price range is the catalogue's own floor and ceiling",
          facets["price_min"] is None
          or (facets["price_min"] == min(float(r["priceFrom"]) for r in everything)
              and facets["price_max"] == max(float(r["priceFrom"]) for r in everything)),
          f"{facets['price_min']}-{facets['price_max']}")

# ---------------------------------------------------------------------------
print("\n== 5. A score is never served without its source ==")
# ---------------------------------------------------------------------------
half = [r["name"] for r in everything
        if (r.get("rating") is not None) != bool(r.get("rating_source"))]
check("no package carries half a rating", not half, str(half))
check("min_rating matches only rated packages",
      get(f"{PKG}?category=holiday&min_rating=4")[1] == []
      or all(r.get("rating") is not None
             for r in get(f"{PKG}?category=holiday&min_rating=4")[1]))

# ---------------------------------------------------------------------------
print("\n== 6. One package, in full ==")
# ---------------------------------------------------------------------------
if everything:
    pid = everything[0]["id"]
    code, d = get(f"{PKG}/{pid}")
    check(f"GET /packages/{pid} answers", code == 200, str(d)[:160])
    if code == 200:
        for field in ("itinerary", "hotels", "inclusions", "exclusions", "departure_months"):
            check(f"  {field} is a list, empty or not", isinstance(d.get(field), list),
                  f"{field}={type(d.get(field)).__name__}")
        check("  nights is days - 1 or a number somebody set",
              d.get("nights") is None or 0 <= d["nights"] <= d["days"],
              f"days={d['days']} nights={d.get('nights')}")

        live = sorted(x["date"] for x in d["departures"] if x["date"] >= TODAY)
        if live:
            first = next(x for x in d["departures"] if x["date"] == live[0])
            check("  next_departure IS the soonest live departure",
                  d.get("next_departure") == live[0],
                  f"{d.get('next_departure')} vs {live[0]}")
            check("  price_next is that departure's price, not the cheapest",
                  float(d["price_next"]) == float(first["price"]),
                  f"{d.get('price_next')} vs {first['price']}")
        # The day-by-day, when one exists, is numbered from 1 with no gaps -
        # the page renders it as a sequence and a missing day 3 would read as
        # a day that does not happen.
        if d["itinerary"]:
            nums = [x["day_number"] for x in d["itinerary"]]
            check("  the itinerary is numbered 1..n with no gaps",
                  nums == list(range(1, len(nums) + 1)), str(nums))

# ---------------------------------------------------------------------------
print("\n== 7. `category=domestic` means what it says ==")
# ---------------------------------------------------------------------------
# TWO VOCABULARIES MEET ON ONE PARAMETER. `category` is 'holiday' or 'gaming'
# to this table and 'domestic' / 'pilgrimage' / 'international' to everybody
# else. Answering the second with "unknown category" is a naming problem made
# into the caller's problem, so both are accepted and this proves it.
for word, expect_kind in (("domestic", "domestic"), ("Pilgrimage", "pilgrimage"),
                          ("INTERNATIONAL", "international")):
    code, rows = get(f"{PKG}?category={word}")
    same = get(f"{PKG}?trip_type={expect_kind}")[1]
    check(f"category={word} is the {expect_kind} shelf",
          code == 200 and [r["id"] for r in rows] == [r["id"] for r in same],
          f"{code} {len(rows) if code == 200 else rows} vs {len(same)}")

code, rows = get(f"{PKG}?category=holiday")
check("category=holiday is still the merchandising shelf, not a trip type",
      code == 200 and len(rows) == total, f"{code} {len(rows) if code == 200 else rows}")

# ---------------------------------------------------------------------------
print("\n== 8. A card can name the country without inferring it ==")
# ---------------------------------------------------------------------------
# The country is read from customer_destinations by slug, never from the name.
# A package whose destination is in that catalogue must carry its country; one
# whose destination is not must carry null rather than a guess.
code, dests = get(f"{BASE}/api/customer/destinations")
known = {}
if code == 200:
    rows_d = dests if isinstance(dests, list) else dests.get("destinations", [])
    known = {d["name"].lower(): d.get("country") for d in rows_d}
wrong = [
    (p["name"], p.get("country"), known.get((p.get("destination") or "").lower()))
    for p in everything
    if (p.get("destination") or "").lower() in known
    and p.get("country") != known[(p.get("destination") or "").lower()]
]
check("every country matches the destinations catalogue", not wrong, str(wrong)[:200])

# ---------------------------------------------------------------------------
print("\n== 9. Both detail URLs serve the page ==")
# ---------------------------------------------------------------------------
if everything:
    pid = everything[0]["id"]
    for path in (f"/package/{pid}", f"/package-details/{pid}"):
        r = requests.get(f"{BASE}{path}")
        check(f"GET {path} serves the package page",
              r.status_code == 200 and "pkBody" in r.text, str(r.status_code))

# ---------------------------------------------------------------------------
print("\n== 10. A shelf that does not exist is rejected ==")
# ---------------------------------------------------------------------------
r = requests.get(f"{PKG}?trip_type=pilgramage")          # deliberate typo
check("an unknown trip_type is 422, not everything", r.status_code == 422, str(r.status_code))
r = requests.get(f"{PKG}?category=holidays")             # deliberate typo
check("an unknown category is 422, not everything", r.status_code == 422, str(r.status_code))
# THE ONE THAT BROKE THE PAGE. The landing page's search card sends the month
# as a word - "July" - and the listing passed it straight through to here,
# which answered 422 and left Tour Packages empty for anybody who searched
# from the home page. The API is right to refuse it: a month name has no year
# in it. The translation belongs to the page, and this asserts the contract
# both sides now hold to.
r = requests.get(f"{PKG}?month=July")
check("a month NAME is refused, not guessed at", r.status_code == 422, str(r.status_code))
r = requests.get(f"{PKG}?month=2026-13")
check("an impossible month is refused", r.status_code in (404, 422, 500), str(r.status_code))
r = requests.get(f"{PKG}/999999")
check("an unknown package is 404", r.status_code == 404, str(r.status_code))

sys.exit(check.report())
