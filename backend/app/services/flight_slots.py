"""A flight request as STATE — what is known, what was just asked, and what to ask next.

THE BUG THIS REPLACES. "Flights to Goa" -> "Where are you flying from?" -> "Delhi" used
to come out as "Flights to Delhi — where are you flying from?": the conversation kept
a destination and nothing about the QUESTION THAT HAD JUST BEEN ASKED, so a bare place
could only be read as "change the destination", and "Delhi to Goa" — a complete route —
was not read as a route at all. The fix is not a smarter guess about the words; it is
remembering what was asked.

    Flight(origin, destination, date, trip, passengers, awaiting, ...)

`awaiting` is the slot the assistant's last question was about. A short reply ("Delhi")
fills THAT slot; a complete route ("Delhi to Goa") sets both; an explicit instruction
("change the origin to Mumbai") sets the one named; a change replaces only its own field.

EXPLICIT TRANSITIONS, NO GUESSING ABOUT HISTORY. Everything here is a pure function of
(state, facts-from-one-sentence, today): `apply` moves the state, `settle` resolves
airports and decides what is still missing, `answer` words the next question. Parsing the
sentence into facts is the assistant's job (it owns the language); deciding what the
facts MEAN for the search is this module's. A model can supply the facts instead of the
rules — see travel_ai_assistant — and the same transitions apply, which is what keeps a
model from being able to put the state somewhere the rules could not.

THE RULES (each is a test in backend/tests/test_flight_conversation.py)
  1. Asked for an origin, a short reply is the origin — the destination is kept.
  2. Asked for a destination, a short reply is the destination.
  3. A complete route sets both.
  4. A changed value replaces that value.
  5. Everything else the traveller said is kept.
  6. A NEW search (the sentence itself asks for flights) starts clean — see the assistant.
  7. Airports are resolved against the existing reference (airport_reference), never invented.
  8. Several airports -> the traveller chooses.
  9. Only what is missing is asked for; 10. nothing already supplied is asked again.
"""
from __future__ import annotations

import dataclasses
import re
from dataclasses import dataclass, field

from app.services import airport_reference as airports
from app.services import travel_dates

SLOTS = ("origin", "destination")


@dataclass(frozen=True)
class Issue:
    """Why the last value could not simply be used.

    ambiguous  the name is several airports (London); ask which
    near       the name is a near miss of one or more real ones; ask, never assume
    unknown    no airport answers to the name
    same       origin and destination resolve to the same airport
    past       the day has gone
    which_slot a lone place, with both ends already known: change which?
    """

    kind: str
    slot: str | None = None
    heard: str = ""
    airports: tuple = ()


@dataclass
class Facts:
    """What ONE sentence said, in the vocabulary of the search. All optional."""

    origin: str | None = None            # "from X" / the left of "X to Y"
    destination: str | None = None       # "to Y" / the right of "X to Y"
    place: str | None = None             # a bare place with no preposition ("Delhi")
    set_slot: tuple[str, str] | None = None  # ("origin", "Mumbai") from "change the origin to Mumbai"
    date: str | None = None
    trip: str | None = None
    passengers: int | None = None
    skip_date: bool = False              # "any day", "skip"

    @property
    def empty(self) -> bool:
        return not any((self.origin, self.destination, self.place, self.set_slot, self.date,
                        self.trip, self.passengers, self.skip_date))


@dataclass
class Flight:
    origin: str | None = None
    destination: str | None = None
    origin_code: str | None = None
    destination_code: str | None = None
    date: str | None = None
    trip: str = "oneway"
    passengers: int | None = None
    #: The slot the assistant's last question was about: origin | destination | date.
    awaiting: str | None = None
    #: The day has been asked for once; it is not asked for again.
    date_asked: bool = False
    issue: Issue | None = None
    #: What changed this turn, for the reply ("origin Mumbai").
    changed: list = field(default_factory=list)
    #: The slot filled most recently — so a conflict (the same airport at both ends)
    #: is put to the traveller about the thing they JUST said, not the other end.
    last_set: str | None = None
    #: Party size / trip type changed this turn ("2 travellers"), for the reply.
    extras: list = field(default_factory=list)

    def copy(self) -> "Flight":
        return dataclasses.replace(self, changed=list(self.changed))

    @property
    def route_complete(self) -> bool:
        return bool(self.origin_code and self.destination_code)


@dataclass
class Answer:
    reply: str
    #: Search-card parameters (the existing search_flights action), or None.
    params: dict | None = None
    #: [{"label", "message"}] — a choice's message is a plain reply that fills the slot.
    choices: list = field(default_factory=list)
    suggestions: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# State <-> the context the browser carries (validated again on the way in)
# ---------------------------------------------------------------------------
_CODE = re.compile(r"[A-Z]{3}")
_AWAITING = {"origin", "destination", "date"}


def from_context(ctx: dict | None) -> Flight:
    ctx = ctx or {}

    def code(key):
        v = ctx.get(key)
        return v if isinstance(v, str) and _CODE.fullmatch(v) else None

    awaiting = ctx.get("awaiting")
    return Flight(
        origin=ctx.get("origin"), destination=ctx.get("destination"),
        origin_code=code("origin_code"), destination_code=code("destination_code"),
        date=ctx.get("date"), trip="round" if ctx.get("trip") == "round" else "oneway",
        passengers=ctx.get("passengers") if isinstance(ctx.get("passengers"), int) else None,
        awaiting=awaiting if awaiting in _AWAITING else None,
        date_asked=bool(ctx.get("date_asked")),
    )


def to_context(f: Flight) -> dict:
    out = {"service": "flight", "origin": f.origin, "destination": f.destination,
           "origin_code": f.origin_code, "destination_code": f.destination_code,
           "date": f.date, "trip": f.trip if f.trip == "round" else None,
           "passengers": f.passengers, "awaiting": f.awaiting,
           "date_asked": True if f.date_asked else None}
    return {k: v for k, v in out.items() if v not in (None, "", [])}


# ---------------------------------------------------------------------------
# Transitions
# ---------------------------------------------------------------------------
def _set(f: Flight, slot: str, value: str) -> None:
    setattr(f, slot, value.strip())
    setattr(f, slot + "_code", None)          # re-resolved by settle(); a stale code must not survive
    f.changed.append(f"{slot} {value.strip()}")
    f.last_set = slot


def apply(flight: Flight, facts: Facts) -> Flight:
    """Move the state by one sentence. Never resolves airports; see settle()."""
    f = flight.copy()
    f.changed = []
    f.extras = []
    f.issue = None

    if facts.set_slot:                                   # "change the origin to Mumbai"
        _set(f, *facts.set_slot)
    elif facts.origin and facts.destination:             # a complete route sets BOTH
        _set(f, "origin", facts.origin)
        _set(f, "destination", facts.destination)
    else:
        if facts.origin:
            _set(f, "origin", facts.origin)
        if facts.destination:
            _set(f, "destination", facts.destination)
        if facts.place:
            slot = _slot_for_bare_place(f)
            if slot:
                _set(f, slot, facts.place)
            else:                                        # both ends known: which one?
                f.issue = Issue("which_slot", heard=facts.place)

    if facts.date:
        f.date = facts.date
        f.changed.append(f"date {facts.date}")
    elif facts.skip_date and f.awaiting == "date":
        f.date_asked = True
    if facts.trip and facts.trip != f.trip:
        f.trip = facts.trip
        f.extras.append("round trip" if facts.trip == "round" else "one way")
    if facts.passengers and facts.passengers != f.passengers:
        f.passengers = facts.passengers
        f.extras.append(f"{facts.passengers} traveller" + ("s" if facts.passengers != 1 else ""))
    return f


def _slot_for_bare_place(f: Flight) -> str | None:
    """Which slot a lone place fills. THE QUESTION JUST ASKED DECIDES.

    Only when no question was open is the answer inferred from what is missing, and
    when both ends are known there is nothing to infer from — so it is asked."""
    if f.awaiting in SLOTS:
        return f.awaiting
    if not f.origin and not f.destination:
        return "origin"                       # people name where they are leaving from first
    if not f.origin:
        return "origin"
    if not f.destination:
        return "destination"
    return None


def settle(flight: Flight, today=None) -> Flight:
    """Resolve airports, find the first thing wrong, and work out what is missing."""
    f = flight.copy()
    f.issue = flight.issue

    for slot in SLOTS:
        if f.issue:
            break
        name = getattr(f, slot)
        if not name:
            continue
        lk = airports.lookup(name)
        if lk.status == "found":
            a = lk.airports[0]
            setattr(f, slot, a.city)
            setattr(f, slot + "_code", a.code)
        else:
            kind = {"ambiguous": "ambiguous", "near": "near"}.get(lk.status, "unknown")
            f.issue = Issue(kind, slot, name, lk.airports)
            setattr(f, slot, None)
            setattr(f, slot + "_code", None)

    if not f.issue and f.origin_code and f.origin_code == f.destination_code:
        # Put the question about the end the traveller JUST gave: "Flights to Goa" ->
        # "Goa" is a wrong origin, and asking again for the destination would be asking
        # for something they already told us.
        slot = f.last_set if f.last_set in SLOTS else "destination"
        f.issue = Issue("same", slot, getattr(f, slot) or "")
        setattr(f, slot, None)
        setattr(f, slot + "_code", None)

    if f.date and travel_dates.is_past(f.date, today):
        f.issue = f.issue or Issue("past", "date", f.date)
        f.date = None
        f.date_asked = False                  # it was asked again below, so it is allowed to be

    # What is still missing, in the order a person is asked: where from, where to, when.
    f.awaiting = None
    if f.issue and f.issue.slot in SLOTS:
        f.awaiting = f.issue.slot
    elif f.issue and f.issue.slot == "date":
        f.awaiting = "date"
    elif f.issue and f.issue.kind == "which_slot":
        f.awaiting = None
    elif not f.origin_code:
        f.awaiting = "origin"
    elif not f.destination_code:
        f.awaiting = "destination"
    elif not f.date and not f.date_asked:
        f.awaiting = "date"
        f.date_asked = True                   # asked now, so never asked again
    return f


# ---------------------------------------------------------------------------
# The next thing to say
# ---------------------------------------------------------------------------
def _route(f: Flight) -> str:
    o = f"{f.origin} ({f.origin_code})" if f.origin_code else None
    d = f"{f.destination} ({f.destination_code})" if f.destination_code else None
    return f"{o} to {d}" if o and d else (o or d or "")


def _params(f: Flight) -> dict:
    """The existing search card's parameters — only what is known, so it leaves the rest
    exactly as the traveller set it. Nothing here is a search RESULT: flights are shown by
    the booking card, from the schedule it already has."""
    p: dict = {"trip": f.trip}
    if f.origin:
        p["from"] = f.origin
    if f.destination:
        p["to"] = f.destination
    if f.origin_code:
        p["fromCode"] = f.origin_code
    if f.destination_code:
        p["toCode"] = f.destination_code
    if f.date:
        p["date"] = f.date
    return p


_DAY_CHOICES = [{"label": "Today", "message": "today"}, {"label": "Tomorrow", "message": "tomorrow"},
                {"label": "This weekend", "message": "this saturday"}, {"label": "Any day", "message": "skip"}]


def _airport_choices(lk_airports):
    return [{"label": a.choice_label, "message": a.label} for a in lk_airports]


def acknowledge(before: Flight, after: Flight) -> str:
    """"Got it — flying from Delhi (DEL)." — what this turn changed, said back.

    Said only for what actually CHANGED, so a reply never repeats what the traveller
    already knows, and never claims a change that did not happen."""
    o = after.origin_code and after.origin_code != before.origin_code
    d = after.destination_code and after.destination_code != before.destination_code
    if o and d:
        return f"Got it — {_route(after)}."
    if o:
        return f"Got it — flying from {after.origin} ({after.origin_code})."
    if d:
        return f"Got it — flying to {after.destination} ({after.destination_code})."
    if after.date and after.date != before.date:
        return f"Got it — {travel_dates.speak(after.date)}."
    return ""


def answer(f: Flight, ack: str = "") -> Answer:
    """Word the next step. One question at a time; never one already answered."""
    i = f.issue
    ask = {"origin": "Where will you be flying from?", "destination": "Where would you like to fly to?"}
    if i:
        if i.kind == "ambiguous":
            return Answer(f"There's more than one {i.heard.strip().title()} — which one do you mean?",
                          choices=_airport_choices(i.airports))
        if i.kind == "near":
            one = len(i.airports) == 1
            return Answer(f"Did you mean {i.airports[0].city}?" if one else "Which of these did you mean?",
                          choices=_airport_choices(i.airports))
        if i.kind == "unknown":
            return Answer(f"I couldn't find an airport for “{i.heard}”. Try the city name or its "
                          f"airport code. {ask[i.slot]}")
        if i.kind == "same":
            return Answer(f"That's the same airport as the other end of the trip. {ask[i.slot]}")
        if i.kind == "past":
            return Answer("That day has already gone — which day would you like to fly?",
                          choices=_DAY_CHOICES[:3])
        if i.kind == "which_slot":
            return Answer("Do you want to change where you're flying from, or where you're flying to?",
                          choices=[{"label": f"Fly from {i.heard}", "message": f"change the origin to {i.heard}"},
                                   {"label": f"Fly to {i.heard}", "message": f"change the destination to {i.heard}"}])

    if f.awaiting == "origin":
        if f.destination_code:
            lead = ack or f"Sure — flights to {f.destination} ({f.destination_code})."
            return Answer(f"{lead} {ask['origin']}", params=_params(f))
        return Answer("I can look up flights. Which cities are you flying between?",
                      suggestions=["Hyderabad to Delhi", "Mumbai to Dubai"])
    if f.awaiting == "destination":
        lead = ack or f"Flying from {f.origin} ({f.origin_code})."
        return Answer(f"{lead} Where would you like to go?", params=_params(f))
    if f.awaiting == "date":
        question = f"{ack} What day would you like to fly?" if ack else f"{_route(f)} — what day would you like to fly?"
        return Answer(question, params=_params(f), choices=_DAY_CHOICES)

    when = f" on {travel_dates.speak(f.date)}" if f.date else ""
    tail = "Pick your passengers on the next screen." if f.date else "Pick your date and passengers on the next screen."
    # Say only what is NEW about the party or the trip type — the route and the day are
    # in the sentence already, and a reply that repeats itself reads like a loop.
    noted = f"Got it — {', '.join(f.extras)}. " if f.extras else ""
    return Answer(f"{noted}Searching flights from {_route(f)}{when}. {tail}", params=_params(f))
