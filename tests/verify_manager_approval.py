"""Manager approval verification — the merchant's own sign-off in front of ours.

Covers the stage added on 2026-08-01: every service request a merchant raises
waits for a manager of that merchant before our desk can see or settle it, the
withdraw endpoint is gone, a completed booking can be cancelled, and a booking
can only ever be asked to be cancelled once.

Bookings are built from scratch by ``flows.make_booking`` at the exact stage
each check needs — most of these assertions *consume* the booking, since a
cancellation that works leaves nothing to cancel a second time.
"""
import datetime
import sys

import flows
import minihttp as requests
from config import ADMIN, BASE, MERCHANT, Checker, H, login

_c = Checker()
check = _c

#: An operator account is created once and reused. Creating one per check would
#: leave a trail of accounts on a real database for no extra coverage.
OPERATOR_EMAIL = "verify.operator@demotravel.example"


def operator_token(mtok):
    """A merchant_user with merchant_role=operator — deliberately NOT a manager.

    The whole point of the stage is that somebody other than a manager raises
    the request, so every check below needs an account that cannot sign its own
    work off. Recreated with a fresh password each run: the account survives
    between runs and its password is returned only once, at creation.
    """
    # LOOK IT UP, DO NOT PAGE FOR IT. This used to read the first 100 team
    # members and create the account when it was not among them. Every run of
    # verify_cr3 and verify_merchant_ui_parity leaves its throwaway colleagues
    # behind, so the demo merchant's team grows a few rows per suite run; the
    # day it passed 100, this account sat at position 101, the lookup missed it,
    # the create branch ran and the API answered "400 Email already registered".
    # `page_size` is capped at 100 by the endpoint, so a bigger page is not the
    # fix — `search` is.
    team = requests.get(
        f"{BASE}/api/merchant/team?page_size=100&search={OPERATOR_EMAIL}", headers=H(mtok)
    ).json()
    existing = next((u for u in team.get("items", []) if u["email"] == OPERATOR_EMAIL), None)

    if existing:
        r = requests.post(
            f"{BASE}/api/merchant/team/{existing['id']}/reset-password", headers=H(mtok)
        )
        assert r.status_code == 200, f"reset operator: {r.status_code} {r.text[:200]}"
        password = r.json()["temporary_password"]
    else:
        r = requests.post(f"{BASE}/api/merchant/team", headers=H(mtok), json={
            "full_name": "Verification Operator",
            "email": OPERATOR_EMAIL,
            "role": "merchant_user",
            "merchant_role": "operator",
        })
        assert r.status_code in (200, 201), f"create operator: {r.status_code} {r.text[:200]}"
        password = r.json()["temporary_password"]

    # A password reset moves force_logout_at to now, and a JWT's `iat` is whole
    # seconds — a token minted in the same second is issued *before* the
    # sub-second reset timestamp and comes back as "session expired".
    import time
    time.sleep(1.1)
    return login(OPERATOR_EMAIL, password, "merchant")


def state_of(tok, rid):
    return requests.get(f"{BASE}/api/requests/{rid}", headers=H(tok)).json()["request"]


def main():
    print("== auth ==")
    mtok, muser = login(*MERCHANT, with_user=True)
    atok = login(*ADMIN)
    check("merchant and admin sign in", bool(mtok and atok))
    check("the seeded merchant account is a manager (merchant_admin)",
          muser["role"] == "merchant_admin", str(muser.get("role")))

    otok = operator_token(mtok)
    check("an operator account exists and can sign in", bool(otok))

    MGR = f"{BASE}/api/manager/service-requests"

    # ---------------------------------------------------------------- rbac
    print("\n== who may sign off ==")
    r = requests.get(MGR, headers=H(otok))
    check("an operator cannot open the manager queue -> 403", r.status_code == 403,
          f"{r.status_code} {r.text[:200]}")
    r = requests.get(MGR, headers=H(mtok))
    check("a manager can open the manager queue -> 200", r.status_code == 200,
          f"{r.status_code} {r.text[:200]}")
    r = requests.get(MGR, headers=H(atok))
    check("platform staff cannot open it at all -> 403", r.status_code == 403,
          f"{r.status_code} {r.text[:200]}")

    # ------------------------------------------------- raise -> sign off -> settle
    print("\n== the happy path ==")
    booking = flows.make_booking(mtok, atok, upto="ticket_issued", label="mgr-approval")
    r = requests.post(f"{BASE}/api/bookings/{booking['id']}/cancellation", headers=H(otok),
                      json={"reason": "Client cancelled the trip."})
    check("an operator can raise a cancellation -> 201", r.status_code == 201,
          f"{r.status_code} {r.text[:250]}")
    cr = r.json()["request"]
    crid = cr["id"]
    check("it is raised Under Manager Approval",
          cr["manager_state"] == "pending" and cr["status_label"] == "Under Manager Approval",
          str(cr.get("manager_state")) + " / " + str(cr.get("status_label")))
    check("its lifecycle status is still Pending Approval",
          cr["status"] == "pending_approval", cr["status"])

    d = requests.get(f"{BASE}/api/change-requests/{crid}", headers=H(atok)).json()
    check("staff cannot review it yet", d["can_review"] is False, str(d["can_review"]))
    check("staff cannot settle it yet", d["can_settle"] is False, str(d["can_settle"]))
    check("can_withdraw is gone from the schema", "can_withdraw" not in d, str(list(d)))

    r = requests.post(f"{BASE}/api/admin/change-requests/{crid}/review", headers=H(atok))
    check("an admin claiming it anyway -> 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")
    check("and is told it is with the merchant's manager",
          "manager" in r.text.lower(), r.text[:200])
    r = requests.post(f"{BASE}/api/admin/change-requests/{crid}/approve", headers=H(atok),
                      json={"cancellation_charge": "500.00"})
    check("an admin settling it anyway -> 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")

    r = requests.post(f"{MGR}/{crid}/approve", headers=H(otok))
    check("the operator who raised it cannot approve it -> 403", r.status_code == 403,
          f"{r.status_code} {r.text[:200]}")

    queue = requests.get(MGR, headers=H(mtok)).json()
    check("it is on the manager's outstanding queue",
          any(i["id"] == crid for i in queue["items"]), str(queue.get("total")))
    counts = requests.get(f"{MGR}/counts", headers=H(mtok)).json()
    check("the manager's pending count is at least 1", counts["pending"] >= 1, str(counts))

    r = requests.post(f"{MGR}/{crid}/approve", headers=H(mtok))
    check("the manager approves it -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("it now reads Manager Approved",
          r.json()["status_label"] == "Manager Approved", r.json().get("status_label"))

    r = requests.post(f"{MGR}/{crid}/approve", headers=H(mtok))
    check("approving twice -> 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")

    d = requests.get(f"{BASE}/api/change-requests/{crid}", headers=H(atok)).json()
    check("staff may settle it now", d["can_settle"] is True, str(d))

    r = requests.post(f"{BASE}/api/admin/change-requests/{crid}/approve", headers=H(atok),
                      json={"cancellation_charge": "500.00"})
    check("the admin settles it -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("the booking is cancelled",
          state_of(mtok, booking["id"])["status"] == "cancelled",
          state_of(mtok, booking["id"])["status"])

    # ------------------------------------------------------- one cancellation only
    print("\n== a booking is cancelled once ==")
    b2 = flows.make_booking(mtok, atok, upto="ticket_issued", label="mgr-once")
    r = requests.post(f"{BASE}/api/bookings/{b2['id']}/cancellation", headers=H(otok),
                      json={"reason": "First attempt."})
    check("the first cancellation is accepted -> 201", r.status_code == 201, r.text[:200])
    first_id = r.json()["request"]["id"]
    r = requests.post(f"{BASE}/api/bookings/{b2['id']}/cancellation", headers=H(otok),
                      json={"reason": "Impatient second click."})
    check("a second one while the first is open -> 409", r.status_code == 409,
          f"{r.status_code} {r.text[:200]}")

    requests.post(f"{MGR}/{first_id}/approve", headers=H(mtok))
    requests.post(f"{BASE}/api/admin/change-requests/{first_id}/approve", headers=H(atok),
                  json={"cancellation_charge": "0"})
    r = requests.post(f"{BASE}/api/bookings/{b2['id']}/cancellation", headers=H(otok),
                      json={"reason": "After the first one settled."})
    check("a second one after the first settled -> 409", r.status_code == 409,
          f"{r.status_code} {r.text[:200]}")
    # Two guards can refuse this and either is correct. In practice the
    # parent-status one answers first — an approved cancellation has already
    # walked the booking to Cancelled, so it is closed before the
    # one-cancellation-per-booking check is reached. That check is the backstop
    # for the case where a cancellation exists but the booking is not cancelled.
    check("and says why, in one of the two ways it can",
          "only cancelled once" in r.text or "closed" in r.text, r.text[:220])

    # ------------------------------------------------------ a completed booking
    print("\n== a completed booking can still be cancelled ==")
    b3 = flows.make_booking(mtok, atok, upto="completed", label="mgr-completed")
    check("the booking really is completed", b3["status"] == "completed", b3["status"])
    r = requests.post(f"{BASE}/api/bookings/{b3['id']}/cancellation", headers=H(otok),
                      json={"reason": "No-show; settling the fare after travel."})
    check("a cancellation on a completed booking -> 201", r.status_code == 201,
          f"{r.status_code} {r.text[:250]}")
    c3 = r.json()["request"]["id"]

    r = requests.post(f"{BASE}/api/bookings/{b3['id']}/reschedule", headers=H(otok), json={
        "new_travel_date": str(datetime.date.today() + datetime.timedelta(days=90)),
        "reason": "Cannot move a journey that has already flown.",
    })
    check("a reschedule on a completed booking -> 409", r.status_code == 409,
          f"{r.status_code} {r.text[:220]}")

    requests.post(f"{MGR}/{c3}/approve", headers=H(mtok))
    r = requests.post(f"{BASE}/api/admin/change-requests/{c3}/approve", headers=H(atok),
                      json={"cancellation_charge": "24500.00"})
    check("settling it walks the completed booking to cancelled -> 200",
          r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("the completed booking is now cancelled",
          state_of(mtok, b3["id"])["status"] == "cancelled", state_of(mtok, b3["id"])["status"])

    # ------------------------------------------------------------- a rejection
    print("\n== a manager's rejection ends it ==")
    b4 = flows.make_booking(mtok, atok, upto="ticket_issued", label="mgr-reject")
    r = requests.post(f"{BASE}/api/bookings/{b4['id']}/cancellation", headers=H(otok),
                      json={"reason": "Raised in error."})
    c4 = r.json()["request"]["id"]

    r = requests.post(f"{MGR}/{c4}/reject", headers=H(mtok), json={"reason": ""})
    check("rejecting without a reason -> 422 or 400", r.status_code in (400, 422),
          f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{MGR}/{c4}/reject", headers=H(mtok),
                      json={"reason": "The client did not actually ask for this."})
    check("the manager rejects it -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("the request is closed", r.json()["status"] == "cancelled", r.json()["status"])
    check("and records who rejected it and why",
          r.json()["manager_approval"]["state"] == "rejected"
          and "did not actually ask" in r.json()["manager_approval"].get("reason", ""),
          str(r.json()["manager_approval"]))
    check("the booking is untouched",
          state_of(mtok, b4["id"])["status"] == "ticket_issued",
          state_of(mtok, b4["id"])["status"])
    r = requests.post(f"{BASE}/api/admin/change-requests/{c4}/approve", headers=H(atok),
                      json={"cancellation_charge": "0"})
    check("staff cannot settle a manager-rejected request -> 409", r.status_code == 409,
          f"{r.status_code} {r.text[:220]}")

    # ------------------------------------------------------------- no withdraw
    print("\n== withdraw is gone ==")
    b5 = flows.make_booking(mtok, atok, upto="ticket_issued", label="mgr-withdraw")
    r = requests.post(f"{BASE}/api/bookings/{b5['id']}/cancellation", headers=H(otok),
                      json={"reason": "To be left alone."})
    c5 = r.json()["request"]["id"]
    r = requests.post(f"{BASE}/api/change-requests/{c5}/withdraw", headers=H(otok))
    check("the withdraw endpoint no longer exists -> 404/405",
          r.status_code in (404, 405), f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{BASE}/api/requests/{c5}/cancel", headers=H(otok),
                      json={"reason": "Trying the generic cancel instead."})
    check("the generic cancel refuses a service request -> 400", r.status_code == 400,
          f"{r.status_code} {r.text[:220]}")
    check("and points at the manager", "manager" in r.text.lower(), r.text[:220])

    # -------------------------------------------- the generic types go the same way
    print("\n== the other service request types ==")
    b6 = flows.make_booking(mtok, atok, upto="ticket_issued", label="mgr-generic")
    pax = b6["passenger_ids"][0]
    r = requests.post(f"{BASE}/api/service-requests", headers=H(otok), json={
        "booking_id": b6["id"], "request_type": "meal",
        "remarks": "Jain meal for the lead passenger.",
        "details": {"passenger_id": pax, "meal": "jain"},
    })
    check("an operator raises a meal request -> 200/201", r.status_code in (200, 201),
          f"{r.status_code} {r.text[:250]}")
    meal = r.json()["request"]
    check("a meal request is Under Manager Approval too",
          meal["manager_state"] == "pending", str(meal.get("manager_state")))

    r = requests.post(f"{BASE}/api/admin/service-requests/{meal['id']}/resolve", headers=H(atok),
                      json={"approve": True})
    check("the generic resolve refuses it until a manager signs off -> 409",
          r.status_code == 409, f"{r.status_code} {r.text[:220]}")

    r = requests.post(f"{MGR}/{meal['id']}/approve", headers=H(mtok))
    check("the manager approves the meal request -> 200", r.status_code == 200, r.text[:200])
    r = requests.post(f"{BASE}/api/admin/service-requests/{meal['id']}/resolve", headers=H(atok),
                      json={"approve": True})
    check("the admin can then resolve it -> 200", r.status_code == 200,
          f"{r.status_code} {r.text[:220]}")

    # ------------------------------------------ a manager's own request skips ahead
    print("\n== a manager raising their own request ==")
    b7 = flows.make_booking(mtok, atok, upto="ticket_issued", label="mgr-self")
    r = requests.post(f"{BASE}/api/bookings/{b7['id']}/cancellation", headers=H(mtok),
                      json={"reason": "Raised by the manager themselves."})
    check("a manager raises a cancellation -> 201", r.status_code == 201, r.text[:200])
    self_cr = r.json()["request"]
    check("it is already Manager Approved",
          self_cr["manager_state"] == "approved", str(self_cr.get("manager_state")))
    check("and is marked as self-raised rather than reviewed",
          self_cr["manager_approval"].get("self_raised") is True,
          str(self_cr["manager_approval"]))
    d = requests.get(f"{BASE}/api/change-requests/{self_cr['id']}", headers=H(atok)).json()
    check("staff may settle it straight away", d["can_settle"] is True, str(d["can_settle"]))

    # -------------------------------------------------------- cross-tenant scope
    print("\n== scope ==")
    rival = flows.rival_merchant(atok)
    r = requests.post(f"{MGR}/{self_cr['id']}/approve", headers=H(rival["token"]))
    check("another company's manager cannot approve it -> 403/404",
          r.status_code in (403, 404), f"{r.status_code} {r.text[:200]}")

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
