"""The conversation's held search, made tamper-evident, session-bound and short-lived.

The assistant keeps no server-side memory between messages: the browser holds the
`context` and hands it back. That is simple and scales, but a bare dict from a
browser is just a claim. Sealing it adds three guarantees without a new table:

  * TAMPER-EVIDENT   — an HMAC over the context, so a customer cannot edit the
                       held search into something the assistant never produced.
  * SESSION-BOUND    — the session key is part of what is signed, so a context
                       copied from one customer's conversation is ignored in
                       another's. This is the customer-isolation boundary.
  * EXPIRING         — it carries its issue time and dies after
                       `travel_ai_context_ttl_seconds`; a search from yesterday
                       never leaks into today's.

An unsigned, foreign, expired or altered context is treated as no context: the
conversation starts fresh. That is the safe failure — never an error, never a guess.
The signing key is derived from the app secret and used for nothing else.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time

from app.config import settings

_SIG, _AT = "_sig", "_at"


def _key() -> bytes:
    return hashlib.sha256(b"assistant-context:" + settings.jwt_secret_key.encode()).digest()


def _mac(body: dict, session_key: str, issued: int) -> str:
    blob = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hmac.new(_key(), f"{session_key}|{issued}|{blob}".encode(), hashlib.sha256).hexdigest()[:40]


def seal(context: dict | None, session_key: str, now: float | None = None) -> dict | None:
    """The context with its issue time and signature, or None when there is none."""
    if not context:
        return None
    body = {k: v for k, v in context.items() if k not in (_SIG, _AT)}
    issued = int(now if now is not None else time.time())
    return {**body, _AT: issued, _SIG: _mac(body, session_key, issued)}


def open_(context, session_key: str, now: float | None = None) -> dict:
    """The context's contents if it is genuine, for THIS session and fresh; else {}."""
    if not isinstance(context, dict):
        return {}
    sig, issued = context.get(_SIG), context.get(_AT)
    if not isinstance(sig, str) or isinstance(issued, bool) or not isinstance(issued, int):
        return {}
    age = (now if now is not None else time.time()) - issued
    if age < 0 or age > settings.travel_ai_context_ttl_seconds:
        return {}
    body = {k: v for k, v in context.items() if k not in (_SIG, _AT)}
    if not hmac.compare_digest(sig, _mac(body, session_key, issued)):
        return {}
    return body
