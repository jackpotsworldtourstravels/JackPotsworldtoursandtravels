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
#: `service_intent` and `context` are ADDITIVE (voice-assistant upgrade): the
#: broad service name beside the older `intent`, and the search the next
#: sentence may change. Every key that was here before is still here.
MESSAGE_KEYS = {"session_id", "reply", "intent", "service_intent", "action", "entities",
                "suggestions", "choices", "context", "timestamp"}

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
    # Packages and places are now DRAWN IN THE CONVERSATION (show_packages /
    # show_places) rather than opened as a page, because the assistant lives on
    # the landing page only and a navigation ends the conversation a follow-up
    # needs. The intents are unchanged.
    ("Goa honeymoon package", "package", "show_packages"),
    ("Show Dubai tour package", "package", "show_packages"),
    ("I want a honeymoon package", "package", "show_packages"),
    ("Places to visit in Jaipur", "places", "show_places"),
    ("things to do in Bali", "places", "show_places"),
    # The two that contain a route and are not one.
    ("honeymoon package from Delhi to Goa", "package", "show_packages"),
    ("what can I see in Goa", "places", "show_places"),
]:
    intent, action, _, _ = routed(said)
    check(f"{said!r} -> {want_intent}", (intent, action) == (want_intent, want_action),
          f"{intent}/{action}")

# ---------------------------------------------------------------------------
print("\n== 3b. One place is where they are going, not a journey ==")
# ---------------------------------------------------------------------------
# WHAT CHANGED. "I want to visit Goa" names one city and no product. It used to
# open the HOTEL search (the old "Rule 1"): choosing a product on the
# traveller's behalf. The voice-assistant brief reverses that — a destination on
# its own is somebody EXPLORING, so the answer is the destination itself, with
# places / packages / hotels offered as the next step (destination_discovery).
# It must still never be read as a route, which is what the original bug was:
# the sentence contains "to", and half a route is not a route.
for said, want_dest in [
    ("I want to visit Goa", "Goa"),
    ("I want to go to Goa", "Goa"),
    ("Goa", "Goa"),
    ("planning to travel to Jaipur", "Jaipur"),
]:
    intent, action, origin, dest = routed(said)
    check(f"{said!r} -> the {want_dest} destination, shown",
          (intent, action, dest) == ("destinations", "show_destination", want_dest),
          f"{intent}/{action} dest={dest}")
    check("  and no origin, because half a route is not a route",
          origin is None, str(origin))

# A place the catalogue has never sold is said plainly, not guessed at: the one
# search that is not limited to the shelf (hotels) is offered, not opened.
for said, want_dest in [("I want to visit Paris", "Paris")]:
    d = say(said)
    check(f"{said!r} says we do not have {want_dest}, and opens nothing",
          d.get("intent") == "destinations" and (d.get("action") or {}).get("type") == "none"
          and want_dest in (d.get("reply") or ""),
          f"{d.get('intent')}/{(d.get('action') or {}).get('type')}")
    check("  and offers its hotels as a choice",
          f"Hotels in {want_dest}" in (d.get("suggestions") or []), str(d.get("suggestions")))
_, action, _, dest = routed("hotels in Kerala")
check("an explicit hotel request for an unstocked place still searches hotels",
      (action, dest) == ("search_hotels", "Kerala"), f"{action} {dest}")

# ...and the sights still belong to sentences that ask about sights.
for said in ["places to visit in Goa", "what can I see in Goa",
             "things to do in Bali", "tourist places in Jaipur"]:
    intent, action, _, _ = routed(said)
    check(f"{said!r} lists the places in the conversation",
          (intent, action) == ("places", "show_places"), f"{intent}/{action}")

# ---------------------------------------------------------------------------
print("\n== 3c. A country is answered with the cities we cover ==")
# ---------------------------------------------------------------------------
# RULE 3. Every hotel and every package is filed under a city, so no hotel's
# address is the word "India": handing the hotel search a country returns an
# empty page and calls it an answer. What we can say honestly is which of its
# cities we sell.
d = say("Show hotels in India")
country_reply = d.get("reply") or ""
check("'Show hotels in India' is understood as a hotel request",
      d.get("intent") == "hotel", str(d.get("intent")))
check("  it does not open a search that cannot match anything",
      (d.get("action") or {}).get("type") == "none",
      str((d.get("action") or {}).get("type")))
check("  the reply names cities we actually cover",
      any(city in country_reply for city in ("Goa", "Hyderabad", "Mumbai", "Delhi")),
      country_reply)
chips = d.get("suggestions") or []
check("  and offers them as chips", len(chips) >= 2, str(chips))
# The chips are ordinary sentences, so the assistant has to understand its own
# offer. An unanswerable suggestion is worse than none.
intent, action, _, dest = routed(chips[0]) if chips else (None, None, None, None)
check(f"  its own chip {chips[0]!r} opens a hotel search" if chips else "  a chip is offered",
      (intent, action) == ("hotel", "search_hotels") and bool(dest),
      f"{intent}/{action} dest={dest}")


# ---------------------------------------------------------------------------
print("\n== 3d. Destination discovery, packages and follow-ups over HTTP ==")
# ---------------------------------------------------------------------------
# The service names the voice-assistant brief uses, the three actions that are
# drawn in the conversation, and the `context` round trip that lets a second
# sentence change the first. Every destination named here is read from the live
# catalogue, so this holds on whatever the 0070 seed holds today.
SERVICES = {
    "Show me destinations": ("destination_discovery", "show_destinations"),
    "I want to visit Goa": ("destination_discovery", "show_destination"),
    "What places can I visit in Hyderabad?": ("destination_location_search", "show_places"),
    "Show locations in Mumbai": ("destination_location_search", "show_places"),
    "Show tour packages": ("tour_package_search", "show_packages"),
    "I want a Goa tour package": ("tour_package_search", "show_packages"),
    "Hotels in Goa": ("hotel_search", "search_hotels"),
    "Hyderabad to Delhi": ("flight_search", "search_flights"),
    "I want a holiday in Goa": ("clarification_required", "none"),
}
for said, (want_service, want_action) in SERVICES.items():
    d = say(said)
    check(f"{said!r} -> {want_service} / {want_action}",
          (d.get("service_intent"), (d.get("action") or {}).get("type")) == (want_service, want_action),
          f"{d.get('service_intent')}/{(d.get('action') or {}).get('type')}")


def say_in_context(message, context, session=None):
    """A held search is sealed to its conversation, so the session id travels with it
    — as it does from the browser."""
    r = requests.post(f"{BASE}/api/customer/assistant/message",
                      json={"message": message, "kind": "voice", "context": context, "session_id": session})
    if r.status_code == 429:
        time.sleep(21)
        r = requests.post(f"{BASE}/api/customer/assistant/message",
                          json={"message": message, "kind": "voice", "context": context, "session_id": session})
    return r.json() if r.status_code == 200 else {"_status": r.status_code}


first = say("Show me Goa tour packages")
check("a package search hands back the search to remember",
      (first.get("context") or {}).get("destination") == "Goa", str(first.get("context")))
second = say_in_context("Only family packages", first.get("context"), first.get("session_id"))
check("'Only family packages' changes the SAME search",
      (second.get("action") or {}).get("params") == {"dest": "Goa", "preference": "family"},
      str((second.get("action") or {}).get("params")))
third = say_in_context("Show me Dubai packages", second.get("context"), first.get("session_id"))
check("a new search replaces the context rather than merging into it",
      (third.get("action") or {}).get("params") == {"dest": "Dubai"},
      str((third.get("action") or {}).get("params")))
junk = say_in_context("Only family packages", {"service": "package", "destination": "x" * 5000,
                                                "days": 10 ** 9, "evil": {"a": 1}})
check("a hostile context is cleaned, not trusted, and never a 500",
      "_status" not in junk and len(str(junk.get("context"))) < 400,
      str(junk)[:120])

# The catalogue-backed lists the browser draws, read here so a drift in either
# endpoint fails this script rather than a traveller's screen.
dests = requests.get(f"{BASE}/api/customer/destinations").json()
slug = dests[0]["id"]
for kind in ("locations", "attractions"):
    rows = requests.get(f"{BASE}/api/customer/destinations/{slug}/{kind}").json()
    need = {"id", "name", "slug", "destination_id"}
    check(f"GET destinations/{{id}}/{kind} rows carry {sorted(need)}",
          all(need <= set(row) for row in rows), str(rows[:1]))
check("an unknown destination is a 404, not an empty list",
      requests.get(f"{BASE}/api/customer/destinations/nowhere-at-all/locations").status_code == 404)
pkgs = requests.get(f"{BASE}/api/customer/packages").json()
need = {"id", "name", "days", "priceFrom", "destination", "next_departure", "price_next"}
check(f"GET packages rows carry what the assistant's cards read {sorted(need)}",
      bool(pkgs) and all(need <= set(row) for row in pkgs), str(pkgs[:1]))
check("the packages API takes the filters the assistant sends",
      requests.get(f"{BASE}/api/customer/packages?destination=Goa&min_days=3&max_days=5"
                   "&month=2026-10&trip_type=domestic").status_code == 200)

# ---------------------------------------------------------------------------
print("\n== 3e. A misspelt place is asked about, never acted on ==")
# ---------------------------------------------------------------------------
# The place is matched against the LIVE catalogue (destinations, famous places and
# areas, loaded per request), so the stored name, slug and parent come from the
# same rows GET /destinations and /destinations/{id}/locations serve. Nothing is
# opened until a choice is made, and a choice sends the traveller's own request
# with the stored name put in.
d = say("Show Charminnar")
check("'Show Charminnar' asks, and opens nothing",
      d.get("service_intent") == "clarification_required"
      and (d.get("action") or {}).get("type") == "none"
      and d.get("reply") == "Did you mean Charminar (Hyderabad)?",
      f"{d.get('service_intent')} {(d.get('action') or {}).get('type')} {d.get('reply')!r}")
choice = (d.get("choices") or [{}])[0]
check("  the offer is the stored place, with its parent to tell it apart",
      choice == {"label": "Charminar · Hyderabad", "message": "Show Charminar"}, str(choice))
shown = say(choice.get("message", ""))
check("  choosing it shows that place (hyderabad / charminar)",
      (shown.get("action") or {}).get("type") == "show_place"
      and (shown["action"]["params"].get("destination"), shown["action"]["params"].get("slug"))
      == ("hyderabad", "charminar"), str(shown.get("action")))
d = say("Hotels near Charminnar")
chosen = say(((d.get("choices") or [{}])[0]).get("message", ""))
check("a misspelt place in a hotel request stays a hotel request",
      (chosen.get("service_intent"), (chosen.get("action") or {}).get("type"))
      == ("hotel_search", "hotels_near"), str((chosen.get("action") or {})))
d = say("Show Chandni Chowk")
check("a place that is not stored is said plainly and nothing is invented",
      (d.get("action") or {}).get("type") == "none"
      and (d.get("reply") or "").startswith("We couldn't find that location")
      and not d.get("choices"), str(d.get("reply")))
d = say("Charminar in Goa")
check("a real place under the wrong destination is corrected aloud, not shown there",
      (d.get("action") or {}).get("type") == "none" and "Hyderabad" in (d.get("reply") or ""),
      str(d.get("reply")))

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
print("\n== 7. A model may read the sentence; it may not invent a city ==")
# ---------------------------------------------------------------------------
# NO HTTP HERE — the provider seam is a pure function, and this is the only
# part of the feature where the input is GENERATED rather than typed. A model
# is allowed to choose between readings the rules could also have produced; it
# is not allowed to introduce a place, and everything it returns is checked
# back against the traveller's own sentence before any of it reaches a search
# box. A host with TRAVEL_AI_PROVIDER unset never calls one at all, which is
# what every check above is running against.
from app.services import travel_ai                      # noqa: E402
from app.services import travel_ai_assistant as engine   # noqa: E402

shelf = engine.Places(destinations=[("goa", "Goa")], countries={"India": [("goa", "Goa")]})

check("the default host calls no provider at all",
      travel_ai.get_provider() is None, str(travel_ai.get_provider()))

honest = travel_ai.Understanding(intent="hotel", destination="Goa", confidence=0.9)
reading = engine._from_provider(honest, "I want to visit Goa", shelf)
check("a model reading the sentence correctly is used",
      reading is not None and reading.place_name == "Goa",
      str(reading))

invented = travel_ai.Understanding(intent="flight", origin="Hyderabad",
                                   destination="Dubai", confidence=0.99)
reading = engine._from_provider(invented, "I want to visit Goa", shelf)
check("a city nobody said is dropped, however confident the model is",
      reading is not None and reading.origin_name is None and reading.place_name is None,
      str(reading))

unsure = travel_ai.Understanding(intent="hotel", destination="Goa", confidence=0.1)
check("an unsure model does not overrule the rules",
      engine._from_provider(unsure, "I want to visit Goa", shelf) is None)

nonsense = travel_ai.Understanding(intent="book_it_for_me", confidence=1.0)
check("an intent outside the list is refused rather than mapped to something near it",
      engine._from_provider(nonsense, "I want to visit Goa", shelf) is None)

same = travel_ai.Understanding(intent="flight", origin="Goa", destination="Goa",
                               confidence=0.9)
reading = engine._from_provider(same, "flights from Goa to Goa", shelf)
check("one airport cannot be both ends, whoever read the sentence",
      reading is not None and reading.place_name is None, str(reading))

check("the airport table is the one the booking card reads, not a second copy",
      engine.resolve_airport("Colombo") == engine.resolve_airport("cmb")
      and (engine.resolve_airport("Colombo") or {}).get("code") == "CMB",
      str(engine.resolve_airport("Colombo")))


# ---------------------------------------------------------------------------
print("\n== 8. The limiter is still there ==")
# ---------------------------------------------------------------------------
# Asserted last, so the back-off inside say() cannot hide its removal.
codes = [requests.post(f"{BASE}/api/customer/assistant/message",
                       json={"message": "flights to Goa"}).status_code
         for _ in range(30)]
check("20/minute per IP still applies", 429 in codes, str(sorted(set(codes))))

sys.exit(check.report())
