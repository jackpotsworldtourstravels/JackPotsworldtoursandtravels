"""Voice call state, inside a conversation (CR-10).

WHAT THIS MODULE OWNS
The lifecycle of a call: who may start one, who may answer it, what state it is
allowed to move to next, and what gets written down when it ends. It knows
nothing about WebRTC, SDP, ICE or WebSockets — `chat_gateway` relays those and
calls these functions at the moments that change state. The split is the same
one `customer_chat_service` keeps, for the same reason: the REST layer and the
socket layer must not be able to disagree about what a call is.

THE SERVER NEVER TOUCHES MEDIA, AND NEVER PARSES SDP
Signalling is a relay. An offer is an opaque string this process forwards to the
other party of a call it has already decided those two people are on. Audio goes
peer-to-peer, or through TURN, and never through this application — a WebSocket
carrying 8 kB/s of Opus per call would put voice on the same event loop as the
chat queue, and the first busy afternoon would take both down.

THREE RACES, AND WHERE EACH IS DECIDED
As in the chat service, each is settled by the database rather than by a
check-then-act in Python, because production runs two workers and check-then-act
across two processes is not a race anyone wins:

  1. Two tabs press Call at once     -> uq_customer_calls_live (partial unique)
  2. Two agents press Accept at once -> conditional UPDATE ... WHERE status
  3. A late `call_end` after hangup  -> CALL_TRANSITIONS, terminal states empty

WHO MAY ANSWER
The brief says "only assigned admins can answer customer calls". Taken
literally that deadlocks an unassigned conversation — nobody is assigned until
somebody accepts, and auto-assignment only runs on a *message*. So: if the
conversation has an owner, only that owner may answer. If it does not, whoever
answers claims it, exactly as pressing Accept on the chat would. The rule the
brief is protecting — that a random agent cannot listen in on a conversation
somebody else is handling — is preserved either way.
"""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Iterable, Optional, Sequence

from sqlalchemy import desc, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models_customer import (
    LIVE_CALL_STATUSES,
    CustomerCall,
    CustomerConversation,
)

#: How long a call may ring before it is given up on. Long enough for someone to
#: walk back to a desk, short enough that a customer is not left listening to a
#: tone nobody will ever pick up. WhatsApp uses about 45; so does this.
RING_TIMEOUT_SECONDS = 45

#: A safety net for calls whose worker died mid-ring. `expire_stale` sweeps
#: anything still live long past any plausible ring or conversation, so a
#: crashed process cannot leave a conversation permanently "busy" — which,
#: because of the partial unique index, would otherwise block every future call
#: on that conversation forever.
STALE_RING_SECONDS = RING_TIMEOUT_SECONDS * 3
STALE_CALL_SECONDS = 60 * 60 * 4


class CallError(Exception):
    """A well-formed request that cannot be satisfied — 400, not 500."""


class CallNotFound(Exception):
    """No such call, or not this caller's. Deliberately the same for both.

    Distinguishing them tells an attacker which call ids are real, which is the
    probe the public uuid exists to defeat.
    """


class CallBusy(CallError):
    """This conversation already has a call in flight."""


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------------------
# Starting
# ---------------------------------------------------------------------------
def start(
    db: Session,
    conversation: CustomerConversation,
    *,
    direction: str,
    admin_id: Optional[int] = None,
    admin_name: Optional[str] = None,
) -> CustomerCall:
    """Open a call at `calling`. Raises CallBusy if one is already in flight.

    THE BUSY CHECK IS THE INDEX, NOT A SELECT. `uq_customer_calls_live` is
    unique on `conversation_id` filtered to the four live statuses, so the
    second insert is refused by Postgres. A `SELECT ... if none: INSERT` has a
    window between the two statements that both workers pass through, and the
    result is two live calls on one conversation — two rings, two offers, and a
    customer whose second call can never be cleaned up because the first row
    still holds the line.

    `admin_id` is set here only for an admin-initiated call. A customer-initiated
    one leaves it NULL until somebody answers, because until then there is no
    agent on the call — and writing the *assigned* agent's id in advance would
    make an unanswered call look like that agent had taken it.
    """
    if direction not in ("customer_to_admin", "admin_to_customer"):
        raise CallError(f"unknown call direction {direction!r}")
    if conversation.status == "closed":
        raise CallError("This conversation is closed.")

    call = CustomerCall(
        public_id=str(uuid.uuid4()),
        conversation_id=conversation.conversation_id,
        customer_id=conversation.customer_id,
        admin_id=admin_id,
        admin_name=admin_name,
        direction=direction,
        status="calling",
    )
    db.add(call)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = live_for_conversation(db, conversation.conversation_id)
        if existing is None:
            # The index refused the insert but no live call exists. That is not
            # the race — it is a real constraint violation, and swallowing it
            # would turn a schema bug into an unexplained "busy".
            raise
        raise CallBusy("A call is already in progress on this conversation.")
    return call


def live_for_conversation(db: Session, conversation_id: int) -> Optional[CustomerCall]:
    return db.execute(
        select(CustomerCall).where(
            CustomerCall.conversation_id == conversation_id,
            CustomerCall.status.in_(LIVE_CALL_STATUSES),
        ).limit(1)
    ).scalar_one_or_none()


def get_by_public_id(db: Session, public_id: str) -> CustomerCall:
    call = db.execute(
        select(CustomerCall).where(CustomerCall.public_id == str(public_id or ""))
    ).scalar_one_or_none()
    if call is None:
        raise CallNotFound(str(public_id))
    return call


def for_customer(db: Session, public_id: str, customer_id: int) -> CustomerCall:
    """A call, scoped to the customer on it. Raises CallNotFound otherwise."""
    call = get_by_public_id(db, public_id)
    if call.customer_id != customer_id:
        raise CallNotFound(str(public_id))
    return call


# ---------------------------------------------------------------------------
# Moving through the states
# ---------------------------------------------------------------------------
def _transition(call: CustomerCall, status: str) -> None:
    if not call.can_transition_to(status):
        raise CallError(
            f"cannot move a {call.status} call to {status}"
        )
    call.status = status


def mark_ringing(db: Session, call: CustomerCall) -> bool:
    """The callee's device has the invitation on screen.

    Returns False if the call has already moved on — the caller hung up while
    the ring frame was in flight, which is common enough that it is an ordinary
    return rather than an exception.
    """
    if call.status != "calling":
        return False
    call.status = "ringing"
    call.ringing_at = _now()
    db.flush()
    return True


def accept(
    db: Session, call: CustomerCall, *, admin_id: int, admin_name: str,
) -> bool:
    """Answer a customer's call. True if this admin won it.

    A CONDITIONAL UPDATE, not `if call.status == 'ringing'`. Two agents watching
    the same waiting conversation both pass the Python check and both send an
    SDP answer; the customer's browser then has two answers for one offer and
    the call fails in a way that looks like a network fault. Only
    `WHERE status IN (...)` can make one of them lose.

    Returns False when someone else got there first, which the caller should
    surface as "already answered" rather than as an error.
    """
    if not may_answer(call, admin_id=admin_id, db=db):
        raise CallError("This conversation is assigned to another agent.")

    now = _now()
    won = db.execute(
        update(CustomerCall)
        .where(
            CustomerCall.call_id == call.call_id,
            CustomerCall.status.in_(("calling", "ringing")),
        )
        .values(
            status="accepted", answered_at=now,
            admin_id=admin_id, admin_name=admin_name,
        )
    ).rowcount
    db.flush()
    if not won:
        return False
    db.refresh(call)
    return True


def may_answer(call: CustomerCall, *, admin_id: int, db: Session) -> bool:
    """Whether this admin is allowed to answer this call — see module docstring.

    An unassigned conversation may be answered by anyone (and answering claims
    it). An assigned one may only be answered by its owner.
    """
    conversation = db.get(CustomerConversation, call.conversation_id)
    if conversation is None:
        return False
    owner = conversation.assigned_admin_id
    return owner is None or owner == admin_id


def mark_connected(db: Session, call: CustomerCall) -> bool:
    """ICE succeeded and audio is flowing. Idempotent.

    Both browsers report `connected`, so this arrives twice for every call. The
    second one must not move `connected_at`, or the duration shortens by
    whatever the round trip was.
    """
    if call.status == "connected":
        return False
    if call.status != "accepted":
        return False
    call.status = "connected"
    call.connected_at = _now()
    db.flush()
    return True


def finish(
    db: Session,
    call: CustomerCall,
    *,
    status: str,
    ended_by: Optional[str] = None,
    reason: Optional[str] = None,
) -> bool:
    """Put a call into a terminal state and write down what happened.

    Returns False if it was already finished — which is the normal case, not an
    error: both parties send `call_end` when either hangs up, and a client whose
    socket was slow can send one after a timeout has already closed the call.
    Treating the second as a failure would put an error in front of a customer
    for doing exactly the right thing.

    DURATION IS MEASURED FROM `connected_at`, not `answered_at`. The seconds
    spent exchanging SDP and gathering candidates are seconds during which
    nobody could say anything, and counting them makes every call look longer
    than it was — which matters the day these numbers are used to judge how
    long an agent spends on a customer.
    """
    if status not in ("ended", "rejected", "missed", "cancelled", "busy", "failed"):
        raise CallError(f"{status!r} is not a terminal call status")
    if not call.can_transition_to(status):
        return False

    now = _now()
    call.status = status
    call.ended_at = now
    call.ended_by = ended_by
    if reason:
        call.failure_reason = reason[:60]
    # A CALL CAN END WHILE STILL HELD — the agent's socket drops, the ring
    # timer fires, the customer gives up waiting. Closing the open bracket here
    # rather than only in `set_hold` means no hold is ever lost because nobody
    # pressed Resume, which is exactly the call whose hold time someone will
    # want to look at.
    _close_hold(call, now)
    # A transfer offer cannot outlive the call it was made against; leaving one
    # set would make a finished row look transferable to the next reader.
    call.transfer_to_admin_id = None
    if call.connected_at is not None:
        started = call.connected_at
        if started.tzinfo is None:
            started = started.replace(tzinfo=dt.timezone.utc)
        call.duration_seconds = max(0, int((now - started).total_seconds()))
    db.flush()
    return True


def _close_hold(call: CustomerCall, now: dt.datetime) -> int:
    """Bank the hold in progress, if there is one. Returns seconds added."""
    if call.held_since is None:
        return 0
    started = call.held_since
    if started.tzinfo is None:
        started = started.replace(tzinfo=dt.timezone.utc)
    seconds = max(0, int((now - started).total_seconds()))
    call.hold_seconds = (call.hold_seconds or 0) + seconds
    call.held_since = None
    return seconds


def set_hold(db: Session, call: CustomerCall, *, on: bool) -> int:
    """Open or close a hold, and keep the running total.

    THE FLAG IS STILL NOT STORED, and that is not an oversight — see the note
    in `call_handlers.hold()`. What is stored is the arithmetic: `held_since`
    is the open bracket and `hold_seconds` the sum of the closed ones. A reader
    of a finished call sees only the total, which is the part that is still
    true once the sockets are gone.

    Idempotent in both directions: holding a held call and resuming one that is
    not held both do nothing, because both browsers echo the state and a double
    hold that reset `held_since` would silently discard the first stretch.

    Returns the call's total hold seconds so far.
    """
    if on:
        if call.held_since is None:
            call.held_since = _now()
    else:
        _close_hold(call, _now())
    db.flush()
    return call.hold_seconds or 0


def expire_stale(db: Session) -> int:
    """Close calls that a dead worker left live. Returns how many.

    WHY THIS HAS TO EXIST. `uq_customer_calls_live` blocks a new call while an
    old row is still in a live status. If a worker is killed mid-ring, that row
    stays `ringing` forever and the conversation can never place another call —
    a permanent, silent failure produced by the very index that prevents a
    different one. Nothing else in the system would ever clear it.

    Ringing rows are swept aggressively (a ring cannot legitimately outlive its
    timeout by much); connected ones get hours, because a genuinely long support
    call must not be cut off by housekeeping.
    """
    now = _now()
    ring_cutoff = now - dt.timedelta(seconds=STALE_RING_SECONDS)
    call_cutoff = now - dt.timedelta(seconds=STALE_CALL_SECONDS)

    swept = db.execute(
        update(CustomerCall)
        .where(
            CustomerCall.status.in_(("calling", "ringing", "accepted")),
            CustomerCall.created_at < ring_cutoff,
        )
        .values(status="missed", ended_at=now, ended_by="system",
                failure_reason="expired")
    ).rowcount
    swept += db.execute(
        update(CustomerCall)
        .where(
            CustomerCall.status == "connected",
            CustomerCall.created_at < call_cutoff,
        )
        .values(status="failed", ended_at=now, ended_by="system",
                failure_reason="expired")
    ).rowcount
    db.flush()
    return swept


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def history(
    db: Session,
    conversation_id: int,
    *,
    limit: int = 20,
    before_id: Optional[int] = None,
) -> Sequence[CustomerCall]:
    """Recent calls on a conversation, newest first.

    Keyset paging on `call_id`, matching `list_messages`: an OFFSET walks rows
    it then throws away, and does it again on every scroll.
    """
    stmt = select(CustomerCall).where(CustomerCall.conversation_id == conversation_id)
    if before_id is not None:
        stmt = stmt.where(CustomerCall.call_id < before_id)
    return list(
        db.execute(
            stmt.order_by(desc(CustomerCall.call_id)).limit(max(1, min(limit, 100)))
        ).scalars()
    )


def admins_on_a_call(db: Session, admin_ids: Iterable[int]) -> set[int]:
    """Of these agents, the ones already on a live call.

    THE RING IS THE PLACE TO FILTER, not the accept. `accept()` already refuses
    a second call with `call_busy`, but by then the agent's console has been
    ringing over the conversation they are in the middle of — the popup is the
    interruption, and answering it with an error afterwards does not take that
    back. An agent who is talking to somebody is not available, and the
    invitation should never have been addressed to them.

    A live call is `accepted` or `connected`: the same pair `active_for_admin`
    uses, and deliberately NOT `ringing`, because an agent with an unanswered
    invitation on screen is still free to take a different one.
    """
    ids = [a for a in admin_ids]
    if not ids:
        return set()
    return set(
        db.execute(
            select(CustomerCall.admin_id).where(
                CustomerCall.admin_id.in_(ids),
                CustomerCall.status.in_(("accepted", "connected")),
            )
        ).scalars()
    )


def active_for_admin(db: Session, admin_id: int) -> Optional[CustomerCall]:
    """The call this agent is currently on, if any.

    Used to answer `call_busy` before a second ring is ever sent: an agent on a
    call must not have another customer's invitation appear over the top of it.
    """
    return db.execute(
        select(CustomerCall).where(
            CustomerCall.admin_id == admin_id,
            CustomerCall.status.in_(("accepted", "connected")),
        ).limit(1)
    ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Transfer (CR-10 follow-up)
# ---------------------------------------------------------------------------
def begin_transfer(db: Session, call: CustomerCall, *, from_admin_id: int,
                   to_admin_id: int) -> None:
    """Offer a connected call to another agent.

    REFUSED UNLESS THE CALLER IS THE ONE ON THE CALL. Anything else would let
    any admin hand away a conversation they are not part of, which is both a
    permission hole and a very confusing thing to have happen to you mid-
    sentence.

    Offering to yourself is refused too — it looks like a no-op but leaves a
    transfer marker set on a live call, which then blocks the next real one.
    """
    if call.status != "connected":
        raise CallError("Only a connected call can be transferred.")
    if call.admin_id != from_admin_id:
        raise CallError("You are not on this call.")
    if to_admin_id == from_admin_id:
        raise CallError("That call is already yours.")
    call.transfer_to_admin_id = to_admin_id
    db.flush()


def clear_transfer(db: Session, call: CustomerCall) -> None:
    """Forget an offer — declined, timed out, or the call ended under it."""
    call.transfer_to_admin_id = None
    db.flush()


def complete_transfer(db: Session, call: CustomerCall, *, to_admin_id: int,
                      to_admin_name: str) -> bool:
    """Hand the call over. True if this caller won it.

    A CONDITIONAL UPDATE, like `accept`. Two agents can be offered the same
    call in sequence if the first was slow, and the database is the only thing
    that can decide which one actually got it. Losing is not an error — it
    means somebody else is already talking to the customer.
    """
    from_admin_id, from_admin_name = call.admin_id, call.admin_name
    # APPENDED IN PYTHON, NOT IN SQL, and safe to do so: the conditional UPDATE
    # below is what decides the winner, and only the winner's version of this
    # list is written. A loser's UPDATE matches no row and its list is thrown
    # away with the transaction.
    chain = list(call.transfer_chain or [])
    chain.append({
        "from_admin_id": from_admin_id,
        "from_admin_name": from_admin_name,
        "to_admin_id": to_admin_id,
        "to_admin_name": to_admin_name,
        "at": _now().isoformat(),
    })
    result = db.execute(
        update(CustomerCall)
        .where(
            CustomerCall.call_id == call.call_id,
            CustomerCall.transfer_to_admin_id == to_admin_id,
            CustomerCall.status == "connected",
        )
        .values(
            admin_id=to_admin_id,
            admin_name=to_admin_name,
            transferred_from_admin_id=from_admin_id,
            transfer_to_admin_id=None,
            transfer_chain=chain,
        )
    )
    db.flush()
    if result.rowcount == 0:
        return False
    db.refresh(call)
    return True
