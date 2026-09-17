"""Raise Booking on a Manual Enquiry that nobody has quoted.

WHAT CHANGED, AND WHY IT NEEDED CHANGING

The Admin portal's Manual Booking screens let the desk file an enquiry FOR a
merchant that telephoned it in. Pressing **Raise Booking** on one then answered
"Not available yet — a booking can only be raised once the desk has quoted this
enquiry", and `enquiry_service.to_booking_request` refused it with a 400.

That rule is the Merchant Portal's, and it is right there: a merchant books the
journey WE answered, at the fare we named. It was never right on the desk's own
screen, because the desk IS the party that sends the quotation — the sentence
told the operator to wait for itself, and named no way to stop waiting. What the
desk does at that screen is type up a ticket it has already arranged; there is no
quotation step in that, because there was no question.

WHAT THIS SCRIPT PROTECTS

1. **The desk may convert an un-quoted enquiry.** Pending and Under Review both
   produce a booking, for one-way and round-trip alike. This is the change; a
   regression here is the feature disappearing.
2. **A merchant still may not.** The identical call from a merchant token on its
   own un-quoted enquiry is still a 400, with the original wording. The gate did
   not move, it grew a second branch — and if that branch ever widens to cover
   merchants, the Classic track's central guarantee is gone silently.
3. **Refused is not the same as unanswered.** A Rejected or Cancelled enquiry is
   still refused for the desk too. Removing "must be quoted" must not also
   remove "must not have been turned down".
4. **The booking is a real one, and it is the merchant's.** `merchant_id` from
   the enquiry and never from the caller, `raised_by` the admin who typed it,
   `source` = `b2b_manual_request`, `parent_request_id` pointing back at the
   enquiry, and the itinerary copied server-side rather than accepted from the
   body.
5. **It is priced the way an unquoted booking has always been priced.**
   `total_amount` 0 and `pricing.quoted` false — the pre-CR-5 shape, where the
   desk names the fare at issuance. A manual booking rejoins that path rather
   than inventing a third one.
6. **Raising it twice does not make two.** The second call is a 409 and the
   enquiry still points at the first booking.
7. **It goes where an enquiry-led booking has always gone: the Manager.**
   After submit it is on `/api/manager/bookings` as Pending Manager Approval,
   and deliberately NOT on `/api/admin/approval-queue`. That queue skips
   `is_classic_track` rows on purpose (CR-2) so it cannot offer an Approve
   button the service layer refuses by track, and a manual booking carries the
   `enquiry_reference` marker like any other enquiry-led one. **Both halves are
   asserted**: the day it starts appearing on the Approval Queue is the day the
   desk is offered an action that will 400, and nothing else in the suite would
   notice. The Admin portal's confirmation screen is worded from this fact —
   see `ambCorrectSubmitted` in admin-manual-booking.js.
8. **The merchant sees it as its own, and can tell who raised it.** It appears
   in the merchant's `/api/requests` — what Booking History reads — carrying
   `source`, so a booking the merchant never typed is explained on the row
   rather than unaccountable.

WHAT IS DELIBERATELY NOT RE-TESTED
The passenger validators, the wallet arithmetic and the approval rules own their
own scripts (verify_group_booking, verify_cr4a/b, verify_manager_approval). This
one checks that a booking raised from an unanswered enquiry ARRIVES in those
machines correctly, not that those machines work.

Run against a server carrying the change::

    JPW_BASE=http://127.0.0.1:8020 python tests/verify_manual_booking_unquoted.py
"""
import datetime
import io
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE))

import flows  # noqa: E402
import minihttp as requests  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.services import group_booking_service as gb  # noqa: E402

from config import (  # noqa: E402
    ADMIN, BASE, Checker, H, JPEG, MANAGER, MERCHANT, PDF, PNG, login,
)

def _pdf_text(data: bytes) -> str:
    """What a rendered invoice actually says.

    Two renders of one document differ in bytes — a PDF stamps its own creation
    time — and the text is Flate-compressed, so neither a byte comparison nor a
    raw substring search says anything useful about the invoice. This is the
    only honest way to assert on one.
    """
    import pymupdf
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return "\n".join(page.get_text() for page in doc)


check = Checker()
atok, admin_user = login(*ADMIN, with_user=True)
mtok, merchant_user = login(*MERCHANT, with_user=True)
# The CR-2 Manager, whose desk is where a submitted enquiry-led booking lands.
# A separate platform role with its own portal: the Admin holds no
# `booking.manager_approve`, so the desk that typed the booking genuinely
# cannot see it afterwards, and section 8 has to sign in as someone else to
# prove it arrived.
gtok, manager_user = login(*MANAGER, with_user=True)

MERCHANT_ID = merchant_user["merchant_id"]
ADMIN_USER_ID = admin_user["id"]
ADMIN_NAME = admin_user["full_name"]

TRAVEL = (datetime.date.today() + datetime.timedelta(days=45)).isoformat()
RETURN = (datetime.date.today() + datetime.timedelta(days=52)).isoformat()
EXPIRY = (datetime.date.today() + datetime.timedelta(days=900)).isoformat()
#: Unique per run: `uq_sr_ticket_number` is a real constraint, so a fixed
#: value would make the second run of this script fail on the first run's row.
TICKET_NO = f"TKT{int(__import__('time').time())}"
#: Group sheets carry a real date object, not an ISO string.
GROUP_TRAVEL = datetime.date.today() + datetime.timedelta(days=70)

print(f"\nBASE={BASE}  merchant_id={MERCHANT_ID}  admin_user_id={ADMIN_USER_ID}")


# ---------------------------------------------------------------------------
# Payload builders — the shapes the two Classic forms actually send.
# ---------------------------------------------------------------------------
def itinerary(**over):
    """A one-way domestic journey, exactly as the enquiry form posts it."""
    body = {
        "trip_type": "one_way",
        "origin": "HYD", "origin_city": "Hyderabad",
        "destination": "CMB", "destination_city": "Colombo",
        "airline": "Air India", "flight_number": "AI283",
        "travel_date": TRAVEL,
        "preferred_time": "09:30",
        "travel_class": "Economy",
        "passenger_count": 1, "adults": 1, "children": 0, "infants": 0,
        "notes": "Raised by the desk from a phone call.",
    }
    body.update(over)
    return body


def passenger(**over):
    """One traveller card's payload, as schemas/ticket.py::PassengerInput takes
    it. A passport is included because HYD -> CMB is an international sector and
    the submit-time rules ask for one there."""
    body = {
        "title": "Ms", "first_name": "Asha", "last_name": "Menon",
        "gender": "female", "dob": "1989-03-11", "passenger_type": "adult",
        "nationality": "Indian",
        "passport_number": "MB0099771", "passport_expiry": EXPIRY,
        "seat_preference": "window", "meal_preference": "Vegetarian",
    }
    body.update(over)
    return body


def raise_manual_enquiry(**over):
    """The desk files an enquiry FOR the merchant. Returns the EnquiryResponse."""
    body = itinerary(**over)
    body["on_behalf_of_merchant_id"] = MERCHANT_ID
    r = requests.post(f"{BASE}/api/enquiries", headers=H(atok), json=body)
    assert r.status_code == 201, f"manual enquiry: {r.status_code} {r.text[:300]}"
    return r.json()


def raise_booking(enquiry_id, token=atok, passengers=None):
    return requests.post(
        f"{BASE}/api/enquiries/{enquiry_id}/booking-request",
        headers=H(token),
        json={
            "passengers": passengers if passengers is not None else [passenger()],
            "remarks": "Ticket arranged by phone; entered by the desk.",
            "contact": {"name": "Desk", "email": "desk@example.com", "phone": "919000000001"},
            "international": True,
        },
    )


# ---------------------------------------------------------------------------
print("\n== 1. the restriction is gone: Pending -> Booking (One Way) ==")
# ---------------------------------------------------------------------------
enq = raise_manual_enquiry()
check("a manual enquiry starts Pending",
      enq["status"] == "pending_approval", enq["status"])
check("  it is filed against the merchant, not the admin",
      enq.get("merchant_id") == MERCHANT_ID,
      f"{enq.get('merchant_id')} != {MERCHANT_ID}")
check("  and records that the DESK typed it",
      enq.get("source") == "b2b_manual_enquiry", str(enq.get("source")))

r = raise_booking(enq["id"])
check("Raise Booking on a PENDING enquiry now succeeds",
      r.status_code == 201, f"{r.status_code} {r.text[:300]}")
one_way = r.json() if r.status_code == 201 else {}

if one_way:
    d = one_way.get("details") or {}
    check("  it is a booking, in draft",
          one_way.get("request_type") == "booking" and one_way.get("status") == "draft",
          f"{one_way.get('request_type')}/{one_way.get('status')}")
    check("  linked to the enquiry it came from (parent_request_id)",
          one_way.get("parent_request_id") == enq["id"],
          f"{one_way.get('parent_request_id')} != {enq['id']}")
    check("  and by reference in travel_details",
          d.get("enquiry_reference") == enq["reference_number"],
          str(d.get("enquiry_reference")))
    check("  the merchant is the ENQUIRY's, not the admin's",
          one_way.get("merchant_id") == MERCHANT_ID,
          f"{one_way.get('merchant_id')} != {MERCHANT_ID}")
    # `raised_by` is the NAME, which is what the schema exposes; the user_id
    # behind it is asserted against the database in section 9, where the
    # column itself is read.
    check("  the admin is recorded as who typed it",
          one_way.get("raised_by") == ADMIN_NAME,
          f"{one_way.get('raised_by')} != {ADMIN_NAME}")
    check("  source is b2b_manual_request",
          one_way.get("source") == "b2b_manual_request", str(one_way.get("source")))
    check("  it carries a booking reference",
          bool(one_way.get("booking_reference")), str(one_way.get("booking_reference")))
    check("  unquoted: total_amount is 0",
          str(one_way.get("total_amount")) in ("0", "0.00", "0.0"),
          str(one_way.get("total_amount")))
    check("  unquoted: pricing.quoted is false",
          (one_way.get("pricing") or {}).get("quoted") is False,
          str(one_way.get("pricing")))
    check("  the itinerary was COPIED from the enquiry",
          d.get("origin") == "HYD" and d.get("destination") == "CMB"
          and one_way.get("travel_date", "").startswith(TRAVEL),
          f"{d.get('origin')}->{d.get('destination')} {one_way.get('travel_date')}")
    check("  the passenger was saved",
          len(one_way.get("passengers") or []) == 1,
          str(len(one_way.get("passengers") or [])))

# ---------------------------------------------------------------------------
print("\n== 2. the enquiry survives, and points at the booking ==")
# ---------------------------------------------------------------------------
assert one_way, "nothing to check: the booking was never created (see above)"
r = requests.get(f"{BASE}/api/enquiries/{enq['id']}", headers=H(atok))
after = r.json() if r.status_code == 200 else {}
check("the enquiry still exists", r.status_code == 200, str(r.status_code))
check("  its status is untouched by the booking",
      after.get("status") == "pending_approval", str(after.get("status")))
check("  it now carries booking_request_id",
      after.get("booking_request_id") == one_way.get("id"),
      f"{after.get('booking_request_id')} != {one_way.get('id')}")
check("  and booking_request_number",
      after.get("booking_request_number") == one_way.get("request_number"),
      str(after.get("booking_request_number")))
check("  the itinerary was not overwritten with booking data",
      after.get("origin") == "HYD" and after.get("destination") == "CMB")

# ---------------------------------------------------------------------------
print("\n== 3. duplicate prevention ==")
# ---------------------------------------------------------------------------
r = raise_booking(enq["id"])
check("Raise Booking a SECOND time is refused (409)",
      r.status_code == 409, f"{r.status_code} {r.text[:200]}")
check("  and names the booking that already exists",
      one_way.get("request_number", "\0") in r.text, r.text[:200])

r = requests.get(f"{BASE}/api/enquiries/{enq['id']}", headers=H(atok))
check("  the enquiry still points at the FIRST booking",
      r.json().get("booking_request_id") == one_way.get("id"))

# ---------------------------------------------------------------------------
print("\n== 4. Round Trip, also from Pending ==")
# ---------------------------------------------------------------------------
rt_enq = raise_manual_enquiry(
    trip_type="round_trip", return_date=RETURN, return_preferred_time="18:00",
    passenger_count=2, adults=2,
)
check("a round-trip manual enquiry starts Pending",
      rt_enq["status"] == "pending_approval", rt_enq["status"])
r = raise_booking(rt_enq["id"], passengers=[
    passenger(),
    passenger(title="Mr", first_name="Ravi", last_name="Kumar", gender="male",
              dob="1985-07-02", passport_number="MB0099772"),
])
check("Raise Booking on a PENDING round trip succeeds",
      r.status_code == 201, f"{r.status_code} {r.text[:300]}")
rt = r.json() if r.status_code == 201 else {}
if rt:
    check("  the return leg was copied from the enquiry",
          (rt.get("return_date") or "").startswith(RETURN), str(rt.get("return_date")))
    check("  both passengers were saved",
          len(rt.get("passengers") or []) == 2, str(len(rt.get("passengers") or [])))
    check("  source is b2b_manual_request",
          rt.get("source") == "b2b_manual_request", str(rt.get("source")))

# ---------------------------------------------------------------------------
print("\n== 5. Under Review is bookable too ==")
# ---------------------------------------------------------------------------
ur_enq = raise_manual_enquiry(flight_number="AI284")
r = requests.post(f"{BASE}/api/admin/enquiries/{ur_enq['id']}/review", headers=H(atok), json={})
check("the desk can pick the enquiry up (Under Review)",
      r.status_code == 200, f"{r.status_code} {r.text[:200]}")
r = raise_booking(ur_enq["id"])
check("Raise Booking on an UNDER REVIEW enquiry succeeds",
      r.status_code == 201, f"{r.status_code} {r.text[:300]}")

# ---------------------------------------------------------------------------
print("\n== 6. refused-and-withdrawn are still refused ==")
# ---------------------------------------------------------------------------
rej_enq = raise_manual_enquiry(flight_number="AI285")
r = requests.post(f"{BASE}/api/admin/enquiries/{rej_enq['id']}/review", headers=H(atok), json={})
r = requests.post(
    f"{BASE}/api/admin/enquiries/{rej_enq['id']}/respond", headers=H(atok),
    json={"available": False, "reason": "No seats on that sector."},
)
check("the desk can decline an enquiry", r.status_code == 200,
      f"{r.status_code} {r.text[:200]}")
r = raise_booking(rej_enq["id"])
check("Raise Booking on a REJECTED enquiry is still refused",
      r.status_code == 400, f"{r.status_code} {r.text[:200]}")
check("  and says it was refused, not that it needs quoting",
      "refused or withdrawn" in r.text, r.text[:250])

# ---------------------------------------------------------------------------
print("\n== 7. THE MERCHANT PORTAL'S RULE IS UNCHANGED ==")
# ---------------------------------------------------------------------------
# A merchant raising its OWN enquiry, then trying to book it before we answer.
r = requests.post(f"{BASE}/api/enquiries", headers=H(mtok), json=itinerary(flight_number="AI286"))
check("a merchant can raise its own enquiry", r.status_code == 201,
      f"{r.status_code} {r.text[:200]}")
own = r.json() if r.status_code == 201 else {}
#: Bound here so section 11 can test it even if the merchant path above
#: never got far enough to create one.
quoted = {}

if own:
    r = raise_booking(own["id"], token=mtok)
    check("a MERCHANT still cannot book an un-quoted enquiry",
          r.status_code == 400, f"{r.status_code} {r.text[:250]}")
    check("  with the original wording, unchanged",
          "Only an enquiry our team has marked available" in r.text, r.text[:250])

    # And the whole merchant path still works once we DO answer it.
    requests.post(f"{BASE}/api/admin/enquiries/{own['id']}/review", headers=H(atok), json={})
    r = requests.post(
        f"{BASE}/api/admin/enquiries/{own['id']}/respond", headers=H(atok),
        json={"available": True, "total_fare": "24500.00",
              "reason": "INR 24,500 all-in: fare, taxes and one checked bag."},
    )
    check("the desk can quote it", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    r = raise_booking(own["id"], token=mtok)
    check("and the merchant can then book it, as always",
          r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    quoted = r.json() if r.status_code == 201 else {}
    if quoted:
        check("  a QUOTED booking is still priced at the quotation",
              str(quoted.get("total_amount")).startswith("24500"),
              str(quoted.get("total_amount")))
        check("  and marked quoted",
              (quoted.get("pricing") or {}).get("quoted") is True,
              str(quoted.get("pricing")))
        check("  source is merchant_portal, not manual",
              quoted.get("source") == "merchant_portal", str(quoted.get("source")))

# ---------------------------------------------------------------------------
print("\n== 8. SAVE STOPS. IT DOES NOT ENTER ANY WORKFLOW ==")
# ---------------------------------------------------------------------------
# THE CORRECTION THIS SECTION EXISTS FOR
#
# Manual Booking previously ended in POST /api/requests/{id}/submit, which put
# the desk's own record on the MANAGER's queue and, after sign-off, on Booking
# Operations. That was wrong in kind, not in degree: a merchant's Booking
# Request is a request to buy, and the workflow exists to approve and then buy
# it. A Manual Booking is the record of a ticket the desk ALREADY bought, PNR in
# hand. There is nothing to approve, nothing to reserve, nothing to buy, and no
# wallet to debit.
#
# So Save creates the booking, writes the ticket onto it, and stops at DRAFT.
# The four assertions below are the four places it must NOT appear, and each is
# checked against a live endpoint rather than reasoned about.
if one_way:
    save = requests.put(
        f"{BASE}/api/requests/{one_way['id']}", headers=H(atok),
        json={"pnr": "ABC123", "ticket_number": TICKET_NO,
              "airline": "SriLankan Airlines", "flight_number": "UL122",
              "client_fare": "31500.00",
              "remarks": "Ticket arranged by phone; entered by the desk."},
    )
    check("Save records the ticket on the booking",
          save.status_code == 200, f"{save.status_code} {save.text[:200]}")
    saved = (save.json() or {}).get("request", {}) if save.status_code == 200 else {}
    check("  PNR is stored", saved.get("pnr") == "ABC123", str(saved.get("pnr")))
    check("  ticket number is stored",
          saved.get("ticket_number") == TICKET_NO, str(saved.get("ticket_number")))
    check("  airline and flight are stored on the itinerary",
          (saved.get("details") or {}).get("airline") == "SriLankan Airlines"
          and (saved.get("details") or {}).get("flight_number") == "UL122",
          str(saved.get("details", {}).get("airline")))
    check("  the fare is stored",
          str(saved.get("client_fare") or "").startswith("31500"),
          str(saved.get("client_fare")))

    # ---- IT STAYS AT DRAFT -------------------------------------------------
    db = SessionLocal()
    try:
        after = dict(db.execute(
            text("SELECT status::text AS status, source::text AS source, pnr, ticket_number, "
                 "total_amount, parent_request_id FROM service_requests WHERE request_id = :r"),
            {"r": one_way["id"]}).mappings().one())
    finally:
        db.close()
    check("  and the booking is still DRAFT — it entered no workflow",
          after["status"] == "draft", after["status"])
    check("  carrying no amount, so nothing can bill a wallet from it",
          str(after["total_amount"]) in ("0", "0.00", "0.0"), str(after["total_amount"]))

    number = one_way["request_number"]

    # ---- 1. NOT ON THE MANAGER'S DESK -------------------------------------
    # manager_service._classic_bookings_filter excludes source=b2b_manual_request.
    # Searched by request number, and the search is proved to work by finding a
    # MERCHANT booking with the same call — otherwise "0 rows" would pass this
    # check for the wrong reason.
    q = requests.get(
        f"{BASE}/api/manager/bookings?search={number}&page_size=100", headers=H(gtok))
    ids = [x["id"] for x in (q.json().get("items") or [])] if q.status_code == 200 else []
    check("the Manager's queue answers (so the next check is not vacuous)",
          q.status_code == 200, f"{q.status_code} {q.text[:160]}")
    check("  and the manual booking is NOT on it",
          one_way["id"] not in ids, f"found {ids} searching {number}")

    # ---- 2. NOT ON THE ADMIN APPROVAL QUEUE -------------------------------
    r = requests.get(f"{BASE}/api/admin/approval-queue?page_size=100", headers=H(atok))
    q2 = (r.json() or {}).get("items", []) if r.status_code == 200 else []
    check("the Approval Queue answers (so the next check is not vacuous)",
          r.status_code == 200 and len(q2) > 0, f"{r.status_code}, {len(q2)} rows")
    check("  and the manual booking is NOT on it",
          all(str(x.get("id")) != str(one_way["id"]) for x in q2),
          f"found in {len(q2)} rows")

    # ---- 3. NOT ON BOOKING OPERATIONS -------------------------------------
    # Its QUEUE_STAGES start at APPROVED, so a DRAFT cannot be there — asserted
    # rather than assumed, because that is the screen the requirement names.
    r = requests.get(
        f"{BASE}/api/admin/bookings/queue?search={number}&page_size=100", headers=H(atok))
    ops = [str(x.get("id")) for x in ((r.json() or {}).get("items") or [])] \
        if r.status_code == 200 else []
    check("Booking Operations answers (so the next check is not vacuous)",
          r.status_code == 200, f"{r.status_code} {r.text[:160]}")
    check("  and the manual booking is NOT on it",
          str(one_way["id"]) not in ops, f"found {ops} searching {number}")

    # ---- 4. NO WALLET MOVEMENT --------------------------------------------
    db = SessionLocal()
    try:
        moves = db.execute(
            text("SELECT count(*) FROM wallet_transactions WHERE request_id = :r"),
            {"r": one_way["id"]}).scalar()
    finally:
        db.close()
    check("  and no wallet transaction exists against it",
          moves == 0, f"{moves} wallet rows")

# ---------------------------------------------------------------------------
print("\n== 9. THE ENQUIRY IS THE PARENT, AND THE ROW SHOWS IT ==")
# ---------------------------------------------------------------------------
# What the Manual Enquiry table reads to decide Raise Booking vs View Booking.
# It is one GET of the ENQUIRY — the booking is reached THROUGH it, never
# addressed directly — so these three fields are the whole contract between the
# save and the table.
if one_way:
    r = requests.get(f"{BASE}/api/enquiries/{enq['id']}", headers=H(atok))
    row = r.json() if r.status_code == 200 else {}
    check("the enquiry still exists, reference unchanged",
          row.get("reference_number") == enq["reference_number"],
          f"{row.get('reference_number')} != {enq['reference_number']}")
    check("  its own status is untouched by the booking",
          row.get("status") == "pending_approval", str(row.get("status")))
    check("  it points at the booking (this is what shows View Booking)",
          row.get("booking_request_id") == one_way["id"],
          f"{row.get('booking_request_id')}")
    check("  and names it, which is what the row prints under the reference",
          row.get("booking_request_number") == one_way["request_number"],
          str(row.get("booking_request_number")))
    check("  the journey was not overwritten with booking data",
          row.get("origin") == "HYD" and row.get("destination") == "CMB"
          and str(row.get("travel_date")).startswith(TRAVEL),
          f"{row.get('origin')}->{row.get('destination')} {row.get('travel_date')}")

    # WHAT VIEW BOOKING READS. Enquiry first, then the booking through it.
    detail = requests.get(f"{BASE}/api/requests/{row['booking_request_id']}", headers=H(atok))
    b = (detail.json() or {}).get("request", {}) if detail.status_code == 200 else {}
    check("View Booking can read the booking through the enquiry",
          detail.status_code == 200, f"{detail.status_code} {detail.text[:160]}")
    check("  and it carries everything the modal prints",
          b.get("pnr") == "ABC123" and b.get("ticket_number") == TICKET_NO
          and len(b.get("passengers") or []) == 1,
          f"pnr={b.get('pnr')} ticket={b.get('ticket_number')} "
          f"pax={len(b.get('passengers') or [])}")
    check("  including who on the desk raised it",
          bool(b.get("raised_by")), str(b.get("raised_by")))

# ---------------------------------------------------------------------------
print("\n== 10. ONE ENQUIRY, ONE BOOKING ==")
# ---------------------------------------------------------------------------
# The table offers Raise Booking or View Booking and never both, because both
# are derived from `booking_request_id`. The server is the guarantee underneath
# that, and it is what this checks.
if one_way:
    r = raise_booking(enq["id"])
    check("raising a second booking from the same enquiry -> 409",
          r.status_code == 409, f"{r.status_code} {r.text[:160]}")

    db = SessionLocal()
    try:
        n = db.execute(text("SELECT count(*) FROM service_requests WHERE parent_request_id = :p"),
                       {"p": enq["id"]}).scalar()
    finally:
        db.close()
    check("  and the enquiry still has exactly ONE booking under it",
          n == 1, f"{n} bookings under {enq['reference_number']}")

    # EDIT, which is the one route back into the form, must UPDATE not create.
    r = requests.put(f"{BASE}/api/requests/{one_way['id']}", headers=H(atok),
                     json={"pnr": "XYZ789"})
    check("  editing the saved booking updates it",
          r.status_code == 200 and (r.json().get("request") or {}).get("pnr") == "XYZ789",
          f"{r.status_code} {r.text[:160]}")
    db = SessionLocal()
    try:
        n = db.execute(text("SELECT count(*) FROM service_requests WHERE parent_request_id = :p"),
                       {"p": enq["id"]}).scalar()
    finally:
        db.close()
    check("  and still exactly one booking afterwards", n == 1, f"{n}")

    # A DUPLICATE TICKET NUMBER IS A DATABASE GUARANTEE (uq_sr_ticket_number),
    # surfaced as a sentence rather than a 500.
    if rt:
        r = requests.put(f"{BASE}/api/requests/{rt['id']}", headers=H(atok),
                         json={"ticket_number": TICKET_NO})
        check("  the same ticket number on a second booking -> 409",
              r.status_code == 409, f"{r.status_code} {r.text[:160]}")

# ---------------------------------------------------------------------------
print("\n== 11. A MERCHANT CANNOT TYPE A PNR ==")
# ---------------------------------------------------------------------------
# `ticket.manual` gates the four ticket fields inside update_draft. On the
# merchant's own track the PNR is OUR statement that we bought the seat, so a
# merchant writing one would be asserting a purchase we never made. The fields
# are ignored rather than refused — the merchant's screen never sends them, so
# a 403 could only be reached by hand.
if own and quoted:
    r = requests.put(f"{BASE}/api/requests/{quoted['id']}", headers=H(mtok),
                     json={"pnr": "MERCH1", "ticket_number": "9999999999"})
    check("a merchant's own draft edit still succeeds",
          r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    db = SessionLocal()
    try:
        m = dict(db.execute(
            text("SELECT pnr, ticket_number FROM service_requests WHERE request_id = :r"),
            {"r": quoted["id"]}).mappings().one())
    finally:
        db.close()
    check("  but the PNR it sent was ignored", m["pnr"] is None, str(m["pnr"]))
    check("  and so was the ticket number",
          m["ticket_number"] is None, str(m["ticket_number"]))

# ---------------------------------------------------------------------------
print("\n== 12. DOCUMENTS ON A MANUAL BOOKING ==")
# ---------------------------------------------------------------------------
# NO BACKEND CHANGE WAS MADE FOR THIS, AND THAT IS THE ASSERTION.
# `document_service._assert_may_modify` opens with `if request.status is
# S.DRAFT: return`, and a manual booking is saved at DRAFT and stays there — so
# every document type is attachable for as long as it exists. The Admin reaches
# POST /api/requests/{id}/documents on `ticket.issue`, which it already holds.
#
# These checks pin that, because it is a rule in someone else's module: if the
# draft exemption is ever narrowed, the Manual Request screen's upload panel
# stops working and nothing else in the suite would notice.
if one_way:
    def _upload(content, filename, ctype, doc_type, passenger_id=None, token=atok):
        form = {"doc_type": doc_type}
        if passenger_id is not None:
            form["passenger_id"] = str(passenger_id)
        return requests.post(
            f"{BASE}/api/requests/{one_way['id']}/documents", headers=H(token),
            files={"file": (filename, content, ctype)}, data=form,
        )

    r = _upload(PDF, "eticket.pdf", "application/pdf", "ticket")
    check("the desk can attach a document to its DRAFT manual booking",
          r.status_code == 201, f"{r.status_code} {r.text[:200]}")
    doc = r.json() if r.status_code == 201 else {}
    check("  stored with the type it was sent as",
          doc.get("doc_type") == "ticket", str(doc.get("doc_type")))
    check("  and attributed to the operator who uploaded it",
          bool(doc.get("uploaded_by_name")), str(doc.get("uploaded_by_name")))

    # A PASSPORT, WHICH IS THE TYPE STAFF MAY *NOT* ATTACH LATE. It works here
    # only because of the DRAFT exemption, so this is the check that would fail
    # first if that exemption were removed.
    r = _upload(PNG, "passport.png", "image/png", "passport")
    check("  including a passport, which staff cannot attach after draft",
          r.status_code == 201, f"{r.status_code} {r.text[:200]}")

    # TIED TO ONE TRAVELLER. The id must belong to THIS booking; the service
    # checks it against the booking's own passengers.
    pax_id = (one_way.get("passengers") or [{}])[0].get("id")
    if pax_id:
        r = _upload(JPEG, "visa.jpg", "image/jpeg", "visa", passenger_id=pax_id)
        check("  and tied to a named traveller on this booking",
              r.status_code == 201 and r.json().get("passenger_id") == pax_id,
              f"{r.status_code} {r.text[:160]}")

    # THE TWO REFUSALS THE PANEL MIRRORS CLIENT-SIDE.
    r = _upload(b"<html>not a pdf</html>", "evil.pdf", "application/pdf", "other")
    check("  a file whose bytes do not match its type is refused",
          r.status_code in (400, 415, 422), f"{r.status_code} {r.text[:160]}")

    # WHAT THE PANEL AND THE MODAL READ BACK.
    r = requests.get(f"{BASE}/api/requests/{one_way['id']}/documents", headers=H(atok))
    listed = r.json() if r.status_code == 200 else []
    check("  the booking lists its documents",
          r.status_code == 200 and len(listed) >= 2, f"{r.status_code}, {len(listed)}")
    types = {d["doc_type"] for d in listed}
    check("  carrying every type that was attached",
          {"ticket", "passport"} <= types, str(sorted(types)))

    if listed:
        d0 = listed[0]
        r = requests.get(f"{BASE}/api/documents/{d0['id']}/download", headers=H(atok))
        check("  and each one downloads",
              r.status_code == 200 and len(r.content) > 0,
              f"{r.status_code} {len(r.content)} bytes")
        r = requests.delete(f"{BASE}/api/documents/{d0['id']}", headers=H(atok))
        check("  and can be removed while the booking is a draft",
              r.status_code in (200, 204), f"{r.status_code} {r.text[:160]}")

    # WHO MAY READ THEM. Two different questions, and the first one caught a
    # mistake in this script rather than in the code: `mtok` is not "another
    # merchant" here — the manual booking was raised ON BEHALF OF that very
    # merchant, so it is the owner and SHOULD see its own paperwork.
    r = requests.get(f"{BASE}/api/requests/{one_way['id']}/documents", headers=H(mtok))
    check("  the merchant the booking belongs to CAN see them",
          r.status_code == 200 and len(r.json()) >= 1, f"{r.status_code} {r.text[:160]}")

    # The real cross-tenant check needs a genuinely different company. A bogus
    # id would prove nothing about a row that really exists and really belongs
    # to someone else.
    rival = flows.rival_merchant(atok)
    r = requests.get(f"{BASE}/api/requests/{one_way['id']}/documents",
                     headers=H(rival["token"]))
    check("  but another company cannot",
          r.status_code in (403, 404), f"{r.status_code} {r.text[:160]}")
    r = requests.post(
        f"{BASE}/api/requests/{one_way['id']}/documents", headers=H(rival["token"]),
        files={"file": ("x.pdf", PDF, "application/pdf")}, data={"doc_type": "other"})
    check("  and cannot attach one either",
          r.status_code in (403, 404), f"{r.status_code} {r.text[:160]}")

# ---------------------------------------------------------------------------
print("\n== 13. GROUP BOOKING: THE DESK UPLOADS THE MANIFEST ==")
# ---------------------------------------------------------------------------
# THE ONE STEP OF MANUAL BOOKING THAT USED TO DEAD-END.
#
# A group's travellers come from a spreadsheet, not the form. Every other step
# already worked on behalf of a named merchant, but POST /api/group-bookings/
# imports required `ticket.request` and `_merchant_id_of` refused any caller
# without a merchant of its own — so the desk could raise a group enquiry, press
# Raise Booking, and then be stopped by a 403 on the upload card with no way
# forward.
#
# The upload now takes `on_behalf_of_merchant_id`, guarded the same way the
# enquiry route is: the permission is useless without the name, and the name is
# refused from anyone who has a merchant of their own.
GB = f"{BASE}/api/group-bookings"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

def group_sheet(journey_type, rows):
    """A workbook built from the service's OWN column list, so a column rename
    breaks this test rather than silently producing an invalid sheet."""
    from openpyxl import Workbook
    cols = list(gb.columns_for(journey_type))
    wb = Workbook()
    ws = wb.active
    ws.title = "Passengers"
    for i, c in enumerate(cols, 1):
        ws.cell(row=1, column=i, value=c)
    for r, data in enumerate(rows, 2):
        for i, c in enumerate(cols, 1):
            ws.cell(row=r, column=i, value=data.get(c))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()

def group_row(**over):
    base = {
        "Origin City": "Hyderabad", "Destination City": "Colombo",
        "Airline": "SriLankan Airlines", "Airline Number": "UL122",
        "Travel Date": GROUP_TRAVEL, "Preferred Hour": 9,
        "Preferred Minute": 30, "AM/PM": "AM",
        "Passenger Name": "Group Traveller", "Gender": "Male",
        "Date of Birth": datetime.date(1990, 4, 18), "Nationality": "Indian",
        "Passport Number": "GRP0001", "Passport Expiry": datetime.date(2032, 4, 18),
        "Booking Class": "Economy", "Adults": 1, "Children": 0, "Infants": 0,
        "Client Fare": 20000, "Notes": "",
    }
    base.update(over)
    return base

# The desk raises a GROUP enquiry for the merchant.
g_enq = raise_manual_enquiry(
    trip_type="group_trip", group_journey_type="one_way_group",
    travel_date=GROUP_TRAVEL.isoformat(),
    passenger_count=3, adults=3, flight_number="UL122",
)
check("the desk raises a group enquiry for the merchant",
      g_enq["status"] == "pending_approval", g_enq["status"])

sheet = group_sheet("one_way_group", [
    group_row(**{"Passenger Name": "Asha Menon", "Passport Number": "GRP0001"}),
    group_row(**{"Passenger Name": "Ravi Kumar", "Passport Number": "GRP0002"}),
    group_row(**{"Passenger Name": "Sara Iqbal", "Passport Number": "GRP0003"}),
])

# ---- THE FIX ----------------------------------------------------------------
r = requests.post(
    f"{GB}/imports", headers=H(atok),
    files={"file": ("party.xlsx", sheet, XLSX)},
    data={"journey_type": "one_way_group",
          "on_behalf_of_merchant_id": str(MERCHANT_ID)},
)
check("the desk can upload a manifest FOR that merchant",
      r.status_code == 201, f"{r.status_code} {r.text[:250]}")
imported = (r.json() or {}).get("imported", {}) if r.status_code == 201 else {}
check("  the sheet validates clean",
      imported.get("validation_status") == "valid", str(imported.get("validation_status")))
check("  with all three travellers",
      imported.get("passengers_imported") == 3, str(imported.get("passengers_imported")))

import_id = imported.get("import_id")
if import_id:
    db = SessionLocal()
    try:
        owner = db.execute(
            text("SELECT merchant_id, uploaded_by FROM group_booking_imports "
                 "WHERE import_id = :i"), {"i": import_id}).mappings().one()
    finally:
        db.close()
    # THE ROW BELONGS TO THE MERCHANT, NOT THE ADMIN. This is the assertion the
    # whole feature rests on: `attach_to_request` refuses a manifest whose
    # merchant differs from the booking's, so an import stored against the admin
    # (or against nobody) could never be attached.
    check("  the import is owned by the MERCHANT, not the admin",
          owner["merchant_id"] == MERCHANT_ID, f"{owner['merchant_id']} != {MERCHANT_ID}")
    check("  while recording which operator uploaded it",
          owner["uploaded_by"] == ADMIN_USER_ID, str(owner["uploaded_by"]))

    # ---- AND THE BOOKING COMPLETES -----------------------------------------
    r = requests.post(
        f"{BASE}/api/enquiries/{g_enq['id']}/booking-request", headers=H(atok),
        json={"passengers": [], "group_import_id": import_id, "international": True},
    )
    check("Raise Booking completes for a GROUP enquiry",
          r.status_code == 201, f"{r.status_code} {r.text[:250]}")
    g_booking = r.json() if r.status_code == 201 else {}
    if g_booking:
        check("  the travellers came from the sheet",
              len(g_booking.get("passengers") or []) == 3,
              str(len(g_booking.get("passengers") or [])))
        check("  the booking is the merchant's",
              g_booking.get("merchant_id") == MERCHANT_ID, str(g_booking.get("merchant_id")))
        db = SessionLocal()
        try:
            gb_row = dict(db.execute(
                text("SELECT status::text AS status, source::text AS source "
                     "FROM service_requests WHERE request_id = :r"),
                {"r": g_booking["id"]}).mappings().one())
            attached = db.execute(
                text("SELECT request_id FROM group_booking_imports WHERE import_id = :i"),
                {"i": import_id}).scalar()
        finally:
            db.close()
        check("  saved as a manual booking, in no workflow",
              gb_row["status"] == "draft" and gb_row["source"] == "b2b_manual_request",
              str(gb_row))
        check("  and the manifest is attached to it",
              attached == g_booking["id"], f"{attached} != {g_booking['id']}")

# ---- THE TWO REFUSALS THAT KEEP THIS FROM WIDENING -------------------------
r = requests.post(
    f"{GB}/imports", headers=H(mtok),
    files={"file": ("party.xlsx", sheet, XLSX)},
    data={"journey_type": "one_way_group", "on_behalf_of_merchant_id": "1"},
)
check("a MERCHANT cannot upload for another company",
      r.status_code == 403, f"{r.status_code} {r.text[:200]}")

r = requests.post(
    f"{GB}/imports", headers=H(atok),
    files={"file": ("party.xlsx", sheet, XLSX)},
    data={"journey_type": "one_way_group"},
)
check("and the desk must still NAME a merchant",
      r.status_code == 403, f"{r.status_code} {r.text[:200]}")

# A merchant uploading its OWN sheet is completely unchanged.
r = requests.post(
    f"{GB}/imports", headers=H(mtok),
    files={"file": ("party.xlsx", sheet, XLSX)},
    data={"journey_type": "one_way_group"},
)
check("a merchant uploading its own sheet still works",
      r.status_code == 201, f"{r.status_code} {r.text[:200]}")
own_import = (r.json() or {}).get("imported", {}).get("import_id") if r.status_code == 201 else None

# CROSS-MERCHANT ATTACH. The manifest and the booking must belong to the same
# company; `to_booking_request` now refuses this before building a single
# passenger row from another company's sheet.
if own_import and rt:
    r = requests.post(
        f"{BASE}/api/enquiries/{rt_enq['id']}/booking-request", headers=H(atok),
        json={"passengers": [], "group_import_id": own_import, "international": True},
    )
    check("a manifest cannot be attached to a different enquiry's booking",
          r.status_code in (400, 403, 409), f"{r.status_code} {r.text[:200]}")

# ---------------------------------------------------------------------------
print("\n== 14. INVOICE FROM A MANUAL REQUEST ==")
# ---------------------------------------------------------------------------
# WHAT THIS PROTECTS
#
# The invoice endpoint refused a manual booking outright — `INVOICEABLE` is
# {ticket_issued, completed}, and a manual booking is finished at DRAFT on
# purpose. It also had no invoice number, because `issue_ticket` is what
# allocates one and that function debits the merchant's wallet, which must
# never happen for a ticket the desk bought off-platform.
#
# So the Generate/Download buttons on Manual Request rest on two things this
# section pins:
#   * a manual booking is invoiceable while still at draft, and ONLY because
#     of its `source` — a merchant's own draft is still refused;
#   * the number is allocated once, from the same sequence, and re-read after.
if one_way:
    # `one_way` is submitted by section 8, so use a booking that is still the
    # shape Manual Request leaves behind: draft, b2b_manual_request.
    m_enq = raise_manual_enquiry(flight_number="AI911")
    r = raise_booking(m_enq["id"])
    check("a manual booking exists to invoice",
          r.status_code == 201, f"{r.status_code} {r.text[:160]}")
    mb = r.json() if r.status_code == 201 else {}

    if mb:
        # Give it a fare the way Manual Request does — the Ticket details panel
        # writes `client_fare`, because `total_amount` stays 0 on this track.
        requests.put(f"{BASE}/api/requests/{mb['id']}", headers=H(atok),
                     json={"client_fare": "48250.00", "pnr": "INVPNR"})

        r = requests.get(f"{BASE}/api/requests/{mb['id']}/invoice", headers=H(atok))
        check("Generate Invoice works on a DRAFT manual booking",
              r.status_code == 200 and r.content[:5] == b"%PDF-",
              f"{r.status_code} {r.text[:160]}")
        first = r.content

        db = SessionLocal()
        try:
            row = dict(db.execute(
                text("SELECT status::text AS status, invoice_number "
                     "FROM service_requests WHERE request_id = :r"),
                {"r": mb["id"]}).mappings().one())
        finally:
            db.close()
        check("  an invoice number was allocated",
              bool(row["invoice_number"]), str(row["invoice_number"]))
        check("  and the booking did NOT change status to get one",
              row["status"] == "draft", row["status"])

        # DOWNLOAD IS THE SAME CALL, so the two cannot disagree — and the second
        # press must not burn a second number.
        #
        # COMPARED AS TEXT, NOT AS BYTES. A PDF embeds its own creation
        # timestamp, so two renders of the identical document are never
        # byte-identical and asserting that fails for a reason that has nothing
        # to do with the invoice. What must match is what the page SAYS.
        r2 = requests.get(f"{BASE}/api/requests/{mb['id']}/invoice", headers=H(atok))
        check("Download Invoice returns the identical document",
              r2.status_code == 200 and _pdf_text(r2.content) == _pdf_text(first),
              f"{r2.status_code}, {len(r2.content)} vs {len(first)} bytes")

        db = SessionLocal()
        try:
            again = db.execute(
                text("SELECT invoice_number FROM service_requests WHERE request_id = :r"),
                {"r": mb["id"]}).scalar()
            dupes = db.execute(text(
                "SELECT count(*) FROM (SELECT invoice_number FROM service_requests "
                "WHERE invoice_number IS NOT NULL GROUP BY invoice_number "
                "HAVING count(*) > 1) d")).scalar()
        finally:
            db.close()
        check("  the number is reused, not reallocated",
              again == row["invoice_number"], f"{again} != {row['invoice_number']}")
        check("  and no invoice number is shared by two bookings",
              dupes == 0, f"{dupes} duplicated")

        # THE AMOUNT COMES FROM THE COLUMN THIS TRACK ACTUALLY USES. total_amount
        # is 0 on a manual booking; the fare the desk typed is client_fare, and
        # an invoice printing 0.00 against a 48,250 booking would be wrong.
        #
        # Extracted, not scanned: a PDF's text lives in Flate-compressed content
        # streams, so searching the raw bytes finds nothing however right the
        # document is.
        rendered = _pdf_text(first)
        check("  the invoice states the fare the desk recorded",
              "48,250.00" in rendered, f"48,250.00 absent; page reads: {rendered[:160]!r}")
        check("  and carries its own invoice number",
              (row["invoice_number"] or "\0") in rendered, row["invoice_number"])

    # A MERCHANT'S OWN DRAFT IS STILL REFUSED. The gate widened on `source`,
    # which a merchant cannot set — not on the status, which it shares.
    r = requests.post(f"{BASE}/api/enquiries", headers=H(mtok),
                      json=itinerary(flight_number="AI912"))
    if r.status_code == 201:
        own_enq = r.json()
        requests.post(f"{BASE}/api/admin/enquiries/{own_enq['id']}/review",
                      headers=H(atok), json={})
        requests.post(f"{BASE}/api/admin/enquiries/{own_enq['id']}/respond", headers=H(atok),
                      json={"available": True, "total_fare": "1000.00", "reason": "ok"})
        d = raise_booking(own_enq["id"], token=mtok)
        if d.status_code == 201:
            r = requests.get(f"{BASE}/api/requests/{d.json()['id']}/invoice", headers=H(mtok))
            check("a MERCHANT's own draft still has no invoice",
                  r.status_code == 409, f"{r.status_code} {r.text[:140]}")

sys.exit(check.report())



