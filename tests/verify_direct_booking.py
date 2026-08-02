"""Book Directly — a booking raised with no enquiry in front of it.

WHAT THIS PROTECTS

The change adds a second way ONTO the Classic Tours track, not a second track.
Almost everything worth asserting here is therefore an assertion that the new
path is indistinguishable from the old one after the row exists:

1. **It creates a real Classic booking.** Draft, with the merchant's itinerary
   and its passengers, no parent request, and the `direct_booking` marker that
   `lifecycle.CLASSIC_MARKER_KEYS` reads.
2. **It carries no amount, and the merchant cannot give it one.** `total_amount`
   is 0 at creation. This is the whole safety property of the feature: a booking
   nobody quoted must not be priced by the party that owes the money. The fare
   is captured at issuance, and this script walks one all the way there to prove
   the pre-CR-5 capture path is still live and still bills the wallet.
3. **The itinerary validators are inherited, not re-implemented.** From == To, a
   past travel date, a round trip with no return, and party arithmetic that does
   not reconcile are all refused with the same 422 the enquiry form gives —
   because `DirectBookingCreate` subclasses `EnquiryCreate`. A regression here
   means someone restated the rules and they have started to drift.
4. **Submission is no easier than on the enquiry-led path.** The completeness
   rules moved from "does this booking have a TICKET_ENQUIRY parent" to "is this
   on the Classic track", and a direct booking has no parent at all — so a bug
   here is silent: the rules would simply stop applying. Missing contact and a
   missing passport on an international sector must still be 400.
5. **It reaches the Manager.** `manager_service._classic_bookings_filter` is a
   SQL term written separately from the Python predicate; if only one of them
   learned about the new marker, the booking would be decidable but invisible,
   or visible and undecidable. Both are asserted.
6. **Only merchants, and only with `ticket.request`.** An Admin has no merchant
   to bill and must be refused rather than creating an orphan.

WHAT IS DELIBERATELY NOT RE-TESTED
The wallet arithmetic (`verify_cr4a`/`verify_cr4b`) and the Manager approval
rules (`verify_manager_approval`) own their own ground. This script checks that
a directly-raised booking arrives in those machines correctly, not that those
machines work.
"""
import datetime
import sys
from decimal import Decimal as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402

from config import ADMIN, BASE, MANAGER, MERCHANT, Checker, H, PDF, login  # noqa: E402

check = Checker()
mtok = login(*MERCHANT)
atok = login(*ADMIN)
gtok = login(*MANAGER)

TRAVEL = datetime.date.today() + datetime.timedelta(days=60)
EXPIRY = TRAVEL + datetime.timedelta(days=500)


def itinerary(**over):
    """A valid one-way domestic journey, as the Classic form would send it."""
    body = {
        "trip_type": "one_way",
        "origin": "HYD", "origin_city": "Hyderabad",
        "destination": "BOM", "destination_city": "Mumbai",
        "airline": "IndiGo", "flight_number": "6e1423",
        "travel_date": str(TRAVEL), "preferred_time": "09:30",
        "travel_class": "Economy",
        "passenger_count": 1, "adults": 1, "children": 0, "infants": 0,
        "passengers": [{"title": "Mr", "first_name": "Direct", "last_name": "Traveller",
                        "passenger_type": "adult"}],
        "contact": {"name": "Ops Contact", "email": "ops@demotravel.example",
                    "phone": "+919845012345"},
        "notes": "raised without an enquiry",
    }
    body.update(over)
    return body


def create(token=None, **over):
    return requests.post(f"{BASE}/api/bookings/direct", headers=H(token or mtok),
                         json=itinerary(**over))


# ---------------------------------------------------------------- 1. creation
print("\n=== 1. A direct booking is a real Classic booking ===")

r = create()
check("POST /api/bookings/direct returns 201", r.status_code == 201,
      f"{r.status_code} {r.text[:300]}")
booking = r.json() if r.status_code == 201 else {}
rid = booking.get("id")

check("...as a DRAFT", booking.get("status") == "draft", str(booking.get("status")))
check("...of type booking", booking.get("request_type") == "booking",
      str(booking.get("request_type")))
check("...with a booking reference issued", bool(booking.get("booking_reference")),
      str(booking.get("booking_reference")))
check("...and the passenger it was given", len(booking.get("passengers") or []) == 1,
      str(len(booking.get("passengers") or [])))

detail = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()["request"]
d = detail.get("details") or {}

check("the itinerary is stored as the merchant entered it",
      (d.get("origin"), d.get("destination"), d.get("travel_class")) == ("HYD", "BOM", "Economy"),
      str([d.get("origin"), d.get("destination"), d.get("travel_class")]))
# _itinerary_details is shared with the enquiry form precisely so this holds.
check("...with the flight number normalised the way the enquiry form does it",
      d.get("flight_number") == "6E1423", str(d.get("flight_number")))
check("...and the preferred time kept as 24-hour HH:MM",
      d.get("preferred_time") == "09:30", str(d.get("preferred_time")))
check("the track marker is written", d.get("direct_booking") is True, str(d.get("direct_booking")))
check("...and there is no enquiry reference to go with it",
      not d.get("enquiry_reference"), str(d.get("enquiry_reference")))
check("the contact is carried through",
      (d.get("contact") or {}).get("email") == "ops@demotravel.example",
      str(d.get("contact")))
# The enquiry form's "notes for our team" must not be silently dropped.
check("the merchant's notes survive as merchant_notes",
      d.get("merchant_notes") == "raised without an enquiry", str(d.get("merchant_notes")))

with SessionLocal() as db:
    row = db.execute(text(
        "SELECT parent_request_id, total_amount, pricing FROM service_requests WHERE request_id = :i"
    ), {"i": rid}).mappings().one()

check("it has NO parent request", row["parent_request_id"] is None, str(row["parent_request_id"]))
check("THE MERCHANT CANNOT PRICE ITS OWN BOOKING: total_amount is 0",
      D(str(row["total_amount"])) == D("0"), str(row["total_amount"]))
check("...and the pricing block says so explicitly",
      (row["pricing"] or {}).get("quoted") is False, str(row["pricing"]))

# An amount sent by the merchant must not become the booking's price. The schema
# has no such field, so this is asserting that it is IGNORED rather than honoured
# by some future `extra=allow`.
r = create(total_amount="1.00", quoted_fare="1.00")
if check("a fare smuggled into the payload is not accepted as the price",
         r.status_code in (201, 422), f"{r.status_code} {r.text[:200]}"):
    if r.status_code == 201:
        with SessionLocal() as db:
            amt = db.execute(text("SELECT total_amount FROM service_requests WHERE request_id = :i"),
                             {"i": r.json()["id"]}).scalar_one()
        check("...the booking is still created at zero", D(str(amt)) == D("0"), str(amt))
    else:
        check("...the booking is still created at zero", True, "refused outright")


# ------------------------------------------------------ 2. inherited validators
print("\n=== 2. The itinerary rules are the enquiry's rules, not a second copy ===")

cases = [
    ("From and To cannot be the same airport", {"destination": "HYD", "destination_city": "Hyderabad"}),
    ("the travel date cannot be in the past",
     {"travel_date": str(datetime.date.today() - datetime.timedelta(days=1))}),
    ("a round trip needs a return date", {"trip_type": "round_trip", "return_date": None}),
    ("the party breakdown must reconcile with the count",
     {"passenger_count": 3, "adults": 1, "children": 0, "infants": 0}),
    ("infants cannot outnumber adults",
     {"passenger_count": 3, "adults": 1, "children": 0, "infants": 2,
      "passengers": [{"title": "Mr", "first_name": "A", "last_name": "B", "passenger_type": "adult"}]}),
    ("a preferred time outside 00:00-23:59 is refused", {"preferred_time": "25:00"}),
]
for name, over in cases:
    r = create(**over)
    check(name, r.status_code == 422, f"{r.status_code} {r.text[:200]}")

r = create(passengers=[])
check("at least one passenger is required", r.status_code in (400, 422),
      f"{r.status_code} {r.text[:200]}")

# The valid round trip, to prove the rule above rejects the missing return and
# not round trips as a whole.
r = create(trip_type="round_trip", return_date=str(TRAVEL + datetime.timedelta(days=5)),
           return_preferred_time="18:45")
check("a complete round trip is accepted", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
if r.status_code == 201:
    rt = requests.get(f"{BASE}/api/requests/{r.json()['id']}", headers=H(mtok)).json()["request"]
    check("...and keeps its return leg",
          (rt.get("details") or {}).get("return_preferred_time") == "18:45",
          str((rt.get("details") or {}).get("return_preferred_time")))


# ------------------------------------------------------------ 3. authorisation
print("\n=== 3. Only a merchant can raise one ===")

r = create(token=atok)
check("an Admin cannot raise a direct booking", r.status_code in (401, 403),
      f"{r.status_code} {r.text[:200]}")
r = requests.post(f"{BASE}/api/bookings/direct", json=itinerary())
check("...and neither can an anonymous caller", r.status_code in (401, 403),
      f"{r.status_code} {r.text[:200]}")


# -------------------------------------------------------- 4. submission rules
print("\n=== 4. Submitting is no easier than on the enquiry-led path ===")

# The rules used to be reached by loading the parent and checking its type. A
# direct booking has no parent, so if the predicate were not the track marker
# these would all quietly pass.
r = create(contact=None)
nc = r.json()["id"]
r = requests.post(f"{BASE}/api/requests/{nc}/submit", headers=H(mtok))
check("a booking with no contact is refused at submit", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")

r = create(destination="DXB", destination_city="Dubai", airline="Emirates",
           flight_number="EK525", international=True)
intl = r.json()["id"]
r = requests.post(f"{BASE}/api/requests/{intl}/submit", headers=H(mtok))
check("an international sector with no passport is refused at submit",
      r.status_code == 400, f"{r.status_code} {r.text[:200]}")

# ...and accepted once the passport details are typed in, which is all CR-1
# leaves required — no upload.
pax_id = requests.get(f"{BASE}/api/requests/{intl}", headers=H(mtok)
                      ).json()["request"]["passengers"][0]["id"]
r = requests.put(f"{BASE}/api/requests/{intl}/passengers", headers=H(mtok), json={
    "passengers": [{"title": "Mr", "first_name": "Direct", "last_name": "Traveller",
                    "passenger_type": "adult", "passport_number": "P7654321",
                    "passport_expiry": str(EXPIRY)}]})
check("passenger details can be replaced on the draft", r.status_code == 200,
      f"{r.status_code} {r.text[:200]}")
r = requests.post(f"{BASE}/api/requests/{intl}/submit", headers=H(mtok))
check("...and it submits once the passport is supplied", r.status_code == 200,
      f"{r.status_code} {r.text[:200]}")

# submit=true does the same thing in one call, and is subject to the same rules.
r = create(submit=True)
check("submit:true creates and submits in one call", r.status_code == 201,
      f"{r.status_code} {r.text[:200]}")
one_shot = r.json() if r.status_code == 201 else {}
check("...and the response shows it already with the desk",
      one_shot.get("status") == "pending_approval", str(one_shot.get("status")))

with SessionLocal() as db:
    made_before = db.execute(text(
        "SELECT COUNT(*) FROM service_requests "
        "WHERE travel_details->>'direct_booking' = 'true'"), {}).scalar_one()

r = create(submit=True, contact=None)
check("submit:true still refuses an incomplete booking", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")

# ALL OR NOTHING. The row is committed before the submit runs, so a refusal has
# to be undone — otherwise the caller gets a 400, is never told the draft's id,
# and every retry of the same POST raises another one.
with SessionLocal() as db:
    made_after = db.execute(text(
        "SELECT COUNT(*) FROM service_requests "
        "WHERE travel_details->>'direct_booking' = 'true'"), {}).scalar_one()
check("...and leaves NO booking behind — a refused one-shot creates nothing",
      made_after == made_before, f"{made_before} -> {made_after}")

# The two-step path is the one that keeps an incomplete draft, and must still:
# the merchant has typed a form and is being told what is missing from it.
survivor = requests.get(f"{BASE}/api/requests/{nc}", headers=H(mtok))
check("...while a two-step draft survives its own refused submit",
      survivor.status_code == 200 and survivor.json()["request"]["status"] == "draft",
      f"{survivor.status_code} {survivor.text[:150]}")


# --------------------------------------------------------- 5. the Manager queue
print("\n=== 5. It reaches the Manager, and can be decided ===")

r = requests.post(f"{BASE}/api/requests/{rid}/submit", headers=H(mtok))
check("the first booking submits", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

# Searched by request number rather than read off page one. The queue is the
# real desk's backlog on a development database and routinely runs past a page,
# so an unfiltered read proves nothing either way — `search` is what makes this
# an assertion about the SQL filter instead of about how busy the desk is.
number = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()["request"]["request_number"]
q = requests.get(
    f"{BASE}/api/manager/bookings?bucket=awaiting&search={number}&page_size=100", headers=H(gtok))
ids = [x["id"] for x in (q.json().get("items") or [])] if q.status_code == 200 else []
check("it appears in the Manager's queue (the SQL filter knows the marker)",
      rid in ids, f"{q.status_code}: matched {len(ids)} rows for {number}")

single = requests.get(f"{BASE}/api/manager/bookings/{rid}", headers=H(gtok))
check("...and the Manager can open it", single.status_code == 200,
      f"{single.status_code} {single.text[:200]}")

r = requests.post(f"{BASE}/api/manager/bookings/{rid}/approve", headers=H(gtok),
                  json={"note": "Direct booking, fare to be confirmed at issuance."})
check("...and approve it (the Python predicate agrees with the SQL)",
      r.status_code == 200, f"{r.status_code} {r.text[:200]}")

after = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()["request"]
check("the booking is approved", after["status"] == "approved", after["status"])
# CR-2 removed the payment stage from this track. A direct booking must not have
# reintroduced it by looking like a catalog booking to the state machine.
check("...and did NOT route through payment_pending",
      "payment_pending" not in [h.get("status") or h.get("to_status")
                                for h in (after.get("status_history") or [])],
      str([h.get("status") or h.get("to_status") for h in (after.get("status_history") or [])]))


# ------------------------------------------------- 6. the fare, named at issuance
print("\n=== 6. The desk names the fare, and the wallet is billed then ===")

with SessionLocal() as db:
    mid = db.execute(text("SELECT merchant_id FROM service_requests WHERE request_id = :i"),
                     {"i": rid}).scalar_one()
    before = db.execute(text("SELECT wallet_balance FROM merchants WHERE merchant_id = :m"),
                        {"m": mid}).scalar_one()

r = requests.post(f"{BASE}/api/requests/{rid}/documents", headers=H(atok),
                  files={"file": (f"eticket-{rid}.pdf", PDF, "application/pdf")},
                  data={"doc_type": "ticket"})
check("the desk attaches the e-ticket", r.status_code in (200, 201),
      f"{r.status_code} {r.text[:200]}")

# An unpriced booking must still REQUIRE a fare here — this is the pre-CR-5
# capture path, and a direct booking is now the main thing that reaches it.
r = requests.post(f"{BASE}/api/admin/requests/{rid}/issue-ticket", headers=H(atok), json={})
check("issuing with no fare is refused on an unquoted booking", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")

FARE = D("31500.00")
r = requests.post(f"{BASE}/api/admin/requests/{rid}/issue-ticket", headers=H(atok),
                  json={"fare_amount": str(FARE)})
check("...and accepted with one", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

with SessionLocal() as db:
    amt = db.execute(text("SELECT total_amount FROM service_requests WHERE request_id = :i"),
                     {"i": rid}).scalar_one()
    after_bal = db.execute(text("SELECT wallet_balance FROM merchants WHERE merchant_id = :m"),
                           {"m": mid}).scalar_one()
    led = db.execute(text(
        "SELECT debit, credit, balance_after, request_id FROM wallet_transactions "
        "WHERE merchant_id = :m ORDER BY txn_id DESC LIMIT 1"), {"m": mid}).mappings().one()

check("the booking now carries the fare the desk named", D(str(amt)) == FARE, str(amt))
check("...the wallet was debited by exactly that", D(str(before)) - D(str(after_bal)) == FARE,
      f"{before} -> {after_bal}")
check("...and the ledger records it as a debit", D(str(led["debit"])) == FARE, str(dict(led)))
check("...against this booking", led["request_id"] == rid, str(led["request_id"]))
check("...with balance_after matching the wallet", D(str(led["balance_after"])) == D(str(after_bal)),
      f"{led['balance_after']} vs {after_bal}")


sys.exit(check.report())
