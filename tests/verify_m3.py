"""M3 verification — cancellation & reschedule workflow.

Every booking used here is built from scratch by ``flows.make_booking`` at the
exact stage the check needs, because most of these assertions *consume* the
booking: a cancellation that works leaves nothing to cancel a second time.
"""
import datetime
import sys
import threading

import flows
import minihttp as requests
from config import ADMIN, ADMIN2, BASE, MERCHANT, SUPER, Checker, H, login

_c = Checker()
check = _c

TOMORROW = datetime.date.today() + datetime.timedelta(days=1)
YESTERDAY = datetime.date.today() - datetime.timedelta(days=1)


def new_date(offset=90):
    return datetime.date.today() + datetime.timedelta(days=offset)


def booking_status(tok, rid):
    return requests.get(f"{BASE}/api/requests/{rid}", headers=H(tok)).json()["request"]["status"]


def main():
    print("== auth ==")
    mtok, muser = login(*MERCHANT, with_user=True)
    atok = login(*ADMIN)
    a2tok = login(*ADMIN2)
    stok = login(*SUPER)
    check("merchant, two admins and super admin sign in", all([mtok, atok, a2tok, stok]))

    CR = f"{BASE}/api/change-requests"

    # ------------------------------------------------------------ eligibility
    print("\n== which bookings may be changed ==")
    draft = flows.make_booking(mtok, atok, upto="draft", label="M3 draft")
    r = requests.post(f"{BASE}/api/bookings/{draft['id']}/cancellation", headers=H(mtok),
                      json={"reason": "changed our mind"})
    check("cancelling a DRAFT booking -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")
    check("the 409 points at the free withdrawal path", "no charge" in r.text, r.text[:250])

    pending = flows.make_booking(mtok, atok, upto="pending_approval", label="M3 pending")
    r = requests.post(f"{BASE}/api/bookings/{pending['id']}/cancellation", headers=H(mtok),
                      json={"reason": "changed our mind"})
    check("cancelling a PENDING booking -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")

    done = flows.make_booking(mtok, atok, upto="completed", label="M3 completed")
    r = requests.post(f"{BASE}/api/bookings/{done['id']}/cancellation", headers=H(mtok),
                      json={"reason": "too late"})
    check("cancelling a COMPLETED booking -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")
    r = requests.post(f"{BASE}/api/bookings/{done['id']}/reschedule", headers=H(mtok),
                      json={"new_travel_date": str(new_date()), "reason": "too late"})
    check("rescheduling a COMPLETED booking -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")

    r = requests.post(f"{BASE}/api/bookings/99999999/cancellation", headers=H(mtok),
                      json={"reason": "ghost"})
    check("cancelling an unknown booking -> 404", r.status_code == 404, f"{r.status_code} {r.text[:200]}")

    # --------------------------------------------------------- raise: validation
    print("\n== raising a request: validation ==")
    live = flows.make_booking(mtok, atok, upto="approved", label="M3 validation")

    r = requests.post(f"{BASE}/api/bookings/{live['id']}/cancellation", headers=H(mtok),
                      json={"reason": "   "})
    check("a blank cancellation reason -> 400/422", r.status_code in (400, 422), f"{r.status_code} {r.text[:200]}")

    r = requests.post(f"{BASE}/api/bookings/{live['id']}/reschedule", headers=H(mtok),
                      json={"new_travel_date": str(YESTERDAY), "reason": "move it"})
    check("a reschedule into the past -> 400", r.status_code == 400 and "future" in r.text,
          f"{r.status_code} {r.text[:220]}")

    current = requests.get(f"{BASE}/api/requests/{live['id']}", headers=H(mtok)).json()["request"]["travel_date"]
    r = requests.post(f"{BASE}/api/bookings/{live['id']}/reschedule", headers=H(mtok),
                      json={"new_travel_date": current, "reason": "move it"})
    check("a reschedule to the same date -> 400", r.status_code == 400, f"{r.status_code} {r.text[:220]}")

    r = requests.post(f"{BASE}/api/bookings/{live['id']}/reschedule", headers=H(mtok),
                      json={"new_travel_date": str(new_date(90)), "new_return_date": str(new_date(80)),
                            "reason": "move it"})
    check("a return date before the new travel date -> 400", r.status_code == 400,
          f"{r.status_code} {r.text[:220]}")

    # ------------------------------------------------------- one open at a time
    print("\n== only one change may be open per booking ==")
    r = requests.post(f"{BASE}/api/bookings/{live['id']}/cancellation", headers=H(mtok),
                      json={"reason": "duplicate guard"})
    check("first cancellation -> 201", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    first = r.json()["request"]
    check("it lands at Pending", first["status"] == "pending_approval", first["status"])
    check("it carries no amounts before staff quote", first["pricing"] == {} and first["amount"] == "0.00",
          str(first["pricing"]) + " " + first["amount"])
    check("it links back to the booking", first["booking_id"] == live["id"], str(first["booking_id"]))

    r = requests.post(f"{BASE}/api/bookings/{live['id']}/cancellation", headers=H(mtok),
                      json={"reason": "second attempt"})
    check("a second cancellation -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")
    check("the 409 names the open request", first["request_number"] in r.text, r.text[:250])

    r = requests.post(f"{BASE}/api/bookings/{live['id']}/reschedule", headers=H(mtok),
                      json={"new_travel_date": str(new_date()), "reason": "and a reschedule too"})
    check("a reschedule while a cancellation is open -> 409", r.status_code == 409,
          f"{r.status_code} {r.text[:220]}")

    # ---------------------------------------------------------------- withdraw
    print("\n== withdraw ==")
    # Approval opens the payment window in the same call, so an "approved"
    # booking is really sitting at Payment Pending by the time we see it.
    live_status = booking_status(mtok, live["id"])
    r = requests.post(f"{CR}/{first['id']}/withdraw", headers=H(mtok))
    check("merchant withdraws a pending request -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("it is now Cancelled", r.json()["request"]["status"] == "cancelled", r.text[:200])
    check("the booking is untouched", booking_status(mtok, live["id"]) == live_status,
          f"{live_status} -> {booking_status(mtok, live['id'])}")

    r = requests.post(f"{BASE}/api/bookings/{live['id']}/cancellation", headers=H(mtok),
                      json={"reason": "after a withdrawal the slot is free"})
    check("a withdrawal frees the slot for a new request -> 201", r.status_code == 201,
          f"{r.status_code} {r.text[:220]}")
    reopened = r.json()["request"]

    r = requests.post(f"{BASE}/api/admin/change-requests/{reopened['id']}/review", headers=H(atok))
    check("admin claims it -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("it is Under Review", r.json()["request"]["status"] == "in_review", r.text[:200])
    check("the claim records who holds it",
          r.json()["request"]["review_claimed_by_name"], r.text[:250])

    r = requests.post(f"{CR}/{reopened['id']}/withdraw", headers=H(mtok))
    check("withdrawing a claimed request -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")

    # ------------------------------------------------------------ claim conflict
    print("\n== two admins cannot settle the same request ==")
    r = requests.post(f"{BASE}/api/admin/change-requests/{reopened['id']}/review", headers=H(a2tok))
    check("a second admin claiming -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")
    r = requests.post(f"{BASE}/api/admin/change-requests/{reopened['id']}/approve", headers=H(a2tok),
                      json={"cancellation_charge": "0"})
    check("a second admin approving -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")
    r = requests.post(f"{BASE}/api/admin/change-requests/{reopened['id']}/review", headers=H(atok))
    check("the holder re-claiming is a no-op -> 200", r.status_code == 200, f"{r.status_code} {r.text[:220]}")

    # ------------------------------------------------------------- money bounds
    print("\n== cancellation charge is bounded by the booking ==")
    total = requests.get(f"{BASE}/api/requests/{live['id']}", headers=H(atok)).json()["request"]["total_amount"]
    print(f"     booking total is {total}")

    A = f"{BASE}/api/admin/change-requests/{reopened['id']}/approve"
    r = requests.post(A, headers=H(atok), json={"cancellation_charge": "-1"})
    check("a negative charge -> 400", r.status_code == 400, f"{r.status_code} {r.text[:220]}")
    r = requests.post(A, headers=H(atok), json={"cancellation_charge": "not-a-number"})
    check("a non-numeric charge -> 400", r.status_code == 400, f"{r.status_code} {r.text[:220]}")
    r = requests.post(A, headers=H(atok), json={"cancellation_charge": "9999999.00"})
    check("a charge above the booking total -> 400", r.status_code == 400, f"{r.status_code} {r.text[:220]}")
    check("the refusal names both numbers", str(total).split(".")[0] in r.text, r.text[:250])

    # ------------------------------------------------------ cancellation settles
    print("\n== approving a cancellation cancels the booking ==")
    r = requests.post(A, headers=H(atok), json={"cancellation_charge": "3000.00",
                                                "note": "Airline fare rule CX-3."})
    check("approve with a charge -> 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    settled = r.json()["request"]
    pricing = settled["pricing"]
    check("the request is Approved", settled["status"] == "approved", settled["status"])
    check("the charge is recorded", pricing.get("cancellation_charge") == "3000.00", str(pricing))
    check("the refund is derived, not sent",
          pricing.get("refund_amount") == f"{float(total) - 3000:.2f}", str(pricing))
    check("the booking amount is recorded alongside it",
          pricing.get("booking_amount") == f"{float(total):.2f}", str(pricing))
    check("the quote is attributed", pricing.get("quoted_by_name"), str(pricing))
    check("amount == the refund due", settled["amount"] == pricing.get("refund_amount"),
          f"{settled['amount']} vs {pricing.get('refund_amount')}")
    check("THE BOOKING IS NOW CANCELLED", booking_status(mtok, live["id"]) == "cancelled",
          booking_status(mtok, live["id"]))

    timeline = requests.get(f"{BASE}/api/requests/{live['id']}", headers=H(mtok)).json()["timeline"]
    check("the booking's timeline records the cancellation",
          any(step.get("status") == "cancelled" for step in timeline), str(timeline)[-300:])
    check("and names the change request that caused it",
          any(reopened["request_number"] in str(step.get("reason") or "") for step in timeline),
          str(timeline)[-300:])

    r = requests.post(A, headers=H(atok), json={"cancellation_charge": "0"})
    check("approving an already-settled request -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")

    r = requests.post(f"{BASE}/api/bookings/{live['id']}/cancellation", headers=H(mtok),
                      json={"reason": "again"})
    check("a cancelled booking cannot be cancelled again -> 409", r.status_code == 409,
          f"{r.status_code} {r.text[:220]}")

    # ------------------------------------------------------- free cancellation
    print("\n== a free cancellation ==")
    freeb = flows.make_booking(mtok, atok, upto="paid", label="M3 free cancel")
    r = requests.post(f"{BASE}/api/bookings/{freeb['id']}/cancellation", headers=H(mtok),
                      json={"reason": "Airline cancelled the flight."})
    check("cancellation on a PAID booking -> 201", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    fid = r.json()["request"]["id"]
    r = requests.post(f"{BASE}/api/admin/change-requests/{fid}/approve", headers=H(atok), json={})
    check("approve with no charge at all -> 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    p = r.json()["request"]["pricing"]
    check("charge defaults to zero", p.get("cancellation_charge") == "0.00", str(p))
    check("the whole booking is refundable", p.get("refund_amount") == p.get("booking_amount"), str(p))
    check("a PAID booking really cancels", booking_status(mtok, freeb["id"]) == "cancelled",
          booking_status(mtok, freeb["id"]))

    # --------------------------------------------- cancelling a ticketed booking
    print("\n== a ticketed booking can still be cancelled ==")
    tkt = flows.make_booking(mtok, atok, upto="ticket_issued", label="M3 ticketed cancel")
    r = requests.post(f"{BASE}/api/bookings/{tkt['id']}/cancellation", headers=H(mtok),
                      json={"reason": "Passenger hospitalised."})
    check("cancellation on a TICKET ISSUED booking -> 201", r.status_code == 201,
          f"{r.status_code} {r.text[:250]}")
    tid = r.json()["request"]["id"]
    r = requests.post(f"{BASE}/api/admin/change-requests/{tid}/approve", headers=H(atok),
                      json={"cancellation_charge": "1500.00"})
    check("approve -> 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    check("a ticketed booking really cancels", booking_status(mtok, tkt["id"]) == "cancelled",
          booking_status(mtok, tkt["id"]))

    # ------------------------------------------------------------- reschedule
    print("\n== reschedule ==")
    resb = flows.make_booking(mtok, atok, upto="paid", label="M3 reschedule")
    before = requests.get(f"{BASE}/api/requests/{resb['id']}", headers=H(mtok)).json()["request"]
    target = new_date(120)

    r = requests.post(f"{BASE}/api/bookings/{resb['id']}/reschedule", headers=H(mtok),
                      json={"new_travel_date": str(target), "reason": "Client moved the trip."})
    check("raise a reschedule -> 201", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    rr = r.json()["request"]
    check("the requested date is carried", rr["new_travel_date"] == str(target), str(rr["new_travel_date"]))
    check("the current date is carried for comparison",
          rr["current_travel_date"] == before["travel_date"], str(rr["current_travel_date"]))
    check("THE BOOKING IS NOT MOVED YET",
          requests.get(f"{BASE}/api/requests/{resb['id']}", headers=H(mtok)).json()["request"]["travel_date"]
          == before["travel_date"], "the booking moved on request, not on approval")

    RA = f"{BASE}/api/admin/change-requests/{rr['id']}/approve"
    r = requests.post(RA, headers=H(atok), json={"fare_difference": "-500"})
    check("a negative fare difference -> 400", r.status_code == 400, f"{r.status_code} {r.text[:220]}")

    r = requests.post(RA, headers=H(atok), json={"fare_difference": "1200.00", "change_fee": "500.00"})
    check("approve a reschedule -> 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    rp = r.json()["request"]["pricing"]
    check("fare difference recorded", rp.get("fare_difference") == "1200.00", str(rp))
    check("change fee recorded", rp.get("change_fee") == "500.00", str(rp))
    check("payable is their sum", rp.get("total_payable") == "1700.00", str(rp))

    after = requests.get(f"{BASE}/api/requests/{resb['id']}", headers=H(mtok)).json()["request"]
    check("THE BOOKING NOW DEPARTS ON THE NEW DATE", after["travel_date"] == str(target),
          f"{before['travel_date']} -> {after['travel_date']}")
    check("a reschedule does NOT change the booking's status", after["status"] == before["status"],
          f"{before['status']} -> {after['status']}")
    moves = (after.get("details") or {}).get("reschedule_history") or []
    check("the move is recorded on the booking", len(moves) == 1, str(moves)[:300])
    check("the move names the change request",
          moves and moves[0].get("change_request") == rr["request_number"], str(moves)[:300])
    check("the move records where it came from",
          moves and moves[0]["from"]["travel_date"] == before["travel_date"], str(moves)[:300])

    r = requests.post(f"{BASE}/api/bookings/{resb['id']}/reschedule", headers=H(mtok),
                      json={"new_travel_date": str(new_date(150)), "reason": "moved again"})
    check("a settled booking can be rescheduled again -> 201", r.status_code == 201,
          f"{r.status_code} {r.text[:220]}")
    again = r.json()["request"]["id"]

    # ---------------------------------------------------------------- rejection
    print("\n== rejection ==")
    r = requests.post(f"{BASE}/api/admin/change-requests/{again}/reject", headers=H(atok), json={})
    check("rejecting with no reason -> 400/422", r.status_code in (400, 422), f"{r.status_code} {r.text[:220]}")
    r = requests.post(f"{BASE}/api/admin/change-requests/{again}/reject", headers=H(atok),
                      json={"reason": "The airline has no seats on that date."})
    check("reject with a reason -> 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    check("it is Rejected", r.json()["request"]["status"] == "rejected", r.text[:200])
    check("the reason is returned", "no seats" in (r.json()["request"]["rejection_reason"] or ""), r.text[:250])
    settled_after = requests.get(f"{BASE}/api/requests/{resb['id']}", headers=H(mtok)).json()["request"]
    check("REJECTING LEAVES THE BOOKING EXACTLY AS IT WAS",
          settled_after["travel_date"] == str(target) and settled_after["status"] == after["status"],
          f"{settled_after['travel_date']} / {settled_after['status']}")

    # ------------------------------------------------------------------- RBAC
    print("\n== permissions ==")
    open_b = flows.make_booking(mtok, atok, upto="approved", label="M3 rbac")
    r = requests.post(f"{BASE}/api/bookings/{open_b['id']}/cancellation", headers=H(mtok),
                      json={"reason": "for the RBAC checks"})
    check("merchant raises one for the RBAC checks -> 201", r.status_code == 201, f"{r.status_code} {r.text[:220]}")
    rbac_id = r.json()["request"]["id"]

    for label, path, body in [
        ("review", f"{BASE}/api/admin/change-requests/{rbac_id}/review", None),
        ("approve", f"{BASE}/api/admin/change-requests/{rbac_id}/approve", {"cancellation_charge": "0"}),
        ("reject", f"{BASE}/api/admin/change-requests/{rbac_id}/reject", {"reason": "no"}),
    ]:
        r = requests.post(path, headers=H(mtok), json=body)
        check(f"merchant cannot {label} -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    r = requests.post(f"{BASE}/api/bookings/{open_b['id']}/cancellation", headers=H(atok),
                      json={"reason": "admins do not raise these"})
    check("an admin cannot raise a change request -> 403", r.status_code == 403,
          f"{r.status_code} {r.text[:200]}")

    r = requests.get(CR, headers=H(stok))
    check("super admin has no ticket.view, so the list -> 403", r.status_code == 403,
          f"{r.status_code} {r.text[:200]}")

    r = requests.get(CR)
    check("no token -> 401/403", r.status_code in (401, 403), str(r.status_code))

    # --------------------------------------------------------- cross-tenant
    print("\n== cross-tenant isolation ==")
    rival = flows.rival_merchant(atok)
    print(f"     rival: {rival['company']} (merchant {rival['merchant_id']})")
    rtok = rival["token"]

    r = requests.get(f"{CR}/{rbac_id}", headers=H(rtok))
    check("another company's change request -> 404 (not 403)", r.status_code == 404,
          f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{CR}/{rbac_id}/withdraw", headers=H(rtok))
    check("another company cannot withdraw it -> 404", r.status_code == 404, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{BASE}/api/bookings/{open_b['id']}/cancellation", headers=H(rtok),
                      json={"reason": "not mine"})
    check("another company cannot cancel our booking -> 404", r.status_code == 404,
          f"{r.status_code} {r.text[:200]}")
    r = requests.get(f"{BASE}/api/bookings/{open_b['id']}/change-requests", headers=H(rtok))
    check("another company cannot list our booking's changes -> 404", r.status_code == 404,
          f"{r.status_code} {r.text[:200]}")

    r = requests.get(f"{CR}?page_size=100", headers=H(rtok))
    check("the rival's own list loads -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("and contains none of ours",
          all(i["merchant_id"] == rival["merchant_id"] for i in r.json()["items"]),
          str({i["merchant_id"] for i in r.json()["items"]}))

    # --------------------------------------------------- listing, counts, detail
    print("\n== listing, counts and detail ==")
    r = requests.get(f"{CR}?page_size=100", headers=H(mtok))
    check("merchant lists its change requests -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    page = r.json()
    check("it is a paginated page", {"items", "total", "page", "total_pages"} <= set(page), str(list(page)))
    check("every row is a change type",
          all(i["change_type"] in ("cancellation", "date_change") for i in page["items"]),
          str({i["change_type"] for i in page["items"]}))
    check("newest first", [i["id"] for i in page["items"]] == sorted(
        [i["id"] for i in page["items"]], reverse=True), str([i["id"] for i in page["items"]][:6]))
    check("every row belongs to this merchant",
          all(i["merchant_id"] == muser.get("merchant_id") for i in page["items"]),
          str({i["merchant_id"] for i in page["items"]}))

    r = requests.get(f"{CR}?type=cancellation&page_size=100", headers=H(mtok))
    check("filter by type -> 200 and filters",
          r.status_code == 200 and all(i["change_type"] == "cancellation" for i in r.json()["items"]),
          f"{r.status_code} {str({i['change_type'] for i in r.json().get('items', [])})}")

    r = requests.get(f"{CR}?request_status=approved&page_size=100", headers=H(mtok))
    check("filter by status -> 200 and filters",
          r.status_code == 200 and all(i["status"] == "approved" for i in r.json()["items"]),
          f"{r.status_code} {str({i['status'] for i in r.json().get('items', [])})}")

    r = requests.get(f"{CR}?type=booking&page_size=5", headers=H(mtok))
    check("a non-change type -> 400/422", r.status_code in (400, 422), f"{r.status_code} {r.text[:200]}")

    r = requests.get(f"{CR}?search={reopened['request_number']}", headers=H(mtok))
    check("search by request number finds it",
          r.status_code == 200 and any(i["id"] == reopened["id"] for i in r.json()["items"]),
          f"{r.status_code} {r.text[:220]}")

    r = requests.get(f"{CR}/counts", headers=H(mtok))
    check("counts -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    counts = r.json()
    check("open == pending + under review",
          counts["open"] == counts["pending_approval"] + counts["in_review"], str(counts))
    total_listed = requests.get(f"{CR}?page_size=100", headers=H(mtok)).json()["total"]
    check("counts.total agrees with the listing total", counts["total"] == total_listed,
          f"counts={counts['total']} list={total_listed}")

    r = requests.get(f"{CR}/{rbac_id}", headers=H(mtok))
    check("detail -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    d = r.json()
    check("detail carries the parent booking", d["booking"] and d["booking"]["request_number"],
          str(d.get("booking"))[:200])
    check("detail carries a timeline", isinstance(d["timeline"], list) and d["timeline"], str(d.get("timeline"))[:200])
    check("merchant may withdraw its own pending request", d["can_withdraw"] is True, str(d))
    check("merchant may not settle it", d["can_settle"] is False and d["can_review"] is False, str(d))
    d_admin = requests.get(f"{CR}/{rbac_id}", headers=H(atok)).json()
    check("admin may review and settle it",
          d_admin["can_review"] is True and d_admin["can_settle"] is True, str(d_admin))
    check("admin may not withdraw it", d_admin["can_withdraw"] is False, str(d_admin))

    r = requests.get(f"{BASE}/api/bookings/{open_b['id']}/change-requests", headers=H(mtok))
    check("per-booking history -> 200 and finds it",
          r.status_code == 200 and any(i["id"] == rbac_id for i in r.json()),
          f"{r.status_code} {r.text[:220]}")

    r = requests.get(f"{CR}/99999999", headers=H(mtok))
    check("an unknown change request -> 404", r.status_code == 404, str(r.status_code))
    r = requests.get(f"{CR}/{open_b['id']}", headers=H(mtok))
    check("a booking id is not a change request -> 404", r.status_code == 404, str(r.status_code))

    # ---------------------------------------------- one settlement path only
    print("\n== the generic paths refuse a change request ==")
    bypass_b = flows.make_booking(mtok, atok, upto="approved", label="M3 bypass")
    r = requests.post(f"{BASE}/api/bookings/{bypass_b['id']}/cancellation", headers=H(mtok),
                      json={"reason": "for the bypass checks"})
    bypass_id = r.json()["request"]["id"]

    r = requests.post(f"{BASE}/api/admin/service-requests/{bypass_id}/resolve", headers=H(atok),
                      json={"approve": True})
    check("the generic service-request resolve refuses it -> 400", r.status_code == 400,
          f"{r.status_code} {r.text[:220]}")
    check("and points at the settlement path", "change-requests" in r.text, r.text[:250])

    # This one matters most: approve_request walks a request to Payment Pending,
    # which on a cancellation would show the merchant a Pay button.
    r = requests.post(f"{BASE}/api/admin/requests/{bypass_id}/approve", headers=H(atok), json={})
    check("the generic booking approve refuses it -> 400", r.status_code == 400,
          f"{r.status_code} {r.text[:220]}")
    r = requests.post(f"{BASE}/api/admin/requests/{bypass_id}/reject", headers=H(atok),
                      json={"reason": "no"})
    check("the generic booking reject refuses it -> 400", r.status_code == 400,
          f"{r.status_code} {r.text[:220]}")
    check("the request is still Pending after all three attempts",
          requests.get(f"{CR}/{bypass_id}", headers=H(atok)).json()["request"]["status"]
          == "pending_approval", "a generic path moved it")

    r = requests.post(f"{BASE}/api/service-requests", headers=H(mtok),
                      json={"booking_id": bypass_b["id"], "request_type": "cancellation",
                            "remarks": "via the generic hook"})
    check("raising a cancellation on the generic hook -> 400", r.status_code == 400,
          f"{r.status_code} {r.text[:220]}")
    r = requests.post(f"{BASE}/api/service-requests", headers=H(mtok),
                      json={"booking_id": bypass_b["id"], "request_type": "date_change",
                            "remarks": "via the generic hook"})
    check("raising a date change on the generic hook -> 400", r.status_code == 400,
          f"{r.status_code} {r.text[:220]}")
    r = requests.post(f"{BASE}/api/service-requests", headers=H(mtok),
                      json={"booking_id": bypass_b["id"], "request_type": "extra_baggage",
                            "remarks": "still fine on the generic hook"})
    check("but the generic hook still accepts other types -> 201", r.status_code in (200, 201),
          f"{r.status_code} {r.text[:220]}")

    r = requests.post(f"{BASE}/api/requests/{bypass_id}/cancel", headers=H(mtok),
                      json={"reason": "cancelling the cancellation"})
    check("the generic cancel refuses a change request -> 400", r.status_code == 400,
          f"{r.status_code} {r.text[:220]}")
    check("and points at withdraw", "withdraw" in r.text.lower(), r.text[:250])
    check("it is still Pending after that too",
          requests.get(f"{CR}/{bypass_id}", headers=H(atok)).json()["request"]["status"]
          == "pending_approval", "the generic cancel moved it")

    # ------------------------------------------------------ no bare cancel path
    print("\n== the settlement edge is not published as an action ==")
    paid = flows.make_booking(mtok, atok, upto="paid", label="M3 no bare cancel")
    actions = requests.get(f"{BASE}/api/requests/{paid['id']}", headers=H(atok)).json().get("actions") or []
    check("a PAID booking offers no bare Cancel action to an admin",
          all(a.get("to") != "cancelled" for a in actions), str(actions))
    r = requests.post(f"{BASE}/api/requests/{paid['id']}/cancel", headers=H(atok),
                      json={"reason": "bypassing the workflow"})
    check("and the direct cancel endpoint refuses it", r.status_code in (400, 403),
          f"{r.status_code} {r.text[:220]}")
    check("the booking is still paid", booking_status(mtok, paid["id"]) == "paid",
          booking_status(mtok, paid["id"]))

    # ------------------------------------------------------------- concurrency
    print("\n== two admins approving at once ==")
    race = flows.make_booking(mtok, atok, upto="approved", label="M3 race")
    r = requests.post(f"{BASE}/api/bookings/{race['id']}/cancellation", headers=H(mtok),
                      json={"reason": "concurrency check"})
    race_id = r.json()["request"]["id"]

    results, lock = [], threading.Lock()

    def approve(i):
        # Unclaimed on purpose: with no holder both admins are entitled to try,
        # so the row lock is the only thing standing between them.
        res = requests.post(
            f"{BASE}/api/admin/change-requests/{race_id}/approve",
            headers=H(atok if i % 2 == 0 else a2tok),
            json={"cancellation_charge": "1000.00"},
        )
        with lock:
            results.append(res.status_code)

    threads = [threading.Thread(target=approve, args=(i,)) for i in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]

    check("exactly one of six simultaneous approvals wins",
          results.count(200) == 1, str(sorted(results)))
    check("the losers get 409, not 500",
          all(code == 409 for code in results if code != 200), str(sorted(results)))
    check("the booking was cancelled exactly once",
          booking_status(mtok, race["id"]) == "cancelled", booking_status(mtok, race["id"]))
    hist = requests.get(f"{BASE}/api/requests/{race['id']}", headers=H(atok)).json()["timeline"]
    check("and its timeline has one cancellation entry, not six",
          sum(1 for step in hist if step.get("status") == "cancelled") == 1, str(hist)[-300:])

    # ---------------------------------------------------------- notifications
    print("\n== notifications ==")
    notes = requests.get(f"{BASE}/api/notifications", headers=H(mtok))
    body = notes.text if notes.status_code == 200 else ""
    check("merchant is notified about the settlement", notes.status_code == 200, str(notes.status_code))
    check("the approval notification reached the merchant",
          "Cancellation approved" in body or "Reschedule approved" in body, body[:300])

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
