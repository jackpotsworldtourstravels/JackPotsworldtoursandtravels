"""CR-3 — the merchant approves its own Booking Requests.

CR-2 put the sign-off with a platform Manager. CR-3 moves it to the merchant
that raised the booking. What has to be true:

  * a merchant approver sees and decides **only its own merchant's** bookings
  * it cannot approve a booking **it raised itself**
  * a merchant sub-role without the code cannot approve at all
  * two approvers at one merchant cannot both decide the same booking
  * the booking still lands in the Admin Booking Operations queue afterwards

The cross-merchant assertion is the important one: a permission code that is
correct but unscoped would let any merchant approve every merchant's work, and
that failure is invisible from a single-merchant test.

    python tests/verify_cr3.py
"""
import sys
import threading
import time

import flows
import minihttp as requests
from config import ADMIN, BASE, MERCHANT, Checker, H, login

check = Checker()
STAMP = str(int(time.time()))


def _colleague(mtok, *, merchant_role, label):
    """Create a team member under MERCHANT's own company and sign them in.

    The suite needs a *second* person at the merchant: the account that raises a
    booking cannot be the one that approves it, which is the rule under test.
    """
    email = f"cr3.{label}.{STAMP}@example.com"
    password = "Cr3Desk#2026x"
    r = requests.post(
        f"{BASE}/api/merchant/team", headers=H(mtok),
        json={
            "full_name": f"CR3 {label.title()}",
            "email": email,
            "role": "merchant_user",
            "merchant_role": merchant_role,
            "password": password,
        },
    )
    assert r.status_code == 201, f"create {label}: {r.status_code} {r.text[:300]}"
    return login(email, password, "merchant"), email


def main() -> int:
    mtok = login(*MERCHANT)          # merchant_admin — raises bookings, and may approve
    atok = login(*ADMIN)
    me = requests.get(f"{BASE}/api/auth/me", headers=H(mtok)).json()
    my_merchant = me.get("merchant_id")

    print("\n== the merchant's manager can approve its own company's booking ==")
    approver, approver_email = _colleague(mtok, merchant_role="manager", label="manager")
    booking = flows.make_booking(mtok, atok, upto="pending_approval", label="cr3 happy path")
    rid = booking["id"]

    # Searched by request number rather than read off page 1: the queue sorts
    # oldest-first and a database that has run the suite before has plenty of
    # older pending bookings, so a brand-new one is on the last page.
    r = requests.get(
        f"{BASE}/api/merchant/approvals?bucket=awaiting&search={booking['request_number']}",
        headers=H(approver),
    )
    check("the approver can open the merchant approval queue", r.status_code == 200,
          f"{r.status_code} {r.text[:200]}")
    ids = [i["id"] for i in r.json().get("items", [])] if r.status_code == 200 else []
    check("the submitted booking is waiting there", rid in ids, str(ids[:5]))

    r = requests.get(f"{BASE}/api/merchant/approvals/{rid}", headers=H(approver))
    check("the approver can read it in full", r.status_code == 200,
          f"{r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        d = r.json()
        check("it carries passengers and a timeline",
              bool(d["request"].get("passengers")) and bool(d.get("timeline")))
        check("and it is decidable by them", d.get("can_decide") is True)

    r = requests.post(f"{BASE}/api/merchant/approvals/{rid}/approve", headers=H(approver),
                      json={"note": "Checked against the enquiry."})
    check("the merchant's manager approves it -> 200", r.status_code == 200,
          f"{r.status_code} {r.text[:250]}")
    if r.status_code == 200:
        check("it reached Manager Approved", r.json()["request"]["status"] == "approved",
              r.json()["request"]["status"])

    r = requests.get(
        f"{BASE}/api/admin/bookings/queue?search={booking['request_number']}", headers=H(atok)
    )
    if r.status_code == 200:
        check("and it is now on the Admin Booking Operations desk",
              rid in [i["id"] for i in r.json().get("items", [])], r.text[:160])
    else:
        check("and it is now on the Admin Booking Operations desk", False,
              f"queue read failed: {r.status_code} {r.text[:160]}")

    print("\n== an approver cannot sign off a booking they raised themselves ==")
    own = flows.make_booking(mtok, atok, upto="pending_approval", label="cr3 self approval")
    r = requests.post(f"{BASE}/api/merchant/approvals/{own['id']}/approve", headers=H(mtok),
                      json={"note": "mine"})
    check("the raiser approving their own booking -> 403", r.status_code == 403,
          f"{r.status_code} {r.text[:200]}")
    check("...and the refusal explains why",
          "raised by you" in r.text.lower() or "another approver" in r.text.lower(), r.text[:160])
    r = requests.get(f"{BASE}/api/merchant/approvals/{own['id']}", headers=H(mtok))
    if r.status_code == 200:
        check("the UI is told not to offer the buttons", r.json().get("can_decide") is False)
    r = requests.post(f"{BASE}/api/merchant/approvals/{own['id']}/approve", headers=H(approver),
                      json={"note": "colleague signs it off"})
    check("but a colleague can approve the same booking", r.status_code == 200,
          f"{r.status_code} {r.text[:200]}")

    print("\n== a merchant sub-role without the code cannot approve ==")
    operator, _ = _colleague(mtok, merchant_role="data_operator", label="dataop")
    blocked = flows.make_booking(mtok, atok, upto="pending_approval", label="cr3 rbac")
    r = requests.get(f"{BASE}/api/merchant/approvals", headers=H(operator))
    check("a data operator cannot open the approval queue", r.status_code == 403,
          f"{r.status_code} {r.text[:160]}")
    r = requests.post(f"{BASE}/api/merchant/approvals/{blocked['id']}/approve",
                      headers=H(operator), json={})
    check("nor approve a booking", r.status_code == 403, f"{r.status_code} {r.text[:160]}")

    print("\n== cross-merchant isolation ==")
    rival = flows.rival_merchant(atok)
    check("the rival is a different company", rival["merchant_id"] != my_merchant,
          f"{rival['merchant_id']} vs {my_merchant}")
    r = requests.get(f"{BASE}/api/merchant/approvals?bucket=awaiting", headers=H(rival["token"]))
    if r.status_code == 200:
        rival_ids = [i["id"] for i in r.json().get("items", [])]
        check("the rival's queue does not contain our booking", blocked["id"] not in rival_ids)
        check("the rival's queue contains only its own merchant's rows",
              all(i.get("merchant_id") in (None, rival["merchant_id"])
                  for i in r.json().get("items", [])))
    else:
        check("the rival can open its own approval queue", False,
              f"{r.status_code} {r.text[:160]}")
    r = requests.get(f"{BASE}/api/merchant/approvals/{blocked['id']}", headers=H(rival["token"]))
    check("reading our booking as the rival -> 404, not 403", r.status_code == 404,
          f"{r.status_code} {r.text[:160]}")
    r = requests.post(f"{BASE}/api/merchant/approvals/{blocked['id']}/approve",
                      headers=H(rival["token"]), json={"note": "not mine to approve"})
    check("approving our booking as the rival -> 404", r.status_code == 404,
          f"{r.status_code} {r.text[:160]}")
    r = requests.get(f"{BASE}/api/requests/{blocked['id']}", headers=H(mtok))
    check("and our booking is untouched by the attempt",
          r.status_code == 200 and r.json()["request"]["status"] == "pending_approval",
          r.text[:160])

    print("\n== return for correction ==")
    r = requests.post(f"{BASE}/api/merchant/approvals/{blocked['id']}/return",
                      headers=H(approver), json={"remarks": ""})
    check("returning with no remarks -> 4xx", r.status_code in (400, 422),
          f"{r.status_code} {r.text[:160]}")
    r = requests.post(f"{BASE}/api/merchant/approvals/{blocked['id']}/return",
                      headers=H(approver), json={"remarks": "Passport expiry is before the travel date."})
    check("returning with remarks -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    if r.status_code == 200:
        check("it goes back to Created, not Rejected",
              r.json()["request"]["status"] == "draft", r.json()["request"]["status"])
    r = requests.get(f"{BASE}/api/requests/{blocked['id']}", headers=H(mtok))
    check("the merchant sees why it came back",
          "passport expiry" in r.text.lower(), r.text[:160])

    print("\n== two approvers at one merchant deciding at once ==")
    second, _ = _colleague(mtok, merchant_role="manager", label="manager2")
    race = flows.make_booking(mtok, atok, upto="pending_approval", label="cr3 race")
    results = []
    lock = threading.Lock()

    def hit(tok):
        resp = requests.post(f"{BASE}/api/merchant/approvals/{race['id']}/approve",
                             headers=H(tok), json={"note": "race"})
        with lock:
            results.append(resp.status_code)

    threads = [threading.Thread(target=hit, args=(t,))
               for t in (approver, second, approver, second)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check("exactly one simultaneous approval wins", results.count(200) == 1, str(results))
    check("the losers get 4xx, never a 500",
          all(c < 500 for c in results), str(results))
    r = requests.get(f"{BASE}/api/requests/{race['id']}", headers=H(mtok))
    check("and the booking was approved exactly once",
          r.status_code == 200 and r.json()["request"]["status"] == "approved",
          r.text[:160])

    print("\n== the platform Manager path is unaffected by scoping ==")
    r = requests.get(f"{BASE}/api/manager/bookings", headers=H(mtok))
    check("a merchant cannot address the platform manager queue", r.status_code == 403,
          f"{r.status_code} {r.text[:160]}")

    return check.report()


if __name__ == "__main__":
    sys.exit(main())
