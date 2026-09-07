"""CR-9 slice 1 — the live chat data model and service layer.

SERVERLESS. Talks to the database directly through `SessionLocal`, like
`verify_cr4a.py` does, because slice 1 has no HTTP surface yet: the migration,
the models and `customer_chat_service` are the whole deliverable. Slices 2-3 add
WebSocket coverage to this file; slice 2 added section 13 below.

WHAT IT PROVES, AND WHY EACH ONE EARNED A TEST

The service layer is built around three races (see its module docstring), and a
race that is only reasoned about is a race that is not handled. Sections 3, 4
and 7 below run the concurrent case with real threads and real sessions rather
than asserting that the code "looks right":

  3. Two tabs opening Support Center create ONE conversation, not two.
  4. A resent message with the same client_msg_id stores once.
  7. Two agents claiming one waiting chat produce exactly one winner.

The rest cover the rules that are easy to write and easy to break later:
ownership scoping, the status machine, internal-note visibility, unread
counters, keyset paging and the reconnect gap fetch.

EVERYTHING IS ROLLED BACK. The script creates its own customer, does its work
and deletes it in a `finally`, so a run leaves no residue in a shared database.
"""
import os
import sys
import threading
import json
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import delete, func, select, text  # noqa: E402
from sqlalchemy.exc import ProgrammingError  # noqa: E402

from app.config import settings  # noqa: E402
from app.database.session import SessionLocal  # noqa: E402
from app.models_customer import (  # noqa: E402
    Customer,
    CustomerChatMessage,
    CustomerConversation,
)
from app.services import customer_chat_service as chat  # noqa: E402
from app.services.customer_auth_service import next_customer_code  # noqa: E402

from config import Checker  # noqa: E402  (after sys.path surgery)

check = Checker()
ADMIN_ID, ADMIN_NAME = 9001, "Test Agent"
SECOND_ADMIN_ID, SECOND_ADMIN_NAME = 9002, "Second Agent"


def _make_customer(db) -> Customer:
    """A throwaway customer. `customer_code` comes from the same sequence the
    real signup path uses, so nothing here invents an id format."""
    customer = Customer(
        customer_code=next_customer_code(db),
        full_name="CR-9 Test Customer",
        # example.com, NOT example.invalid. Both are reserved by RFC 2606 and
        # .invalid is the more correct choice for a fixture — but email-validator,
        # which app.schemas uses, rejects special-use TLDs outright. A customer
        # created with one 500s any endpoint that serialises them, which cost
        # half an hour to find the first time.
        email=f"cr9-{uuid.uuid4().hex[:12]}@example.com",
        mobile=f"+9199{uuid.uuid4().int % 10**8:08d}",
    )
    db.add(customer)
    db.flush()
    return customer


def _cleanup(customer_id: int) -> None:
    with SessionLocal() as db:
        db.execute(delete(Customer).where(Customer.customer_id == customer_id))
        db.commit()


def main() -> int:
    with SessionLocal() as db:
        # The migration must be applied. Saying so plainly beats forty
        # confusing failures about a missing relation.
        try:
            db.execute(select(func.count()).select_from(CustomerConversation)).scalar()
        except ProgrammingError:
            print("SKIP  0064_customer_live_chat is not applied to this database.")
            print("      Run: cd backend && alembic upgrade head")
            return 0

    with SessionLocal() as db:
        customer = _make_customer(db)
        customer_id = customer.customer_id
        db.commit()

    try:
        return _run(customer_id)
    finally:
        _cleanup(customer_id)


def _run(customer_id: int) -> int:
    # == 1. the conversation opens itself ==
    print("\n== the conversation opens itself ==")
    with SessionLocal() as db:
        conversation = chat.get_or_create_conversation(db, customer_id)
        db.commit()
        conversation_id = conversation.conversation_id
        check("Support Center opens straight into a conversation", conversation_id is not None)
        check("a new conversation starts waiting", conversation.status == "waiting")
        check("nobody is assigned yet", conversation.assigned_admin_id is None)

    with SessionLocal() as db:
        again = chat.get_or_create_conversation(db, customer_id)
        check(
            "revisiting loads the SAME conversation, not a new one",
            again.conversation_id == conversation_id,
            f"{again.conversation_id} != {conversation_id}",
        )

    # == 2. ownership is a server-side filter ==
    print("\n== ownership is a server-side filter ==")
    with SessionLocal() as db:
        other = _make_customer(db)
        db.commit()
        other_id = other.customer_id
    try:
        with SessionLocal() as db:
            try:
                chat.get_for_customer(db, conversation_id, other_id)
                check("another customer cannot open this conversation", False, "no raise")
            except chat.ChatNotFound:
                check("another customer cannot open this conversation", True)
            try:
                chat.get_for_customer(db, 10**15, customer_id)
                check("a nonexistent id raises the same error as a forbidden one", False)
            except chat.ChatNotFound:
                check("a nonexistent id raises the same error as a forbidden one", True)
    finally:
        _cleanup(other_id)

    # == 3. two tabs, one conversation (RACE) ==
    print("\n== two tabs, one conversation (race) ==")
    with SessionLocal() as db:
        db.execute(
            delete(CustomerConversation).where(
                CustomerConversation.customer_id == customer_id
            )
        )
        db.commit()

    results: list[int] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def open_support_center():
        try:
            barrier.wait(timeout=10)
            with SessionLocal() as db:
                conv = chat.get_or_create_conversation(db, customer_id)
                db.commit()
                results.append(conv.conversation_id)
        except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
            errors.append(exc)

    threads = [threading.Thread(target=open_support_center) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    check("neither concurrent open raised", not errors, "; ".join(map(repr, errors)))
    check("both concurrent opens returned a conversation", len(results) == 2, str(results))
    check(
        "both got the SAME conversation — uq_customer_conversation_live held",
        len(set(results)) == 1,
        f"got {set(results)}",
    )
    with SessionLocal() as db:
        live = db.execute(
            select(func.count()).select_from(CustomerConversation).where(
                CustomerConversation.customer_id == customer_id,
                CustomerConversation.status != "closed",
            )
        ).scalar()
        check("exactly one live conversation row exists", live == 1, f"{live} rows")
        conversation_id = results[0]

    # == 4. a resent message stores once (RACE) ==
    print("\n== a resent message stores once (race) ==")
    with SessionLocal() as db:
        conv = chat.get_for_customer(db, conversation_id, customer_id)
        client_id = uuid.uuid4().hex
        first, created_first = chat.post_customer_message(
            db, conv, body="Hi, I need help with my booking.", client_msg_id=client_id,
        )
        db.commit()
        # Read the id INSIDE the session. `db.commit()` expires the instance,
        # and touching it after the `with` block closes raises
        # DetachedInstanceError rather than returning a stale value.
        first_id = first.message_id
        check("the first send is created", created_first)

    with SessionLocal() as db:
        conv = chat.get_for_customer(db, conversation_id, customer_id)
        again, created_again = chat.post_customer_message(
            db, conv, body="Hi, I need help with my booking.", client_msg_id=client_id,
        )
        db.commit()
        check("a resend is NOT created again", not created_again)
        check("a resend returns the original id", again.message_id == first_id)

    dupe_errors: list[BaseException] = []
    dupe_ids: list[int] = []
    race_client_id = uuid.uuid4().hex
    barrier2 = threading.Barrier(2)

    def resend():
        try:
            barrier2.wait(timeout=10)
            with SessionLocal() as db:
                conv = chat.get_for_customer(db, conversation_id, customer_id)
                msg, _ = chat.post_customer_message(
                    db, conv, body="racing", client_msg_id=race_client_id,
                )
                db.commit()
                dupe_ids.append(msg.message_id)
        except BaseException as exc:  # noqa: BLE001
            dupe_errors.append(exc)

    threads = [threading.Thread(target=resend) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)
    check("neither concurrent resend raised", not dupe_errors, "; ".join(map(repr, dupe_errors)))
    check(
        "concurrent resends collapse to one message",
        len(set(dupe_ids)) == 1,
        f"got {set(dupe_ids)}",
    )

    # == 5. body validation ==
    print("\n== body validation ==")
    with SessionLocal() as db:
        conv = chat.get_for_customer(db, conversation_id, customer_id)
        for label, body in (("empty", ""), ("whitespace only", "   \n  "), ("None", None)):
            try:
                chat.post_customer_message(db, conv, body=body)
                check(f"a {label} text message is refused", False, "no raise")
            except chat.ChatError:
                check(f"a {label} text message is refused", True)
            db.rollback()
        try:
            chat.post_customer_message(db, conv, body="x" * (chat.MAX_BODY_CHARS + 1))
            check("an over-long message is refused, not truncated", False, "no raise")
        except chat.ChatError:
            check("an over-long message is refused, not truncated", True)
        db.rollback()

    # == 6. unread counters and read receipts ==
    print("\n== unread counters and read receipts ==")
    with SessionLocal() as db:
        conv = chat.get_for_customer(db, conversation_id, customer_id)
        before = conv.admin_unread_count
        chat.post_customer_message(db, conv, body="are you there?")
        db.commit()
        check(
            "a customer message raises the ADMIN unread count",
            conv.admin_unread_count == before + 1,
            f"{before} -> {conv.admin_unread_count}",
        )
        check("the preview is stored for the queue", conv.last_message == "are you there?")

    with SessionLocal() as db:
        conv = chat.get_for_admin(db, conversation_id)
        reply = chat.post_admin_message(
            db, conv, admin_id=ADMIN_ID, admin_name=ADMIN_NAME,
            body="Sure. Please share your Booking ID.",
        )
        db.commit()
        check("an admin reply raises the CUSTOMER unread count", conv.customer_unread_count >= 1)
        reply_id = reply.message_id

    with SessionLocal() as db:
        conv = chat.get_for_customer(db, conversation_id, customer_id)
        chat.mark_read(db, conv, reader="customer", up_to_message_id=reply_id)
        db.commit()
        check("reading clears the customer's badge", conv.customer_unread_count == 0)
        stamped = db.get(CustomerChatMessage, reply_id)
        check("the admin's message is stamped read", stamped.read_at is not None)

    # == 7. two agents, one winner (RACE) ==
    print("\n== two agents, one winner (race) ==")
    with SessionLocal() as db:
        conv = chat.get_for_admin(db, conversation_id)
        conv.assigned_admin_id = None
        conv.assigned_admin_name = None
        conv.status = "waiting"
        db.commit()

    claims: list[bool] = []
    claim_errors: list[BaseException] = []
    barrier3 = threading.Barrier(2)

    def claim_it(admin_id, admin_name):
        try:
            barrier3.wait(timeout=10)
            with SessionLocal() as db:
                conv = chat.get_for_admin(db, conversation_id)
                won = chat.claim(db, conv, admin_id=admin_id, admin_name=admin_name)
                db.commit()
                claims.append(won)
        except BaseException as exc:  # noqa: BLE001
            claim_errors.append(exc)

    threads = [
        threading.Thread(target=claim_it, args=(ADMIN_ID, ADMIN_NAME)),
        threading.Thread(target=claim_it, args=(SECOND_ADMIN_ID, SECOND_ADMIN_NAME)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    check("neither concurrent claim raised", not claim_errors, "; ".join(map(repr, claim_errors)))
    check(
        "exactly one agent won the claim",
        claims.count(True) == 1 and claims.count(False) == 1,
        f"claims={claims}",
    )
    with SessionLocal() as db:
        conv = chat.get_for_admin(db, conversation_id)
        check("the winner owns it", conv.assigned_admin_id in (ADMIN_ID, SECOND_ADMIN_ID))
        check("claiming activates the conversation", conv.status == "active")
        check("the agent name is denormalised onto the row", bool(conv.assigned_admin_name))

    # == 8. the status machine ==
    print("\n== the status machine ==")
    with SessionLocal() as db:
        conv = chat.get_for_admin(db, conversation_id)
        chat.set_status(db, conv, "resolved", actor=ADMIN_NAME)
        db.commit()
        check("active -> resolved is allowed", conv.status == "resolved")

    with SessionLocal() as db:
        conv = chat.get_for_customer(db, conversation_id, customer_id)
        chat.post_customer_message(db, conv, body="actually, one more thing")
        db.commit()
        check(
            "a customer message REOPENS a resolved conversation",
            conv.status == "active",
            f"status={conv.status}",
        )

    with SessionLocal() as db:
        conv = chat.get_for_admin(db, conversation_id)
        chat.set_status(db, conv, "closed", actor=ADMIN_NAME)
        db.commit()
        try:
            chat.set_status(db, conv, "active", actor=ADMIN_NAME)
            check("closed is terminal", False, "no raise")
        except chat.ChatError:
            check("closed is terminal", True)
        db.rollback()

    with SessionLocal() as db:
        fresh = chat.get_or_create_conversation(db, customer_id)
        db.commit()
        check(
            "after closing, the next message starts a NEW conversation",
            fresh.conversation_id != conversation_id,
        )
        new_id = fresh.conversation_id

    # == 9. internal notes never reach the customer ==
    print("\n== internal notes never reach the customer ==")
    with SessionLocal() as db:
        conv = chat.get_for_admin(db, new_id)
        chat.post_customer_message(db, conv, body="hello again")
        chat.post_admin_message(
            db, conv, admin_id=ADMIN_ID, admin_name=ADMIN_NAME,
            body="Customer is a repeat traveller — approve the waiver.",
            is_internal=True,
        )
        db.commit()
        customer_view = chat.list_messages(db, conv, include_internal=False)
        agent_view = chat.list_messages(db, conv, include_internal=True)
        bodies = [m.body for m in customer_view]
        check(
            "the internal note is absent from the customer's view",
            not any("waiver" in (b or "") for b in bodies),
            str(bodies),
        )
        check(
            "the internal note IS present in the agent's view",
            any("waiver" in (m.body or "") for m in agent_view),
        )
        check(
            "an internal note does not raise the customer's badge",
            conv.customer_unread_count == 0,
            f"count={conv.customer_unread_count}",
        )

    # == 10. paging and the reconnect gap fetch ==
    print("\n== paging and the reconnect gap fetch ==")
    with SessionLocal() as db:
        conv = chat.get_for_admin(db, new_id)
        for i in range(12):
            chat.post_customer_message(db, conv, body=f"message {i}")
        db.commit()

        page = chat.list_messages(db, conv, include_internal=False, limit=5)
        check("a page returns at most `limit`", len(page) == 5, f"{len(page)}")
        check(
            "a page is ordered oldest-first for rendering",
            [m.message_id for m in page] == sorted(m.message_id for m in page),
        )

        older = chat.list_messages(
            db, conv, include_internal=False, before_id=page[0].message_id, limit=5,
        )
        check("before_id pages backwards", all(m.message_id < page[0].message_id for m in older))

        # The default page is the NEWEST messages, not the oldest — a chat opens
        # at the bottom, the way every messenger does. This is asserted rather
        # than assumed because the first draft of this test assumed the
        # opposite, and an "oldest first" default would silently open every
        # conversation on its first day.
        newest_id = db.execute(
            select(func.max(CustomerChatMessage.message_id)).where(
                CustomerChatMessage.conversation_id == conv.conversation_id,
                CustomerChatMessage.is_internal.is_(False),
            )
        ).scalar()
        check(
            "the default page is the newest messages",
            page[-1].message_id == newest_id,
            f"page ends at {page[-1].message_id}, newest is {newest_id}",
        )

        # The gap fetch starts from an OLD cursor — the case a reconnecting
        # socket is actually in, holding a stale id after a dropped connection.
        gap = chat.list_messages(
            db, conv, include_internal=False, after_id=older[0].message_id, limit=100,
        )
        check(
            "after_id fetches the reconnect gap",
            all(m.message_id > older[0].message_id for m in gap),
        )
        check(
            "the gap reaches the newest message",
            newest_id in [m.message_id for m in gap],
            f"gap ends at {gap[-1].message_id if gap else None}",
        )
        check(
            "the gap excludes internal notes for a customer",
            not any(m.is_internal for m in gap),
        )

    # == 11. soft delete ==
    print("\n== soft delete ==")
    with SessionLocal() as db:
        conv = chat.get_for_customer(db, new_id, customer_id)
        mine, _ = chat.post_customer_message(db, conv, body="delete me")
        db.commit()
        chat.soft_delete_message(db, mine, by_customer_id=customer_id)
        db.commit()
        row = db.get(CustomerChatMessage, mine.message_id)
        check("deleting tombstones rather than removes", row is not None and row.deleted_at is not None)

        theirs = chat.post_admin_message(
            db, conv, admin_id=ADMIN_ID, admin_name=ADMIN_NAME, body="not yours",
        )
        db.commit()
        try:
            chat.soft_delete_message(db, theirs, by_customer_id=customer_id)
            check("a customer cannot delete the agent's message", False, "no raise")
        except chat.ChatError:
            check("a customer cannot delete the agent's message", True)
        db.rollback()

    # == 12. the queue ==
    print("\n== the queue ==")
    with SessionLocal() as db:
        counts = chat.counts_by_status(db)
        check(
            "counts_by_status returns every status, zero-filled",
            set(counts) == {"waiting", "active", "resolved", "closed"},
            str(sorted(counts)),
        )
        rows = chat.queue(db, limit=5)
        check("the queue returns conversations", len(rows) >= 1)
        stamps = [r.last_message_at for r in rows if r.last_message_at is not None]
        check(
            "the queue is ordered by most recent activity",
            stamps == sorted(stamps, reverse=True),
        )


    # == 13. the REST surface (slice 2) ==
    #
    # Against a LIVE server at config.BASE, like every other HTTP script in this
    # suite — not FastAPI's TestClient, which needs a package that is not in
    # requirements.txt and would make the suite depend on a test-only library.
    #
    # The token is minted directly rather than obtained by logging in over HTTP.
    # This script already holds a database session, and a login round trip here
    # would be testing customer_auth_service, which verify_customer_portal.py
    # already covers. What is under test is the chat routes and their scoping.
    print("\n== the REST surface ==")
    import requests  # noqa: PLC0415

    from config import BASE  # noqa: PLC0415
    from app.services.customer_auth_service import issue_tokens  # noqa: PLC0415

    try:
        probe = requests.get(f"{BASE}/api/health", timeout=4)
        server_up = probe.status_code == 200
    except requests.RequestException:
        server_up = False

    if not server_up:
        print(f"  SKIP  no server at {BASE} — start one, or set JPW_BASE, to cover the REST layer")
        return check.report()

    with SessionLocal() as db:
        me = db.get(Customer, customer_id)
        access, _ = issue_tokens(me)
        stranger = _make_customer(db)
        db.commit()
        stranger_id = stranger.customer_id
        stranger_access, _ = issue_tokens(stranger)

    auth = {"Authorization": f"Bearer {access}"}
    stranger_auth = {"Authorization": f"Bearer {stranger_access}"}
    url = lambda path: f"{BASE}/api/customer/chat{path}"  # noqa: E731

    try:
        probe = requests.get(url("/conversation"), headers=auth, timeout=8)
        if probe.status_code == 404:
            print("  SKIP  the running server predates CR-9 slice 2 — restart it to cover REST")
            return check.report()

        r = requests.get(url("/conversation"), timeout=8)
        check("the chat requires a session", r.status_code in (401, 403), f"got {r.status_code}")

        check("GET /conversation opens the chat", probe.status_code == 200, probe.text[:180])
        opened = probe.json()
        check(
            "it returns the header AND the first page in one round trip",
            "conversation" in opened and "messages" in opened,
            str(sorted(opened)),
        )
        rest_conversation_id = opened["conversation"]["conversation_id"]
        check(
            "no internal id for the agent is exposed",
            "assigned_admin_id" not in opened["conversation"],
            str(sorted(opened["conversation"])),
        )

        r = requests.get(url("/conversation"), headers=stranger_auth, timeout=8)
        check(
            "a different customer gets their OWN conversation, not this one",
            r.status_code == 200
            and r.json()["conversation"]["conversation_id"] != rest_conversation_id,
        )

        client_msg_id = uuid.uuid4().hex
        body = {"body": "Sent over REST", "client_msg_id": client_msg_id}
        r1 = requests.post(url("/messages"), json=body, headers=auth, timeout=8)
        check("POST /messages creates a message", r1.status_code == 201, r1.text[:180])
        check("the first send reports created=true", r1.json()["created"] is True)
        sent_id = r1.json()["message"]["message_id"]

        r2 = requests.post(url("/messages"), json=body, headers=auth, timeout=8)
        check("a replayed send reports created=false", r2.json()["created"] is False)
        check(
            "a replayed send returns the same message",
            r2.json()["message"]["message_id"] == sent_id,
        )

        r = requests.post(url("/messages"), json={"body": "   "}, headers=auth, timeout=8)
        check("an empty message is rejected", r.status_code == 400, f"got {r.status_code}")

        r = requests.post(url("/messages"), json={"body": "x" * 5000}, headers=auth, timeout=8)
        check(
            "an over-long message is rejected at the edge",
            r.status_code == 422, f"got {r.status_code}",
        )

        r = requests.get(
            url("/messages"), params={"before_id": 10, "after_id": 20}, headers=auth, timeout=8,
        )
        check("before_id and after_id together is a 400", r.status_code == 400)

        r = requests.get(url("/messages"), params={"limit": 500}, headers=auth, timeout=8)
        check("an absurd limit is rejected, not honoured", r.status_code == 422)

        # An agent replies, and leaves a note the customer must never see.
        with SessionLocal() as db:
            conv = chat.get_for_admin(db, rest_conversation_id)
            reply = chat.post_admin_message(
                db, conv, admin_id=ADMIN_ID, admin_name=ADMIN_NAME, body="On it.",
            )
            chat.post_admin_message(
                db, conv, admin_id=ADMIN_ID, admin_name=ADMIN_NAME,
                body="internal: do not show", is_internal=True,
            )
            db.commit()
            reply_id = reply.message_id

        r = requests.get(url("/messages"), params={"limit": 100}, headers=auth, timeout=8)
        bodies = [m["body"] for m in r.json()]
        check(
            "an internal note never reaches the customer over REST",
            not any("do not show" in (b or "") for b in bodies),
            str(bodies),
        )
        check("the agent's real reply does reach them", "On it." in bodies)
        check(
            "the agent's name is shown, their id is not",
            all("sender_admin_id" not in m for m in r.json()),
        )

        r = requests.post(
            url("/read"), json={"up_to_message_id": reply_id}, headers=auth, timeout=8,
        )
        check(
            "POST /read clears the badge",
            r.status_code == 200 and r.json()["unread_count"] == 0, r.text[:150],
        )

        r = requests.delete(url(f"/messages/{sent_id}"), headers=auth, timeout=8)
        check("a customer can delete their own message", r.status_code == 204, r.text[:120])

        r = requests.get(url("/messages"), params={"limit": 100}, headers=auth, timeout=8)
        deleted = [m for m in r.json() if m["message_id"] == sent_id]
        check("the deleted message survives as a tombstone", len(deleted) == 1)
        check(
            "its body is blanked server-side, not client-side",
            bool(deleted) and deleted[0]["body"] is None,
        )

        r = requests.delete(url(f"/messages/{reply_id}"), headers=auth, timeout=8)
        check(
            "a customer cannot delete the agent's message",
            r.status_code in (400, 404), f"got {r.status_code}",
        )

        r = requests.delete(url(f"/messages/{sent_id}"), headers=stranger_auth, timeout=8)
        check(
            "another customer cannot delete this message, and gets 404 not 403",
            r.status_code == 404, f"got {r.status_code}",
        )
    finally:
        _cleanup(stranger_id)
    conversation_id_for_ws = rest_conversation_id

    # == 14. the broker (slice 3) ==
    #
    # Backend-agnostic: these are the guarantees the gateway relies on, and
    # they must hold whether the broker is Redis or the in-process fallback.
    print("\n== the broker ==")
    import asyncio  # noqa: PLC0415

    from app.services import chat_broker  # noqa: PLC0415

    broker = chat_broker.get_broker()
    check(f"a broker is configured ({broker.describe()})", broker is not None)

    async def _broker_checks():
        ticket = await broker.issue_ticket(customer_id)
        first = await broker.redeem_ticket(ticket)
        second = await broker.redeem_ticket(ticket)
        unknown = await broker.redeem_ticket("not-a-real-ticket")

        # Fan-out: a subscriber gets what a publisher publishes.
        received = []
        sub = broker.subscribe(conversation_id_for_ws)

        async def listen():
            async with sub as stream:
                async for payload in stream:
                    received.append(payload)
                    return

        task = asyncio.create_task(listen())
        await asyncio.sleep(0.35)          # let the subscription establish
        await broker.publish(conversation_id_for_ws, {"event": "probe", "data": {"n": 1}})
        try:
            await asyncio.wait_for(task, timeout=5)
        except asyncio.TimeoutError:
            task.cancel()
        return first, second, unknown, received

    first, second, unknown, received = asyncio.run(_broker_checks())
    check("a ticket redeems to its customer", first == customer_id, f"got {first}")
    check("a ticket is SINGLE USE — the replay gets nothing", second is None, f"got {second}")
    check("an unknown ticket gets nothing", unknown is None, f"got {unknown}")
    check(
        "a subscriber receives what is published",
        len(received) == 1 and received[0].get("event") == "probe",
        str(received),
    )

    # THE REGRESSION THAT REACHED PRODUCTION ON 2026-09-07.
    # A published payload must be JSON-serialisable, because Redis carries
    # bytes. The message envelope is built by model_dump(), which returns real
    # datetime objects unless mode="json" is asked for — and the in-process
    # broker used to accept them happily, so 110 tests passed and every live
    # send then died with "Object of type datetime is not JSON serializable",
    # after storing and acking the message. Both brokers serialise now, and
    # this asserts the shape they must accept.
    import datetime as _dt  # noqa: PLC0415

    from app.schemas.customer_chat import ChatMessageResponse  # noqa: PLC0415

    sample = ChatMessageResponse(
        message_id=1, conversation_id=1, sender_type="customer",
        body="probe", message_type="text",
        created_at=_dt.datetime.now(_dt.timezone.utc),
        read_at=_dt.datetime.now(_dt.timezone.utc),
    )
    dumped = sample.model_dump(mode="json")
    try:
        json.dumps({"event": "receive_message", "data": dumped})
        serialisable = True
    except TypeError:
        serialisable = False
    check("a message payload is JSON-serialisable as published", serialisable)
    check(
        "timestamps leave the model as strings, not datetimes",
        isinstance(dumped["created_at"], str),
        f"created_at is {type(dumped['created_at']).__name__}",
    )

    async def _publish_a_real_message():
        """Publish the actual envelope shape through the actual broker."""
        try:
            await broker.publish(conversation_id_for_ws, {
                "event": "receive_message", "data": dumped, "internal": False,
            })
            return None
        except Exception as exc:  # noqa: BLE001
            return repr(exc)

    failure = asyncio.run(_publish_a_real_message())
    check("publishing a real message envelope does not raise", failure is None, failure or "")

    # == 15. the WebSocket gateway (slice 3) ==
    print("\n== the WebSocket gateway ==")
    try:
        from websockets.asyncio.client import connect as ws_connect  # noqa: PLC0415
        from websockets.exceptions import (  # noqa: PLC0415
            ConnectionClosed, InvalidStatus,
        )
    except ImportError:
        print("  SKIP  the `websockets` client is not installed")
        return check.report()

    ws_base = BASE.replace("https://", "wss://").replace("http://", "ws://")

    ws_partial: dict = {}

    async def _ws_checks():
        # Populated in place, not returned, so that a raise part-way through
        # still leaves the caller able to see whether the socket ever connected.
        results = ws_partial

        # A bad ticket must be refused, and refused with the code that says so.
        try:
            async with ws_connect(f"{ws_base}/api/customer/chat/ws?ticket=rubbish") as ws:
                await asyncio.wait_for(ws.recv(), timeout=4)
            results["bad_ticket_closed"] = False
        except (ConnectionClosed, InvalidStatus, OSError, asyncio.TimeoutError) as exc:
            code = getattr(exc, "code", None) or getattr(
                getattr(exc, "rcvd", None), "code", None)
            results["bad_ticket_closed"] = True
            results["bad_ticket_code"] = code

        # A real ticket, obtained the way the browser obtains one.
        issued = requests.post(
            f"{BASE}/api/customer/chat/ws-ticket", headers=auth, timeout=8,
        )
        results["ticket_status"] = issued.status_code
        ticket = issued.json().get("ticket") if issued.status_code == 200 else None
        if not ticket:
            return results

        async with ws_connect(f"{ws_base}/api/customer/chat/ws?ticket={ticket}") as ws:
            joined = json.loads(await asyncio.wait_for(ws.recv(), timeout=6))
            results["joined_event"] = joined.get("event")
            results["joined_conversation"] = joined.get("data", {}).get("conversation_id")

            # A second socket for the SAME conversation. On one worker this
            # proves the registry; with Redis and two workers it is the real
            # cross-process fan-out test (section 16).
            second_ticket = requests.post(
                f"{BASE}/api/customer/chat/ws-ticket", headers=auth, timeout=8,
            ).json()["ticket"]
            async with ws_connect(
                f"{ws_base}/api/customer/chat/ws?ticket={second_ticket}"
            ) as listener:
                await asyncio.wait_for(listener.recv(), timeout=6)   # its own 'joined'

                client_msg_id = uuid.uuid4().hex
                await ws.send(json.dumps({
                    "event": "send_message",
                    "data": {"body": "over the socket", "client_msg_id": client_msg_id},
                }))

                ack, echo, heard = None, None, None
                deadline = asyncio.get_event_loop().time() + 8
                while (ack is None or echo is None) and asyncio.get_event_loop().time() < deadline:
                    frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=6))
                    if frame.get("event") == "message_ack":
                        ack = frame["data"]
                    elif frame.get("event") == "receive_message":
                        echo = frame["data"]
                try:
                    while True:
                        frame = json.loads(await asyncio.wait_for(listener.recv(), timeout=6))
                        if frame.get("event") == "receive_message":
                            heard = frame["data"]
                            break
                except asyncio.TimeoutError:
                    pass

                results["ack"] = ack
                results["echo_body"] = (echo or {}).get("body")
                results["second_socket_heard"] = (heard or {}).get("body")

                # Typing is relayed and never stored.
                await ws.send(json.dumps({"event": "typing_start", "data": {}}))
                try:
                    while True:
                        frame = json.loads(await asyncio.wait_for(listener.recv(), timeout=5))
                        if frame.get("event") == "typing":
                            results["typing"] = frame["data"]
                            break
                except asyncio.TimeoutError:
                    results["typing"] = None

                # An unknown event is refused, not ignored.
                await ws.send(json.dumps({"event": "nonsense", "data": {}}))
                try:
                    while True:
                        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                        if frame.get("event") == "error":
                            results["unknown_event_error"] = frame["data"].get("code")
                            break
                except asyncio.TimeoutError:
                    results["unknown_event_error"] = None
        return results

    # A SKIP AND A FAILURE ARE NOT THE SAME THING, and conflating them cost a
    # production bug. This used to treat ANY exception as "could not reach the
    # WebSocket" and skip the whole section — so when a real defect made the
    # gateway stop answering, the timeout was reported as an absent dependency
    # and the run went green.
    #
    # Not being able to CONNECT is a skip. Connecting and then not behaving is a
    # failure, and is reported as one.
    ws_results, ws_error = {}, None
    try:
        ws_results = asyncio.run(_ws_checks())
    except Exception as exc:  # noqa: BLE001
        ws_error = exc

    ws_results = ws_results or ws_partial
    reached = bool(ws_partial.get("ticket_status") == 200)
    if ws_error is not None and not reached:
        print(f"  SKIP  the WebSocket could not be reached: {ws_error!r}")
        return check.report()
    if ws_error is not None:
        check(
            "the gateway answered every step after connecting",
            False, f"connected, then failed: {ws_error!r}",
        )

    check("a rubbish ticket is refused", ws_results.get("bad_ticket_closed") is True)
    check(
        "it is refused with 4401, not a generic close",
        ws_results.get("bad_ticket_code") in (4401, None),
        f"code={ws_results.get('bad_ticket_code')}",
    )
    check("POST /ws-ticket issues a ticket", ws_results.get("ticket_status") == 200)
    check("the socket greets with `joined`", ws_results.get("joined_event") == "joined")
    check(
        "it joins the caller's own conversation",
        ws_results.get("joined_conversation") is not None,
    )
    ack = ws_results.get("ack") or {}
    check("a socket send is acknowledged", bool(ack.get("message_id")), str(ack))
    check("the ack carries the client_msg_id back", bool(ack.get("client_msg_id")))
    check(
        "the sender receives the stored message",
        ws_results.get("echo_body") == "over the socket",
        str(ws_results.get("echo_body")),
    )
    check(
        "a SECOND socket on the same conversation receives it too",
        ws_results.get("second_socket_heard") == "over the socket",
        str(ws_results.get("second_socket_heard")),
    )
    typing = ws_results.get("typing") or {}
    check("typing is relayed to the other socket", typing.get("is_typing") is True, str(typing))
    check(
        "an unknown event is refused rather than ignored",
        ws_results.get("unknown_event_error") == "unknown_event",
        str(ws_results.get("unknown_event_error")),
    )

    with SessionLocal() as db:
        stored = db.execute(text(
            "SELECT count(*) FROM customer_chat_messages WHERE body = 'over the socket'"
        )).scalar()
        check("the socket message was persisted, not just broadcast", stored >= 1, f"{stored}")
        # Typing is not "not stored by convention" — it is UNSTORABLE. The
        # enum has no such label, so an attempt to write one is a database
        # error rather than a row nobody noticed. Asserting on the enum says
        # that; counting rows of a type that cannot exist just raises
        # InvalidTextRepresentation, which is how this check was first written.
        labels = {r[0] for r in db.execute(text(
            "SELECT enumlabel FROM pg_enum e "
            "JOIN pg_type t ON t.oid = e.enumtypid "
            "WHERE t.typname = 'customer_chat_message_type_enum'"
        ))}
        check(
            "typing cannot be stored — the message-type enum has no such value",
            "typing" not in labels and labels == {"text", "image", "file", "system"},
            str(sorted(labels)),
        )



    # == 17. the agent console (slice 4) ==
    #
    # The customer side is scoped by the caller's own id; this side cannot be,
    # because an agent's job is reading other people's conversations. So the
    # thing worth testing here is the OPPOSITE property: that the role gate is
    # the only thing standing between a customer token and every conversation in
    # the system.
    print("\n== the agent console ==")
    # config.login() drives the REAL two-step OTP flow and waits out the login
    # rate limit, which a hand-rolled POST here would trip on a full suite run.
    from config import ADMIN, H, login as portal_login  # noqa: PLC0415

    try:
        admin_token = portal_login(*ADMIN)
    except Exception as exc:  # noqa: BLE001 - a missing admin is a skip, not a failure
        print(f"  SKIP  could not sign in as admin: {exc!r}")
        return check.report()
    if not admin_token:
        print("  SKIP  no admin session — set JPW_ADMIN_EMAIL / JPW_ADMIN_PASSWORD")
        return check.report()
    admin_auth = H(admin_token)
    aurl = lambda p: f"{BASE}/api/admin/chat{p}"  # noqa: E731

    # A CUSTOMER TOKEN MUST NOT REACH THE AGENT CONSOLE. This is the check that
    # matters most in this section: the customer endpoints are scoped, so a leak
    # there exposes one conversation; a leak here exposes all of them.
    r = requests.get(aurl("/conversations"), headers=auth, timeout=8)
    check(
        "a CUSTOMER token cannot read the agent queue",
        r.status_code in (401, 403), f"got {r.status_code}",
    )
    r = requests.get(aurl("/conversations"), timeout=8)
    check("the agent queue requires a session", r.status_code in (401, 403), f"got {r.status_code}")

    r = requests.get(aurl("/conversations"), headers=admin_auth, timeout=8)
    check("an admin can read the queue", r.status_code == 200, r.text[:180])
    if r.status_code != 200:
        return check.report()
    queue = r.json()
    check(
        "the queue returns counts and conversations together",
        set(queue) == {"counts", "conversations"}, str(sorted(queue)),
    )
    check(
        "counts cover every status",
        set(queue["counts"]) == {"waiting", "active", "resolved", "closed"},
        str(sorted(queue["counts"])),
    )

    # The conversation this script has been building all along must be in there.
    r = requests.get(
        aurl("/conversations"), headers=admin_auth,
        params={"q": str(conversation_id_for_ws)}, timeout=8,
    )
    found = [c for c in r.json()["conversations"]
             if c["conversation_id"] == conversation_id_for_ws]
    check("search by conversation id finds it", len(found) == 1, str(len(found)))
    if found:
        check(
            "the queue row carries the customer, not just an id",
            found[0].get("customer_email") is not None,
            str(found[0]),
        )

    r = requests.get(aurl(f"/conversations/{conversation_id_for_ws}"), headers=admin_auth, timeout=8)
    check("an admin can open a thread", r.status_code == 200, r.text[:150])
    thread = r.json()

    # An internal note was written in section 13. The agent must see it; the
    # customer must not. Section 13 already proved the second half.
    note_visible = any("do not show" in (m.get("body") or "") for m in thread["messages"])
    check("the agent DOES see the internal note the customer cannot", note_visible)

    r = requests.get(aurl("/conversations/99999999"), headers=admin_auth, timeout=8)
    check("a missing conversation is a 404", r.status_code == 404, f"got {r.status_code}")

    # Replying, and the note that must not be delivered.
    r = requests.post(
        aurl(f"/conversations/{conversation_id_for_ws}/messages"),
        json={"body": "Agent reply over REST"}, headers=admin_auth, timeout=8,
    )
    check("an agent can reply", r.status_code == 201, r.text[:180])
    check("the reply is attributed to the agent", (r.json() or {}).get("sender_type") == "admin")

    r = requests.post(
        aurl(f"/conversations/{conversation_id_for_ws}/messages"),
        json={"body": "note: escalate to finance", "is_internal": True},
        headers=admin_auth, timeout=8,
    )
    check("an agent can leave an internal note", r.status_code == 201, r.text[:150])

    customer_view = requests.get(
        f"{BASE}/api/customer/chat/messages", params={"limit": 100}, headers=auth, timeout=8,
    ).json()
    bodies = [m.get("body") for m in customer_view]
    check("the agent's reply reaches the customer", "Agent reply over REST" in bodies)
    check(
        "the internal note does NOT reach the customer",
        not any("escalate to finance" in (b or "") for b in bodies),
        str(bodies[-3:]),
    )

    # Status machine, through the API this time.
    r = requests.post(
        aurl(f"/conversations/{conversation_id_for_ws}/status"),
        json={"status": "closed"}, headers=admin_auth, timeout=8,
    )
    check("an agent can close a conversation", r.status_code == 200, r.text[:150])
    r = requests.post(
        aurl(f"/conversations/{conversation_id_for_ws}/status"),
        json={"status": "active"}, headers=admin_auth, timeout=8,
    )
    check(
        "closed is terminal through the API too",
        r.status_code == 400, f"got {r.status_code}",
    )
    r = requests.post(
        aurl(f"/conversations/{conversation_id_for_ws}/status"),
        json={"status": "banana"}, headers=admin_auth, timeout=8,
    )
    check("an unknown status is refused by the schema", r.status_code == 422, f"got {r.status_code}")

    r = requests.get(aurl("/agents"), headers=admin_auth, timeout=8)
    check("the transfer target list loads", r.status_code == 200, r.text[:150])
    check(
        "it contains only admins",
        all(a["role"] in ("admin", "super_admin") for a in r.json()),
        str(r.json()[:3]),
    )

    r = requests.post(aurl("/ws-ticket"), headers=admin_auth, timeout=8)
    check("an agent can get a socket ticket", r.status_code == 200, r.text[:120])
    agent_ticket = r.json().get("ticket") if r.status_code == 200 else None

    # THE CROSS-NAMESPACE CHECK. Both tables number from 1, so an admin ticket
    # presented at the customer socket must be refused on TYPE, not just id.
    if agent_ticket:
        async def _wrong_door():
            try:
                async with ws_connect(
                    f"{ws_base}/api/customer/chat/ws?ticket={agent_ticket}"
                ) as ws:
                    await asyncio.wait_for(ws.recv(), timeout=4)
                return False
            except Exception:
                return True

        check(
            "an ADMIN ticket cannot open a CUSTOMER socket",
            asyncio.run(_wrong_door()),
        )

    # == 16. TWO PROCESSES, ONE CONVERSATION ==
    #
    # THE ONLY CHECK IN THIS FILE THAT TESTS WHAT SLICE 3 IS FOR.
    #
    # Everything above runs in one process, where an in-process dictionary is
    # indistinguishable from a real broker. Production runs WEB_CONCURRENCY=2:
    # gunicorn forks, the two workers share no memory, and a customer's socket
    # and an agent's socket routinely land on different ones. If fan-out is
    # per-process, roughly half of all messages are delivered to nobody, with no
    # exception raised and nothing in the log.
    #
    # So this publishes from a SEPARATE OS PROCESS and subscribes here. It is
    # the same question the two workers ask, reduced to its smallest form: does
    # a publish over there arrive over here?
    #
    # It skips without REDIS_URL, because without it the answer is known and is
    # "no" — see chat_broker.InProcessBroker.
    print("\n== two processes, one conversation ==")
    if not settings.redis_url:
        print("  SKIP  REDIS_URL is not set — the cross-process guarantee is untested.")
        print("        Start Redis and re-run:")
        print("          docker run -d --name jpw-redis-dev -p 6379:6379 redis:7-alpine")
        print("          REDIS_URL=redis://127.0.0.1:6379/0 python tests/verify_live_chat.py")
        return check.report()

    import subprocess  # noqa: PLC0415

    publisher = f'''
import asyncio, sys
sys.path.insert(0, {str(BACKEND)!r})
from app.services.chat_broker import get_broker
async def main():
    broker = get_broker()
    await asyncio.sleep(1.2)              # let the parent subscribe first
    await broker.publish({conversation_id_for_ws}, {{"event": "cross_process", "data": {{"ok": True}}}})
asyncio.run(main())
'''

    async def _cross_process():
        broker = chat_broker.get_broker()
        received = []
        sub = broker.subscribe(conversation_id_for_ws)

        async def listen():
            async with sub as stream:
                async for payload in stream:
                    received.append(payload)
                    return

        task = asyncio.create_task(listen())
        await asyncio.sleep(0.5)
        child = subprocess.Popen(
            [sys.executable, "-c", publisher],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            await asyncio.wait_for(task, timeout=15)
        except asyncio.TimeoutError:
            task.cancel()
        out, err = child.communicate(timeout=20)
        return received, child.returncode, err.decode(errors="replace")[-400:]

    chat_broker.reset_broker_for_tests()
    received, rc, stderr = asyncio.run(_cross_process())

    check("the publishing process exited cleanly", rc == 0, stderr)
    check(
        "a message published in ANOTHER PROCESS arrived here",
        len(received) == 1 and received[0].get("event") == "cross_process",
        f"received={received}",
    )
    check(
        "the broker in use is Redis, not the in-process fallback",
        "redis" in chat_broker.get_broker().describe(),
        chat_broker.get_broker().describe(),
    )

    return check.report()


if __name__ == "__main__":
    raise SystemExit(main())
