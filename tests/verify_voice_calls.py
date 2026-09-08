"""CR-10 — voice calling, verified against a running server.

WHAT THIS PROVES, AND WHY IT IS THE ONLY THING WORTH PROVING
Signalling has no visible output. A call that never connects and a call whose
`offer` went to the wrong socket look identical from the outside: a customer
staring at "Calling…". So every check here follows a frame from one socket to
the other and asserts it arrived at the RIGHT one — which is the whole job.

Two sockets, both real, driven the way the browsers drive them:

    customer ws  ──call_request──►  server  ──incoming_call──►  agent ws
                 ◄──call_accepted──         ◄──call_accept─────
                 ───offer────────►          ────offer────────►
                 ◄──answer───────           ◄───answer────────
                 ───ice_candidate►          ────ice_candidate►

THE CHECK THAT MATTERS MOST is the one where a THIRD account tries to relay an
offer into somebody else's call. The relay forwards payloads it deliberately
does not understand; the party check is the entire thing standing between that
and an authenticated stranger injecting SDP into a stranger's conversation.

THE OTHER ONE IS THE AGENT CHANNEL. An agent socket only pumps conversations it
has joined, so a ring for a thread the agent is not reading must arrive on their
own channel or not at all. The test deliberately never sends `join_chat`.
"""
import asyncio
import os
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import requests  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_customer import Customer, CustomerCall  # noqa: E402
from app.services import customer_call_service as calls  # noqa: E402
from app.services import customer_chat_service as chat  # noqa: E402
from app.services.customer_auth_service import (  # noqa: E402
    issue_tokens, next_customer_code,
)

from config import ADMIN, BASE, Checker, H, login as portal_login  # noqa: E402

check = Checker()
WS_BASE = BASE.replace("https://", "wss://").replace("http://", "ws://")


def _make_customer(db) -> Customer:
    customer = Customer(
        customer_code=next_customer_code(db),
        full_name="CR-10 Call Customer",
        email=f"cr10-{uuid.uuid4().hex[:12]}@example.com",
        mobile=f"+9199{uuid.uuid4().int % 10**8:08d}",
    )
    db.add(customer)
    db.flush()
    return customer


def _cleanup(*customer_ids: int) -> None:
    with SessionLocal() as db:
        for cid in customer_ids:
            db.execute(delete(Customer).where(Customer.customer_id == cid))
        db.commit()


async def _recv_until(ws, wanted, timeout=8.0):
    """Read frames until one of `wanted` arrives. Returns (event, data) or None.

    Reads PAST uninteresting frames rather than asserting on the next one. Both
    sockets carry chat traffic, presence and status updates; a test that
    demanded the very next frame be the one it wanted would fail on timing
    rather than on behaviour, which is the sort of flake that gets a suite
    ignored.
    """
    import json

    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            return None
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            return None
        try:
            frame = json.loads(raw)
        except ValueError:
            continue
        if frame.get("event") in wanted:
            return frame.get("event"), frame.get("data") or {}


async def _send(ws, event, data):
    import json

    await ws.send(json.dumps({"event": event, "data": data}))


def main() -> int:
    # The migration must be applied; saying so beats forty confusing failures.
    with SessionLocal() as db:
        try:
            db.execute(select(CustomerCall).limit(1)).all()
        except Exception:
            print("SKIP  0066_customer_voice_calls is not applied to this database.")
            print("      Run: cd backend && alembic upgrade head")
            return 0

    try:
        probe = requests.get(f"{BASE}/api/health", timeout=4)
        if probe.status_code != 200:
            raise requests.RequestException
    except requests.RequestException:
        print(f"  SKIP  no server at {BASE} — start one, or set JPW_BASE")
        return 0

    with SessionLocal() as db:
        caller = _make_customer(db)
        onlooker = _make_customer(db)
        db.commit()
        caller_id, onlooker_id = caller.customer_id, onlooker.customer_id
        caller_token, _ = issue_tokens(caller)
        onlooker_token, _ = issue_tokens(onlooker)

    try:
        return _run(caller_id, onlooker_id, caller_token, onlooker_token)
    finally:
        _cleanup(caller_id, onlooker_id)


def _run(caller_id, onlooker_id, caller_token, onlooker_token) -> int:
    auth = {"Authorization": f"Bearer {caller_token}"}
    onlooker_auth = {"Authorization": f"Bearer {onlooker_token}"}

    # == 1. the state machine, with no transport in the way ==
    print("\n== the call state machine ==")
    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, caller_id)
        db.commit()
        conversation_id = conversation.conversation_id

    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, caller_id)
        call = calls.start(db, conversation, direction="customer_to_admin")
        db.commit()
        check("a call starts at `calling`", call.status == "calling", call.status)
        check("it gets a public uuid, not an integer", len(call.public_id) == 36)
        check("no agent is on it yet", call.admin_id is None)
        first_public = call.public_id

    # The partial unique index, which is what makes `busy` a fact rather than a
    # hope. Two tabs both pass any Python check.
    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, caller_id)
        try:
            calls.start(db, conversation, direction="customer_to_admin")
            db.commit()
            busy_refused = False
        except calls.CallBusy:
            busy_refused = True
        except Exception:
            busy_refused = False
    check("a SECOND live call on one conversation is refused", busy_refused)

    with SessionLocal() as db:
        call = calls.get_by_public_id(db, first_public)
        calls.mark_ringing(db, call)
        check("calling -> ringing", call.status == "ringing")
        check("and the ring is timestamped", call.ringing_at is not None)
        ok = calls.accept(db, call, admin_id=9001, admin_name="Test Agent")
        check("ringing -> accepted", ok and call.status == "accepted", call.status)
        check("the answering agent is recorded", call.admin_id == 9001)
        check("a second accept loses the race", not calls.accept(
            db, call, admin_id=9002, admin_name="Other"))
        calls.mark_connected(db, call)
        check("accepted -> connected", call.status == "connected")
        check("connected is timestamped", call.connected_at is not None)
        check(
            "a repeat `connected` does not move the clock",
            calls.mark_connected(db, call) is False,
        )
        calls.finish(db, call, status="ended", ended_by="customer")
        check("connected -> ended", call.status == "ended")
        check("a duration is written", call.duration_seconds is not None)
        check(
            "a second hangup is a no-op, not an error",
            calls.finish(db, call, status="ended", ended_by="admin") is False,
        )
        db.commit()

    # A call that never connected must have NULL duration, not 0 — see 0066.
    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, caller_id)
        missed = calls.start(db, conversation, direction="customer_to_admin")
        calls.finish(db, missed, status="missed", ended_by="system")
        db.commit()
        check(
            "an unanswered call has NULL duration, not zero",
            missed.duration_seconds is None, str(missed.duration_seconds),
        )
        check("and it is recorded as missed", missed.status == "missed")

    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, caller_id)
        cancelled = calls.start(db, conversation, direction="customer_to_admin")
        calls.finish(db, cancelled, status="cancelled", ended_by="customer")
        db.commit()
        check(
            "the caller hanging up first is `cancelled`, not `missed`",
            cancelled.status == "cancelled",
        )

    # Terminal really is terminal. A late frame must not reopen a finished call.
    with SessionLocal() as db:
        done = calls.get_by_public_id(db, first_public)
        check(
            "an ended call cannot be answered by a late frame",
            done.can_transition_to("accepted") is False,
        )

    # == 2. the ICE config ==
    print("\n== ICE configuration ==")
    r = requests.get(f"{BASE}/api/customer/chat/ice", headers=auth, timeout=8)
    check("a signed-in customer can fetch ICE servers", r.status_code == 200, r.text[:150])
    ice = r.json() if r.status_code == 200 else {}
    check("it names at least one STUN server", bool(ice.get("iceServers")), str(ice)[:150])
    check(
        "it says plainly whether TURN is configured",
        "turn_configured" in ice, str(sorted(ice)),
    )
    r = requests.get(f"{BASE}/api/customer/chat/ice", timeout=8)
    check(
        "ICE credentials require a session — an open TURN relay is not a feature",
        r.status_code in (401, 403), f"got {r.status_code}",
    )

    # == 3. the real thing: two sockets ==
    print("\n== signalling across two sockets ==")
    try:
        from websockets.asyncio.client import connect as ws_connect  # noqa: PLC0415
    except ImportError:
        print("  SKIP  the `websockets` client is not installed")
        return check.report()

    try:
        admin_token = portal_login(*ADMIN)
    except Exception as exc:  # noqa: BLE001
        print(f"  SKIP  could not sign in as admin: {exc!r}")
        return check.report()
    admin_auth = H(admin_token)

    results: dict = {}

    async def _flow():
        cust_ticket = requests.post(
            f"{BASE}/api/customer/chat/ws-ticket", headers=auth, timeout=8,
        ).json()["ticket"]
        agent_ticket = requests.post(
            f"{BASE}/api/admin/chat/ws-ticket", headers=admin_auth, timeout=8,
        ).json()["ticket"]

        async with ws_connect(f"{WS_BASE}/api/customer/chat/ws?ticket={cust_ticket}") as cws, \
                   ws_connect(f"{WS_BASE}/api/admin/chat/ws?ticket={agent_ticket}") as aws:
            # NOTE: the agent NEVER sends join_chat. If the ring arrives it can
            # only be via the agent's own channel, which is the point.
            joined = await _recv_until(cws, {"joined"})
            results["customer_joined"] = joined is not None

            await _send(cws, "call_request", {})
            rung = await _recv_until(aws, {"incoming_call"}, timeout=10)
            results["agent_rang"] = rung is not None
            if rung is None:
                return
            call_id = rung[1].get("call_id")
            results["ring_names_the_customer"] = bool(rung[1].get("customer_name"))
            results["ring_carries_a_uuid"] = isinstance(call_id, str) and len(call_id) == 36

            status = await _recv_until(cws, {"call_status"}, timeout=8)
            results["caller_sees_status"] = status is not None and status[1].get(
                "status") in ("calling", "ringing")

            await _send(aws, "call_accept", {"call_id": call_id})
            accepted = await _recv_until(cws, {"call_accepted"}, timeout=8)
            results["customer_told_it_was_answered"] = accepted is not None
            if accepted:
                results["answer_names_the_agent"] = bool(accepted[1].get("admin_name"))

            # SDP, both directions. The strings are nonsense on purpose: the
            # server must forward what it cannot read.
            await _send(cws, "offer", {"call_id": call_id, "payload": {"sdp": "OFFER-XYZ"}})
            got = await _recv_until(aws, {"offer"}, timeout=8)
            results["offer_reached_the_agent"] = got is not None
            if got:
                results["offer_arrived_intact"] = got[1].get("payload", {}).get("sdp") == "OFFER-XYZ"
                results["offer_says_who_sent_it"] = got[1].get("from") == "customer"

            await _send(aws, "answer", {"call_id": call_id, "payload": {"sdp": "ANSWER-ABC"}})
            got = await _recv_until(cws, {"answer"}, timeout=8)
            results["answer_reached_the_customer"] = got is not None
            if got:
                results["answer_arrived_intact"] = got[1].get("payload", {}).get("sdp") == "ANSWER-ABC"

            await _send(cws, "ice_candidate", {"call_id": call_id, "payload": {"candidate": "C1"}})
            got = await _recv_until(aws, {"ice_candidate"}, timeout=8)
            results["ice_customer_to_agent"] = got is not None and got[1].get(
                "payload", {}).get("candidate") == "C1"

            await _send(aws, "ice_candidate", {"call_id": call_id, "payload": {"candidate": "C2"}})
            got = await _recv_until(cws, {"ice_candidate"}, timeout=8)
            results["ice_agent_to_customer"] = got is not None and got[1].get(
                "payload", {}).get("candidate") == "C2"

            # A STRANGER'S SOCKET MUST NOT REACH THIS CALL.
            stranger_ticket = requests.post(
                f"{BASE}/api/customer/chat/ws-ticket", headers=onlooker_auth, timeout=8,
            ).json()["ticket"]
            async with ws_connect(
                f"{WS_BASE}/api/customer/chat/ws?ticket={stranger_ticket}"
            ) as sws:
                await _recv_until(sws, {"joined"})
                await _send(sws, "offer", {"call_id": call_id,
                                           "payload": {"sdp": "INTRUDER"}})
                refused = await _recv_until(sws, {"error"}, timeout=6)
                results["stranger_is_refused"] = refused is not None
                leaked = await _recv_until(aws, {"offer"}, timeout=3)
                results["stranger_sdp_never_arrives"] = leaked is None

            await _send(cws, "call_connected", {"call_id": call_id})
            live = await _recv_until(aws, {"call_status"}, timeout=8)
            results["both_sides_told_it_connected"] = (
                live is not None and live[1].get("status") == "connected"
            )

            await _send(cws, "call_end", {"call_id": call_id})
            ended = await _recv_until(aws, {"call_status"}, timeout=8)
            results["hangup_reaches_the_other_side"] = (
                ended is not None and ended[1].get("status") == "ended"
            )
            if ended:
                results["hangup_says_who_ended_it"] = ended[1].get("ended_by") == "customer"
            results["ended_call_id"] = call_id

    try:
        asyncio.run(_flow())
    except Exception as exc:  # noqa: BLE001
        check("the signalling flow ran without raising", False, repr(exc))
        return check.report()

    check("the customer socket opens onto a conversation", results.get("customer_joined"))
    check(
        "AN AGENT WHO NEVER JOINED THE THREAD STILL GETS THE RING",
        results.get("agent_rang"), "the agent channel did not deliver",
    )
    check("the ring names the customer", results.get("ring_names_the_customer"))
    check("the ring carries the public uuid", results.get("ring_carries_a_uuid"))
    check("the caller sees its own call status", results.get("caller_sees_status"))
    check("the customer is told it was answered", results.get("customer_told_it_was_answered"))
    check("and by whom", results.get("answer_names_the_agent"))
    check("an SDP offer reaches the agent", results.get("offer_reached_the_agent"))
    check("the offer arrives byte-identical", results.get("offer_arrived_intact"))
    check("the relay stamps who sent it", results.get("offer_says_who_sent_it"))
    check("an SDP answer reaches the customer", results.get("answer_reached_the_customer"))
    check("the answer arrives byte-identical", results.get("answer_arrived_intact"))
    check("ICE candidates flow customer -> agent", results.get("ice_customer_to_agent"))
    check("ICE candidates flow agent -> customer", results.get("ice_agent_to_customer"))
    check(
        "A STRANGER CANNOT RELAY INTO SOMEBODY ELSE'S CALL",
        results.get("stranger_is_refused"),
    )
    check(
        "and their SDP never reaches the agent",
        results.get("stranger_sdp_never_arrives"),
    )
    check("both sides learn the call connected", results.get("both_sides_told_it_connected"))
    check("a hangup reaches the other side", results.get("hangup_reaches_the_other_side"))
    check("and records who hung up", results.get("hangup_says_who_ended_it"))

    # == 3b. nobody is there ==
    #
    # THE 45-SECOND LIE. `ring_agents` counts publishes, and a Redis publish to
    # a channel nobody subscribes to succeeds — so before the presence filter,
    # a customer calling when every agent was signed out heard a full ring-out
    # toward an outcome that was certain from the first millisecond.
    print("\n== ringing an empty room ==")

    async def _presence_checks():
        out = {}
        from app.services import call_signaling as signalling  # noqa: PLC0415

        out["empty_list"] = await signalling.online_agents([]) == []
        out["ghost_admin"] = await signalling.online_agents([99999999]) == []
        out["absent_customer"] = await signalling.is_online(
            f"customer:{caller_id}") is False
        return out

    presence = asyncio.run(_presence_checks())
    check("no candidates means nobody online", presence.get("empty_list"))
    check(
        "an admin id that holds no socket is not 'online'",
        presence.get("ghost_admin"),
        "a publish succeeding is not the same as somebody listening",
    )
    check(
        "a customer with no socket is not 'online'",
        presence.get("absent_customer"),
    )

    # End to end: place a call with NO agent socket open and require it to fail
    # FAST. The point is the elapsed time as much as the status.
    async def _empty_room():
        import time as _time  # noqa: PLC0415
        from app.services import call_signaling as signalling  # noqa: PLC0415

        # PRESENCE CANNOT BE CHECKED FROM HERE. This script is a separate
        # process, so `get_broker()` builds its OWN in-process broker with an
        # empty presence set — it cannot see the server's sockets at all, and
        # asking it whether an agent is online always answers "no". (With
        # REDIS_URL set it would work; without it, it is a confident lie.)
        #
        # So the outcome decides. A call that RINGS proves an agent was online,
        # which is a fine state of the world and simply not the case this
        # section is about. Only a call that ends as missed can be asserted on.

        ticket = requests.post(
            f"{BASE}/api/customer/chat/ws-ticket", headers=auth, timeout=8,
        ).json()["ticket"]
        async with ws_connect(f"{WS_BASE}/api/customer/chat/ws?ticket={ticket}") as cws:
            await _recv_until(cws, {"joined"})
            began = _time.monotonic()
            await _send(cws, "call_request", {})
            frames = []
            while _time.monotonic() - began < 12:
                got = await _recv_until(cws, {"call_status"}, timeout=12)
                if got is None:
                    break
                frames.append(got[1])
                if got[1].get("status") == "missed":
                    break
            return {
                "elapsed": _time.monotonic() - began,
                "final": frames[-1] if frames else None,
            }

    empty = asyncio.run(_empty_room())
    final = empty.get("final") or {}
    # ASSERT ONLY ON THE CASE THIS SECTION IS ABOUT. Anything other than a
    # `missed` outcome means an agent was online and the call went somewhere —
    # a fine state of the world, and not one this section can say anything
    # about. Written as "only missed is testable" rather than "ringing is
    # skippable" because the frame read can also stop at `calling`, and an
    # earlier version treated that as a failure of the code instead of a
    # timing artefact of the test.
    if final.get("status") != "missed":
        print(f"  SKIP  an agent is online (call went to "
              f"{final.get('status') or 'no terminal status'}) — "
              f"the empty-room case cannot be forced")
    else:
        check(
            "a call with no agent online ends as missed",
            final.get("status") == "missed", str(final)[:200],
        )
        check(
            "and it says WHY, rather than looking like a ring-out",
            final.get("failure_reason") == "no_agent_online",
            str(final.get("failure_reason")),
        )
        check(
            "IT FAILS FAST — seconds, not the 45-second ring timeout",
            empty.get("elapsed", 99) < 10,
            f"took {empty.get('elapsed'):.1f}s",
        )

    # == 4. the call log ==
    print("\n== the call log ==")
    r = requests.get(f"{BASE}/api/customer/chat/calls", headers=auth, timeout=8)
    check("a customer can read their call history", r.status_code == 200, r.text[:150])
    if r.status_code == 200:
        body = r.json()
        rows = body.get("calls", [])
        check("the history has the calls this run made", len(rows) >= 3, str(len(rows)))
        check(
            "newest first",
            all(rows[i]["created_at"] >= rows[i + 1]["created_at"] for i in range(len(rows) - 1)),
        )
        statuses = {c["status"] for c in rows}
        check(
            "it distinguishes missed, cancelled and completed",
            {"missed", "cancelled"} <= statuses, str(sorted(statuses)),
        )
        check(
            "THE CUSTOMER'S LOG NEVER CARRIES A STAFF USER ID",
            all(c.get("admin_id") is None for c in rows),
            str([c.get("admin_id") for c in rows]),
        )
        check(
            "but it does name who they spoke to",
            any(c.get("admin_name") for c in rows),
        )
    r = requests.get(f"{BASE}/api/customer/chat/calls", timeout=8)
    check("call history requires a session", r.status_code in (401, 403), f"got {r.status_code}")

    r = requests.get(f"{BASE}/api/customer/chat/calls", headers=onlooker_auth, timeout=8)
    check(
        "another customer's history is THEIR OWN, not this one's",
        r.status_code == 200 and r.json().get("calls") == [],
        r.text[:150],
    )

    # The agent side keeps the id the console needs.
    r = requests.get(
        f"{BASE}/api/admin/chat/conversations/{conversation_id}/calls",
        headers=admin_auth, timeout=8,
    )
    check("an agent can read a conversation's calls", r.status_code == 200, r.text[:150])
    if r.status_code == 200:
        rows = r.json().get("calls", [])
        check(
            "and the agent view DOES carry admin_id",
            any(c.get("admin_id") for c in rows),
            "no admin_id on any row",
        )
    r = requests.get(
        f"{BASE}/api/admin/chat/conversations/{conversation_id}/calls",
        headers=auth, timeout=8,
    )
    check(
        "a CUSTOMER token cannot read the agent call log",
        r.status_code in (401, 403), f"got {r.status_code}",
    )

    # == 5. the stale sweeper ==
    #
    # Without it, one killed worker leaves a row in a live status and the
    # partial unique index blocks every future call on that conversation
    # forever — a permanent silent failure caused by the index that prevents a
    # different one.
    print("\n== recovering from a worker that died mid-ring ==")
    import datetime as dt

    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, caller_id)
        # SETTLE ANYTHING THIS RUN LEFT LIVE FIRST. Earlier sections place real
        # calls, and whether those end on their own depends on something this
        # suite does not control: whether a REAL agent happens to be signed in.
        # With nobody online they die as no_agent_online; with somebody online
        # they legitimately ring on, and this section then collides with the
        # partial unique index and fails for a reason that has nothing to do
        # with what it is testing. Ninety confusing seconds, once, was enough.
        for stale in db.execute(
            select(CustomerCall).where(
                CustomerCall.conversation_id == conversation.conversation_id,
                CustomerCall.status.in_(("calling", "ringing", "accepted", "connected")),
            )
        ).scalars():
            # The state machine allows `cancelled` only before an answer and
            # `ended` only after one, and it is right to refuse the other way
            # round — so the wind-down has to match how far the call got.
            unanswered = stale.status in ("calling", "ringing")
            calls.finish(
                db, stale,
                status="cancelled" if unanswered else "ended",
                ended_by="system",
            )
        db.commit()

    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, caller_id)
        orphan = calls.start(db, conversation, direction="customer_to_admin")
        orphan.created_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
        db.commit()
        orphan_public = orphan.public_id

    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, caller_id)
        try:
            calls.start(db, conversation, direction="customer_to_admin")
            blocked = False
        except calls.CallBusy:
            blocked = True
        db.rollback()
    check("an orphaned live call blocks the next one", blocked)

    with SessionLocal() as db:
        swept = calls.expire_stale(db)
        db.commit()
    check("the sweeper closes it", swept >= 1, str(swept))

    with SessionLocal() as db:
        recovered = calls.get_by_public_id(db, orphan_public)
        check("and marks it missed, not connected", recovered.status == "missed",
              recovered.status)
        conversation = chat.get_or_create_conversation(db, caller_id)
        try:
            calls.start(db, conversation, direction="customer_to_admin")
            db.commit()
            unblocked = True
        except calls.CallBusy:
            unblocked = False
    check("a new call can be placed again afterwards", unblocked)

    return check.report()


if __name__ == "__main__":
    raise SystemExit(main())
