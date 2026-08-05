"""CR-5 — the enquiry answer becomes a binding quotation.

WHAT THIS PROTECTS

1. **An enquiry cannot be answered without a price.** "Send Quotation" requires
   a strictly positive `total_fare` and the remarks that explain it. The old
   bare `{"available": true}` — which every caller in this suite used to send —
   must now be refused, or the whole change is optional in practice.
2. **The quotation reaches the merchant, as a decimal string.** The number the
   desk typed is the number the merchant reads, with its paise, having never
   been through a float. Asserted on the raw JSON, not on a rendered screen.
3. **The quotation is binding.** The booking raised from the enquiry carries
   *exactly* that amount. This is the scope decision CR-5 was approved on, and
   it is the assertion that would catch a later edit quietly restoring the zero.
4. **Two frozen CR-4b gates change behaviour without changing code.** With a
   real amount present from the draft onwards, the credit limit stops asking
   "is there any headroom at all" and starts asking "does *this* amount fit",
   at submission and at approval; and `_capture_fare_for_wallet_billing` stops
   demanding a fare at issuance because there already is one. Both are asserted
   here rather than assumed from reading the code.
5. **A decline is still a decline.** No fare, a mandatory reason, and the
   refusal of a fare sent alongside one — so nothing routes a price through the
   rejection path.
6. **The answer is still final and still claim-guarded.** CR-5 added fields to
   `respond`; it must not have loosened Phase 2's concurrency or ownership.

The wallet arithmetic itself is not re-tested here — `verify_cr4a` and
`verify_cr4b` own that, and CR-5 changes where the amount comes from, not what
is done with it. What this script checks is that the amount arrives.
"""
import concurrent.futures
import datetime
import os
import sys
from decimal import Decimal as D
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MANAGER, MERCHANT, Checker, H, PDF, login  # noqa: E402

check = Checker()
mtok = login(*MERCHANT)
atok = login(*ADMIN)
gtok = login(*MANAGER)

TRAVEL = datetime.date.today() + datetime.timedelta(days=60)


def raise_enquiry(label, *, pax=1, adults=1, children=0, infants=0,
                  travel_class="Economy", preferred_time="09:30", client_fare=None):
    """A merchant enquiry, through the real endpoint.

    ``client_fare`` is still accepted by the API but is no longer collected on
    the merchant form (it moved to Booking Request on 2026-08-05). It is a
    parameter here so the backward-compatible path — an enquiry that already
    carries one — stays under test.
    """
    body = {
        "trip_type": "one_way",
        "origin": "HYD", "origin_city": "Hyderabad",
        "destination": "BOM", "destination_city": "Mumbai",
        "airline": "IndiGo", "flight_number": "6E1423",
        "travel_date": str(TRAVEL), "preferred_time": preferred_time,
        "travel_class": travel_class,
        "passenger_count": pax, "adults": adults,
        "children": children, "infants": infants,
        "notes": f"cr5 {label}",
    }
    if client_fare is not None:
        body["client_fare"] = client_fare
    r = requests.post(f"{BASE}/api/enquiries", headers=H(mtok), json=body)
    assert r.status_code in (200, 201), f"enquiry {label}: {r.status_code} {r.text[:300]}"
    return r.json()


def answer_enquiry(eid, *, fare="18000.00"):
    """Claim and quote, the two steps every booking-side check needs first."""
    claim(eid)
    r = respond(eid, {"available": True, "response": "Seats confirmed.",
                      "total_fare": fare, "reason": "Base fare plus taxes."})
    assert r.status_code == 200, f"respond: {r.status_code} {r.text[:200]}"
    return r.json()


def respond(eid, payload, token=None):
    return requests.post(f"{BASE}/api/admin/enquiries/{eid}/respond",
                         headers=H(token or atok), json=payload)


def claim(eid, token=None):
    return requests.post(f"{BASE}/api/admin/enquiries/{eid}/review", headers=H(token or atok))


def wallet_state():
    p = requests.get(f"{BASE}/api/merchant/finance/position", headers=H(mtok)).json()
    return p


def set_credit_limit(merchant_id, value):
    """Straight to the column: there is no admin endpoint for the limit alone,
    and CR-5 is not the milestone to add one."""
    db = SessionLocal()
    db.execute(text("UPDATE merchants SET credit_limit = :v WHERE merchant_id = :m"),
               {"v": value, "m": merchant_id})
    db.commit()
    db.close()


MID = wallet_state()["merchant_id"]
ORIGINAL_LIMIT = D(str(wallet_state()["credit_limit"]))


# ===========================================================================
print("\n== Send Quotation: the fare and the remarks are both required ==")
# ===========================================================================
e = raise_enquiry("required fields")
claim(e["id"])

r = respond(e["id"], {"available": True})
check("the old bare {available:true} is now refused -> 422", r.status_code == 422,
      f"{r.status_code} {r.text[:200]}")
check("...naming the fare as what is missing", "fare" in r.text.lower(), r.text[:250])

r = respond(e["id"], {"available": True, "reason": "Seats held."})
check("remarks without a fare -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")

r = respond(e["id"], {"available": True, "total_fare": "0", "reason": "Seats held."})
check("a fare of zero -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")
check("...saying why a zero quotation is useless",
      "bills nobody" in r.text.lower() or "0" in r.text, r.text[:250])

r = respond(e["id"], {"available": True, "total_fare": "-500.00", "reason": "Seats held."})
check("a negative fare -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")

r = respond(e["id"], {"available": True, "total_fare": "15000.00"})
check("a fare with no remarks -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")
check("...saying the merchant needs the breakdown",
      "remark" in r.text.lower(), r.text[:250])

st = requests.get(f"{BASE}/api/enquiries/{e['id']}", headers=H(atok)).json()
check("...and every refusal left the enquiry Under Review, unanswered",
      st["status"] == "in_review", st["status"])
check("...with no fare recorded", st.get("quoted_fare") is None, str(st.get("quoted_fare")))


# ===========================================================================
print("\n== the quotation reaches the merchant, to the paise ==")
# ===========================================================================
FARE = "15000.50"
REMARKS = "INR 3,000 ticket fare\nINR 12,000 baggage charges\nINR 0.50 rounding"

quoted = raise_enquiry("quotation")
claim(quoted["id"])
r = respond(quoted["id"], {"available": True, "total_fare": FARE, "reason": REMARKS,
                           "response": "Seats held until 18:00."})
check("Send Quotation succeeds", r.status_code == 200, f"{r.status_code} {r.text[:250]}")

body = r.json()
check("the response carries the fare", body.get("quoted_fare") is not None,
      str(body.get("quoted_fare")))
check("...as a decimal STRING, so no browser can float it",
      isinstance(body.get("quoted_fare"), str), repr(body.get("quoted_fare")))
check("...with the paise intact", D(body["quoted_fare"]) == D(FARE),
      f"{body.get('quoted_fare')} vs {FARE}")
check("...and the remarks verbatim, newlines and all",
      body.get("quotation_remarks") == REMARKS, repr(body.get("quotation_remarks")))
check("the enquiry is Available", body["status"] == "approved", body["status"])

# The merchant's own read of the same row — a quotation the desk can see and the
# merchant cannot is worse than no quotation.
mine = requests.get(f"{BASE}/api/enquiries/{quoted['id']}", headers=H(mtok)).json()
check("the merchant reads the identical fare", mine.get("quoted_fare") == body["quoted_fare"],
      f"{mine.get('quoted_fare')} vs {body['quoted_fare']}")
check("the merchant reads the identical remarks",
      mine.get("quotation_remarks") == REMARKS, repr(mine.get("quotation_remarks")))

listed = requests.get(f"{BASE}/api/enquiries?page_size=100", headers=H(mtok)).json()["items"]
row = next((x for x in listed if x["id"] == quoted["id"]), None)
check("...and the fare is on the LIST row too, not only the detail",
      row is not None and row.get("quoted_fare") == body["quoted_fare"],
      str(row and row.get("quoted_fare")))

# The Activity Timeline, which is what both portals render. `status_history` is
# stored on the row but is deliberately not on the detail response — `timeline`
# is the rendered form of it, so that is what has to carry the figure.
tl = requests.get(f"{BASE}/api/requests/{quoted['id']}", headers=H(atok)).json()["timeline"]
notes = [str(h.get("note") or "") for h in tl]
check("the quotation is in the enquiry's timeline, with the figure",
      any(FARE in n for n in notes), str(notes)[:300])
check("...and with the remarks, so the timeline explains the number too",
      any("baggage charges" in n for n in notes), str(notes)[:300])


# ===========================================================================
print("\n== the quotation is binding: the booking is raised at that amount ==")
# ===========================================================================
r = requests.post(f"{BASE}/api/enquiries/{quoted['id']}/booking-request", headers=H(mtok), json={
    "passengers": [{"title": "Mr", "first_name": "Arjun", "last_name": "Mehta",
                    "passenger_type": "adult"}],
    "contact": {"name": "Arjun Mehta", "email": "arjun@example.com", "phone": "+919800000001"},
})
check("the booking draft is created", r.status_code in (200, 201), f"{r.status_code} {r.text[:250]}")
booking = r.json()
bid = booking["id"]

detail = requests.get(f"{BASE}/api/requests/{bid}", headers=H(mtok)).json()["request"]
check("the booking carries the QUOTED amount, not zero",
      D(str(detail["total_amount"])) == D(FARE), str(detail.get("total_amount")))
check("...as a decimal string", isinstance(detail["total_amount"], str),
      repr(detail["total_amount"]))

db = SessionLocal()
pricing = db.execute(text("SELECT pricing FROM service_requests WHERE request_id = :r"),
                     {"r": bid}).scalar()
db.close()
check("...and pricing records that it IS quoted", bool(pricing.get("quoted")), str(pricing))
check("...and where the price came from", pricing.get("priced_at") == "enquiry_quotation",
      str(pricing))
check("...and the source is still the enquiry", pricing.get("source") == "ticket_enquiry",
      str(pricing))

# `travel_details` is returned to the merchant wholesale as `details`, so what is
# copied onto the booking is a merchant-facing decision, not an internal one.
# The price and its explanation belong there; who quoted it does not — that is a
# platform staff **user id**, and it is dropped for the same reason the review
# claim always was.
carried = detail.get("details") or {}
check("the booking carries the quoted fare as provenance",
      carried.get("quoted_fare") == FARE, str(carried.get("quoted_fare")))
check("...and the remarks", carried.get("quotation_remarks") == REMARKS,
      repr(carried.get("quotation_remarks")))
for leaked in ("quoted_by", "quoted_by_name", "quoted_at", "review_claimed_by"):
    check(f"...but NOT '{leaked}' — internal attribution stays off a merchant response",
          leaked not in carried, f"{leaked}={carried.get(leaked)!r}")


# ===========================================================================
print("\n== a declined enquiry takes no fare ==")
# ===========================================================================
d = raise_enquiry("decline")
claim(d["id"])

r = respond(d["id"], {"available": False, "total_fare": "9000.00", "reason": "Sold out"})
check("a fare on a decline -> 422 (not silently dropped)", r.status_code == 422,
      f"{r.status_code} {r.text[:200]}")
check("...saying there is nothing to quote", "quote" in r.text.lower(), r.text[:250])

r = respond(d["id"], {"available": False})
check("a decline with no reason is still refused", r.status_code >= 400,
      f"{r.status_code} {r.text[:200]}")

r = respond(d["id"], {"available": False, "reason": "Sold out in Economy on this date."})
check("a decline with a reason succeeds", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
dbody = r.json()
check("...and carries no fare", dbody.get("quoted_fare") is None, str(dbody.get("quoted_fare")))
check("...and the reason reaches the merchant",
      "Sold out" in (requests.get(f"{BASE}/api/enquiries/{d['id']}",
                                  headers=H(mtok)).json().get("rejection_reason") or ""),
      str(requests.get(f"{BASE}/api/enquiries/{d['id']}", headers=H(mtok)).json()
          .get("rejection_reason")))

r = requests.post(f"{BASE}/api/enquiries/{d['id']}/booking-request", headers=H(mtok), json={
    "passengers": [{"title": "Mr", "first_name": "No", "last_name": "Booking",
                    "passenger_type": "adult"}],
    "contact": {"name": "No Booking", "email": "no@example.com", "phone": "+919800000009"},
})
check("a declined enquiry still cannot be booked -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")


# ===========================================================================
print("\n== the answer is still final, and still claimed ==")
# ===========================================================================
r = respond(quoted["id"], {"available": True, "total_fare": "1.00", "reason": "repricing"})
check("re-quoting an answered enquiry -> 409", r.status_code == 409,
      f"{r.status_code} {r.text[:200]}")

after = requests.get(f"{BASE}/api/enquiries/{quoted['id']}", headers=H(mtok)).json()
check("...and the original fare is untouched", D(after["quoted_fare"]) == D(FARE),
      str(after.get("quoted_fare")))

# Two admins racing one quotation. CR-5 added fields to `respond`; the row lock
# and the claim guard behind it must be exactly as they were.
race = raise_enquiry("race")
claim(race["id"])
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    results = [f.result() for f in [
        pool.submit(respond, race["id"],
                    {"available": True, "total_fare": f"{7000 + i}.00", "reason": f"race {i}"})
        for i in range(6)
    ]]
codes = sorted(r.status_code for r in results)
check("six simultaneous quotations: exactly one succeeds", codes.count(200) == 1, str(codes))
check("...and the losers are refusals, never 500s",
      all(c in (200, 400, 409) for c in codes), str(codes))

final = requests.get(f"{BASE}/api/enquiries/{race['id']}", headers=H(atok)).json()
winner = next(r.json()["quoted_fare"] for r in results if r.status_code == 200)
check("...and the stored fare is the winner's, exactly one of the six",
      final["quoted_fare"] == winner, f"{final.get('quoted_fare')} vs {winner}")


# ===========================================================================
print("\n== cross-tenant: another company cannot read the quotation ==")
# ===========================================================================
rival = flows.rival_merchant(atok)
r = requests.get(f"{BASE}/api/enquiries/{quoted['id']}", headers=H(rival["token"]))
check("a rival merchant gets 404 for the enquiry (not 403)", r.status_code == 404,
      f"{r.status_code} {r.text[:150]}")
check("...and the fare is nowhere in the body", FARE not in r.text, r.text[:200])

r = requests.post(f"{BASE}/api/admin/enquiries/{quoted['id']}/respond", headers=H(rival["token"]),
                  json={"available": True, "total_fare": "1.00", "reason": "nope"})
check("a merchant cannot quote at all", r.status_code in (403, 404),
      f"{r.status_code} {r.text[:150]}")


# ===========================================================================
print("\n== CR-4b's credit gate now sees a real amount, at BOTH gates ==")
# ===========================================================================
# The behaviour under test is CR-4b's and is frozen. What CR-5 changes is the
# input: before it, an enquiry-led booking reached both gates at 0 and only the
# "any headroom at all" branch could fire. Now the full amount check runs.
pos = wallet_state()
spending_power = D(str(pos["wallet_balance"]))

# A limit that leaves room for a small booking and not for a large one.
set_credit_limit(MID, str(spending_power + D("20000.00")))

small = raise_enquiry("credit small")
claim(small["id"])
respond(small["id"], {"available": True, "total_fare": "5000.00", "reason": "within limit"})
r = requests.post(f"{BASE}/api/enquiries/{small['id']}/booking-request", headers=H(mtok), json={
    "passengers": [{"title": "Mr", "first_name": "Small", "last_name": "Fare",
                    "passenger_type": "adult"}],
    "contact": {"name": "Small Fare", "email": "small@example.com", "phone": "+919800000002"},
})
small_id = r.json()["id"]
r = requests.post(f"{BASE}/api/requests/{small_id}/submit", headers=H(mtok), json={})
check("a booking inside the limit submits", r.status_code == 200, f"{r.status_code} {r.text[:250]}")

big = raise_enquiry("credit big")
claim(big["id"])
respond(big["id"], {"available": True, "total_fare": "900000.00", "reason": "far over the limit"})
r = requests.post(f"{BASE}/api/enquiries/{big['id']}/booking-request", headers=H(mtok), json={
    "passengers": [{"title": "Mr", "first_name": "Big", "last_name": "Fare",
                    "passenger_type": "adult"}],
    "contact": {"name": "Big Fare", "email": "big@example.com", "phone": "+919800000003"},
})
big_id = r.json()["id"]

# Read the position immediately before the refusal, so every figure below is
# asserted against what the server itself believes at that moment rather than
# against a literal that rots the first time a fixture changes.
before_refusal = wallet_state()
r = requests.post(f"{BASE}/api/requests/{big_id}/submit", headers=H(mtok), json={})
check("a booking over the limit is refused AT SUBMISSION -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:300]}")

# The refusal text is CR-4b's shared `credit_refusal_message`, which its own
# scope requires to name five figures. Asserted **by name and by value** — the
# roadmap records a credit-block test that asserted only
# `"credit limit" in text and "wallet" in text` and passed against a message
# missing three of the five.
#
# The figures are the WALLET's, computed here the way `wallet_service` computes
# them, and that is not the same arithmetic as `finance_service`'s position:
#   * wallet `outstanding`  = max(0, -wallet_balance)  — the wallet debt
#   * position `outstanding` = unpaid balance_due across billable bookings
# Both are frozen and both are right for what they describe; deriving the
# expected text from the position would assert the wrong pair of numbers. See
# the CR-5 summary, which flags the shared word as something for the wallet gate
# to reconcile on the merchant-facing screens.
balance = D(str(before_refusal["wallet_balance"]))
limit = D(str(before_refusal["credit_limit"]))
wallet_outstanding = max(D("0.00"), -balance)
wallet_available = max(D("0.00"), limit + balance)
required = D("900000.00")

figures = {
    "wallet balance": balance,
    "outstanding": wallet_outstanding,
    "credit limit": limit,
    "available credit": wallet_available,
}
for name, value in figures.items():
    check(f"...refusal names '{name}'", name in r.text.lower(), r.text[:400])
    check(f"...with its value {value:.2f}", f"{value:.2f}" in r.text,
          f"{value:.2f} not in {r.text[:400]}")
check("...and the amount required", f"{required:.2f}" in r.text, r.text[:400])
check("...and the shortfall, so the merchant knows how much to add",
      f"{required - wallet_available:.2f}" in r.text, r.text[:400])

st = requests.get(f"{BASE}/api/requests/{big_id}", headers=H(mtok)).json()["request"]
check("...and the over-limit booking never left draft", st["status"] == "draft", st["status"])

set_credit_limit(MID, str(ORIGINAL_LIMIT))


# ===========================================================================
print("\n== CR-4b's fare capture: no longer demanded, because it is already set ==")
# ===========================================================================
b = flows.make_booking(mtok, atok, gtok=gtok, upto="approved",
                       label="cr5 issuance", quote="18250.75")
detail = requests.get(f"{BASE}/api/requests/{b['id']}", headers=H(mtok)).json()["request"]
check("the approved booking still carries the quoted amount",
      D(str(detail["total_amount"])) == D("18250.75"), str(detail.get("total_amount")))

requests.post(f"{BASE}/api/requests/{b['id']}/documents", headers=H(atok),
              files={"file": ("t.pdf", PDF, "application/pdf")}, data={"doc_type": "ticket"})

before = D(str(wallet_state()["wallet_balance"]))
# No `fare_amount` at all — before CR-5 this was a 400.
r = requests.post(f"{BASE}/api/admin/requests/{b['id']}/issue-ticket", headers=H(atok), json={})
check("issuing a quoted booking needs NO fare_amount -> 200", r.status_code == 200,
      f"{r.status_code} {r.text[:300]}")

after_bal = D(str(wallet_state()["wallet_balance"]))
check("...and the wallet moved by exactly the quoted fare",
      before - after_bal == D("18250.75"), f"{before} -> {after_bal}")

db = SessionLocal()
# `debit`, not `amount` — the ledger stores the two directions in separate
# columns so `balance_after = balance_before + credit - debit` can be a database
# check constraint (CR-4a).
debits = db.execute(text(
    "SELECT debit FROM wallet_transactions WHERE request_id = :r AND txn_type = 'booking_debit'"
), {"r": b["id"]}).scalars().all()
db.close()
check("...writing exactly one booking debit", len(debits) == 1, str(debits))
check("...for the quoted amount", len(debits) == 1 and D(str(debits[0])) == D("18250.75"),
      str(debits))

fin = requests.get(f"{BASE}/api/requests/{b['id']}", headers=H(mtok)).json()["request"]
check("...and the booking reads as settled, so the debt is not counted twice",
      D(str(fin.get("balance_due") or 0)) == D("0.00"), str(fin.get("balance_due")))


# ===========================================================================
print("\n== a pre-CR-5 booking still finishes the way it was made ==")
# ===========================================================================
# The backward-compatibility guarantee. A booking sitting at zero is what every
# enquiry-led booking raised before CR-5 looks like, and CR-4b's fare-at-issuance
# path is what those still need. Reproduced by zeroing the row, because the API
# can no longer create one.
legacy = flows.make_booking(mtok, atok, gtok=gtok, upto="approved", label="cr5 legacy")
db = SessionLocal()
db.execute(text("UPDATE service_requests SET total_amount = 0, pricing = pricing || "
                "'{\"quoted\": false}'::jsonb WHERE request_id = :r"), {"r": legacy["id"]})
db.commit()
db.close()

requests.post(f"{BASE}/api/requests/{legacy['id']}/documents", headers=H(atok),
              files={"file": ("t.pdf", PDF, "application/pdf")}, data={"doc_type": "ticket"})

r = requests.post(f"{BASE}/api/admin/requests/{legacy['id']}/issue-ticket", headers=H(atok), json={})
check("a zero-amount booking STILL demands a fare at issuance -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:250]}")

before = D(str(wallet_state()["wallet_balance"]))
r = requests.post(f"{BASE}/api/admin/requests/{legacy['id']}/issue-ticket", headers=H(atok),
                  json={"fare_amount": "7300.25"})
check("...and issues once the desk supplies one", r.status_code == 200,
      f"{r.status_code} {r.text[:250]}")
check("...billing that fare to the wallet",
      before - D(str(wallet_state()["wallet_balance"])) == D("7300.25"),
      f"{before} -> {wallet_state()['wallet_balance']}")


# ===========================================================================
print("\n== the merchant form's rules still hold server-side ==")
# ===========================================================================
# CR-5 made the passenger total typeable and reconciled it against the
# breakdown in the browser. The server rule it reconciles *to* is what makes
# that safe, so it is asserted here — a UI that stopped reconciling must fail
# loudly rather than submit a party that does not add up.
r = requests.post(f"{BASE}/api/enquiries", headers=H(mtok), json={
    "trip_type": "one_way", "origin": "HYD", "origin_city": "Hyderabad",
    "destination": "BOM", "destination_city": "Mumbai",
    "airline": "IndiGo", "flight_number": "6E1423",
    "travel_date": str(TRAVEL), "preferred_time": "09:30", "travel_class": "Business",
    "passenger_count": 9, "adults": 2, "children": 0, "infants": 0,
})
check("a passenger count that disagrees with the breakdown -> 422", r.status_code == 422,
      f"{r.status_code} {r.text[:200]}")

ok = raise_enquiry("typed total", pax=9, adults=8, children=1)
check("a reconciled party of 9 is accepted", ok["passenger_count"] == 9, str(ok))
check("...with the breakdown the merchant chose", (ok["adults"], ok["children"]) == (8, 1),
      f"{ok['adults']}/{ok['children']}")

# The four dropdown options must all be accepted — the UI now offers only these.
for cabin in ("Economy", "Premium Economy", "Business", "First Class"):
    e2 = raise_enquiry(f"class {cabin}", travel_class=cabin)
    check(f"cabin '{cabin}' is accepted", e2["travel_class"] == cabin, str(e2.get("travel_class")))

# 24-hour times, including the two the old AM/PM control could not express.
for t in ("00:00", "00:30", "12:00", "23:30"):
    e3 = raise_enquiry(f"time {t}", preferred_time=t)
    check(f"24-hour time '{t}' round-trips", e3["preferred_time"] == t,
          str(e3.get("preferred_time")))


# ===========================================================================
print("\n== an enquiry may name no airline and no flight ==")
# ===========================================================================
# 2026-08-05. Both were mandatory; an enquiry is a question about a route on a
# date, and which carrier and service answer it best is part of what the desk
# is being asked. "All Airlines" is a UI label, never a stored value — the form
# sends nothing at all for it.
def enq_raw(**over):
    body = {
        "trip_type": "one_way", "origin": "HYD", "destination": "BOM",
        "travel_date": str(TRAVEL), "preferred_time": "09:30",
        "travel_class": "Economy", "passenger_count": 1, "adults": 1,
    }
    body.update(over)
    return requests.post(f"{BASE}/api/enquiries", headers=H(mtok), json=body)


r = enq_raw()
check("an enquiry with neither airline nor flight is accepted", r.status_code == 201,
      f"{r.status_code} {r.text[:180]}")
open_enq = r.json() if r.status_code == 201 else {}
check("...and stores the airline as null, not an empty string",
      open_enq.get("airline") is None, repr(open_enq.get("airline")))
check("...and the flight number as null too",
      open_enq.get("flight_number") is None, repr(open_enq.get("flight_number")))

r = enq_raw(airline="", flight_number="   ")
check("blank strings normalise to null rather than storing whitespace",
      r.status_code == 201
      and r.json().get("airline") is None and r.json().get("flight_number") is None,
      f"{r.status_code} {r.text[:140]}")

r = enq_raw(airline="Air India")
check("an airline with no flight number is accepted", r.status_code == 201, f"{r.status_code}")
check("...and keeps the carrier the merchant chose",
      r.status_code == 201 and r.json().get("airline") == "Air India",
      r.text[:120])

r = enq_raw(flight_number="ai217")
check("a flight number with no airline is accepted", r.status_code == 201, f"{r.status_code}")
check("...and is upper-cased as it always was",
      r.status_code == 201 and r.json().get("flight_number") == "AI217", r.text[:120])

r = enq_raw(airline="IndiGo", flight_number="6E217")
check("naming both still works exactly as before",
      r.status_code == 201
      and (r.json().get("airline"), r.json().get("flight_number")) == ("IndiGo", "6E217"),
      r.text[:140])

# THE "None" ON AN INVOICE, GUARDED.
# `travel_details` stores both keys PRESENT AND NULL for an open enquiry, and a
# dict default only fires for a MISSING key — so `d.get("airline", "")` returns
# None and an f-string prints the word "None" onto the invoice and confirmation
# PDF the merchant sends to its own customer. Asserted against the helper the
# documents now build that line with.
from app.services.invoice_service import _flight_label  # noqa: E402

check("an open enquiry's flight line is empty, not the string 'None'",
      _flight_label({"airline": None, "flight_number": None}) == "",
      repr(_flight_label({"airline": None, "flight_number": None})))
check("...a carrier with no service reads as the carrier alone",
      _flight_label({"airline": "IndiGo", "flight_number": None}) == "IndiGo",
      repr(_flight_label({"airline": "IndiGo", "flight_number": None})))
check("...a service with no carrier reads as the service alone",
      _flight_label({"airline": None, "flight_number": "6E217"}) == "6E217",
      repr(_flight_label({"airline": None, "flight_number": "6E217"})))
check("...and both together are unchanged",
      _flight_label({"airline": "IndiGo", "flight_number": "6E217"}) == "IndiGo 6E217",
      repr(_flight_label({"airline": "IndiGo", "flight_number": "6E217"})))


# ===========================================================================
print("\n== the client fare is stated at the BOOKING, not at the enquiry ==")
# ===========================================================================
# It used to be collected on the enquiry form, which asked the merchant to name
# a selling price before we had quoted them a cost. It moved to Booking Request
# — the first screen on which our fare is known.
priced = raise_enquiry("client fare at booking", pax=1, adults=1)
check("an enquiry carries no client fare of its own",
      priced.get("client_fare") is None, repr(priced.get("client_fare")))

answer_enquiry(priced["id"], fare="18000.00")
r = requests.post(f"{BASE}/api/enquiries/{priced['id']}/booking-request", headers=H(mtok), json={
    "passengers": [{"first_name": "Asha", "last_name": "Rao", "passenger_type": "adult"}],
    "contact": {"email": "ops@demo.example", "phone": "+919000000001"},
    "client_fare": "22500.00",
})
check("the booking request accepts a client fare", r.status_code == 201,
      f"{r.status_code} {r.text[:180]}")
booked = r.json() if r.status_code == 201 else {}
check("...and stores it", str(booked.get("client_fare") or "") .startswith("22500"),
      repr(booked.get("client_fare")))
check("...alongside the quoted amount it will be compared against",
      str(booked.get("total_amount") or "").startswith("18000"),
      repr(booked.get("total_amount")))

# Editable while it is still a draft — a mistyped selling price is the one a
# merchant notices immediately after saving.
r = requests.put(f"{BASE}/api/requests/{booked['id']}", headers=H(mtok),
                 json={"client_fare": "21000.00"})
edited = (r.json().get("request") or r.json()) if r.status_code == 200 else {}
check("a draft's client fare can be corrected", r.status_code == 200, f"{r.status_code}")
check("...and the new figure is what is stored",
      str(edited.get("client_fare") or "").startswith("21000"),
      repr(edited.get("client_fare")))

# The fallback that keeps every enquiry raised before the move working: one
# that already carries a client fare passes it on when no new one is sent.
legacy = raise_enquiry("legacy client fare", pax=1, adults=1, client_fare="30000.00")
check("an enquiry that DOES carry a client fare still accepts it",
      str(legacy.get("client_fare") or "").startswith("30000"),
      repr(legacy.get("client_fare")))
answer_enquiry(legacy["id"], fare="18000.00")
r = requests.post(f"{BASE}/api/enquiries/{legacy['id']}/booking-request", headers=H(mtok), json={
    "passengers": [{"first_name": "Legacy", "last_name": "Case", "passenger_type": "adult"}],
    "contact": {"email": "ops@demo.example", "phone": "+919000000001"},
})
check("...and it is carried onto the booking when none is sent at this step",
      r.status_code == 201 and str(r.json().get("client_fare") or "").startswith("30000"),
      f"{r.status_code} {str(r.json().get('client_fare') if r.status_code == 201 else r.text[:120])}")


sys.exit(check.report())
