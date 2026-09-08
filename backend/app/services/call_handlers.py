"""The call frame handlers, written once for both sides (CR-10).

WHY ONE MODULE RATHER THAN TWO SETS OF METHODS
A call is symmetric. Either party can start one, either can hang up, both send
ICE candidates, and the state machine does not care which of them is which. The
only asymmetries are *who is allowed to answer* and *how the other party is
addressed* — and both are two lines. Writing these handlers once on each
connection class would mean two copies of the transition rules, and the copy
that gets forgotten during the next change is the one that lets a rejected call
be answered.

So `CallSession` holds the four things that differ (who I am, how I am
addressed, how to reach the other side, and how to talk to my own socket) and
every rule is stated once above them.

WHAT NEVER HAPPENS HERE
No SDP is parsed. No candidate is inspected. No audio is touched. `_relay`
forwards an opaque payload after checking one thing: that the sender is a party
to the call they named. That check is the entire security model of the relay,
and it is why the payload does not need to be understood to be safe.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from app.database.session import SessionLocal
from app.models_customer import Customer, CustomerConversation
from app.services import call_signaling as sig
from app.services import customer_call_service as calls
from app.services import customer_chat_service as chat

logger = logging.getLogger("jackpots.chat")

#: Events a call-capable socket accepts. Kept here so both connection classes
#: dispatch from the same list and neither can quietly support one the other
#: does not.
CALL_EVENTS = (
    "call_request", "call_accept", "call_reject", "call_cancel", "call_end",
    "call_connected", "call_failed",
    "offer", "answer", "ice_candidate",
)


class CallSession:
    """Call handling for one socket.

    `kind` is "customer" or "admin". Everything else follows from it.
    """

    def __init__(self, *, kind: str, actor_id: int, actor_name: Optional[str], send, fail):
        self.kind = kind
        self.actor_id = actor_id
        self.actor_name = actor_name or ("Customer" if kind == "customer" else "Support")
        self._send = send
        self._fail = fail
        #: One ring timer per socket. A socket can only be on one call, so a
        #: single slot is enough — and holding it here means it is cancelled
        #: automatically when the socket closes, which is what stops a timer
        #: firing against a call the disconnect already ended.
        self._ring_timer: Optional[asyncio.Task] = None

    # -- plumbing ---------------------------------------------------------
    def close(self) -> None:
        if self._ring_timer:
            self._ring_timer.cancel()
            self._ring_timer = None

    async def _party_check(self, db, call) -> bool:
        """Is this socket a party to this call?

        THE WHOLE SECURITY MODEL OF THE RELAY. Without it, any authenticated
        customer could send an `offer` naming any call id and have it forwarded
        into someone else's conversation. With it, the relay never needs to
        understand what it is forwarding.
        """
        if self.kind == "customer":
            return call.customer_id == self.actor_id
        # An admin is a party once they have answered. Before that they are a
        # candidate, which is enough to accept or reject but not to relay media.
        return call.admin_id == self.actor_id

    def _candidates(self, db, conversation: CustomerConversation) -> list[int]:
        """Which agents should be rung for this conversation.

        An assigned conversation rings its owner alone — the brief's rule, and
        the one that stops a customer's call being answered by an agent who has
        not read a word of their chat. An unassigned one rings every available
        agent, because otherwise a customer whose first contact is a call has
        nobody to reach: auto-assignment runs on a *message*, and there is not
        going to be one.
        """
        if conversation.assigned_admin_id is not None:
            return [conversation.assigned_admin_id]
        from app.services import chat_assignment  # noqa: PLC0415 - import cycle

        return [admin_id for admin_id, _ in chat_assignment.candidates(db)]

    def _customer_name(self, db, call) -> Optional[str]:
        customer = db.get(Customer, call.customer_id)
        return customer.full_name if customer else None

    # -- starting a call ---------------------------------------------------
    async def request(self, data: dict[str, Any], *, conversation_id: int) -> None:
        """Somebody pressed Call."""
        from app.config import settings  # noqa: PLC0415

        if not settings.voice_calls_enabled:
            await self._fail("calls_disabled", "Voice calling is currently unavailable.")
            return

        with SessionLocal() as db:
            # Housekeeping first: a conversation whose previous call was left
            # live by a dead worker can never place another one, because the
            # partial unique index still sees that row. Sweeping here means the
            # fix happens at the moment somebody is actually blocked by it.
            calls.expire_stale(db)

            conversation = (
                chat.get_or_create_conversation(db, self.actor_id)
                if self.kind == "customer"
                else chat.get_for_admin(db, conversation_id)
            )
            if self.kind == "customer" and conversation.conversation_id != conversation_id:
                conversation_id = conversation.conversation_id

            direction = (
                "customer_to_admin" if self.kind == "customer" else "admin_to_customer"
            )
            try:
                call = calls.start(
                    db, conversation, direction=direction,
                    admin_id=self.actor_id if self.kind == "admin" else None,
                    admin_name=self.actor_name if self.kind == "admin" else None,
                )
            except calls.CallBusy:
                await self._send("call_busy", {"conversation_id": conversation_id})
                return
            except calls.CallError as exc:
                await self._fail("call_rejected", str(exc))
                return

            payload = sig.call_payload(call, customer_name=self._customer_name(db, call))
            targets = self._candidates(db, conversation) if self.kind == "customer" else []
            db.commit()
            public_id = call.public_id

        # The caller sees `calling` immediately — before any ring goes out — so
        # the button stops looking unpressed while the fan-out happens.
        await self._send("call_status", payload)

        if self.kind == "customer":
            # FILTERED BY PRESENCE BEFORE RINGING. `ring_agents` counts
            # publishes, and a publish to a channel nobody subscribes to
            # succeeds — so without this the customer hears 45 seconds of
            # ringing whenever every agent happens to be signed out.
            live = await sig.online_agents(targets)
            if not live:
                await self._terminate(public_id, "missed", "system", "no_agent_online")
                return
            await sig.ring_agents(live, payload)
            await self._mark_ringing(public_id)
        else:
            # The brief's "if customer is online". Same reasoning in reverse:
            # an agent calling a customer who closed the tab should be told now,
            # not after the timeout.
            if not await sig.is_online(f"customer:{payload['customer_id']}"):
                await self._terminate(public_id, "missed", "system", "callee_offline")
                return
            await sig.to_customer(conversation_id, "incoming_call", payload)
            await self._mark_ringing(public_id)

        self._arm_ring_timeout(public_id)

    async def _mark_ringing(self, public_id: str) -> None:
        with SessionLocal() as db:
            call = calls.get_by_public_id(db, public_id)
            if not calls.mark_ringing(db, call):
                return
            payload = sig.call_payload(call, customer_name=self._customer_name(db, call))
            db.commit()
        await self._send("call_status", payload)

    def _arm_ring_timeout(self, public_id: str) -> None:
        if self._ring_timer:
            self._ring_timer.cancel()

        async def ring_out():
            try:
                await asyncio.sleep(calls.RING_TIMEOUT_SECONDS)
            except asyncio.CancelledError:
                return
            # Re-read rather than trusting the state this task started with:
            # 45 seconds is long enough for the call to have been answered,
            # rejected and ended again on another worker.
            await self._terminate(public_id, "missed", "system", "ring_timeout")

        self._ring_timer = asyncio.create_task(ring_out())

    # -- answering ---------------------------------------------------------
    async def accept(self, data: dict[str, Any]) -> None:
        if self.kind == "customer":
            await self._customer_accept(data)
            return

        with SessionLocal() as db:
            call = calls.get_by_public_id(db, str(data.get("call_id", "")))
            busy = calls.active_for_admin(db, self.actor_id)
            if busy is not None and busy.call_id != call.call_id:
                await self._send("call_busy", {"call_id": call.public_id})
                return
            try:
                won = calls.accept(
                    db, call, admin_id=self.actor_id, admin_name=self.actor_name,
                )
            except calls.CallError as exc:
                await self._fail("call_rejected", str(exc))
                return
            if not won:
                # Another agent answered in the last few milliseconds. Not an
                # error — the popup just closes.
                await self._send("call_taken", {"call_id": call.public_id})
                return

            conversation = db.get(CustomerConversation, call.conversation_id)
            # Answering an unassigned conversation claims it, exactly as
            # pressing Accept on the chat would. Otherwise the agent is on a
            # call about a thread they are not allowed to reply in.
            if conversation is not None and conversation.assigned_admin_id is None:
                chat.claim(
                    db, conversation, admin_id=self.actor_id, admin_name=self.actor_name,
                )
            payload = sig.call_payload(call, customer_name=self._customer_name(db, call))
            others = self._candidates(db, conversation) if conversation else []
            db.commit()

        self.close()   # our own ring timer, if we were also the caller
        await self._send("call_status", payload)
        await sig.cancel_ring(others, payload)
        # The CUSTOMER is told last and is the one who then sends the offer:
        # the answering side must be listening before the offer is created, or
        # the first frame of the negotiation races the socket that has to
        # receive it.
        await sig.to_customer(payload["conversation_id"], "call_accepted", payload)

    async def _customer_accept(self, data: dict[str, Any]) -> None:
        """The customer answering an admin-initiated call."""
        with SessionLocal() as db:
            call = calls.for_customer(db, str(data.get("call_id", "")), self.actor_id)
            now_accepted = call.status in ("calling", "ringing")
            if now_accepted:
                call.status = "accepted"
                call.answered_at = calls._now()  # noqa: SLF001 - one clock for all of it
                db.flush()
            payload = sig.call_payload(call, customer_name=self._customer_name(db, call))
            db.commit()
        if not now_accepted:
            await self._send("call_taken", {"call_id": payload["call_id"]})
            return
        self.close()
        await self._send("call_status", payload)
        if call_admin := payload.get("admin_id"):
            await sig.to_agent(call_admin, "call_accepted", payload)

    async def reject(self, data: dict[str, Any]) -> None:
        await self._terminate(
            str(data.get("call_id", "")), "rejected", self.kind, None,
        )

    async def cancel(self, data: dict[str, Any]) -> None:
        await self._terminate(
            str(data.get("call_id", "")), "cancelled", self.kind, None,
        )

    async def end(self, data: dict[str, Any]) -> None:
        await self._terminate(str(data.get("call_id", "")), "ended", self.kind, None)

    async def failed(self, data: dict[str, Any]) -> None:
        reason = str(data.get("reason") or "unknown")[:60]
        await self._terminate(str(data.get("call_id", "")), "failed", self.kind, reason)

    async def connected(self, data: dict[str, Any]) -> None:
        """ICE succeeded. Arrives from BOTH browsers; the second is a no-op."""
        with SessionLocal() as db:
            call = calls.get_by_public_id(db, str(data.get("call_id", "")))
            if not await self._party_check(db, call):
                raise calls.CallNotFound(str(data.get("call_id")))
            changed = calls.mark_connected(db, call)
            payload = sig.call_payload(call, customer_name=self._customer_name(db, call))
            db.commit()
        self.close()
        if not changed:
            return
        # BOTH SIDES ARE TOLD, and both read connected_at off the same row.
        # A client that started its timer from its own clock would drift from
        # the other party's by however long the round trip took, and the two
        # would visibly disagree about the length of the call they are on.
        await self._notify_both(payload)

    async def _notify_both(self, payload: dict[str, Any]) -> None:
        await sig.to_customer(payload["conversation_id"], "call_status", payload)
        if payload.get("admin_id"):
            await sig.to_agent(payload["admin_id"], "call_status", payload)

    async def _terminate(
        self, public_id: str, status: str, ended_by: str, reason: Optional[str],
    ) -> None:
        """One exit for every way a call can stop.

        Rejected, cancelled, missed, failed and a normal hangup differ by one
        word in the row and by nothing at all in what has to happen next: write
        the outcome, stop the ring, tell both sides. Five separate paths would
        be five chances to forget the ring.
        """
        with SessionLocal() as db:
            try:
                call = calls.get_by_public_id(db, public_id)
            except calls.CallNotFound:
                return
            if not await self._party_check(db, call) and self.kind == "customer":
                return
            conversation = db.get(CustomerConversation, call.conversation_id)
            candidates = self._candidates(db, conversation) if conversation else []
            changed = calls.finish(
                db, call, status=status, ended_by=ended_by, reason=reason,
            )
            payload = sig.call_payload(call, customer_name=self._customer_name(db, call))
            db.commit()

        self.close()
        if not changed:
            # Already finished. The other party has been told; saying it twice
            # would restart a timer that has stopped.
            return
        await self._notify_both(payload)
        await sig.cancel_ring(candidates, payload)

    # -- the relay ---------------------------------------------------------
    async def relay(self, event: str, data: dict[str, Any]) -> None:
        """Forward an SDP offer/answer or an ICE candidate, unread.

        The payload is passed through exactly as it arrived. The server has no
        business understanding it, and a server that rewrote SDP would be a
        server that could break codec negotiation on a browser it had never
        been tested against.
        """
        with SessionLocal() as db:
            try:
                call = calls.get_by_public_id(db, str(data.get("call_id", "")))
            except calls.CallNotFound:
                await self._fail("no_such_call", "That call is no longer active.")
                return
            if not call.is_live:
                await self._fail("call_over", "That call has ended.")
                return
            if not await self._party_check(db, call):
                # Not a party. Answered with the same message a non-existent
                # call gets, so probing ids tells an attacker nothing.
                await self._fail("no_such_call", "That call is no longer active.")
                return
            admin_id = call.admin_id
            conversation_id = call.conversation_id

        forward = {
            "call_id": data.get("call_id"),
            "conversation_id": conversation_id,
            "from": self.kind,
            # The one field the server does look at is the one it puts there.
            "payload": data.get("payload"),
        }
        if self.kind == "customer":
            if admin_id is None:
                await self._fail("call_over", "Nobody has answered yet.")
                return
            await sig.to_agent(admin_id, event, forward)
        else:
            await sig.to_customer(conversation_id, event, forward)
