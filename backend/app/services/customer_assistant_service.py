"""The Travel Assistant — what a traveller asked for, and what to answer.

THREE FUNCTIONS, IN THE ORDER THEY RUN:

    detect_intent(text, places)     what was asked for, and about where
    generate_response(reading)      the words, and the screen to open
    process_message(...)            the two above, plus the conversation

NOTHING ELSE IN THE APPLICATION DECIDES WHAT THE ASSISTANT SAYS. The browser
renders `reply` and follows `action`; it does not carry a second copy of these
rules, which is the failure this module exists to prevent — a phrase understood
in the panel and not in the voice popup would be two assistants wearing one
name.

NO PLACE NAME IS WRITTEN HERE. Destinations are read from
``customer_destinations`` and their landmarks from ``customer_attractions``
(0070/0075) and matched against what was said, so a destination added through
the catalogue is understood by the assistant the same day, with no edit here.

RULES FIRST, AND A MODEL IS OPTIONAL. This is the deterministic matcher, the
same arrangement ``services/assistant`` (the merchant's helper) uses: a
built-in classifier that needs no vendor, and one seam — ``detect_intent`` —
where a provider can be put in front of it later. A model would classify;
the sentences below would still be the answer, because an assistant that
invents prices or availability is worse than one that cannot.

WHAT IT DELIBERATELY DOES NOT DO: quote a fare, claim a room is free, or book
anything. It understands the request and opens the screen that can answer it,
which is the existing search — never a second booking path.
"""
from __future__ import annotations

import datetime as dt
import enum
import re
import secrets
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerAssistantMessage,
    CustomerAssistantSession,
    CustomerAttraction,
    CustomerDestination,
)

#: Hard cap on one message. Long enough for a spoken sentence, short enough
#: that nothing here is a place to paste a document into.
MAX_MESSAGE = 500
#: How much history a browser may ask back for.
MAX_HISTORY = 100


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
_PLACES = re.compile(r"\b(visit|see|sight ?seeing|sights|places|attraction|attractions|landmark|landmarks|things to do)\b", re.I)
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


def load_places(db: Session) -> Places:
    """Read the place names once per request. Two small indexed queries."""
    dests = db.execute(
        select(CustomerDestination.slug, CustomerDestination.name)
        .where(CustomerDestination.is_active.is_(True))
    ).all()
    attrs = db.execute(
        select(CustomerDestination.slug, CustomerAttraction.slug, CustomerAttraction.name)
        .join(CustomerAttraction,
              CustomerAttraction.destination_id == CustomerDestination.customer_destination_id)
        .where(CustomerAttraction.is_active.is_(True), CustomerDestination.is_active.is_(True))
    ).all()
    return Places(
        destinations=[(d.slug, d.name) for d in dests],
        attractions=[(a[0], a[1], a[2]) for a in attrs],
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

    found = _find_place(raw, places)
    attraction = _find_attraction(raw, places)
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

    if said_flight or ((origin_text or dest_text) and not named_other):
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
        return Reading(
            intent=Intent.HOTEL, place_slug=place_slug, place_name=place_name,
            date=date, passengers=pax, confidence=1.0 if place_name else 0.6,
        )

    # ---- 3. Places to visit ----------------------------------------------
    if _PLACES.search(raw) or attraction:
        slug = place_slug or (attraction[0] if attraction else None)
        name = place_name
        if not name and attraction:
            name = next((n for s, n in places.destinations if s == attraction[0]), None)
        return Reading(
            intent=Intent.PLACES, place_slug=slug, place_name=name,
            attraction_slug=attraction[1] if attraction else None,
            attraction_name=attraction[2] if attraction else None,
            confidence=1.0 if slug else 0.5,
        )

    # ---- 4. Holiday packages ---------------------------------------------
    if _PACKAGE.search(raw):
        return Reading(
            intent=Intent.PACKAGE, place_slug=place_slug, place_name=place_name,
            date=date, passengers=pax, confidence=1.0 if place_name else 0.6,
        )

    # A place on its own, with no product word and no route — "Goa". The
    # packages shelf is the right shelf for that, and it is now the ONLY way to
    # reach it by accident, which is what the rewrite was for.
    if place_name:
        return Reading(intent=Intent.PACKAGE, place_slug=place_slug,
                       place_name=place_name, date=date, confidence=0.5)

    return Reading(intent=Intent.FALLBACK, confidence=0.0)


# ---------------------------------------------------------------------------
# 2. What to say back
# ---------------------------------------------------------------------------
def generate_response(reading: Reading) -> Answer:
    """One reading -> the words and the screen. No data is read here.

    EVERY SENTENCE IS ABOUT WHAT HAPPENS NEXT, never about price or
    availability: this module has read no fares and no rooms, so a line like
    "flights from ₹2,499" would be invented. The screen it opens is the one
    that holds the real answer.
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
        return Answer(
            reply="I can show you what to see. Which destination did you have in mind?",
            intent=reading.intent,
            suggestions=["Places to visit in Jaipur", "What to see in Bali"],
        )

    if reading.intent is Intent.PACKAGE:
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


# ---------------------------------------------------------------------------
# 3. The conversation
# ---------------------------------------------------------------------------
def _clean(text: str) -> str:
    """Trim, drop control characters, and cap the length.

    Storage is plain text and the browser renders every message with
    textContent, so nothing here is HTML-escaped — escaping on the way IN
    would double-escape the moment it is rendered correctly. Control
    characters go because they are never typed on purpose and make a log
    unreadable.
    """
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", (text or "")).strip()
    return cleaned[:MAX_MESSAGE]


def get_session(
    db: Session, session_key: str | None, customer: Customer | None, kind: str = "assistant",
) -> CustomerAssistantSession:
    """The conversation this message belongs to, creating one if needed.

    A KEY IS ONLY HONOURED WHEN IT IS THE CALLER'S TO USE. A session already
    claimed by a customer is refused to anyone else — including a signed-out
    browser holding the key — so a leaked key cannot be used to read somebody's
    history. Anything unusable simply starts a new conversation rather than
    failing: the traveller is mid-sentence and does not care why.
    """
    session = None
    if session_key:
        session = db.scalar(
            select(CustomerAssistantSession)
            .where(CustomerAssistantSession.session_key == session_key)
        )
        if session is not None:
            owner = session.customer_id
            mine = customer.customer_id if customer else None
            if owner is not None and owner != mine:
                session = None
            elif owner is None and mine is not None:
                # Signed in mid-conversation: the guest session becomes theirs.
                session.customer_id = mine

    if session is None:
        session = CustomerAssistantSession(
            session_key=secrets.token_urlsafe(24),
            customer_id=customer.customer_id if customer else None,
            kind=kind if kind in ("assistant", "voice") else "assistant",
        )
        db.add(session)
        db.flush()

    session.last_active_at = dt.datetime.now(dt.timezone.utc)
    return session


def process_message(
    db: Session,
    *,
    session_key: str | None,
    message: str,
    customer: Customer | None = None,
    kind: str = "assistant",
) -> dict:
    """Take one line from a traveller, store both sides, and answer.

    Both turns are written in ONE transaction with the reply that was actually
    sent, so the stored history is what the traveller saw — not a reply
    regenerated later from rules that may since have changed.
    """
    text = _clean(message)
    session = get_session(db, session_key, customer, kind)

    if not text:
        reading = Reading(intent=Intent.FALLBACK, confidence=0.0)
        answer = Answer(
            reply="I did not catch that — could you say it again?",
            intent=Intent.FALLBACK,
        )
    else:
        reading = detect_intent(text, load_places(db))
        answer = generate_response(reading)

    db.add(CustomerAssistantMessage(
        session_id=session.customer_assistant_session_id, sender="user", message=text or "",
    ))
    db.add(CustomerAssistantMessage(
        session_id=session.customer_assistant_session_id, sender="assistant",
        message=answer.reply, intent=answer.intent.value,
    ))
    db.commit()

    return {
        "session_id": session.session_key,
        "reply": answer.reply,
        "intent": answer.intent.value,
        "action": answer.action,
        # The reading itself, beside the screen it opened. `action` says WHERE
        # to go and `entities` says WHAT was understood; a browser that wants
        # to fill a field reads the second without having to unpick the first.
        "entities": reading.entities(),
        "suggestions": answer.suggestions,
        "timestamp": dt.datetime.now(dt.timezone.utc),
    }


def history(db: Session, session_key: str, customer: Customer | None = None) -> list[dict] | None:
    """Every turn of one conversation, oldest first. ``None`` if not theirs."""
    session = db.scalar(
        select(CustomerAssistantSession)
        .where(CustomerAssistantSession.session_key == session_key)
    )
    if session is None:
        return None
    mine = customer.customer_id if customer else None
    if session.customer_id is not None and session.customer_id != mine:
        return None
    return [
        {"sender": m.sender, "message": m.message, "intent": m.intent, "created_at": m.created_at}
        for m in session.messages[:MAX_HISTORY]
    ]


def claim(db: Session, session_key: str, customer: Customer) -> bool:
    """Attach a guest conversation to the account that has just signed in.

    The merge the brief asks for, and it copies nothing: the rows already
    exist, so this names their owner. A session already owned by someone else
    is left alone and reported as not claimed.
    """
    session = db.scalar(
        select(CustomerAssistantSession)
        .where(CustomerAssistantSession.session_key == session_key)
    )
    if session is None:
        return False
    if session.customer_id is not None:
        return session.customer_id == customer.customer_id
    session.customer_id = customer.customer_id
    db.commit()
    return True
