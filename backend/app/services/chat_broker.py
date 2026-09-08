"""Cross-worker fan-out and short-lived tickets for live chat (CR-9, slice 3).

THE PROBLEM THIS EXISTS TO SOLVE, STATED ONCE
`WEB_CONCURRENCY=2`. Gunicorn forks two independent processes with separate
memory. A dictionary of open WebSockets therefore holds *some* of the
connections — the ones that happened to land on this worker. A customer on
worker 1 and an agent on worker 2 are invisible to each other, and about half of
all messages are delivered to nobody, with no exception raised and nothing in
the log. It is the worst class of bug this system can have: silent, intermittent,
and indistinguishable from "the other person hasn't replied yet".

So a message is never handed straight to a socket. It is PUBLISHED to a channel
that every worker subscribes to, and each worker delivers it to whichever of its
own sockets are listening. One publish, every worker, no matter which process
the two parties landed on.

TWO IMPLEMENTATIONS, THE SAME SHAPE AS storage.py
`storage.py` has LocalStorage for a single box and S3Storage for real
deployments; this has the same split for the same reason.

    RedisBroker      the real one. Required for more than one worker.
    InProcessBroker  a development convenience, correct ONLY with one worker.

`InProcessBroker` is not a silent fallback: it logs a warning at start-up every
time it is chosen, and `describe()` reports which is in use so a health endpoint
can say so out loud. A fallback nobody can see is how you end up debugging the
paragraph above in production.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from typing import Any, AsyncIterator, Optional, Protocol

from app.config import settings

logger = logging.getLogger("jackpots.chat")

#: One channel per conversation. Workers subscribe only to the conversations
#: they actually hold a socket for, so a worker with three chats open is not
#: woken by traffic for the other four hundred.
CHANNEL_PREFIX = "chat:conv:"
TICKET_PREFIX = "chat:ticket:"
PRESENCE_PREFIX = "chat:presence:"

#: One channel per AGENT, subscribed for the life of their socket (CR-10).
#:
#: The conversation channels above are joined on demand, which is right for
#: chat: an agent who has four hundred conversations should not be woken by
#: traffic on the three hundred and ninety-seven they are not reading. A voice
#: call is the exact opposite — it exists to interrupt, and the customer ringing
#: is almost never in the thread the agent happens to have open. Without a
#: channel that is always subscribed, an incoming call reaches an agent only by
#: the coincidence of them already looking at the right conversation.
AGENT_PREFIX = "chat:agent:"


def channel_for(conversation_id: int) -> str:
    return f"{CHANNEL_PREFIX}{conversation_id}"


def agent_channel(admin_id: int) -> str:
    return f"{AGENT_PREFIX}{admin_id}"


class ChatBroker(Protocol):
    """What the gateway needs. Deliberately small — four verbs."""

    async def publish(self, conversation_id: int, payload: dict[str, Any]) -> None: ...

    def subscribe(self, conversation_id: int) -> "Subscription": ...

    async def publish_to(self, channel: str, payload: dict[str, Any]) -> None: ...

    def subscribe_to(self, channel: str) -> "Subscription": ...

    async def issue_ticket(self, actor: str) -> str: ...

    async def redeem_ticket(self, ticket: str) -> Optional[str]: ...

    def describe(self) -> str: ...


class Subscription(Protocol):
    async def __aenter__(self) -> AsyncIterator[dict[str, Any]]: ...
    async def __aexit__(self, *exc: Any) -> None: ...


# ---------------------------------------------------------------------------
# The real one
# ---------------------------------------------------------------------------
class RedisBroker:
    """Redis pub/sub, plus tickets as keys with a TTL.

    TICKETS ARE `GETDEL`, NOT `GET` THEN `DELETE`.
    A ticket authorises one socket. Read-then-delete is a check-then-act: two
    connections replaying the same ticket in the same millisecond both read it
    and both are admitted. `GETDEL` is atomic in Redis, so exactly one of them
    gets a value back and the other gets None — the same reasoning as the
    conditional UPDATE that decides which agent wins a claim.
    """

    def __init__(self, url: str):
        import redis.asyncio as aioredis  # imported here so the dep is optional

        self._redis = aioredis.from_url(url, decode_responses=True)
        self._url = url

    async def publish(self, conversation_id: int, payload: dict[str, Any]) -> None:
        await self._redis.publish(channel_for(conversation_id), json.dumps(payload))

    def subscribe(self, conversation_id: int) -> "RedisSubscription":
        return self.subscribe_to(channel_for(conversation_id))

    async def publish_to(self, channel: str, payload: dict[str, Any]) -> None:
        await self._redis.publish(channel, json.dumps(payload))

    def subscribe_to(self, channel: str) -> "RedisSubscription":
        return RedisSubscription(self._redis, channel)

    async def issue_ticket(self, actor: str) -> str:
        """`actor` is "customer:43" or "admin:7".

        The ticket carries WHO it is for, not just which id — an admin and a
        customer can hold the same numeric id in their own tables, and a ticket
        that only said "7" would let one open the other's socket.
        """
        ticket = secrets.token_urlsafe(32)
        await self._redis.set(
            f"{TICKET_PREFIX}{ticket}", actor,
            ex=settings.chat_ticket_ttl_seconds,
        )
        return ticket

    async def redeem_ticket(self, ticket: str) -> Optional[str]:
        if not ticket:
            return None
        try:
            value = await self._redis.getdel(f"{TICKET_PREFIX}{ticket}")
        except AttributeError:
            # GETDEL needs Redis 6.2+. Fall back to a transaction rather than
            # to a non-atomic read: the whole point is that it is single-use.
            async with self._redis.pipeline(transaction=True) as pipe:
                pipe.get(f"{TICKET_PREFIX}{ticket}")
                pipe.delete(f"{TICKET_PREFIX}{ticket}")
                value, _ = await pipe.execute()
        return value or None

    async def mark_online(self, actor: str, ttl: int = 60) -> None:
        """Presence with a TTL, refreshed by heartbeat.

        A crashed worker cannot run its own cleanup, so presence that is only
        deleted on disconnect leaves people permanently "online". Expiry is the
        only thing that survives the process dying.
        """
        await self._redis.set(f"{PRESENCE_PREFIX}{actor}", "1", ex=ttl)

    async def mark_offline(self, actor: str) -> None:
        await self._redis.delete(f"{PRESENCE_PREFIX}{actor}")

    async def is_online(self, actor: str) -> bool:
        return bool(await self._redis.exists(f"{PRESENCE_PREFIX}{actor}"))

    async def ping(self) -> bool:
        try:
            return bool(await self._redis.ping())
        except Exception:
            return False

    def describe(self) -> str:
        host = self._url.split("@")[-1]
        return f"redis({host})"


class RedisSubscription:
    def __init__(self, redis_client, channel: str):
        self._redis = redis_client
        self._channel = channel
        self._pubsub = None

    async def __aenter__(self) -> AsyncIterator[dict[str, Any]]:
        self._pubsub = self._redis.pubsub()
        await self._pubsub.subscribe(self._channel)
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[dict[str, Any]]:
        async for message in self._pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                yield json.loads(message["data"])
            except (ValueError, TypeError):
                # A malformed payload is one publisher's bug. Dropping it keeps
                # every other subscriber on this channel talking.
                logger.warning("chat: undecodable payload on %s", self._channel)

    async def __aexit__(self, *exc: Any) -> None:
        if self._pubsub is not None:
            try:
                await self._pubsub.unsubscribe(self._channel)
            finally:
                await self._pubsub.aclose()


# ---------------------------------------------------------------------------
# The development one
# ---------------------------------------------------------------------------
class InProcessBroker:
    """Correct for exactly one worker. Wrong, silently, for more than one.

    Kept because a developer running `uvicorn` on a laptop should not need a
    Redis container to open the chat, exactly as `LocalStorage` exists so they
    do not need an S3 bucket to upload a document. It says so at start-up.
    """

    def __init__(self) -> None:
        self._queues: dict[str, set[asyncio.Queue]] = {}
        self._tickets: dict[str, str] = {}
        #: actor -> monotonic deadline. A dict, not a set, because presence
        #: expires — see mark_online.
        self._online: dict[str, float] = {}
        logger.warning(
            "chat: REDIS_URL is not set — using the in-process broker. This is "
            "correct for ONE worker only; with WEB_CONCURRENCY>1 messages will "
            "reach only the workers that happen to hold both sockets."
        )

    async def publish(self, conversation_id: int, payload: dict[str, Any]) -> None:
        """Round-trips through JSON, exactly as RedisBroker does.

        THIS IS NOT WASTE. It used to hand the dict straight to the queue, which
        meant the fallback accepted payloads Redis would reject — and on
        2026-09-07 that hid a real bug all the way into production: a
        `model_dump()` carrying datetime objects passed every one of 110 tests
        against this broker and then raised
        `TypeError: Object of type datetime is not JSON serializable` on the
        first live send, storing the message, acking it, and broadcasting
        nothing.

        A development stand-in that is more permissive than the real thing is
        not a stand-in; it is a way of not testing. The cost is one serialise
        per publish on a laptop.
        """
        await self.publish_to(channel_for(conversation_id), payload)

    def subscribe(self, conversation_id: int) -> "InProcessSubscription":
        return self.subscribe_to(channel_for(conversation_id))

    async def publish_to(self, channel: str, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload)
        for queue in list(self._queues.get(channel, ())):
            queue.put_nowait(json.loads(encoded))

    def subscribe_to(self, channel: str) -> "InProcessSubscription":
        return InProcessSubscription(self._queues, channel)

    async def issue_ticket(self, actor: str) -> str:
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = actor
        return ticket

    async def redeem_ticket(self, ticket: str) -> Optional[str]:
        # dict.pop is atomic under the GIL, which gives the same single-use
        # guarantee GETDEL gives across processes.
        return self._tickets.pop(ticket, None) if ticket else None

    async def mark_online(self, actor: str, ttl: int = 60) -> None:
        """Presence WITH the expiry, exactly as RedisBroker applies it.

        THIS ARGUMENT USED TO BE IGNORED, and that hid a real bug for a whole
        release. `ttl` existed in the signature and did nothing: presence went
        into a set that never expired, so on a laptop an agent stayed online
        forever no matter what the client did. On Redis the key expires after
        sixty seconds unless refreshed — and the agent console was refreshing
        nothing, so every call placed more than a minute after an admin signed
        in found nobody available.

        It was invisible locally for the same reason `publish` used to hide a
        serialisation bug: a stand-in more permissive than the real thing is a
        way of not testing. Same fix, same lesson, a second method of the same
        class.
        """
        self._online[actor] = time.monotonic() + max(1, ttl)

    async def mark_offline(self, actor: str) -> None:
        self._online.pop(actor, None)

    async def is_online(self, actor: str) -> bool:
        expires = self._online.get(actor)
        if expires is None:
            return False
        if expires <= time.monotonic():
            # Expired. Dropped on read rather than swept on a timer: there is no
            # scheduler here, and an entry nobody asks about costs nothing.
            self._online.pop(actor, None)
            return False
        return True

    async def ping(self) -> bool:
        return True

    def describe(self) -> str:
        return "in-process(single worker only)"


class InProcessSubscription:
    def __init__(self, registry: dict[str, set[asyncio.Queue]], channel: str):
        self._registry = registry
        self._channel = channel
        self._queue: asyncio.Queue = asyncio.Queue()

    async def __aenter__(self) -> AsyncIterator[dict[str, Any]]:
        self._registry.setdefault(self._channel, set()).add(self._queue)
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            yield await self._queue.get()

    async def __aexit__(self, *exc: Any) -> None:
        listeners = self._registry.get(self._channel)
        if listeners:
            listeners.discard(self._queue)
            if not listeners:
                self._registry.pop(self._channel, None)


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------
_broker: Optional[ChatBroker] = None


def get_broker() -> ChatBroker:
    """The process-wide broker. Built once, on first use."""
    global _broker
    if _broker is None:
        if settings.redis_url:
            _broker = RedisBroker(settings.redis_url)
            logger.info("chat: fan-out via %s", _broker.describe())
        else:
            # The dangerous combination, said out loud. More than one worker
            # with a per-process broker is the silent half-delivery bug this
            # module exists to prevent, and a WARNING scrolls past in a deploy
            # log where an ERROR does not.
            import os
            workers = int(os.environ.get("WEB_CONCURRENCY", "1") or "1")
            if workers > 1:
                logger.error(
                    "chat: WEB_CONCURRENCY=%s with no REDIS_URL. Live chat will "
                    "deliver messages ONLY to the worker that holds both sockets; "
                    "roughly half will reach nobody, silently. Set REDIS_URL.",
                    workers,
                )
            _broker = InProcessBroker()
    return _broker


def reset_broker_for_tests() -> None:
    """Drop the cached broker so a test can point at a different backend."""
    global _broker
    _broker = None
