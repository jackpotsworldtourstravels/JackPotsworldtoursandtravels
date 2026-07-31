"""End-to-end API verification for the enquiry-led booking + documents work.

Runs against the live dev backend on 127.0.0.1:8000. Read-mostly except for the
rows it creates itself (one enquiry, its booking, its documents).
"""
import datetime
import json
import sys

import minihttp as requests
from config import ADMIN, BASE, JPEG, MERCHANT, PDF, PNG, Checker, H, login

_c = Checker()
check = _c


def main():
    print("== auth ==")
    mtok = login(*MERCHANT)
    atok = login(*ADMIN)
    check("merchant + admin sign in", bool(mtok and atok))

    today = datetime.date.today()
    travel = today + datetime.timedelta(days=45)

    # ---------------------------------------------------------------- enquiry
    print("\n== enquiry -> answered ==")
    r = requests.post(f"{BASE}/api/enquiries", headers=H(mtok), json={
        "trip_type": "one_way", "origin": "HYD", "origin_city": "Hyderabad",
        "destination": "DXB", "destination_city": "Dubai",
        "airline": "Emirates", "flight_number": "EK525",
        "travel_date": str(travel), "preferred_time": "09:30",
        "travel_class": "Economy", "passenger_count": 2, "adults": 2,
        "notes": "verification run",
    })
    check("create enquiry -> 201/200", r.status_code in (200, 201), f"{r.status_code} {r.text[:200]}")
    enq = r.json()
    eid = enq["id"]
    print(f"     enquiry {enq['reference_number']} (id {eid})")

    r = requests.post(f"{BASE}/api/admin/enquiries/{eid}/review", headers=H(atok))
    check("admin claims review", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # generic booking approve/reject must refuse an enquiry
    r = requests.post(f"{BASE}/api/admin/requests/{eid}/approve", headers=H(atok), json={})
    check("generic approve refuses an enquiry -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{BASE}/api/admin/requests/{eid}/reject", headers=H(atok), json={"reason": "no"})
    check("generic reject refuses an enquiry -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.post(f"{BASE}/api/admin/enquiries/{eid}/respond", headers=H(atok),
                      json={"available": True, "response": "Seats held at INR 24,500 all-in."})
    check("admin answers available", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    # ------------------------------------------------------- enquiry -> draft
    print("\n== enquiry -> draft booking ==")
    r = requests.post(f"{BASE}/api/enquiries/{eid}/booking-request", headers=H(mtok), json={
        "passengers": [
            {"title": "Mr", "first_name": "Arjun", "last_name": "Mehta", "passenger_type": "adult"},
            {"title": "Ms", "first_name": "Kavya", "last_name": "Rao", "passenger_type": "adult"},
        ],
        "contact": {"name": "Arjun Mehta", "email": "arjun@example.com", "phone": "+919812345678"},
        "international": True,
        "special_requests": "Seats together, one wheelchair at HYD.",
    })
    check("convert enquiry to draft", r.status_code in (200, 201), f"{r.status_code} {r.text[:300]}")
    req = r.json()
    rid = req["id"] if "id" in req else req["request"]["id"]
    print(f"     booking request id {rid}")

    r = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok))
    detail = r.json()
    td = detail["request"].get("details") or {}
    check("itinerary copied from enquiry", td.get("origin") == "HYD" and td.get("destination") == "DXB", json.dumps(td)[:300])
    check("contact stored on the draft", (td.get("contact") or {}).get("email") == "arjun@example.com", json.dumps(td)[:300])
    check("international flag stored", td.get("international") is True, json.dumps(td)[:300])
    check("special requests stored", "wheelchair" in (td.get("special_requests") or ""), json.dumps(td)[:300])
    check("enquiry reference carried over", td.get("enquiry_reference") == enq["reference_number"], json.dumps(td)[:300])
    check("pricing keeps its enquiry provenance",
          (detail["request"].get("pricing") or {}).get("source") == "ticket_enquiry",
          json.dumps(detail["request"].get("pricing"))[:200])
    check("detail response carries a documents list", isinstance(detail.get("documents"), list))
    pax = detail["request"]["passengers"]
    p1, p2 = pax[0]["id"], pax[1]["id"]

    # ---------------------------------------------- update_draft merge safety
    print("\n== update_draft merges, never replaces ==")
    r = requests.put(f"{BASE}/api/requests/{rid}", headers=H(mtok), json={
        "contact": {"name": "Arjun M", "email": "arjun2@example.com", "phone": "+919800000000"},
        "special_requests": "Bassinet for infant.",
    })
    check("update draft with contact -> 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    td = r.json()["request"].get("details") or {}
    check("update kept the locked itinerary", td.get("origin") == "HYD" and td.get("flight_number") == "EK525", json.dumps(td)[:300])
    check("update replaced the contact", (td.get("contact") or {}).get("email") == "arjun2@example.com")
    check("update kept the international flag", td.get("international") is True)

    # ---------------------------------------- passenger identity across saves
    print("\n== replace_passengers keeps identity (and documents) ==")
    RP = f"{BASE}/api/requests/{rid}/passengers"

    def pax_body(items):
        return {"passengers": items}

    r = requests.post(f"{BASE}/api/requests/{rid}/documents", headers=H(mtok),
                      files={"file": ("keepme.pdf", PDF, "application/pdf")},
                      data={"doc_type": "passport", "passenger_id": p1})
    check("attach a passport before editing passengers", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
    keep_doc = r.json()["id"]

    r = requests.put(RP, headers=H(mtok), json=pax_body([
        {"id": p1, "title": "Mr", "first_name": "Arjun", "last_name": "Mehta-Singh", "passenger_type": "adult"},
        {"id": p2, "title": "Ms", "first_name": "Kavya", "last_name": "Rao", "passenger_type": "adult"},
    ]))
    check("edit a passenger by id -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    ids_after = [p["id"] for p in r.json()]
    check("passenger ids are stable across an edit", ids_after == [p1, p2], f"{ids_after} vs {[p1, p2]}")
    check("the edit actually applied", r.json()[0]["last_name"] == "Mehta-Singh", r.text[:200])
    check("passenger order is preserved", ids_after == sorted(ids_after), str(ids_after))

    r = requests.get(f"{BASE}/api/documents/{keep_doc}/download", headers=H(mtok))
    check("the passport SURVIVED the passenger edit", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    r = requests.put(RP, headers=H(mtok), json=pax_body([
        {"id": 999999, "first_name": "Ghost", "last_name": "Rider", "passenger_type": "adult"}]))
    check("a foreign passenger id -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.put(RP, headers=H(mtok), json=pax_body([
        {"id": p1, "first_name": "A", "last_name": "B", "passenger_type": "adult"},
        {"id": p1, "first_name": "C", "last_name": "D", "passenger_type": "adult"}]))
    check("the same passenger twice -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    # a genuinely removed traveller loses their paperwork, which is correct
    r = requests.post(f"{BASE}/api/requests/{rid}/documents", headers=H(mtok),
                      files={"file": ("goner.pdf", PDF, "application/pdf")},
                      data={"doc_type": "passport", "passenger_id": p2})
    gone_doc = r.json()["id"] if r.status_code == 201 else None
    r = requests.put(RP, headers=H(mtok), json=pax_body([
        {"id": p1, "title": "Mr", "first_name": "Arjun", "last_name": "Mehta-Singh", "passenger_type": "adult"}]))
    check("drop a traveller -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("only the remaining traveller is left", [p["id"] for p in r.json()] == [p1], r.text[:200])
    r = requests.get(f"{BASE}/api/documents/{gone_doc}/download", headers=H(mtok))
    check("the dropped traveller's document is gone -> 404", r.status_code == 404, str(r.status_code))
    r = requests.get(f"{BASE}/api/documents/{keep_doc}/download", headers=H(mtok))
    check("the kept traveller's document is untouched", r.status_code == 200, str(r.status_code))

    # put the second traveller back for the rest of the run
    r = requests.put(RP, headers=H(mtok), json=pax_body([
        {"id": p1, "title": "Mr", "first_name": "Arjun", "last_name": "Mehta", "passenger_type": "adult"},
        {"title": "Ms", "first_name": "Kavya", "last_name": "Rao", "passenger_type": "adult"}]))
    check("add a traveller alongside an existing one -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    now = [p["id"] for p in r.json()]
    check("the existing traveller kept its id", now[0] == p1, str(now))
    p2 = now[1]

    # ------------------------------------------------------------- documents
    print("\n== document upload validation ==")
    U = f"{BASE}/api/requests/{rid}/documents"

    r = requests.post(U, headers=H(mtok), files={"file": ("a.txt", b"hello", "text/plain")}, data={"doc_type": "passport"})
    check("text/plain rejected -> 415", r.status_code == 415, f"{r.status_code} {r.text[:200]}")

    r = requests.post(U, headers=H(mtok), files={"file": ("fake.pdf", b"<html>x</html>", "application/pdf")}, data={"doc_type": "passport"})
    check("HTML renamed .pdf rejected -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    r = requests.post(U, headers=H(mtok), files={"file": ("empty.pdf", b"", "application/pdf")}, data={"doc_type": "passport"})
    check("empty file rejected -> 400/415", r.status_code in (400, 415), f"{r.status_code} {r.text[:200]}")

    big = b"%PDF-" + b"0" * (12 * 1024 * 1024)
    r = requests.post(U, headers=H(mtok), files={"file": ("big.pdf", big, "application/pdf")}, data={"doc_type": "passport"})
    check("oversize rejected -> 413", r.status_code == 413, f"{r.status_code} {r.text[:200]}")

    r = requests.post(U, headers=H(mtok), files={"file": ("p.pdf", PDF, "application/pdf")},
                      data={"doc_type": "passport", "passenger_id": 999999})
    check("foreign passenger_id rejected -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")

    print("\n== document upload / list / download / delete ==")
    r = requests.post(U, headers=H(mtok),
                      files={"file": ("../../../etc/passwd\r\nX: y.pdf", PDF, "application/pdf")},
                      data={"doc_type": "passport", "passenger_id": p1})
    check("valid passport upload -> 201", r.status_code == 201, f"{r.status_code} {r.text[:300]}")
    d1 = r.json()
    check("traversal + CRLF stripped from stored name",
          "/" not in d1["original_filename"] and "\r" not in d1["original_filename"] and ".." != d1["original_filename"][:2],
          repr(d1.get("original_filename")))
    check("size recorded", d1.get("size_bytes") == len(PDF), json.dumps(d1)[:300])
    check("stored_path never leaves the server", "stored_path" not in d1 and "checksum" not in d1, json.dumps(d1)[:300])
    check("starts unverified", d1.get("verification_status") in ("pending", "Pending"), json.dumps(d1)[:200])

    r = requests.post(U, headers=H(mtok), files={"file": ("kavya.png", PNG, "image/png")},
                      data={"doc_type": "passport", "passenger_id": p2})
    check("png passport upload -> 201", r.status_code == 201, f"{r.status_code} {r.text[:300]}")
    d2 = r.json()

    r = requests.post(U, headers=H(mtok), files={"file": ("visa.jpg", JPEG, "image/jpeg")}, data={"doc_type": "visa"})
    check("booking-level doc (no passenger) -> 201", r.status_code == 201, f"{r.status_code} {r.text[:300]}")
    d3 = r.json()

    r = requests.get(U, headers=H(mtok))
    listed = {d["id"] for d in r.json()} if r.status_code == 200 else set()
    check("list documents returns everything uploaded",
          r.status_code == 200 and {d1["id"], d2["id"], d3["id"]} <= listed, f"{r.status_code} {r.text[:200]}")
    n_before_delete = len(listed)

    r = requests.get(f"{BASE}/api/documents/{d1['id']}/download", headers=H(mtok))
    check("download -> 200 with bytes", r.status_code == 200 and r.content == PDF, f"{r.status_code} {len(r.content)}")
    cd = r.headers.get("content-disposition", "")
    check("served as attachment, not inline", cd.lower().startswith("attachment"), cd)
    check("Cache-Control private/no-store", "no-store" in r.headers.get("cache-control", ""), r.headers.get("cache-control"))
    check("no path leaked in headers", "requests/" not in cd and "uploads" not in cd.lower(), cd)

    r = requests.get(f"{BASE}/api/documents/{d1['id']}/download")
    check("download without a token -> 401/403", r.status_code in (401, 403), str(r.status_code))

    # admin can read it; merchant scope is enforced by query, tested via a bogus id
    r = requests.get(f"{BASE}/api/documents/99999999/download", headers=H(mtok))
    check("unknown document -> 404", r.status_code == 404, str(r.status_code))

    r = requests.get(f"{BASE}/api/documents/{d1['id']}/download", headers=H(atok))
    check("admin may download", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

    r = requests.delete(f"{BASE}/api/documents/{d3['id']}", headers=H(mtok))
    check("delete a draft document -> 204", r.status_code == 204, f"{r.status_code} {r.text[:200]}")
    r = requests.get(U, headers=H(mtok))
    check("list reflects the delete", len(r.json()) == n_before_delete - 1, f"{n_before_delete} -> {len(r.json())}")
    r = requests.get(f"{BASE}/api/documents/{d3['id']}/download", headers=H(mtok))
    check("deleted document is gone -> 404", r.status_code == 404, str(r.status_code))

    # --------------------------------------------------- submit validation
    print("\n== submit validation (enquiry-led only) ==")
    SUB = f"{BASE}/api/requests/{rid}/submit"

    # international, both passengers have a passport doc, but no passport numbers yet
    r = requests.post(SUB, headers=H(mtok))
    check("international without passport number -> 400", r.status_code == 400 and "passport number" in r.text, f"{r.status_code} {r.text[:250]}")

    # Passport numbers, sent the way the Classic screen sends them: with ids.
    def put_pax(expiry2):
        return requests.put(RP, headers=H(mtok), json={"passengers": [
            {"id": p1, "title": "Mr", "first_name": "Arjun", "last_name": "Mehta", "passenger_type": "adult",
             "passport_number": "Z1234567", "passport_expiry": str(travel + datetime.timedelta(days=400))},
            {"id": p2, "title": "Ms", "first_name": "Kavya", "last_name": "Rao", "passenger_type": "adult",
             "passport_number": "Z7654321", "passport_expiry": expiry2},
        ]})

    docs_before = len(requests.get(U, headers=H(mtok)).json())
    r = put_pax(str(travel - datetime.timedelta(days=5)))
    check("replace passengers -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    docs_after = len(requests.get(U, headers=H(mtok)).json())
    check("saving passengers does not destroy documents", docs_after == docs_before, f"{docs_before} -> {docs_after}")

    r = requests.post(SUB, headers=H(mtok))
    check("expired passport -> 400", r.status_code == 400 and "expires" in r.text, f"{r.status_code} {r.text[:250]}")

    r = put_pax(str(travel + datetime.timedelta(days=400)))
    check("fix the expiry -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")

    # Strip every passport document so the next rung is genuinely missing one.
    for d in requests.get(U, headers=H(mtok)).json():
        if d["doc_type"] == "passport":
            requests.delete(f"{BASE}/api/documents/{d['id']}", headers=H(mtok))
    r = requests.post(SUB, headers=H(mtok))
    check("missing passport document -> 400", r.status_code == 400 and "passport document" in r.text.lower(), f"{r.status_code} {r.text[:250]}")

    # Only one of the two travellers — the message must name the other.
    r = requests.post(U, headers=H(mtok), files={"file": ("pp1.pdf", PDF, "application/pdf")},
                      data={"doc_type": "passport", "passenger_id": p1})
    check("attach a passport for the first traveller", r.status_code == 201, f"{r.status_code} {r.text[:200]}")
    r = requests.post(SUB, headers=H(mtok))
    check("one passport short -> 400 naming the traveller",
          r.status_code == 400 and "Kavya" in r.text and "Arjun" not in r.text, f"{r.status_code} {r.text[:250]}")

    r = requests.post(U, headers=H(mtok), files={"file": ("pp2.pdf", PDF, "application/pdf")},
                      data={"doc_type": "passport", "passenger_id": p2})
    check("attach a passport for the second traveller", r.status_code == 201, f"{r.status_code} {r.text[:200]}")

    # blank the contact and confirm it is required
    requests.put(f"{BASE}/api/requests/{rid}", headers=H(mtok), json={"contact": {}})
    r = requests.post(SUB, headers=H(mtok))
    check("missing contact -> 400", r.status_code == 400 and "contact" in r.text.lower(), f"{r.status_code} {r.text[:250]}")
    requests.put(f"{BASE}/api/requests/{rid}", headers=H(mtok),
                 json={"contact": {"name": "Arjun M", "email": "arjun@example.com", "phone": "+919812345678"}})

    # The real UI saves passengers immediately before submitting. That exact
    # sequence is what the cascade used to break, so assert it directly.
    r = put_pax(str(travel + datetime.timedelta(days=400)))
    check("re-save passengers just before submitting -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    kept = [d for d in requests.get(U, headers=H(mtok)).json() if d["doc_type"] == "passport"]
    check("both passports still attached after that save", len(kept) == 2, str(len(kept)))

    r = requests.post(SUB, headers=H(mtok))
    check("complete international booking submits -> 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    st = r.json()["request"]["status"] if r.status_code == 200 else "?"
    check("submitted lands at pending_approval", st == "pending_approval", str(st))

    # ------------------------------------------------- post-submit immutability
    print("\n== documents are frozen after submit ==")
    r = requests.post(U, headers=H(mtok), files={"file": ("late.pdf", PDF, "application/pdf")}, data={"doc_type": "other"})
    check("upload after submit -> 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")
    r = requests.delete(f"{BASE}/api/documents/{d1['id']}", headers=H(mtok))
    check("delete after submit -> 409/404", r.status_code in (409, 404), f"{r.status_code} {r.text[:200]}")

    # --------------------------------------------------------- admin verify
    print("\n== admin document verification ==")
    docs = requests.get(U, headers=H(atok)).json()
    check("admin lists the documents", len(docs) >= 2, str(len(docs)))
    target = docs[0]["id"]
    r = requests.post(f"{BASE}/api/admin/documents/{target}/verify", headers=H(atok), json={"approved": False})
    check("reject without a reason -> 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    r = requests.post(f"{BASE}/api/admin/documents/{target}/verify", headers=H(atok),
                      json={"approved": False, "reason": "Scan is unreadable at the MRZ."})
    check("reject with a reason -> 200", r.status_code == 200 and r.json()["verification_status"] == "rejected", f"{r.status_code} {r.text[:250]}")
    check("rejection reason returned", "MRZ" in (r.json().get("rejection_reason") or ""), r.text[:200])
    r = requests.post(f"{BASE}/api/admin/documents/{target}/verify", headers=H(atok), json={"approved": True})
    check("approve -> 200 verified", r.status_code == 200 and r.json()["verification_status"] == "verified", f"{r.status_code} {r.text[:250]}")
    check("verifier name attached", bool(r.json().get("verified_by_name")), r.text[:250])
    check("rejecting a document did not reject the booking",
          requests.get(f"{BASE}/api/requests/{rid}", headers=H(atok)).json()["request"]["status"] != "rejected")

    r = requests.post(f"{BASE}/api/admin/documents/{target}/verify", headers=H(mtok), json={"approved": True})
    check("merchant cannot verify -> 403", r.status_code == 403, f"{r.status_code} {r.text[:200]}")

    # ------------------------------------------- catalog-led flow unaffected
    print("\n== catalog-led flow is unaffected ==")
    r = requests.get(f"{BASE}/api/catalog/search?page_size=5", headers=H(mtok))
    items = r.json().get("items", []) if r.status_code == 200 else []
    if not items:
        print("     (no catalog inventory available — skipped)")
    else:
        item = items[0]
        r = requests.post(f"{BASE}/api/requests", headers=H(mtok), json={
            "catalog_item_id": item["id"], "quantity": 1,
            "passengers": [{"first_name": "Cat", "last_name": "Legacy", "passenger_type": "adult"}],
        })
        check("create catalog-led draft", r.status_code in (200, 201), f"{r.status_code} {r.text[:250]}")
        if r.status_code in (200, 201):
            crid = r.json()["request"]["id"]
            before = r.json()["request"]["total_amount"]
            # No ids: the pre-documents contract, still delete-and-recreate.
            r = requests.put(f"{BASE}/api/requests/{crid}/passengers", headers=H(mtok), json={"passengers": [
                {"first_name": "Cat", "last_name": "Legacy", "passenger_type": "adult"},
                {"first_name": "Second", "last_name": "Seat", "passenger_type": "adult"}]})
            check("id-less replace still works (legacy callers)", r.status_code == 200 and len(r.json()) == 2, f"{r.status_code} {r.text[:250]}")
            after = requests.get(f"{BASE}/api/requests/{crid}", headers=H(mtok)).json()["request"]["total_amount"]
            check("catalog-led repricing still runs", after != before, f"{before} -> {after}")
            r = requests.post(f"{BASE}/api/requests/{crid}/submit", headers=H(mtok))
            check("catalog-led submits with no contact or documents", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
            requests.post(f"{BASE}/api/requests/{crid}/cancel", headers=H(mtok), json={"reason": "verification run"})

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
