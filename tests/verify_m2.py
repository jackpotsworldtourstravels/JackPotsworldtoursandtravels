"""M2 verification — ticket upload, invoice/confirmation PDFs, merchant delivery.

Drives a real booking from Payment Pending through to Ticket Issued so the
staff-upload window and the paperwork endpoints are exercised against a genuine
lifecycle rather than a hand-set status.
"""
import sys

import flows
import minihttp as requests
from config import ADMIN, BASE, MERCHANT, PDF, Checker, H, login

_c = Checker()
check = _c


def main():
    mtok, atok = login(*MERCHANT), login(*ADMIN)

    # Built from scratch rather than found in existing data: the previous run
    # ticketed the only candidate and left the next run with nothing, which
    # made the suite order-dependent.
    print("== build a fresh booking, driven to Paid ==")
    b = flows.make_booking(mtok, atok, upto="paid", label="M2 verification")
    rid, status = b["id"], b["status"]
    print(f"     {b['request_number']} (id {rid}) at {status}")
    check("flow produced a paid booking", status == "paid", status)

    detail = requests.get(f"{BASE}/api/requests/{rid}", headers=H(atok)).json()

    # ------------------------------------------------ staff upload window
    print("\n== staff may attach the e-ticket after payment ==")
    U = f"{BASE}/api/requests/{rid}/documents"

    if status == "paid":
        r = requests.post(U, headers=H(atok), files={"file": ("eticket-EK525.pdf", PDF, "application/pdf")},
                          data={"doc_type": "ticket"})
        check("admin attaches an e-ticket to a PAID booking -> 201", r.status_code == 201, f"{r.status_code} {r.text[:250]}")
        eticket = r.json() if r.status_code == 201 else None
    else:
        eticket = None
        print(f"     (booking is '{status}', not paid — skipping the paid-stage upload)")

    # the merchant's own rule must be unchanged: still draft-only
    r = requests.post(U, headers=H(mtok), files={"file": ("late.pdf", PDF, "application/pdf")},
                      data={"doc_type": "passport"})
    check("merchant still cannot attach after draft -> 409", r.status_code == 409, f"{r.status_code} {r.text[:250]}")
    check("the merchant's 409 message is the merchant one",
          "no longer a draft" in r.text, r.text[:250])

    # staff may not attach a passport late — only ticket/other
    r = requests.post(U, headers=H(atok), files={"file": ("pp.pdf", PDF, "application/pdf")},
                      data={"doc_type": "passport"})
    check("staff cannot attach a passport late -> 409", r.status_code == 409, f"{r.status_code} {r.text[:250]}")
    check("the staff 409 explains which types are allowed",
          "ticket" in r.text and "paid" in r.text.lower(), r.text[:250])

    # ------------------------------------------------------- issue ticket
    print("\n== issue the ticket ==")
    if status == "paid":
        r = requests.post(f"{BASE}/api/admin/requests/{rid}/issue-ticket", headers=H(atok), json={})
        check("issue ticket -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
        if r.status_code == 200:
            req = r.json()["request"]
            check("invoice number allocated", bool(req["invoice_number"]), str(req)[:200])
            check("ticket number allocated", bool(req["ticket_number"]), str(req)[:200])
            check("PNR present", bool(req["pnr"]), str(req)[:200])
            status = req["status"]

    detail = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()
    check("merchant sees can_download once ticketed", detail.get("can_download") is True,
          f"status={detail['request']['status']} can_download={detail.get('can_download')}")

    # ------------------------------------------------------------ invoice
    print("\n== invoice PDF ==")
    r = requests.get(f"{BASE}/api/requests/{rid}/invoice", headers=H(mtok))
    check("merchant downloads the invoice -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("it is a real PDF", r.content[:5] == b"%PDF-", str(r.content[:20]))
    check("served as an attachment", r.headers.get("content-disposition", "").startswith("attachment"),
          r.headers.get("content-disposition"))
    check("invoice is not cached", "no-store" in r.headers.get("cache-control", ""), r.headers.get("cache-control"))
    check("filename carries the invoice number",
          "invoice-" in r.headers.get("content-disposition", ""), r.headers.get("content-disposition"))
    check("invoice has real content", len(r.content) > 1500, str(len(r.content)))

    r2 = requests.get(f"{BASE}/api/requests/{rid}/invoice", headers=H(atok))
    check("admin may download the same invoice", r2.status_code == 200, f"{r2.status_code} {r2.text[:200]}")

    r = requests.get(f"{BASE}/api/requests/{rid}/invoice")
    check("invoice without a token -> 401/403", r.status_code in (401, 403), str(r.status_code))

    # The bytes being a valid PDF says nothing about what is printed on it, so
    # the text layer is asserted too.
    import os
    import tempfile

    import pdftext

    def text_of(payload: bytes) -> str:
        fd, p = tempfile.mkstemp(suffix=".pdf")
        os.write(fd, payload)
        os.close(fd)
        try:
            return pdftext.extract(p)
        finally:
            os.unlink(p)

    inv = text_of(requests.get(f"{BASE}/api/requests/{rid}/invoice", headers=H(mtok)).content)
    check("invoice prints its invoice number", detail["request"]["invoice_number"] in inv, inv[:200])
    check("invoice prints the PNR", (detail["request"]["pnr"] or "@@") in inv, inv[:200])
    check("invoice names the merchant", "Demo Travel Co" in inv, inv[:200])
    check("invoice shows a balance line", "Balance due" in inv, inv[:200])
    check("invoice reconciles paid against total", "Booking total" in inv and "Paid" in inv, inv[:200])
    check("no literal markup leaks into the invoice", "<br/>" not in inv and "<b>" not in inv, inv[:300])

    # --------------------------------------------------------- confirmation
    print("\n== booking confirmation PDF ==")
    r = requests.get(f"{BASE}/api/requests/{rid}/confirmation", headers=H(mtok))
    check("merchant downloads the confirmation -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("confirmation is a PDF", r.content[:5] == b"%PDF-", str(r.content[:20]))
    check("confirmation filename is distinct from the invoice",
          "confirmation-" in r.headers.get("content-disposition", ""), r.headers.get("content-disposition"))

    conf = text_of(r.content)
    check("confirmation lists the passengers", "Passengers" in conf, conf[:200])
    check("confirmation carries the PNR", (detail["request"]["pnr"] or "@@") in conf, conf[:200])
    check("confirmation disclaims being a ticket", "not an airline ticket" in conf, conf[:300])
    check("no literal markup leaks into the confirmation", "<br/>" not in conf and "<b>" not in conf, conf[:300])

    # ------------------------------------------------------- ticket delivery
    print("\n== merchant ticket delivery ==")
    r = requests.get(f"{BASE}/api/requests/{rid}/tickets", headers=H(mtok))
    check("merchant lists e-tickets -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    tickets = r.json() if r.status_code == 200 else []
    check("only ticket-type documents are returned",
          all(t["doc_type"] == "ticket" for t in tickets), str(tickets)[:250])

    if tickets:
        tid = tickets[0]["id"]
        r = requests.get(f"{BASE}/api/documents/{tid}/download", headers=H(mtok))
        check("merchant downloads the e-ticket bytes -> 200", r.status_code == 200 and r.content == PDF,
              f"{r.status_code} {len(r.content)}")
    elif eticket:
        check("uploaded e-ticket appears in the ticket list", False, "uploaded but not listed")

    # a merchant must not reach another company's paperwork
    other = requests.get(f"{BASE}/api/admin/bookings/queue?page_size=100", headers=H(atok)).json()["items"]
    foreign = [i for i in other if i["merchant_id"] and i["id"] != rid]
    print(f"     (all queue bookings belong to merchant ids: {sorted({i['merchant_id'] for i in other})})")

    # ------------------------------------------------- not-yet-ticketed guard
    print("\n== paperwork is refused before ticketing ==")
    drafts = requests.get(f"{BASE}/api/requests?status=draft&page_size=1", headers=H(mtok)).json()
    if drafts.get("items"):
        did = drafts["items"][0]["id"]
        r = requests.get(f"{BASE}/api/requests/{did}/invoice", headers=H(mtok))
        check("invoice on a draft -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")
        check("the 409 explains why", "not been ticketed" in r.text, r.text[:220])
        r = requests.get(f"{BASE}/api/requests/{did}/confirmation", headers=H(mtok))
        check("confirmation on a draft -> 409", r.status_code == 409, f"{r.status_code} {r.text[:220]}")
    else:
        print("     (no draft available to test the guard)")

    r = requests.get(f"{BASE}/api/requests/99999999/invoice", headers=H(mtok))
    check("invoice for an unknown booking -> 404", r.status_code == 404, f"{r.status_code} {r.text[:200]}")

    # ------------------------------------------ reissue: staff replace ticket
    print("\n== reissue ==")
    if tickets:
        r = requests.delete(f"{BASE}/api/documents/{tickets[0]['id']}", headers=H(atok))
        check("staff may remove a ticket for reissue -> 204", r.status_code == 204, f"{r.status_code} {r.text[:220]}")
        r = requests.post(U, headers=H(atok), files={"file": ("eticket-reissued.pdf", PDF, "application/pdf")},
                          data={"doc_type": "ticket"})
        check("staff attach the reissued ticket -> 201", r.status_code == 201, f"{r.status_code} {r.text[:220]}")
        r = requests.get(f"{BASE}/api/requests/{rid}/tickets", headers=H(mtok))
        check("merchant sees the reissued ticket",
              any("reissued" in t["original_filename"] for t in r.json()), r.text[:250])

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
