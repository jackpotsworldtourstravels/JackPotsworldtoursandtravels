"""Live chat between a customer and support (CR-9, migration 0064).

Every query is scoped by `customer_id` from the authenticated caller — never
from a path or body parameter — for the reason `customer_account_service` gives:
an id in a URL is guessable, so ownership is a filter applied server-side.

WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT
It owns the conversation: creating it, moving it through its statuses, writing
messages, counting unread, and deciding who may see what. It knows nothing about
WebSockets, Redis or HTTP. The gateway (slice 3) calls these functions and then
publishes whatever they return; the REST router (slice 2) calls the same
functions and serialises whatever they return. One set of rules, two transports —
which is the only way the two can be guaranteed to agree.

THREE RACES THIS MODULE IS BUILT AROUND
Each is handled by letting the database decide and catching the loss, never by
a check-then-act in Python. Under two gunicorn workers, check-then-act is not a
theoretical problem: it is a Tuesday.

  1. Two tabs open Support Center at once      -> uq_customer_conversation_live
  2. A reconnecting socket resends a message   -> uq_customer_chat_messages_client_id
  3. Two agents claim the same waiting chat    -> conditional UPDATE ... WHERE
"""
from __future__ import annotations

import datetime as dt
from typing import Iterable, Optional, Sequence

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models_customer import (
    CONVERSATION_TRANSITIONS,
    CustomerChatAttachment,
    CustomerChatMessage,
    CustomerConversation,
)

#: Trimmed into `customer_conversations.last_message`, whose column is 500.
_PREVIEW_LIMIT = 500

#: Bodies longer than this are refused rather than silently truncated: a
#: truncated message is a lie about what the customer said.
MAX_BODY_CHARS = 4000


class ChatError(Exception):
    """A request that is well-formed but cannot be satisfied — 400, not 500."""


class ChatNotFound(Exception):
    """No such conversation, or not this caller's — 404 either way.

    DELIBERATELY THE SAME EXCEPTION FOR BOTH. Distinguishing "does not exist"
    from "exists but is not yours" tells an attacker which conversation ids are
    real, which is exactly the probe the scoping above exists to defeat.
    """


# ---------------------------------------------------------------------------
# Visibility — the single place internal notes are filtered
# ---------------------------------------------------------------------------
def _visible(stmt, *, include_internal: bool):
    """Apply the audience filter to a message SELECT.

    ONE PLACE, called by every read path. An internal note is an agent writing
    about a customer, not to them — "customer is abusive", "approved goodwill
    refund, do not mention" — and the single time this filter is forgotten at a
    call site is the time one is delivered to the person it is about. A helper
    that every reader must pass through makes forgetting it a visible omission
    rather than an invisible one.
    """
    if not include_internal:
        stmt = stmt.where(CustomerChatMessage.is_internal.is_(False))
    return stmt


# ---------------------------------------------------------------------------
# The conversation
# ---------------------------------------------------------------------------
def get_or_create_conversation(db: Session, customer_id: int) -> CustomerConversation:
    """The live conversation for this customer, creating one if none exists.

    THIS NEVER RAISES NOT-FOUND, and that is the product requirement: opening
    Support Center must land in a chat, not on an empty state asking the
    customer to start something.

    The insert may lose to a concurrent one — two tabs, a double-clicked widget.
    `uq_customer_conversation_live` declines the second, and the loser re-reads
    the winner's row rather than surfacing a 500. Catching IntegrityError is the
    only correct shape here: a `SELECT ... if not found: INSERT` has a window
    between the two statements that both callers pass through.
    """
    existing = _live_conversation(db, customer_id)
    if existing is not None:
        return existing

    conversation = CustomerConversation(customer_id=customer_id, status="waiting")
    db.add(conversation)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        contended = _live_conversation(db, customer_id)
        if contended is None:
            # The unique index rejected the insert but no live row exists. That
            # is not the race — it is a real constraint violation, and hiding it
            # would turn a schema bug into an infinite retry.
            raise
        return contended
    return conversation


def _live_conversation(db: Session, customer_id: int) -> Optional[CustomerConversation]:
    return db.execute(
        select(CustomerConversation)
        .where(
            CustomerConversation.customer_id == customer_id,
            CustomerConversation.status != "closed",
        )
        .limit(1)
    ).scalar_one_or_none()


def get_for_customer(db: Session, conversation_id: int, customer_id: int) -> CustomerConversation:
    """One conversation, scoped to its owner. Raises ChatNotFound otherwise."""
    conversation = db.get(CustomerConversation, conversation_id)
    if conversation is None or conversation.customer_id != customer_id:
        raise ChatNotFound(str(conversation_id))
    return conversation


def get_for_admin(db: Session, conversation_id: int) -> CustomerConversation:
    conversation = db.get(CustomerConversation, conversation_id)
    if conversation is None:
        raise ChatNotFound(str(conversation_id))
    return conversation


# ---------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------
def claim(
    db: Session, conversation: CustomerConversation, *, admin_id: int, admin_name: str,
) -> bool:
    """Assign an unassigned conversation to this admin. True if it was won.

    A conditional UPDATE, not a Python `if conversation.assigned_admin_id is
    None`. Two agents pressing Accept on the same waiting chat within the same
    second both pass the Python check and the second silently steals the first
    agent's conversation; only `WHERE assigned_admin_id IS NULL` can make one of
    them lose.

    Returns False when someone else got there first, which the caller should
    surface as "already assigned" rather than as an error.
    """
    result = db.execute(
        update(CustomerConversation)
        .where(
            CustomerConversation.conversation_id == conversation.conversation_id,
            CustomerConversation.assigned_admin_id.is_(None),
        )
        .values(
            assigned_admin_id=admin_id,
            assigned_admin_name=admin_name,
            status="active",
        )
    )
    db.flush()
    if result.rowcount == 0:
        return False
    db.refresh(conversation)
    _system_message(db, conversation, f"Chat assigned to {admin_name}.")
    return True


def transfer(
    db: Session, conversation: CustomerConversation, *, admin_id: int, admin_name: str,
) -> None:
    """Hand an active conversation to another agent.

    Unconditional, unlike `claim`: a transfer is a deliberate act by someone who
    already holds the conversation, so there is no race to lose.
    """
    previous = conversation.assigned_admin_name or "the queue"
    conversation.assigned_admin_id = admin_id
    conversation.assigned_admin_name = admin_name
    if conversation.status == "waiting":
        conversation.status = "active"
    db.flush()
    _system_message(db, conversation, f"Chat transferred from {previous} to {admin_name}.")


def set_status(
    db: Session, conversation: CustomerConversation, status: str, *, actor: str,
) -> None:
    """Move the conversation, refusing edges the machine does not have."""
    if status == conversation.status:
        return
    if not conversation.can_transition_to(status):
        raise ChatError(
            f"cannot move a {conversation.status} conversation to {status}; "
            f"allowed: {CONVERSATION_TRANSITIONS.get(conversation.status, ())}"
        )
    conversation.status = status
    db.flush()
    _system_message(db, conversation, f"Chat {status} by {actor}.")


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------
def post_customer_message(
    db: Session,
    conversation: CustomerConversation,
    *,
    body: Optional[str],
    client_msg_id: Optional[str] = None,
    message_type: str = "text",
) -> tuple[CustomerChatMessage, bool]:
    """Write a customer message. Returns (message, created).

    `created` is False when this was a duplicate of one already stored — the
    caller should still echo it back, because the client is asking precisely
    because it is unsure whether the first attempt landed.

    A REOPEN IS A SIDE EFFECT OF WRITING, NOT A SEPARATE ACTION. If support
    resolved the conversation and the customer types again, it becomes active
    again here. That is the entire behavioural difference from a ticket system,
    and putting it anywhere other than "the customer said something" would
    reintroduce the step this feature exists to remove.
    """
    body = _clean_body(body, required=message_type == "text")

    if client_msg_id:
        existing = db.execute(
            select(CustomerChatMessage).where(
                CustomerChatMessage.conversation_id == conversation.conversation_id,
                CustomerChatMessage.client_msg_id == client_msg_id,
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing, False

    message = CustomerChatMessage(
        conversation_id=conversation.conversation_id,
        sender_type="customer",
        body=body,
        message_type=message_type,
        client_msg_id=client_msg_id,
    )
    db.add(message)
    try:
        db.flush()
    except IntegrityError:
        # Lost the idempotency race to a concurrent retry of the same send.
        db.rollback()
        duplicate = db.execute(
            select(CustomerChatMessage).where(
                CustomerChatMessage.conversation_id == conversation.conversation_id,
                CustomerChatMessage.client_msg_id == client_msg_id,
            )
        ).scalar_one_or_none()
        if duplicate is None:
            raise
        return duplicate, False

    if conversation.status == "resolved":
        conversation.status = "active"
    _touch(db, conversation, message, unread_for="admin")
    return message, True


def post_admin_message(
    db: Session,
    conversation: CustomerConversation,
    *,
    admin_id: int,
    admin_name: str,
    body: Optional[str],
    message_type: str = "text",
    is_internal: bool = False,
) -> CustomerChatMessage:
    """Write an agent message, or an internal note.

    An internal note does NOT touch the customer's unread badge or the
    conversation preview — it is not something the customer is waiting to read,
    and lighting up their widget for it would leak that a note exists.
    """
    body = _clean_body(body, required=message_type == "text")
    message = CustomerChatMessage(
        conversation_id=conversation.conversation_id,
        sender_type="admin",
        sender_admin_id=admin_id,
        sender_name=admin_name,
        body=body,
        message_type=message_type,
        is_internal=is_internal,
    )
    db.add(message)
    db.flush()

    if not is_internal:
        _touch(db, conversation, message, unread_for="customer")
    return message


def _system_message(
    db: Session, conversation: CustomerConversation, body: str,
) -> CustomerChatMessage:
    """An event in the thread's chronology: assigned, transferred, closed.

    Not unread for anybody. "Chat resolved by Priya" is context, and a badge
    demanding attention for it trains people to ignore badges.
    """
    message = CustomerChatMessage(
        conversation_id=conversation.conversation_id,
        sender_type="system",
        body=body,
        message_type="system",
    )
    db.add(message)
    db.flush()
    return message


def soft_delete_message(
    db: Session, message: CustomerChatMessage, *, by_customer_id: Optional[int] = None,
) -> None:
    """Tombstone a message. Never a DELETE.

    The other party may already have read it; removing the row rewrites their
    history so that a conversation they remember no longer matches what they
    are shown. A tombstone is honest about what happened.
    """
    if by_customer_id is not None:
        if message.sender_type != "customer":
            raise ChatError("a customer may only delete their own messages")
        if message.conversation.customer_id != by_customer_id:
            raise ChatNotFound(str(message.message_id))
    if message.deleted_at is None:
        message.deleted_at = dt.datetime.now(dt.timezone.utc)
        db.flush()


def _clean_body(body: Optional[str], *, required: bool) -> Optional[str]:
    """Normalise and bound a message body.

    No HTML escaping here on purpose. The body is stored as the customer typed
    it and escaped where it is *rendered* — escaping on the way in double-escapes
    on the way out and means the stored text is no longer what was said. The
    frontend renders with `textContent` (CR-9 §7.3).
    """
    if body is None:
        if required:
            raise ChatError("a text message needs a body")
        return None
    body = body.strip()
    if not body:
        if required:
            raise ChatError("a text message needs a body")
        return None
    if len(body) > MAX_BODY_CHARS:
        raise ChatError(f"message is too long ({len(body)} > {MAX_BODY_CHARS} characters)")
    return body


def _touch(
    db: Session,
    conversation: CustomerConversation,
    message: CustomerChatMessage,
    *,
    unread_for: str,
) -> None:
    """Update the preview and bump the other side's unread counter.

    The counter is incremented with a SQL expression rather than
    `conversation.admin_unread_count += 1`. Read-modify-write in Python loses
    increments when two workers write to the same conversation at once, and the
    badge then under-counts — which is the failure people notice, because it is
    the one where a message appears to have never arrived.
    """
    preview = (message.body or "")[:_PREVIEW_LIMIT] or None
    column = (
        CustomerConversation.admin_unread_count
        if unread_for == "admin"
        else CustomerConversation.customer_unread_count
    )
    db.execute(
        update(CustomerConversation)
        .where(CustomerConversation.conversation_id == conversation.conversation_id)
        .values(
            last_message=preview,
            last_message_at=message.created_at or func.now(),
            **{column.key: column + 1},
        )
    )
    db.flush()
    db.refresh(conversation)


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def list_messages(
    db: Session,
    conversation: CustomerConversation,
    *,
    include_internal: bool,
    before_id: Optional[int] = None,
    after_id: Optional[int] = None,
    limit: int = 30,
) -> list[CustomerChatMessage]:
    """A page of messages, oldest-first within the page.

    `before_id` pages backwards through history (scroll up). `after_id` is the
    RECONNECT GAP FETCH: a socket that dropped asks for everything since the
    last id it holds. Without that, reconnect looks like it works and silently
    loses every message sent while the connection was down.

    Keyset pagination on `message_id`, not OFFSET: an offset shifts under
    inserts, and this table takes inserts constantly, so page 2 of an OFFSET
    scan would skip or repeat messages as people talk.
    """
    limit = max(1, min(limit, 100))
    stmt = (
        select(CustomerChatMessage)
        .where(CustomerChatMessage.conversation_id == conversation.conversation_id)
        .options(selectinload(CustomerChatMessage.attachments))
    )
    stmt = _visible(stmt, include_internal=include_internal)

    if after_id is not None:
        stmt = stmt.where(CustomerChatMessage.message_id > after_id).order_by(
            CustomerChatMessage.message_id.asc()
        )
        return list(db.execute(stmt.limit(limit)).scalars())

    if before_id is not None:
        stmt = stmt.where(CustomerChatMessage.message_id < before_id)
    rows = list(db.execute(
        stmt.order_by(CustomerChatMessage.message_id.desc()).limit(limit)
    ).scalars())
    rows.reverse()
    return rows


def mark_read(
    db: Session, conversation: CustomerConversation, *, reader: str, up_to_message_id: int,
) -> int:
    """Mark the other party's messages read up to an id. Returns how many.

    Bounded by an id rather than "mark everything read", because a client that
    has rendered up to message 900 should not clear a badge for message 901 that
    arrived while it was rendering.
    """
    if reader not in ("customer", "admin"):
        raise ChatError(f"unknown reader {reader!r}")
    other = "admin" if reader == "customer" else "customer"

    result = db.execute(
        update(CustomerChatMessage)
        .where(
            CustomerChatMessage.conversation_id == conversation.conversation_id,
            CustomerChatMessage.message_id <= up_to_message_id,
            CustomerChatMessage.sender_type == other,
            CustomerChatMessage.read_at.is_(None),
        )
        .values(read_at=dt.datetime.now(dt.timezone.utc))
    )
    counter = (
        "customer_unread_count" if reader == "customer" else "admin_unread_count"
    )
    db.execute(
        update(CustomerConversation)
        .where(CustomerConversation.conversation_id == conversation.conversation_id)
        .values(**{counter: 0})
    )
    db.flush()
    db.refresh(conversation)
    return result.rowcount


def mark_delivered(db: Session, message_ids: Iterable[int]) -> None:
    """Stamp delivery for messages that reached a live socket."""
    ids = list(message_ids)
    if not ids:
        return
    db.execute(
        update(CustomerChatMessage)
        .where(
            CustomerChatMessage.message_id.in_(ids),
            CustomerChatMessage.delivered_at.is_(None),
        )
        .values(delivered_at=dt.datetime.now(dt.timezone.utc))
    )
    db.flush()


# ---------------------------------------------------------------------------
# The admin queue
# ---------------------------------------------------------------------------
def queue(
    db: Session,
    *,
    status: Optional[str] = None,
    assigned_admin_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
) -> Sequence[CustomerConversation]:
    """The agent's work list, most recently active first.

    Ordered by `last_message_at DESC NULLS LAST` so a brand-new conversation
    with no message yet does not sort above one somebody is actively waiting in.
    """
    stmt = select(CustomerConversation)
    if status:
        stmt = stmt.where(CustomerConversation.status == status)
    if assigned_admin_id is not None:
        stmt = stmt.where(CustomerConversation.assigned_admin_id == assigned_admin_id)
    stmt = stmt.order_by(
        CustomerConversation.last_message_at.desc().nullslast(),
        CustomerConversation.conversation_id.desc(),
    )
    return list(db.execute(stmt.limit(max(1, min(limit, 100))).offset(offset)).scalars())


def counts_by_status(db: Session) -> dict[str, int]:
    """Queue badges. One grouped query, not four COUNTs."""
    rows = db.execute(
        select(CustomerConversation.status, func.count())
        .group_by(CustomerConversation.status)
    ).all()
    counts = {status: 0 for status in CONVERSATION_TRANSITIONS}
    counts.update({status: n for status, n in rows})
    return counts
