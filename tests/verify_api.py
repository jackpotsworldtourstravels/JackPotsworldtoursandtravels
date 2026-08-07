"""End-to-end API verification for the enquiry-led booking + documents work.

Runs against the live dev backend on 127.0.0.1:8000. Read-mostly except for the
rows it creates itself (one enquiry, its booking, its documents).
"""
import datetime
import json
import sys

import minihttp as requests
from config import ADMIN, BASE, JPEG, MANAGER, MERCHANT, PDF, PNG, Checker, H, login

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

    # CR-5 rewrote this call. The answer used to be a bare `available: true`;
    # it is now a quotation, and the two new fields are required by the schema.
    r = requests.post(f"{BASE}/api/admin/enquiries/{eid}/respond", headers=H(atok),
                      json={"available": True, "response": "Seats held.",
                            "total_fare": "24500.00",
                            "reason": "INR 21,500 fare + INR 3,000 baggage."})
    check("admin sends a quotation", r.status_code == 200, f"{r.status_code} {r.text[:200]}")

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
    # The suggested save-name is built by hand now that downloads stream (an S3
    # object has no path for FileResponse to take), so check it still arrives.
    check("the display filename is offered to the browser",
          d1["original_filename"] in cd, cd)

    r = requests.get(f"{BASE}/api/documents/{d2['id']}/download", headers=H(mtok))
    check("a png document downloads with its own type",
          r.status_code == 200 and r.content == PNG
          and r.headers.get("content-type", "").startswith("image/png"),
          f"{r.status_code} {r.headers.get('content-type')}")
    check("Content-Length matches the stored size",
          r.headers.get("content-length") == str(len(PNG)), r.headers.get("content-length"))

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

    # DOCUMENTS ARE NOT A PRECONDITION OF SUBMITTING (changed 2026-07-31).
    # This used to be the opposite assertion: an international booking whose
    # travellers had no passport scan was refused, and the refusal named the
    # traveller still missing one. Documents were then removed from the Classic
    # merchant workflow, so that rule went with them — a merchant fills in the
    # travellers and submits, and nothing about a file may stand in the way.
    #
    # Arjun's passport is dropped here and deliberately not replaced, so this
    # booking reaches submit with one traveller covered and one not. Under the
    # old rule that was a 400 naming Arjun. Kavya's stays attached so the admin
    # verification section below still has a real document to act on — the
    # upload API is fully supported, just no longer required.
    # Every one of Arjun's, not just d1 — the identity section above attached
    # him a second passport, and leaving it would mean he was still covered and
    # this would prove nothing.
    def passport_coverage():
        return {d["passenger_id"] for d in requests.get(U, headers=H(mtok)).json()
                if d["doc_type"] == "passport"}

    for d in requests.get(U, headers=H(mtok)).json():
        if d["doc_type"] == "passport" and d["passenger_id"] == p1:
            r = requests.delete(f"{BASE}/api/documents/{d['id']}", headers=H(mtok))
            check("drop one of that traveller's passports -> 204", r.status_code == 204,
                  f"{r.status_code} {r.text[:200]}")
    check("one traveller now has no passport document at all",
          p1 not in passport_coverage() and p2 in passport_coverage(), str(passport_coverage()))

    # THE CONTACT IS OPTIONAL (2026-08-07). This used to blank the contact,
    # submit, and expect a 400 — while the merchant form described the panel as
    # optional and promised to fall back to the account's details. The rule was
    # removed rather than the promise.
    #
    # NOT re-asserted by submitting THIS booking. The old check relied on the
    # refusal leaving the request a draft; now that a blank contact is accepted,
    # submitting here would carry `rid` out of draft and every step below —
    # which is the passenger-cascade sequence this script exists for — would
    # fail on a request it can no longer edit. The acceptance is proved on a
    # throwaway booking in verify_direct_booking.py instead. All that is checked
    # here is that a blank contact still SAVES, which is the state the old
    # refusal made unreachable.
    r = requests.put(f"{BASE}/api/requests/{rid}", headers=H(mtok), json={"contact": {}})
    check("a booking may hold no contact at all", r.status_code == 200,
          f"{r.status_code} {r.text[:250]}")
    requests.put(f"{BASE}/api/requests/{rid}", headers=H(mtok),
                 json={"contact": {"name": "Arjun M", "email": "arjun@example.com", "phone": "+919812345678"}})

    # The real UI saves passengers immediately before submitting. That exact
    # sequence is what the cascade used to break, so assert it directly.
    r = put_pax(str(travel + datetime.timedelta(days=400)))
    check("re-save passengers just before submitting -> 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("the other traveller's passport survived that save",
          passport_coverage() == {p2}, str(passport_coverage()))

    r = requests.post(SUB, headers=H(mtok))
    check("international booking submits with a traveller's passport missing -> 200",
          r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    st = r.json()["request"]["status"] if r.status_code == 200 else "?"
    check("submitted lands at pending_approval", st == "pending_approval", str(st))

    # ------------------------------------------------- post-submit immutability
    print("\n== documents are frozen after submit ==")
    r = requests.post(U, headers=H(mtok), files={"file": ("late.pdf", PDF, "application/pdf")}, data={"doc_type": "other"})
    check("upload after submit -> 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")
    # d2, not d1 — d1 was dropped before submit, so deleting it would 404 for a
    # reason that has nothing to do with the booking having left draft.
    r = requests.delete(f"{BASE}/api/documents/{d2['id']}", headers=H(mtok))
    check("delete after submit -> 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")

    # ------------------------------ an enquiry-led booking with NO documents
    # The headline of the 2026-07-31 change, asserted on its own booking rather
    # than inferred from the one above: a merchant that never opens a document
    # endpoint can still take an international sector all the way to the desk.
    print("\n== a booking that never touches a document endpoint ==")
    r = requests.post(f"{BASE}/api/enquiries", headers=H(mtok), json={
        "trip_type": "one_way", "origin": "BOM", "origin_city": "Mumbai",
        "destination": "SIN", "destination_city": "Singapore",
        "airline": "Singapore Airlines", "flight_number": "SQ423",
        "travel_date": str(travel), "preferred_time": "01:30",
        "travel_class": "Economy", "passenger_count": 1, "adults": 1,
    })
    eid2 = r.json()["id"]
    requests.post(f"{BASE}/api/admin/enquiries/{eid2}/review", headers=H(atok))
    requests.post(f"{BASE}/api/admin/enquiries/{eid2}/respond", headers=H(atok),
                  json={"available": True, "total_fare": "48000.00",
                        "reason": "Return fare, taxes included."})
    r = requests.post(f"{BASE}/api/enquiries/{eid2}/booking-request", headers=H(mtok), json={
        "passengers": [{"title": "Mr", "first_name": "Nikhil", "last_name": "Bose",
                        "passenger_type": "adult", "passport_number": "M9988776",
                        "passport_expiry": str(travel + datetime.timedelta(days=500))}],
        "contact": {"name": "Nikhil Bose", "email": "nikhil@example.com", "phone": "+919700000000"},
        "international": True,
    })
    check("draft created in a single call", r.status_code in (200, 201), f"{r.status_code} {r.text[:250]}")
    rid2 = r.json()["id"]
    check("it genuinely has no documents",
          requests.get(f"{BASE}/api/requests/{rid2}/documents", headers=H(mtok)).json() == [])
    r = requests.post(f"{BASE}/api/requests/{rid2}/submit", headers=H(mtok))
    check("international submit with zero documents -> 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
    check("no refusal ever mentions uploading",
          "upload" not in r.text.lower(), r.text[:200])
    # CR-2 moved this booking's approval from the Admin to the Manager. It must
    # reach the Manager's desk and must NOT sit in the Admin's approval queue —
    # a queue that offered Approve on a booking the service refuses by track
    # would be worse than not listing it at all.
    gtok = login(*MANAGER)
    mgr = requests.get(f"{BASE}/api/manager/bookings/{rid2}", headers=H(gtok))
    check("the manager can open it", mgr.status_code == 200, f"{mgr.status_code} {mgr.text[:200]}")
    number = mgr.json()["request"]["request_number"]
    # Searched by number rather than read off page 1: the queue is oldest-first
    # (it is a work queue), so the booking just created is the last thing on it.
    check("it reaches the manager's queue",
          any(i["id"] == rid2 for i in requests.get(
              f"{BASE}/api/manager/bookings?search={number}", headers=H(gtok)).json()["items"]))
    check("and not the admin approval queue",
          not any(i["id"] == rid2 and i.get("kind") == "request" for i in requests.get(
              f"{BASE}/api/admin/approval-queue?page_size=100", headers=H(atok)).json()["items"]))

    # --------------------------------------------------------- admin verify
    print("\n== admin document verification ==")
    docs = requests.get(U, headers=H(atok)).json()
    check("admin lists the documents", len(docs) >= 1, str(len(docs)))
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
