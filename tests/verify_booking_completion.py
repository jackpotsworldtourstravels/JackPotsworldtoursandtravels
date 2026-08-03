"""Ticket Issued is not Completed — a booking completes when the journey has.

WHAT CHANGED
Issuing a ticket used to walk the booking straight to Completed, and an Admin
could also press "Mark Completed" the moment the ticket was uploaded. Both said
the trip was over before anyone had travelled, so "Completed Tickets" on every
dashboard counted tickets sold rather than trips taken.

Issuance now ends at **Ticket Issued**. **Completed** arrives on its own once
the scheduled journey is behind us, swept on a timer by
``booking_completion_service``.

WHAT THIS PROTECTS

1. **The manual route is gone, not hidden.** ``POST /admin/requests/{id}/complete``
   404s, and the action menu at Ticket Issued offers no Completed edge — so
   neither a portal nor a curl can declare a trip finished early.
2. **Nothing financial moved.** The wallet is still debited at issuance, for the
   full fare, before any of this runs. This is the assertion that would catch
   someone "tidying up" by moving the debit to completion.
3. **The end of the journey is the RETURN leg.** A round trip whose outbound has
   flown but whose return has not is *not* complete. Getting this wrong marks
   trips finished while the passengers are still away, and it is invisible on a
   one-way booking — which is most of them.
4. **The clock is read in local time.** Travel dates and "HH:MM" departures are
   bare values written against an Indian departure board; reading them as UTC
   would complete every booking 5½ hours late.
5. **The sweep is idempotent and self-limiting.** Running it twice completes
   nothing the second time, and it never touches a booking that is not Ticket
   Issued — which is what makes a timer safe to run every fifteen minutes.
6. **Completed is still cancellable.** The post-travel settlement edge
   (``lifecycle.SETTLEMENT_TRANSITIONS``) must survive a change that removed the
   *other* edge out of Ticket Issued.

WHAT IS DELIBERATELY NOT RE-TESTED
Wallet arithmetic (verify_cr4b) and the Manager path (verify_manager_approval)
own their own ground. This checks where a booking STOPS, and what moves it on.
"""
import datetime
import sys
from decimal import Decimal as D
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import BigInteger, cast, func, literal, select, text  # noqa: E402

from app.config import settings  # noqa: E402
from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import RequestStatus as S  # noqa: E402
from app.models_v2 import ServiceRequest  # noqa: E402
from app.services import booking_completion_service as bcs  # noqa: E402
from app.services import lifecycle  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MERCHANT, Checker, H, login  # noqa: E402

check = Checker()
mtok = login(*MERCHANT)
atok = login(*ADMIN)

UTC = datetime.timezone.utc
IST = datetime.timezone(datetime.timedelta(minutes=330))


def detail(tok, rid):
    return requests.get(f"{BASE}/api/requests/{rid}", headers=H(tok)).json()


def stub(travel_date, preferred_time=None, return_date=None, return_time=None):
    """The three fields `journey_end` reads, with nothing else attached."""
    return SimpleNamespace(
        travel_date=travel_date,
        return_date=return_date,
        travel_details={
            "preferred_time": preferred_time,
            "return_preferred_time": return_time,
        },
    )


# ===========================================================================
print("== the state machine no longer offers a manual completion ==")
# ===========================================================================

check("TICKET_ISSUED has no outgoing edge on the standard track",
      lifecycle.TRANSITIONS[S.TICKET_ISSUED] == (),
      str(lifecycle.TRANSITIONS[S.TICKET_ISSUED]))
check("...nor on the Classic Tours track",
      lifecycle.CLASSIC_TRANSITIONS[S.TICKET_ISSUED] == (),
      str(lifecycle.CLASSIC_TRANSITIONS[S.TICKET_ISSUED]))
check("the automatic table is the only holder of Ticket Issued -> Completed",
      [t.to for t in lifecycle.AUTO_TRANSITIONS[S.TICKET_ISSUED]] == [S.COMPLETED],
      str(lifecycle.AUTO_TRANSITIONS.get(S.TICKET_ISSUED)))
check("a completed booking is still cancellable by settlement",
      any(t.to is S.CANCELLED for t in lifecycle.SETTLEMENT_TRANSITIONS[S.COMPLETED]),
      str(lifecycle.SETTLEMENT_TRANSITIONS.get(S.COMPLETED)))
# The happy path must still PROJECT Completed, or a merchant looking at a
# ticketed booking is told the next thing to happen is nothing at all.
check("Completed is still the last step of both happy paths",
      lifecycle.HAPPY_PATH[-1] is S.COMPLETED and lifecycle.CLASSIC_HAPPY_PATH[-1] is S.COMPLETED,
      f"{lifecycle.HAPPY_PATH[-1]} / {lifecycle.CLASSIC_HAPPY_PATH[-1]}")


# ===========================================================================
print("\n== when a journey is over ==")
# ===========================================================================

today = datetime.date.today()
noon_ist = datetime.datetime(today.year, today.month, today.day, 12, 0, tzinfo=IST)

# A departure at 09:30 IST is over by noon IST, and NOT over at 09:00.
check("a departure earlier today is due",
      bcs.is_due(stub(today, "09:30"), noon_ist.astimezone(UTC)))
check("a departure later today is not",
      not bcs.is_due(stub(today, "15:30"), noon_ist.astimezone(UTC)))
check("tomorrow is never due today",
      not bcs.is_due(stub(today + datetime.timedelta(days=1), "00:01"), noon_ist.astimezone(UTC)))

# THE TIMEZONE ASSERTION. 09:30 IST is 04:00 UTC. At 05:00 UTC the flight has
# gone; a service reading the stored time as UTC would still be waiting.
check("09:30 is read as IST, not UTC",
      bcs.is_due(stub(today, "09:30"),
                 datetime.datetime(today.year, today.month, today.day, 5, 0, tzinfo=UTC)),
      "05:00 UTC is 10:30 IST — after a 09:30 IST departure")
check("...and is not due an hour before that",
      not bcs.is_due(stub(today, "09:30"),
                     datetime.datetime(today.year, today.month, today.day, 3, 0, tzinfo=UTC)))

# THE RETURN LEG DECIDES. Outbound flown, return still ahead => not finished.
check("a round trip with its return still ahead is NOT due",
      not bcs.is_due(
          stub(today - datetime.timedelta(days=2), "09:30",
               return_date=today + datetime.timedelta(days=3), return_time="18:00"),
          noon_ist.astimezone(UTC)),
      "the outbound has flown but the party has not come back")
check("...and IS due once the return has flown too",
      bcs.is_due(
          stub(today - datetime.timedelta(days=5), "09:30",
               return_date=today - datetime.timedelta(days=1), return_time="18:00"),
          noon_ist.astimezone(UTC)))

# A missing time must never complete a booking EARLY.
check("a missing departure time falls back to the end of the day",
      not bcs.is_due(stub(today, None), noon_ist.astimezone(UTC)),
      "23:59 fallback — noon has not passed it")
check("an unparseable departure time does the same",
      not bcs.is_due(stub(today, "not-a-time"), noon_ist.astimezone(UTC)))
check("a booking with no travel date at all is never completed",
      not bcs.is_due(stub(None, "09:30"), noon_ist.astimezone(UTC)),
      "nothing to judge it by")

check("journey_end returns a timezone-aware instant",
      bcs.journey_end(stub(today, "09:30")).tzinfo is not None)
check("the configured buffer is applied",
      bcs.journey_end(stub(today, "09:30"))
      == datetime.datetime(today.year, today.month, today.day, 9, 30, tzinfo=IST)
      + datetime.timedelta(hours=settings.booking_completion_buffer_hours))


# ===========================================================================
print("\n== issuing a ticket stops at Ticket Issued ==")
# ===========================================================================

FARE = D("18400.00")
booking = flows.make_booking(mtok, atok, upto="ticket_issued", fare=str(FARE),
                             label="completion")
rid = booking["id"]

d = detail(mtok, rid)
check("the booking is Ticket Issued, not Completed", d["request"]["status"] == "ticket_issued",
      d["request"]["status"])
check("...and it is not resolved", not d["request"].get("completed_at"),
      str(d["request"].get("completed_at")))

# THE MONEY MUST ALREADY HAVE MOVED. This is the assertion that fails if anyone
# relocates the debit to completion.
check("the fare was captured at issuance", D(str(d["request"]["total_amount"])) == FARE,
      str(d["request"]["total_amount"]))

with SessionLocal() as db:
    row = db.execute(text(
        "SELECT debit FROM wallet_transactions WHERE request_id = :r ORDER BY txn_id DESC LIMIT 1"
    ), {"r": rid}).mappings().first()
check("...and the wallet was debited then, not at completion",
      row is not None and D(str(row["debit"])) == FARE, str(dict(row) if row else None))

# No portal may offer completion, and neither may the API.
admin_actions = [a["to"] for a in detail(atok, rid).get("actions", [])]
check("the Admin's action menu offers no Completed edge",
      "completed" not in admin_actions, str(admin_actions))

r = requests.post(f"{BASE}/api/admin/requests/{rid}/complete", headers=H(atok), json={})
check("POST .../complete is gone -> 404/405", r.status_code in (404, 405),
      f"{r.status_code} {r.text[:160]}")

# The merchant should still be told what is coming.
upcoming = [s["label"] for s in detail(mtok, rid)["timeline"] if s["state"] == "pending"]
check("the timeline still projects Completed as the step ahead",
      "Completed" in upcoming, str(upcoming))


# ===========================================================================
print("\n== the sweep completes it, and only once ==")
# ===========================================================================

with SessionLocal() as db:
    # Nothing has travelled, so a sweep now must leave this booking alone.
    before = db.get(ServiceRequest, rid).status
    bcs.sweep(db)
    still = db.get(ServiceRequest, rid)
    db.refresh(still)
check("a sweep before the travel date changes nothing", still.status is S.TICKET_ISSUED,
      f"{before} -> {still.status}")

with SessionLocal() as db:
    b = db.get(ServiceRequest, rid)
    b.travel_date = datetime.date.today() - datetime.timedelta(days=1)
    b.return_date = None
    db.commit()
    swept = bcs.sweep(db)
check("once the travel date has passed, the sweep completes it", swept >= 1, str(swept))

d = detail(mtok, rid)
check("the booking is Completed", d["request"]["status"] == "completed", d["request"]["status"])
check("...and completed_at was stamped", bool(d["request"].get("completed_at")),
      str(d["request"].get("completed_at")))

hist = [h for h in (d.get("timeline") or []) if h.get("status") == "completed"]
check("the step is on the timeline", bool(hist), str(d.get("timeline"))[:200])
check("...attributed to System rather than to a person",
      bool(hist) and hist[0].get("by") == "System", str(hist[:1]))

with SessionLocal() as db:
    again = bcs.sweep(db)
check("a second sweep completes nothing more", again == 0, str(again))

# THE ADVISORY LOCK IS WHAT PRODUCTION ACTUALLY CALLS, and it is the part most
# able to fail silently: the scheduler swallows exceptions so one bad tick
# cannot kill the loop, which is exactly how a lock that always raises would go
# unnoticed while nothing ever completed. Each assertion below caught a real
# defect: the key must fit in a signed bigint and must be CAST to one, or
# PostgreSQL answers "function pg_try_advisory_lock(numeric) does not exist".
with SessionLocal() as db:
    check("the locked sweep runs without raising", bcs.sweep_once_locked(db) == 0)

# A second connection must be refused while the first holds the lock — that is
# the whole point of it under several gunicorn workers.
holder = SessionLocal()
try:
    got = holder.scalar(
        select(func.pg_try_advisory_lock(cast(literal(bcs._ADVISORY_LOCK_KEY), BigInteger)))
    )
    check("a session can take the sweep lock", got is True, str(got))
    with SessionLocal() as other:
        check("...and a second one then skips its tick instead of contending",
              bcs.sweep_once_locked(other) == 0)
finally:
    holder.execute(
        select(func.pg_advisory_unlock(cast(literal(bcs._ADVISORY_LOCK_KEY), BigInteger)))
    )
    holder.commit()
    holder.close()

# ...and once released, the lock is genuinely free again. A leaked session-level
# lock would silence every later sweep for as long as the app stayed up.
with SessionLocal() as db:
    check("the lock is released after the sweep", bcs.sweep_once_locked(db) == 0)


# ===========================================================================
print("\n== a completed booking is still cancellable ==")
# ===========================================================================

r = requests.post(f"{BASE}/api/bookings/{rid}/cancellation", headers=H(mtok),
                  json={"reason": "No-show; settling the fare after travel."})
check("a cancellation on a completed booking -> 201", r.status_code == 201,
      f"{r.status_code} {r.text[:200]}")

r = requests.post(f"{BASE}/api/bookings/{rid}/reschedule", headers=H(mtok), json={
    "new_travel_date": str(datetime.date.today() + datetime.timedelta(days=90)),
    "reason": "A journey that has already flown cannot be moved.",
})
check("...but a reschedule on it is still refused -> 409", r.status_code == 409,
      f"{r.status_code} {r.text[:200]}")


sys.exit(check.report())
