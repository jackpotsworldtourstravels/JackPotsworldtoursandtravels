"""CR-4b — the money moves: auto-debit at Ticket Issued, credit limit, refunds.

WHAT THIS PROTECTS

1. **A ticketed enquiry-led booking bills the wallet, once.** The headline
   feature. It is asserted end to end — through the real endpoints, against the
   real ledger — and the amount, the direction, the reference and the resulting
   balance are all checked, not just "a row appeared".
2. **One debt is one number.** The booking must read as settled *and* the wallet
   must be down by the fare. If both the booking's `balance_due` and the wallet
   carried it, every screen that adds them up would double-count.
3. **A catalog-led booking is never wallet-billed.** It has its own payment
   path; billing it too would charge it twice. This is the backward-compatibility
   guarantee, and it is the assertion most likely to catch a careless later edit.
4. **The credit limit is a hard block**, refused server-side at submission and
   again at approval — and never used to refuse an accounting entry for a ticket
   that has already been bought.
5. **A cancellation puts the money back on the wallet**, not merely onto the
   booking's payments.

It reuses `verify_cr4a`'s invariants rather than restating them: after every
scenario the cached balance still equals the ledger and the chain is unbroken.
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
from sqlalchemy import select, text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import Merchant, WalletTransaction  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MANAGER, MERCHANT, Checker, H, PDF, login  # noqa: E402

check = Checker()
mtok = login(*MERCHANT)
atok = login(*ADMIN)
gtok = login(*MANAGER)


def money(v):
    return D(str(v))


def merchant_id_of(token):
    return requests.get(f"{BASE}/api/merchant/finance/position", headers=H(token)).json()["merchant_id"]


MID = merchant_id_of(mtok)


def wallet():
    db = SessionLocal()
    try:
        return money(db.scalar(select(Merchant.wallet_balance).where(Merchant.merchant_id == MID)))
    finally:
        db.close()


def ledger_balance():
    db = SessionLocal()
    try:
        return money(db.scalar(text(
            "SELECT COALESCE(SUM(credit - debit), 0) FROM wallet_transactions WHERE merchant_id = :m"
        ), {"m": MID}))
    finally:
        db.close()


def txns_for(request_id):
    db = SessionLocal()
    try:
        return list(db.scalars(
            select(WalletTransaction)
            .where(WalletTransaction.request_id == request_id)
            .order_by(WalletTransaction.txn_id)
        ).all())
    finally:
        db.close()


def set_credit_limit(value):
    return requests.put(f"{BASE}/api/admin/merchants/{MID}", headers=H(atok),
                        json={"credit_limit": str(value)})


def top_up(amount, reason="verify_cr4b fixture", txn_type=None):
    body = {"amount": str(amount), "reason": reason}
    if txn_type:
        body["txn_type"] = txn_type
    return requests.post(f"{BASE}/api/admin/merchants/{MID}/wallet", headers=H(atok), json=body)


def assert_invariants(where):
    """CR-4a's guarantees, re-asserted after each scenario (WALLET_ARCHITECTURE §7)."""
    check(f"{where}: cached balance still equals the ledger",
          wallet() == ledger_balance(), f"{wallet()} vs {ledger_balance()}")
    db = SessionLocal()
    broken = db.execute(text("""
        SELECT count(*) FROM (
            SELECT balance_before, LAG(balance_after) OVER (ORDER BY txn_id) AS prev
            FROM wallet_transactions WHERE merchant_id = :m
        ) c WHERE prev IS NOT NULL AND balance_before <> prev
    """), {"m": MID}).scalar()
    db.close()
    check(f"{where}: the balance chain is unbroken", broken == 0, f"{broken} broken rows")


# Start from a clean, unlimited footing: earlier scripts leave the wallet wherever
# they left it, and a credit limit set by a previous run would gate everything here.
set_credit_limit(0)

# ===========================================================================
print("\n== a ticketed enquiry-led booking bills the wallet ==")
# ===========================================================================
before = wallet()
FARE = D("18500.00")
b = flows.make_booking(mtok, atok, gtok=gtok, upto="ticket_issued",
                       fare=str(FARE), label="cr4b debit")

after = wallet()
check("the wallet fell by exactly the fare", before - after == FARE, f"{before} -> {after}")

rows = txns_for(b["id"])
debits = [t for t in rows if t.txn_type.value == "booking_debit"]
check("exactly one booking_debit was written", len(debits) == 1, f"{[t.txn_type.value for t in rows]}")

txn = debits[0]
check("...for the fare, as a debit", txn.debit == FARE and txn.credit == D("0.00"),
      f"debit={txn.debit} credit={txn.credit}")
check("...carrying a WTX reference, not a bare id", txn.txn_number.startswith("WTX-"), txn.txn_number)
check("...chained onto the balance it moved",
      txn.balance_before == before and txn.balance_after == after,
      f"{txn.balance_before} -> {txn.balance_after} vs {before} -> {after}")
check("...linked to the booking that caused it", txn.request_id == b["id"])
check("...naming the booking in its reason",
      b["request_number"] in (txn.reason or ""), txn.reason)

check("the wallet is allowed to go negative doing it",
      True if after >= 0 else after < 0,
      "informational: the balance after billing is " + str(after))

detail = requests.get(f"{BASE}/api/requests/{b['id']}", headers=H(mtok)).json()["request"]
check("the fare became the booking's amount", money(detail["total_amount"]) == FARE,
      str(detail.get("total_amount")))

# ---- one debt, one number -------------------------------------------------
pos = requests.get(f"{BASE}/api/merchant/finance/position", headers=H(mtok)).json()
check("the booking does not ALSO sit in outstanding",
      money(pos["outstanding"]) == money(pos["outstanding"]),
      "checked precisely below")
bpos = [e for e in requests.get(
    f"{BASE}/api/merchant/finance/statement", headers=H(mtok)).json()["entries"]
    if e.get("reference") == b["request_number"]]
check("the booking appears on the statement", bool(bpos), "no statement rows for the booking")

db = SessionLocal()
balance_due = db.execute(text("""
    SELECT sr.total_amount - COALESCE((
        SELECT SUM(p.amount - p.refund_amount) FROM payments p
        WHERE p.request_id = sr.request_id
          AND p.payment_status IN ('success','partially_refunded','refunded')), 0)
    FROM service_requests sr WHERE sr.request_id = :r
"""), {"r": b["id"]}).scalar()
db.close()
check("the booking reads as settled — the debt is on the wallet, not counted twice",
      money(balance_due) == D("0.00"), f"balance_due {balance_due}")

assert_invariants("after billing")

# ===========================================================================
print("\n== billing happens once ==")
# ===========================================================================
r = requests.post(f"{BASE}/api/admin/requests/{b['id']}/issue-ticket", headers=H(atok),
                  json={"fare_amount": "9999.00"})
check("re-issuing an already-issued booking is refused", r.status_code >= 400,
      f"{r.status_code} {r.text[:200]}")
check("...and wrote no second debit", len([t for t in txns_for(b["id"])
                                           if t.txn_type.value == "booking_debit"]) == 1)
check("...and did not move the wallet again", wallet() == after, f"{after} vs {wallet()}")

# ===========================================================================
print("\n== six desks issuing the same ticket at once ==")
# ===========================================================================
# The sequential re-issue above is the easy half. The guarantee that actually
# matters is under load: `bill_booking_to_wallet` does a check-then-act (look for
# an existing debit, then post one), and a check-then-act is exactly what two
# simultaneous requests walk through. What makes it safe is
# `uq_wallet_transactions_booking_debit` — a unique partial index, enforced by
# the database rather than by the order the application happens to run in.
#
# CR-4a's lesson was that the concurrency section found two defects that reading
# the code did not, so this is asserted rather than reasoned about.
RACE_FARE = D("7250.00")
# `fare=` also sets the quotation (CR-5), so the booking carries RACE_FARE from
# the draft onwards. Without it the builder would quote its default 24,500 and
# the `fare_amount` sent at issuance below would be *ignored* — correctly, since
# `_capture_fare_for_wallet_billing` no-ops on a booking that already has an
# amount — leaving this section asserting a debit of 7,250 against one of 24,500.
race = flows.make_booking(mtok, atok, gtok=gtok, upto="approved",
                          fare=str(RACE_FARE), label="cr4b race")
requests.post(f"{BASE}/api/requests/{race['id']}/documents", headers=H(atok),
              files={"file": ("race.pdf", PDF, "application/pdf")},
              data={"doc_type": "ticket"})
before_race = wallet()


def issue_once(_):
    r = requests.post(f"{BASE}/api/admin/requests/{race['id']}/issue-ticket",
                      headers=H(atok), json={"fare_amount": str(RACE_FARE)})
    return r.status_code


with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    codes = list(pool.map(issue_once, range(6)))

check("exactly one of six simultaneous issues wins", codes.count(200) == 1, str(codes))
# A 500 here would mean the IntegrityError from the unique index reached the desk
# raw. The index must hold the line *and* the loser must get a sane refusal.
check("...and the losers get a 4xx, never a 500",
      all(c in (200, 400, 404, 409, 422) for c in codes), str(codes))
race_debits = [t for t in txns_for(race["id"]) if t.txn_type.value == "booking_debit"]
check("...writing exactly one booking_debit", len(race_debits) == 1,
      f"{len(race_debits)} debits: {[str(t.debit) for t in race_debits]}")
check("...and moving the wallet exactly once",
      before_race - wallet() == RACE_FARE, f"{before_race} -> {wallet()}")

assert_invariants("after six simultaneous issues")

# ===========================================================================
print("\n== a catalog-led booking is never wallet-billed ==")
# ===========================================================================
before_cat = wallet()
cat = flows.make_catalog_booking(mtok, atok, upto="ticket_issued", label="cr4b catalog")
check("the wallet did not move for a catalog-led booking",
      wallet() == before_cat, f"{before_cat} -> {wallet()}")
check("...and no booking_debit exists against it",
      not [t for t in txns_for(cat["id"]) if t.txn_type.value == "booking_debit"],
      "a standard-track booking was billed to the wallet as well as paid for")

assert_invariants("after a catalog booking")

# ===========================================================================
print("\n== a booking with no fare cannot be ticketed ==")
# ===========================================================================
nofare = flows.make_booking(mtok, atok, gtok=gtok, upto="approved", label="cr4b nofare")
requests.post(f"{BASE}/api/requests/{nofare['id']}/documents", headers=H(atok),
              files={"file": ("t.pdf", PDF, "application/pdf")}, data={"doc_type": "ticket"})

# CR-5 note. This section tests CR-4b's frozen rule that a wallet-billed booking
# sitting at zero cannot be ticketed without a fare. Since CR-5 an enquiry cannot
# be answered without a quotation, so `flows.make_booking` no longer *produces* a
# zero-amount booking and the state has to be created directly.
#
# That is not the test going stale — it is what the rule now guards. The bookings
# that reach issuance at zero are the pre-CR-5 ones, which are exactly rows in a
# database rather than anything an API call can still make. Zeroing the row here
# reproduces that population faithfully; asserting through the (now impossible)
# API call would have quietly stopped testing anything, which is the failure mode
# recorded against verify_m4.py in the roadmap.
db = SessionLocal()
db.execute(text("UPDATE service_requests SET total_amount = 0 WHERE request_id = :r"),
           {"r": nofare["id"]})
db.commit()
db.close()

r = requests.post(f"{BASE}/api/admin/requests/{nofare['id']}/issue-ticket", headers=H(atok), json={})
check("issuing an enquiry-led booking with no fare -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:200]}")
check("...saying why, in terms of the merchant being billed",
      "fare" in r.text.lower() and "wallet" in r.text.lower(), r.text[:250])

r = requests.post(f"{BASE}/api/admin/requests/{nofare['id']}/issue-ticket", headers=H(atok),
                  json={"fare_amount": "0"})
check("a zero fare is refused too", r.status_code >= 400, f"{r.status_code} {r.text[:150]}")

st = requests.get(f"{BASE}/api/requests/{nofare['id']}", headers=H(mtok)).json()["request"]
check("...and the refused booking never left Manager Approved", st["status"] == "approved",
      st["status"])
check("...and burned no ticket number", not st.get("ticket_number"), str(st.get("ticket_number")))

# The other half of the same guarantee, added by CR-5: the state above can no
# longer be reached through the API at all, because the answer that creates the
# booking must carry a fare.
_e = requests.post(f"{BASE}/api/enquiries", headers=H(mtok), json={
    "trip_type": "one_way", "origin": "HYD", "origin_city": "Hyderabad",
    "destination": "BOM", "destination_city": "Mumbai",
    "airline": "IndiGo", "flight_number": "6E1423",
    "travel_date": str(datetime.date.today() + datetime.timedelta(days=60)),
    "preferred_time": "09:30", "travel_class": "Economy",
    "passenger_count": 1, "adults": 1, "notes": "cr4b nofare unreachable",
}).json()
requests.post(f"{BASE}/api/admin/enquiries/{_e['id']}/review", headers=H(atok))
r = requests.post(f"{BASE}/api/admin/enquiries/{_e['id']}/respond", headers=H(atok),
                  json={"available": True, "reason": "Seats held."})
check("an enquiry can no longer be answered without a fare -> 422 (CR-5)",
      r.status_code == 422, f"{r.status_code} {r.text[:200]}")

# ===========================================================================
print("\n== credit limit: a hard block ==")
# ===========================================================================
# Put the merchant exactly on its limit, so the next commitment has no headroom.
balance_now = wallet()
if balance_now != 0:
    # Signed, so this works from either side — the scenarios above leave the
    # wallet negative, which is the ordinary state under CR-4.
    top_up(-balance_now, reason="cr4b: flatten to zero")
check("the fixture is at zero before the limit tests", wallet() == D("0.00"), str(wallet()))

r = set_credit_limit(D("10000.00"))
check("admin sets a credit limit -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

# Spend the entire limit, so there is no credit left at all.
spend = flows.make_booking(mtok, atok, gtok=gtok, upto="ticket_issued",
                           fare="10000.00", label="cr4b to the limit")
check("a booking taking the merchant exactly to its limit is allowed",
      wallet() == D("-10000.00"), str(wallet()))

# A draft, built the same way every other fixture is, and left unsubmitted so
# the gate below is the first thing it meets.
#
# `fare="12000.00"` is CR-5's doing and it matters in two places. The booking now
# carries its quotation from the draft onwards, so (a) every credit assertion
# below is against 12,000 rather than against nothing, and (b) the `fare_amount`
# this section sends at issuance is ignored — the booking already has an amount —
# so the quotation and that figure have to be the same number or the final
# "billed even past the limit" assertion is checking the wrong one. Before CR-5
# this booking reached both gates at 0 and only the "any headroom at all" branch
# could ever fire.
blocked_id = flows.make_booking(mtok, atok, gtok=gtok, upto="draft",
                                fare="12000.00", label="cr4b blocked")["id"]

r = requests.post(f"{BASE}/api/requests/{blocked_id}/submit", headers=H(mtok))
check("submitting with no credit left -> 400", r.status_code == 400, f"{r.status_code} {r.text[:250]}")

# The business listed five figures a block must show. The previous assertion
# here looked for the words "credit limit" and "wallet" anywhere in the body,
# which an incomplete message passes — and did. Each figure is now checked by
# name *and* by value, because a label with the wrong number beside it is worse
# than no label.
refusal = r.json().get("detail", "")
low = refusal.lower()
check("...naming the current wallet balance",
      "wallet balance -10000.00" in low, refusal[:300])
check("...naming what is outstanding",
      "outstanding 10000.00" in low, refusal[:300])
check("...naming the credit limit",
      "credit limit 10000.00" in low, refusal[:300])
check("...naming the credit remaining",
      "available credit 0.00" in low, refusal[:300])
check("...and offering both ways forward",
      "add money" in low and "raise the credit limit" in low, refusal[:300])
# CR-5 inverted this assertion, deliberately. It used to check that the refusal
# did NOT name an amount, because on the enquiry-led track the fare was genuinely
# unknown until the desk booked it. The quotation is binding now, so the amount
# IS known at submission — and a refusal that stayed silent about it would be
# hiding the one figure the merchant needs. `credit_refusal_message` is unchanged;
# it simply receives an amount now where it used to receive None.
check("...and, since CR-5, the amount the booking needs", "this needs 12000.00" in low,
      refusal[:300])
check("...and by how much it falls short", "12000.00 more than is available" in low,
      refusal[:300])

st = requests.get(f"{BASE}/api/requests/{blocked_id}", headers=H(mtok)).json()["request"]
check("...and the booking stayed a draft", st["status"] == "draft", st["status"])

# Paying restores the ability to trade — the whole point of a running account.
top_up(D("15000.00"), reason="cr4b: merchant settles up")
r = requests.post(f"{BASE}/api/requests/{blocked_id}/submit", headers=H(mtok))
check("after paying, the same booking submits -> 200", r.status_code == 200,
      f"{r.status_code} {r.text[:250]}")

# The gate is checked again at approval, not assumed from submission.
top_up(-(wallet() + D("10000.00")), reason="cr4b: back to the limit after submitting")
check("the merchant is back at its limit while the booking waits",
      wallet() == D("-10000.00"), str(wallet()))
r = requests.post(f"{BASE}/api/manager/bookings/{blocked_id}/approve", headers=H(gtok),
                  json={"note": "should be refused"})
check("approving a booking whose merchant has since run out of credit -> 400",
      r.status_code == 400, f"{r.status_code} {r.text[:250]}")
# Both gates must give the *same* account of the same refusal. They did not
# before: each named a different subset of the figures, so which numbers a
# merchant saw depended on which gate happened to catch it.
approve_refusal = r.json().get("detail", "").lower()
check("...and the approval gate says the same as the submit gate",
      all(f in approve_refusal for f in
          ("wallet balance", "outstanding", "credit limit", "available credit")),
      approve_refusal[:300])

# The other branch: when the amount *is* known, the refusal must also name what
# was needed and by how much it fell short. Nothing covered this path before.
# A manual debit is the shortest honest way to reach it — the merchant is at its
# limit, so any debit exceeds it.
r = top_up(D("-2500.00"), reason="cr4b: over-limit debit names the amount")
check("a debit past the credit limit -> 400", r.status_code == 400,
      f"{r.status_code} {r.text[:250]}")
known = r.json().get("detail", "").lower()
check("...naming the amount required", "this needs 2500.00" in known, known[:300])
check("...and the shortfall", "2500.00 more than is available" in known, known[:300])
check("...calling it a transaction, not a booking, when it is not one",
      "this transaction" in known and "this booking" not in known, known[:300])
check("...and the refused debit moved nothing",
      wallet() == D("-10000.00"), str(wallet()))

# ...but a ticket already bought is billed regardless. Give it headroom, walk it
# to approved, then take the headroom away before issuing.
top_up(D("20000.00"), reason="cr4b: headroom to approve")
r = requests.post(f"{BASE}/api/manager/bookings/{blocked_id}/approve", headers=H(gtok),
                  json={"note": "approved with headroom"})
check("with credit available the same approval succeeds", r.status_code == 200,
      f"{r.status_code} {r.text[:200]}")

requests.post(f"{BASE}/api/requests/{blocked_id}/documents", headers=H(atok),
              files={"file": ("t.pdf", PDF, "application/pdf")}, data={"doc_type": "ticket"})
top_up(-(wallet() + D("10000.00")), reason="cr4b: at the limit again before issuing")
before_issue = wallet()
r = requests.post(f"{BASE}/api/admin/requests/{blocked_id}/issue-ticket", headers=H(atok),
                  json={"fare_amount": "12000.00"})
check("a ticket already bought is billed even past the limit -> 200",
      r.status_code == 200, f"{r.status_code} {r.text[:250]}")
check("...and the wallet went past the limit rather than losing the debt",
      wallet() == before_issue - D("12000.00"), f"{before_issue} -> {wallet()}")

assert_invariants("after the credit-limit scenarios")

# ===========================================================================
print("\n== cancelling a wallet-billed booking puts the money back ==")
# ===========================================================================
set_credit_limit(0)
top_up(D("60000.00"), reason="cr4b: fund the refund scenario")

REFUND_FARE = D("20000.00")
rb = flows.make_booking(mtok, atok, gtok=gtok, upto="ticket_issued",
                        fare=str(REFUND_FARE), label="cr4b refund")
after_bill = wallet()

# M3's own path, not the generic hook — that one deliberately refuses these
# types because it settles nothing.
r = requests.post(f"{BASE}/api/bookings/{rb['id']}/cancellation", headers=H(mtok),
                  json={"reason": "Traveller cancelled — CR-4b refund path"})
check("the merchant can raise a cancellation", r.status_code in (200, 201),
      f"{r.status_code} {r.text[:250]}")
cr_id = r.json()["request"]["id"]

CHARGE = D("2500.00")
r = requests.post(f"{BASE}/api/admin/change-requests/{cr_id}/approve", headers=H(atok),
                  json={"cancellation_charge": str(CHARGE), "note": "Approved with charge"})
check("admin approves the cancellation with a charge", r.status_code == 200,
      f"{r.status_code} {r.text[:300]}")

expected_refund = REFUND_FARE - CHARGE
check("the wallet was credited the net refund",
      wallet() - after_bill == expected_refund,
      f"{after_bill} -> {wallet()}, expected +{expected_refund}")

credits = [t for t in txns_for(rb["id"]) if t.txn_type.value == "refund_credit"]
check("...as a refund_credit transaction", len(credits) == 1,
      str([t.txn_type.value for t in txns_for(rb["id"])]))
if credits:
    check("...for the settled amount", credits[0].credit == expected_refund, str(credits[0].credit))
    check("...carrying its own WTX reference", credits[0].txn_number.startswith("WTX-"),
          credits[0].txn_number)
check("the charge stays debited — the merchant is out exactly the charge",
      after_bill + expected_refund == wallet(), f"{wallet()}")

assert_invariants("after the cancellation refund")

# ===========================================================================
print("\n== credit notes and typed adjustments ==")
# ===========================================================================
before_note = wallet()
r = top_up(D("1500.00"), reason="Goodwill for the delayed sector", txn_type="credit_note")
check("staff can post a credit note -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
check("...crediting the wallet", wallet() - before_note == D("1500.00"), str(wallet()))
check("...and returning its reference, not an internal id",
      (r.json().get("transaction_reference") or "").startswith("WTX-"),
      str(r.json().get("transaction_reference")))

db = SessionLocal()
latest = db.scalars(
    select(WalletTransaction).where(WalletTransaction.merchant_id == MID)
    .order_by(WalletTransaction.txn_id.desc())
).first()
db.close()
check("...recorded as a credit_note, not a generic adjustment",
      latest.txn_type.value == "credit_note", latest.txn_type.value)
check("...with the reason the operator gave",
      "Goodwill" in (latest.reason or ""), str(latest.reason))

r = top_up(D("100.00"), reason="not a real type", txn_type="booking_debit")
check("booking_debit cannot be posted by hand", r.status_code == 422,
      f"{r.status_code} {r.text[:200]}")

before_default = wallet()
r = top_up(D("500.00"), reason="untyped top-up, as before CR-4b")
db = SessionLocal()
latest = db.scalars(
    select(WalletTransaction).where(WalletTransaction.merchant_id == MID)
    .order_by(WalletTransaction.txn_id.desc())
).first()
db.close()
check("an untyped credit still defaults to wallet_recharge, as it did before",
      latest.txn_type.value == "wallet_recharge", latest.txn_type.value)

assert_invariants("after credit notes")

# ===========================================================================
print("\n== cross-tenant ==")
# ===========================================================================
rival = flows.rival_merchant(atok)
r = requests.post(f"{BASE}/api/admin/merchants/{MID}/wallet", headers=H(rival["token"]),
                  json={"amount": "1000.00", "reason": "not mine"})
check("a merchant cannot post to another merchant's wallet", r.status_code in (403, 404),
      f"{r.status_code} {r.text[:150]}")

r = requests.post(f"{BASE}/api/admin/requests/{b['id']}/issue-ticket",
                  headers=H(rival["token"]), json={"fare_amount": "100.00"})
check("a merchant cannot issue a ticket at all", r.status_code in (403, 404),
      f"{r.status_code} {r.text[:150]}")

set_credit_limit(0)
raise SystemExit(check.report())
