"""OpenAI-compatible classification, and the locally hosted twin of it.

TWO CLASSES, ONE WIRE FORMAT. ``/v1/chat/completions`` with a JSON answer is
what OpenAI, Ollama, vLLM, LM Studio, Together and OpenRouter all speak, so
``LocalModelProvider`` is ``OpenAIProvider`` with a different base URL and no
API key rather than a second implementation of the same HTTP call. A model you
host yourself and a model you rent are a deployment decision, not a code one.

WHAT IT SENDS: the traveller's sentence, the destination names we sell, and
the list of intents it is allowed to answer with. No customer, no booking, no
fare, no token, no session id — there is nothing here to leak, and that is a
property of what this function is given rather than a promise about a prompt.

WHAT IT ACCEPTS BACK: one JSON object. Anything else — prose, a code fence
with something else in it, an HTTP error, a timeout, a refusal — is None, and
the built-in reader answers. The caller checks the contents of a well-formed
answer too; see travel_ai_assistant._trust.

``requests`` AND NOTHING ELSE. No vendor SDK, so turning this on adds no
dependency to the image and no import at startup.
"""
from __future__ import annotations

import json
import logging
import re

import requests

from .base import AIProvider, Hints, Understanding

log = logging.getLogger(__name__)

#: What the model is asked to produce. Deliberately small: every field is
#: something a person said out loud, and there is no field for an answer.
_SYSTEM = (
    "You read one sentence from a traveller on a travel booking website and "
    "report what they asked for. Reply with ONE JSON object and nothing else.\n"
    "Keys: intent, origin, destination, date, passengers, trip, attraction, confidence.\n"
    "  intent       one of: {intents}\n"
    "  origin       the city they are travelling FROM, only for flights, else null\n"
    "  destination  the place the request is about (fly to, stay in, or holiday in), else null\n"
    "  date         ISO yyyy-mm-dd, ONLY if a day was actually said. Today is {today}\n"
    "  passengers   integer, only if counted out loud, else null\n"
    "  trip         'round' if a return was asked for, else 'oneway'\n"
    "  attraction   a named landmark ('Charminar'), else null\n"
    "  confidence   0.0 to 1.0\n"
    "RULES THAT DECIDE THE INTENT:\n"
    "  Two places with a direction between them ('Hyderabad to Colombo') is a flight, "
    "even with no other travel word.\n"
    "  ONE place and no product word ('I want to visit Goa', 'Goa') is a hotel request.\n"
    "  A country or a region ('hotels in Thailand') is a hotel request; put the country in destination.\n"
    "  'package', 'tour', 'holiday' or 'itinerary' makes it a package.\n"
    "  Asking what to SEE — places, attractions, landmarks, sightseeing — is 'places'.\n"
    "  Asking for a person, a refund or a cancellation is 'support'. Asking about a trip they "
    "already booked is 'bookings'.\n"
    "COPY PLACE NAMES OUT OF THE SENTENCE. Never invent one, never expand an abbreviation "
    "into a city that was not said, and never guess a destination that was not named.\n"
    "Places this website sells holidays to: {destinations}.\n"
    "That list is context only — a flight may go anywhere."
)

#: A model that wraps its JSON in a code fence is common enough to handle.
_FENCE = re.compile(r"```(?:json)?\s*(.+?)\s*```", re.S)


class OpenAIProvider(AIProvider):
    """A hosted OpenAI-compatible endpoint."""

    name = "openai"
    #: Whether an API key is required for this provider to be worth calling.
    requires_key = True

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://api.openai.com/v1",
        model: str = "gpt-4o-mini",
        timeout: float = 6.0,
    ) -> None:
        self.api_key = (api_key or "").strip() or None
        self.base_url = (base_url or "").rstrip("/")
        self.model = model
        self.timeout = timeout

    def available(self) -> bool:
        if not self.base_url or not self.model:
            return False
        return bool(self.api_key) or not self.requires_key

    # -- the call ----------------------------------------------------------
    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def classify(self, text: str, hints: Hints) -> Understanding | None:
        if not self.available():
            return None
        system = _SYSTEM.format(
            intents=", ".join(hints.intents),
            today=hints.today,
            destinations=", ".join(hints.destinations[:60]) or "none listed",
        )
        body = {
            "model": self.model,
            # Zero, because this is a classification and the same sentence
            # twice must not route two ways.
            "temperature": 0,
            "max_tokens": 200,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": text},
            ],
        }
        try:
            r = requests.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(), json=body, timeout=self.timeout,
            )
            if r.status_code != 200:
                log.warning("travel_ai %s: HTTP %s", self.name, r.status_code)
                return None
            content = (r.json()["choices"][0]["message"]["content"] or "").strip()
        except Exception as exc:  # network, JSON, shape — all the same answer
            log.warning("travel_ai %s unavailable: %s", self.name, exc)
            return None
        return self._read(content)

    def _read(self, content: str) -> Understanding | None:
        """The model's text -> an Understanding, or None. Never raises."""
        fenced = _FENCE.search(content)
        if fenced:
            content = fenced.group(1)
        try:
            data = json.loads(content)
        except ValueError:
            log.warning("travel_ai %s: answer was not JSON", self.name)
            return None
        if not isinstance(data, dict) or not isinstance(data.get("intent"), str):
            return None

        def word(key: str) -> str | None:
            value = data.get(key)
            if not isinstance(value, str):
                return None
            value = value.strip()
            # A model saying "null" or "none" in a string field means empty,
            # and a 60-character "city" is a sentence, not a place.
            if not value or value.lower() in {"null", "none", "n/a", "-"} or len(value) > 60:
                return None
            return value

        pax = data.get("passengers")
        if not isinstance(pax, int) or isinstance(pax, bool) or not 1 <= pax <= 9:
            pax = None
        try:
            confidence = float(data.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5

        return Understanding(
            intent=data["intent"].strip().lower(),
            origin=word("origin"),
            destination=word("destination"),
            date=word("date"),
            passengers=pax,
            trip="round" if str(data.get("trip", "")).lower().startswith("round") else "oneway",
            confidence=min(max(confidence, 0.0), 1.0),
            attraction=word("attraction"),
        )


class LocalModelProvider(OpenAIProvider):
    """A model you host yourself, speaking the same protocol.

    No key, because a service on your own network does not issue one — which
    is the only thing that differs. Everything else is inherited on purpose:
    if the request shape or the parsing needs fixing, it gets fixed once.
    """

    name = "local"
    requires_key = False

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:11434/v1",
        model: str = "llama3.1",
        timeout: float = 6.0,
        api_key: str | None = None,
    ) -> None:
        super().__init__(api_key=api_key, base_url=base_url, model=model, timeout=timeout)
