"""sms_service.py — a configurable SMS provider adapter (Phase 2 Bug 1).

THE PLATFORM HAS NEVER SENT SMS. This module is the one seam where it could,
shaped exactly like ``email_service._send``: a single ``send()`` that returns a
plain result and NEVER raises, so a caller can record what happened without
wrapping every call site in try/except.

CONFIGURABLE, AND OFF BY DEFAULT.
``settings.sms_provider`` selects the adapter and ``settings.sms_enabled`` is
the master switch. With the switch off — the default, and what every test and
local/dev run uses — :func:`send` is a no-op that reports ``suppressed`` and
touches no network. A deployment turns SMS on deliberately and configures a
real provider; nothing sends a live message by accident, the same guarantee
``lifecycle_emails_enabled`` gives email.

    console  the default. Logs a one-line, NUMBER-MASKED record and sends
             nothing. Lets a developer see that a confirmation *would* have
             gone out, and to whom, without a provider account.
    http     a generic HTTP gateway (``settings.sms_http_*``). The one adapter
             that reaches the network. Credentials come from the environment
             and are NEVER logged.

NEVER LOGS A FULL NUMBER OR A CREDENTIAL. Phone numbers are masked to their
last two digits before they reach a log line, and the api key is only ever put
in a request header, never in a message, a log, or the returned result.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from app.config import settings

logger = logging.getLogger("jackpots.sms")


@dataclass(frozen=True)
class SmsResult:
    """What became of one send attempt. ``ok`` is True only when a provider
    accepted the message. ``suppressed`` means nothing was attempted (SMS off,
    or no recipient) and is NOT a failure — the same distinction
    ``delivery_service`` draws for email. ``detail`` is a short, safe reason
    with no number or credential in it, suitable for a ``error_message`` column
    and for a log."""

    ok: bool
    suppressed: bool = False
    detail: str = ""
    provider: str = ""


def mask_number(number: str | None) -> str:
    """A phone number reduced to something safe to log: the last two digits,
    everything else starred. ``None``/blank becomes ``"(none)"``. Used for every
    log line this module writes so a full number never lands in the logs."""
    digits = "".join(ch for ch in (number or "") if ch.isdigit())
    if not digits:
        return "(none)"
    if len(digits) <= 2:
        return "*" * len(digits)
    return "*" * (len(digits) - 2) + digits[-2:]


# ---------------------------------------------------------------------------
# Adapters
# ---------------------------------------------------------------------------
def _console_send(to: str, body: str) -> SmsResult:
    """Record the intent and send nothing. The default adapter."""
    logger.info(
        "SMS (console) to %s via sender %r: %d chars — not sent (console adapter).",
        mask_number(to), settings.sms_sender_id, len(body),
    )
    return SmsResult(ok=True, detail="console adapter (not sent)", provider="console")


def _http_send(to: str, body: str) -> SmsResult:
    """POST one message to the generic HTTP gateway. The only networked adapter.

    Fails CLOSED and quietly: an unconfigured url, a timeout or a non-2xx is a
    returned ``SmsResult(ok=False)`` with a short safe reason, never an
    exception and never the api key in the result or the log.
    """
    import requests

    if not settings.sms_http_url:
        return SmsResult(ok=False, detail="SMS http provider has no sms_http_url configured.", provider="http")

    payload = {
        settings.sms_http_to_field: to,
        settings.sms_http_body_field: body,
        settings.sms_http_sender_field: settings.sms_sender_id,
    }
    headers = {}
    if settings.sms_http_api_key:
        headers["Authorization"] = f"Bearer {settings.sms_http_api_key}"

    try:
        resp = requests.post(
            settings.sms_http_url, data=payload, headers=headers,
            timeout=settings.sms_http_timeout_seconds,
        )
    except Exception as exc:  # noqa: BLE001 — see docstring; never raise to the caller
        logger.warning("SMS (http) to %s failed to connect: %s", mask_number(to), type(exc).__name__)
        return SmsResult(ok=False, detail=f"connection error: {type(exc).__name__}", provider="http")

    if 200 <= resp.status_code < 300:
        logger.info("SMS (http) to %s accepted (HTTP %d).", mask_number(to), resp.status_code)
        return SmsResult(ok=True, detail=f"accepted (HTTP {resp.status_code})", provider="http")

    logger.warning("SMS (http) to %s refused (HTTP %d).", mask_number(to), resp.status_code)
    return SmsResult(ok=False, detail=f"gateway refused (HTTP {resp.status_code})", provider="http")


#: Adapter registry. A name not here is treated as a misconfiguration and fails
#: closed (recorded failed), rather than silently defaulting to one that sends.
_ADAPTERS = {
    "console": _console_send,
    "http": _http_send,
}


def send(to: str | None, body: str) -> SmsResult:
    """Send one SMS through the configured provider. NEVER raises.

    Returns ``suppressed`` when SMS is switched off or there is no recipient,
    ``ok`` when a provider accepted the message, and a failure with a short safe
    reason otherwise. The body is the caller's final text — this module does no
    templating and stores no copy of it.
    """
    if not settings.sms_enabled:
        return SmsResult(ok=False, suppressed=True, detail="SMS delivery is disabled (sms_enabled is false).",
                         provider=settings.sms_provider)
    if not to or not to.strip():
        return SmsResult(ok=False, suppressed=True, detail="No mobile number on file.", provider=settings.sms_provider)

    adapter = _ADAPTERS.get(settings.sms_provider)
    if adapter is None:
        logger.error("Unknown sms_provider %r; no SMS sent.", settings.sms_provider)
        return SmsResult(ok=False, detail=f"unknown sms_provider {settings.sms_provider!r}",
                         provider=settings.sms_provider)

    try:
        return adapter(to.strip(), body)
    except Exception as exc:  # noqa: BLE001 — defense in depth; an adapter must never break a caller
        logger.exception("SMS adapter %r raised; treating as failed.", settings.sms_provider)
        return SmsResult(ok=False, detail=f"adapter error: {type(exc).__name__}", provider=settings.sms_provider)
