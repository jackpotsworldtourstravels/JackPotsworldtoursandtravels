"""The WebSocket side of live chat (CR-9, slice 3).

TRANSPORT ONLY. Every rule about what a message is, who may see it and what a
status change means lives in `customer_chat_service`. This module reads frames,
calls those functions, and publishes what they return. That separation is why
the REST path from slice 2 and the socket path cannot disagree: they are the
same code with different doors.

THE ENVELOPE
Every frame is `{"event": "...", "data": {...}}` — the names from the CR-9
brief, so swapping the transport for python-socketio later is a change of
plumbing rather than a rewrite of the client.

WHY A MESSAGE IS PUBLISHED AND NOT PUSHED
See chat_broker.py. Short version: two workers, so the socket that must receive
a message is usually not on the process that produced it.

ONE DATABASE SESSION PER FRAME, NOT ONE PER SOCKET.
A socket lives for minutes or hours. Holding a Session open for that long pins a
pooled connection and hands out data that got stale the moment somebody else
committed. Each frame opens a session, does its work, commits and closes — the
same lifecycle a request has.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Optional

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.config import settings
from app.database.session import SessionLocal
from app.schemas.customer_chat import ChatMessageResponse, MAX_BODY_CHARS
from app.services import call_handlers
from app.services import chat_assignment as assignment_service
from app.services import customer_chat_service as chat
from app.services.chat_broker import agent_channel, get_broker

logger = logging.getLogger("jackpots.chat")

#: Closing codes. 4401 rather than 1008 so the client can tell "your ticket was
#: no good" from "the server is unhappy for some other reason" and decide
#: whether re-authenticating is worth trying.
CLOSE_BAD_TICKET = 4401
CLOSE_RATE_LIMITED = 4429


def _envelope(event: str, data: Any) -> str:
    return json.dumps({"event": event, "data": data}, default=str)


class _RateLimiter:
    """A token bucket per socket.

    `slowapi` limits by remote address over HTTP; it never sees a frame on an
    already-open socket. Without this, one connection can write as fast as it
    can serialise, which is a way to fill an agent's queue and the message table
    from a single browser tab.
    """

    def __init__(self, burst: int, window: float):
        self._burst = burst
        self._window = window
        self._hits: list[float] = []

    def allow(self) -> bool:
        now = time.monotonic()
        cutoff = now - self._window
        self._hits = [t for t in self._hits if t > cutoff]
        if len(self._hits) >= self._burst:
            return False
        self._hits.append(now)
        return True


class ChatConnection:
    """One customer's socket, for the life of that socket."""

    #: Set lazily by the `calls` property. Declared here so the attribute
    #: exists before the first frame arrives.
    _calls = None

    def __init__(self, websocket: WebSocket, customer_id: int):
        self.ws = websocket
        self.customer_id = customer_id
        self.conversation_id: Optional[int] = None
        self.limiter = _RateLimiter(
            settings.chat_rate_burst, float(settings.chat_rate_window_seconds),
        )
        self.broker = get_broker()

    # -- helpers ----------------------------------------------------------
    async def send(self, event: str, data: Any) -> None:
        await self.ws.send_text(_envelope(event, data))

    async def fail(self, code: str, message: str) -> None:
        await self.send("error", {"code": code, "message": message})

    @property
    def calls(self) -> "call_handlers.CallSession":
        """Call handling for this socket, built on first use (CR-10).

        Lazy because most sockets never place a call, and a CallSession holds a
        ring-timer slot that would otherwise be created for every chat.
        """
        if self._calls is None:
            self._calls = call_handlers.CallSession(
                kind="customer", actor_id=self.customer_id, actor_name=None,
                send=self.send, fail=self.fail,
            )
        return self._calls

    def _session(self) -> Session:
        return SessionLocal()

    # -- lifecycle --------------------------------------------------------
    async def run(self) -> None:
        """Read frames until the socket closes.

        The subscriber task and the read loop are separate: a socket that is
        only listening must still receive, and a socket that is only sending
        must not block on the channel. `asyncio.gather` with the reader as the
        anchor means the subscriber is cancelled the moment the reader ends.
        """
        with self._session() as db:
            conversation = chat.get_or_create_conversation(db, self.customer_id)
            db.commit()
            self.conversation_id = conversation.conversation_id
            await self.send("joined", {
                "conversation_id": conversation.conversation_id,
                "status": conversation.status,
                "assigned_admin_name": conversation.assigned_admin_name,
            })

        await self.broker.mark_online(f"customer:{self.customer_id}")
        subscription = self.broker.subscribe(self.conversation_id)
        async with subscription as stream:
            pump = asyncio.create_task(self._pump(stream))
            try:
                await self._read_loop()
            finally:
                pump.cancel()
                # A dropped socket during a live call is a hangup, not a pause:
                # cancel the ring timer so it cannot fire against a call this
                # disconnect has effectively ended.
                if self._calls is not None:
                    self._calls.close()
                await self.broker.mark_offline(f"customer:{self.customer_id}")

    async def _pump(self, stream) -> None:
        """Forward everything published on this conversation to this socket."""
        try:
            async for payload in stream:
                # Internal notes are published so agents' sockets get them, and
                # dropped HERE for the customer. The service layer's `_visible`
                # filter cannot help across a broker, so the audience check is
                # repeated at the one place the audience is known.
                if payload.get("internal"):
                    continue
                await self.ws.send_text(json.dumps(payload, default=str))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("chat: pump failed for conversation %s", self.conversation_id)

    async def _read_loop(self) -> None:
        while True:
            try:
                raw = await self.ws.receive_text()
            except WebSocketDisconnect:
                return
            try:
                frame = json.loads(raw)
                event = frame.get("event")
                data = frame.get("data") or {}
            except (ValueError, AttributeError):
                await self.fail("bad_frame", "Expected {\"event\": ..., \"data\": ...}")
                continue

            if event in call_handlers.CALL_EVENTS:
                try:
                    await self._dispatch_call(event, data)
                except Exception:
                    logger.exception("call: customer handler %s failed", event)
                    await self.fail("call_failed", "The call could not be set up.")
                continue

            handler = self._HANDLERS.get(event)
            if handler is None:
                await self.fail("unknown_event", f"No such event: {event}")
                continue
            try:
                await handler(self, data)
            except chat.ChatError as exc:
                await self.fail("rejected", str(exc))
            except Exception:
                logger.exception("chat: handler %s failed", event)
                await self.fail("server_error", "Something went wrong handling that.")

    # -- handlers ---------------------------------------------------------
    async def _on_send_message(self, data: dict) -> None:
        if not self.limiter.allow():
            await self.fail("rate_limited", "You are sending messages too quickly.")
            return
        body = data.get("body")
        if isinstance(body, str) and len(body) > MAX_BODY_CHARS:
            await self.fail("too_long", "That message is too long.")
            return

        with self._session() as db:
            conversation = chat.get_for_customer(db, self.conversation_id, self.customer_id)
            message, created = chat.post_customer_message(
                db, conversation,
                body=body,
                client_msg_id=data.get("client_msg_id"),
            )
            chat.mark_delivered(db, [message.message_id])
            # ROUTE ON THE FIRST MESSAGE, not when the widget opened the
            # conversation: opening Support Center creates one whether or not
            # the customer types, and assigning those fills an agent's list with
            # chats nobody ever sent. `auto_assign` is a no-op once owned, so
            # this costs one already-loaded attribute check per later message.
            assignment = None
            if conversation.assigned_admin_id is None:
                assignment = await assignment_service.auto_assign(db, conversation)
            db.commit()
            payload = ChatMessageResponse.for_customer(message).model_dump(mode="json")
            assigned_status = conversation.status

        # The sender gets an ack keyed to their client_msg_id so an optimistic
        # bubble can be reconciled; everyone on the channel gets the message.
        await self.send("message_ack", {
            "client_msg_id": data.get("client_msg_id"),
            "message_id": payload["message_id"],
            "created": created,
        })
        await self.broker.publish(self.conversation_id, {
            "event": "receive_message", "data": payload,
        })
        if assignment:
            # On the conversation channel, so the customer's own socket can say
            # "Priya is with you" without a refetch and any agent watching the
            # thread sees it change hands. Same envelope the REST path sends.
            await publish_assignment(
                self.conversation_id, assignment[0], assignment[1], assigned_status,
            )

    async def _dispatch_call(self, event: str, data: dict) -> None:
        """Call frames, all of them delegated to the shared handler (CR-10).

        A flat if-chain rather than a dict, because three of the ten need an
        argument the others do not and a table of partials reads worse than the
        chain it replaces.
        """
        from app.services import customer_call_service as call_service  # noqa: PLC0415

        session = self.calls
        try:
            if event == "call_request":
                await session.request(data, conversation_id=self.conversation_id)
            elif event == "call_accept":
                await session.accept(data)
            elif event == "call_reject":
                await session.reject(data)
            elif event == "call_cancel":
                await session.cancel(data)
            elif event == "call_end":
                await session.end(data)
            elif event == "call_connected":
                await session.connected(data)
            elif event == "call_failed":
                await session.failed(data)
            elif event == "call_hold":
                await session.hold(data, on=True)
            elif event == "call_resume":
                await session.hold(data, on=False)
            elif event == "call_transfer":
                await session.transfer(data)
            else:
                await session.relay(event, data)
        except call_service.CallNotFound:
            await self.fail("no_such_call", "That call is no longer active.")
        except call_service.CallError as exc:
            await self.fail("call_rejected", str(exc))

    async def _on_typing(self, data: dict, *, typing: bool) -> None:
        """Typing is published but never stored.

        It is worthless a second later, and a table of keystrokes is a table
        nobody wants to hold about their customers.
        """
        await self.broker.publish(self.conversation_id, {
            "event": "typing",
            "data": {
                "conversation_id": self.conversation_id,
                "actor": "customer",
                "is_typing": typing,
            },
        })

    async def _on_typing_start(self, data: dict) -> None:
        await self._on_typing(data, typing=True)

    async def _on_typing_stop(self, data: dict) -> None:
        await self._on_typing(data, typing=False)

    async def _on_message_read(self, data: dict) -> None:
        up_to = data.get("up_to_message_id")
        if not isinstance(up_to, int):
            await self.fail("bad_frame", "up_to_message_id must be an integer")
            return
        with self._session() as db:
            conversation = chat.get_for_customer(db, self.conversation_id, self.customer_id)
            marked = chat.mark_read(
                db, conversation, reader="customer", up_to_message_id=up_to,
            )
            db.commit()
            unread = conversation.customer_unread_count
        await self.send("read_ack", {"marked": marked, "unread_count": unread})
        await self.broker.publish(self.conversation_id, {
            "event": "read_receipt",
            "data": {
                "conversation_id": self.conversation_id,
                "up_to_message_id": up_to,
                "by": "customer",
            },
        })

    async def _on_ping(self, data: dict) -> None:
        """Heartbeat. Refreshes the presence TTL and proves the socket is alive.

        The client sends it rather than relying on protocol-level pings, because
        an intermediary can keep a TCP connection open long after the tab that
        owns it has gone to sleep.
        """
        await self.broker.mark_online(f"customer:{self.customer_id}")
        await self.send("pong", {"t": int(time.time())})

    _HANDLERS = {
        "send_message": _on_send_message,
        "typing_start": _on_typing_start,
        "typing_stop": _on_typing_stop,
        "message_read": _on_message_read,
        "ping": _on_ping,
    }


def _parse_actor(actor: Optional[str], expected: str) -> Optional[int]:
    """"customer:43" -> 43, but only when `expected` matches.

    THE TYPE IS CHECKED, NOT JUST THE ID. Both `customers` and `users` number
    from 1, so a ticket that only said "7" would let an admin open the socket of
    whichever customer happens to share their id. The actor string is what keeps
    the two namespaces apart.
    """
    if not actor or ":" not in actor:
        return None
    kind, _, raw = actor.partition(":")
    if kind != expected:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


async def serve_customer(websocket: WebSocket, ticket: str) -> None:
    """Accept, authenticate by ticket, then hand over to ChatConnection.

    THE TICKET IS CHECKED BEFORE `accept()`. Refusing with a close code on an
    accepted socket works, but accepting first means an unauthenticated peer has
    already been allocated a connection — and under load, refusing early is the
    difference between rejecting a flood and hosting it.
    """
    broker = get_broker()
    customer_id = _parse_actor(await broker.redeem_ticket(ticket), "customer")
    if customer_id is None:
        await websocket.close(code=CLOSE_BAD_TICKET)
        return

    await websocket.accept()
    connection = ChatConnection(websocket, customer_id)
    try:
        await connection.run()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("chat: socket failed for customer %s", customer_id)
        try:
            await websocket.close(code=1011)
        except RuntimeError:
            pass   # already closed


async def publish_message(conversation_id: int, body) -> None:
    """Broadcast an already-serialised customer message.

    Takes the `ChatMessageResponse`, not the ORM row, because its only caller is
    the REST fallback — which builds that model before it commits, precisely so
    nothing here has to touch an expired instance.
    """
    await get_broker().publish(conversation_id, {
        "event": "receive_message", "data": body.model_dump(mode="json"),
    })


async def publish_assignment(
    conversation_id: int, admin_id: int, admin_name: str, status: str,
) -> None:
    """Tell the conversation it has an owner.

    One envelope shape for a routing decision, whether it was made by
    `auto_assign` on a first message or by an agent pressing Accept.
    """
    await get_broker().publish(conversation_id, {
        "event": "conversation_assigned",
        "data": {
            "conversation_id": conversation_id,
            "assigned_admin_id": admin_id,
            "assigned_admin_name": admin_name,
            "status": status,
        },
    })


async def publish_admin_message(conversation_id: int, message, *, internal: bool) -> None:
    """Called by the admin side (slice 4) after it writes a reply.

    Lives here rather than in the admin router so there is exactly one place
    that knows the envelope shape for an outgoing message.
    """
    broker = get_broker()
    await broker.publish(conversation_id, {
        "event": "receive_message",
        "data": ChatMessageResponse.for_customer(message).model_dump(mode="json"),
        "internal": internal,
    })


# ---------------------------------------------------------------------------
# The agent side (slice 4)
# ---------------------------------------------------------------------------
class AgentConnection:
    """One agent's socket.

    DIFFERENT FROM ChatConnection IN THE ONE WAY THAT MATTERS: an agent moves
    between conversations. A customer has exactly one, opened for them at
    connect and held for the life of the socket. An agent opens a thread,
    answers it, and moves to the next — so this subscribes and unsubscribes per
    `join_chat` / `leave_chat`, holding one pump task per open thread.

    Unsubscribing on leave is not tidiness: an agent who worked forty
    conversations in a shift would otherwise hold forty Redis subscriptions and
    receive every message on all of them for as long as they stayed signed in.

    It also SEES internal notes, which the customer's pump drops.
    """

    _calls = None

    def __init__(self, websocket: WebSocket, admin_id: int, admin_name: str):
        self.ws = websocket
        self.admin_id = admin_id
        self.admin_name = admin_name
        self.broker = get_broker()
        self.limiter = _RateLimiter(
            settings.chat_rate_burst, float(settings.chat_rate_window_seconds),
        )
        self._pumps: dict[int, asyncio.Task] = {}

    async def send(self, event: str, data: Any) -> None:
        await self.ws.send_text(_envelope(event, data))

    async def fail(self, code: str, message: str) -> None:
        await self.send("error", {"code": code, "message": message})

    @property
    def calls(self) -> "call_handlers.CallSession":
        if self._calls is None:
            self._calls = call_handlers.CallSession(
                kind="admin", actor_id=self.admin_id, actor_name=self.admin_name,
                send=self.send, fail=self.fail,
            )
        return self._calls

    async def run(self) -> None:
        await self.broker.mark_online(f"admin:{self.admin_id}")
        # THE AGENT'S OWN CHANNEL, held for the whole session (CR-10).
        #
        # The per-conversation pumps below are joined on demand, which is right
        # for chat and useless for a call: an incoming call is by definition
        # about a conversation the agent is NOT currently reading. Without this
        # subscription a ring would reach an agent only by the coincidence of
        # them already having the right thread open.
        personal = self.broker.subscribe_to(agent_channel(self.admin_id))
        async with personal as stream:
            ring_pump = asyncio.create_task(self._pump_personal(stream))
            try:
                await self._read_loop()
            finally:
                ring_pump.cancel()
                for task in self._pumps.values():
                    task.cancel()
                if self._calls is not None:
                    self._calls.close()
                await self.broker.mark_offline(f"admin:{self.admin_id}")

    async def _pump_personal(self, stream) -> None:
        try:
            async for payload in stream:
                await self.ws.send_text(json.dumps(payload, default=str))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("call: personal pump failed for admin %s", self.admin_id)

    async def _read_loop(self) -> None:
        while True:
            try:
                raw = await self.ws.receive_text()
            except WebSocketDisconnect:
                return
            try:
                frame = json.loads(raw)
                event, data = frame.get("event"), frame.get("data") or {}
            except (ValueError, AttributeError):
                await self.fail("bad_frame", "Expected an {event, data} object")
                continue
            try:
                await self._dispatch(event, data)
            except chat.ChatNotFound:
                await self.fail("not_found", "No such conversation")
            except chat.ChatError as exc:
                await self.fail("rejected", str(exc))
            except Exception:
                logger.exception("chat: agent handler %s failed", event)
                await self.fail("server_error", "Something went wrong handling that.")

    async def _dispatch(self, event: str, data: dict) -> None:
        if event == "join_chat":
            await self._join(int(data.get("conversation_id", 0)))
        elif event == "leave_chat":
            self._leave(int(data.get("conversation_id", 0)))
        elif event == "send_message":
            await self._send_message(data)
        elif event == "typing_start":
            await self._typing(data, True)
        elif event == "typing_stop":
            await self._typing(data, False)
        elif event == "message_read":
            await self._mark_read(data)
        elif event == "ping":
            await self.broker.mark_online(f"admin:{self.admin_id}")
            await self.send("pong", {"t": int(time.time())})
        elif event in call_handlers.CALL_EVENTS:
            await self._dispatch_call(event, data)
        else:
            await self.fail("unknown_event", f"No such event: {event}")

    async def _dispatch_call(self, event: str, data: dict) -> None:
        """The agent half of the call vocabulary. Same handlers as the
        customer half — see call_handlers.CallSession."""
        from app.services import customer_call_service as call_service  # noqa: PLC0415

        session = self.calls
        try:
            if event == "call_request":
                await session.request(
                    data, conversation_id=int(data.get("conversation_id", 0)),
                )
            elif event == "call_accept":
                await session.accept(data)
            elif event == "call_reject":
                await session.reject(data)
            elif event == "call_cancel":
                await session.cancel(data)
            elif event == "call_end":
                await session.end(data)
            elif event == "call_connected":
                await session.connected(data)
            elif event == "call_failed":
                await session.failed(data)
            elif event == "call_hold":
                await session.hold(data, on=True)
            elif event == "call_resume":
                await session.hold(data, on=False)
            elif event == "call_transfer":
                await session.transfer(data)
            else:
                await session.relay(event, data)
        except call_service.CallNotFound:
            await self.fail("no_such_call", "That call is no longer active.")
        except call_service.CallError as exc:
            await self.fail("call_rejected", str(exc))

    async def _join(self, conversation_id: int) -> None:
        if conversation_id in self._pumps:
            return
        with SessionLocal() as db:
            chat.get_for_admin(db, conversation_id)      # raises if it is not real
        subscription = self.broker.subscribe(conversation_id)

        async def pump():
            async with subscription as stream:
                async for payload in stream:
                    await self.ws.send_text(json.dumps(payload, default=str))

        self._pumps[conversation_id] = asyncio.create_task(pump())
        await self.send("joined", {"conversation_id": conversation_id})

    def _leave(self, conversation_id: int) -> None:
        task = self._pumps.pop(conversation_id, None)
        if task:
            task.cancel()

    async def _send_message(self, data: dict) -> None:
        if not self.limiter.allow():
            await self.fail("rate_limited", "Too many messages.")
            return
        conversation_id = int(data.get("conversation_id", 0))
        with SessionLocal() as db:
            conversation = chat.get_for_admin(db, conversation_id)
            message = chat.post_admin_message(
                db, conversation,
                admin_id=self.admin_id, admin_name=self.admin_name,
                body=data.get("body"),
                is_internal=bool(data.get("is_internal")),
            )
            db.commit()
            payload = ChatMessageResponse.for_customer(message).model_dump(mode="json")
            internal = message.is_internal
        # `internal` rides on the envelope, not inside the message: the
        # customer's pump reads it and drops the frame before the body is
        # written to their socket.
        await self.broker.publish(conversation_id, {
            "event": "receive_message", "data": payload, "internal": internal,
        })

    async def _typing(self, data: dict, typing: bool) -> None:
        await self.broker.publish(int(data.get("conversation_id", 0)), {
            "event": "typing",
            "data": {
                "conversation_id": data.get("conversation_id"),
                "actor": "admin",
                "is_typing": typing,
            },
        })

    async def _mark_read(self, data: dict) -> None:
        conversation_id = int(data.get("conversation_id", 0))
        up_to = data.get("up_to_message_id")
        if not isinstance(up_to, int):
            await self.fail("bad_frame", "up_to_message_id must be an integer")
            return
        with SessionLocal() as db:
            conversation = chat.get_for_admin(db, conversation_id)
            marked = chat.mark_read(
                db, conversation, reader="admin", up_to_message_id=up_to,
            )
            db.commit()
        await self.send("read_ack", {"marked": marked})
        await self.broker.publish(conversation_id, {
            "event": "read_receipt",
            "data": {
                "conversation_id": conversation_id,
                "up_to_message_id": up_to,
                "by": "admin",
            },
        })


async def serve_agent(websocket: WebSocket, ticket: str) -> None:
    broker = get_broker()
    admin_id = _parse_actor(await broker.redeem_ticket(ticket), "admin")
    if admin_id is None:
        await websocket.close(code=CLOSE_BAD_TICKET)
        return

    with SessionLocal() as db:
        # Imported here rather than at module scope: this module belongs to the
        # B2C tree, and a top-level models_v2 import would make the B2B side a
        # hard dependency of the customer chat path.
        from app.models_v2 import User
        user = db.get(User, admin_id)
        name = user.full_name if user else "Support"

    await websocket.accept()
    connection = AgentConnection(websocket, admin_id, name)
    try:
        await connection.run()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("chat: agent socket failed for user %s", admin_id)
        try:
            await websocket.close(code=1011)
        except RuntimeError:
            pass
