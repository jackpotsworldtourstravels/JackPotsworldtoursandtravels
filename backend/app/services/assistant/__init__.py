"""Partner Assistant — provider selection.

Same shape as ``services/passport_ocr`` (CR-8): a provider name in config, a
deterministic default that needs no vendor, and no vendor string anywhere
outside this package. Switching providers is an environment change and a
restart, never a code change.

    ASSISTANT_PROVIDER=none        the built-in matcher (default)
    ASSISTANT_PROVIDER=anthropic   Claude, with the matcher as the fallback

WHY THE FALLBACK IS UNCONDITIONAL
The model classifies; it does not answer. So when it is unavailable the
assistant loses some tolerance for unusual phrasing and keeps every one of its
capabilities — which makes falling back obviously correct, and makes an outage
at the vendor a degradation rather than an incident. Contrast CR-8, where a
missing OCR provider has to disable the feature outright, because there the
provider *is* the capability.
"""
from __future__ import annotations

import logging

from app.config import settings

from . import rules
from .base import (
    HELP_TOPICS,
    AssistantNotConfigured,
    Intent,
    IntentResult,
    StatusFilter,
)

logger = logging.getLogger(__name__)

__all__ = [
    "HELP_TOPICS",
    "AssistantNotConfigured",
    "Intent",
    "IntentResult",
    "StatusFilter",
    "classify",
    "provider_status",
]

_VALID = {"none", "anthropic"}


def _configured() -> str:
    name = (settings.assistant_provider or "none").strip().lower()
    if name not in _VALID:
        # Misconfiguration must be loud but must not take the portal down —
        # the assistant is an aid, not a dependency of any other screen.
        logger.error(
            "ASSISTANT_PROVIDER=%r is not one of %s; using 'none'", name, sorted(_VALID)
        )
        return "none"
    return name


def provider_status() -> dict:
    """What the availability endpoint reports.

    ``degraded`` separates "this deployment does not use a model" from "it is
    supposed to and cannot" — without the distinction a missing key looks
    exactly like a deliberate configuration, which is the trap CR-8 documents.
    """
    name = _configured()
    if name == "none":
        return {"provider": "none", "model_backed": False, "degraded": False}

    try:
        _check_ready(name)
    except AssistantNotConfigured as exc:
        logger.error("assistant: %s is configured but not usable — %s", name, exc)
        return {"provider": name, "model_backed": False, "degraded": True}
    return {"provider": name, "model_backed": True, "degraded": False}


def _check_ready(name: str) -> None:
    if name == "anthropic":
        if not (settings.assistant_api_key or "").strip():
            raise AssistantNotConfigured("ASSISTANT_API_KEY is not set")
        try:
            import anthropic  # noqa: F401
        except ImportError as exc:
            raise AssistantNotConfigured("the 'anthropic' package is not installed") from exc


def classify(
    message: str, page: str | None = None, history: list[str] | None = None
) -> IntentResult:
    """Resolve ``message`` to an intent. Always returns — never raises."""
    name = _configured()

    if name == "anthropic":
        try:
            from . import anthropic_provider

            result = anthropic_provider.classify(
                message, page=page, history=history, settings=settings
            )
            if result is not None:
                return result
        except AssistantNotConfigured as exc:
            logger.error("assistant: falling back to rules — %s", exc)
        except Exception:  # pragma: no cover - belt and braces
            logger.exception("assistant: provider %s failed; falling back to rules", name)

    return rules.classify(message, page=page)
