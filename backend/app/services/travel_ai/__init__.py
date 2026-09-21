"""Which provider reads the traveller's sentence, if any.

ONE SETTING DECIDES: ``TRAVEL_AI_PROVIDER``. 'none' is the default and is not
a degraded mode — it means the built-in reader in ``travel_ai_assistant``
answers, which is the implementation every rule in the brief is written
against and the one the tests assert.

RESOLVED ONCE. The provider object is built on first use and kept, so a
sentence does not pay for reading configuration. It holds no per-traveller
state — only a URL, a model name and a timeout — so one instance serving every
request is correct rather than merely cheap.
"""
from __future__ import annotations

import logging
import threading

from .base import AIProvider, Hints, Understanding

log = logging.getLogger(__name__)

_lock = threading.Lock()
_resolved: tuple[bool, AIProvider | None] = (False, None)


def _build() -> AIProvider | None:
    from app.config import settings

    choice = (settings.travel_ai_provider or "none").strip().lower()
    if choice in {"", "none", "off", "rules"}:
        return None

    # Imported here, not at module import, so a host running the default
    # never loads a provider it will not call.
    from .openai_provider import LocalModelProvider, OpenAIProvider

    if choice == "openai":
        provider: AIProvider = OpenAIProvider(
            api_key=settings.travel_ai_api_key,
            base_url=settings.travel_ai_base_url,
            model=settings.travel_ai_model,
            timeout=settings.travel_ai_timeout_seconds,
        )
    elif choice in {"local", "ollama", "vllm"}:
        provider = LocalModelProvider(
            base_url=settings.travel_ai_base_url,
            model=settings.travel_ai_model,
            timeout=settings.travel_ai_timeout_seconds,
            api_key=settings.travel_ai_api_key,
        )
    else:
        log.warning("TRAVEL_AI_PROVIDER=%r is not a provider; using the built-in reader", choice)
        return None

    if not provider.available():
        # Said out loud at startup rather than silently falling back: a host
        # that meant to switch a model on and mistyped the key would
        # otherwise look identical to one that never tried.
        log.warning("travel_ai provider %r is configured but not usable "
                    "(missing key or base URL); using the built-in reader", choice)
        return None
    return provider


def get_provider() -> AIProvider | None:
    """The configured provider, or None for the built-in reader."""
    global _resolved
    done, provider = _resolved
    if done:
        return provider
    with _lock:
        if not _resolved[0]:
            _resolved = (True, _build())
    return _resolved[1]


def reset_provider() -> None:
    """Forget the resolved provider. For tests and for a settings reload."""
    global _resolved
    with _lock:
        _resolved = (False, None)


__all__ = ["AIProvider", "Hints", "Understanding", "get_provider", "reset_provider"]
