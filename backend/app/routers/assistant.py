"""Partner Assistant — the merchant's helper in the Classic portal.

TWO ROUTES, AND NEITHER RETURNS BUSINESS DATA

    GET  /api/assistant/config      is it on, and what can it help with
    POST /api/assistant/interpret   what did this sentence ask for

``interpret`` takes the merchant's words and answers with an intent name. The
browser then calls the existing merchant endpoints — ``/api/wallet``,
``/api/requests``, ``/api/enquiries`` and the rest — under the merchant's own
token, and renders the answer from those responses.

PERMISSIONS — NO NEW CODES
There are none to add. This endpoint reads nothing, so there is no capability
to gate: the check is that the caller is a signed-in merchant. What the
assistant can then *show* is decided entirely by the endpoints the browser goes
on to call, which already enforce the role matrix. A merchant whose role cannot
see the wallet gets the same 403 through the assistant as through the menu —
and adding a permission here would be the mistake Phase 9 recorded, a gate that
every role holds and which therefore gates nothing while implying it does.

CROSS-TENANT
Nothing here takes a merchant id, so there is none to tamper with, and no route
reads a merchant row at all. Tenant isolation lives on the data endpoints,
where it belongs.

STAFF
Platform staff get a 400, the same answer ``routers/wallet.py`` gives: the help
text describes the merchant portal, and pointing an admin at instructions for a
portal they are not using is worse than declining.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.auth.deps import get_current_user
from app.auth.rate_limit import limiter
from app.config import settings
from app.models_v2 import User
from app.schemas.assistant import (
    AssistantConfig,
    HelpTopicOut,
    InterpretRequest,
    InterpretResponse,
)
from app.services import assistant

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


def _merchant_only(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.merchant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The Partner Assistant is available to merchant accounts.",
        )
    return current_user


def _topics() -> list[HelpTopicOut]:
    return [
        HelpTopicOut(id=key, title=topic["title"], body=topic["body"], screen=topic.get("screen"))
        for key, topic in assistant.HELP_TOPICS.items()
    ]


@router.get("/config", response_model=AssistantConfig)
def assistant_config(current_user: User = Depends(_merchant_only)) -> AssistantConfig:
    """Whether to draw the launcher, and the help the assistant can give.

    The topic bodies ship here rather than in the bundle so the answers cannot
    drift from the release that serves them, and so a wording fix does not
    need a cache-bust.
    """
    status_ = assistant.provider_status()
    return AssistantConfig(
        enabled=bool(settings.assistant_enabled),
        provider=status_["provider"],
        model_backed=status_["model_backed"],
        degraded=status_["degraded"],
        help_topics=_topics(),
    )


@router.post("/interpret", response_model=InterpretResponse)
@limiter.limit(lambda: f"{settings.assistant_rate_per_minute}/minute")
def interpret(
    request: Request,
    payload: InterpretRequest,
    current_user: User = Depends(_merchant_only),
) -> InterpretResponse:
    """Resolve a merchant's sentence to one intent.

    ``request`` is unused by the body of this function and required by the
    limiter, which reads the client address off it.
    """
    if not settings.assistant_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="The Partner Assistant is not enabled.",
        )

    result = assistant.classify(
        payload.message,
        page=payload.page,
        history=[h for h in payload.history if h and h.strip()],
    )

    help_topic = None
    if result.intent is assistant.Intent.PORTAL_HELP and result.topic:
        topic = assistant.HELP_TOPICS.get(result.topic)
        if topic:
            help_topic = HelpTopicOut(
                id=result.topic,
                title=topic["title"],
                body=topic["body"],
                screen=topic.get("screen"),
            )

    # An understood help request whose topic did not survive validation is
    # reported as not understood, rather than as an answer with nothing in it.
    intent = result.intent
    if intent is assistant.Intent.PORTAL_HELP and help_topic is None:
        intent = assistant.Intent.UNKNOWN

    return InterpretResponse(
        intent=intent.value,
        reference=result.reference,
        status=result.status.value if result.status else None,
        passport=result.passport,
        confidence=result.confidence,
        clarify=result.clarify,
        help=help_topic,
        model_backed=assistant.provider_status()["model_backed"],
    )
