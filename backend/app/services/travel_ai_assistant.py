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

THE ROUTING RULES, AND WHERE THEY LIVE

  1. ONE PLACE, NO PRODUCT WORD -> THE DESTINATION. "I want to visit Goa" is
     somebody saying where they are going: they are exploring, so the answer is
     the destination itself, with its places, packages and hotels offered as the
     next step (DESTINATIONS). It must never open flights — there is no second
     city, and half a route is not a route.

     THIS REVERSES THE ORIGINAL RULE 1, WHICH OPENED THE HOTEL SEARCH. That
     chose a product on the traveller's behalf; the voice-assistant brief asks
     for destination discovery instead, and tests/verify_travel_assistant_routing.py
     (3b) and backend/tests/test_travel_assistant_voice.py hold the new behaviour.
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
  4. A PACKAGE IS ONLY A PACKAGE WHEN SOMEBODY SAYS SO. "Package", "tour" and
     "itinerary" say so outright. "Holiday", "trip", "getaway" and "vacation"
     are how people talk about going anywhere, so on their own they are a
     QUESTION (CLARIFY: packages, hotels or flights?) — unless the sentence also
     gives a length or a style ("a three-day trip", "a family holiday"), which
     only a package has. A bare place name is DESTINATIONS (rule 1), never a
     package.
  5. AMBIGUITY IS ASKED ABOUT. Two places and no service ("Goa Hyderabad") is
     not a flight: it is a clarification offering the readings.
  6. A QUESTION ABOUT A PLACE ("best time to visit Goa") is not a request to
     go there. This business holds no such data, so it says so (GENERAL).

  Priority, when a sentence is several of these at once: support and My
  Bookings first (a person asking for a person must never get a search box),
  then flights, then hotels, then places / areas, then packages, then browsing
  the catalogue, then the clarifications, then a bare place.

CONVERSATION CONTEXT (section 5 below). The browser sends back the search the
previous reply described; a sentence that only CHANGES it ("only family
packages", "for four people", "change the destination to Bali") is applied to
it, and anything else replaces it. The server keeps no state between messages.

PACKAGES AND PLACES ARE DRAWN IN THE CONVERSATION. Their actions (show_packages,
show_places, show_destination, show_destinations) are not page navigations: the
assistant lives on the landing page only, so opening another page would end the
conversation a follow-up needs. The browser fetches the real results from the
existing endpoints (assets/js/assistant-results.js); this module still reads no
fare, no price and no availability.

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

from app.config import settings
from app.models_customer import CustomerAttraction, CustomerDestination, CustomerLocation
from app.services import airport_reference, flight_slots as fs, place_matcher, travel_ai, travel_dates

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
    #: "Show me destinations", "I want to visit Goa" — the catalogue, not a
    #: product. The browser shows the shelf or the one destination.
    DESTINATIONS = "destinations"
    #: A sentence that names a place and a holiday but not what to look up
    #: ("I want a holiday in Goa"). Asked about, never guessed at.
    CLARIFY = "clarify"
    #: Weather, best season, currency — not something this business has data
    #: for, so it is said plainly rather than answered from memory.
    GENERAL = "general"
    BOOKINGS = "bookings"
    SUPPORT = "support"
    THANKS = "thanks"
    FALLBACK = "fallback"


#: THE BROAD VOCABULARY, ADDITIVE. The wire values above are what the stored
#: history, the browser and the verification scripts already use, so they are
#: not renamed; this table gives each one the service name the product brief
#: uses, and the response carries it beside ``intent`` as ``service_intent``.
SERVICE_INTENT = {
    Intent.FLIGHT: "flight_search",
    Intent.HOTEL: "hotel_search",
    Intent.PACKAGE: "tour_package_search",
    Intent.DESTINATIONS: "destination_discovery",
    Intent.PLACES: "destination_location_search",
    Intent.GENERAL: "general_travel_question",
    Intent.CLARIFY: "clarification_required",
}


def service_intent(intent: Intent) -> str:
    """The brief's name for an intent; the intent's own value where it has none."""
    return SERVICE_INTENT.get(intent, intent.value)


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
    # --- package details, only ever set when the sentence said them ---------
    #: Trip length in DAYS, as the packages API counts them (``min_days`` /
    #: ``max_days``). "Three nights" is four days.
    days: int | None = None
    #: 'YYYY-MM', the shape the packages API's ``month`` filter takes.
    month: str | None = None
    #: A style the traveller asked for — family, honeymoon, beach... The
    #: packages API has no such filter, so the browser matches it against the
    #: packages' own text and says so when nothing matches.
    theme: str | None = None
    #: 'domestic' | 'international' | 'pilgrimage' — the API's own ``trip_type``.
    pkg_type: str | None = None
    #: For PLACES: 'locations' (the areas of a destination) or 'attractions'
    #: (its famous places). Both are existing endpoints; this picks which one
    #: the traveller's own word asked for.
    list_kind: str = "attractions"
    #: True when this reading is the previous search with something changed,
    #: and what changed — the reply says so instead of restating the search.
    followup: bool = False
    changed: list[str] = field(default_factory=list)
    #: The sentence named a destination we do not sell. Said, with alternatives.
    not_found: bool = False
    #: An AREA of a destination, when one was named ("Banjara Hills").
    area_slug: str | None = None
    area_name: str | None = None
    #: True when the sentence is about ONE named place — a famous place or an
    #: area — rather than a list of them: "Show Charminar", not "places in
    #: Hyderabad".
    single_place: bool = False
    #: A near-miss spelling, offered rather than acted on. The stored places it
    #: may have meant (place_matcher.Match), the words that were compared, and
    #: for each the sentence that would carry the request out with the real name.
    near: list = field(default_factory=list)
    heard: str | None = None
    rewrites: list[str] = field(default_factory=list)
    #: A destination the sentence named that does not contain the place it also
    #: named ("Charminar in Goa") — said in the reply, never silently corrected.
    wrong_parent: str | None = None
    #: A flight request as conversation STATE (flight_slots.Flight): what is known,
    #: which question is open, and what is still missing. Set for every FLIGHT
    #: reading; the fields above (origin_name, place_name, date…) are what the
    #: traveller SAID, this is what the search now IS.
    flight: object | None = None
    #: "Got it — flying from Delhi." when this reading changed a flight in progress.
    ack: str = ""

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
            "days": self.days,
            "month": self.month,
            "preference": self.theme,
            "package_type": self.pkg_type,
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
    #: Selectable answers with a label that differs from what is sent: a "Did you
    #: mean…?" button reads "Charminar · Hyderabad" and sends a whole sentence.
    #: [{"label": ..., "message": ...}]. Absent, the browser makes one from each
    #: suggestion, whose label IS its message.
    choices: list[dict] = field(default_factory=list)


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
_HOTEL = re.compile(r"\b(hotel|hotels|stay|stays|room|rooms|accommodation|resort|resorts|lodging)\b", re.I)
#: TWO STRENGTHS OF "THIS IS A PACKAGE". "Package", "tour" and "itinerary" are
#: the product's own names for itself. "Holiday", "trip", "getaway" and
#: "vacation" are how people talk about going somewhere, and "I want a holiday
#: in Goa" is as likely to want a hotel or a flight as a package — so a weak
#: word on its own is a question (CLARIFY), not an answer. A weak word WITH a
#: length ("a three-day trip") or a style ("a family holiday") is a package.
_PACKAGE_STRONG = re.compile(r"\b(package|packages|tour|tours|itinerary|itineraries)\b", re.I)
_PACKAGE_WEAK = re.compile(r"\b(holiday|holidays|trip|trips|getaway|getaways|vacation|vacations)\b", re.I)
#: Either strength. Where the sentence only needs to know a package was spoken
#: of — the route rule, the free-place guard — this is the one to ask.
_PACKAGE = re.compile(
    r"\b(package|packages|holiday|holidays|trip|trips|tour|tours|itinerary|itineraries"
    r"|getaway|getaways|vacation|vacations)\b", re.I)
#: "What areas does Goa have" — the second of the two lists a destination owns.
_LOCATIONS_WORD = re.compile(
    r"\b(locations?|areas?|neighbou?rhoods?|localities|districts?)\b", re.I)
#: Browsing the catalogue itself, with no product named.
_DISCOVER = re.compile(
    r"\b(destinations?|where (?:can|could|should) (?:i|we) (?:go|travel|visit)"
    r"|places? to go|popular places|explore (?:the )?(?:world|places))\b", re.I)
#: Questions about a place that this business holds no data for. Only reached
#: when no product was named — "how long is the flight to Dubai" is a flight.
_GENERAL_Q = re.compile(
    r"\b(best (?:time|season|month)|weather|climate|temperature|currency|exchange rate"
    r"|language|time ?zone|(?:is it|are they) (?:safe|cold|hot|expensive)|safe (?:to|for)"
    r"|what (?:is|are) the (?:capital|population)|how (?:far|big) is)\b", re.I)

# --- package details -------------------------------------------------------
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
              "seven": 7, "eight": 8, "nine": 9, "ten": 10}
_NUM = r"(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)"
#: "three-day", "5 days", "3 nights", "a week", "two weeks".
_DAYS = re.compile(rf"\b{_NUM}[\s-]*(day|days|night|nights|week|weeks)\b", re.I)
_A_WEEK = re.compile(r"\b(?:a|one)[\s-]+week\b", re.I)
_MONTHS = ["january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december"]
_MONTH_NAME = re.compile(
    r"\b(?P<pre>in|for|during|of|this|next|around|by|early|late|mid)?\s*"
    r"(?P<m>january|february|march|april|may|june|july|august|september|october"
    r"|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b", re.I)
_WEEKEND = re.compile(r"\b(?:(?P<which>this|next|coming|upcoming)\s+)?weekend\b", re.I)
_THEMES = [
    ("family", re.compile(r"\bfamil(?:y|ies)\b", re.I)),
    ("honeymoon", re.compile(r"\bhoneymoons?\b", re.I)),
    ("adventure", re.compile(r"\badventures?\b", re.I)),
    ("beach", re.compile(r"\bbeach(?:es)?\b", re.I)),
    ("cruise", re.compile(r"\bcruises?\b", re.I)),
    ("heritage", re.compile(r"\bheritage\b", re.I)),
    ("luxury", re.compile(r"\bluxury\b", re.I)),
    ("budget", re.compile(r"\b(?:budget|cheap|affordable)\b", re.I)),
]
_PKG_TYPES = [
    ("international", re.compile(r"\b(?:international|overseas|abroad|foreign)\b", re.I)),
    ("domestic", re.compile(r"\bdomestic\b", re.I)),
    ("pilgrimage", re.compile(r"\b(?:pilgrim\w*|yatra|darshan)\b", re.I)),
]
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
#: Numbers may be spoken as words — speech recognition returns "four people",
#: not "4 people" — and "for 3" must not swallow "for 3 days" (a length, not a
#: party), which is what the lookahead is for.
_PAX = re.compile(
    rf"\b{_NUM}\s*(?:adults?|passengers?|people|persons?|pax|travell?ers?|seats?|guests?)\b"
    rf"|\bfor\s+{_NUM}\b(?![\s-]*(?:days?|nights?|weeks?|months?|hours?|star))"
    rf"|\b(?:family|party|group) of {_NUM}\b", re.I)


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
    # "Change the destination to Bali" has the shape of a route and is not one:
    # its left side is an instruction, never a city.
    if re.match(r"(?:change|switch|update|modify|set|make)\b", text, re.I):
        return None
    text = _SPAN_LEAD.sub("", text)
    text = _SPAN_TAIL.sub("", text).strip(" ,.-")
    if not text or len(text) > _SPAN_MAX_CHARS:
        return None
    if re.search(r"\d", text) or len(text.split()) > _SPAN_MAX_WORDS:
        return None
    # "A three day trip to Goa" has the shape of a route: its left side is a
    # length, not a city. Likewise a bare product or style word ("family").
    if re.search(r"\b(?:day|days|night|nights|week|weeks)\b", text, re.I) or _NOT_A_PLACE.match(text):
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
    word = next((g for g in m.groups() if g), None)
    n = _to_int(word)
    return n if n is not None and 1 <= n <= 9 else None


def _to_int(word: str | None) -> int | None:
    """'4' or 'four' -> 4. Anything else is None."""
    if not word:
        return None
    word = word.strip().lower()
    if word.isdigit():
        return int(word)
    return _NUM_WORDS.get(word)


def _find_days(text: str) -> int | None:
    """A trip length in DAYS, only when the sentence stated one.

    The packages API counts days (``min_days``/``max_days``), so nights are
    converted: "three nights" is a four-day trip. A week is seven days. Anything
    outside 1-30 is a misheard number, not a request.
    """
    m = _DAYS.search(text or "")
    if m:
        n = _to_int(m.group(1))
        unit = m.group(2).lower()
        if n is None:
            return None
        days = n + 1 if unit.startswith("night") else n * 7 if unit.startswith("week") else n
        return days if 1 <= days <= 30 else None
    if _A_WEEK.search(text or ""):
        return 7
    return None


def _find_theme(text: str) -> str | None:
    for name, pattern in _THEMES:
        if pattern.search(text or ""):
            return name
    return None


def _find_pkg_type(text: str) -> str | None:
    for name, pattern in _PKG_TYPES:
        if pattern.search(text or ""):
            return name
    return None


def _find_package_when(text: str, today: dt.date | None = None) -> tuple[str | None, str | None]:
    """``(month 'YYYY-MM', day ISO)`` for a package sentence, either may be None.

    THE PACKAGES API FILTERS BY MONTH — it matches packages with a live
    departure in that month — so a weekend or a named month both come back as a
    month; a weekend also names the Saturday it means. "This weekend" and a bare
    "weekend" are the coming Saturday; "next weekend" is the one after it. A
    month name is its next occurrence, so "March" said in October is March of
    next year. "May" counts only after a preposition, because it is also a verb.
    Flights and hotels do not use this: their dates are read by ``_find_date``,
    which only trusts a day it can be certain of.
    """
    today = today or dt.date.today()
    lowered = (text or "").lower()

    wk = _WEEKEND.search(lowered)
    if wk:
        saturday = today + dt.timedelta(days=(5 - today.weekday()) % 7)
        if (wk.group("which") or "") == "next":
            saturday += dt.timedelta(days=7)
        return saturday.strftime("%Y-%m"), saturday.isoformat()

    if re.search(r"\bnext month\b", lowered):
        y, m = (today.year + (today.month == 12), today.month % 12 + 1)
        return f"{y:04d}-{m:02d}", None
    if re.search(r"\bthis month\b", lowered):
        return today.strftime("%Y-%m"), None

    for m in _MONTH_NAME.finditer(lowered):
        name = m.group("m")
        if name == "may" and not m.group("pre"):
            continue
        index = next((i for i, full in enumerate(_MONTHS, 1) if full.startswith(name[:3])), None)
        if index is None:
            continue
        year = today.year + (1 if index < today.month else 0)
        return f"{year:04d}-{index:02d}", None

    day = _find_date(text)
    if day:
        return day[:7], day
    return None, None


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
    #: A destination's AREAS — the rows GET /destinations/{id}/locations returns
    #: (North Goa, Banjara Hills). (dest slug, slug, name).
    locations: list[tuple[str, str, str]] = field(default_factory=list)

    def candidates(self) -> list["place_matcher.Candidate"]:
        """Every stored place, as the fuzzy matcher's records.

        BUILT FROM THE SAME ROWS THE ENDPOINTS SERVE, on every request, so a
        place added or retired in the catalogue is matched (or not) immediately —
        there is no second list to go stale. Names, slugs and parents are the
        rows' own; the matcher can only ever return one of these.
        """
        parent = dict(self.destinations)
        out = [place_matcher.Candidate("destination", slug, name)
               for slug, name in self.destinations]
        out += [place_matcher.Candidate("attraction", slug, name, d, parent.get(d))
                for d, slug, name in self.attractions]
        out += [place_matcher.Candidate("area", slug, name, d, parent.get(d))
                for d, slug, name in self.locations]
        return out


def load_places(db: Session) -> Places:
    """Read the place names once per request. Three small indexed queries."""
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
    areas = db.execute(
        select(CustomerDestination.slug, CustomerLocation.slug, CustomerLocation.name)
        .join(CustomerLocation,
              CustomerLocation.destination_id == CustomerDestination.customer_destination_id)
        .where(CustomerLocation.is_active.is_(True), CustomerDestination.is_active.is_(True))
    ).all()
    countries: dict[str, list[tuple[str, str]]] = {}
    for d in dests:
        if d.country:
            countries.setdefault(d.country.strip(), []).append((d.slug, d.name))
    return Places(
        destinations=[(d.slug, d.name) for d in dests],
        attractions=[(a[0], a[1], a[2]) for a in attrs],
        countries=countries,
        locations=[(a[0], a[1], a[2]) for a in areas],
    )


def _find_place(text: str, places: Places) -> list[tuple[str, str, int]]:
    """Every known destination named in the sentence, in the order spoken.

    Matched on a WORD BOUNDARY, so "Goa" in "Goan" is not a hit and "Male"
    inside "female" is not either — the failure a bare `in` test would make.
    Longest name first, so "North Goa" wins over "Goa" where both would match.
    """
    hits: list[tuple[str, str, int]] = []
    for slug, name in sorted(places.destinations, key=lambda p: -len(p[1])):
        m = re.search(_flex(name), text, re.I)
        if m and not any(h[0] == slug for h in hits):
            hits.append((slug, name, m.start()))
    hits.sort(key=lambda h: h[2])
    return hits


def _flex(name: str) -> str:
    """A stored name as a pattern that tolerates how it is TYPED.

    "Banjara-Hills", "banjara  hills" and "Banjara Hills" are one place, and the
    apostrophe in "Tipu Sultan's" is optional. Case is ignored by the caller.
    """
    words = [re.escape(w) for w in re.split(r"[\W_]+", name.replace("'", "").replace("’", "")) if w]
    return r"\b" + r"[\W_]*".join(words) + r"\b"


def _best_named(rows: list[tuple[str, str, str]], text: str, prefer: tuple[str, ...]):
    """The longest stored name in ``rows`` that ``text`` contains.

    ``prefer`` are destinations the sentence also names: a same-named place under
    one of them wins, which is how "Charminar in Hyderabad" is told apart from an
    identically named place elsewhere.
    """
    hits = [r for r in sorted(rows, key=lambda r: -len(r[2])) if re.search(_flex(r[2]), text, re.I)]
    if not hits:
        return None
    top = [h for h in hits if len(h[2]) == len(hits[0][2])]
    return ([h for h in top if h[0] in prefer] or top)[0]


def _find_attraction(text: str, places: Places, prefer: tuple[str, ...] = ()) -> tuple[str, str, str] | None:
    """A famous place named in the sentence: (destination slug, slug, name)."""
    return _best_named(places.attractions, text, prefer)


def _find_area(text: str, places: Places, prefer: tuple[str, ...] = ()) -> tuple[str, str, str] | None:
    """An AREA of a destination (GET …/locations) named in the sentence."""
    return _best_named(places.locations, text, prefer)


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
    prefer = tuple(slug for slug, _ in destinations)
    return {
        "destinations": destinations,
        "attraction": _find_attraction(text, places, prefer),
        "area": _find_area(text, places, prefer),
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
    """Only days we can be certain of. A vague "next month" is left unset.

    The reading lives in travel_dates.parse_day, which also understands weekdays
    ("friday", "next friday") and written dates ("12 oct", "oct 12th", "12/10"), and
    which fixes an old bug here: "day after tomorrow" contains "tomorrow", and was
    read as tomorrow."""
    return travel_dates.parse_day(text)


# ---------------------------------------------------------------------------
# 1. What was asked
# ---------------------------------------------------------------------------
def _substitute(raw: str, span: str, name: str) -> str:
    """``raw`` with the words ``span`` (as the matcher normalised them) replaced by
    the stored ``name``. Matched across any punctuation or spacing, so the words
    the traveller actually said are the ones replaced; if they cannot be found
    the real name is appended instead, which is still a sentence that resolves."""
    words = [re.escape(w) for w in span.split()]
    if words:
        new, n = re.subn(r"\b" + r"[\W_]*".join(words) + r"\b", lambda _m: name, raw,
                         count=1, flags=re.I)
        if n:
            return new
    return f"{raw} {name}"


def _resolve_near(raw: str, places: Places, found: list, attraction, area, country):
    """Is there a word in the sentence that is a MISSPELT stored place?

    Returns None (nothing to do), a SENTENCE (the traveller's own, with a name
    that was only written differently put right — safe to carry on with, no guess
    was made), or a CLARIFY Reading offering the stored places it may have meant.

    ONLY WHAT THE EXACT MATCHER LEFT UNEXPLAINED IS CONSIDERED. Places it already
    found are masked out of the text first, and become the PARENT CONTEXT:
    "Charminnar in Hyderabad" is matched among Hyderabad's places, and a name
    that exists under several destinations is told apart by the one named.
    Request words ("show", "hotels near", "places to visit") are never compared
    with a place, which is what keeps an unrelated word from matching by accident.
    A word that is close to nothing returns None, and the sentence is read exactly
    as it always was — "hotels in Kerala" still searches hotels in Kerala.
    """
    known = [f[1] for f in found]
    for hit in (attraction, area):
        if hit:
            known.append(hit[2])
    if country:
        known.append(country[0])
    covered = {t for name in known for t in place_matcher.normalize(name).split()}
    leftover = [t for t in place_matcher.normalize(raw).split()
                if t not in place_matcher.STOPWORDS and t not in covered]
    if not leftover:
        return None

    masked = raw
    for name in known:
        masked = re.sub(_flex(name), " ", masked, flags=re.I)
    parents = tuple(f[0] for f in found) + tuple(h[0] for h in (attraction, area) if h)
    cands = places.candidates()
    res = place_matcher.resolve(masked, cands, parent_slugs=parents)
    if res.outcome == "none" and known:
        # Nothing is left once the exact names are masked — but a word BESIDE one
        # may be the rest of a longer name ("Calangute bech": the area Calangute,
        # and the beach it is one slip from). Only a near miss that CONTAINS the
        # exact name counts here; an exact one is what the sentence already said.
        full = place_matcher.resolve(raw, cands, parent_slugs=parents)
        if full.outcome in ("suggest", "multiple"):
            res = full
    if res.outcome == "none" or not res.best:
        return None
    if res.outcome == "exact":
        return _substitute(raw, res.heard or "", res.best.candidate.name)

    names = [m.candidate.name for m in res.matches]
    rewrites = []
    for m in res.matches:
        c = m.candidate
        text = _substitute(raw, res.heard or "", c.name)
        # The same name under another destination: say which one is meant.
        twin = sum(1 for o in places.candidates()
                   if place_matcher.normalize(o.name) == place_matcher.normalize(c.name)
                   and o.parent_slug != c.parent_slug) > 0
        if c.parent_name and (twin or names.count(c.name) > 1) and c.parent_slug not in parents:
            text += f" in {c.parent_name}"
        rewrites.append(text)
    return Reading(intent=Intent.CLARIFY, place_name=res.best.candidate.name,
                   near=res.matches, heard=res.heard, rewrites=rewrites, confidence=0.5)


def detect_intent(text: str, places: Places, _depth: int = 0) -> Reading:
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
    area = where["area"]
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

    # A QUESTION ABOUT A PLACE, NOT A REQUEST FOR A PRODUCT. "Best time to visit
    # Goa" has a destination in it and no service, and the old order read it as
    # somebody saying where they are going. This business holds no weather or
    # season data, so it says so — see execute_action — rather than guessing. A
    # product word anywhere in the sentence ("how long is the flight to Dubai")
    # makes it a request again.
    if _GENERAL_Q.search(raw) and not (
            _FLIGHT.search(raw) or _HOTEL.search(raw) or _PACKAGE_STRONG.search(raw)):
        return Reading(intent=Intent.GENERAL, place_slug=place_slug,
                       place_name=place_name, confidence=0.9)

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

        # THE SAME TRANSITIONS AS A FOLLOW-UP. A first sentence is just "the flight so
        # far" being empty: its facts go through flight_slots.apply/settle, so what
        # was said, what an airport resolves to and what is still to be asked are
        # decided in one place and the first turn can never disagree with the second.
        reading = _flight_reading(
            fs.Facts(origin=origin_name, destination=dest_name, date=date,
                     trip="round" if _ROUND.search(raw) else None, passengers=pax),
            None, spoken_origin=origin_name, spoken_destination=dest_name,
            confidence=1.0 if (origin_name and dest_name) else 0.6,
        )
        reading.place_slug, reading.origin_slug = dest_slug, origin_slug
        return reading

    # ---- 1b. A misspelt place --------------------------------------------
    # AFTER flights, which are read from the shape of the sentence and may name
    # any city in the world, and before anything that would act on a place.
    # See _resolve_near. One level deep: the sentence it hands back has its
    # place spelt as stored, so it is read once more and not matched again.
    if _depth == 0:
        near = _resolve_near(raw, places, found, attraction, area, country)
        if isinstance(near, str):
            return detect_intent(near, places, _depth=1)
        if near is not None:
            return near

    # ---- 1c. A real place, under the wrong destination ---------------------
    # "Charminar in Goa": both names exist, the pairing does not. Showing
    # Charminar under Goa would be a fabricated record, and silently showing
    # Hyderabad's would ignore half the sentence — so say where it is and ask.
    named_place = attraction or area
    if named_place and found and named_place[0] not in {f[0] for f in found}:
        parent_name = next((n for s, n in places.destinations if s == named_place[0]), None)
        said_parent = found[0][1]
        stripped = re.sub(_flex(said_parent), " ", raw, flags=re.I)
        stripped = re.sub(r"\s+(?:in|at|near|of|from)\s*$", "", stripped.strip(), flags=re.I)
        cand = place_matcher.Candidate("attraction" if attraction else "area", named_place[1],
                                       named_place[2], named_place[0], parent_name)
        return Reading(intent=Intent.CLARIFY, place_name=named_place[2],
                       near=[place_matcher.Match(cand, 1.0, named_place[2].lower())],
                       heard=named_place[2], rewrites=[stripped.strip() or named_place[2]],
                       wrong_parent=said_parent, confidence=0.5)

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

    # ---- 3. Places to visit, and the areas of a destination ---------------
    # TWO WORDS, TWO LISTS. "Locations", "areas" and "neighbourhoods" ask for the
    # destination's areas (GET /destinations/{id}/locations); "places", "sights"
    # and "things to do" ask for its famous places (…/attractions). The browser
    # falls back to the other list when the one asked for is empty.
    if _PLACES.search(raw) or _LOCATIONS_WORD.search(raw) or attraction or area:
        # THE PLACE THE SENTENCE NAMES, if it names one: a famous place wins over
        # an area (it has a page of its own), and either one's parent is the
        # destination. "Show Charminar" is about ONE place — shown as itself —
        # where "places to visit in Hyderabad" asks for the list.
        named = attraction or area
        slug = place_slug or (named[0] if named else None)
        name = place_name
        if not name and named:
            name = next((n for s, n in places.destinations if s == named[0]), None)
        wants_areas = bool(_LOCATIONS_WORD.search(raw)) and not _PLACES.search(raw)
        asks_for_list = bool(_PLACES.search(raw) or _LOCATIONS_WORD.search(raw))
        not_found = bool(not slug and not country and free_place)
        return Reading(
            intent=Intent.PLACES, place_slug=slug,
            # A destination the catalogue lacks is still NAMED, so the reply can
            # say "we don't have Paris" instead of asking where they meant.
            place_name=name or (country[0] if country else None) or (free_place if not_found else None),
            attraction_slug=attraction[1] if attraction else None,
            attraction_name=attraction[2] if attraction else None,
            area_slug=area[1] if (area and not attraction) else None,
            area_name=area[2] if (area and not attraction) else None,
            single_place=bool(named and not asks_for_list),
            is_country=bool(country and not slug),
            options=[n for _, n in country[1]] if (country and not slug) else [],
            list_kind="locations" if wants_areas else "attractions",
            # A destination the sentence named but the catalogue lacks ("places
            # in Paris") is not a destination we can list places for.
            not_found=not_found,
            confidence=1.0 if slug else 0.5,
        )

    # ---- 4. Holiday packages ---------------------------------------------
    days = _find_days(raw)
    theme = _find_theme(raw)
    pkg_type = _find_pkg_type(raw)
    strong = bool(_PACKAGE_STRONG.search(raw))
    weak = bool(_PACKAGE_WEAK.search(raw))
    # "A three-day trip" and "a family holiday" say what KIND of package, which
    # a bare "holiday" does not — see _PACKAGE_WEAK.
    if strong or (weak and (days or theme)):
        month, when = _find_package_when(raw)
        # A PACKAGE WITH A ROUTE INSIDE IT IS STILL ABOUT WHERE IT GOES.
        # "honeymoon package from Delhi to Goa" names Delhi first, and the
        # first place named is the one they are leaving from — filtering the
        # holiday shelf by it is the same mistake in a smaller place. The end
        # it goes to is used even when the catalogue does not sell it: "a
        # package from Hyderabad to Colombo" is about Colombo, not Hyderabad.
        origin_slug = origin_name = None
        if both_ends:
            origin_slug, origin_name = _named(origin_text, places)
            place_slug, place_name = _named(dest_text, places)
        if country and not place_name:
            return Reading(
                intent=Intent.PACKAGE, place_name=country[0], is_country=True,
                options=[n for _, n in country[1]], date=when or date, passengers=pax,
                days=days, month=month, theme=theme, pkg_type=pkg_type,
            )
        return Reading(
            intent=Intent.PACKAGE, place_slug=place_slug,
            place_name=place_name or free_place,
            origin_slug=origin_slug, origin_name=origin_name,
            date=when or date, passengers=pax,
            days=days, month=month, theme=theme, pkg_type=pkg_type,
            confidence=1.0 if place_name else 0.6,
        )

    # ---- 5. Browsing the catalogue ----------------------------------------
    # "Show me destinations", "show destinations in India". No product is named,
    # so this is neither a search nor a booking: it is the shelf.
    if _DISCOVER.search(raw):
        if country and not place_name:
            return Reading(
                intent=Intent.DESTINATIONS, place_name=country[0], is_country=True,
                options=[n for _, n in country[1]], confidence=0.95,
            )
        return Reading(
            intent=Intent.DESTINATIONS, place_slug=place_slug, place_name=place_name,
            confidence=0.95,
        )

    # ---- 6. "A holiday in Goa" is not yet a request ------------------------
    # A weak package word and nothing that says what kind. It could be a hotel,
    # a flight or a package, and a wrong guess opens the wrong search — so ask,
    # with the three answers offered as sentences the assistant understands.
    if weak:
        # "A trip from Hyderabad to Goa" is about Goa, not the city they leave.
        if both_ends:
            place_slug, place_name = _named(dest_text, places)
        return Reading(
            intent=Intent.CLARIFY, place_slug=place_slug,
            place_name=place_name or free_place, confidence=0.4,
        )

    # ---- 6b. Two places and no service ------------------------------------
    # "Goa Hyderabad". It could be a flight, a trip to one of them or a
    # comparison, and nothing in the sentence says which — so ask, offering the
    # readings, rather than quietly picking the first place named.
    if len(found) >= 2:
        return Reading(
            intent=Intent.CLARIFY, place_slug=found[0][0], place_name=found[0][1],
            options=[found[0][1], found[1][1]], confidence=0.3,
        )

    # ---- 7. A place, and nothing said about what to do there --------------
    # "I want to visit Goa", "Goa", "planning to travel to Kerala". Somebody
    # naming where they are going and no product is exploring, so the answer is
    # the destination itself — what it is, and where to go from there (places,
    # packages, hotels) — not a search for one product they did not ask for.
    #
    # THIS REVERSES THE OLD RULE 1, WHICH OPENED THE HOTEL SEARCH. Choosing a
    # product on the traveller's behalf is what the clarification above exists
    # to avoid, and the destination page offers all of them.
    if place_name or free_place:
        return Reading(
            intent=Intent.DESTINATIONS, place_slug=place_slug,
            place_name=place_name or free_place,
            not_found=not place_name,
            confidence=1.0 if place_name else 0.5,
        )
    if country:
        return Reading(
            intent=Intent.DESTINATIONS, place_name=country[0], is_country=True,
            options=[n for _, n in country[1]], confidence=0.6,
        )

    return Reading(intent=Intent.FALLBACK, confidence=0.0)


# ---------------------------------------------------------------------------
# 2. What to say back
# ---------------------------------------------------------------------------
def _package_params(reading: Reading) -> dict:
    """What a package search carries — only what the sentence (or the search it
    follows) actually said, so the browser applies no filter nobody asked for.

    ``dest`` is the destination as spoken or as the catalogue spells it;
    ``days``/``month``/``pkgType`` map one-to-one onto the packages API's own
    ``min_days``+``max_days``/``month``/``trip_type``. ``preference`` and
    ``travellers`` are not API filters — see Reading.theme and _package_reply.
    """
    params: dict = {}
    if reading.place_name:
        params["dest"] = reading.place_name
    if reading.days:
        params["days"] = reading.days
    if reading.month:
        params["month"] = reading.month
    if reading.date:
        params["date"] = reading.date
    if reading.pkg_type:
        params["pkgType"] = reading.pkg_type
    if reading.theme:
        params["preference"] = reading.theme
    if reading.passengers:
        params["travellers"] = reading.passengers
    return params


def _describe_package_search(reading: Reading) -> str:
    """'Goa tour packages, 3 days, family' — the search, in words."""
    base = f"{reading.place_name} tour packages" if reading.place_name else "tour packages"
    bits = []
    if reading.pkg_type:
        bits.append(reading.pkg_type)
    if reading.days:
        bits.append(f"{reading.days} days")
    if reading.theme:
        bits.append(f"{reading.theme} style")
    if reading.month:
        label = dt.date(int(reading.month[:4]), int(reading.month[5:7]), 1).strftime("%B %Y")
        bits.append(f"departing {label}")
    if reading.passengers:
        bits.append(f"{reading.passengers} traveller" + ("s" if reading.passengers != 1 else ""))
    return base + (f" ({', '.join(bits)})" if bits else "")


def _catalogue_chips(places: Places | None, template: str, limit: int = 4,
                     skip: str | None = None) -> list[str]:
    """Follow-up sentences built from the catalogue's own destination names."""
    names = [n for _, n in (places.destinations if places else []) if n != skip]
    return [template.format(n) for n in names[:limit]]


def _join(names: list[str]) -> str:
    """'A', 'A and B', 'A, B and C'."""
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _not_found_answer(reading: Reading, places: Places | None, what: str) -> Answer:
    """A place we do not sell, said plainly, with places we do.

    NEVER A SILENT FAILURE AND NEVER A GUESS. The traveller named somewhere real
    that is not on the shelf; the useful answer is that, plus what IS here —
    taken from the catalogue, so it is true today — and, for hotels and flights
    which are not limited to the shelf, a way to search for it anyway.
    """
    where = reading.place_name
    names = [n for _, n in (places.destinations if places else [])]
    return Answer(
        # Nothing here is fabricated: "that location" is whatever was said, and
        # what is offered is read from the catalogue.
        reply=f"We couldn't find that location: {where}. Please say the name again, or choose "
              "one of our destinations"
              + (f" — we cover {_join(names[:5])}" + (" and more" if len(names) > 5 else "")
                 if names else "") + ".",
        intent=reading.intent,
        suggestions=[f"Hotels in {where}", *[f"Show me {n}" for n in names[:3]]],
    )


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
    #: "Updated — family style, 4 travellers. " when this reading is the last
    #: search with something changed, empty otherwise.
    lead = ("Updated — " + ", ".join(reading.changed) + ". ") if reading.changed else ""

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
        # THE FLIGHT IS STATE (flight_slots). What to say — and which question is
        # open — comes from that state, not from the words of this sentence, which
        # is why "Delhi" after "where are you flying from?" is an answer and not a
        # new destination.
        #
        # THE ACTION CARRIES ONLY WHAT IS KNOWN. A key not yet known is absent,
        # so the booking card leaves that field exactly as the traveller set it;
        # and nothing here is a flight RESULT — the card shows flights from the
        # schedule it already has. No fare, seat or availability is stated.
        flight = reading.flight if isinstance(reading.flight, fs.Flight) else fs.settle(fs.Flight())
        step = fs.answer(flight, reading.ack)
        return Answer(
            reply=step.reply,
            intent=reading.intent,
            action=({"type": "search_flights", "params": step.params} if step.params else
                    {"type": "none", "params": {}}),
            suggestions=step.suggestions,
            choices=step.choices,
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
                reply=f"{lead}Looking up hotels in {to}. Choose your dates and rooms on the next screen.",
                intent=reading.intent,
                action={"type": "search_hotels",
                        "params": {"dest": to, "checkIn": reading.date}},
            )
        return Answer(
            reply="I can find hotels. Which city are you staying in?",
            intent=reading.intent,
            # Cities we actually sell, read from the catalogue; the old fixed
            # examples are only the fallback for an empty one.
            suggestions=_catalogue_chips(places, "Hotels in {}", 3) or ["Hotels in Goa", "Hotels in Dubai"],
        )

    if reading.intent is Intent.PLACES:
        if reading.single_place and reading.place_slug:
            # ONE named place, shown as itself. A famous place has a page and a
            # "hotels near" search; an area has the hotel search only.
            kind = "attraction" if reading.attraction_slug else "area"
            slug = reading.attraction_slug or reading.area_slug
            nm = reading.attraction_name or reading.area_name
            return Answer(
                reply=f"{lead}Here is {nm} in {to}. I can show its page and hotels nearby, "
                      f"or the other places in {to}." if kind == "attraction" else
                      f"{lead}Here is {nm} in {to}. I can show hotels there, or the other "
                      f"places in {to}.",
                intent=reading.intent,
                action={"type": "show_place",
                        "params": {"destination": reading.place_slug, "destinationName": to,
                                   "kind": kind, "slug": slug, "name": nm}},
                suggestions=[f"Places to visit in {to}", f"{to} tour packages"],
            )
        if reading.place_slug:
            name = to or "there"
            areas = reading.list_kind == "locations"
            what = "areas" if areas else "famous places to visit"
            # An area has no page of its own — only a hotel search — so the
            # reply does not promise one.
            then = "Pick one to see its hotels." if areas else "Pick one to see its page or the hotels nearby."
            return Answer(
                reply=f"{lead}Here are the {what} in {name}. {then}",
                intent=reading.intent,
                # NOT open_destination any more: the list is shown HERE, in the
                # conversation, so the next sentence ("hotels near the first
                # one", "packages for Goa") still has somewhere to be said.
                action={"type": "show_places",
                        "params": {"destination": reading.place_slug, "name": name,
                                   "list": reading.list_kind}},
                suggestions=[f"{name} tour packages", f"Hotels in {name}"],
            )
        if reading.is_country and reading.options:
            shown = reading.options[:4]
            return Answer(
                reply=f"In {reading.place_name} we cover "
                      f"{', '.join(shown)}. Which one would you like to see?",
                intent=reading.intent,
                suggestions=[f"Places to visit in {name}" for name in shown],
            )
        if reading.not_found and reading.place_name:
            return _not_found_answer(reading, places, "places to visit")
        return Answer(
            reply="I can show you what to see. Which destination did you have in mind?",
            intent=reading.intent,
            suggestions=_catalogue_chips(places, "Places to visit in {}", 3)
            or ["Places to visit in Jaipur", "What to see in Bali"],
        )

    if reading.intent is Intent.PACKAGE:
        if reading.is_country:
            return _country_answer(reading, "holiday packages", "show_packages", "dest")
        params = _package_params(reading)
        said = _describe_package_search(reading)
        # THE REPLY NAMES THE SEARCH, NEVER ITS RESULTS. What exists — and what it
        # costs — is read by the browser from GET /api/customer/packages and
        # shown beside this sentence; a count or a price written here could only
        # be invented.
        return Answer(
            reply=(f"{lead}Looking up {said}." if reading.place_name or reading.changed
                   else f"{lead}Showing our tour packages. Tell me a destination, a length "
                        "or a month to narrow them."),
            intent=reading.intent,
            action={"type": "show_packages", "params": params},
            # WHAT TO DO NEXT, for the destination just shown — or, with none yet,
            # destinations to narrow by. Every one is a sentence the assistant
            # understands; none is a label with nothing behind it.
            suggestions=([f"Places to visit in {reading.place_name}", f"Hotels in {reading.place_name}"]
                         if reading.place_slug else
                         [] if reading.place_name else
                         _catalogue_chips(places, "{} tour packages", 3)),
        )

    if reading.intent is Intent.DESTINATIONS:
        if reading.is_country and reading.options:
            shown = reading.options[:6]
            return Answer(
                reply=f"In {reading.place_name} we cover {_join(shown)}"
                      + (" and more" if len(reading.options) > len(shown) else "")
                      + ". Pick one and I'll show it.",
                intent=reading.intent,
                action={"type": "show_destinations", "params": {"country": reading.place_name}},
                suggestions=[f"Show me {n}" for n in shown[:4]],
            )
        if reading.place_slug:
            return Answer(
                reply=f"{lead}Here is {to}. I can show its places to visit, tour packages "
                      "or hotels — which would you like?",
                intent=reading.intent,
                action={"type": "show_destination",
                        "params": {"destination": reading.place_slug, "name": to}},
                suggestions=[f"Places to visit in {to}", f"{to} tour packages",
                             f"Hotels in {to}"],
            )
        if reading.not_found and reading.place_name:
            return _not_found_answer(reading, places, "destinations")
        names = [n for _, n in (places.destinations if places else [])]
        return Answer(
            reply="Here are our destinations"
                  + (f" — {_join(names[:5])} and more." if names else ".")
                  + " Pick one and I'll show it.",
            intent=reading.intent,
            action={"type": "show_destinations", "params": {}},
            suggestions=[f"Show me {n}" for n in names[:4]],
        )

    if reading.intent is Intent.CLARIFY and reading.near:
        # A MISSPELT PLACE, ASKED ABOUT AND NEVER ACTED ON. Each choice sends the
        # traveller's own sentence with the stored name put in, so choosing one
        # is exactly the request they made — and nothing has opened before then.
        matches = reading.near
        if len(matches) == 1:
            c = matches[0].candidate
            where = f"{c.name} ({c.parent_name})" if c.parent_name else c.name
            reply = (f"We don't have {c.name} in {reading.wrong_parent} — it's in "
                     f"{c.parent_name}. Did you mean {where}?" if reading.wrong_parent
                     else f"Did you mean {where}?")
        else:
            reply = "Which of these did you mean?"
        return Answer(
            reply=reply,
            intent=reading.intent,
            suggestions=[m.candidate.label for m in matches],
            choices=[{"label": m.candidate.label, "message": msg}
                     for m, msg in zip(matches, reading.rewrites)],
        )

    if reading.intent is Intent.CLARIFY:
        where = reading.place_name
        if len(reading.options) == 2:
            a, b = reading.options
            return Answer(
                reply=f"You mentioned {a} and {b}. Are you looking for flights between "
                      f"them, or something in one of them?",
                intent=reading.intent,
                suggestions=[f"Flights from {a} to {b}", f"Show me {a}", f"Show me {b}"],
            )
        if where:
            return Answer(
                reply=f"Happy to help with a holiday in {where}. Are you looking for tour "
                      "packages, hotels or flights?",
                intent=reading.intent,
                suggestions=[f"{where} tour packages", f"Hotels in {where}",
                             f"Flights to {where}"],
            )
        return Answer(
            reply="Happy to help plan a trip. Would you like to see tour packages, "
                  "destinations or flights?",
            intent=reading.intent,
            suggestions=["Show tour packages", "Show me destinations", "Flights from Hyderabad"],
        )

    if reading.intent is Intent.GENERAL:
        where = to
        return Answer(
            reply="I can't answer travel questions like that yet — I only know what we "
                  "sell. I can show you "
                  + (f"{where}'s places to visit, tour packages or hotels." if where
                     else "destinations, tour packages, hotels and flights."),
            intent=reading.intent,
            suggestions=([f"Places to visit in {where}", f"{where} tour packages"]
                         if where else ["Show me destinations", "Show tour packages"]),
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
# 5. What the conversation already holds — follow-ups
# ---------------------------------------------------------------------------
# "Show me Goa tour packages" … "only family packages" … "for four people" …
# "change the destination to Bali". Each of the later sentences is half a search:
# it only means something beside the first one.
#
# THE SEARCH IS HELD BY THE BROWSER, NOT BY THE SERVER. The browser sends back
# the `context` the previous reply handed it; the server reads it, applies the
# change, and returns the new one. That keeps the assistant stateless (nothing
# to expire, nothing to clean up after a signed-out visitor leaves), makes every
# follow-up testable as a plain function call, and means a stale context cannot
# outlive the tab. IT IS UNTRUSTED INPUT, exactly like the sentence beside it:
# clean_context() keeps a fixed set of keys, bounds every value, and drops
# anything else, and nothing in it can do more than the sentence itself could.
#
# A NEW SEARCH REPLACES THE CONTEXT; IT NEVER MERGES INTO IT. "Show me Dubai
# packages" after a four-day Goa search is a Dubai search, not a four-day one.
# A sentence is a follow-up only when it names no OTHER product, does not open
# with a request of its own, and says something (a place, a length, a month, a
# party, a style) that can change the search it follows.
_CTX_SERVICES = ("package", "flight", "hotel", "places")
_CTX_TEXT_KEYS = ("destination", "destination_slug", "origin", "date", "month",
                  "preference", "pkg_type", "trip", "list")
_THEME_NAMES = {name for name, _ in _THEMES}
_SERVICE_INTENT_OF = {"package": Intent.PACKAGE, "flight": Intent.FLIGHT,
                      "hotel": Intent.HOTEL, "places": Intent.PLACES}

#: A request of its own: "show…", "find…", "I want…". Opens a NEW search unless a
#: word like "only" or "instead" says it is a change to the last one.
_NEW_SEARCH_LEAD = re.compile(
    r"^\s*(?:please\s+)?(?:show|find|search|look(?:ing)?|get|book|take|plan|give|tell|explain|describe"
    r"|i\s+(?:want|need|would|'d|wanna|am looking)|we\s+(?:want|need)|can you|could you)\b", re.I)
_FOLLOW_MARKER = re.compile(
    r"\b(?:only|just|also|instead|too|same|those|these|them|rather|actually|change|switch"
    r"|update|make it|how about|what about|but)\b", re.I)
_CHANGE_TO = re.compile(
    r"\b(?:change|switch|make|update|set)\b.*?\b(?:to|as)\s+(?P<p>.+?)\s*$", re.I)
_INSTEAD = re.compile(
    r"\b(?:how about|what about|try)\s+(?P<p>.+?)\s*$|^\s*(?P<q>.+?)\s+instead\s*$", re.I)


# ---------------------------------------------------------------------------
# Flights as conversation state (see flight_slots)
# ---------------------------------------------------------------------------
#: "change the origin to Mumbai", "set destination as Goa", "switch the departure city to X".
_SET_SLOT = re.compile(
    r"\b(?:change|switch|update|set|make)\b\s+(?:the\s+|my\s+)?"
    r"(?P<slot>origin|source|departure(?:\s+city|\s+airport)?|from|destination|arrival|to)\b"
    r"\s*(?:city|airport)?\s*(?:to|as|=|:|is)?\s*(?P<p>.+?)\s*$", re.I)
#: "origin Mumbai", "destination: Goa".
_SLOT_WORD = re.compile(r"^\s*(?P<slot>origin|destination)\s*(?:is|:|=)?\s+(?P<p>.+?)\s*$", re.I)
#: "to Goa", "flying to Goa", "I'll be going to Goa" — a destination on its own.
_TO_ONLY = re.compile(
    r"^\s*(?:(?:i(?:'m| am| will|'ll)\s+)?(?:be\s+)?(?:flying|going|travell?ing|heading)\s+)?to\s+(?P<p>.+?)\s*$", re.I)
#: The PRODUCT asked for, as opposed to the verb: "flights", "tickets". "I'll fly from
#: Delhi" answers a question; "flights from Delhi to Goa" is a request of its own.
_FLIGHT_NOUN = re.compile(r"\b(flights?|tickets?|air ?fares?|air ?tickets?)\b", re.I)
#: "any day", "skip" — an answer to "what day?" that declines to give one.
_SKIP = re.compile(r"^\s*(?:skip|any(?:\s?day|\s?time|\s?date)?|anytime|whenever|flexible|no preference"
                   r"|doesn'?t matter|not sure)\b", re.I)
#: Spoken padding in front of a bare answer: "um, it's Delhi".
_FILLER = re.compile(r"^(?:(?:um+|uh+|well|so|ok(?:ay)?|yes|yeah|sure|it'?s|its|it is|that'?s|i'?m|i am"
                     r"|we'?re|we are|the|my)\b[\s,]*)+", re.I)
_AFTER = re.compile(r"\b(?:instead|please|pls|then|actually|rather|thanks|thank you)\b[\s.!?]*$", re.I)
#: Words that are answers, not places.
_NOT_AN_ANSWER = {"no", "nope", "nah", "none", "nothing", "ok", "okay", "yes", "yeah", "thanks", "hmm", "hello", "hi"}


def _flight_facts(raw: str, today=None) -> fs.Facts:
    """One sentence, as what it says about a flight (flight_slots.Facts).

    Language only: which words are the origin, which the destination, which a lone
    place, which a day. What those MEAN for the search — a lone place answers the
    open question — is flight_slots' job, which is why a lone "Delhi" is a `place`
    here and not yet an origin or a destination."""
    facts = fs.Facts(
        date=travel_dates.parse_day(raw, today),
        trip="round" if _ROUND.search(raw) else None,
        passengers=_find_passengers(raw),
        skip_date=bool(_SKIP.search(raw)),
    )
    text = _AFTER.sub("", raw.strip()).strip()
    m = _SET_SLOT.search(text) or _SLOT_WORD.search(text)
    if m:
        word = m["slot"].lower().split()[0]
        value = _span(m["p"])
        if value:
            facts.set_slot = ("origin" if word in ("origin", "source", "departure", "from") else "destination", value)
            return facts
    origin_text, dest_text = _route(text)
    if origin_text or dest_text:
        facts.origin, facts.destination = origin_text, dest_text
        return facts
    m = _TO_ONLY.search(text)
    if m and _span(m["p"]):
        facts.destination = _span(m["p"])
        return facts
    place = _span(_FILLER.sub("", text).strip())
    if place and place.lower() not in _NOT_AN_ANSWER and not facts.skip_date:
        facts.place = place
    return facts


def _flight_reading(facts: fs.Facts, before: fs.Flight | None, *, spoken_origin: str | None = None,
                    spoken_destination: str | None = None, followup: bool = False,
                    confidence: float = 1.0, today=None) -> Reading:
    """Facts + the flight so far -> the new flight, as a Reading.

    THE ONE PLACE A FLIGHT READING IS MADE — from a first sentence, from a follow-up,
    and from a model's structured answer — so all three obey the same transitions."""
    start = before or fs.Flight()
    new = fs.settle(fs.apply(start, facts), today)
    reading = Reading(
        intent=Intent.FLIGHT, flight=new, trip=new.trip, date=new.date, passengers=new.passengers,
        origin_name=spoken_origin or new.origin or None,
        place_name=spoken_destination or new.destination or None,
        followup=followup, confidence=confidence,
    )
    if followup and not new.issue:
        reading.ack = fs.acknowledge(start, new)
    return reading


def clean_context(raw) -> dict:
    """The browser's ``context`` as a safe dict, or ``{}``.

    Fixed keys, bounded values, validated shapes. A key outside the list is
    dropped, not carried; a value that is the wrong type or length is dropped,
    not coerced. Whatever survives is no more powerful than the traveller typing
    the same words.
    """
    if not isinstance(raw, dict):
        return {}
    service = raw.get("service")
    if service not in _CTX_SERVICES + ("destination",):
        return {}
    out: dict = {"service": service}
    for key in _CTX_TEXT_KEYS:
        value = raw.get(key)
        if isinstance(value, str) and 0 < len(value.strip()) <= 80:
            out[key] = value.strip()
    for key, low, high in (("days", 1, 30), ("passengers", 1, 9)):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high:
            out[key] = value
    if "month" in out and not re.fullmatch(r"\d{4}-\d{2}", out["month"]):
        del out["month"]
    if "date" in out and not _ISO_DAY.fullmatch(out["date"]):
        del out["date"]
    if out.get("pkg_type") not in (None, "domestic", "international", "pilgrimage"):
        del out["pkg_type"]
    if "preference" in out and out["preference"] not in _THEME_NAMES:
        del out["preference"]
    if out.get("trip") not in (None, "oneway", "round"):
        del out["trip"]
    if out.get("list") not in (None, "locations", "attractions"):
        del out["list"]
    # The slot state of a conversation in progress (flight_slots): the question
    # that is open, the airports already resolved, and whether the day was asked.
    if raw.get("awaiting") in ("origin", "destination", "date"):
        out["awaiting"] = raw["awaiting"]
    for key in ("origin_code", "destination_code"):
        value = raw.get(key)
        if isinstance(value, str) and re.fullmatch(r"[A-Z]{3}", value):
            out[key] = value
    if raw.get("date_asked") is True:
        out["date_asked"] = True
    return out


def next_context(reading: Reading, prior: dict | None) -> dict | None:
    """The search to remember after this reading — or what was remembered, or none.

    A search replaces the context outright. Small talk and a sentence nobody
    understood leave it alone (a mis-hear must not wipe a good search); leaving
    for support or My Bookings clears it.
    """
    i = reading.intent
    keep = prior or None

    def pack(**fields) -> dict:
        return {k: v for k, v in fields.items() if v not in (None, "", [])}

    if i is Intent.PACKAGE and not reading.is_country:
        return pack(service="package", destination=reading.place_name,
                    destination_slug=reading.place_slug, days=reading.days,
                    month=reading.month, date=reading.date, passengers=reading.passengers,
                    preference=reading.theme, pkg_type=reading.pkg_type)
    if i is Intent.FLIGHT:
        # The flight's own state — slots, resolved airports and the open question.
        if isinstance(reading.flight, fs.Flight):
            return fs.to_context(reading.flight)
        return pack(service="flight", origin=reading.origin_name,
                    destination=reading.place_name, date=reading.date,
                    trip=reading.trip if reading.trip == "round" else None,
                    passengers=reading.passengers)
    if i is Intent.HOTEL and reading.place_name and not reading.is_country:
        return pack(service="hotel", destination=reading.place_name,
                    destination_slug=reading.place_slug, date=reading.date,
                    passengers=reading.passengers)
    # A question with no city yet ("Find hotels" -> "Which city?"): the next bare
    # place is the answer, not a new request for a destination page.
    if i is Intent.HOTEL and not reading.place_name and not reading.is_country:
        return {"service": "hotel", "awaiting": "destination"}
    if i is Intent.PLACES and reading.place_slug:
        return pack(service="places", destination=reading.place_name,
                    destination_slug=reading.place_slug, list=reading.list_kind)
    if i is Intent.PLACES and not reading.place_name and not reading.is_country:
        return {"service": "places", "awaiting": "destination"}
    if i is Intent.DESTINATIONS and reading.place_slug:
        return pack(service="destination", destination=reading.place_name,
                    destination_slug=reading.place_slug)
    if i in (Intent.GREETING, Intent.THANKS, Intent.FALLBACK, Intent.GENERAL):
        return keep
    return None


def _month_label(month: str) -> str:
    return dt.date(int(month[:4]), int(month[5:7]), 1).strftime("%B %Y")


def _flight_followup(raw: str, ctx: dict) -> Reading | None:
    """``raw`` as the next turn of a flight in progress, or None for a NEW search.

    A sentence is a NEW search — and starts clean, inheriting no route, day or party —
    when it asks for the product ("flights from Mumbai to Dubai") and does more than
    answer the question that is open. A sentence that merely answers it ("Delhi",
    "from Delhi", "flights from Delhi" when asked where from) updates the flight."""
    facts = _flight_facts(raw)
    if facts.empty:
        return None
    before = fs.from_context(ctx)
    if not _flight_continues(raw, facts, before):
        return None
    return _flight_reading(facts, before, followup=True, confidence=0.9)


def _flight_continues(raw: str, facts: fs.Facts, before: fs.Flight) -> bool:
    """Does this sentence continue the flight in progress (True), or start a new one?

    ONE DECISION, USED BY THE RULES AND BY A MODEL'S ANSWER ALIKE, so a model cannot
    decide differently what a new search is. Asking for the product ("flights from
    Mumbai to Dubai") while doing more than answer the open question is a new
    search; answering the question — however it is worded — is not."""
    gives_place = bool(facts.origin or facts.destination or facts.place)
    if _FLIGHT_NOUN.search(raw) and gives_place and not facts.set_slot:
        asked = before.awaiting
        answers_it = (
            (asked == "origin" and facts.origin and not facts.destination)
            or (asked == "destination" and facts.destination and not facts.origin)
            or (asked in ("origin", "destination") and facts.place and not facts.origin and not facts.destination)
        )
        return bool(answers_it)
    return True


def _awaited_destination(raw: str, ctx: dict, places: Places, service: str) -> Reading | None:
    """A bare place, answering "which city?" for a hotel or places question.

    Handed to the ordinary reader as the sentence the traveller would have said had
    they said it in full, so the catalogue, the misspelling check and the unknown-place
    answer all apply exactly as they do to a typed request."""
    place = _span(_FILLER.sub("", raw.strip()).strip())
    if not place or place.lower() in _NOT_AN_ANSWER:
        return None
    full = f"hotels in {place}" if service == "hotel" else f"places to visit in {place}"
    return detect_intent(full, places)


def _followup(raw: str, ctx: dict, places: Places) -> Reading | None:
    """``raw`` as a change to the search in ``ctx``, or None if it is a new request.

    None is the safe answer and the common one: the sentence is then read from
    scratch and the context is replaced by whatever it turns out to be.
    """
    service = ctx.get("service")
    if service not in _CTX_SERVICES or len(raw.split()) > 14:
        return None
    if (_SUPPORT.search(raw) or _BOOKINGS.search(raw) or _GREETING.search(raw)
            or _THANKS.search(raw) or _GENERAL_Q.search(raw)):
        return None

    # "round trip" and "one way" are about a FLIGHT; the word "trip" in them must not
    # be read as a holiday package.
    scan = _ROUND.sub(" ", raw)
    said = {
        "package": bool(_PACKAGE_STRONG.search(scan) or _PACKAGE_WEAK.search(scan)),
        "flight": bool(_FLIGHT.search(raw)),
        "hotel": bool(_HOTEL.search(scan)),
        "places": bool(_PLACES.search(scan) or _LOCATIONS_WORD.search(scan)),
        # NOT _DISCOVER: "change the destination to Bali" contains the word and
        # is the commonest follow-up there is. A real request to browse
        # ("show me destinations") opens with a request of its own, which the
        # _NEW_SEARCH_LEAD test below already treats as a new search.
    }
    # A different product is a different search, whatever else it says.
    if any(named for kind, named in said.items() if kind != service):
        return None

    # A QUESTION IS OPEN. "Delhi" after "which city?" is the answer to it.
    if service == "flight":
        return _flight_followup(raw, ctx)
    if ctx.get("awaiting") == "destination" and service in ("hotel", "places"):
        answer = _awaited_destination(raw, ctx, places, service)
        if answer is not None:
            return answer

    marked = bool(_FOLLOW_MARKER.search(raw))
    if _NEW_SEARCH_LEAD.search(raw) and not marked:
        return None
    origin_text, dest_text = _route(raw)
    if origin_text and dest_text and service != "flight" and not marked:
        return None          # "from Hyderabad to Goa" is a route, and a flight

    fields: dict = {}
    labels: list[str] = []

    if service == "package":
        days = _find_days(raw)
        if days:
            fields["days"] = days
            labels.append(f"{days} days")
        theme = _find_theme(raw)
        if theme:
            fields["theme"] = theme
            labels.append(f"{theme} style")
        kind = _find_pkg_type(raw)
        if kind:
            fields["pkg_type"] = kind
            labels.append(f"{kind} trips")
        month, when = _find_package_when(raw)
        if month:
            fields["month"], fields["date"] = month, when
            labels.append(f"departing {_month_label(month)}")
    elif service in ("flight", "hotel"):
        day = _find_date(raw)
        if day:
            fields["date"] = day
            labels.append(f"date {day}")
        if service == "flight" and _ROUND.search(raw):
            fields["trip"] = "round"
            labels.append("round trip")

    if service != "places":
        pax = _find_passengers(raw)
        if pax:
            fields["passengers"] = pax
            labels.append(f"{pax} traveller" + ("s" if pax != 1 else ""))

    # --- a new place ----------------------------------------------------------
    target = None
    spoken = _CHANGE_TO.search(raw) or _INSTEAD.search(raw)
    if spoken:
        target = (spoken.groupdict().get("p") or spoken.groupdict().get("q") or "").strip()
    if target and service == "package" and not fields.get("theme"):
        # "change it to honeymoon" changes the style, not the destination.
        theme_named = _find_theme(target)
        if theme_named:
            fields["theme"] = theme_named
            labels.append(f"{theme_named} style")
            target = None
    place_slug = place_name = None
    if target:
        place_slug, place_name = _named(_span(target), places)
        if place_name and (_NOT_A_PLACE.match(place_name) or re.search(r"\d", place_name)
                           or _find_days(place_name) or _find_theme(place_name)):
            place_slug = place_name = None
    if not place_name:
        hit = _find_place(raw, places)
        if hit:
            place_slug, place_name = hit[0][0], hit[0][1]
    if place_name:
        fields["place"] = (place_slug, place_name)
        labels.append(f"destination {place_name}")
    if service == "flight" and origin_text and not dest_text:
        o_slug, o_name = _named(origin_text, places)
        if o_name:
            fields["origin"] = o_name
            labels.append(f"from {o_name}")

    if not fields:
        return None

    reading = Reading(
        intent=_SERVICE_INTENT_OF[service],
        place_slug=ctx.get("destination_slug"), place_name=ctx.get("destination"),
        origin_name=ctx.get("origin"), date=ctx.get("date"),
        passengers=ctx.get("passengers"), trip=ctx.get("trip", "oneway"),
        days=ctx.get("days"), month=ctx.get("month"), theme=ctx.get("preference"),
        pkg_type=ctx.get("pkg_type"), list_kind=ctx.get("list", "attractions"),
        followup=True, changed=labels, confidence=0.9,
    )
    if "place" in fields:
        reading.place_slug, reading.place_name = fields.pop("place")
    for key, value in fields.items():
        setattr(reading, key, value)
    return reading


def _enrich_package(reading: Reading, text: str) -> Reading:
    """Fill the package details a PROVIDER's reading does not carry.

    A provider returns an intent and places; length, month, style and party are
    read from the sentence by the same rules the built-in reader uses, so
    switching a provider on does not switch the new package filters off.
    """
    if reading.intent is Intent.PACKAGE:
        reading.days = reading.days or _find_days(text)
        reading.theme = reading.theme or _find_theme(text)
        reading.pkg_type = reading.pkg_type or _find_pkg_type(text)
        reading.passengers = reading.passengers or _find_passengers(text)
        if not reading.month:
            reading.month, when = _find_package_when(text)
            reading.date = reading.date or when
    return reading


# ---------------------------------------------------------------------------
# 6. A provider, when one is configured
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


#: Intents a model is never asked about: the rules are certain, and a model has
#: nothing to add to "thanks" or "talk to a person".
_NO_MODEL = (Intent.GREETING, Intent.THANKS, Intent.SUPPORT, Intent.BOOKINGS)


def _wants_model(rules: Reading, text: str) -> bool:
    """Is this sentence worth a model call? MINIMAL BY DESIGN: the rules answer
    most messages; the model sees the ones they did not understand, were unsure
    about, or that are long enough to hide a route or a change in a clause."""
    if rules.intent in _NO_MODEL:
        return False
    if rules.intent in (Intent.FALLBACK, Intent.CLARIFY, Intent.GENERAL) or rules.confidence < 0.7:
        return True
    return len(text.split()) >= max(1, settings.travel_ai_min_words)


def _synth(sentence: str, want: Intent, places: Places) -> Reading | None:
    """Read a sentence the BACKEND wrote from a model's grounded arguments.

    The model never builds a Reading itself for hotels, packages or places: its
    arguments become a plain sentence that goes through the same rules a customer's
    own words would, so every place is resolved against the catalogue the same way."""
    reading = detect_intent(sentence, places)
    return reading if reading.intent is want else None


def _reading_from_turn(turn, text: str, places: Places, prior: dict) -> Reading | None:
    """A validated tool call -> a Reading, or None to let the rules answer.

    GROUNDING: a place the customer did not say is dropped (_said); a date,
    party size and trip type are re-read from the customer's words by the rules,
    never taken from the model; and the decision whether a sentence continues the
    flight in progress is the rules' own (_flight_continues)."""
    a = turn.args
    tool = turn.tool
    if tool == "search_flights":
        facts = _flight_facts(text)
        facts.origin = _said(a.get("origin"), text)
        facts.destination = _said(a.get("destination"), text)
        facts.set_slot = None
        facts.place = None
        if facts.origin and facts.destination and facts.origin.lower() == facts.destination.lower():
            return None
        if facts.empty:
            return None
        before = fs.from_context(prior) if prior.get("service") == "flight" else None
        if before is not None and not _flight_continues(text, facts, before):
            before = None
        return _flight_reading(facts, before, followup=before is not None, confidence=0.85)
    dest = _said(a.get("destination"), text)
    if tool == "search_hotels":
        near = _said(a.get("location"), text)
        if near:
            return _synth(f"hotels near {near}" + (f" in {dest}" if dest else ""), Intent.HOTEL, places)
        return _synth(f"hotels in {dest}", Intent.HOTEL, places) if dest else None
    if tool == "search_tour_packages":
        if not dest:
            return None
        reading = _synth(f"tour packages for {dest}", Intent.PACKAGE, places)
        return _enrich_package(reading, text) if reading else None
    if tool == "get_destinations":
        country = _said(a.get("country"), text)
        return _synth(f"show me destinations in {country}" if country else "show me destinations",
                      Intent.DESTINATIONS, places)
    if tool == "get_destination_locations":
        if not dest:
            return None
        phrase = "areas in" if a.get("kind") == "areas" else "places to visit in"
        return _synth(f"{phrase} {dest}", Intent.PLACES, places)
    if tool == "get_location_details":
        spot = _said(a.get("location"), text)
        if not spot:
            return None
        hit = _find_attraction(spot, places)
        if not hit:
            return None
        return Reading(intent=Intent.PLACES, place_slug=hit[0], attraction_slug=hit[1],
                       attraction_name=hit[2], confidence=0.85)
    if tool == "ask_clarification":
        return _synth(f"I want a holiday in {dest}", Intent.CLARIFY, places) if dest else None
    if tool == "answer_general_question":
        return Reading(intent=Intent.GENERAL, confidence=0.8)
    return None


def read(text: str, places: Places, prior: dict | None = None) -> tuple[Reading, str]:
    """One sentence -> (reading, which reader produced it).

    RULES FIRST, MODEL ONLY WHEN IT CAN HELP. The deterministic reader is a complete
    implementation of the brief; a configured model is asked only about sentences
    the rules did not understand, were unsure of, or that are long (_wants_model).
    Its answer is a validated tool call that is grounded again here; anything off
    — no key, a timeout, an unknown tool, a city nobody said — and the rules'
    reading stands. Switching a model on can widen what is understood; it cannot
    change what the site does with it, and switching it off or losing it narrows
    quality, never availability."""
    rules = detect_intent(text, places)
    provider = travel_ai.get_provider()
    if provider is None or not _wants_model(rules, text):
        return rules, "rules"
    prior = prior or {}
    hints = travel_ai.Hints(
        destinations=[name for _, name in places.destinations],
        countries=sorted(places.countries),
        intents=sorted(_INTENT_NAMES),
        today=dt.date.today().isoformat(),
        state=prior, awaiting=prior.get("awaiting"),
    )
    try:
        if type(provider).plan is not travel_ai.AIProvider.plan:
            turn = provider.plan(text, hints)
            reading = _reading_from_turn(turn, text, places, prior) if turn is not None else None
            if reading is not None:
                return reading, provider.name
        else:  # a provider written against the older classify-only interface
            understanding = provider.classify(text, hints)
            reading = _from_provider(understanding, text, places) if understanding is not None else None
            if reading is not None:
                return _enrich_package(reading, text), provider.name
    except Exception as exc:  # a provider must not take the panel down
        log.warning("travel_ai provider raised: %s", type(exc).__name__)
    return rules, "rules"


def analyze_message(text: str, places: Places, context: dict | None = None) -> dict:
    """The whole understanding of one sentence, in one call.

    ``{'intent', 'service_intent', 'entities', 'action', 'reply', 'suggestions',
    'confidence', 'reader', 'context'}`` — what was asked, what it was about,
    where to send them, what to say, and the search to remember for the next
    sentence. The conversation layer stores the reply and hands the rest to the
    browser; nothing else has to know that reading and answering are two steps.

    ``context`` is the previous reply's ``context``, as the browser holds it. A
    sentence that is a change to that search is applied to it; anything else is
    read from scratch and replaces it.
    """
    prior = clean_context(context)
    reading = None
    reader = "rules"
    if prior:
        reading = _followup((text or "").strip(), prior, places)
        if reading is not None:
            reader = "context"
    if reading is None:
        reading, reader = read(text, places, prior)
    answer = execute_action(reading, places)
    return {
        "intent": answer.intent.value,
        "service_intent": service_intent(answer.intent),
        "entities": reading.entities(),
        "action": answer.action,
        "reply": answer.reply,
        "suggestions": answer.suggestions,
        "choices": answer.choices,
        "confidence": reading.confidence,
        "reader": reader,
        "context": next_context(reading, prior),
    }
