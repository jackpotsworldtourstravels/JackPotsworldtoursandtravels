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


class AssistantAction(BaseModel):
    """The screen the browser should open, if any."""

    type: str = Field(description="search_flights | search_hotels | hotels_near | search_packages | open_destination | open_support | open_bookings | none")
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


class AssistantMessageResponse(BaseModel):
    session_id: str = Field(description="Send this back with the next message.")
    reply: str
    intent: str
    action: AssistantAction
    entities: AssistantEntities = Field(default_factory=AssistantEntities)
    suggestions: list[str] = []
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
