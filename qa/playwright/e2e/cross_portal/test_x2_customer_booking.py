"""X2 — Customer booking is visible to Admin with the SAME booking_ref.
X3 — Admin status action is visible to the Customer (same booking).

A PENDING B2C package booking is created through the real API (status 'pending';
no payment gateway). It appears in the customer's My Trips and the admin booking
list under the SAME booking_ref. Admin then changes the status and the customer
sees it. jpw_qa only; suppliers dormant; no payment.
"""
from __future__ import annotations

import httpx
import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.cross_portal]

ADMIN_LIST = "/api/admin/customer-bookings"


def _my_trips(base, token):
    r = httpx.get(base + "/api/customer/package-bookings",
                  headers={"Authorization": f"Bearer {token}"}, timeout=30.0)
    r.raise_for_status()
    d = r.json()
    return d if isinstance(d, list) else (d.get("items") or d.get("bookings") or [])


def test_customer_booking_cross_portal_and_status(require_server, qa_base_url, api,
                                                  role_tokens, db_probe, customer_session):
    from fixtures import auth as A
    from fixtures import journeys as J
    bk = J.create_customer_package_booking(customer_session)
    ref = bk["reference"]
    assert ref, "booking has no reference"
    assert bk["status"] == "pending"
    cid = (customer_session["customer"] or {}).get("id")

    # DB: the booking persisted for this customer.
    assert db_probe.count("customer_package_bookings", "booking_ref = :r", r=ref) == 1

    # Customer My Trips shows it as pending.
    mine = [x for x in _my_trips(qa_base_url, customer_session["access"])
            if x.get("booking_ref") == ref]
    assert mine and mine[0]["status"] == "pending", "customer cannot see own pending booking"

    # X2: Admin sees the SAME booking_ref.
    status, body = api.get_json(ADMIN_LIST, role_tokens["admin"])
    assert status == 200
    aitems = body if isinstance(body, list) else (body.get("items") or body.get("bookings")
                                                  or body.get("results") or [])
    amatch = [x for x in aitems if str(x.get("booking_id")) == ref]
    assert amatch, f"admin does not see booking {ref}"
    # Admin surfaces the status in upper-case display form; compare case-insensitively.
    assert str(amatch[0].get("booking_status")).lower() == "pending"

    # Authorization: admin booking surface is admin-only; status PATCH too.
    assert api.status("GET", ADMIN_LIST, None) in (401, 403)
    assert api.status("GET", ADMIN_LIST, role_tokens["merchant"]) in (401, 403)
    assert api.status("PATCH", f"{ADMIN_LIST}/{ref}/status", role_tokens["merchant"]) in (401, 403)

    # Invalid transition is refused (error handling).
    bad = httpx.patch(qa_base_url + f"{ADMIN_LIST}/{ref}/status", json={"status": "not_a_status"},
                      headers={"Authorization": f"Bearer {role_tokens['admin']}"}, timeout=30.0)
    assert bad.status_code == 400, bad.text[:120]

    # X3: a valid admin status change becomes visible to the customer.
    ok = httpx.patch(qa_base_url + f"{ADMIN_LIST}/{ref}/status", json={"status": "confirmed"},
                     headers={"Authorization": f"Bearer {role_tokens['admin']}"}, timeout=30.0)
    assert ok.status_code == 200, ok.text[:120]
    mine2 = [x for x in _my_trips(qa_base_url, customer_session["access"])
             if x.get("booking_ref") == ref]
    assert mine2 and mine2[0]["status"] == "confirmed", "customer did not see admin status change"
    # DB reflects the same state.
    assert db_probe.scalar("SELECT status FROM customer_package_bookings WHERE booking_ref = :r",
                           r=ref) == "confirmed"
