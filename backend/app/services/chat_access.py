"""Who may use the B2C live-chat console, and what they may do with a conversation.

PHASE 13 (owner decisions D7-D9, C4, C5, C8; findings F-12a, X4, X5). ONE place,
used by the REST routes (``routers/admin_chat.py``), the agent WebSocket
(``chat_gateway.AgentConnection``), auto-assignment (``chat_assignment``) and
call routing (``call_handlers``), so the four doors cannot drift apart.

ELIGIBLE AGENT
An ACTIVE account with role ``admin`` or ``super_admin`` that is either a super
admin or holds ``b2c.chat.manage`` EXPLICITLY (role defaults never grant a
``b2c.*`` scope). Nobody else may hold a ticket, open the socket, be auto-assigned
a chat, be offered a transfer, or be rung for a call.

PER CONVERSATION
* The ASSIGNED agent ("owner") may read and write.
* A SUPER ADMIN may read and write any conversation (supervision, C4/D7). When
  the conversation is not assigned to them, every such read and write is audited.
* Any other eligible agent may only CLAIM an unassigned conversation (existing
  race-safe conditional UPDATE) and, in the queue, sees only the customer's name
  for unassigned rows (C8). Reading or writing someone else's conversation, or
  an unassigned one before claiming it, is refused.

Customers are untouched by all of this: their side is scoped by
``customer_chat_service.get_for_customer`` and the internal-note filters.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.rbac import P
from app.models_v2 import User, UserRole, UserStatus

_ADMIN_ROLES = (UserRole.SUPER_ADMIN, UserRole.ADMIN)

OWNER = "owner"
SUPERVISOR = "supervisor"


class ChatAccessDenied(Exception):
    """Refused. ``write`` says whether it was a write (409) or a read (403)."""

    def __init__(self, message: str, *, write: bool):
        super().__init__(message)
        self.write = write


def is_super(user) -> bool:
    return getattr(user, "role", None) is UserRole.SUPER_ADMIN


def is_eligible(user) -> bool:
    """ACTIVE admin/super admin, and super admin or explicit b2c.chat.manage."""
    if user is None:
        return False
    if getattr(user, "status", UserStatus.ACTIVE) is not UserStatus.ACTIVE:
        return False
    if getattr(user, "role", None) not in _ADMIN_ROLES:
        return False
    return is_super(user) or P.B2C_CHAT_MANAGE in set(getattr(user, "permissions", None) or [])


def eligible_agents(db: Session) -> list[tuple[int, str, bool]]:
    """Every eligible agent as ``(user_id, name, is_super)``.

    Filtered in Python after a role/status SELECT: the permission array is
    JSONB on PostgreSQL and TEXT/JSON in the SQLite tests, and the handful of
    admin rows makes a portable filter cheaper than two dialect-specific ones.
    """
    rows = db.execute(
        select(User).where(User.status == UserStatus.ACTIVE, User.role.in_(_ADMIN_ROLES))
    ).scalars()
    return [
        (u.user_id, u.full_name or f"Admin #{u.user_id}", is_super(u))
        for u in rows if is_eligible(u)
    ]


def access(conversation, user) -> Optional[str]:
    """``OWNER``, ``SUPERVISOR`` (a super admin on a conversation not assigned to
    them), or ``None`` (no read/write access)."""
    if conversation.assigned_admin_id is not None and conversation.assigned_admin_id == user.user_id:
        return OWNER
    if is_super(user):
        return SUPERVISOR
    return None


def require(conversation, user, *, write: bool) -> str:
    """Raise :class:`ChatAccessDenied` unless ``user`` may read (or write) it."""
    level = access(conversation, user)
    if level is not None:
        return level
    if conversation.assigned_admin_id is None:
        raise ChatAccessDenied("Claim this conversation before opening or replying to it.", write=write)
    raise ChatAccessDenied(
        f"This conversation is assigned to {conversation.assigned_admin_name or 'another agent'}.",
        write=write,
    )


def call_ring_list(db: Session, conversation) -> list[int]:
    """Who is rung for a customer's call (owner decision C5).

    * Assigned conversation: the assigned agent IF they are still eligible, plus
      every super admin.
    * Unassigned: every eligible agent (super admins included).
    Presence/busy filtering stays where it was (``call_handlers.request``).
    """
    agents = eligible_agents(db)
    supers = [uid for uid, _name, sup in agents if sup]
    owner = conversation.assigned_admin_id if conversation is not None else None
    if owner is None:
        return [uid for uid, _name, _sup in agents]
    ring = [owner] if any(uid == owner for uid, _n, _s in agents) else []
    return ring + [uid for uid in supers if uid != owner]
