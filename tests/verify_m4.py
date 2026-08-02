"""M4 — Finance, Billing & Payment Tracking.

Proves the roadmap's five verification requirements:

  * ledger arithmetic against **hand-computed** fixtures, including partial refunds
  * credit-limit enforcement server-side
  * every money figure traced back to the one service function
  * Decimal all the way out — no float anywhere in the money path
  * concurrency: two simultaneous verifications of one payment

The arithmetic assertions are written as literal expected strings rather than
recomputed from the response, because a test that recomputes the number the same
way the code does will agree with the code even when both are wrong.
"""
import concurrent.futures
import datetime
import json
import sys
from decimal import Decimal

import flows
import minihttp as requests
from config import ADMIN, BASE, MERCHANT, Checker, H, login

_c = Checker()
check = _c

D = Decimal


def money(v) -> Decimal:
    return Decimal(str(v))


def wallet_after(response):
    """The `wallet_balance` a wallet adjustment reports, or None if it did not
    make one.

    `money(r.json()["wallet_balance"])` reads fine until the adjustment is
    refused: an error body carries `detail`, not `wallet_balance`, so the check
    that was about to fail raises `KeyError` instead and takes every remaining
    check in the file down with it. Returning None lets the check fail, say
    what the server actually answered, and let the script carry on."""
    value = (response.json() or {}).get("wallet_balance")
    return money(value) if value is not None else None


def position(token, merchant_id=None):
    url = (f"{BASE}/api/admin/merchants/{merchant_id}/finance" if merchant_id
           else f"{BASE}/api/merchant/finance/position")
    return requests.get(url, headers=H(token)).json()


def newest_payment(response):
    """`/pay` answers with the whole request detail, so the payment just made is
    the newest row in its `payments` list — there is no bare payment id to read."""
    payments = (response.json() or {}).get("payments") or []
    return max((p["id"] for p in payments), default=None)


def set_credit_limit(atok, merchant_id, limit):
    """Through the real admin endpoint, not a direct UPDATE."""
    return requests.put(f"{BASE}/api/admin/merchants/{merchant_id}", headers=H(atok),
                        json={"credit_limit": str(limit)})


def main():
    mtok = login(*MERCHANT)
    atok = login(*ADMIN)
    me = requests.get(f"{BASE}/api/auth/me", headers=H(mtok)).json()
    merchant_id = me.get("merchant_id")
    check("merchant id resolved from the token", bool(merchant_id), json.dumps(me)[:200])

    # =====================================================================
    print("\n== the ledger is one computation, and it is Decimal ==")
    # =====================================================================
    p = position(mtok)
    for field in ("billed", "paid", "refunded", "net_paid", "outstanding",
                  "wallet_balance", "credit_limit", "spending_power"):
        check(f"{field} is serialised as a decimal string, not a float",
              isinstance(p[field], str) and "." in p[field], f"{field}={p[field]!r}")

    check("net_paid == paid - refunded",
          money(p["net_paid"]) == money(p["paid"]) - money(p["refunded"]),
          f"{p['paid']} - {p['refunded']} != {p['net_paid']}")
    check("credit_available is null while no limit is configured",
          p["credit_available"] is None if not p["has_credit_limit"] else True,
          str(p["credit_available"]))

    admin_view = position(atok, merchant_id)
    check("admin and merchant read the identical position",
          admin_view["outstanding"] == p["outstanding"] and admin_view["billed"] == p["billed"],
          f"{admin_view['outstanding']} vs {p['outstanding']}")

    # =====================================================================
    print("\n== hand-computed fixture: bill 24,500, pay 10,000, refund 2,500 ==")
    # =====================================================================
    before = money(position(mtok)["outstanding"])

    b = flows.make_catalog_booking(mtok, atok, upto="payment_pending", label="m4 arithmetic")
    rid = b["id"]
    # flows approves at 24500.00
    after_bill = money(position(mtok)["outstanding"])
    check("billing 24,500 moves outstanding by exactly 24,500",
          after_bill - before == D("24500.00"), f"{before} -> {after_bill}")

    # --- a partial payment must NOT settle the booking -------------------
    r = requests.post(f"{BASE}/api/requests/{rid}/pay", headers=H(mtok),
                      json={"amount": "10000.00", "method": "bank_transfer",
                            "transaction_id": f"M4PART{rid}"})
    check("partial payment accepted -> 200/201", r.status_code in (200, 201), f"{r.status_code} {r.text[:200]}")
    pay_id = newest_payment(r)

    detail = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()
    check("an unverified payment does not reduce what is owed",
          money(position(mtok)["outstanding"]) - before == D("24500.00"),
          str(money(position(mtok)["outstanding"]) - before))
    check("but it is visible as awaiting verification",
          money(position(mtok)["awaiting_verification"]) >= D("10000.00"),
          position(mtok)["awaiting_verification"])

    r = requests.post(f"{BASE}/api/admin/payments/{pay_id}/verify", headers=H(atok),
                      json={"approve": True})
    check("verify the partial payment -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")

    detail = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()
    check("a PARTIALLY paid booking is still Payment Pending, not Paid",
          detail["request"]["status"] == "payment_pending", detail["request"]["status"])
    check("outstanding fell by exactly the 10,000 verified",
          money(position(mtok)["outstanding"]) - before == D("14500.00"),
          str(money(position(mtok)["outstanding"]) - before))

    # --- overpayment is refused -----------------------------------------
    r = requests.post(f"{BASE}/api/requests/{rid}/pay", headers=H(mtok),
                      json={"amount": "14500.01", "method": "bank_transfer",
                            "transaction_id": f"M4OVER{rid}"})
    check("paying one paisa more than is owed -> 400", r.status_code == 400, f"{r.status_code} {r.text[:250]}")
    check("...and the refusal states what is actually left",
          "14500.00" in r.text, r.text[:250])

    # --- settle the rest, which DOES move it to Paid ---------------------
    r = requests.post(f"{BASE}/api/requests/{rid}/pay", headers=H(mtok),
                      json={"amount": "14500.00", "method": "bank_transfer",
                            "transaction_id": f"M4REST{rid}"})
    rest_id = newest_payment(r)
    requests.post(f"{BASE}/api/admin/payments/{rest_id}/verify", headers=H(atok), json={"approve": True})
    detail = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()
    check("paying the remainder moves the booking to Paid",
          detail["request"]["status"] == "paid", detail["request"]["status"])
    check("the booking now owes nothing",
          money(position(mtok)["outstanding"]) == before, str(money(position(mtok)["outstanding"])))

    # --- partial refund --------------------------------------------------
    r = requests.post(f"{BASE}/api/admin/payments/{pay_id}/refund", headers=H(atok),
                      json={"amount": "2500.00", "reason": "Fare correction after ticketing"})
    check("partial refund -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("the refunded payment is marked partially_refunded",
          r.json().get("status") == "partially_refunded" or r.json().get("payment_status") == "partially_refunded",
          json.dumps(r.json())[:250])
    check("a 2,500 refund puts 2,500 back on the balance",
          money(position(mtok)["outstanding"]) - before == D("2500.00"),
          str(money(position(mtok)["outstanding"]) - before))

    r = requests.post(f"{BASE}/api/admin/payments/{pay_id}/refund", headers=H(atok),
                      json={"amount": "8000.00", "reason": "too much"})
    check("a refund exceeding that payment -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    # =====================================================================
    print("\n== statement reconciles with the position ==")
    # =====================================================================
    st = requests.get(f"{BASE}/api/merchant/finance/statement", headers=H(mtok)).json()
    check("statement returns entries", len(st["entries"]) > 0, str(len(st["entries"])))
    check("running balance on the last row equals closing_balance",
          st["entries"][-1]["balance"] == st["closing_balance"],
          f"{st['entries'][-1]['balance']} vs {st['closing_balance']}")
    recomputed = money(st["total_debits"]) - money(st["total_credits"])
    check("closing balance == total debits - total credits",
          recomputed == money(st["closing_balance"]),
          f"{recomputed} vs {st['closing_balance']}")
    check("the statement carries the same position object",
          st["position"]["outstanding"] == position(mtok)["outstanding"],
          f"{st['position']['outstanding']}")
    check("a failed payment never appears on the statement",
          all(e["kind"] != "payment" or money(e["credit"]) > 0 for e in st["entries"]))

    # =====================================================================
    print("\n== wallet ==")
    # =====================================================================
    start_wallet = money(position(mtok)["wallet_balance"])
    r = requests.post(f"{BASE}/api/admin/merchants/{merchant_id}/wallet", headers=H(atok),
                      json={"amount": "50000.00", "reason": "Advance received by NEFT"})
    check("admin tops up the wallet -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("wallet balance rose by exactly the top-up",
          wallet_after(r) == start_wallet + D("50000.00"),
          f"{start_wallet} -> {r.text[:160]}")

    # CR-4a changed this rule, and the roadmap's §0 requires the script to
    # assert the new contract rather than the old one. The wallet is a running
    # account now: a debit past zero is the *ordinary* case, and what bounds it
    # is the credit limit (exercised in verify_cr4a.py), not a floor at zero.
    #
    # The old assertion had also quietly stopped testing anything. It tried to
    # overdraw by a fixed 999,999 and expected a refusal — but the seeded wallet
    # grows by 50,000 on every run of this script, so once it passed 999,999 the
    # debit no longer crossed zero and the check was asserting a refusal that had
    # nothing to do with the rule. The replacement is computed from the balance
    # and therefore says the same thing on every run.
    #
    # It still assumed one thing it never checked: that the balance here is not
    # *already* further below zero than the overdraw itself. `overdraw` is
    # derived as `balance + 50,000`, so the moment an earlier script leaves the
    # wallet under -50,000 at this point, `overdraw` is itself negative and
    # `f"-{overdraw}"` renders the literal `--400000.00`. The API rejects that
    # with 422 decimal_parsing, and the assertion below then died on
    # `KeyError: 'wallet_balance'`, taking the rest of the file with it.
    # It reads exactly like this suite's usual order-flakiness — verify_m4 run
    # alone leaves the wallet high enough for the derivation to hold — but it is
    # this fixture assuming a starting state, not the ordering.
    #
    # Two changes, because there were two faults. Clear any carried-over deficit
    # first: "a debit past zero" only means anything while the balance starts on
    # the positive side of zero, and funding the scenario rather than hoping for
    # it is what the wallet payment below already does. And build the debit with
    # `str(-overdraw)` rather than by prefixing a minus to whatever the number
    # renders as, so the string is well formed for any sign.
    carried = money(position(mtok)["wallet_balance"])
    if carried < 0:
        requests.post(f"{BASE}/api/admin/merchants/{merchant_id}/wallet", headers=H(atok),
                      json={"amount": str(-carried),
                            "reason": "m4: clear a carried-over deficit before the overdraw test"})

    before_overdraw = money(position(mtok)["wallet_balance"])
    overdraw = before_overdraw + D("50000.00")
    r = requests.post(f"{BASE}/api/admin/merchants/{merchant_id}/wallet", headers=H(atok),
                      json={"amount": str(-overdraw), "reason": "CR-4a: debit past zero"})
    check("a debit past zero is now accepted -> 200", r.status_code == 200,
          f"{r.status_code} {r.text[:250]}")
    check("...and leaves the wallet negative by exactly the overdraw",
          wallet_after(r) == D("-50000.00"), r.text[:200])

    r = requests.post(f"{BASE}/api/admin/merchants/{merchant_id}/wallet", headers=H(atok),
                      json={"amount": str(overdraw), "reason": "CR-4a: settle the overdraw"})
    check("crediting it back lifts the balance through zero again",
          wallet_after(r) == before_overdraw,
          f"{before_overdraw} vs {r.text[:160]}")

    r = requests.post(f"{BASE}/api/admin/merchants/{merchant_id}/wallet", headers=H(atok),
                      json={"amount": "0", "reason": "nothing"})
    check("a zero adjustment is refused -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.post(f"{BASE}/api/admin/merchants/{merchant_id}/wallet", headers=H(mtok),
                      json={"amount": "1000.00", "reason": "self-service top-up"})
    check("a merchant cannot top up its own wallet -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    # --- paying from the wallet actually moves it ------------------------
    b2 = flows.make_catalog_booking(mtok, atok, upto="payment_pending", label="m4 wallet")

    # Fund the scenario instead of hoping the shared wallet is deep enough.
    # This asserted against whatever balance the development wallet happened to
    # carry, which worked only while the suite put more in than it took out.
    # Since CR-5 an enquiry-led booking is priced from the draft onwards, so more
    # of the fixtures ahead of this one bill the wallet for real, and the balance
    # arrives lower — the same "fixed expectation against a drifting fixture"
    # trap the roadmap records against this file's overdraw test, in the other
    # direction. Topping up to cover the payment makes the check independent of
    # what ran before it.
    shortfall = D("24500.00") - money(position(mtok)["wallet_balance"])
    if shortfall > 0:
        requests.post(f"{BASE}/api/admin/merchants/{merchant_id}/wallet", headers=H(atok),
                      json={"amount": str(shortfall), "reason": "m4: fund the wallet payment"})

    wallet_before = money(position(mtok)["wallet_balance"])
    r = requests.post(f"{BASE}/api/requests/{b2['id']}/pay", headers=H(mtok),
                      json={"amount": "24500.00", "method": "wallet",
                            "transaction_id": f"M4WAL{b2['id']}"})
    check("wallet payment accepted", r.status_code in (200, 201), f"{r.status_code} {r.text[:250]}")
    check("the wallet was actually debited",
          wallet_before - money(position(mtok)["wallet_balance"]) == D("24500.00"),
          f"{wallet_before} -> {position(mtok)['wallet_balance']}")

    wpay = newest_payment(r)
    r = requests.post(f"{BASE}/api/admin/payments/{wpay}/verify", headers=H(atok),
                      json={"approve": False, "note": "Wrong reference"})
    check("refusing a wallet payment -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("a refused wallet payment gives the money back",
          money(position(mtok)["wallet_balance"]) == wallet_before,
          f"{wallet_before} vs {position(mtok)['wallet_balance']}")

    # =====================================================================
    print("\n== credit limit ==")
    # =====================================================================
    p = position(mtok)
    check("no limit configured means unlimited, not zero",
          p["has_credit_limit"] is False and p["credit_available"] is None,
          json.dumps(p)[:200])

    b3 = flows.make_catalog_booking(mtok, atok, upto="pending_approval", label="m4 credit")
    outstanding_now = money(position(atok, merchant_id)["outstanding"])
    wallet_now = money(position(atok, merchant_id)["wallet_balance"])

    # A limit that leaves room for 1,000 but not for 24,500.
    tight = outstanding_now - wallet_now + D("1000.00")
    r = set_credit_limit(atok, merchant_id, tight)
    check("admin sets a credit limit -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("the limit is now reported as configured",
          position(mtok)["has_credit_limit"] is True, json.dumps(position(mtok))[:200])

    r = requests.post(f"{BASE}/api/admin/requests/{b3['id']}/approve", headers=H(atok),
                      json={"final_amount": "24500.00"})
    check("approving past the credit limit -> 400", r.status_code == 400, f"{r.status_code} {r.text[:300]}")
    check("...and the refusal says by how much and names the merchant",
          "over its credit limit" in r.text, r.text[:300])

    r = requests.post(f"{BASE}/api/admin/requests/{b3['id']}/approve", headers=H(atok),
                      json={"final_amount": "500.00"})
    check("approving within the limit still works", r.status_code == 200, f"{r.status_code} {r.text[:300]}")

    detail = requests.get(f"{BASE}/api/requests/{b3['id']}", headers=H(atok)).json()
    check("the refused approval left the booking untouched (not half-priced)",
          money(detail["request"]["total_amount"]) == D("500.00"),
          str(detail["request"]["total_amount"]))

    p = position(mtok)
    # Negative is legitimate and meaningful: it is how far past the ceiling the
    # merchant already is. Clamping it at zero would hide exactly that.
    check("credit_available is now a real number",
          p["credit_available"] is not None, str(p["credit_available"]))
    check("credit_available == limit - outstanding",
          money(p["credit_available"]) == money(p["credit_limit"]) - money(p["outstanding"]),
          f"{p['credit_limit']} - {p['outstanding']} != {p['credit_available']}")

    set_credit_limit(atok, merchant_id, "0")
    check("clearing the limit restores unlimited",
          position(mtok)["has_credit_limit"] is False)

    # =====================================================================
    print("\n== cancellation refunds settle into the ledger (M3 -> M4) ==")
    # =====================================================================
    b4 = flows.make_catalog_booking(mtok, atok, upto="paid", label="m4 cancel refund")
    paid_pos = position(mtok)
    r = requests.post(f"{BASE}/api/bookings/{b4['id']}/cancellation", headers=H(mtok),
                      json={"reason": "Client cancelled the trip"})
    check("raise a cancellation -> 201/200", r.status_code in (200, 201), f"{r.status_code} {r.text[:250]}")
    body = r.json()
    cr_id = body.get("id") or (body.get("request") or {}).get("id")

    r = requests.post(f"{BASE}/api/admin/change-requests/{cr_id}/approve", headers=H(atok),
                      json={"cancellation_charge": "4500.00"})
    check("approve the cancellation with a 4,500 charge -> 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")

    cr = requests.get(f"{BASE}/api/change-requests/{cr_id}", headers=H(atok)).json()
    pricing = cr["request"].get("pricing") or {}
    check("M3 still computes refund = 24,500 - 4,500",
          money(pricing.get("refund_amount", 0)) == D("20000.00"), json.dumps(pricing)[:250])
    check("M4 records what was actually settled",
          money(pricing.get("refund_settled", -1)) == D("20000.00"), json.dumps(pricing)[:250])
    check("nothing was left unsettled",
          money(pricing.get("refund_unsettled", -1)) == D("0.00"), json.dumps(pricing)[:250])

    after_cancel = position(mtok)
    check("the refund shows up as money given back",
          money(after_cancel["refunded"]) - money(paid_pos["refunded"]) == D("20000.00"),
          f"{paid_pos['refunded']} -> {after_cancel['refunded']}")
    check("a cancelled booking stops being billable",
          money(after_cancel["outstanding"]) == money(paid_pos["outstanding"]),
          f"{paid_pos['outstanding']} -> {after_cancel['outstanding']}")

    st = requests.get(f"{BASE}/api/merchant/finance/statement", headers=H(mtok)).json()
    check("the refund appears on the statement as a debit",
          any(e["kind"] == "refund" and money(e["debit"]) > 0 for e in st["entries"]))

    # =====================================================================
    print("\n== two admins verifying one payment at once ==")
    # =====================================================================
    b5 = flows.make_catalog_booking(mtok, atok, upto="payment_pending", label="m4 race")
    r = requests.post(f"{BASE}/api/requests/{b5['id']}/pay", headers=H(mtok),
                      json={"amount": "24500.00", "method": "bank_transfer",
                            "transaction_id": f"M4RACE{b5['id']}"})
    race_id = newest_payment(r)

    def verify_once(_):
        return requests.post(f"{BASE}/api/admin/payments/{race_id}/verify",
                             headers=H(atok), json={"approve": True}).status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(verify_once, range(6)))
    check("exactly one of six simultaneous verifications wins",
          codes.count(200) == 1, str(codes))
    check("the losers get 400, never a 500", all(c in (200, 400) for c in codes), str(codes))

    detail = requests.get(f"{BASE}/api/requests/{b5['id']}", headers=H(atok)).json()
    paid_steps = [s for s in detail["timeline"] if s.get("status") == "paid" and s.get("at")]
    check("the booking was marked Paid exactly once", len(paid_steps) == 1, str(len(paid_steps)))

    payments = detail.get("payments") or []
    settled = [p for p in payments if p["status"] == "success"]
    check("and only one payment row is successful", len(settled) == 1, str(len(settled)))

    # =====================================================================
    print("\n== invoice numbering is gap-free and never reused ==")
    # =====================================================================
    issued = []
    for i in range(3):
        bk = flows.make_catalog_booking(mtok, atok, upto="ticket_issued", label=f"m4 invoice {i}")
        d = requests.get(f"{BASE}/api/requests/{bk['id']}", headers=H(atok)).json()
        issued.append(d["request"]["invoice_number"])
    check("every issued ticket carries an invoice number", all(issued), str(issued))
    check("invoice numbers are unique", len(set(issued)) == len(issued), str(issued))
    seq = [int(n.rsplit("-", 1)[-1]) for n in issued]
    check("allocated strictly increasing with no reuse",
          all(b > a for a, b in zip(seq, seq[1:])), str(seq))

    # A rejected transition must not burn a number.
    bk = flows.make_catalog_booking(mtok, atok, upto="payment_pending", label="m4 invoice burn")
    r = requests.post(f"{BASE}/api/admin/requests/{bk['id']}/issue-ticket", headers=H(atok))
    check("issuing a ticket before payment is refused", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    bk2 = flows.make_catalog_booking(mtok, atok, upto="ticket_issued", label="m4 invoice after burn")
    d = requests.get(f"{BASE}/api/requests/{bk2['id']}", headers=H(atok)).json()
    nxt = int(d["request"]["invoice_number"].rsplit("-", 1)[-1])
    check("the refused attempt burned no invoice number", nxt == seq[-1] + 1, f"{seq[-1]} -> {nxt}")

    # =====================================================================
    print("\n== a booking cannot be approved without a fare ==")
    # =====================================================================
    # This rule was written for enquiry-led bookings, which reached approval at
    # 0.00 and, once approved, sat in Payment Pending unable to be paid or
    # re-priced. CR-2 removed that failure mode at the root: an enquiry-led
    # booking is now approved by a Manager and never enters Payment Pending at
    # all, and the admin approval path refuses it outright — asserted below, and
    # at length in verify_cr2.py.
    #
    # The rule itself still matters for the track that *does* bill, so it is
    # re-asserted here against a catalog-led booking rather than deleted.
    classic = flows.make_booking(mtok, atok, upto="pending_approval", label="m4 classic guard")
    r = requests.post(f"{BASE}/api/admin/requests/{classic['id']}/approve", headers=H(atok),
                      json={"final_amount": "31000.00"})
    check("an enquiry-led booking cannot be approved by an admin at all -> 400",
          r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    check("and the refusal points at the Manager",
          "manager" in r.text.lower(), r.text[:200])

    # "No amount at all" is no longer reachable: a catalog-led booking is priced
    # from its inventory row before it is ever submitted, and the track that
    # arrived unpriced no longer comes through this endpoint. Approving with an
    # explicit zero is the case that survives, and it is the one that mattered —
    # a booking at 0.00 in Payment Pending is one the merchant cannot pay.
    b6 = flows.make_catalog_booking(mtok, atok, upto="pending_approval", label="m4 unpriced")
    r = requests.post(f"{BASE}/api/admin/requests/{b6['id']}/approve", headers=H(atok),
                      json={"final_amount": "0"})
    check("approving at an explicit 0 -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    d = requests.get(f"{BASE}/api/requests/{b6['id']}", headers=H(atok)).json()
    check("the refused approval left the booking untouched, not half-approved",
          d["request"]["status"] == "pending_approval", d["request"]["status"])
    check("and wrote nothing to the timeline",
          not [s for s in d["timeline"] if s.get("status") == "approved" and s.get("at")])

    r = requests.post(f"{BASE}/api/admin/requests/{b6['id']}/approve", headers=H(atok),
                      json={"final_amount": "31000.00", "note": "Fare confirmed."})
    check("approving with an amount succeeds", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    d = requests.get(f"{BASE}/api/requests/{b6['id']}", headers=H(atok)).json()
    check("and lands in Payment Pending at that amount",
          d["request"]["status"] == "payment_pending"
          and money(d["request"]["total_amount"]) == D("31000.00"),
          f"{d['request']['status']} {d['request']['total_amount']}")

    # =====================================================================
    print("\n== correcting the amount after approval (/reprice) ==")
    # =====================================================================
    RP = f"{BASE}/api/admin/requests"

    # Wrong stages, before and after Payment Pending.
    draft = flows.make_booking(mtok, atok, upto="draft", label="m4 reprice draft")
    r = requests.post(f"{RP}/{draft['id']}/reprice", headers=H(atok),
                      json={"amount": "100.00", "reason": "no"})
    check("re-pricing a draft -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    paid = flows.make_catalog_booking(mtok, atok, upto="paid", label="m4 reprice paid")
    r = requests.post(f"{RP}/{paid['id']}/reprice", headers=H(atok),
                      json={"amount": "100.00", "reason": "no"})
    check("re-pricing a paid booking -> 400 (that is a refund, not an overwrite)",
          r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    # The happy path, up and then down.
    b7 = flows.make_catalog_booking(mtok, atok, upto="payment_pending", label="m4 reprice")
    r = requests.post(f"{RP}/{b7['id']}/reprice", headers=H(atok),
                      json={"amount": "26750.50", "reason": "Airline reissued at a higher fare"})
    check("re-pricing upwards succeeds", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    d = requests.get(f"{BASE}/api/requests/{b7['id']}", headers=H(atok)).json()
    check("the new amount is stored to the paisa",
          money(d["request"]["total_amount"]) == D("26750.50"), str(d["request"]["total_amount"]))
    check("the status is untouched — re-pricing is not a transition",
          d["request"]["status"] == "payment_pending", d["request"]["status"])
    before_steps = len([s for s in d["timeline"] if s.get("at")])

    r = requests.post(f"{RP}/{b7['id']}/reprice", headers=H(atok),
                      json={"amount": "19000.00", "reason": "Corrected — wrong cabin quoted"})
    check("re-pricing downwards succeeds too", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    d = requests.get(f"{BASE}/api/requests/{b7['id']}", headers=H(atok)).json()
    check("no timeline step was added by either correction",
          len([s for s in d["timeline"] if s.get("at")]) == before_steps)
    history = ((d["request"].get("pricing") or {}).get("history") or [])
    check("both corrections are recorded in pricing.history", len(history) == 2, json.dumps(history)[:300])
    check("history carries from/to/reason/actor",
          bool(history) and all(k in history[-1] for k in ("from", "to", "reason", "by_name")),
          json.dumps(history[-1:])[:300])

    # Refusals.
    r = requests.post(f"{RP}/{b7['id']}/reprice", headers=H(atok),
                      json={"amount": "19000.00", "reason": "same again"})
    check("re-sending the amount it already has -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{RP}/{b7['id']}/reprice", headers=H(atok), json={"amount": "0", "reason": "x"})
    check("an amount of 0 -> 422 (schema)", r.status_code == 422, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{RP}/{b7['id']}/reprice", headers=H(atok), json={"amount": "500.00"})
    check("no reason -> 422 (the merchant is told why)", r.status_code == 422, f"{r.status_code} {r.text[:200]}")
    # b7 is catalog-led and has no enquiry behind it, so one is built for this.
    enq_only = flows.make_booking(mtok, atok, upto="draft", label="m4 reprice enquiry")
    r = requests.post(f"{RP}/{enq_only['enquiry_id']}/reprice", headers=H(atok),
                      json={"amount": "500.00", "reason": "x"})
    check("re-pricing an enquiry -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{RP}/{b7['id']}/reprice", headers=H(mtok),
                      json={"amount": "500.00", "reason": "cheaper please"})
    check("a merchant cannot re-price its own booking -> 403",
          r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    # The point of the whole fix: the merchant can now pay the corrected figure,
    # and only that figure.
    r = requests.post(f"{BASE}/api/requests/{b7['id']}/pay", headers=H(mtok),
                      json={"amount": "26750.50", "method": "bank_transfer",
                            "transaction_id": f"M4RP{b7['id']}A"})
    check("paying the superseded amount is refused as an overpayment",
          r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{BASE}/api/requests/{b7['id']}/pay", headers=H(mtok),
                      json={"amount": "19000.00", "method": "bank_transfer",
                            "transaction_id": f"M4RP{b7['id']}B"})
    check("paying the corrected amount succeeds", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # Concurrency: same target amount from several threads. Serialized by the
    # row lock, exactly one write finds a different value to replace; without
    # the lock they would all read the old total and all succeed.
    b8 = flows.make_catalog_booking(mtok, atok, upto="payment_pending", label="m4 reprice race")

    def reprice_once(_):
        return requests.post(f"{RP}/{b8['id']}/reprice", headers=H(atok),
                             json={"amount": "27500.00", "reason": "race"}).status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(reprice_once, range(6)))
    check("exactly one of six identical re-prices wins", codes.count(200) == 1, str(codes))
    check("the losers get 400, never a 500", all(c in (200, 400) for c in codes), str(codes))
    d = requests.get(f"{BASE}/api/requests/{b8['id']}", headers=H(atok)).json()
    check("and the booking carries exactly one correction",
          len(((d["request"].get("pricing") or {}).get("history") or [])) == 1)

    # Credit limit still applies to the increase, and never to a reduction.
    set_credit_limit(atok, merchant_id, "1000.00")
    r = requests.post(f"{RP}/{b8['id']}/reprice", headers=H(atok),
                      json={"amount": "900000.00", "reason": "way over the limit"})
    check("a correction that breaches the credit limit is refused",
          r.status_code == 400 and "credit limit" in r.text.lower(), f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{RP}/{b8['id']}/reprice", headers=H(atok),
                      json={"amount": "100.00", "reason": "reduced"})
    check("a reduction is never refused for credit", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    set_credit_limit(atok, merchant_id, "0")

    # =====================================================================
    print("\n== the approval queue shows what is waiting on us ==")
    # =====================================================================
    q = requests.get(f"{BASE}/api/admin/approval-queue?page_size=100", headers=H(atok)).json()
    rows = q.get("items", [])
    check("queue rows carry total_amount", all("total_amount" in i for i in rows) if rows else True)
    check("a priced Payment Pending booking is NOT in the default queue — it waits on the merchant",
          not any(i["id"] == b7["id"] and i["kind"] == "request" for i in rows))
    q2 = requests.get(f"{BASE}/api/admin/approval-queue?status=payment_pending&page_size=100",
                      headers=H(atok)).json()
    check("but an explicit status=payment_pending lists it",
          any(i["id"] == b7["id"] and i["kind"] == "request" for i in q2.get("items", [])))

    # =====================================================================
    print("\n== cross-tenant and RBAC ==")
    # =====================================================================
    rival = flows.rival_merchant(atok)
    rtok = rival["token"] if isinstance(rival, dict) else rival
    r = requests.post(f"{RP}/{b7['id']}/reprice", headers=H(rtok),
                      json={"amount": "500.00", "reason": "not mine"})
    check("another company re-pricing -> 403/404, never a successful write",
          r.status_code in (403, 404), f"{r.status_code} {r.text[:200]}")
    r = requests.get(f"{BASE}/api/admin/merchants/{merchant_id}/finance", headers=H(rtok))
    check("another company's position -> 404, not 403", r.status_code == 404, f"{r.status_code} {r.text[:200]}")
    r = requests.get(f"{BASE}/api/admin/merchants/{merchant_id}/statement", headers=H(rtok))
    check("another company's statement -> 404", r.status_code == 404, f"{r.status_code} {r.text[:200]}")
    r = requests.get(f"{BASE}/api/merchant/finance/position")
    check("no token -> 401/403", r.status_code in (401, 403), str(r.status_code))

    # =====================================================================
    print("\n== the surfaces read the same computation (M4 frontend) ==")
    # =====================================================================
    # The endpoints the screens call. Until the M4 frontend was built these had
    # zero callers, and each surface showed money it had worked out for itself;
    # this asserts the one thing that made that a bug — that there is a single
    # answer, and both audiences get it.
    mine = requests.get(f"{BASE}/api/merchant/finance/position", headers=H(mtok)).json()
    theirs = requests.get(f"{BASE}/api/admin/merchants/{merchant_id}/finance",
                          headers=H(atok)).json()
    for field in ("billed", "paid", "refunded", "net_paid", "outstanding", "overpaid",
                  "awaiting_verification", "wallet_balance", "credit_limit",
                  "credit_used", "spending_power"):
        check(f"merchant and admin read an identical {field}",
              mine[field] == theirs[field], f"{mine[field]} vs {theirs[field]}")
    check("and an identical billable-booking count",
          mine["bookings_billable"] == theirs["bookings_billable"],
          f"{mine['bookings_billable']} vs {theirs['bookings_billable']}")

    # Every figure the screens render is a string, so the browser cannot make a
    # float of it on the way to the DOM. A number here would mean the schema had
    # been loosened and the whole no-float guarantee had quietly lapsed.
    for field in ("billed", "outstanding", "wallet_balance", "spending_power"):
        check(f"{field} crosses the wire as a decimal STRING, not a number",
              isinstance(mine[field], str), f"{type(mine[field]).__name__}={mine[field]!r}")

    stmt = requests.get(f"{BASE}/api/merchant/finance/statement", headers=H(mtok)).json()
    check("the statement carries its own totals, so no screen has to add a column",
          all(k in stmt for k in ("total_debits", "total_credits",
                                  "opening_balance", "closing_balance")),
          str(sorted(stmt))[:200])
    check("statement totals are strings too",
          isinstance(stmt["total_debits"], str) and isinstance(stmt["closing_balance"], str))
    check("every entry carries a server-computed running balance",
          all(isinstance(e.get("balance"), str) for e in stmt["entries"][:50]))
    check("the statement embeds the same position the position endpoint returns",
          stmt["position"]["outstanding"] == mine["outstanding"],
          f"{stmt['position']['outstanding']} vs {mine['outstanding']}")

    # A credit limit is only meaningful beside what is left of it — the tile the
    # merchant dashboard used to show without it.
    check("the position states credit_used and credit_available, not just the limit",
          "credit_used" in mine and "credit_available" in mine, str(sorted(mine))[:200])

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
