"""CR-2 — Manager approval step, and the payment workflow bypassed for Classic Tours.

Proves the change request's contract:

  * the workflow runs end to end: enquiry -> booking -> Manager -> ops -> merchant
  * **only** a Manager can approve a Classic Tours booking, and an Admin cannot
  * reject means "returned for correction" — editable, resubmittable, not terminal
  * the payment workflow is unreachable on this track, through every door
  * ticket documents: multiple files, staff-only upload, merchant-only download
  * RBAC from every role, including cross-tenant
  * concurrency: two managers deciding one booking
  * the standard (catalog-led) track still pays, exactly as before
  * the Super Admin can create, list, re-role and delete Manager accounts, and
    the RBAC set arrives with the role rather than being granted by hand
  * a Manager can read its notifications and manage its own profile/password

The refusals are asserted on the **status code and the message**, not just the
code: "400" alone would pass against a validation error that happens to reject
for the wrong reason, and these guards exist to say why.
"""
import concurrent.futures
import sys
import time

import flows
import minihttp as requests
from config import ADMIN, BASE, MANAGER, MERCHANT, PDF, SUPER, Checker, H, login

_c = Checker()
check = _c

MGR = f"{BASE}/api/manager/bookings"


def detail(token, rid):
    return requests.get(f"{BASE}/api/requests/{rid}", headers=H(token)).json()


def main():
    mtok = login(*MERCHANT)
    atok = login(*ADMIN)
    gtok = login(*MANAGER)
    stok = login(*SUPER)

    # =====================================================================
    print("\n== the Manager role is its own thing ==")
    # =====================================================================
    me = requests.get(f"{BASE}/api/auth/me", headers=H(gtok)).json()
    check("the manager signs in on the manager portal", me.get("portal") == "manager", str(me.get("portal")))
    check("and carries the manager role", me.get("role") == "manager", str(me.get("role")))

    perms = set(me.get("permissions") or [])
    check("it holds booking.manager_approve", "booking.manager_approve" in perms, str(sorted(perms)))
    check("it holds booking.manager_return", "booking.manager_return" in perms, str(sorted(perms)))
    # The separations that make the role worth having.
    check("it does NOT hold ticket.approve — that is the admin's catalog queue",
          "ticket.approve" not in perms, str(sorted(perms)))
    check("it does NOT hold ticket.issue — that is the operations desk",
          "ticket.issue" not in perms, str(sorted(perms)))
    check("it does NOT hold ticket.view — that would open every admin booking screen",
          "ticket.view" not in perms, str(sorted(perms)))
    check("it holds no payment permission at all",
          not any(p.startswith("payment.") for p in perms), str(sorted(perms)))

    admin_perms = set(requests.get(f"{BASE}/api/auth/me", headers=H(atok)).json().get("permissions") or [])
    check("an ADMIN cannot approve as a manager",
          "booking.manager_approve" not in admin_perms, str(sorted(admin_perms)))

    # A manager's credentials must not open another portal.
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": MANAGER[0], "password": MANAGER[1], "portal": "admin"})
    check("manager credentials on the admin portal -> 401", r.status_code == 401, f"{r.status_code} {r.text[:150]}")

    # =====================================================================
    print("\n== a submitted Classic Tours booking belongs to the Manager ==")
    # =====================================================================
    b = flows.make_booking(mtok, atok, upto="pending_approval", label="cr2 main")
    rid, number = b["id"], b["request_number"]

    d = detail(mtok, rid)["request"]
    check("it is tagged as the classic_tours workflow", d["workflow"] == "classic_tours", str(d.get("workflow")))
    check("and reads 'Pending Manager Approval', not 'Pending'",
          d["status_label"] == "Pending Manager Approval", d["status_label"])

    tl = detail(mtok, rid)["timeline"]
    labels = [s["label"] for s in tl]
    check("its timeline never projects Payment Pending",
          "Payment Pending" not in labels, str(labels))
    check("nor Paid", "Paid" not in labels, str(labels))
    check("it does project Manager Approved", "Manager Approved" in labels, str(labels))

    q = requests.get(f"{BASE}/api/admin/approval-queue?page_size=100", headers=H(atok)).json()
    check("it is absent from the admin approval queue",
          not any(i["id"] == rid and i.get("kind") == "request" for i in q.get("items", [])))

    seen = requests.get(f"{MGR}?search={number}", headers=H(gtok)).json()
    check("it is present on the manager's queue",
          any(i["id"] == rid for i in seen.get("items", [])), seen.get("total"))

    # =====================================================================
    print("\n== the admin cannot approve, reject or re-price it ==")
    # =====================================================================
    for path, payload, label in (
        ("approve", {"final_amount": "24500.00"}, "approve"),
        ("reject", {"reason": "no"}, "reject"),
        ("reprice", {"amount": "100.00", "reason": "x"}, "reprice"),
    ):
        r = requests.post(f"{BASE}/api/admin/requests/{rid}/{path}", json=payload, headers=H(atok))
        check(f"admin {label} -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
        check(f"...and the refusal points at the Manager ({label})",
              "manager" in r.text.lower(), r.text[:200])

    st = detail(atok, rid)["request"]["status"]
    check("the booking did not move", st == "pending_approval", st)

    # =====================================================================
    print("\n== payment is unreachable, through every door ==")
    # =====================================================================
    r = requests.post(f"{BASE}/api/requests/{rid}/pay",
                      json={"amount": "100.00", "method": "bank_transfer"}, headers=H(mtok))
    check("the merchant paying -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    check("...and it says nothing is owed", "not paid through the portal" in r.text.lower(), r.text[:200])

    # The state machine itself, not just the endpoint: Payment Pending has no
    # inbound edge on this track, so no caller of any kind can reach it.
    mdetail = requests.get(f"{MGR}/{rid}", headers=H(gtok)).json()
    check("no action offered to the manager leads to payment_pending",
          not any(a["to"] == "payment_pending" for a in mdetail["actions"]),
          str([a["to"] for a in mdetail["actions"]]))

    # =====================================================================
    print("\n== reject means 'returned for correction', not terminal ==")
    # =====================================================================
    r = requests.post(f"{MGR}/{rid}/return", json={"remarks": ""}, headers=H(gtok))
    check("returning with empty remarks -> 422", r.status_code == 422, f"{r.status_code} {r.text[:150]}")

    remark = "Traveller 1 surname does not match the passport."
    r = requests.post(f"{MGR}/{rid}/return", json={"remarks": remark}, headers=H(gtok))
    check("returning with remarks -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    d = detail(mtok, rid)["request"]
    check("the booking is back at Draft, NOT Rejected", d["status"] == "draft", d["status"])
    check("the merchant is told exactly what to fix",
          d["details"].get("manager_remarks") == remark, str(d["details"].get("manager_remarks")))
    check("its passengers survived the round trip", len(d["passengers"]) >= 1, str(len(d["passengers"])))
    check("and so did the enquiry link", bool(d["details"].get("enquiry_reference")))
    check("rejection_reason is untouched — this request is not over",
          not d.get("rejection_reason"), str(d.get("rejection_reason")))

    tl = detail(mtok, rid)["timeline"]
    upcoming = [s["label"] for s in tl if s["state"] == "pending"]
    check("the timeline still projects the submission it has to make again",
          "Pending Manager Approval" in upcoming, str(upcoming))

    r = requests.post(f"{BASE}/api/requests/{rid}/submit", headers=H(mtok))
    check("the merchant resubmits -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    d = detail(mtok, rid)["request"]
    check("the stale remarks are cleared on resubmission",
          "manager_remarks" not in d["details"], str(d["details"].get("manager_remarks")))

    # =====================================================================
    print("\n== only the manager holding the claim may decide ==")
    # =====================================================================
    r = requests.post(f"{MGR}/{rid}/start-review", headers=H(gtok))
    check("start review -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("it reads 'Under Manager Review'",
          r.json()["request"]["status_label"] == "Under Manager Review",
          r.json()["request"]["status_label"])
    r = requests.post(f"{MGR}/{rid}/start-review", headers=H(gtok))
    check("re-claiming your own is a no-op, not an error", r.status_code == 200, f"{r.status_code}")

    # =====================================================================
    print("\n== approval hands the booking to the operations desk ==")
    # =====================================================================
    r = requests.post(f"{MGR}/{rid}/approve", json={"note": "Verified against the enquiry."}, headers=H(gtok))
    check("manager approves -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    d = detail(mtok, rid)["request"]
    check("it reads 'Manager Approved'", d["status_label"] == "Manager Approved", d["status_label"])
    check("and no amount was invented along the way",
          str(d["total_amount"]) in ("0", "0.00", "0.0"), str(d["total_amount"]))

    queue = requests.get(f"{BASE}/api/admin/bookings/queue?stage=approved&search={number}",
                         headers=H(atok)).json()
    row = next((i for i in queue.get("items", []) if i["id"] == rid), None)
    check("it appears in the Booking Operations queue", row is not None, str(queue.get("total")))
    check("the queue marks it as the classic_tours workflow",
          row and row["workflow"] == "classic_tours", str(row and row.get("workflow")))
    check("and reports that no tickets are attached yet",
          row and row["has_ticket_documents"] is False, str(row and row.get("has_ticket_documents")))

    # A second approval must not be possible.
    r = requests.post(f"{MGR}/{rid}/approve", json={}, headers=H(gtok))
    check("approving an already-approved booking -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    # =====================================================================
    print("\n== ticket documents ==")
    # =====================================================================
    r = requests.post(f"{BASE}/api/admin/requests/{rid}/issue-ticket", headers=H(atok), json={})
    check("marking Ticket Issued with nothing attached -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    check("...and it says to upload the documents first",
          "upload" in r.text.lower(), r.text[:200])

    # The merchant may not attach to a submitted booking; the desk may, from
    # Manager Approved onwards — there is no Paid stage on this track to wait for.
    r = requests.post(f"{BASE}/api/requests/{rid}/documents", headers=H(mtok),
                      files={"file": ("sneaky.pdf", PDF, "application/pdf")},
                      data={"doc_type": "ticket"})
    check("a merchant attaching a 'ticket' to an approved booking -> 409",
          r.status_code == 409, f"{r.status_code} {r.text[:200]}")

    uploaded = []
    for n in (1, 2, 3):
        r = requests.post(f"{BASE}/api/requests/{rid}/documents", headers=H(atok),
                          files={"file": (f"eticket{n}.pdf", PDF, "application/pdf")},
                          data={"doc_type": "ticket"})
        check(f"staff attach ticket {n} of 3 -> 201", r.status_code in (200, 201), f"{r.status_code} {r.text[:200]}")
        if r.status_code in (200, 201):
            uploaded.append(r.json()["id"])

    docs = requests.get(f"{BASE}/api/requests/{rid}/tickets", headers=H(mtok)).json()
    check("the merchant lists all three", len(docs) == 3, str(len(docs)))

    dl = requests.get(f"{BASE}/api/documents/{uploaded[0]}/download", headers=H(mtok))
    check("and downloads one -> 200", dl.status_code == 200, str(dl.status_code))
    check("served as an attachment, not inline",
          "attachment" in (dl.headers.get("content-disposition") or ""),
          dl.headers.get("content-disposition"))
    check("and never cached",
          "no-store" in (dl.headers.get("cache-control") or ""), dl.headers.get("cache-control"))

    # CR-4b: an enquiry-led booking carries no amount until the desk issuing the
    # ticket supplies the fare it paid, which is what the merchant's wallet is
    # debited. Before CR-4b this call omitted it and produced a ticketed booking
    # worth nothing — the assertion below was passing on a ₹0 booking.
    r = requests.post(f"{BASE}/api/admin/requests/{rid}/issue-ticket", headers=H(atok),
                      json={"fare_amount": "24500.00"})
    check("with the tickets attached, Ticket Issued -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    d = detail(mtok, rid)["request"]
    check("the booking is Ticket Issued", d["status"] == "ticket_issued", d["status"])
    check("a PNR was allocated", bool(d.get("pnr")), str(d.get("pnr")))

    r = requests.post(f"{BASE}/api/admin/requests/{rid}/complete", headers=H(atok), json={})
    check("and then Completed -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    final = detail(mtok, rid)
    check("final status is Completed", final["request"]["status"] == "completed", final["request"]["status"])
    check("its whole history is on the timeline, with no payment step",
          not any(s["label"] in ("Payment Pending", "Paid") for s in final["timeline"]),
          str([s["label"] for s in final["timeline"]]))

    # =====================================================================
    print("\n== RBAC on the manager surface ==")
    # =====================================================================
    other = flows.make_booking(mtok, atok, upto="pending_approval", label="cr2 rbac")
    oid = other["id"]

    for token, who in ((atok, "admin"), (mtok, "merchant"), (stok, "super admin")):
        r = requests.get(MGR, headers=H(token))
        check(f"{who} listing the manager queue -> 403", r.status_code == 403, f"{r.status_code} {r.text[:150]}")
        r = requests.post(f"{MGR}/{oid}/approve", json={}, headers=H(token))
        check(f"{who} approving as a manager -> 403", r.status_code == 403, f"{r.status_code} {r.text[:150]}")
        r = requests.post(f"{MGR}/{oid}/return", json={"remarks": "no"}, headers=H(token))
        check(f"{who} returning as a manager -> 403", r.status_code == 403, f"{r.status_code} {r.text[:150]}")

    r = requests.get(MGR)
    check("no token at all -> 401/403", r.status_code in (401, 403), str(r.status_code))

    # The manager is platform staff, but only for the bookings it decides.
    r = requests.get(f"{BASE}/api/admin/bookings/queue", headers=H(gtok))
    check("a manager cannot open the operations queue -> 403", r.status_code == 403, f"{r.status_code} {r.text[:150]}")
    r = requests.get(f"{BASE}/api/admin/bookings/{oid}/notes", headers=H(gtok))
    check("nor read the desk's internal notes -> 403", r.status_code == 403, f"{r.status_code} {r.text[:150]}")
    r = requests.post(f"{BASE}/api/requests/{oid}/documents", headers=H(gtok),
                      files={"file": ("x.pdf", PDF, "application/pdf")}, data={"doc_type": "ticket"})
    check("nor attach a ticket -> 403", r.status_code == 403, f"{r.status_code} {r.text[:150]}")

    # =====================================================================
    print("\n== the manager surface refuses everything that is not its business ==")
    # =====================================================================
    enquiry_id = other["enquiry_id"]
    r = requests.post(f"{MGR}/{enquiry_id}/approve", json={}, headers=H(gtok))
    check("approving a ticket enquiry here -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    catalog = flows.make_catalog_booking(mtok, atok, upto="pending_approval", label="cr2 catalog")
    r = requests.post(f"{MGR}/{catalog['id']}/approve", json={}, headers=H(gtok))
    check("approving a catalog-led booking here -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    check("...and the refusal explains it is not a Classic Tours booking",
          "classic tours" in r.text.lower(), r.text[:200])

    r = requests.get(f"{MGR}/999999999", headers=H(gtok))
    check("an unknown booking -> 404", r.status_code == 404, str(r.status_code))

    # =====================================================================
    print("\n== cross-tenant ==")
    # =====================================================================
    rival = flows.rival_merchant(atok)
    r = requests.get(f"{BASE}/api/requests/{oid}", headers=H(rival["token"]))
    check("another company reading this booking -> 404, not 403", r.status_code == 404, str(r.status_code))
    r = requests.post(f"{BASE}/api/requests/{oid}/submit", headers=H(rival["token"]))
    check("another company submitting it -> 404", r.status_code == 404, str(r.status_code))
    r = requests.get(f"{BASE}/api/requests/{oid}/tickets", headers=H(rival["token"]))
    check("another company listing its tickets -> 404", r.status_code == 404, str(r.status_code))

    # =====================================================================
    print("\n== two managers deciding one booking at once ==")
    # =====================================================================
    race = flows.make_booking(mtok, atok, upto="pending_approval", label="cr2 race")

    def approve_once(_):
        return requests.post(f"{MGR}/{race['id']}/approve", json={}, headers=H(gtok)).status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(approve_once, range(6)))
    check("exactly one of six simultaneous approvals wins", codes.count(200) == 1, str(codes))
    check("the losers get 400/409, never a 500",
          all(c in (200, 400, 409) for c in codes), str(codes))

    d = detail(mtok, race["id"])
    approvals = [s for s in d["timeline"] if s.get("status") == "approved" and s.get("at")]
    check("and the booking was approved exactly once", len(approvals) == 1, str(len(approvals)))

    # =====================================================================
    print("\n== the standard track still pays, untouched ==")
    # =====================================================================
    paid = flows.make_catalog_booking(mtok, atok, upto="paid", label="cr2 standard")
    d = detail(mtok, paid["id"])["request"]
    check("a catalog-led booking is still the standard workflow",
          d["workflow"] == "standard", str(d.get("workflow")))
    check("it reached Paid", d["status"] == "paid", d["status"])
    check("its label is the ordinary one", d["status_label"] == "Paid", d["status_label"])

    tl = detail(mtok, paid["id"])["timeline"]
    check("and its timeline DOES include the payment steps",
          any(s["label"] == "Payment Pending" for s in tl), str([s["label"] for s in tl]))

    r = requests.post(f"{BASE}/api/admin/requests/{paid['id']}/issue-ticket", headers=H(atok), json={})
    check("a standard booking still issues without a ticket document attached",
          r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # =====================================================================
    print("\n== the Super Admin can run Manager accounts (CR-2 follow-up) ==")
    # =====================================================================
    SA = f"{BASE}/api/super-admin/admins"
    made_email = f"cr2.manager.{int(time.time())}@jackpotsworldtours.com"

    r = requests.post(SA, headers=H(stok), json={
        "full_name": "Verification Manager", "email": made_email, "role": "manager"})
    check("create a manager -> 201", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
    made = r.json()["account"]
    made_password = r.json()["temporary_password"]
    check("it is created as a manager, not an admin", made["role"] == "manager", str(made["role"]))

    # The point of the whole exercise: the codes arrive with the role, and
    # nobody has to grant them by hand.
    made_token = login(made_email, made_password, "manager")
    made_me = requests.get(f"{BASE}/api/auth/me", headers=H(made_token)).json()
    check("the new manager gets the manager permission set automatically",
          set(made_me["permissions"]) == {
              "booking.manager_approve", "booking.manager_return",
              "notification.view", "profile.manage"},
          str(sorted(made_me["permissions"])))
    check("and can open the manager queue immediately",
          requests.get(f"{BASE}/api/manager/bookings?page_size=1",
                       headers=H(made_token)).status_code == 200)

    listed = requests.get(f"{SA}?role=manager&page_size=100", headers=H(stok)).json()
    check("the role filter returns only managers",
          all(i["role"] == "manager" for i in listed["items"]) and listed["total"] >= 1,
          str(listed["total"]))
    unfiltered = requests.get(f"{SA}?page_size=100", headers=H(stok)).json()
    check("and the unfiltered list carries both kinds of staff account",
          {"admin", "manager"} <= {i["role"] for i in unfiltered["items"]},
          str(sorted({i["role"] for i in unfiltered["items"]})))
    check("every listed staff account exposes its role",
          all("role" in i for i in unfiltered["items"]))

    matrix = requests.get(f"{BASE}/api/super-admin/permissions/matrix", headers=H(stok)).json()
    check("the permission matrix includes the manager role",
          "manager" in matrix["roles"], str(sorted(matrix["roles"])))

    r = requests.post(SA, headers=H(stok), json={
        "full_name": "Nope", "email": f"nope.{int(time.time())}@x.com", "role": "super_admin"})
    check("creating a super admin through this endpoint -> 422", r.status_code == 422,
          f"{r.status_code} {r.text[:150]}")

    # --- role changes -------------------------------------------------
    r = requests.put(f"{SA}/{made['id']}", headers=H(stok), json={
        "full_name": "Verification Manager", "email": made_email, "phone": None})
    check("editing without a role leaves the role alone",
          r.status_code == 200 and r.json()["role"] == "manager", f"{r.status_code} {r.json().get('role')}")

    # A manager mid-review must not be converted out from under its claim.
    claimed = flows.make_booking(mtok, atok, upto="pending_approval", label="cr2 claim guard")
    requests.post(f"{MGR}/{claimed['id']}/start-review", headers=H(made_token))
    r = requests.put(f"{SA}/{made['id']}", headers=H(stok), json={
        "full_name": "Verification Manager", "email": made_email, "phone": None, "role": "admin"})
    check("changing the role of a manager holding a review -> 409",
          r.status_code == 409, f"{r.status_code} {r.text[:200]}")
    check("...and the refusal names the booking to decide first",
          claimed["request_number"] in r.text, r.text[:250])

    requests.post(f"{MGR}/{claimed['id']}/approve", json={}, headers=H(made_token))
    r = requests.put(f"{SA}/{made['id']}", headers=H(stok), json={
        "full_name": "Verification Manager", "email": made_email, "phone": None, "role": "admin"})
    check("once nothing is held, the role change succeeds",
          r.status_code == 200 and r.json()["role"] == "admin", f"{r.status_code} {r.json().get('role')}")

    # The permission set must follow the role, not the account.
    time.sleep(1.2)   # force_logout_at is sub-second; a token minted in the same second looks older
    readmin = login(made_email, made_password, "admin")
    readmin_me = requests.get(f"{BASE}/api/auth/me", headers=H(readmin)).json()
    check("the converted account now holds the admin set, not the manager's",
          "booking.manager_approve" not in readmin_me["permissions"]
          and "ticket.approve" in readmin_me["permissions"],
          str(sorted(readmin_me["permissions"]))[:200])
    check("and can no longer reach the manager queue",
          requests.get(f"{BASE}/api/manager/bookings", headers=H(readmin)).status_code == 403)

    r = requests.delete(f"{SA}/{made['id']}", headers=H(stok))
    check("the account can be deleted from the same screen",
          r.status_code in (200, 204, 400), f"{r.status_code} {r.text[:150]}")

    # =====================================================================
    print("\n== a manager can read its notifications and manage its profile ==")
    # =====================================================================
    # notify_managers writes on every submission; before CR-2's follow-up the
    # manager held notification.view but had no surface to read them on.
    before = requests.get(f"{BASE}/api/notifications/unread-count", headers=H(gtok)).json()
    flows.make_booking(mtok, atok, upto="pending_approval", label="cr2 notify")
    after = requests.get(f"{BASE}/api/notifications/unread-count", headers=H(gtok)).json()
    check("a submitted booking raises the manager's unread count",
          int(after["count"]) > int(before["count"]), f"{before} -> {after}")

    notifs = requests.get(f"{BASE}/api/notifications?page_size=5", headers=H(gtok)).json()
    check("the manager can list them", notifs.get("total", 0) >= 1, str(notifs.get("total")))
    top = notifs["items"][0]
    check("and they name the booking awaiting approval",
          "approval" in (top.get("title", "") + top.get("message", "")).lower(),
          str(top)[:200])

    r = requests.patch(f"{BASE}/api/notifications/{top['id']}/read", headers=H(gtok))
    check("marking one read -> 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
    r = requests.post(f"{BASE}/api/notifications/read-all", headers=H(gtok))
    check("marking all read -> 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
    check("the unread count falls to zero",
          int(requests.get(f"{BASE}/api/notifications/unread-count",
                           headers=H(gtok)).json()["count"]) == 0)

    profile = requests.get(f"{BASE}/api/profile", headers=H(gtok))
    check("the manager can read its own profile", profile.status_code == 200, str(profile.status_code))
    original_name = profile.json()["full_name"]
    r = requests.put(f"{BASE}/api/profile", headers=H(gtok),
                     json={"full_name": original_name, "phone": "+919845012345"})
    check("and update it", r.status_code == 200 and r.json()["mobile"] == "+919845012345",
          f"{r.status_code} {r.text[:150]}")

    # Password change, on a throwaway account so the suite's own login keeps working.
    pw_email = f"cr2.pw.{int(time.time())}@jackpotsworldtours.com"
    created = requests.post(SA, headers=H(stok), json={
        "full_name": "Password Manager", "email": pw_email,
        "password": "FirstPass#2026", "role": "manager"}).json()
    pw_token = login(pw_email, "FirstPass#2026", "manager")
    r = requests.post(f"{BASE}/api/auth/change-password", headers=H(pw_token),
                      json={"current_password": "WrongPass#2026", "new_password": "SecondPass#2026"})
    check("changing a password with the wrong current one -> 400/401",
          r.status_code in (400, 401), f"{r.status_code} {r.text[:150]}")
    r = requests.post(f"{BASE}/api/auth/change-password", headers=H(pw_token),
                      json={"current_password": "FirstPass#2026", "new_password": "SecondPass#2026"})
    check("changing it correctly -> 200", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
    time.sleep(1.2)
    check("and the new password signs in",
          bool(login(pw_email, "SecondPass#2026", "manager")))
    requests.delete(f"{SA}/{created['account']['id']}", headers=H(stok))

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
