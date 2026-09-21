"""Travel Assistant — what a spoken sentence was understood to be, and where it sends the traveller.

WHAT CHANGED, AND WHY IT NEEDED CHANGING

Saying "I would like to go from Hyderabad to Colombo" into the Voice Assistant
opened the TOUR PACKAGES page, filtered to Hyderabad — the origin city, in the
destination filter, for a product nobody asked about.

Nothing misheard it. ``detect_intent`` simply had no test for a route: the
sentence names no product word at all, so it fell through flights, hotels and
sights to the last rule in the function — "a place on its own means a holiday
package" — and the first place named was the one they were leaving FROM.

A ROUTE IS A FLIGHT. Two ends and a direction is what a flight is, and nothing
else this business sells is described that way. That rule now sits second,
after support and My Bookings and ahead of every product.

WHAT THIS SCRIPT PROTECTS

1. **The reported sentence opens a flight search, both ends the right way
   round.** Origin Hyderabad, destination Colombo — not the reverse, and not a
   package. This is the bug; a regression here is it coming back.

2. **A route is understood without a product word, and without the
   catalogue.** Colombo is not on the destinations shelf and is not going to
   be: it is somewhere people fly, not a holiday this business sells. The route
   is read from the SHAPE of the sentence, so a city the catalogue has never
   heard of still fills the To box. Anything that quietly reintroduces "the
   destination must be a known destination" fails here.

3. **Flights outrank the rest — and a product the traveller actually named
   outranks a route.** "A honeymoon package from Delhi to Goa" is a package
   with a route inside it, and "places to visit in Goa" contains the word "to"
   by accident. Both still land where they did. A priority order is only
   useful if it stops somewhere.

4. **Support and My Bookings still outrank everything, route or no route.**
   "Talk to support" is a route-shaped sentence. A traveller asking for a
   person must never be answered with a search box; that rule predates this
   change and this change must not have loosened it.

5. **The action carries the route, and NOTHING else.** ``trip`` is one way
   unless a return was asked for, and ``date`` is present only when a day was
   actually spoken. No passengers and no cabin — the booking card keeps
   whatever the traveller set, which is what the routing brief asked for and
   what stops the assistant quietly editing a form it was not asked to edit.

6. **It still quotes no fare and claims no availability.** Every reply is about
   what happens next. A reply that has grown a number is the one failure mode
   that makes this feature worse than not having it.

WHAT IS DELIBERATELY NOT TESTED HERE
Session ownership, the guest-to-account claim and the history endpoint are the
conversation's rules, not the routing's. The browser half — which airport code
"Colombo" resolves to, and what ends up in the From box — belongs to
travel-assistant.js, and is asserted here by reading the reply's ``entities``
rather than by driving a card this script cannot see.

RUN IT AGAINST A LIVE SERVER, with the 0070 destinations seeded:

    JPW_BASE=http://127.0.0.1:8020 python tests/verify_travel_assistant_routing.py
"""
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402

from config import BASE, Checker  # noqa: E402

check = Checker()

#: The complete response contract. A key outside this set is a field nobody
#: reviewed; a missing one is a browser reading undefined.
MESSAGE_KEYS = {"session_id", "reply", "intent", "action", "entities",
                "suggestions", "timestamp"}

#: Anything money-shaped or availability-shaped in a reply. Any digit at all
#: counts: the assistant has read no fare and no room, so a figure in its own
#: words could only have been invented. WORD BOUNDARIES MATTER HERE — a bare
#: "rs " also reads as the middle of "passengers on the next screen", which is
#: a sentence about what happens next and not about money.
MONEY = re.compile(
    r"₹|\$|\brs\.?\s*\d|\busd\b|\bper night\b"
    r"|\bstarting (?:from|at)\b|\bonwards\b|\d", re.I)

#: One reply per sentence. The classifier is deterministic, so asking twice
#: proves nothing and spends a limiter budget the script is already close to.
_HEARD: dict = {}


def say(message, expect=200):
    """One sentence, waiting out the rate limiter rather than failing on it.

    20/minute is a per-IP budget and this script spends far more of it than a
    traveller ever would, so it backs off for a whole window rather than
    reporting the limiter as a routing failure. Section 7 asserts the limiter
    is still in place, so tolerating a 429 here cannot hide its removal.
    """
    if (message, expect) in _HEARD:
        return _HEARD[(message, expect)]
    for _ in range(4):
        r = requests.post(f"{BASE}/api/customer/assistant/message",
                          json={"message": message, "kind": "voice"})
        if r.status_code != 429:
            break
        time.sleep(21)
    out = ({"_status": r.status_code, "_body": r.text[:180]}
           if r.status_code != expect else r.json())
    _HEARD[(message, expect)] = out
    return out


def params_of(message):
    """The action params for one sentence, or an empty dict."""
    return ((say(message).get("action") or {}).get("params")) or {}


def routed(message):
    """(intent, action type, origin, destination) — the four facts that matter."""
    d = say(message)
    if "_status" in d:
        return (f"HTTP {d['_status']}", d["_body"], None, None)
    e = d.get("entities") or {}
    return (d.get("intent"), (d.get("action") or {}).get("type"),
            e.get("origin"), e.get("destination"))


print(f"\nBASE={BASE}")

# ---------------------------------------------------------------------------
print("\n== 1. The reported sentence ==")
# ---------------------------------------------------------------------------
SAID = "I would like to go from Hyderabad to Colombo"
d = say(SAID)
check("the response carries exactly the documented keys",
      set(d) == MESSAGE_KEYS, str(set(d) ^ MESSAGE_KEYS))
check("  it is a flight, not a package", d.get("intent") == "flight", str(d.get("intent")))
check("  and it opens the flight search",
      (d.get("action") or {}).get("type") == "search_flights",
      str((d.get("action") or {}).get("type")))
p = (d.get("action") or {}).get("params") or {}
check("  from Hyderabad", p.get("from") == "Hyderabad", str(p.get("from")))
check("  to Colombo", p.get("to") == "Colombo", str(p.get("to")))
check("  one way, because no return was asked for", p.get("trip") == "oneway", str(p.get("trip")))
check("  no date, because none was spoken", "date" not in p, str(p))
# The two the brief names explicitly. Their ABSENCE is the assertion: the
# booking card keeps whatever the traveller set.
check("  no passengers and no cabin in the action",
      not ({"passengers", "adults", "cabin"} & set(p)), str(sorted(p)))

# ---------------------------------------------------------------------------
print("\n== 2. A route is read from the sentence, not from the catalogue ==")
# ---------------------------------------------------------------------------
# Colombo is not a row in customer_destinations and Hyderabad is. If the
# destination ever has to be a known destination again, these come back as the
# FIRST city named, which is the original bug exactly.
for said, frm, to in [
    ("Hyderabad to Colombo", "Hyderabad", "Colombo"),
    ("I want to go Hyderabad to Colombo", "Hyderabad", "Colombo"),
    ("Book flight from Hyderabad to Colombo", "Hyderabad", "Colombo"),
    ("I want to fly from Delhi to Singapore", "Delhi", "Singapore"),
    ("kuala lumpur to bangkok", "Kuala Lumpur", "Bangkok"),
]:
    intent, action, origin, dest = routed(said)
    check(f"{said!r} -> flights, {origin} to {dest}",
          (intent, action, origin, dest) == ("flight", "search_flights", frm, to),
          f"{intent}/{action} {origin}->{dest}")

# Spoken order is the direction even with no "to" to read it from...
intent, action, origin, dest = routed("Book flight Hyderabad Dubai tomorrow")
check("'Book flight Hyderabad Dubai tomorrow' -> Hyderabad to Dubai",
      (intent, origin, dest) == ("flight", "Hyderabad", "Dubai"),
      f"{intent} {origin}->{dest}")
check("  and a day that was spoken IS filled in",
      params_of("Book flight Hyderabad Dubai tomorrow").get("date") is not None)

# ...but a sentence that named one end explicitly keeps the end it named.
intent, action, origin, dest = routed("flights to Delhi from Goa")
check("'flights to Delhi from Goa' does not come out backwards",
      (origin, dest) == ("Goa", "Delhi"), f"{origin}->{dest}")

intent, action, origin, dest = routed("Find flights to London")
check("'Find flights to London' names a destination and no origin",
      (intent, origin, dest) == ("flight", None, "London"),
      f"{intent} {origin}->{dest}")

intent, action, origin, dest = routed("kuala lumpur to bangkok round trip")
check("a spoken return makes it a round trip",
      params_of("kuala lumpur to bangkok round trip").get("trip") == "round")
check("  without the trip type leaking into the city name", dest == "Bangkok", str(dest))

# A three-letter word in a travel sentence is an airport code. Title-casing it
# produced "Searching flights from Hyd to Cmb" — a reply that reads like a typo
# for the shorthand people who book flights actually use.
intent, action, origin, dest = routed("hyd to cmb flights")
check("'hyd to cmb flights' keeps the codes as codes",
      (intent, origin, dest) == ("flight", "HYD", "CMB"), f"{intent} {origin}->{dest}")
check("  and the reply says so rather than 'Hyd to Cmb'",
      "HYD" in (say("hyd to cmb flights").get("reply") or ""),
      say("hyd to cmb flights").get("reply", ""))
# The catalogue is consulted first, so a three-letter place it knows is a place.
_, _, _, dest = routed("flights to Goa")
check("  but Goa is still Goa, not GOA", dest == "Goa", str(dest))

# ONE PLACE IS NOT A ROUTE. This is how the bug reached a traveller: both boxes
# filled with Hyderabad, which is a search the card itself refuses on submit
# ("Origin and destination cannot be the same"). A voice transcript that hears
# one city at both ends is the commonest way it arrives.
for said in ["hyd to hyd flights", "hyderabad to hyderabad flights",
             "flights from Goa to Goa", "ticket Goa Goa"]:
    p = params_of(said)
    check(f"{said!r} fills one end, not two",
          "to" not in p and p.get("from") is not None, str(p))

# EVERY PHRASING THE AIRPORT BRIEF LISTS, including the two the route shapes
# alone did not reach: "ticket Hyderabad Colombo" draws no route at all, and
# "Hyderabad airport" would have carried the word "airport" into the From box.
for said in [
    "Hyderabad to Colombo",
    "Book a flight from Hyderabad to Colombo",
    "I need a ticket Hyderabad Colombo",
    "Fly me from Hyderabad to Colombo",
    "Take me from Hyderabad airport to Colombo",
    "I want to travel from Hyderabad to Colombo",
]:
    intent, action, origin, dest = routed(said)
    check(f"{said!r} -> flights, Hyderabad to Colombo",
          (intent, action, origin, dest)
          == ("flight", "search_flights", "Hyderabad", "Colombo"),
          f"{intent}/{action} {origin}->{dest}")

intent, action, origin, dest = routed("Book flight from Delhi to Dubai")
check("'Book flight from Delhi to Dubai' -> Delhi to Dubai",
      (intent, origin, dest) == ("flight", "Delhi", "Dubai"), f"{intent} {origin}->{dest}")

# ---------------------------------------------------------------------------
print("\n== 3. A product the traveller named still wins ==")
# ---------------------------------------------------------------------------
for said, want_intent, want_action in [
    ("Hotels in Goa", "hotel", "search_hotels"),
    ("Find hotels in Goa", "hotel", "search_hotels"),
    ("I need accommodation", "hotel", "none"),
    ("Show hotels near Charminar", "hotel", "hotels_near"),
    ("Goa honeymoon package", "package", "search_packages"),
    ("Show Dubai tour package", "package", "search_packages"),
    ("I want a honeymoon package", "package", "none"),
    ("Places to visit in Jaipur", "places", "open_destination"),
    ("things to do in Bali", "places", "open_destination"),
    # The two that contain a route and are not one.
    ("honeymoon package from Delhi to Goa", "package", "search_packages"),
    ("what can I see in Goa", "places", "open_destination"),
]:
    intent, action, _, _ = routed(said)
    check(f"{said!r} -> {want_intent}", (intent, action) == (want_intent, want_action),
          f"{intent}/{action}")

# ---------------------------------------------------------------------------
print("\n== 4. A person still outranks a search box ==")
# ---------------------------------------------------------------------------
for said, want_intent in [
    ("Talk to support", "support"),           # route-shaped, and not a route
    ("I want to talk to someone", "support"),
    ("cancel my ticket", "support"),          # says "ticket" and is not a flight
    ("where is my booking", "bookings"),
    ("ticket status", "bookings"),
    ("hi", "greeting"),
    ("thanks", "thanks"),
]:
    intent, _, _, _ = routed(said)
    check(f"{said!r} -> {want_intent}", intent == want_intent, str(intent))

# ---------------------------------------------------------------------------
print("\n== 5. Still no fare, and still no availability ==")
# ---------------------------------------------------------------------------
for said in [SAID, "Hotels in Goa", "Goa honeymoon package", "Find flights to London",
             "cheapest flights to Dubai", "how much is a Goa package"]:
    reply = (say(said).get("reply") or "").lower()
    check(f"no figure in the reply to {said!r}", not MONEY.search(reply), reply[:120])

# ---------------------------------------------------------------------------
print("\n== 6. Nothing said is still nothing done ==")
# ---------------------------------------------------------------------------
intent, action, origin, dest = routed("asdfghjkl")
check("gibberish falls back rather than guessing a place",
      (intent, action, origin, dest) == ("fallback", "none", None, None),
      f"{intent}/{action} {origin}->{dest}")
r = requests.post(f"{BASE}/api/customer/assistant/message", json={"message": ""})
check("an empty message is refused by the schema, not answered",
      r.status_code == 422, str(r.status_code))

# ---------------------------------------------------------------------------
print("\n== 7. The limiter is still there ==")
# ---------------------------------------------------------------------------
# Asserted last, so the back-off inside say() cannot hide its removal.
codes = [requests.post(f"{BASE}/api/customer/assistant/message",
                       json={"message": "flights to Goa"}).status_code
         for _ in range(30)]
check("20/minute per IP still applies", 429 in codes, str(sorted(set(codes))))

sys.exit(check.report())
