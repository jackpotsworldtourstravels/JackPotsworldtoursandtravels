"""Request and response shapes for the Travel Assistant."""
from __future__ import annotations

import datetime

from pydantic import BaseModel, Field

from app.services.customer_assistant_service import MAX_MESSAGE


class AssistantMessageRequest(BaseModel):
    """One line typed or spoken by a traveller."""

    message: str = Field(
        min_length=1, max_length=MAX_MESSAGE,
        description="What the traveller said. Plain text; markup is never interpreted.",
    )
    session_id: str | None = Field(
        default=None, max_length=64,
        description=(
            "The conversation to continue — the `session_id` a previous reply returned. "
            "Omit it to start one. A guest's browser holds this; it is not an account id."
        ),
    )
    kind: str | None = Field(
        default="assistant",
        description="'assistant' for the typed panel, 'voice' for the spoken one.",
    )
    context: dict | None = Field(
        default=None,
        description=(
            "The `context` the previous reply returned, sent back unchanged so a follow-up "
            "(\"only family packages\", \"for four people\") applies to the search it follows. "
            "The server holds nothing between messages; this is untrusted input, validated "
            "against a fixed set of keys and bounds, and omitting it simply starts fresh."
        ),
    )


class AssistantAction(BaseModel):
    """The screen the browser should open, if any."""

    type: str = Field(description=("search_flights | search_hotels | hotels_near | show_packages | show_places | "
                                   "show_destination | show_destinations | search_packages | open_destination | "
                                   "open_support | open_bookings | none"))
    params: dict = Field(
        default_factory=dict,
        description=(
            "Only what the traveller actually said, so a screen leaves every other field "
            "as they left it. A flight carries `from`/`to` as spoken, `trip`, `date` when "
            "one was named, and `fromCode`/`toCode` when the airport table recognises the "
            "city — the same table the booking card's picker reads. A hotel carries `dest` "
            "and `checkIn`; a package `dest`."
        ),
    )


class AssistantEntities(BaseModel):
    """What the sentence was understood to be ABOUT.

    Separate from `action.params`, which carries only what that particular
    screen needs. These are the reading itself, so a browser can fill a field
    without unpicking a navigation — and every one of them is null when the
    traveller did not say it, which is different from saying it is empty.
    """

    origin: str | None = Field(
        default=None, description="Where they are flying FROM. Flights only.")
    destination: str | None = Field(
        default=None,
        description="Where the request is about — to fly to, stay in, or holiday in.")
    date: str | None = Field(
        default=None, description="ISO day, only when the sentence named one we can be sure of.")
    passengers: int | None = Field(
        default=None,
        description=(
            "Party size, only when it was counted out loud. REPORTED, NOT APPLIED — "
            "the booking card keeps whatever the traveller set."
        ),
    )
    trip: str | None = Field(
        default="oneway", description="'oneway' unless a return was clearly asked for.")
    days: int | None = Field(
        default=None,
        description="Trip length in DAYS (the packages API's unit); nights are converted.")
    month: str | None = Field(
        default=None, description="'YYYY-MM', only when a month, weekend or day was named.")
    preference: str | None = Field(
        default=None,
        description="A style asked for — family, honeymoon, beach… Not an API filter; see the browser.")
    package_type: str | None = Field(
        default=None, description="'domestic', 'international' or 'pilgrimage', when said.")


class AssistantChoice(BaseModel):
    """A button whose label differs from what it sends."""

    label: str = Field(description="What the button shows — 'Charminar · Hyderabad'.")
    message: str = Field(
        description=(
            "The sentence to send when it is chosen: the traveller's own request with the "
            "stored place name put in, so choosing is exactly the request they made."
        ),
    )


class AssistantMessageResponse(BaseModel):
    session_id: str = Field(description="Send this back with the next message.")
    reply: str
    intent: str
    service_intent: str | None = Field(
        default=None,
        description=(
            "The broad service name for `intent`: flight_search, hotel_search, "
            "tour_package_search, destination_discovery, destination_location_search, "
            "general_travel_question or clarification_required. `intent` keeps its older values."
        ),
    )
    action: AssistantAction
    entities: AssistantEntities = Field(default_factory=AssistantEntities)
    context: dict | None = Field(
        default=None,
        description="The search to remember. Send it back as `context` with the next message.",
    )
    suggestions: list[str] = []
    choices: list[AssistantChoice] = Field(
        default_factory=list,
        description=(
            "Selectable answers, set when a place was misspelt or ambiguous: \"Did you mean "
            "Charminar?\". Nothing has been opened when these are returned. Absent, `suggestions` "
            "are plain sentences whose label is what they send."
        ),
    )
    timestamp: datetime.datetime


class AssistantTurn(BaseModel):
    sender: str = Field(description="'user' or 'assistant'.")
    message: str
    intent: str | None = None
    created_at: datetime.datetime


class AssistantHistoryResponse(BaseModel):
    session_id: str
    messages: list[AssistantTurn] = []


class AssistantClaimRequest(BaseModel):
    session_id: str = Field(max_length=64)


class AssistantClaimResponse(BaseModel):
    claimed: bool = Field(description="False when the conversation belongs to another account.")
