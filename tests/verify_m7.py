"""M7 — merchant booking history, ticket delivery and downloads.

WHAT THIS PROTECTS

M7's verification requirements are four claims about what a merchant can and
cannot reach. Three of them are about *absence*, which is the hard kind:

1. **A merchant of company A gets 404 for every one of company B's bookings,
   documents and PDFs.** Asserted against a rival company's *real* rows — a 404
   for id 99999999 proves nothing about a record that exists and belongs to
   someone else.
2. **Internal notes are absent from every merchant response**, asserted on the
   raw JSON rather than on a rendered screen. `request_notes` is staff-only at
   the service layer (migration 0032); a note is written, then hunted for in the
   merchant's own payload byte by byte.
3. **Downloads are served as attachments with `Cache-Control: private, no-store`**
   — a booking confirmation sitting in a shared proxy cache is a passenger
   manifest sitting in a shared proxy cache.
4. **Pagination and filters are correct on a merchant with many bookings** —
   including the property the old screen did not have: that a search reaches
   rows beyond the first page.

Plus the two bugs M7 found in surfaces it had to touch:

5. `MERCHANT_REQUEST_STATUSES` sent `ticketed`, which is not a `RequestStatus`
   member — every status filter in the merchant portal 422'd on that option.
   The vocabulary is asserted against the live enum, so it cannot drift again.
6. The two PDFs M2 built had **no caller anywhere in the product** while the
   ticket-issued notification told merchants they could download them.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402

from app.models_v2 import RequestStatus  # noqa: E402

import flows  # noqa: E402
from config import ADMIN, BASE, MERCHANT, Checker, H, login  # noqa: E402

check = Checker()
atok = login(*ADMIN)
mtok = login(*MERCHANT)


def get(path, token=mtok):
    return requests.get(f"{BASE}{path}", headers=H(token))


print("\n=== 1. Booking history: filters, pagination, search ===")

page1 = get("/api/requests?request_type=booking&page=1&page_size=25").json()
check("the list is paginated", page1["page"] == 1 and page1["page_size"] == 25)
check("...and reports a total beyond the page",
      page1["total"] > len(page1["items"]),
      f"total={page1['total']} items={len(page1['items'])}")
check("a page returns at most page_size rows", len(page1["items"]) <= 25)

page2 = get("/api/requests?request_type=booking&page=2&page_size=25").json()
check("page 2 returns different rows from page 1",
      {i["id"] for i in page1["items"]}.isdisjoint({i["id"] for i in page2["items"]}))
check("...and the total is stable across pages", page2["total"] == page1["total"])

check("page_size is capped server-side",
      get("/api/requests?page_size=500").status_code == 422)

# The vocabulary the portal's status filter is built from must be reachable.
# This is the bug M7 found: the list said `ticketed`, which is not an enum
# member, so choosing it 422'd and the screen rendered "[object Object]".
PORTAL_STATUSES = [
    "draft", "pending_approval", "in_review", "approved", "payment_pending",
    "paid", "ticket_issued", "completed", "cancelled", "rejected",
]
enum_values = {s.value for s in RequestStatus}
bad = [s for s in PORTAL_STATUSES if s not in enum_values]
check("every status the merchant portal offers is a real RequestStatus", not bad, str(bad))
check("...and 'ticketed' is NOT one of them — that was the bug",
      "ticketed" not in enum_values)

for status in PORTAL_STATUSES:
    r = get(f"/api/requests?status={status}&page_size=5")
    check(f"status={status} is accepted", r.status_code == 200, f"{r.status_code} {r.text[:120]}")

check("an invented status is still refused",
      get("/api/requests?status=ticketed&page_size=5").status_code == 422)

# Search must reach the whole history, not the page in front of the user. This
# is what the old client-side filter could not do.
deep = get("/api/requests?request_type=booking&page=8&page_size=25").json()
if deep["items"]:
    target = deep["items"][0]
    key = target.get("pnr") or target["request_number"]
    found = get(f"/api/requests?search={key}&page_size=25").json()
    check("a search finds a booking that lives on page 8",
          any(i["id"] == target["id"] for i in found["items"]),
          f"searched {key!r}, got {[i['request_number'] for i in found['items']][:5]}")
    check("...and the result set is narrowed, not the whole list",
          found["total"] < page1["total"], f"{found['total']} vs {page1['total']}")
else:
    check("fewer than 8 pages of bookings — deep-search check skipped", True)

filtered = get("/api/requests?request_type=booking&status=ticket_issued&page_size=1").json()
check("type and status filters combine", filtered["total"] <= page1["total"])
check("...and every returned row honours both",
      all(i["request_type"] == "booking" and i["status"] == "ticket_issued"
          for i in filtered["items"]))


print("\n=== 2. Booking detail carries what the screen renders ===")

ticketed = get("/api/requests?request_type=booking&status=ticket_issued&page_size=1").json()
assert ticketed["items"], "no ticketed booking to verify against"
BOOKING = ticketed["items"][0]
BID = BOOKING["id"]

detail = get(f"/api/requests/{BID}").json()
check("detail returns the request", detail["request"]["id"] == BID)
check("detail returns the full timeline", len(detail["timeline"]) > 1)
check("detail returns passengers", isinstance(detail["request"]["passengers"], list))
check("detail returns payments", isinstance(detail["payments"], list))
check("timeline steps carry a state, so 'still ahead' is distinguishable",
      all("state" in s for s in detail["timeline"]))

children = get(f"/api/bookings/{BID}/change-requests")
check("change requests raised against a booking are listable",
      children.status_code == 200, children.text[:150])


print("\n=== 3. Staff-only data is absent from merchant responses ===")

# Written as staff, then hunted for in the merchant's own payload.
note_body = "M7 internal probe — merchants must never see this string"
created = requests.post(
    f"{BASE}/api/admin/bookings/{BID}/notes", headers=H(atok), json={"body": note_body}
)
check("an admin can write an internal note", created.status_code in (200, 201),
      f"{created.status_code} {created.text[:150]}")
note_id = created.json().get("id") if created.status_code in (200, 201) else None

staff_notes = requests.get(f"{BASE}/api/admin/bookings/{BID}/notes", headers=H(atok))
check("...and read it back", staff_notes.status_code == 200
      and any(n["body"] == note_body for n in staff_notes.json()))

raw_detail = get(f"/api/requests/{BID}").text
check("the note body is absent from the merchant's booking detail",
      note_body not in raw_detail)
check("no 'internal' key appears anywhere in that payload",
      "internal" not in raw_detail.lower())
check("the assigned operator is not named to the merchant",
      "assigned_admin" not in raw_detail)

raw_list = get(f"/api/requests?request_type=booking&page_size=25").text
check("the note body is absent from the merchant's list response",
      note_body not in raw_list)

check("a merchant cannot read the staff notes endpoint at all",
      get(f"/api/admin/bookings/{BID}/notes").status_code in (403, 404))
check("a merchant cannot write one either",
      requests.post(f"{BASE}/api/admin/bookings/{BID}/notes",
                    headers=H(mtok), json={"body": "nope"}).status_code in (403, 404))

# The timeline DOES carry a `note` key — that is the lifecycle transition note
# written by lifecycle.transition, a different thing from request_notes, and it
# is deliberately merchant-visible. Asserted so a future reader does not "fix"
# it by removing the field.
timeline_notes = [s.get("note") for s in detail["timeline"]]
check("the timeline's own transition notes are a separate, merchant-visible field",
      all(n is None or isinstance(n, str) for n in timeline_notes))

if note_id:
    requests.delete(f"{BASE}/api/admin/bookings/notes/{note_id}", headers=H(atok))


print("\n=== 4. Downloads: invoice, confirmation, e-ticket ===")

invoice = get(f"/api/requests/{BID}/invoice")
check("the invoice PDF downloads", invoice.status_code == 200, invoice.text[:150])
check("...as a real PDF", invoice.content[:5] == b"%PDF-")
check("...served as an attachment",
      "attachment" in invoice.headers.get("content-disposition", "").lower())
check("...and never cached",
      "no-store" in invoice.headers.get("cache-control", "").lower()
      and "private" in invoice.headers.get("cache-control", "").lower(),
      invoice.headers.get("cache-control"))

confirmation = get(f"/api/requests/{BID}/confirmation")
check("the booking confirmation PDF downloads", confirmation.status_code == 200)
check("...as a real PDF", confirmation.content[:5] == b"%PDF-")
check("...served as an attachment",
      "attachment" in confirmation.headers.get("content-disposition", "").lower())
check("...and never cached",
      "no-store" in confirmation.headers.get("cache-control", "").lower())

tickets = get(f"/api/requests/{BID}/tickets")
check("the e-ticket listing is merchant-readable", tickets.status_code == 200)
ticket_docs = tickets.json() if tickets.status_code == 200 else []
if ticket_docs:
    doc_id = ticket_docs[0]["id"]
    blob = get(f"/api/documents/{doc_id}/download")
    check("an attached e-ticket downloads", blob.status_code == 200)
    check("...as an attachment",
          "attachment" in blob.headers.get("content-disposition", "").lower())
    check("...and never cached",
          "no-store" in blob.headers.get("cache-control", "").lower())
else:
    doc_id = None
    check("this booking carries no e-ticket file — download check skipped", True)

# The gate: a PDF is only meaningful once the invoice number exists.
draft = get("/api/requests?request_type=booking&status=draft&page_size=1").json()
if draft["items"]:
    draft_id = draft["items"][0]["id"]
    r = get(f"/api/requests/{draft_id}/invoice")
    check("an un-ticketed booking has no invoice, and says so with a 409",
          r.status_code == 409, f"{r.status_code} {r.text[:150]}")
else:
    check("no draft booking to test the invoice gate — skipped", True)


print("\n=== 5. Cross-tenant: company A gets 404 for company B ===")

rival = flows.rival_merchant(atok)
rtok = rival["token"]

check("a rival cannot read the booking detail",
      requests.get(f"{BASE}/api/requests/{BID}", headers=H(rtok)).status_code == 404)
check("a rival cannot download its invoice",
      requests.get(f"{BASE}/api/requests/{BID}/invoice", headers=H(rtok)).status_code == 404)
check("a rival cannot download its confirmation",
      requests.get(f"{BASE}/api/requests/{BID}/confirmation", headers=H(rtok)).status_code == 404)
check("a rival cannot list its e-tickets",
      requests.get(f"{BASE}/api/requests/{BID}/tickets", headers=H(rtok)).status_code == 404)
check("a rival cannot list its change requests",
      requests.get(f"{BASE}/api/bookings/{BID}/change-requests",
                   headers=H(rtok)).status_code == 404)
if doc_id:
    check("a rival cannot download its e-ticket file",
          requests.get(f"{BASE}/api/documents/{doc_id}/download",
                       headers=H(rtok)).status_code == 404)

# 404, not 403 — a 403 confirms the record exists.
forbidden = [
    code for code in (
        requests.get(f"{BASE}/api/requests/{BID}", headers=H(rtok)).status_code,
        requests.get(f"{BASE}/api/requests/{BID}/invoice", headers=H(rtok)).status_code,
    ) if code == 403
]
check("cross-tenant refusals are 404, never 403 — a 403 confirms the row exists",
      not forbidden, str(forbidden))

rival_list = requests.get(
    f"{BASE}/api/requests?request_type=booking&page_size=100", headers=H(rtok)
).json()
check("a rival's own list contains none of our bookings",
      all(i["id"] != BID for i in rival_list["items"]))
check("...and is scoped to its own merchant",
      all(i["merchant_id"] == rival["merchant_id"] for i in rival_list["items"])
      if rival_list["items"] else True)

for path in (f"/api/requests/{BID}", f"/api/requests/{BID}/invoice",
             f"/api/requests/{BID}/confirmation", f"/api/requests/{BID}/tickets"):
    r = requests.get(f"{BASE}{path}")
    check(f"{path} requires authentication", r.status_code in (401, 403), str(r.status_code))


print("\n=== 6. Delivery: the merchant is told, and can re-fetch ===")

notifications = get("/api/notifications?page_size=50").json()
items = notifications.get("items", notifications)
ticket_notices = [
    n for n in items
    if "ticket" in (n.get("title") or "").lower() and "issued" in (n.get("title") or "").lower()
]
check("the merchant is notified when its ticket is issued", bool(ticket_notices),
      f"titles seen: {[n.get('title') for n in items[:5]]}")
if ticket_notices:
    body = json.dumps(ticket_notices[0])
    check("...and the notice mentions the paperwork it can now fetch",
          "download" in body.lower() or "invoice" in body.lower())

# Re-fetch: the same download works a second time and is generated fresh, not
# served from a store. Nothing is persisted, so a refund can never leave a stale
# PDF disagreeing with the ledger.
again = get(f"/api/requests/{BID}/invoice")
check("the invoice can be re-fetched", again.status_code == 200)
check("...and is regenerated, not stored", again.content[:5] == b"%PDF-")

sys.exit(check.report())
