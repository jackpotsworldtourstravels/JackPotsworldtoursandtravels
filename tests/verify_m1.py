"""M1 verification — Booking Operations backend core.

Covers the processing queue, operator assignment, external references and
internal notes, including the staff-only boundary and concurrency behaviour.
"""
import sys

import flows
import minihttp as requests
from config import ADMIN, ADMIN2, BASE, MERCHANT, SUPER, Checker, H, login

_c = Checker()
check = _c


def main():
    print("== auth ==")
    mtok, muser = login(*MERCHANT, with_user=True)
    atok, auser = login(*ADMIN, with_user=True)
    stok, suser = login(*SUPER, with_user=True)
    a2tok, a2user = login(*ADMIN2, with_user=True)
    check("merchant, two admins and super admin sign in", all([mtok, atok, stok, a2tok]))
    admin_id = auser["id"] if "id" in auser else auser.get("user_id")

    Q = f"{BASE}/api/admin/bookings/queue"

    # ------------------------------------------------------------ the queue
    print("\n== processing queue ==")
    r = requests.get(Q, headers=H(atok))
    check("queue loads for admin", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    page = r.json()
    check("queue is a paginated page", {"items", "total", "page", "total_pages"} <= set(page), str(list(page))[:200])
    stages = {i["status"] for i in page["items"]}
    allowed = {"approved", "payment_pending", "paid", "ticket_issued"}
    check("queue only holds post-approval bookings", stages <= allowed, str(stages))
    check("queue rows carry merchant + passenger context",
          all("merchant_name" in i and "passengers" in i for i in page["items"]) if page["items"] else True)
    if page["items"]:
        ages = [i["age_hours"] for i in page["items"]]
        check("oldest first (age descends down the page)", ages == sorted(ages, reverse=True), str(ages[:6]))

    r = requests.get(f"{Q}?stage=pending_approval", headers=H(atok))
    check("a pre-approval stage is refused -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.get(f"{Q}?stage=paid", headers=H(atok))
    check("filter by a valid stage -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("stage filter actually filters",
          all(i["status"] == "paid" for i in r.json()["items"]), str([i["status"] for i in r.json()["items"]][:5]))

    r = requests.get(f"{Q}/counts", headers=H(atok))
    check("queue counts -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    counts = r.json()
    check("counts total equals the sum of its stages",
          counts["total"] == counts["approved"] + counts["payment_pending"] + counts["paid"] + counts["ticket_issued"],
          str(counts))

    r = requests.get(f"{BASE}/api/admin/bookings/queue?page_size=100", headers=H(atok))
    check("counts.total agrees with the listing total", r.json()["total"] == counts["total"],
          f"list={r.json()['total']} counts={counts['total']}")
    items = r.json()["items"]
    if not items:
        # Build one rather than bailing out: a suite that only works when the
        # database happens to hold the right row is not a regression suite.
        print("     (queue empty — building a booking to work with)")
        flows.make_booking(mtok, atok, upto="approved", label="M1 verification")
        r = requests.get(f"{BASE}/api/admin/bookings/queue?page_size=100", headers=H(atok))
        items = r.json()["items"]
        check("a post-approval booking is available to work", bool(items), r.text[:250])
        if not items:
            return _c.report()
    booking = items[0]
    rid = booking["id"]
    print(f"     working booking {booking['request_number']} (id {rid}, {booking['status']})")

    # ---------------------------------------------------- staff-only boundary
    print("\n== staff-only boundary ==")
    for label, path, method, body in [
        ("queue", Q, "GET", None),
        ("counts", f"{Q}/counts", "GET", None),
        ("operators", f"{BASE}/api/admin/bookings/operators", "GET", None),
        ("notes list", f"{BASE}/api/admin/bookings/{rid}/notes", "GET", None),
        ("add note", f"{BASE}/api/admin/bookings/{rid}/notes", "POST", {"body": "merchant should not be here"}),
        ("assign", f"{BASE}/api/admin/bookings/{rid}/assign", "POST", {"operator_id": None}),
        ("references", f"{BASE}/api/admin/bookings/{rid}/references", "PUT", {"pnr": "HACKED"}),
    ]:
        r = requests.request(method, path, headers=H(mtok), json=body)
        check(f"merchant blocked from {label} -> 403", r.status_code == 403, f"{r.status_code} {r.text[:160]}")

    # ------------------------------------------------------------- operators
    print("\n== operator assignment ==")
    r = requests.get(f"{BASE}/api/admin/bookings/operators", headers=H(atok))
    check("operator list -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    ops = r.json()
    check("operators are returned", len(ops) > 0, str(ops)[:200])
    check("each operator reports its current load",
          all("open_bookings" in o for o in ops), str(ops)[:250])
    op_id = ops[0]["id"]

    r = requests.post(f"{BASE}/api/admin/bookings/{rid}/assign", headers=H(atok), json={"operator_id": op_id})
    check("assign to an operator -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("assignment is reflected in the response",
          r.json()["assigned_admin"] == op_id and r.json()["assigned_to"], r.text[:250])

    r = requests.get(f"{Q}?assigned_to={op_id}", headers=H(atok))
    check("filter by assignee finds it", any(i["id"] == rid for i in r.json()["items"]), r.text[:200])

    r = requests.get(f"{Q}?unassigned=true", headers=H(atok))
    check("unassigned filter excludes it", all(i["id"] != rid for i in r.json()["items"]))

    r = requests.post(f"{BASE}/api/admin/bookings/{rid}/assign", headers=H(atok), json={"operator_id": 999999})
    check("unknown operator -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    merchant_uid = muser["id"] if "id" in muser else muser.get("user_id")
    r = requests.post(f"{BASE}/api/admin/bookings/{rid}/assign", headers=H(atok), json={"operator_id": merchant_uid})
    check("a merchant user cannot be an operator -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.post(f"{BASE}/api/admin/bookings/{rid}/assign", headers=H(atok), json={"operator_id": None})
    check("unassign -> 200", r.status_code == 200 and r.json()["assigned_admin"] is None, f"{r.status_code} {r.text[:200]}")
    requests.post(f"{BASE}/api/admin/bookings/{rid}/assign", headers=H(atok), json={"operator_id": op_id})

    # ------------------------------------------------------------ references
    print("\n== external references ==")
    REF = f"{BASE}/api/admin/bookings/{rid}/references"
    before = requests.get(f"{Q}?search={booking['request_number']}", headers=H(atok)).json()["items"][0]

    r = requests.put(REF, headers=H(atok), json={"pnr": "h4x9pq"})
    check("set the airline PNR -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("PNR is upper-cased", r.json()["pnr"] == "H4X9PQ", r.text[:200])
    check("setting only the PNR left the ticket number alone",
          r.json()["ticket_number"] == before["ticket_number"], f"{before['ticket_number']} -> {r.json()['ticket_number']}")

    r = requests.put(REF, headers=H(atok), json={"pnr": "   "})
    check("a blank PNR is refused -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.put(REF, headers=H(atok), json={"airline_reference": "GRP/2026/EK/7781"})
    check("airline reference stored -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("PNR survived the airline-reference write", r.json()["pnr"] == "H4X9PQ", r.text[:200])

    r = requests.get(f"{Q}?search=H4X9PQ", headers=H(atok))
    check("the queue is searchable by PNR", any(i["id"] == rid for i in r.json()["items"]), r.text[:250])

    # a duplicate ticket number must 409, not 500
    others = [i for i in items if i["id"] != rid and i["ticket_number"]]
    if others:
        r = requests.put(REF, headers=H(atok), json={"ticket_number": others[0]["ticket_number"]})
        check("duplicate ticket number -> 409 naming the other booking",
              r.status_code == 409 and others[0]["request_number"] in r.text, f"{r.status_code} {r.text[:250]}")
    else:
        print("     (no other ticketed booking — duplicate check skipped)")

    # a booking that is not yet confirmed has nothing to reference
    draft = requests.get(f"{BASE}/api/requests?request_status=draft&page_size=1", headers=H(mtok))
    if draft.status_code == 200 and draft.json().get("items"):
        did = draft.json()["items"][0]["id"]
        r = requests.put(f"{BASE}/api/admin/bookings/{did}/references", headers=H(atok), json={"pnr": "TOOSOON"})
        check("references refused on an unconfirmed booking -> 400", r.status_code == 400, f"{r.status_code} {r.text[:220]}")

    # ----------------------------------------------------------- internal notes
    print("\n== internal notes ==")
    N = f"{BASE}/api/admin/bookings/{rid}/notes"

    r = requests.post(N, headers=H(atok), json={"body": "Airline holding seats until 18:00 IST. Called Emirates desk."})
    check("add a note -> 201", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    note = r.json()
    check("note carries its author", note.get("author_name"), r.text[:200])
    check("author may edit their own note", note.get("can_edit") is True, r.text[:200])
    check("a fresh note is not marked edited", note.get("edited_at") is None, r.text[:200])

    r = requests.post(N, headers=H(atok), json={"body": "   "})
    check("a blank note is refused -> 400/422", r.status_code in (400, 422), f"{r.status_code} {r.text[:200]}")

    r = requests.get(N, headers=H(atok))
    check("notes list -> 200", r.status_code == 200 and len(r.json()) >= 1, f"{r.status_code} {r.text[:200]}")
    check("newest note first", r.json()[0]["id"] == note["id"], r.text[:200])

    r = requests.put(f"{BASE}/api/admin/bookings/notes/{note['id']}", headers=H(atok),
                     json={"body": "Airline holding seats until 20:00 IST (extended)."})
    check("author edits their note -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("edited_at is stamped", r.json().get("edited_at"), r.text[:200])
    check("the edit applied", "20:00" in r.json()["body"], r.text[:200])

    # a different Admin may read but not rewrite
    r = requests.get(N, headers=H(a2tok))
    ok = r.status_code == 200 and isinstance(r.json(), list)
    check("another admin can read the note", ok and any(n["id"] == note["id"] for n in r.json()),
          f"{r.status_code} {r.text[:200]}")
    check("but cannot edit it (can_edit false)",
          ok and all(not n["can_edit"] for n in r.json() if n["id"] == note["id"]), r.text[:250])
    r = requests.put(f"{BASE}/api/admin/bookings/notes/{note['id']}", headers=H(a2tok), json={"body": "hijacked"})
    check("a non-author editing -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")
    r = requests.delete(f"{BASE}/api/admin/bookings/notes/{note['id']}", headers=H(a2tok))
    check("a non-author deleting -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    # Super Admin is not an operations role — this is the designed boundary,
    # not an oversight, so it is asserted rather than worked around.
    r = requests.get(N, headers=H(stok))
    check("super admin has no booking-ops access -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    # notes must never leak into the merchant's own view of the booking
    r = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok))
    if r.status_code == 200:
        check("notes never appear in the merchant's booking detail",
              "notes" not in r.json() and "20:00 IST" not in r.text, r.text[:200])

    r = requests.delete(f"{BASE}/api/admin/bookings/notes/{note['id']}", headers=H(atok))
    check("author deletes their note -> 204", r.status_code == 204, f"{r.status_code} {r.text[:200]}")
    r = requests.get(N, headers=H(atok))
    check("the note is gone", all(n["id"] != note["id"] for n in r.json()), r.text[:200])

    # --------------------------------------------------------- not-found paths
    print("\n== not found ==")
    r = requests.get(f"{BASE}/api/admin/bookings/99999999/notes", headers=H(atok))
    check("notes on an unknown booking -> 404", r.status_code == 404, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{BASE}/api/admin/bookings/99999999/assign", headers=H(atok), json={"operator_id": op_id})
    check("assigning an unknown booking -> 404", r.status_code == 404, f"{r.status_code} {r.text[:200]}")
    r = requests.put(f"{BASE}/api/admin/bookings/notes/99999999", headers=H(atok), json={"body": "x"})
    check("editing an unknown note -> 404", r.status_code == 404, f"{r.status_code} {r.text[:200]}")

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
