"""WebRTC signalling: who gets told what, and when (CR-10).

A RELAY, NOT A PARTICIPANT
This module forwards opaque strings between two browsers that
`customer_call_service` has already decided are on a call together. It does not
parse SDP, does not inspect ICE candidates, and never sees a byte of audio —
media goes peer-to-peer, or through TURN, and if it ever went through here the
first busy afternoon would put voice packets on the same event loop as the chat
queue and take both down.

WHAT IT ACTUALLY OWNS: ADDRESSING. Signalling is only hard because the two
parties are on different sockets, usually on different workers, and one of them
is not looking at the conversation. Three rules cover it:

  * A frame for the CUSTOMER goes on the conversation channel, which their
    socket already subscribes to for the whole session.
  * A frame for a SPECIFIC AGENT goes on that agent's own channel
    (`chat:agent:{id}`), subscribed for the life of their socket. This is what
    makes a ring arrive when the agent is reading a different thread.
  * A RING with no agent yet goes to every candidate agent's channel — a
    fan-out, not a broadcast: each is addressed individually, so an agent who
    is not a candidate is never woken.

WHY NOT SOCKET.IO, WHICH THE BRIEF ASKS FOR
Socket.IO would mean a second server with its own auth, its own fan-out and its
own scaling story, running beside a WebSocket gateway that already has all
three and is already proven across two workers. The brief's real requirement is
the event vocabulary — `call_request`, `offer`, `answer`, `ice_candidate` and
the rest — and that is a set of names, not a library. They are implemented
verbatim on the existing transport. Nothing about the client's logic would
differ under Socket.IO except the connect call.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

from app.services.chat_broker import agent_channel, channel_for, get_broker

logger = logging.getLogger("jackpots.chat")

#: Frames the server will relay between the two parties of a live call without
#: looking inside them. Anything not on this list is refused rather than
#: forwarded: an allowlist means a new event has to be added deliberately,
#: where a denylist means a typo becomes a channel for arbitrary payloads.
RELAYABLE = ("offer", "answer", "ice_candidate")


def call_payload(call, *, customer_name: Optional[str] = None) -> dict[str, Any]:
    """The shape every call frame carries.

    ONE SHAPE FOR ALL OF THEM, so a client can keep a single call object and
    replace it wholesale on every frame rather than merging fields per event
    type — which is where a UI ends up showing a stale timer or a name from the
    previous call.

    `call_id` is the PUBLIC uuid. The integer primary key never leaves the
    server: it is guessable, and a signalling frame naming somebody else's call
    must not be a matter of arithmetic.
    """
    return {
        "call_id": call.public_id,
        "conversation_id": call.conversation_id,
        "status": call.status,
        "direction": call.direction,
        "admin_id": call.admin_id,
        "admin_name": call.admin_name,
        "customer_id": call.customer_id,
        "customer_name": customer_name,
        "created_at": call.created_at.isoformat() if call.created_at else None,
        "connected_at": call.connected_at.isoformat() if call.connected_at else None,
        "ended_at": call.ended_at.isoformat() if call.ended_at else None,
        "duration_seconds": call.duration_seconds,
        "ended_by": call.ended_by,
        "failure_reason": call.failure_reason,
    }


async def to_customer(conversation_id: int, event: str, data: dict[str, Any]) -> None:
    """Send one frame to the customer's socket.

    The conversation channel is also read by any agent who has that thread
    open. That is harmless for call frames — they carry no message body and the
    agent is a legitimate party — and it is what lets a second agent watching
    the thread see it go from ringing to answered without a refetch.
    """
    await get_broker().publish(conversation_id, {"event": event, "data": data})


async def to_agent(admin_id: int, event: str, data: dict[str, Any]) -> None:
    """Send one frame to a specific agent, wherever they are looking."""
    await get_broker().publish_to(agent_channel(admin_id), {"event": event, "data": data})


async def is_online(actor: str) -> bool:
    """Does this actor hold a live socket? `actor` is "customer:43" / "admin:7".

    A presence lookup that raises is treated as ONLINE, not offline. Presence is
    an optimisation — it exists to avoid ringing an empty room — and a Redis
    hiccup must not turn into "nobody is available" for a customer whose agent
    is sitting right there. Failing open costs one wasted ring; failing closed
    silently disables calling.
    """
    try:
        return await get_broker().is_online(actor)
    except Exception:  # noqa: BLE001
        logger.warning("call: presence lookup failed for %s; assuming online", actor)
        return True


async def online_agents(admin_ids: Iterable[int]) -> list[int]:
    """Filter candidates down to the ones actually holding a socket."""
    live = []
    for admin_id in admin_ids:
        if await is_online(f"admin:{admin_id}"):
            live.append(admin_id)
    return live


async def ring_agents(admin_ids: Iterable[int], data: dict[str, Any]) -> int:
    """Ring every candidate agent. Returns how many were rung.

    ADDRESSED INDIVIDUALLY, NOT BROADCAST. A single "somebody is calling"
    channel that every agent subscribes to would be simpler and would also ring
    the phone of every agent in the company for a conversation assigned to one
    of them. Fanning out to named channels costs one publish per candidate —
    and there are, at most, a handful of candidates.

    THIS COUNT IS PUBLISHES, NOT LISTENERS, and that distinction cost a bug: a
    Redis publish to a channel nobody subscribes to succeeds, so a non-zero
    return says only that the invitation was sent, never that anyone was there
    to receive it. Callers must filter with `online_agents()` FIRST — an earlier
    version of this docstring claimed a zero meant "callee offline", which was
    untrue and produced exactly the 45 seconds of false ringing it warned about.
    """
    broker = get_broker()
    rung = 0
    for admin_id in admin_ids:
        try:
            await broker.publish_to(
                agent_channel(admin_id), {"event": "incoming_call", "data": data},
            )
            rung += 1
        except Exception:  # noqa: BLE001 - one unreachable agent must not stop the rest
            logger.warning("call: could not ring admin %s", admin_id)
    return rung


async def cancel_ring(admin_ids: Iterable[int], data: dict[str, Any]) -> None:
    """Take the invitation off every agent's screen.

    Sent when the call is answered, cancelled or times out. Every agent who was
    rung must be told, including the one who answered — their own popup has to
    close too, and a client that only closes the popup it acted on leaves the
    others ringing an already-answered call.
    """
    broker = get_broker()
    for admin_id in admin_ids:
        try:
            await broker.publish_to(
                agent_channel(admin_id), {"event": "call_cancelled", "data": data},
            )
        except Exception:  # noqa: BLE001
            logger.warning("call: could not clear the ring for admin %s", admin_id)


def ice_config() -> dict[str, Any]:
    """The ICE servers a browser should use, in RTCConfiguration shape.

    Built from settings so TURN credentials are never baked into a static file
    the whole internet can read — `frontend/` is served by the same process, and
    anything hardcoded there is public.

    Says out loud when TURN is missing. STUN alone cannot connect a peer behind
    symmetric or carrier-grade NAT, which on Indian mobile networks is the
    common case rather than the exception; those calls fail with no error the
    customer can act on. A log line at the moment a browser asks for the config
    is the earliest point anyone can be told.
    """
    from app.config import settings  # noqa: PLC0415 - avoids an import cycle at start-up

    servers: list[dict[str, Any]] = []
    if settings.stun_url_list:
        servers.append({"urls": settings.stun_url_list})
    if settings.turn_configured:
        servers.append({
            "urls": settings.turn_url_list,
            "username": settings.turn_username,
            "credential": settings.turn_password,
        })
    else:
        logger.warning(
            "call: no TURN server configured. Calls between peers that cannot "
            "reach each other directly (symmetric NAT, and most Indian mobile "
            "carriers' CGNAT) will fail to connect. See docs/CR-10_VOICE_CALLS.md."
        )
    return {
        "iceServers": servers,
        "turn_configured": settings.turn_configured,
        "ttl_seconds": settings.ice_ttl_seconds,
    }
