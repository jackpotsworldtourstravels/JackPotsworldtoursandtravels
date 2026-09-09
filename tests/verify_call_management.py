"""CR-10 follow-up — call ownership, hold and transfer, verified over real sockets.

WHY THIS IS SEPARATE FROM verify_voice_calls.py
That script proves a frame sent by one browser arrives at the right other
browser — the relay, and nothing above it. This one is about what happens to a
call once two people are actually on it: who owns it, who else may be rung, what
a hold costs, and every way a transfer can end. Those are state-machine
questions, and mixing them into the signalling script would make a failure in
either one harder to place.

THE THREE CHECKS THAT MATTER MOST, because each one was a real defect:

* A DECLINED TRANSFER MUST NOT END THE CALL. Agent B pressing Reject on a
  handover used to run the ordinary `call_reject` path, which marked the *live*
  call rejected and hung up on a customer who was mid-sentence with agent A and
  had nothing to do with the transfer.

* A HOLD MUST REACH BOTH PARTIES. `hold()` passed a `{"event", "data"}` wrapper
  to `_notify_both`, which hardcoded `call_status` and read `conversation_id`
  off it — a KeyError, so nobody was ever told. It looked like it worked
  because the browser that pressed the button applies hold locally.

* AN AGENT ON A CALL IS NOT AVAILABLE. Presence alone rang the agent who was
  already talking to somebody; `accept()` then answered them with `call_busy`,
  which is an apology for an interruption that should not have happened.

Two admin accounts are required, and ADMIN2 is deliberately a second Admin
rather than the Super Admin — a transfer needs somebody who can legitimately be
offered a call.
"""
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import requests  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_customer import Customer, CustomerCall  # noqa: E402
from app.services import customer_call_service as calls  # noqa: E402
from app.services.customer_auth_service import (  # noqa: E402
    issue_tokens, next_customer_code,
)

from config import ADMIN, ADMIN2, BASE, Checker, H, login as portal_login  # noqa: E402

check = Checker()
WS_BASE = BASE.replace("https://", "wss://").replace("http://", "ws://")


async def _recv_until(ws, wanted, timeout=8.0):
    """Read past uninteresting frames until one of `wanted` arrives, or give up.

    Both sockets carry chat traffic, presence and status updates; demanding
    that the very next frame be the wanted one fails on timing rather than on
    behaviour, which is the sort of flake that gets a suite ignored.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        remaining = deadline - loop.time()
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
    await ws.send(json.dumps({"event": event, "data": data}))


def _row(public_id):
    """The call as the database has it — the only opinion that settles a race."""
    with SessionLocal() as db:
        call = calls.get_by_public_id(db, public_id)
        return {
            "status": call.status,
            "admin_id": call.admin_id,
            "hold_seconds": call.hold_seconds,
            "held_since": call.held_since,
            "chain": list(call.transfer_chain or []),
            "pending": call.transfer_to_admin_id,
        }


def _make_customer(db) -> Customer:
    customer = Customer(
        customer_code=next_customer_code(db),
        full_name="CR-10 Call Management",
        email=f"cr10mgmt-{uuid.uuid4().hex[:12]}@example.com",
        mobile=f"+9199{uuid.uuid4().int % 10**8:08d}",
    )
    db.add(customer)
    db.flush()
    return customer


def _ticket(token, portal):
    return requests.post(
        f"{BASE}/api/{portal}/chat/ws-ticket", headers=H(token), timeout=8,
    ).json()["ticket"]


def main() -> int:
    with SessionLocal() as db:
        try:
            db.execute(CustomerCall.__table__.select().limit(1)).all()
        except Exception:  # noqa: BLE001
            print("SKIP  the voice-call migrations are not applied to this database.")
            return check.report()

    try:
        from websockets.asyncio.client import connect as ws_connect  # noqa: PLC0415
    except ImportError:
        print("  SKIP  the `websockets` client is not installed")
        return check.report()

    try:
        admin1 = portal_login(*ADMIN)
        admin2 = portal_login(*ADMIN2)
    except Exception as exc:  # noqa: BLE001
        print(f"  SKIP  could not sign in two admins: {exc!r}")
        return check.report()

    id1 = requests.get(f"{BASE}/api/auth/me", headers=H(admin1), timeout=8).json()["id"]
    id2 = requests.get(f"{BASE}/api/auth/me", headers=H(admin2), timeout=8).json()["id"]

    with SessionLocal() as db:
        caller = _make_customer(db)
        latecomer = _make_customer(db)
        db.commit()
        caller_token, _ = issue_tokens(caller)
        late_token, _ = issue_tokens(latecomer)
        made = [caller.customer_id, latecomer.customer_id]

    async def _flow():
        async with ws_connect(f"{WS_BASE}/api/customer/chat/ws?ticket={_ticket(caller_token, 'customer')}") as cws, \
                   ws_connect(f"{WS_BASE}/api/customer/chat/ws?ticket={_ticket(late_token, 'customer')}") as cws2, \
                   ws_connect(f"{WS_BASE}/api/admin/chat/ws?ticket={_ticket(admin1, 'admin')}") as aws1, \
                   ws_connect(f"{WS_BASE}/api/admin/chat/ws?ticket={_ticket(admin2, 'admin')}") as aws2:
            await _recv_until(cws, {"joined"})
            await _recv_until(cws2, {"joined"})

            print("\n== one call, one owner ==")
            await _send(cws, "call_request", {})
            rung1 = await _recv_until(aws1, {"incoming_call"}, 10)
            rung2 = await _recv_until(aws2, {"incoming_call"}, 10)
            if not check("both online agents are rung", bool(rung1 and rung2)):
                return
            call_id = rung1[1]["call_id"]
            await _recv_until(cws, {"call_status"}, 8)
            await _send(aws1, "call_accept", {"call_id": call_id})
            await _recv_until(cws, {"call_accepted"}, 8)
            check(
                "THE AGENT WHO LOST IS TOLD IT WAS CLAIMED",
                await _recv_until(aws2, {"call_claimed"}, 8) is not None,
            )
            await _send(cws, "call_connected", {"call_id": call_id})
            await _recv_until(cws, {"call_status"}, 8)
            check("the call belongs to the agent who answered",
                  _row(call_id)["admin_id"] == id1, _row(call_id))

            print("\n== an agent on a call is not available ==")
            await _send(cws2, "call_request", {})
            intruder = await _recv_until(aws1, {"incoming_call"}, 4)
            check("A BUSY AGENT IS NOT RUNG by a second customer",
                  intruder is None, intruder and intruder[1])
            second = await _recv_until(aws2, {"incoming_call"}, 6)
            check("...but a free agent still is", second is not None)
            if second:
                await _send(aws2, "call_reject", {"call_id": second[1]["call_id"]})
                await _recv_until(cws2, {"call_status"}, 6)

            print("\n== hold reaches both parties, and is counted ==")
            await _send(aws1, "call_hold", {"call_id": call_id})
            held = await _recv_until(cws, {"call_hold"}, 6)
            check("THE CUSTOMER IS TOLD THE CALL IS ON HOLD",
                  bool(held) and held[1].get("on_hold") is True, held)
            check("the row opens a hold bracket",
                  _row(call_id)["held_since"] is not None)
            await asyncio.sleep(2.2)
            await _send(aws1, "call_resume", {"call_id": call_id})
            resumed = await _recv_until(cws, {"call_hold"}, 6)
            check("and told when it resumes",
                  bool(resumed) and resumed[1].get("on_hold") is False, resumed)
            row = _row(call_id)
            check("the held seconds are banked", row["hold_seconds"] >= 2, row)
            check("and the bracket is closed", row["held_since"] is None, row)
            check("a hold does not end the call", row["status"] == "connected", row)

            print("\n== a declined transfer ==")
            await _send(aws1, "call_transfer", {"call_id": call_id, "to_admin_id": id2})
            check("the transferring agent sees it ringing",
                  await _recv_until(aws1, {"call_transfer_ringing"}, 8) is not None)
            offered = await _recv_until(aws2, {"incoming_call"}, 8)
            check("the other agent is offered the call",
                  bool(offered) and offered[1].get("is_transfer") is True, offered)
            await _send(aws2, "call_reject", {"call_id": call_id})
            check("the transferring agent is told it failed",
                  await _recv_until(aws1, {"call_transfer_failed"}, 8) is not None)
            row = _row(call_id)
            check("THE CALL SURVIVES A DECLINED TRANSFER",
                  row["status"] == "connected", row)
            check("...and still belongs to the agent who had it",
                  row["admin_id"] == id1, row)
            check("...and the offer is withdrawn", row["pending"] is None, row)

            print("\n== an accepted transfer ==")
            await _send(aws1, "call_transfer", {"call_id": call_id, "to_admin_id": id2})
            await _recv_until(aws1, {"call_transfer_ringing"}, 8)
            await _recv_until(aws2, {"incoming_call"}, 8)
            await _send(aws2, "call_accept", {"call_id": call_id})
            check("the first agent is told they handed it over",
                  await _recv_until(aws1, {"call_transferred"}, 8) is not None)
            check("THE CUSTOMER IS NOT ASKED TO ANSWER AGAIN",
                  await _recv_until(cws, {"call_renegotiate"}, 8) is not None)
            row = _row(call_id)
            check("the call is now the second agent's", row["admin_id"] == id2, row)
            check("THE CUSTOMER IS NEVER DISCONNECTED",
                  row["status"] == "connected", row)
            check("the handover is recorded", len(row["chain"]) == 1, row["chain"])
            if row["chain"]:
                hop = row["chain"][0]
                check("...naming both ends of it",
                      hop.get("from_admin_id") == id1 and hop.get("to_admin_id") == id2,
                      hop)

            print("\n== what the finished call remembers ==")
            await _send(aws2, "call_end", {"call_id": call_id})
            await _recv_until(cws, {"call_status"}, 8)
            row = _row(call_id)
            check("the call ends", row["status"] == "ended", row)
            check("hold time survives into history", row["hold_seconds"] >= 2, row)
            check("the transfer chain survives into history",
                  len(row["chain"]) == 1, row["chain"])

            history = requests.get(
                f"{BASE}/api/customer/chat/calls", headers=H(caller_token), timeout=8,
            ).json()
            latest = (history.get("calls") or [{}])[0]
            check("the call log reports hold time",
                  latest.get("hold_seconds", 0) >= 2, latest)
            check("the call log reports the transfer chain",
                  len(latest.get("transfer_chain") or []) == 1, latest)
            check(
                "THE CUSTOMER'S CHAIN CARRIES NO STAFF IDS",
                all("to_admin_id" not in hop and "from_admin_id" not in hop
                    for hop in (latest.get("transfer_chain") or [])),
                latest.get("transfer_chain"),
            )

    try:
        asyncio.run(_flow())
    finally:
        with SessionLocal() as db:
            for customer_id in made:
                db.execute(delete(Customer).where(Customer.customer_id == customer_id))
            db.commit()

    return check.report()


if __name__ == "__main__":
    sys.exit(main())
