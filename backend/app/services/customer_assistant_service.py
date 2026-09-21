"""The Travel Assistant's conversation — the session, the turns, and who owns them.

    get_session(...)      the conversation this message belongs to
    process_message(...)  one line in, a stored exchange and an answer out
    history(...)          what was said, to the caller it belongs to
    claim(...)            a guest conversation, kept after signing in

WHAT IT WAS UNDERSTOOD AS IS NOT DECIDED HERE. Intent, entities, the reply and
the screen to open all come from ``services/travel_ai_assistant``, which is
also where an optional model provider plugs in. This module stores what was
said and enforces who may read it back; splitting the two is what keeps the
understanding testable without a database and the ownership rules readable
without the vocabulary.

OWNERSHIP, WHICH IS THE ONLY SECURITY RULE IN THE FEATURE. A conversation is
found by a random `session_key` the first reply hands out. Once it belongs to
an account it is refused to every other caller, signed in or not — so a copied
key stops working the moment its owner signs in, and an unclaimed one holds
nothing but what that same browser typed. No fare, booking or customer record
is read by any function here, so there is nothing else to leak.

THE STORED REPLY IS THE REPLY THAT WAS SENT. Both turns are written in one
transaction with the exact words the traveller saw, never regenerated later
from rules that may since have changed.
"""
from __future__ import annotations

import datetime as dt
import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import (
    Customer,
    CustomerAssistantMessage,
    CustomerAssistantSession,
)
# Re-exported on purpose: the router, the schemas and the verification scripts
# have always imported these from here, and the split is an internal one.
from app.services.travel_ai_assistant import (  # noqa: F401
    Answer,
    Intent,
    Places,
    Reading,
    analyze_message,
    detect_intent,
    execute_action,
    extract_locations,
    generate_response,
    load_places,
    resolve_airport,
)

#: Hard cap on one message. Long enough for a spoken sentence, short enough
#: that nothing here is a place to paste a document into.
MAX_MESSAGE = 500
#: How much history a browser may ask back for.
MAX_HISTORY = 100




# ---------------------------------------------------------------------------
# 3. The conversation
# ---------------------------------------------------------------------------
def _clean(text: str) -> str:
    """Trim, drop control characters, and cap the length.

    Storage is plain text and the browser renders every message with
    textContent, so nothing here is HTML-escaped — escaping on the way IN
    would double-escape the moment it is rendered correctly. Control
    characters go because they are never typed on purpose and make a log
    unreadable.
    """
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", (text or "")).strip()
    return cleaned[:MAX_MESSAGE]


def get_session(
    db: Session, session_key: str | None, customer: Customer | None, kind: str = "assistant",
) -> CustomerAssistantSession:
    """The conversation this message belongs to, creating one if needed.

    A KEY IS ONLY HONOURED WHEN IT IS THE CALLER'S TO USE. A session already
    claimed by a customer is refused to anyone else — including a signed-out
    browser holding the key — so a leaked key cannot be used to read somebody's
    history. Anything unusable simply starts a new conversation rather than
    failing: the traveller is mid-sentence and does not care why.
    """
    session = None
    if session_key:
        session = db.scalar(
            select(CustomerAssistantSession)
            .where(CustomerAssistantSession.session_key == session_key)
        )
        if session is not None:
            owner = session.customer_id
            mine = customer.customer_id if customer else None
            if owner is not None and owner != mine:
                session = None
            elif owner is None and mine is not None:
                # Signed in mid-conversation: the guest session becomes theirs.
                session.customer_id = mine

    if session is None:
        session = CustomerAssistantSession(
            session_key=secrets.token_urlsafe(24),
            customer_id=customer.customer_id if customer else None,
            kind=kind if kind in ("assistant", "voice") else "assistant",
        )
        db.add(session)
        db.flush()

    session.last_active_at = dt.datetime.now(dt.timezone.utc)
    return session


def process_message(
    db: Session,
    *,
    session_key: str | None,
    message: str,
    customer: Customer | None = None,
    kind: str = "assistant",
) -> dict:
    """Take one line from a traveller, store both sides, and answer.

    Both turns are written in ONE transaction with the reply that was actually
    sent, so the stored history is what the traveller saw — not a reply
    regenerated later from rules that may since have changed.
    """
    text = _clean(message)
    session = get_session(db, session_key, customer, kind)

    if not text:
        answer = Answer(
            reply="I did not catch that — could you say it again?",
            intent=Intent.FALLBACK,
        )
        entities = Reading(intent=Intent.FALLBACK, confidence=0.0).entities()
    else:
        # ONE CALL, AND IT IS THE WHOLE UNDERSTANDING: a provider if one is
        # configured, the built-in reader otherwise, then the screen and the
        # words. See services/travel_ai_assistant.
        read = analyze_message(text, load_places(db))
        answer = Answer(
            reply=read["reply"], intent=Intent(read["intent"]),
            action=read["action"], suggestions=read["suggestions"],
        )
        entities = read["entities"]

    db.add(CustomerAssistantMessage(
        session_id=session.customer_assistant_session_id, sender="user", message=text or "",
    ))
    db.add(CustomerAssistantMessage(
        session_id=session.customer_assistant_session_id, sender="assistant",
        message=answer.reply, intent=answer.intent.value,
    ))
    db.commit()

    return {
        "session_id": session.session_key,
        "reply": answer.reply,
        "intent": answer.intent.value,
        "action": answer.action,
        # The reading itself, beside the screen it opened. `action` says WHERE
        # to go and `entities` says WHAT was understood; a browser that wants
        # to fill a field reads the second without having to unpick the first.
        "entities": entities,
        "suggestions": answer.suggestions,
        "timestamp": dt.datetime.now(dt.timezone.utc),
    }


def history(db: Session, session_key: str, customer: Customer | None = None) -> list[dict] | None:
    """Every turn of one conversation, oldest first. ``None`` if not theirs."""
    session = db.scalar(
        select(CustomerAssistantSession)
        .where(CustomerAssistantSession.session_key == session_key)
    )
    if session is None:
        return None
    mine = customer.customer_id if customer else None
    if session.customer_id is not None and session.customer_id != mine:
        return None
    return [
        {"sender": m.sender, "message": m.message, "intent": m.intent, "created_at": m.created_at}
        for m in session.messages[:MAX_HISTORY]
    ]


def claim(db: Session, session_key: str, customer: Customer) -> bool:
    """Attach a guest conversation to the account that has just signed in.

    The merge the brief asks for, and it copies nothing: the rows already
    exist, so this names their owner. A session already owned by someone else
    is left alone and reported as not claimed.
    """
    session = db.scalar(
        select(CustomerAssistantSession)
        .where(CustomerAssistantSession.session_key == session_key)
    )
    if session is None:
        return False
    if session.customer_id is not None:
        return session.customer_id == customer.customer_id
    session.customer_id = customer.customer_id
    db.commit()
    return True
