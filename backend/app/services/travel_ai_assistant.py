"""The Travel Assistant's understanding — what was asked, and which screen answers it.

FIVE FUNCTIONS, IN THE ORDER THEY RUN:

    extract_locations(text, places)   every place the sentence names
    detect_intent(text, places)       what was asked for, and about where
    resolve_airport(name)             a city -> the airport a flight leaves from
    execute_action(reading)           the words, and the screen to open
    analyze_message(text, places)     all four, as one reading

``customer_assistant_service`` owns the CONVERSATION — the session, the stored
turns, the ownership rules — and calls this module for every judgement. Nothing
else in the application decides what the assistant understands or says: the
browser renders ``reply`` and follows ``action``, and carries no second copy of
these rules. A phrase understood in the panel and not in the voice popup would
be two assistants wearing one name.

NO PLACE NAME IS WRITTEN HERE. Destinations and their countries come from
``customer_destinations`` and landmarks from ``customer_attractions``
(0070/0075), so a destination added through the catalogue is understood the
same day with no edit to this file. Airports come from
``frontend/assets/js/airports.js`` — the table the booking card's own picker
uses — parsed once, because two copies of an airport list is two lists that
disagree.

THE FOUR RULES THE ROUTING BRIEF ASKED FOR, AND WHERE THEY LIVE

  1. ONE PLACE, NO PRODUCT WORD -> HOTELS. "I want to visit Goa" is somebody
     saying where they are going, not asking for a timetable and not asking
     what there is to photograph. It opens the hotel search. It must not open
     flights: there is no second city, and half a route is not a route.
  2. TWO PLACES AND A DIRECTION -> FLIGHTS. That is what a flight is, and
     nothing else this business sells is described that way. It holds for a
     city the catalogue has never heard of, because the route is read from the
     shape of the sentence.
  3. A COUNTRY OR A REGION -> HOTELS, VIA ITS CITIES. "Show hotels in India"
     names a country, and no hotel's address is the word "India", so passing
     it to the hotel search as typed would produce an empty page and call it
     an answer. The catalogue knows which destinations are in a country, so
     the assistant offers them; one destination in the country and it goes
     straight there.
  4. A PACKAGE IS ONLY A PACKAGE WHEN SOMEBODY SAYS SO — package, tour,
     holiday, itinerary, getaway. It used to be where a bare place name fell
     to, which is how "Goa" opened the holiday shelf.

  Priority, when a sentence is several of these at once: support and My
  Bookings first (a person asking for a person must never get a search box),
  then flights, then hotels, then sights, then packages.

A MODEL IS OPTIONAL, AND THE RULES ARE NOT. ``services/travel_ai`` may put a
provider in front of ``detect_intent``; what it returns is validated against
the traveller's own sentence and then converted into exactly the ``Reading``
the rules would have produced, so everything downstream is unchanged and a
provider that is missing, slow or wrong costs nothing but some tolerance for
unusual phrasing.

WHAT IT DELIBERATELY DOES NOT DO: quote a fare, claim a room is free, or book
anything. It has read no prices and no availability, so any figure in a reply
here could only have been invented. It understands the request and opens the
screen that holds the real answer — always the existing search, never a second
booking path.
"""
from __future__ import annotations

import datetime as dt
import enum
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import CustomerAttraction, CustomerDestination
from app.services import travel_ai

log = logging.getLogger(__name__)


class Intent(str, enum.Enum):
    """Everything the assistant understands.

    Adding a member is the only way to widen what it does: the response table
    below and the browser's action map are both keyed by these names, so an
    intent with no answer falls to FALLBACK rather than doing something
    unintended.
    """

    GREETING = "greeting"
    FLIGHT = "flight"
    HOTEL = "hotel"
    PACKAGE = "package"
    PLACES = "places"
    BOOKINGS = "bookings"
    SUPPORT = "support"
    THANKS = "thanks"
    FALLBACK = "fallback"


@dataclass
class Reading:
    """What one sentence was understood to mean."""

    intent: Intent
    #: Destination slug and display name, when a known place was named.
    place_slug: str | None = None
    place_name: str | None = None
    #: A second known place, which on a flight makes the origin.
    origin_slug: str | None = None
    origin_name: str | None = None
    #: A landmark, when one was named ("hotels near Charminar").
    attraction_slug: str | None = None
    attraction_name: str | None = None
    #: ISO day, when the sentence carried one we can be sure of.
    date: str | None = None
    #: Party size, when it was counted out loud. Reported, never applied —
    #: see _find_passengers.
    passengers: int | None = None
    #: "oneway" unless a return was clearly asked for. Flights only.
    trip: str = "oneway"
    #: True when `place_name` is a COUNTRY, not a city — Rule 3. A country is
    #: not a search term any hotel's address matches, so the answer is its
    #: cities rather than an empty results page.
    is_country: bool = False
    #: The destination names inside that country, in shelf order.
    options: list[str] = field(default_factory=list)
    #: 1.0 for a phrase match, lower for a bare keyword.
    confidence: float = 1.0

    def entities(self) -> dict:
        """The reading flattened into what the browser fills a field with.

        THE SAME NAMES THE ACTION PARAMS USE, so travel-assistant.js reads one
        vocabulary rather than two. `destination` is the place the request is
        about whatever the intent — the city to fly to, to stay in, or to
        holiday in — and `origin` is only ever a flight's other end.
        """
        return {
            "origin": self.origin_name,
            "destination": self.place_name,
            "date": self.date,
            "passengers": self.passengers,
            "trip": self.trip,
        }


@dataclass
class Answer:
    """What to say, and which existing screen to open."""

    reply: str
    intent: Intent
    #: {"type": ..., "params": {...}} — the browser maps `type` onto the
    #: navigation it already has. "none" means stay put.
    action: dict = field(default_factory=lambda: {"type": "none", "params": {}})
    #: Short follow-up prompts the panel offers as chips.
    suggestions: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Vocabulary. Phrases only — never place names, which come from the database.
# ---------------------------------------------------------------------------
#: Every way a traveller says "this is a flight". Wider than the product word
#: on purpose: the brief lists ticket, departure and arrival alongside fly and
#: flight, because those are the words a spoken request actually uses.
_FLIGHT = re.compile(
    r"\b(flight|flights|fly|flying|flew|air ?fare|airfare|air ?ticket|airticket"
    r"|plane|aeroplane|airplane|ticket|tickets|boarding|layover|stopover"
    r"|non ?stop|one ?way|round ?trip|depart|departs|departing|departure"
    r"|arrive|arrives|arriving|arrival)\b", re.I)
_HOTEL = re.compile(r"\b(hotel|hotels|stay|stays|room|rooms|accommodation|resort)\b", re.I)
_PACKAGE = re.compile(r"\b(package|packages|holiday|holidays|trip|tour|tours|itinerary|getaway)\b", re.I)
#: ASKING WHAT THERE IS TO SEE — and only that. "Visit" used to be in this
#: list, which made "I want to visit Goa" a question about photographs when it
#: is somebody telling us where they are going. The bare verbs moved to
#: _VISIT below; what is left here is a sentence that can only be about
#: sightseeing.
_PLACES = re.compile(
    r"\b(sight ?seeing|sights|places|attraction|attractions|landmark|landmarks"
    r"|monument|monuments|temples|things to do|tourist (?:spot|spots|place|places)"
    r"|what (?:to|can i|should i) (?:see|do)|what can we (?:see|do))\b", re.I)
#: TELLING US WHERE THEY ARE GOING. A travelling verb with one place after it
#: is Rule 1 — a hotel request — and never a route, because there is only one
#: end. Kept apart from _PLACES so "places to visit in Jaipur" still opens the
#: sights and "I want to visit Jaipur" opens the hotels.
_VISIT = re.compile(
    r"\b(visit|visiting|go to|going to|travel to|travelling to|traveling to"
    r"|head to|heading to|explore|exploring|holiday in|vacation in|stay in)\b", re.I)
_BOOKINGS = re.compile(r"\b(my booking|my bookings|my trip|my trips|booking status|pnr|ticket status)\b", re.I)
_SUPPORT = re.compile(r"\b(support|help ?desk|agent|human|complain|complaint|refund|cancel my|talk to (?:someone|support)|customer care)\b", re.I)
_GREETING = re.compile(r"^\s*(hi|hey|hello|hai|namaste|good (?:morning|afternoon|evening))\b", re.I)
_THANKS = re.compile(r"\b(thanks|thank you|thx|great, thanks)\b", re.I)
#: A return leg, said out loud. Everything else is one way, which is what the
#: booking card opens on.
_ROUND = re.compile(r"\b(round ?trip|return ticket|two ways?|both ways|and (?:come|coming) back)\b", re.I)

# --- The shape a route is spoken in ----------------------------------------
# THREE FORMS, TRIED IN THIS ORDER. The first two name their own ends and are
# unambiguous; the third is the bare "Hyderabad to Colombo".
_ROUTE_FROM_TO = re.compile(r"\bfrom\s+(?P<a>.+?)\s+to\s+(?P<b>.+?)\s*$", re.I)
_ROUTE_TO_FROM = re.compile(r"\bto\s+(?P<b>.+?)\s+from\s+(?P<a>.+?)\s*$", re.I)
#: The left side is GREEDY on purpose. "I want to go Hyderabad to Colombo"
#: contains two "to"s and only the LAST one separates the ends of the route; a
#: lazy left side hands back "go Hyderabad to Colombo" as the origin.
_ROUTE_BARE = re.compile(r"^(?P<a>.+)\s+to\s+(?P<b>.+?)\s*$", re.I)
#: "Flights from Hyderabad" — an origin, and no destination yet.
_ROUTE_FROM = re.compile(r"\bfrom\s+(?P<a>.+?)\s*$", re.I)

#: How a request is WRAPPED. Stripped off the front of a route span, so
#: "I want to go Hyderabad" leaves "Hyderabad", and "Find flights" leaves
#: nothing at all.
_SPAN_LEAD = re.compile(
    r"^(?:\s*(?:i|we|you|me|my|us|a|an|the|is|are|there|any|some|please|pls"
    r"|can|could|would|will|shall|want|wanted|wanna|need|needed|like|love"
    r"|looking|look|search|searching|find|show|get|give|book|booking|reserve"
    r"|plan|planning|going|go|travel|travelling|traveling|fly|flying|take"
    r"|taking|visit|visiting|see|cheap|cheapest|best|direct|non ?stop|one ?way"
    r"|round ?trip|return|flight|flights|air ?ticket|airfare|fare|fares|ticket"
    r"|tickets|plane|trip|trips|journey|route|hotel|hotels|stay|package"
    r"|packages|holiday|holidays|tour|tours|for|to|from|of|in|on|next|this)"
    r"\b[\s,.]*)+", re.I)

#: Where a place name ENDS. The span is cut at the first of these, so
#: "Colombo tomorrow" and "Dubai for 2 passengers" both leave the city behind.
_SPAN_TAIL = re.compile(
    r"\b(?:on|in|for|at|by|with|from|around|before|after|via|next|this|coming"
    r"|today|tomorrow|tonight|yesterday|weekend|week|month|morning|evening"
    r"|night|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday"
    r"|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct"
    r"|nov|dec|january|february|march|april|june|july|august|september"
    r"|october|november|december|adult|adults|child|children|infant|infants"
    r"|passenger|passengers|people|person|persons|pax|traveller|travellers"
    r"|traveler|travelers|flight|flights|ticket|tickets|fare|fares|please|pls"
    # "from Hyderabad airport to Colombo" — the word is how a person
    # points at a city, and it is never part of the city's name.
    r"|airport|airports|terminal"
    r"|thanks|thank|and|or"
    # Trip type and urgency trail a route as often as a date does —
    # "kuala lumpur to bangkok round trip" must not put Bangkok Round Trip
    # in the To box. _ROUND has already read the trip type off the whole
    # sentence by the time a span is cut.
    r"|round|trip|trips|return|returning|direct|non ?stop|nonstop|one ?way"
    r"|oneway|way|cheap|cheapest|best|now|asap|urgent|only|also)\b.*$", re.I)

#: A span longer than this is the rest of the sentence, not a city. An origin
#: box reading "I would like" is a worse answer than an empty one.
_SPAN_MAX_CHARS = 40
_SPAN_MAX_WORDS = 4

#: A bare three-letter word, which in a travel sentence is an airport code.
_CODE = re.compile(r"\A[A-Za-z]{3}\Z")

#: A party size, counted out loud.
_PAX = re.compile(
    r"\b(\d{1,2})\s*(?:adults?|passengers?|people|persons?|pax|travell?ers?|seats?)\b"
    r"|\bfor\s+(\d{1,2})\b", re.I)


def _span(raw: str | None) -> str | None:
    """One end of a spoken route, reduced to the place name or to nothing.

    Speech arrives as a whole sentence — "I would like to go from Hyderabad to
    Colombo" — so each half of the route carries the request wrapped around it.
    This unwraps it and REFUSES whatever still does not look like a place,
    because an empty box is an answer the traveller can finish and half a
    sentence in the From box is not.

    NO PLACE NAME IS CONSULTED HERE, which is the point. Colombo is not on the
    destinations shelf and is not going to be — it is somewhere people fly, not
    a holiday this business sells — and a route has to work for it anyway.
    """
    text = re.sub(r"[\s,.!?]+", " ", (raw or "")).strip()
    text = _SPAN_LEAD.sub("", text)
    text = _SPAN_TAIL.sub("", text).strip(" ,.-")
    if not text or len(text) > _SPAN_MAX_CHARS:
        return None
    if re.search(r"\d", text) or len(text.split()) > _SPAN_MAX_WORDS:
        return None
    return text


def _route(raw: str) -> tuple[str | None, str | None]:
    """The two ends of a spoken route. Either may come back unknown."""
    for pattern in (_ROUTE_FROM_TO, _ROUTE_TO_FROM, _ROUTE_BARE):
        m = pattern.search(raw)
        if m:
            return _span(m.group("a")), _span(m.group("b"))
    only = _ROUTE_FROM.search(raw)
    return (_span(only.group("a")) if only else None), None


def _bare_pair(raw: str) -> tuple[str | None, str | None]:
    """Two places said back to back, with no "to" between them.

    "I need a ticket Hyderabad Colombo" is a flight request that draws no route
    shape at all. Strip the request off it — the same two vocabularies a span
    is trimmed with — and what is left is the two ends in the order they were
    spoken, which is the only direction the sentence carries.

    ONLY A CLEAN PAIR IS ACCEPTED. Three words could be "Kuala Lumpur Bangkok"
    or one city and a stray, and nothing here can tell which; detect_intent
    tries the catalogue's own place names first, which is what covers the
    multi-word cases for places this business already knows.
    """
    text = re.sub(r"[\s,.!?]+", " ", raw or "").strip()
    text = _SPAN_LEAD.sub("", text)
    text = _SPAN_TAIL.sub("", text).strip(" ,.-")
    words = text.split()
    if len(words) != 2 or any(re.search(r"\d", w) for w in words):
        return None, None
    return words[0], words[1]


def _find_passengers(text: str) -> int | None:
    """A party size, only when the sentence counted one out.

    REPORTED, NOT APPLIED. The booking card keeps whatever the traveller set in
    its passenger selector; the brief is explicit that the assistant fills the
    route and leaves the party and the cabin alone. It is read here so the
    reading is complete, and so a screen that wants it later need not go back
    to the sentence.
    """
    m = _PAX.search(text or "")
    if not m:
        return None
    try:
        n = int(m.group(1) or m.group(2))
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 9 else None


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")


@dataclass
class Places:
    """The catalogue's own place names, ready to match against a sentence."""

    destinations: list[tuple[str, str]] = field(default_factory=list)      # (slug, name)
    attractions: list[tuple[str, str, str]] = field(default_factory=list)  # (dest slug, slug, name)
    #: Country name -> the destinations we sell inside it, in shelf order.
    #: THIS IS WHAT MAKES "hotels in Thailand" ANSWERABLE. No hotel's address
    #: is the word "Thailand", so the country has to be turned into the cities
    #: it contains before it can mean anything to a hotel search.
    countries: dict[str, list[tuple[str, str]]] = field(default_factory=dict)


def load_places(db: Session) -> Places:
    """Read the place names once per request. Two small indexed queries."""
    dests = db.execute(
        select(CustomerDestination.slug, CustomerDestination.name,
               CustomerDestination.country)
        .where(CustomerDestination.is_active.is_(True))
        .order_by(CustomerDestination.sort_order, CustomerDestination.name)
    ).all()
    attrs = db.execute(
        select(CustomerDestination.slug, CustomerAttraction.slug, CustomerAttraction.name)
        .join(CustomerAttraction,
              CustomerAttraction.destination_id == CustomerDestination.customer_destination_id)
        .where(CustomerAttraction.is_active.is_(True), CustomerDestination.is_active.is_(True))
    ).all()
    countries: dict[str, list[tuple[str, str]]] = {}
    for d in dests:
        if d.country:
            countries.setdefault(d.country.strip(), []).append((d.slug, d.name))
    return Places(
        destinations=[(d.slug, d.name) for d in dests],
        attractions=[(a[0], a[1], a[2]) for a in attrs],
        countries=countries,
    )


def _find_place(text: str, places: Places) -> list[tuple[str, str, int]]:
    """Every known destination named in the sentence, in the order spoken.

    Matched on a WORD BOUNDARY, so "Goa" in "Goan" is not a hit and "Male"
    inside "female" is not either — the failure a bare `in` test would make.
    Longest name first, so "North Goa" wins over "Goa" where both would match.
    """
    hits: list[tuple[str, str, int]] = []
    for slug, name in sorted(places.destinations, key=lambda p: -len(p[1])):
        m = re.search(rf"\b{re.escape(name)}\b", text, re.I)
        if m and not any(h[0] == slug for h in hits):
            hits.append((slug, name, m.start()))
    hits.sort(key=lambda h: h[2])
    return hits


def _find_attraction(text: str, places: Places) -> tuple[str, str, str] | None:
    for dest_slug, slug, name in sorted(places.attractions, key=lambda a: -len(a[2])):
        if re.search(rf"\b{re.escape(name)}\b", text, re.I):
            return dest_slug, slug, name
    return None


def _find_country(text: str, places: Places) -> tuple[str, list[tuple[str, str]]] | None:
    """A country we sell into, named in the sentence, with its destinations.

    A DESTINATION OF THE SAME NAME WINS. Singapore and Dubai are a city on the
    shelf and a country on a map; the shelf is the more specific answer and is
    what the traveller can actually be shown, so _find_place is consulted
    first by the caller and this is only reached when it found nothing.
    """
    for country, dests in sorted(places.countries.items(), key=lambda c: -len(c[0])):
        if re.search(rf"\b{re.escape(country)}\b", text, re.I):
            return country, dests
    return None


#: Where a place name can begin when the catalogue does not know it. Only
#: after one of these — a preposition or a travelling verb — so that "I need
#: accommodation" and "I want a honeymoon package" do not hand the hotel
#: search the word "accommodation" or "honeymoon" and call it a city.
_PLACE_LEAD = re.compile(
    r"\b(?:in|at|near|around|to|towards|for|visit|visiting|explore|exploring"
    r"|holiday in|vacation in)\s+(?P<p>\S.*)$", re.I)

#: A span made only of words like these is the product, not the place.
_NOT_A_PLACE = re.compile(
    r"^(?:hotel|hotels|room|rooms|stay|stays|accommodation|resort|resorts"
    r"|package|packages|holiday|holidays|tour|tours|trip|trips|flight|flights"
    r"|ticket|tickets|place|places|somewhere|anywhere|here|there|home"
    r"|honeymoon|family|weekend|beach|beaches|mountain|mountains|hill|hills"
    r"|abroad|overseas|international|domestic)$", re.I)


def _free_place(text: str) -> str | None:
    """A place the catalogue has never heard of, read out of the sentence.

    WITHOUT THIS, THE ASSISTANT CAN ONLY UNDERSTAND WHAT WE ALREADY SELL.
    "Hotels in Kerala" and "I want to visit Paris" name real places that are
    not rows in ``customer_destinations``, and answering them with "sorry, I
    did not catch that" reads as a broken assistant rather than as an empty
    shelf. The hotel search is opened with the name as spoken, and it says
    honestly when nothing matches.

    DELIBERATELY NARROW. It reads only what follows a preposition or a
    travelling verb, refuses anything that is a product word, a number or most
    of a sentence, and otherwise gives up — a wrong city in the search box is
    worse than an empty one.
    """
    lead = None
    for m in _PLACE_LEAD.finditer(text):
        lead = m          # the LAST one: "I want to visit Paris" is "visit Paris"
    candidate = _span(lead.group("p") if lead else text)
    if not candidate or _NOT_A_PLACE.match(candidate):
        return None
    if _HOTEL.search(candidate) or _PACKAGE.search(candidate) or _FLIGHT.search(candidate):
        return None
    if lead is None and candidate.islower():
        # No preposition and no capital letter — "book something" rather than
        # a name. A typed place keeps its capital; a spoken one reaches here
        # through the preposition branch.
        return None
    return candidate


def extract_locations(text: str, places: Places) -> dict:
    """Every place one sentence names, of each kind it can name one.

    ``{"destinations": [(slug, name), ...], "attraction": (dest, slug, name) |
    None, "country": (name, [(slug, name), ...]) | None, "route": (origin,
    destination), "free_text": str | None}``

    ONE PASS, READ BY EVERY RULE. detect_intent decides what the sentence is
    FOR; this decides what it is ABOUT, and keeping the two apart is what lets
    a country reach the hotel rule and a landmark reach it differently.
    """
    destinations = [(slug, name) for slug, name, _ in _find_place(text, places)]
    return {
        "destinations": destinations,
        "attraction": _find_attraction(text, places),
        "country": None if destinations else _find_country(text, places),
        "route": _route(text),
        "free_text": None if destinations else _free_place(text),
    }


def _named(span: str | None, places: Places) -> tuple[str | None, str | None]:
    """A route span, reconciled with the catalogue where the catalogue has it.

    A place the shelf knows comes back under ITS name and ITS slug, so
    "hyderabad" spoken becomes "Hyderabad" and the same reading could open the
    destination page. A place the shelf does not know comes back AS SPOKEN and
    with no slug, because a flight is not limited to the destinations this
    business sells holidays in — which is the whole of the Colombo case.
    """
    if not span:
        return None, None
    lowered = span.lower()
    for slug, name in places.destinations:
        if name.lower() == lowered:
            return slug, name
    # A THREE-LETTER TOKEN IS AN AIRPORT CODE, NOT A WORD. "hyd to cmb" is how
    # people who book often say it, and title-casing turned that into "Hyd" and
    # "Cmb" — a reply that reads like a typo. The catalogue is checked first, so
    # a three-letter place it actually knows (Goa) still comes back as itself.
    if _CODE.fullmatch(span):
        return None, span.upper()
    return None, span.title() if (span.islower() or span.isupper()) else span


def _find_date(text: str) -> str | None:
    """Only days we can be certain of. A vague "next month" is left unset."""
    today = dt.date.today()
    lowered = text.lower()
    if re.search(r"\btoday\b", lowered):
        return today.isoformat()
    if re.search(r"\btomorrow\b", lowered):
        return (today + dt.timedelta(days=1)).isoformat()
    if re.search(r"\bday after tomorrow\b", lowered):
        return (today + dt.timedelta(days=2)).isoformat()
    if re.search(r"\bnext week\b", lowered):
        return (today + dt.timedelta(days=7)).isoformat()
    iso = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", text)
    if iso:
        try:
            return dt.date.fromisoformat(iso.group(1)).isoformat()
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
# 1. What was asked
# ---------------------------------------------------------------------------
def detect_intent(text: str, places: Places) -> Reading:
    """Classify one sentence. Deterministic, and never raises.

    THE ORDER OF THESE TESTS IS THE DESIGN.

    SUPPORT AND MY BOOKINGS OUTRANK EVERYTHING. A traveller asking for a person,
    or for the trip they have already paid for, must not be answered with a
    search box.

    THEN FLIGHTS, and that is the fix this function was rewritten for. "I would
    like to go from Hyderabad to Colombo" names no product at all: the old order
    fell through every product test to "a place on its own", which meant a
    holiday package — so a spoken route opened the packages shelf, with the
    origin city in the destination filter. A ROUTE IS A FLIGHT. Two ends and a
    direction is what a flight is, and nothing else this business sells is
    described that way.

    A ROUTE STILL YIELDS TO A PRODUCT THE TRAVELLER NAMED. "A honeymoon package
    from Delhi to Goa" is a package with a route inside it, and "places to visit
    in Goa" only contains the word "to" by accident. So flights take every
    sentence that says flight, fly, ticket, departure or arrival outright, plus
    every sentence that draws a route and names no other product — and a
    sentence that names hotels, packages or sights keeps them.

    A MODEL WOULD SIT HERE, in front of the rules, and return the same
    ``Reading``; everything downstream would be unchanged. That is the whole
    seam — see the module docstring.
    """
    raw = (text or "").strip()
    if not raw:
        return Reading(intent=Intent.FALLBACK, confidence=0.0)

    where = extract_locations(raw, places)
    found = _find_place(raw, places)
    attraction = where["attraction"]
    country = where["country"]
    free_place = where["free_text"]
    date = _find_date(raw)
    pax = _find_passengers(raw)

    place_slug = found[0][0] if found else None
    place_name = found[0][1] if found else None

    if _SUPPORT.search(raw):
        return Reading(intent=Intent.SUPPORT)
    if _BOOKINGS.search(raw):
        return Reading(intent=Intent.BOOKINGS)
    if _GREETING.search(raw) and not (found or attraction):
        return Reading(intent=Intent.GREETING)
    if _THANKS.search(raw) and not (found or attraction):
        return Reading(intent=Intent.THANKS)

    # ---- 1. Flights -------------------------------------------------------
    said_flight = bool(_FLIGHT.search(raw))
    named_other = bool(_HOTEL.search(raw) or _PACKAGE.search(raw) or _PLACES.search(raw))
    origin_text, dest_text = _route(raw)
    # ONE PLACE IS NOT A ROUTE. A voice transcript that hears the same city at
    # both ends is the commonest way this arrives, and filling both boxes with
    # one airport builds a search the booking card itself refuses on submit —
    # "Origin and destination cannot be the same". Keep the origin, which is
    # the end a traveller is least often misheard on, and ask for the other.
    if origin_text and dest_text and origin_text.lower() == dest_text.lower():
        dest_text = None

    # HALF A ROUTE IS NOT A ROUTE — Rule 1, and the reason it is here. "I want
    # to go to Goa" draws the shape of a route because it contains the word
    # "to", but it names ONE place, and one place is where somebody is going
    # rather than a journey between two. It used to open the flight search with
    # the To box filled and the From box empty, which is a timetable nobody
    # asked for. A sentence that says "flight" outright still gets one.
    both_ends = bool(origin_text and dest_text)
    if said_flight or (both_ends and not named_other):
        origin_slug, origin_name = _named(origin_text, places)
        dest_slug, dest_name = _named(dest_text, places)

        # NO "TO" ANYWHERE, and a flight asked for outright — "Book flight
        # Hyderabad Dubai tomorrow", "I need a ticket Hyderabad Colombo".
        # Spoken order is the only direction such a sentence carries.
        #
        # Only when the route shape found NEITHER end: a sentence that named
        # one end has already said which end it is, and overruling that is how
        # "flights to Delhi from Goa" comes out backwards.
        if said_flight and origin_name is None and dest_name is None:
            if len(found) >= 2:
                # Places the catalogue knows, which is what makes a two-word
                # city name readable here.
                origin_slug, origin_name = found[0][0], found[0][1]
                dest_slug, dest_name = found[1][0], found[1][1]
            else:
                # Colombo is not on that shelf, so fall back to what is left of
                # the sentence once the request is stripped off it.
                a, b = _bare_pair(raw)
                origin_slug, origin_name = _named(a, places)
                dest_slug, dest_name = _named(b, places)

        # The same-place guard again, because the two branches above can each
        # produce it — "ticket Goa Goa" reaches here having named one place
        # twice, and one airport cannot be both ends of a flight.
        if origin_name and dest_name and origin_name.lower() == dest_name.lower():
            dest_slug = dest_name = None

        return Reading(
            intent=Intent.FLIGHT,
            place_slug=dest_slug, place_name=dest_name,
            origin_slug=origin_slug, origin_name=origin_name,
            date=date, passengers=pax,
            trip="round" if _ROUND.search(raw) else "oneway",
            confidence=1.0 if (origin_name and dest_name) else 0.6,
        )

    # ---- 2. Hotels --------------------------------------------------------
    if attraction and _HOTEL.search(raw):
        return Reading(
            intent=Intent.HOTEL, place_slug=attraction[0],
            place_name=place_name, attraction_slug=attraction[1],
            attraction_name=attraction[2], date=date, passengers=pax,
        )
    if _HOTEL.search(raw):
        # RULE 3 — A COUNTRY IS ANSWERED WITH ITS CITIES. "Show hotels in
        # India" is a hotel request about a place no hotel's address contains,
        # so the country is carried as the country it is and execute_action
        # offers what we actually have in it.
        if country and not place_name:
            return Reading(
                intent=Intent.HOTEL, place_name=country[0], is_country=True,
                options=[n for _, n in country[1]], date=date, passengers=pax,
            )
        # A city the catalogue does not stock is still a city. The hotel
        # search takes it as spoken and says honestly if it has nothing.
        return Reading(
            intent=Intent.HOTEL, place_slug=place_slug,
            place_name=place_name or free_place,
            date=date, passengers=pax,
            confidence=1.0 if place_name else (0.7 if free_place else 0.6),
        )

    # ---- 3. Places to visit ----------------------------------------------
    if _PLACES.search(raw) or attraction:
        slug = place_slug or (attraction[0] if attraction else None)
        name = place_name
        if not name and attraction:
            name = next((n for s, n in places.destinations if s == attraction[0]), None)
        return Reading(
            intent=Intent.PLACES, place_slug=slug, place_name=name or (country[0] if country else None),
            attraction_slug=attraction[1] if attraction else None,
            attraction_name=attraction[2] if attraction else None,
            is_country=bool(country and not slug),
            options=[n for _, n in country[1]] if (country and not slug) else [],
            confidence=1.0 if slug else 0.5,
        )

    # ---- 4. Holiday packages ---------------------------------------------
    if _PACKAGE.search(raw):
        # A PACKAGE WITH A ROUTE INSIDE IT IS STILL ABOUT WHERE IT GOES.
        # "honeymoon package from Delhi to Goa" names Delhi first, and the
        # first place named is the one they are leaving from — filtering the
        # holiday shelf by it is the same mistake in a smaller place.
        if both_ends:
            slug, name = _named(dest_text, places)
            if slug:
                place_slug, place_name = slug, name
        if country and not place_name:
            return Reading(
                intent=Intent.PACKAGE, place_name=country[0], is_country=True,
                options=[n for _, n in country[1]], date=date, passengers=pax,
            )
        return Reading(
            intent=Intent.PACKAGE, place_slug=place_slug,
            place_name=place_name or free_place,
            date=date, passengers=pax,
            confidence=1.0 if place_name else 0.6,
        )

    # ---- RULE 1 — a place, and nothing said about what to do there --------
    # "I want to visit Goa", "Goa", "planning to travel to Kerala". Somebody
    # naming where they are going and no product at all is asking where to
    # stay: it is the one answer that is useful before anything else is known,
    # and the hotel search is where dates and rooms are chosen anyway.
    #
    # THIS USED TO BE THE PACKAGES SHELF, which meant a single city opened a
    # holiday catalogue that may hold nothing for it. Packages are now reached
    # only by asking for one, which is Rule 4.
    if place_name or free_place:
        # "I want to visit Goa" says outright that this is where they are
        # going; a bare "Goa" is the same request with the sentence left off.
        spoken_plainly = bool(_VISIT.search(raw))
        return Reading(
            intent=Intent.HOTEL, place_slug=place_slug,
            place_name=place_name or free_place, date=date,
            confidence=(1.0 if spoken_plainly else 0.8) if place_name else 0.6,
        )
    if country:
        return Reading(
            intent=Intent.HOTEL, place_name=country[0], is_country=True,
            options=[n for _, n in country[1]], date=date, confidence=0.6,
        )

    return Reading(intent=Intent.FALLBACK, confidence=0.0)


# ---------------------------------------------------------------------------
# 2. What to say back
# ---------------------------------------------------------------------------
def _country_answer(reading: Reading, product: str, action_type: str, key: str) -> Answer:
    """Rule 3 — a country turned into something a search box can use.

    A COUNTRY IS NOT A SEARCH TERM. Every hotel and every package is filed
    under a city, so handing the hotel search the word "India" returns an
    empty page — a wrong answer dressed as a real one. What we can honestly
    say is which of its cities we sell, so that is what is offered, and the
    chips are ordinary follow-up sentences the assistant already understands.

    ONE CITY IN THAT COUNTRY AND THERE IS NOTHING TO ASK, so it goes straight
    through to the search, which is what somebody saying "hotels in Sri Lanka"
    meant anyway.
    """
    country = reading.place_name
    options = reading.options
    if len(options) == 1:
        only = options[0]
        return Answer(
            reply=f"In {country} we go to {only} — looking up {product} there now.",
            intent=reading.intent,
            action={"type": action_type, "params": {key: only}},
        )
    if options:
        shown = options[:4]
        listed = ", ".join(shown[:-1]) + " and " + shown[-1] if len(shown) > 1 else shown[0]
        more = " among others" if len(options) > len(shown) else ""
        return Answer(
            reply=f"In {country} we cover {listed}{more}. Which one shall I look up {product} in?",
            intent=reading.intent,
            suggestions=[f"{product.capitalize()} in {name}" for name in shown],
        )
    # A country we sell nothing in yet. Said plainly rather than opening an
    # empty search — the traveller can then ask for somewhere we do go.
    return Answer(
        reply=f"We don't have {product} in {country} on the site yet. "
              "Tell me another destination and I'll look it up.",
        intent=reading.intent,
    )


def execute_action(reading: Reading, places: Places | None = None) -> Answer:
    """One reading -> the words and the screen. No data is read here.

    EVERY SENTENCE IS ABOUT WHAT HAPPENS NEXT, never about price or
    availability: this module has read no fares and no rooms, so a line like
    "flights from ₹2,499" would be invented. The screen it opens is the one
    that holds the real answer.

    THE SCREEN IS ALWAYS ONE THE SITE ALREADY HAS. ``action.type`` names a
    search the browser can already open — the flight card, the hotel panel,
    the packages shelf, a destination page, Support, My Bookings — and the
    assistant never draws a booking form of its own. A new action type means a
    new line in travel-assistant.js's map and nothing else.

    ``places`` is optional and is only consulted for wording; the action never
    depends on it.
    """
    to = reading.place_name
    frm = reading.origin_name

    if reading.intent is Intent.GREETING:
        return Answer(
            reply="Hello! I can help you find flights, hotels and holiday packages. Where would you like to go?",
            intent=reading.intent,
            suggestions=["Flights to Delhi", "Hotels in Goa", "Show me packages"],
        )

    if reading.intent is Intent.THANKS:
        return Answer(reply="Happy to help. Anything else I can look up for you?",
                      intent=reading.intent)

    if reading.intent is Intent.SUPPORT:
        return Answer(
            reply="I can put you through to our support team — they answer in the chat window.",
            intent=reading.intent,
            action={"type": "open_support", "params": {}},
        )

    if reading.intent is Intent.BOOKINGS:
        return Answer(
            reply="Your trips are in My Bookings. Opening it for you — you may need to sign in first.",
            intent=reading.intent,
            action={"type": "open_bookings", "params": {}},
        )

    if reading.intent is Intent.FLIGHT:
        # ONLY WHAT WAS ASKED FOR. A key the traveller did not speak is absent
        # rather than null, so the card leaves that field exactly as they left
        # it — the date, the party and the cabin are theirs, and the brief says
        # so in as many words.
        params: dict = {"trip": reading.trip}
        if frm:
            params["from"] = frm
        if to:
            params["to"] = to
        if reading.date:
            params["date"] = reading.date
        # THE AIRPORT, WHEN THE PICKER'S OWN TABLE KNOWS IT. A city name is
        # what the browser resolves today and still can; a code alongside it
        # means the From box is filled with exactly the airport meant rather
        # than with the first row a text search returns. Absent when the table
        # does not list the city — Colombo is a real flight and not a row
        # here — and the browser falls back to the name, as it does now.
        origin_airport = resolve_airport(frm)
        dest_airport = resolve_airport(to)
        if origin_airport:
            params["fromCode"] = origin_airport["code"]
        if dest_airport:
            params["toCode"] = dest_airport["code"]

        if to and frm:
            when = " on that date" if reading.date else ""
            return Answer(
                reply=f"Searching flights from {frm} to {to}{when}. "
                      "Pick your date and passengers on the next screen.",
                intent=reading.intent,
                action={"type": "search_flights", "params": params},
            )
        if to:
            return Answer(
                reply=f"Flights to {to} — where are you flying from?",
                intent=reading.intent,
                action={"type": "search_flights", "params": params},
            )
        if frm:
            return Answer(
                reply=f"Flights from {frm} — where would you like to go?",
                intent=reading.intent,
                action={"type": "search_flights", "params": params},
            )
        return Answer(
            reply="I can look up flights. Which cities are you flying between?",
            intent=reading.intent,
            suggestions=["Hyderabad to Delhi", "Mumbai to Dubai"],
        )

    if reading.intent is Intent.HOTEL:
        if reading.attraction_name:
            return Answer(
                reply=f"Showing hotels near {reading.attraction_name}.",
                intent=reading.intent,
                action={"type": "hotels_near",
                        "params": {"destination": reading.place_slug,
                                   "attraction": reading.attraction_slug}},
            )
        if reading.is_country:
            return _country_answer(reading, "hotels", "search_hotels", "dest")
        if to:
            return Answer(
                reply=f"Looking up hotels in {to}. Choose your dates and rooms on the next screen.",
                intent=reading.intent,
                action={"type": "search_hotels",
                        "params": {"dest": to, "checkIn": reading.date}},
            )
        return Answer(
            reply="I can find hotels. Which city are you staying in?",
            intent=reading.intent,
            suggestions=["Hotels in Goa", "Hotels in Dubai"],
        )

    if reading.intent is Intent.PLACES:
        if reading.place_slug:
            name = to or "there"
            return Answer(
                reply=f"Here are the famous places to visit in {name}. "
                      "Each one lists hotels nearby.",
                intent=reading.intent,
                action={"type": "open_destination", "params": {"destination": reading.place_slug}},
            )
        if reading.is_country and reading.options:
            shown = reading.options[:4]
            return Answer(
                reply=f"In {reading.place_name} we cover "
                      f"{', '.join(shown)}. Which one would you like to see?",
                intent=reading.intent,
                suggestions=[f"Places to visit in {name}" for name in shown],
            )
        return Answer(
            reply="I can show you what to see. Which destination did you have in mind?",
            intent=reading.intent,
            suggestions=["Places to visit in Jaipur", "What to see in Bali"],
        )

    if reading.intent is Intent.PACKAGE:
        if reading.is_country:
            return _country_answer(reading, "holiday packages", "search_packages", "dest")
        if to:
            return Answer(
                reply=f"Let's look at holiday packages for {to}. "
                      "You can filter by month and budget on the next screen.",
                intent=reading.intent,
                action={"type": "search_packages", "params": {"dest": to}},
            )
        return Answer(
            reply="I can show our holiday packages. Which destination interests you?",
            intent=reading.intent,
            suggestions=["Goa packages", "Dubai packages"],
        )

    return Answer(
        reply="Sorry, I did not catch that. I can help with flights, hotels, "
              "holiday packages and places to visit — or put you through to support.",
        intent=Intent.FALLBACK,
        suggestions=["Flights to Goa", "Hotels in Hyderabad", "Talk to support"],
    )

#: ``generate_response`` was this function's name while it was the only thing
#: it did. The routing brief calls it the action executor; both names are kept
#: because the older one is what the conversation layer and the tests already
#: call, and a rename that breaks callers buys nothing.
generate_response = execute_action


# ---------------------------------------------------------------------------
# 3. Airports — one table, and it is the booking card's own
# ---------------------------------------------------------------------------
#: ``JPAirports`` in frontend/assets/js/airports.js. THE SAME FILE THE PICKER
#: IN THE BOOKING CARD READS, parsed rather than restated: an airport list in
#: Python and another in JavaScript is two lists, and the day they disagree the
#: assistant fills a From box the card then rejects. Adding an airport stays a
#: one-file job, exactly as it is today.
#: app/services/travel_ai_assistant.py -> app -> backend -> the repository,
#: the same walk app/main.py does to find FRONTEND_DIR.
_AIRPORTS_JS = (Path(__file__).resolve().parents[3]
                / "frontend" / "assets" / "js" / "airports.js")

#:   HYD: { city: 'Hyderabad', country: 'India', utc: IST },
_AIRPORT_ROW = re.compile(
    r"^\s*(?P<code>[A-Z]{3})\s*:\s*\{\s*city\s*:\s*'(?P<city>[^']+)'\s*,"
    r"\s*country\s*:\s*'(?P<country>[^']+)'", re.M)

_airports: dict[str, dict] | None = None


def airports() -> dict[str, dict]:
    """``{'HYD': {'code': 'HYD', 'city': 'Hyderabad', 'country': 'India'}, ...}``.

    Read once and kept. A missing or unreadable file is an empty table and a
    logged warning, never an exception: airport resolution makes a flight
    reading *better* — it fills a code the browser would otherwise look up
    itself — and the assistant works without it.
    """
    global _airports
    if _airports is None:
        table: dict[str, dict] = {}
        try:
            text = _AIRPORTS_JS.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("airport table unreadable (%s); flights will carry city "
                        "names only", exc)
            text = ""
        for m in _AIRPORT_ROW.finditer(text):
            table[m.group("code")] = {
                "code": m.group("code"),
                "city": m.group("city"),
                "country": m.group("country"),
            }
        _airports = table
    return _airports


def resolve_airport(name: str | None) -> dict | None:
    """A spoken place -> the airport a flight would use, or None.

    Takes a code as easily as a city, because "hyd to cmb" is how people who
    book often say it. Returns the row rather than the code, so a caller can
    say "Hyderabad (HYD)" without a second lookup.

    NONE IS A NORMAL ANSWER, and it does not mean the flight is impossible: we
    sell tickets through a supplier whose airport list is far longer than the
    one the picker offers. It means "the card will have to resolve this one",
    which is what the browser does with a city name today.
    """
    said = (name or "").strip()
    if not said:
        return None
    table = airports()
    if len(said) == 3 and said.upper() in table:
        return table[said.upper()]
    # "Hyderabad (HYD)" — what a submitted picker holds.
    bracketed = re.search(r"\(([A-Za-z]{3})\)\s*$", said)
    if bracketed and bracketed.group(1).upper() in table:
        return table[bracketed.group(1).upper()]
    lowered = said.lower()
    for row in table.values():
        if row["city"].lower() == lowered:
            return row
    return None


# ---------------------------------------------------------------------------
# 4. A provider, when one is configured
# ---------------------------------------------------------------------------
#: Below this, the model is not confident enough to overrule a deterministic
#: reading that is right far more often than it is wrong.
_TRUST_FLOOR = 0.55

#: What a provider is allowed to answer with. Anything else is dropped rather
#: than mapped to something near it — a guess about a guess.
_INTENT_NAMES = {i.value: i for i in Intent}


def _said(value: str | None, text: str) -> str | None:
    """A place name, only if the traveller actually said it.

    THIS IS THE WHOLE DEFENCE against a model that fills in a city because the
    sentence sounded like it wanted one. A generated answer is untrusted input;
    a word that is not in the traveller's own sentence never reaches a search
    box. Case and surrounding punctuation are ignored, a three-letter code is
    accepted as itself, and anything else is dropped.
    """
    if not value:
        return None
    needle = value.strip()
    if not needle:
        return None
    if re.search(rf"\b{re.escape(needle)}\b", text, re.I):
        return needle
    hit = resolve_airport(needle)
    if hit and re.search(rf"\b{re.escape(hit['code'])}\b", text, re.I):
        return hit["code"]
    return None


def _from_provider(understanding, text: str, places: Places) -> Reading | None:
    """A provider's answer, validated and turned into a ``Reading``.

    Returns None whenever anything is off — an unknown intent, low confidence,
    a place nobody said — and the rules then answer. Nothing here trusts the
    model with more than the CHOICE between readings the rules could also have
    produced.
    """
    intent = _INTENT_NAMES.get((understanding.intent or "").strip().lower())
    if intent is None or understanding.confidence < _TRUST_FLOOR:
        return None

    origin = _said(understanding.origin, text)
    dest = _said(understanding.destination, text)
    # HALF A ROUTE IS NOT A ROUTE — the same rule the built-in reader applies,
    # applied again to a model that decided otherwise.
    if intent is Intent.FLIGHT and origin and dest and origin.lower() == dest.lower():
        dest = None

    origin_slug, origin_name = _named(origin, places)
    place_slug, place_name = _named(dest, places)

    attraction_slug = attraction_name = None
    spoken = _said(understanding.attraction, text)
    if spoken:
        hit = _find_attraction(spoken, places)
        if hit:
            place_slug = place_slug or hit[0]
            attraction_slug, attraction_name = hit[1], hit[2]

    date = understanding.date if (understanding.date and _ISO_DAY.fullmatch(understanding.date)) else None
    return Reading(
        intent=intent,
        place_slug=place_slug, place_name=place_name,
        origin_slug=origin_slug, origin_name=origin_name,
        attraction_slug=attraction_slug, attraction_name=attraction_name,
        date=date, passengers=understanding.passengers,
        trip=understanding.trip if understanding.trip in {"oneway", "round"} else "oneway",
        confidence=understanding.confidence,
    )


_ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def read(text: str, places: Places) -> tuple[Reading, str]:
    """One sentence -> (reading, which reader produced it).

    THE PROVIDER GOES FIRST AND THE RULES DECIDE. A configured model reads the
    sentence; if it is unavailable, unsure, or says something the traveller did
    not, the built-in reader answers instead — and the built-in reader is a
    complete implementation of the brief, not a stub. So switching a model on
    can only widen what unusual phrasing is understood, and switching it off
    can only narrow it.
    """
    provider = travel_ai.get_provider()
    if provider is not None:
        try:
            hints = travel_ai.Hints(
                destinations=[name for _, name in places.destinations],
                countries=sorted(places.countries),
                intents=sorted(_INTENT_NAMES),
                today=dt.date.today().isoformat(),
            )
            understanding = provider.classify(text, hints)
        except Exception as exc:  # a provider must not take the panel down
            log.warning("travel_ai provider raised: %s", exc)
            understanding = None
        if understanding is not None:
            reading = _from_provider(understanding, text, places)
            if reading is not None:
                return reading, provider.name
    return detect_intent(text, places), "rules"


def analyze_message(text: str, places: Places) -> dict:
    """The whole understanding of one sentence, in one call.

    ``{'intent', 'entities', 'action', 'reply', 'suggestions', 'confidence',
    'reader'}`` — what was asked, what it was about, where to send them and
    what to say. The conversation layer stores the reply and hands the rest to
    the browser; nothing else has to know that reading and answering are two
    steps.
    """
    reading, reader = read(text, places)
    answer = execute_action(reading, places)
    return {
        "intent": answer.intent.value,
        "entities": reading.entities(),
        "action": answer.action,
        "reply": answer.reply,
        "suggestions": answer.suggestions,
        "confidence": reading.confidence,
        "reader": reader,
    }
