"""Who a new chat goes to, and when it goes to them (CR-9).

THE BRIEF ASKS FOR TWO THINGS
  * "Automatically assign to available Admin"
  * "If only one Admin exists, all chats should automatically be assigned to
    that Admin"

The second is the first with a pool of one, so there is one rule here, not two.

WHY THIS IS ITS OWN MODULE
It is the one place in the chat code that has to look at both database
registries at once — `CustomerConversation` from `models_customer`, `User` from
`models_v2`. `customer_chat_service` deliberately knows nothing about staff
accounts (it is imported by the customer's own request path), and `admin_chat`
is a router, not somewhere the customer's send path should be importing from.
Crossing the B2C/B2B line is fine; doing it in exactly one file, on purpose, is
what keeps it from spreading.

WHEN ASSIGNMENT HAPPENS
On the customer's first message, not when the widget opens the conversation.
Opening Support Center creates a conversation whether or not the customer types
anything, and a queue full of empty conversations assigned to an agent is a
queue that has to be re-triaged by hand every morning.

WAITING vs ACTIVE, AND WHY AN OFFLINE ADMIN STILL GETS THE CHAT
`active` means somebody is on it. If the chosen admin has a live socket, that is
true and the status moves. If nobody is online — 2am, and the footer promises
24/7 — the chat is still assigned, so it appears in that admin's "Only mine" the
moment they sign in, but the status stays `waiting`, because claiming otherwise
would make the queue's own badges lie about how long a customer has been
waiting. Assignment is a routing decision; status is a statement of fact.
"""
from __future__ import annotations

import logging
from typing import Optional, Sequence

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models_customer import CustomerConversation
from app.services import customer_chat_service as chat
from app.services.chat_broker import get_broker

logger = logging.getLogger("app.chat")

#: Statuses that still occupy an agent. `resolved` does not: it is settled work
#: the customer can still reply into, and counting it as load would make an
#: agent who closes chats well look busier than one who lets them rot.
_OPEN_STATUSES = ("waiting", "active")


def candidates(db: Session) -> list[tuple[int, str]]:
    """Every admin a chat may be routed to, least loaded first.

    Load is counted as open conversations already assigned, so the pool
    self-levels without anything storing a round-robin cursor — a cursor in a
    table would need locking under two workers, and a cursor in memory would
    give each worker its own idea of whose turn it is.

    The role filter reuses `_ADMIN_ROLES`, the same tuple `get_current_admin`
    gates on, for the reason the `/agents` endpoint gives: the set of people a
    chat can be *given* to must not drift from the set allowed to *open* one.
    """
    from app.auth.deps import _ADMIN_ROLES          # noqa: PLC0415 - avoids an import cycle
    from app.models_v2 import User, UserStatus      # noqa: PLC0415

    load = dict(
        db.execute(
            select(CustomerConversation.assigned_admin_id, func.count())
            .where(
                CustomerConversation.assigned_admin_id.is_not(None),
                CustomerConversation.status.in_(_OPEN_STATUSES),
            )
            .group_by(CustomerConversation.assigned_admin_id)
        ).all()
    )
    admins = db.execute(
        select(User.user_id, User.full_name)
        .where(User.status == UserStatus.ACTIVE, User.role.in_(_ADMIN_ROLES))
    ).all()
    # user_id breaks ties deterministically: two workers assigning two chats in
    # the same second must not both decide the same idle admin is "the" answer
    # by accident of row order, and the conditional UPDATE below is what makes
    # the collision harmless when they do.
    return sorted(
        ((uid, name or f"Admin #{uid}") for uid, name in admins),
        key=lambda row: (load.get(row[0], 0), row[0]),
    )


async def online_ids(ids: Sequence[int]) -> set[int]:
    """Which of these admins currently hold a socket.

    One `is_online` per admin rather than a scan: the pool is a handful of
    people, and `SCAN chat:presence:*` on a shared Redis is a cost paid by
    everything else on that instance.
    """
    broker = get_broker()
    found: set[int] = set()
    for admin_id in ids:
        try:
            if await broker.is_online(f"admin:{admin_id}"):
                found.add(admin_id)
        except Exception:  # noqa: BLE001 - presence is a hint, never a blocker
            logger.warning("chat: presence lookup failed for admin %s", admin_id)
            return set()
    return found


async def auto_assign(
    db: Session, conversation: CustomerConversation,
) -> Optional[tuple[int, str]]:
    """Route an unassigned conversation. Returns (admin_id, name), or None.

    None covers three ordinary cases and is not an error in any of them: the
    conversation already has an owner, there are no admins configured, or
    another worker won the same race a millisecond earlier.

    THE WRITE IS THE SAME CONDITIONAL UPDATE `claim()` USES — `WHERE
    assigned_admin_id IS NULL`. Auto-assignment and an agent pressing Accept can
    happen in the same instant, and the database is the only thing that can
    decide between them. Losing is silent on purpose: the chat has an owner
    either way, which is all this function was asked to achieve.
    """
    if conversation.assigned_admin_id is not None:
        return None

    pool = candidates(db)
    if not pool:
        logger.warning(
            "chat: conversation %s has nobody to assign to — no active admin accounts",
            conversation.conversation_id,
        )
        return None

    live = await online_ids([admin_id for admin_id, _ in pool])
    # Prefer someone who is actually at their desk; fall back to the whole pool
    # rather than leaving the chat unowned overnight.
    preferred = [row for row in pool if row[0] in live] or pool
    admin_id, admin_name = preferred[0]
    is_live = admin_id in live

    values = {"assigned_admin_id": admin_id, "assigned_admin_name": admin_name}
    if is_live and conversation.status == "waiting":
        values["status"] = "active"

    won = db.execute(
        update(CustomerConversation)
        .where(
            CustomerConversation.conversation_id == conversation.conversation_id,
            CustomerConversation.assigned_admin_id.is_(None),
        )
        .values(**values)
    ).rowcount
    db.flush()
    if not won:
        return None

    db.refresh(conversation)
    chat._system_message(  # noqa: SLF001 - same package, one authoring path for system lines
        db, conversation,
        f"Chat assigned to {admin_name}."
        if is_live else
        f"Chat assigned to {admin_name}, who is currently offline.",
    )
    return admin_id, admin_name
