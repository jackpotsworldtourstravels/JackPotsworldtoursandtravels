"""Partner Assistant request/response bodies.

NOTE WHAT IS ABSENT. There is no balance, booking, fare, passenger or merchant
field anywhere in this module, and there should never be one. This API answers
"what did they ask for?" — the browser answers "what is the figure?" by calling
the endpoints the rest of the portal already uses, under the merchant's own
token. Keeping the two apart is what stops the assistant becoming a second,
less-audited way to read a merchant's money.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class InterpretRequest(BaseModel):
    message: str = Field(min_length=1, max_length=600)
    #: The section id the merchant is looking at (``CL_LOADERS`` in
    #: classic-shell.js). Advisory — it only breaks ties.
    page: str | None = Field(default=None, max_length=40)
    #: The merchant's OWN previous questions, oldest first. The client must not
    #: send anything the portal rendered back — see the module docstring.
    history: list[str] = Field(default_factory=list, max_length=6)


class HelpTopicOut(BaseModel):
    id: str
    title: str
    body: str
    #: Section id for the "Take me there" button, or null.
    screen: str | None = None


class InterpretResponse(BaseModel):
    intent: str
    reference: str | None = None
    status: str | None = None
    passport: str | None = None
    confidence: float
    #: A question to put back to the merchant instead of answering.
    clarify: str | None = None
    #: Populated only for ``portal_help``.
    help: HelpTopicOut | None = None
    #: True when a language model resolved this, false when the built-in
    #: matcher did. Surfaced so the UI never implies more than happened.
    model_backed: bool = False


class AssistantConfig(BaseModel):
    enabled: bool
    provider: str
    model_backed: bool
    #: Set when a provider is configured but unusable — the deployment is
    #: broken, not deliberately plain. Never shown to a merchant.
    degraded: bool = False
    help_topics: list[HelpTopicOut] = Field(default_factory=list)
