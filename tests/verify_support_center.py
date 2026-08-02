"""Support Center verification — the merchant-facing support surface.

Covers what the redesign added on top of the existing live-chat threads:
categories, priority, the linked booking, real file attachments, search across
message bodies, read receipts, staff-only internal notes, admin triage, and
reopening a resolved conversation.

The security-relevant assertions here are deliberately made against raw JSON
rather than against anything a screen renders:

  * an internal note must not appear anywhere in a merchant's payload, and the
    notes endpoints must refuse a merchant outright;
  * a merchant must not be able to link its ticket to another company's
    booking, or read another company's thread;
  * a Super Admin holds chat.view alone — reading a thread must not mark it
    read, because a receipt is a claim that somebody who can *act* saw it.
"""
import sys

import flows
import minihttp as requests
from config import ADMIN, BASE, JPEG, MERCHANT, PDF, PNG, SUPER, Checker, H, login

_c = Checker()
check = _c

T = f"{BASE}/api/support/threads"


def _open(tok, subject, message, **extra):
    payload = {"subject": subject, "message": message}
    payload.update(extra)
    return requests.post(T, headers=H(tok), json=payload)


def main():
    print("== auth ==")
    mtok = login(*MERCHANT)
    atok = login(*ADMIN)
    stok = login(*SUPER)
    check("merchant, admin and super admin sign in", all([mtok, atok, stok]))

    # ------------------------------------------------- category and priority
    print("\n== category, priority, linked booking ==")
    booking = flows.make_booking(mtok, atok, upto="draft", label="support-center")
    booking_id = booking["id"]

    r = _open(mtok, "Wallet debited twice on a top-up", "The top-up shows twice on my ledger.",
              category="wallet", priority="high", related_request_id=booking_id)
    check("merchant opens a thread with category/priority/booking",
          r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    detail = r.json()
    thread = detail["thread"]
    tid = thread["id"]
    check("category comes back with a label",
          thread["category"] == "wallet" and thread["category_label"] == "Wallet", str(thread)[:200])
    check("priority is stored, not defaulted", thread["priority"] == "high", str(thread["priority"]))
    check("linked booking is resolved to its number",
          thread["related_request_id"] == booking_id and thread["related_request_number"],
          str(thread.get("related_request_number")))
    check("a new thread reports no attachments", thread["attachment_count"] == 0)
    check("an open thread cannot be reopened", thread["can_reopen"] is False)

    r = _open(mtok, "Bad category", "x", category="nonsense")
    check("an unknown category is refused -> 422", r.status_code == 422, f"{r.status_code} {r.text[:200]}")

    # Cross-tenant: a real booking that belongs to somebody else.
    rival = flows.rival_merchant(atok)
    rival_booking = flows.make_booking(rival["token"], atok, upto="draft", label="rival-support")
    r = _open(mtok, "Linking someone else's booking", "x", related_request_id=rival_booking["id"])
    check("linking another merchant's booking -> 404",
          r.status_code == 404, f"{r.status_code} {r.text[:200]}")

    r = requests.get(f"{T}/{tid}", headers=H(rival["token"]))
    check("another merchant cannot read the thread -> 404",
          r.status_code == 404, f"{r.status_code} {r.text[:200]}")

    # ------------------------------------------------------------ attachments
    print("\n== file sharing ==")
    r = requests.post(f"{T}/{tid}/documents", headers=H(mtok),
                      files={"file": ("ledger.pdf", PDF, "application/pdf")})
    check("merchant shares a PDF", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    after = r.json()
    check("the upload posts a line into the transcript",
          any("ledger.pdf" in (m.get("message") or "") for m in after["messages"]),
          str([m.get("message") for m in after["messages"]])[:250])
    check("the file is listed on the thread",
          len(after["documents"]) == 1 and after["documents"][0]["filename"] == "ledger.pdf",
          str(after["documents"])[:250])
    check("attachment_count tracks it", after["thread"]["attachment_count"] == 1)
    doc = after["documents"][0]
    check("the merchant's file is not marked staff", doc["is_staff"] is False)
    check("the stored path is never exposed", "stored_path" not in doc, str(list(doc)))

    r = requests.post(f"{T}/{tid}/documents", headers=H(mtok),
                      files={"file": ("notes.txt", b"hello", "text/plain")})
    check("an unaccepted type is refused -> 415", r.status_code == 415, f"{r.status_code} {r.text[:200]}")

    # The signature check is the one that matters: a declared type the bytes do
    # not match is what a stored-XSS payload looks like.
    r = requests.post(f"{T}/{tid}/documents", headers=H(mtok),
                      files={"file": ("fake.png", b"<html>not a png</html>", "image/png")})
    check("bytes that contradict the declared type -> 400",
          r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.get(f"{BASE}/api/documents/{doc['id']}/download", headers=H(mtok))
    check("the merchant can download its own attachment",
          r.status_code == 200 and r.content.startswith(b"%PDF"), f"{r.status_code}")
    r = requests.get(f"{BASE}/api/documents/{doc['id']}/download", headers=H(rival["token"]))
    check("another merchant cannot download it -> 404",
          r.status_code == 404, f"{r.status_code} {r.text[:200]}")

    # --------------------------------------------------------------- search
    print("\n== search and filters ==")
    r = requests.get(f"{T}?q=debited%20twice", headers=H(mtok))
    check("search matches the subject", r.status_code == 200 and
          any(i["id"] == tid for i in r.json()["items"]), r.text[:200])

    r = requests.get(f"{T}?q=shows%20twice%20on%20my%20ledger", headers=H(mtok))
    check("search matches text inside a MESSAGE, not just the subject",
          r.status_code == 200 and any(i["id"] == tid for i in r.json()["items"]), r.text[:250])

    r = requests.get(f"{T}?q=zzz-nothing-matches-this", headers=H(mtok))
    check("a term nobody said returns nothing", r.json()["total"] == 0, r.text[:200])

    r = requests.get(f"{T}?category=wallet", headers=H(mtok))
    check("category filter finds it", any(i["id"] == tid for i in r.json()["items"]))
    r = requests.get(f"{T}?category=refund", headers=H(mtok))
    check("a different category does not", not any(i["id"] == tid for i in r.json()["items"]))
    r = requests.get(f"{T}?priority=high", headers=H(mtok))
    check("priority filter finds it", any(i["id"] == tid for i in r.json()["items"]))

    # -------------------------------------------------------- read receipts
    print("\n== read receipts ==")
    thread_now = requests.get(f"{T}/{tid}", headers=H(mtok)).json()
    mine = [m for m in thread_now["messages"] if m["direction"] == "inbound"]
    check("the merchant's own messages start unread by the desk",
          all(m["is_read"] is False for m in mine), str([m["is_read"] for m in mine]))

    # A Super Admin holds chat.view only and cannot participate, so its read
    # must NOT produce a receipt.
    requests.get(f"{T}/{tid}", headers=H(stok))
    mine = [m for m in requests.get(f"{T}/{tid}", headers=H(mtok)).json()["messages"]
            if m["direction"] == "inbound"]
    check("a super admin reading does NOT mark the thread read",
          all(m["is_read"] is False for m in mine), str([m["is_read"] for m in mine]))

    # An explicit background fetch must not either.
    requests.get(f"{T}/{tid}?mark_read=false", headers=H(atok))
    mine = [m for m in requests.get(f"{T}/{tid}", headers=H(mtok)).json()["messages"]
            if m["direction"] == "inbound"]
    check("mark_read=false does not produce a receipt",
          all(m["is_read"] is False for m in mine), str([m["is_read"] for m in mine]))

    requests.get(f"{T}/{tid}", headers=H(atok))
    mine = [m for m in requests.get(f"{T}/{tid}", headers=H(mtok)).json()["messages"]
            if m["direction"] == "inbound"]
    check("an admin opening the thread DOES mark it read",
          all(m["is_read"] is True for m in mine), str([m["is_read"] for m in mine]))

    # ------------------------------------------------------- internal notes
    print("\n== internal notes ==")
    r = requests.post(f"{T}/{tid}/notes", headers=H(atok),
                      json={"body": "Ledger checked — duplicate is the gateway's retry."})
    check("admin adds an internal note", r.status_code == 201, f"{r.status_code} {r.text[:250]}")

    r = requests.get(f"{T}/{tid}/notes", headers=H(atok))
    check("admin reads the notes", r.status_code == 200 and len(r.json()) >= 1, r.text[:200])
    check("the note carries its author", bool(r.json()[0].get("author")), r.text[:200])

    r = requests.get(f"{T}/{tid}/notes", headers=H(mtok))
    check("a merchant cannot read internal notes -> 403",
          r.status_code == 403, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{T}/{tid}/notes", headers=H(mtok), json={"body": "let me in"})
    check("a merchant cannot write an internal note -> 403",
          r.status_code == 403, f"{r.status_code} {r.text[:200]}")
    r = requests.get(f"{T}/{tid}/notes", headers=H(stok))
    check("a super admin cannot read internal notes either -> 403",
          r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    # The real test: the note body must not leak into ANY merchant response.
    body = requests.get(f"{T}/{tid}", headers=H(mtok)).text
    check("the note body is absent from the merchant's thread payload",
          "gateway's retry" not in body and "Ledger checked" not in body, body[:300])
    listing = requests.get(f"{T}?page_size=100", headers=H(mtok)).text
    check("and from the merchant's thread list", "Ledger checked" not in listing)

    # -------------------------------------------------------------- triage
    print("\n== triage ==")
    r = requests.patch(f"{T}/{tid}/triage", headers=H(atok),
                       json={"priority": "urgent", "category": "payment"})
    check("admin re-files priority and category", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    t2 = r.json()
    check("priority changed", t2["priority"] == "urgent", str(t2["priority"]))
    check("category changed", t2["category"] == "payment", str(t2["category"]))

    r = requests.patch(f"{T}/{tid}/triage", headers=H(atok), json={"priority": "low"})
    check("an omitted category is left alone, not cleared",
          r.json()["category"] == "payment", str(r.json()["category"]))

    r = requests.patch(f"{T}/{tid}/triage", headers=H(mtok), json={"priority": "urgent"})
    check("a merchant cannot triage -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")
    r = requests.patch(f"{T}/{tid}/triage", headers=H(stok), json={"priority": "urgent"})
    check("a super admin cannot triage -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    # -------------------------------------------------------------- reopen
    print("\n== resolve and reopen ==")
    r = requests.post(f"{T}/{tid}/reopen", headers=H(mtok))
    check("an open thread cannot be reopened -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.post(f"{T}/{tid}/resolve", headers=H(atok))
    check("admin resolves the thread", r.status_code == 200, f"{r.status_code} {r.text[:250]}")

    got = requests.get(f"{T}/{tid}", headers=H(mtok)).json()["thread"]
    check("a freshly resolved thread reports can_reopen", got["can_reopen"] is True, str(got["can_reopen"]))

    r = requests.post(f"{T}/{tid}/messages", headers=H(mtok), json={"message": "still broken"})
    check("a resolved thread refuses new messages -> 400",
          r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{T}/{tid}/documents", headers=H(mtok),
                      files={"file": ("more.png", PNG, "image/png")})
    check("a resolved thread refuses attachments too -> 400",
          r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.post(f"{T}/{tid}/reopen", headers=H(mtok))
    check("merchant reopens it", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("it returns to the unclaimed queue", r.json()["status"] == "submitted", str(r.json()["status"]))

    r = requests.post(f"{T}/{tid}/messages", headers=H(mtok), json={"message": "thanks, continuing here"})
    check("and can be talked in again", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # ------------------------------------------------- staff side attachment
    print("\n== staff attachments ==")
    r = requests.post(f"{T}/{tid}/documents", headers=H(atok),
                      files={"file": ("resolution.jpg", JPEG, "image/jpeg")})
    check("admin shares a file back", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    docs = r.json()["documents"]
    staff_doc = next((d for d in docs if d["filename"] == "resolution.jpg"), None)
    check("it is tagged as the staff side", staff_doc and staff_doc["is_staff"] is True, str(staff_doc))
    check("the merchant can see both files", len(docs) == 2, str([d["filename"] for d in docs]))

    r = requests.post(f"{T}/{tid}/documents", headers=H(stok),
                      files={"file": ("nope.png", PNG, "image/png")})
    check("a super admin cannot attach -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
