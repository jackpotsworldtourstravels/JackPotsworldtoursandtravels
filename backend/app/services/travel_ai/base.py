"""What a Travel Assistant provider is, and the only thing one may return.

ONE JOB: READ THE SENTENCE. A provider says what was asked for and about
where. It does not write the reply, does not choose the screen, and is never
handed a fare, a room, a booking or a customer — those belong to
``travel_ai_assistant`` and to the search screens themselves. That division is
what makes a model safe to switch on here: the worst a wrong answer can do is
open the wrong search, and the rules would have opened the right one.

EVERYTHING A PROVIDER RETURNS IS CHECKED. ``Understanding`` is a plain
dataclass with no behaviour, and ``travel_ai_assistant`` validates every field
of it against the sentence that was actually said before a single one is used —
an intent outside the list, or a city that does not appear in the traveller's
own words, is dropped and the rules answer instead. A provider is therefore
untrusted input by design, which is the correct way to treat something whose
output is generated.

NEVER RAISES OUTWARD. ``classify`` returns None for "I could not read this" —
no key, no network, a timeout, a malformed answer, a refusal. The caller's
fallback is the built-in reader, which is a complete feature on its own, so a
provider being down is a quality difference and never an outage.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass
class Hints:
    """What the provider is told about this business before it reads.

    NOT A DATABASE CONNECTION — a handful of names, assembled by the caller
    from the public catalogue. It exists so a model knows that "Goa" is a
    destination we sell and "Colombo" is somewhere people fly, and so it can
    resolve a relative day. Nothing private is ever in here.
    """

    #: Destination names from the catalogue, for grounding. Capped by the caller.
    destinations: list[str] = field(default_factory=list)
    #: The countries those destinations sit in.
    countries: list[str] = field(default_factory=list)
    #: The intent names the caller will accept. Anything else is dropped.
    intents: list[str] = field(default_factory=list)
    #: Today, ISO, so "tomorrow" can be resolved to a date.
    today: str = ""
    #: The search in progress, as the small structured state the assistant keeps
    #: (service, origin, destination, date, trip, passengers…) — NOT the chat
    #: history. Sending state instead of transcript is what bounds the cost of a turn
    #: and keeps anything but the travel request out of what leaves the server.
    state: dict = field(default_factory=dict)
    #: The slot the assistant's last question was about ("origin"), if one is open.
    awaiting: str | None = None


@dataclass
class Understanding:
    """One sentence, as a provider read it. Untrusted until validated.

    Every field is optional because a traveller is allowed to say half a
    request: "hotels in Goa" has no origin and no date, and a null is how that
    is reported. A provider that fills a field the sentence did not contain is
    caught by the caller, not here.
    """

    intent: str
    origin: str | None = None
    destination: str | None = None
    #: ISO day, only when the sentence named one.
    date: str | None = None
    passengers: int | None = None
    #: "oneway" or "round".
    trip: str = "oneway"
    #: The provider's own confidence, 0..1. Below the caller's floor, the
    #: rules answer instead.
    confidence: float = 0.0
    #: A landmark, if one was named ("hotels near Charminar"). Matched against
    #: the catalogue by the caller; a name it does not know is dropped.
    attraction: str | None = None


class AIProvider(abc.ABC):
    """The seam. Implementations live beside this file, and nowhere else.

    No caller outside ``services/travel_ai`` names a vendor, imports a vendor
    package or knows a base URL — that is the whole point of the abstraction
    the brief asked for. Adding a provider is a file here plus a name in
    ``get_provider``.
    """

    #: For logs and for the ``provider`` field on an analysis.
    name: str = "base"

    @abc.abstractmethod
    def available(self) -> bool:
        """True when this provider is configured enough to be worth calling."""

    def plan(self, text: str, hints: Hints):
        """Read one message in the context of the conversation state, and answer with ONE
        validated tool call (travel_ai.tools.ModelTurn) — or None, and the rules answer.

        THE CURRENT SEAM. `classify` below is the older, stateless reading of a single
        sentence and is kept so existing callers and tests keep working; the assistant
        uses `plan`. MUST NOT RAISE, for the same reason classify must not."""
        return None

    @abc.abstractmethod
    def classify(self, text: str, hints: Hints) -> Understanding | None:
        """Read one sentence, or return None and let the rules answer.

        MUST NOT RAISE. A provider that lets an exception out takes the
        assistant down with it, which is strictly worse than not having a
        provider at all.
        """
