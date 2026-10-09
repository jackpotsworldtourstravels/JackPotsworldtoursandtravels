"""The airport reference the Travel Assistant resolves cities and codes against.

    lookup("Goa")        -> found     [GOI Goa]
    lookup("london")     -> ambiguous [LHR London, United Kingdom; YXU London, Canada]
    lookup("Hyderbad")   -> near      [HYD Hyderabad]            (a suggestion, never used silently)
    lookup("Narnia")     -> none

ONE REFERENCE, NOT A THIRD COPY. The booking card's own picker reads two files in
the browser and this module reads the SAME two, so the assistant and the card
cannot disagree about what "Goa" is:

  frontend/assets/js/airports.js           the airports this business SELLS from
  frontend/assets/js/travel-locations.js   the wider reference: every other city,
                                           its airport's name, aliases ("bangalore"),
                                           and the genuinely ambiguous names (two
                                           Hyderabads, two Londons, two Parises)

They are parsed rather than restated, for the reason airports.js gives for its own
design: an airport list in Python and another in JavaScript is two lists, and the day
they disagree the assistant fills a box the card then rejects. Adding an airport stays
a one-file job.

WHICH ANSWER WINS. The table the business sells from comes FIRST, exactly as
JPAirports.resolve in the browser does it, so "Hyderabad" is HYD without asking which
of the world's Hyderabads is meant. Only when the sold table has no opinion and the
wider one has SEVERAL does the traveller get a choice — "London" really is two
different places — and they are shown with their country so they can tell them apart.

A MISSPELLING IS A SUGGESTION. The same similarity measure the place matcher uses
(place_matcher.similarity, with its thresholds, set against the real catalogue) is
applied to city names and aliases; what it finds is offered ("Did you mean…?") and
never filled in.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.services import place_matcher

log = logging.getLogger(__name__)

#: app/services/airport_reference.py -> app -> backend -> the repository (the same
#: walk travel_ai_assistant and app/main.py do to find the frontend).
_JS = Path(__file__).resolve().parents[3] / "frontend" / "assets" / "js"
_SOLD_JS = _JS / "airports.js"
_WIDER_JS = _JS / "travel-locations.js"

#:   HYD: { city: 'Hyderabad', country: 'India', utc: IST },
_SOLD_ROW = re.compile(
    r"^\s*(?P<code>[A-Z]{3})\s*:\s*\{\s*city\s*:\s*'(?P<city>[^']+)'\s*,"
    r"\s*country\s*:\s*'(?P<country>[^']+)'", re.M)
#: A string value of a row, with escaped quotes allowed.
_KV = re.compile(r"(\w+)\s*:\s*'((?:[^'\\]|\\.)*)'")
_ALIASES = re.compile(r"aliases\s*:\s*\[([^\]]*)\]")


@dataclass(frozen=True)
class Airport:
    code: str
    city: str
    country: str
    region: str | None = None
    airport: str | None = None
    #: True for the airports the business sells from (airports.js).
    sold: bool = False
    aliases: tuple[str, ...] = ()

    @property
    def label(self) -> str:
        """'Delhi (DEL)' — what the card writes for a picked airport."""
        return f"{self.city} ({self.code})"

    @property
    def long_label(self) -> str:
        """'London, United Kingdom (LHR)' — enough to tell two Londons apart."""
        return f"{self.city}, {self.country} ({self.code})"

    @property
    def choice_label(self) -> str:
        """'London · Heathrow Airport (LHR)' — a button that says WHICH airport.

        The airport's own name tells two airports of one city apart (Tokyo's
        Haneda and Narita), and where it is unknown the country does."""
        return f"{self.city} · {self.airport or self.country} ({self.code})"

    @property
    def names(self) -> tuple[str, ...]:
        return (self.city, *self.aliases)


@dataclass(frozen=True)
class Lookup:
    #: found | ambiguous | near | none
    status: str
    airports: tuple[Airport, ...] = ()
    heard: str = ""

    @property
    def one(self) -> Airport | None:
        return self.airports[0] if self.status == "found" and self.airports else None


@lru_cache(maxsize=1)
def load() -> tuple[Airport, ...]:
    """Every airport in either table, the business's own first. Read once.

    A missing or unreadable file is an EMPTY reference and a logged warning, never an
    exception: the assistant then passes a city through as spoken, as it always did.
    """
    sold: dict[str, Airport] = {}
    try:
        for m in _SOLD_ROW.finditer(_SOLD_JS.read_text(encoding="utf-8")):
            sold[m["code"]] = Airport(m["code"], m["city"], m["country"], sold=True)
    except OSError as exc:
        log.warning("airport table unreadable (%s)", exc)

    wider: dict[str, Airport] = {}
    try:
        for line in _WIDER_JS.read_text(encoding="utf-8").splitlines():
            if "code:" not in line or "city:" not in line:
                continue
            kv = {k: v.replace("\\'", "'") for k, v in _KV.findall(line)}
            if not re.fullmatch(r"[A-Z]{3}", kv.get("code", "")) or not kv.get("city"):
                continue
            al = _ALIASES.search(line)
            aliases = tuple(a.replace("\\'", "'") for a in re.findall(r"'((?:[^'\\]|\\.)*)'", al.group(1))) if al else ()
            wider[kv["code"]] = Airport(kv["code"], kv["city"], kv.get("country", ""), kv.get("region"),
                                        kv.get("airport"), sold=False, aliases=aliases)
    except OSError as exc:
        log.warning("wider airport reference unreadable (%s)", exc)

    merged: dict[str, Airport] = {}
    for code, w in wider.items():
        s = sold.get(code)
        # The sold table's NAME for a code is the one the card writes ("Delhi",
        # not "New Delhi"); the wider row adds the airport's name and aliases.
        merged[code] = Airport(code, s.city if s else w.city, (s or w).country, w.region, w.airport,
                               sold=bool(s), aliases=tuple(dict.fromkeys(
                                   [*w.aliases, *([w.city.lower()] if s and s.city != w.city else [])])))
    for code, s in sold.items():
        merged.setdefault(code, s)
    return tuple(sorted(merged.values(), key=lambda a: (not a.sold, a.city, a.code)))


def reset_cache() -> None:
    """For tests that point the reference at another file."""
    load.cache_clear()


def _by_code(code: str) -> Airport | None:
    return next((a for a in load() if a.code == code.upper()), None)


def lookup(text: str | None) -> Lookup:
    """A spoken or typed place, resolved to the airport(s) it names."""
    said = (text or "").strip()
    if not said:
        return Lookup("none")

    # "Hyderabad (HYD)" — what a picked airport reads as.
    bracketed = re.search(r"\(([A-Za-z]{3})\)\s*$", said)
    if bracketed and _by_code(bracketed.group(1)):
        return Lookup("found", (_by_code(bracketed.group(1)),), said)

    norm = place_matcher.normalize(said)
    if not norm:
        return Lookup("none", heard=said)
    airports = load()

    # A name is matched exactly, ignoring case, spacing and punctuation.
    exact = [a for a in airports if norm in {place_matcher.normalize(n) for n in a.names}]
    if exact:
        # The business's own airports first; the wider table only when it has none.
        sold = [a for a in exact if a.sold]
        pool = sold or exact
        if len(pool) == 1:
            return Lookup("found", tuple(pool), said)
        return Lookup("ambiguous", tuple(pool), said)

    # A bare three-letter code ("del", "GOI"). After names, because "goa" is a name.
    if re.fullmatch(r"[A-Za-z]{3}", said):
        hit = _by_code(said)
        if hit:
            return Lookup("found", (hit,), said)

    # A near miss: offered, never used. One suggestion per distinct place name.
    scored: list[tuple[float, Airport]] = []
    for a in airports:
        best = max(place_matcher.similarity(said, n) for n in a.names)
        if best >= place_matcher.SUGGEST_AT:
            scored.append((best, a))
    if scored:
        scored.sort(key=lambda t: (-t[0], not t[1].sold, t[1].city))
        top = scored[0][0]
        close = [a for s, a in scored if top - s <= place_matcher.AMBIGUITY_MARGIN]
        # The airports the business sells from win a near miss as they win an
        # exact one: "Hyderbad" is HYD, not also the Hyderabad in Pakistan.
        close = [a for a in close if a.sold] or close
        # Two airports of one city name, or several near names: the traveller picks.
        return Lookup("near", tuple(close[:place_matcher.MAX_CHOICES]), said)
    return Lookup("none", heard=said)
