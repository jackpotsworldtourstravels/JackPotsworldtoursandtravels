"""Reusable end-to-end flows against the live API.

Every verification script needs a booking at a known stage, and hunting for one
in existing data makes suites order-dependent — the M2 run ticketed the only
candidate and the next run had nothing to work with. This builds one from
scratch instead, so any script can ask for exactly the stage it needs.

TWO BUILDERS, BECAUSE THERE ARE TWO WORKFLOWS (CR-2)
:func:`make_booking` builds an **enquiry-led** booking, which now runs the
Classic Tours workflow: a Manager approves it and it has no payment stage at
all. :func:`make_catalog_booking` builds a **catalog-led** one, which keeps the
original Admin-approves-then-merchant-pays path.

A suite that needs to exercise money — invoices, the ledger, credit limits,
refunds — must use the catalog builder. Asking :func:`make_booking` for a paid
booking is not a stage it can reach, and it says so rather than walking a
booking somewhere the state machine will not go.
"""
import datetime
import time

import minihttp as requests
# Re-exported so a script can `import flows` and reach the accounts without a
# second import; config.py is the one definition of both.
from config import (  # noqa: F401
    ADMIN, ADMIN2, BASE, MANAGER, MERCHANT, PDF, SUPER, H, forget_login, login,
)

#: Stage order, so a caller can ask for "at least paid" and the flow knows how
#: far to walk.
ORDER = ["draft", "pending_approval", "approved", "payment_pending", "paid", "ticket_issued", "completed"]

#: The stages an enquiry-led (Classic Tours) booking can actually occupy.
#: Payment Pending and Paid are absent because they are unreachable on that
#: track — see ``lifecycle.CLASSIC_TRANSITIONS``.
CLASSIC_ORDER = ["draft", "pending_approval", "approved", "ticket_issued", "completed"]


def complete_by_travelling(rid):
    """Walk a ticketed booking to **Completed** the only way that now exists.

    THERE IS NO "MARK COMPLETE" ENDPOINT ANY MORE.
    ``POST /api/admin/requests/{id}/complete`` was removed: a booking completes
    when its scheduled journey has finished, swept on a timer by
    ``booking_completion_service``. So a test cannot ask for a completed booking
    — it has to make one *travel*.

    Which is what this does: it moves the itinerary into the past directly in
    the database (the API refuses to create or reschedule into the past, and
    rightly so), then runs the real sweep. Nothing here reimplements the rule —
    ``sweep`` is the production function, judging the production columns — so a
    test that gets a completed booking has just proved the mechanism works
    rather than routed around it.

    Imported lazily: every script imports this module, but only three ask for a
    completed booking, and only those three should need the backend importable.
    """
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parent.parent / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))

    from app.database.session import SessionLocal
    from app.models_v2 import ServiceRequest
    from app.services import booking_completion_service

    yesterday = datetime.date.today() - datetime.timedelta(days=1)
    db = SessionLocal()
    try:
        booking = db.get(ServiceRequest, rid)
        assert booking is not None, f"booking {rid} vanished"
        booking.travel_date = yesterday
        # A return leg still in the future would keep the journey open — which
        # is the correct behaviour, and not what this helper is asking for.
        if booking.return_date is not None:
            booking.return_date = yesterday
        db.commit()

        completed = booking_completion_service.sweep(db)
        assert completed >= 1, "the completion sweep completed nothing"
    finally:
        db.close()


def rival_merchant(atok):
    """A signed-in user belonging to a **different** company than ``MERCHANT``.

    Cross-tenant isolation is the one rule that cannot be checked with a bogus
    id — a 404 for id 99999999 proves nothing about a row that really exists
    and really belongs to someone else. This finds another active merchant with
    a login, resets that login's password through the Admin endpoint (which
    returns it once), and signs in as them.

    Returns ``{"token", "merchant_id", "email", "company"}``.
    """
    merchants = requests.get(
        f"{BASE}/api/admin/merchants?page_size=100", headers=H(atok)
    ).json()["items"]

    me = requests.get(f"{BASE}/api/auth/me", headers=H(login(*MERCHANT))).json()
    mine = me.get("merchant_id")

    for merchant in merchants:
        if merchant["id"] == mine or merchant["status"] != "active" or not merchant["user_count"]:
            continue
        users = requests.get(
            f"{BASE}/api/admin/merchants/{merchant['id']}/users?page_size=20", headers=H(atok)
        ).json()["items"]
        candidate = next(
            (u for u in users if u["status"] == "active" and u["role"] == "merchant_admin"), None
        )
        if not candidate:
            continue

        r = requests.post(
            f"{BASE}/api/admin/merchants/{merchant['id']}/users/{candidate['id']}/reset-password",
            headers=H(atok),
        )
        if r.status_code != 200:
            continue
        password = r.json()["temporary_password"]
        # A password reset moves ``force_logout_at`` to now, and a JWT's ``iat``
        # is whole seconds — a token minted in the same second is issued
        # *before* the sub-second reset timestamp and comes back as "session
        # ended". One second of clock is the whole fix.
        time.sleep(1.2)
        # ...and the *cached* token for this account was minted before the reset,
        # so `login` below would hand back a token the server has already
        # revoked. Calling this flow twice in one script is what exposes it.
        forget_login(candidate["email"], "merchant")
        return {
            "token": login(candidate["email"], password, "merchant"),
            "merchant_id": merchant["id"],
            "email": candidate["email"],
            "company": merchant["company_name"],
        }

    raise AssertionError(
        "no second merchant with an active merchant_admin login — cross-tenant "
        "isolation cannot be verified against this database"
    )


def make_booking(mtok, atok, *, upto="draft", international=False, pax=1, label="verification",
                 gtok=None, fare="24500.00", quote=None):
    """Create an **enquiry-led** booking and walk it to ``upto``.

    This is the Classic Tours workflow (CR-2): the Admin answers the enquiry,
    the merchant submits, and a **Manager** approves. ``gtok`` is a Manager
    token; it is obtained from :data:`config.MANAGER` when not supplied, so
    existing callers keep working without passing one.

    ``upto`` may be any of :data:`CLASSIC_ORDER`. Asking for ``payment_pending``
    or ``paid`` fails loudly — those stages do not exist on this track, and
    silently stopping short would leave a suite asserting against a booking that
    is not where it thinks it is. Use :func:`make_catalog_booking` for money.

    ``quote`` is the total fare the Admin quotes when answering the enquiry
    (CR-5), and it defaults to ``fare`` so the booking this builder produces
    carries a real amount from the moment it is drafted. **A quotation is now
    mandatory** — ``/respond`` refuses ``available: true`` without a positive
    ``total_fare`` — so this is not optional plumbing; a caller passing
    ``quote=None`` gets ``fare`` anyway rather than a 422 three lines later.

    ``fare`` is what the desk pays the airline, supplied at ticket issuance
    (CR-4b). Since CR-5 the booking normally already carries the quoted amount,
    and ``_capture_fare_for_wallet_billing`` then ignores this value — it is
    still sent because the endpoint still accepts it, and because a booking that
    reaches issuance at 0 (a pre-CR-5 one) still requires it. Only used when
    ``upto`` reaches ``ticket_issued``.

    Returns ``{"id", "request_number", "enquiry_id", "status", "passenger_ids"}``.
    """
    if upto not in CLASSIC_ORDER:
        raise AssertionError(
            f"'{upto}' is not a stage an enquiry-led booking can reach — the Classic "
            f"Tours workflow has no payment step (CR-2). Stages: {', '.join(CLASSIC_ORDER)}. "
            f"For a booking that can be paid, use flows.make_catalog_booking()."
        )
    travel = datetime.date.today() + datetime.timedelta(days=60)

    dest, dest_city = ("DXB", "Dubai") if international else ("BOM", "Mumbai")
    airline, flight = ("Emirates", "EK525") if international else ("IndiGo", "6E1423")

    r = requests.post(f"{BASE}/api/enquiries", headers=H(mtok), json={
        "trip_type": "one_way",
        "origin": "HYD", "origin_city": "Hyderabad",
        "destination": dest, "destination_city": dest_city,
        "airline": airline, "flight_number": flight,
        "travel_date": str(travel), "preferred_time": "09:30",
        "travel_class": "Economy",
        "passenger_count": pax, "adults": pax,
        "notes": label,
    })
    assert r.status_code in (200, 201), f"enquiry: {r.status_code} {r.text[:300]}"
    enq = r.json()

    requests.post(f"{BASE}/api/admin/enquiries/{enq['id']}/review", headers=H(atok))
    # CR-5: the answer is a quotation. `total_fare` and remarks are both
    # required by the schema, and the fare becomes the booking's total_amount.
    r = requests.post(f"{BASE}/api/admin/enquiries/{enq['id']}/respond", headers=H(atok),
                      json={"available": True, "response": "Seats confirmed.",
                            "total_fare": str(quote if quote is not None else fare),
                            "reason": "Base fare plus taxes and baggage."})
    assert r.status_code == 200, f"respond: {r.status_code} {r.text[:300]}"

    passengers = [
        {"title": "Mr", "first_name": f"Test{i}", "last_name": "Traveller",
         "passenger_type": "adult",
         **({"passport_number": f"P{i}234567",
             "passport_expiry": str(travel + datetime.timedelta(days=500))} if international else {})}
        for i in range(1, pax + 1)
    ]
    r = requests.post(f"{BASE}/api/enquiries/{enq['id']}/booking-request", headers=H(mtok), json={
        "passengers": passengers,
        "contact": {"name": "Ops Contact", "email": "ops@demotravel.example", "phone": "+919845012345"},
        "international": international,
        "remarks": label,
    })
    assert r.status_code in (200, 201), f"to-booking: {r.status_code} {r.text[:300]}"
    booking = r.json()
    rid = booking["id"]

    detail = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()
    pax_ids = [p["id"] for p in detail["request"]["passengers"]]

    if international:
        for pid in pax_ids:
            requests.post(f"{BASE}/api/requests/{rid}/documents", headers=H(mtok),
                          files={"file": (f"pp{pid}.pdf", PDF, "application/pdf")},
                          data={"doc_type": "passport", "passenger_id": pid})

    want = CLASSIC_ORDER.index(upto)

    if want >= CLASSIC_ORDER.index("pending_approval"):
        r = requests.post(f"{BASE}/api/requests/{rid}/submit", headers=H(mtok))
        assert r.status_code == 200, f"submit: {r.status_code} {r.text[:300]}"

    if want >= CLASSIC_ORDER.index("approved"):
        gtok = gtok or login(*MANAGER)
        r = requests.post(f"{BASE}/api/manager/bookings/{rid}/approve", headers=H(gtok),
                          json={"note": "Verified against the enquiry."})
        assert r.status_code == 200, f"manager approve: {r.status_code} {r.text[:300]}"

    if want >= CLASSIC_ORDER.index("ticket_issued"):
        # The desk must attach what it bought before it may say "issued" — on
        # this track that status is what tells the merchant its paperwork is
        # ready, so there is no later stage at which the file could arrive.
        r = requests.post(f"{BASE}/api/requests/{rid}/documents", headers=H(atok),
                          files={"file": (f"eticket-{rid}.pdf", PDF, "application/pdf")},
                          data={"doc_type": "ticket"})
        assert r.status_code in (200, 201), f"ticket upload: {r.status_code} {r.text[:300]}"
        # CR-4b: the fare is captured here, because nothing before this point on
        # the enquiry-led track ever sets one.
        r = requests.post(f"{BASE}/api/admin/requests/{rid}/issue-ticket", headers=H(atok),
                          json={"fare_amount": fare})
        assert r.status_code == 200, f"issue: {r.status_code} {r.text[:300]}"

    if want >= CLASSIC_ORDER.index("completed"):
        complete_by_travelling(rid)

    final = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()["request"]
    return {
        "id": rid,
        "request_number": final["request_number"],
        "enquiry_id": enq["id"],
        "status": final["status"],
        "passenger_ids": pax_ids,
    }


def make_catalog_booking(mtok, atok, *, upto="draft", pax=1, amount="24500.00",
                         label="verification"):
    """Create a **catalog-led** booking and walk it to ``upto``.

    The standard track: the merchant books against live inventory, an Admin
    approves with a fare, the merchant pays and an Admin verifies. This is the
    workflow CR-2 left untouched, and it is the one to use whenever a suite
    needs a booking that has money on it — invoices, the ledger, credit limits,
    refunds and cancellation settlements.

    Returns the same shape as :func:`make_booking`, with ``enquiry_id`` set to
    ``None`` — there is no enquiry behind a catalog booking.
    """
    if upto not in ORDER:
        raise AssertionError(f"'{upto}' is not a stage; use one of {', '.join(ORDER)}")

    items = requests.get(
        f"{BASE}/api/catalog/search?page_size=20", headers=H(mtok)
    ).json().get("items", [])
    item = next((i for i in items if (i.get("available_units") or 0) >= pax), None)
    assert item, "no catalog item with available units — cannot build a catalog booking"

    passengers = [
        {"title": "Mr", "first_name": f"Cat{i}", "last_name": "Traveller",
         "passenger_type": "adult"}
        for i in range(1, pax + 1)
    ]
    r = requests.post(f"{BASE}/api/requests", headers=H(mtok), json={
        "catalog_item_id": item["id"],
        "passengers": passengers,
        "travel_date": item.get("travel_date"),
        "remarks": label,
    })
    assert r.status_code in (200, 201), f"catalog booking: {r.status_code} {r.text[:300]}"
    detail = r.json()
    rid = detail["request"]["id"]
    pax_ids = [p["id"] for p in detail["request"]["passengers"]]

    want = ORDER.index(upto)

    if want >= ORDER.index("pending_approval"):
        r = requests.post(f"{BASE}/api/requests/{rid}/submit", headers=H(mtok))
        assert r.status_code == 200, f"submit: {r.status_code} {r.text[:300]}"

    if want >= ORDER.index("approved"):
        r = requests.post(f"{BASE}/api/admin/requests/{rid}/approve", headers=H(atok),
                          json={"final_amount": amount, "note": "Confirmed with airline."})
        assert r.status_code == 200, f"approve: {r.status_code} {r.text[:300]}"

    if want >= ORDER.index("paid"):
        txn = f"TXN-{rid}-VERIFY"
        r = requests.post(f"{BASE}/api/requests/{rid}/pay", headers=H(mtok),
                          json={"amount": amount, "method": "bank_transfer",
                                "transaction_id": txn})
        assert r.status_code == 200, f"pay: {r.status_code} {r.text[:300]}"

        # FOUND BY ITS TRANSACTION ID, NOT BY READING THE TOP OF THE QUEUE.
        # This used to fetch /admin/payments/pending?page_size=100 and scan it
        # for our request. That queue is ordered OLDEST FIRST and page_size is
        # capped at 100 by the endpoint, so once a hundred payments were sitting
        # unverified on the dev database, a payment created one second ago was
        # on page two and this asserted "no pending payment found" — a fixture
        # failing on the size of a queue it does not own, in five scripts at
        # once. The general payments list filters on transaction_id, and the id
        # written just above is unique per request, so the lookup is exact
        # however long the backlog gets.
        found = requests.get(
            f"{BASE}/api/admin/payments?status=pending&page_size=100&search={txn}",
            headers=H(atok)).json()
        mine = [p for p in found.get("items", []) if p.get("request_id") == rid]
        assert mine, f"no pending payment found for {rid} (searched {txn})"
        r = requests.post(f"{BASE}/api/admin/payments/{mine[0]['id']}/verify", headers=H(atok),
                          json={"approve": True})
        assert r.status_code == 200, f"verify payment: {r.status_code} {r.text[:300]}"

    if want >= ORDER.index("ticket_issued"):
        r = requests.post(f"{BASE}/api/admin/requests/{rid}/issue-ticket", headers=H(atok), json={})
        assert r.status_code == 200, f"issue: {r.status_code} {r.text[:300]}"

    if want >= ORDER.index("completed"):
        complete_by_travelling(rid)

    final = requests.get(f"{BASE}/api/requests/{rid}", headers=H(mtok)).json()["request"]
    return {
        "id": rid,
        "request_number": final["request_number"],
        "enquiry_id": None,
        "status": final["status"],
        "passenger_ids": pax_ids,
    }
