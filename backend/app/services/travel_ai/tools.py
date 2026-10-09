"""The controlled set of tools a model may choose between — and the one place they are defined.

A MODEL ROUTES; THE BACKEND DECIDES. The model reads a customer's message and the small
conversation state, and answers by calling exactly ONE of the functions below. It cannot
call anything else, has no tool that reads a customer, a booking, a fare or the database,
and has no tool that books or pays — there is nothing here for a prompt injection to
escalate to. Everything it returns is validated here (types, enums, lengths) and then again
by the assistant against the customer's own words and the real catalogue before any of it
is used. A tool call is an INTENT AND ITS ARGUMENTS, never a result: results come from the
site's own services, and the assistant never states one the site did not return.

    tool                        intent it stands for            what it ends up opening
    search_flights              flight_search                   the booking card, seeded (flights are shown by the card)
    search_hotels               hotel_search                    the hotel search / hotels near a place
    search_tour_packages        tour_package_search             GET /packages, drawn in the conversation
    get_destinations            destination_discovery           GET /destinations
    get_destination_locations   destination_location_search     GET /destinations/{id}/attractions | /locations
    get_location_details        destination_location_search     the place's own page and its nearby hotels
    ask_clarification           clarification_required          one question, with choices
    answer_general_question     general_travel_question          an honest "I can't answer that yet", plus what I can do

ONE DEFINITION, TWO USES. Each tool is described once, as data (`_SPECS`); from it come
(1) the strict JSON schema sent to the provider as the function's parameters and
(2) the validator applied to what comes back. Two hand-written copies is how a schema and
its check drift apart, and a check looser than the schema is the dangerous direction.

Strict mode (OpenAI "Structured Outputs" for function calling) requires every property to be
listed as required and every object to forbid extras, with optional values written as a
union with null — which is exactly how the specs below are rendered.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

log = logging.getLogger(__name__)

#: field kinds: ("str", max_len) | ("int", lo, hi) | ("enum", [values])
_PLACE = ("str", 80)
_SPECS: dict[str, tuple[str, dict]] = {
    "search_flights": (
        "Search flights. Use when the customer wants to fly somewhere, or is answering a question "
        "about a flight (where from, where to, which day). Fill ONLY what the latest message says; "
        "leave the rest null — the earlier parts of the search are already in `state`.",
        {"origin": _PLACE, "destination": _PLACE, "date": ("str", 10),
         "trip": ("enum", ["oneway", "round"]), "passengers": ("int", 1, 9)},
    ),
    "search_hotels": (
        "Search hotels or resorts in a place, or near a named landmark or area.",
        {"destination": _PLACE, "location": _PLACE, "check_in": ("str", 10)},
    ),
    "search_tour_packages": (
        "Search holiday / tour packages. Duration, month, style and party size are read from the "
        "customer's words by the backend; only the destination is needed here.",
        {"destination": _PLACE, "days": ("int", 1, 30), "month": ("str", 7),
         "package_type": ("enum", ["domestic", "international", "pilgrimage"]),
         "preference": ("enum", ["family", "honeymoon", "adventure", "beach", "cruise", "heritage", "luxury", "budget"]),
         "travellers": ("int", 1, 9)},
    ),
    "get_destinations": (
        "Show the destinations the website offers, optionally only those in one country. Use for "
        "'show me destinations' and similar browsing requests with no particular place.",
        {"country": _PLACE},
    ),
    "get_destination_locations": (
        "List the places to visit (kind=places) or the areas (kind=areas) inside one destination.",
        {"destination": _PLACE, "kind": ("enum", ["places", "areas"])},
    ),
    "get_location_details": (
        "Show one named place or area (a landmark such as a fort or a neighbourhood), optionally "
        "within a named destination.",
        {"location": _PLACE, "destination": _PLACE},
    ),
    "ask_clarification": (
        "Ask ONE short question because the request cannot be acted on safely: for example a "
        "holiday in a place with no product named (about=service).",
        {"about": ("enum", ["service", "destination", "origin", "date"]), "destination": _PLACE},
    ),
    "answer_general_question": (
        "The customer asked a general travel question (weather, visas, best season) rather than "
        "for a search. The website holds no such data, so no answer is invented.",
        {"topic": ("str", 80)},
    ),
}
TOOL_NAMES = tuple(_SPECS)
#: Required parameters (the rest are optional, i.e. nullable). Everything else may be null.
_REQUIRED = {"get_destination_locations": {"destination"}, "get_location_details": {"location"},
             "ask_clarification": {"about"}, "answer_general_question": {"topic"}}


def _json_type(kind: tuple, nullable: bool) -> dict:
    """One property, in the subset of JSON Schema that strict function calling accepts.

    Length and range limits are deliberately NOT in the schema: strict mode does not
    take every constraint keyword, and a request rejected for a schema keyword would
    switch the model off. They are enforced where they cannot be skipped — in validate(),
    on everything that comes back."""
    base = {"str": "string", "int": "integer", "enum": "string"}[kind[0]]
    out: dict = {"type": [base, "null"] if nullable else base}
    if kind[0] == "enum":
        out["enum"] = list(kind[1]) + ([None] if nullable else [])
    return out


def schema(name: str) -> dict:
    """The STRICT JSON schema for one tool's arguments."""
    _desc, fields = _SPECS[name]
    required = _REQUIRED.get(name, set())
    return {
        "type": "object",
        "properties": {f: _json_type(kind, f not in required) for f, kind in fields.items()},
        "required": list(fields),                       # strict mode: every property is listed
        "additionalProperties": False,
    }


def definitions(style: str = "responses") -> list[dict]:
    """The tool list in the shape the provider's API wants.

    ``responses`` (OpenAI Responses API): flat function objects.
    ``chat``      (Chat Completions and compatible servers): wrapped in {"function": …}."""
    out = []
    for name, (description, _fields) in _SPECS.items():
        params = schema(name)
        if style == "chat":
            out.append({"type": "function", "function": {
                "name": name, "description": description, "parameters": params, "strict": True}})
        else:
            out.append({"type": "function", "name": name, "description": description,
                        "parameters": params, "strict": True})
    return out


@dataclass(frozen=True)
class ModelTurn:
    """One validated tool call. `args` has EVERY field of the tool, None where unsaid."""

    tool: str
    args: dict


def validate(name: str, arguments) -> ModelTurn | None:
    """A model's tool call -> a ModelTurn, or None. Never raises; says only the tool name.

    REJECTED, NOT REPAIRED: an unknown tool, a field that is not part of the tool, a
    value of the wrong type or outside its range, an over-long string, a missing
    required value. A tool call the schema should have prevented is a model (or a
    server) misbehaving, and a repaired guess is exactly what this layer exists to avoid."""
    if name not in _SPECS:
        log.warning("travel_ai: model called an unknown tool %r", str(name)[:40])
        return None
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments or "{}")
        except ValueError:
            log.warning("travel_ai: %s arguments were not JSON", name)
            return None
    if not isinstance(arguments, dict):
        return None
    _desc, fields = _SPECS[name]
    if set(arguments) - set(fields):
        log.warning("travel_ai: %s was given fields it does not have", name)
        return None
    clean: dict = {}
    for field, kind in fields.items():
        value = arguments.get(field)
        if isinstance(value, str):
            value = value.strip() or None
            if value is not None and value.lower() in {"null", "none", "n/a", "unknown", "-"}:
                value = None
        if value is None:
            if field in _REQUIRED.get(name, set()):
                log.warning("travel_ai: %s is missing %s", name, field)
                return None
            clean[field] = None
            continue
        if kind[0] == "str":
            if not isinstance(value, str) or len(value) > kind[1]:
                return None
        elif kind[0] == "int":
            if isinstance(value, bool) or not isinstance(value, int) or not kind[1] <= value <= kind[2]:
                return None
        elif value not in kind[1]:
            return None
        clean[field] = value
    return ModelTurn(name, clean)


# ---------------------------------------------------------------------------
# What leaves the server
# ---------------------------------------------------------------------------
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL = re.compile(r"https?://\S+|www\.\S+", re.I)
_LONG_NUMBER = re.compile(r"(?:\d[ -]?){7,}")


def redact(text: str) -> str:
    """The customer's message with anything that is not a travel request masked.

    A traveller types the odd card number or phone number into a chat box; none of it
    is needed to route a search, and none of it should reach a third party. Seven or
    more digits in a run (cards, phones, passports, booking numbers), e-mail
    addresses and links are replaced; dates, party sizes and prices-in-words are not."""
    out = _URL.sub("[link]", text or "")
    out = _EMAIL.sub("[email]", out)
    # A date such as 2026-10-12 has 8 digits but hyphens at fixed places; protect it.
    out = re.sub(r"(?<!\d)(?!\d{4}-\d{2}-\d{2})((?:\d[ -]?){7,})", "[number]", out)
    return out[:500]
