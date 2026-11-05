"""Cross-portal (4A.4) record builders — create REAL records through the actual
application workflows (no mocking), for consistency verification across portals.

- B2C: create a pending package booking (status 'pending'; the API itself states
  "no payment gateway is integrated", so NO payment is triggered).
- B2B: create an enquiry-led Classic Tours request via the existing tests/flows
  helper (payment is bypassed for Classic Tours, CR-2) — no supplier/payment.

All data lands in jpw_qa and is namespaced. Suppliers stay dormant.
"""
from __future__ import annotations

import sys
from pathlib import Path

import httpx

from . import auth as A

REPO_ROOT = Path(__file__).resolve().parents[3]
for p in (str(REPO_ROOT), str(REPO_ROOT / "tests")):
    if p not in sys.path:
        sys.path.insert(0, p)


def create_customer_package_booking(session: dict) -> dict:
    """Create one PENDING B2C package booking for the given customer session.
    Returns {booking_id, reference, status, package_id, departure_id, http}."""
    h = {"Authorization": f"Bearer {session['access']}"}
    c = httpx.Client(base_url=A.base_url(), timeout=30.0)
    try:
        pkgs = c.get("/api/customer/packages").json()
        cand = [p for p in pkgs if p.get("next_departure")]
        assert cand, "no package with a live departure to book"
        pid = int(cand[0]["id"])
        det = c.get(f"/api/customer/packages/{pid}").json()
        deps = [d for d in (det.get("departures") or []) if d.get("id")]
        assert deps, f"package {pid} has no bookable departure"
        depid = int(deps[0]["id"])
        payload = {
            "trip": {"package_id": pid, "departure_id": depid, "pax_count": 1},
            "travellers": [{
                "first_name": "Qa", "last_name": "Journey", "traveller_type": "adult",
                "is_contact": True, "mobile": "9000000000", "email": session["email"],
            }],
        }
        r = c.post("/api/customer/package-bookings", json=payload, headers=h)
        r.raise_for_status()
        b = r.json()
        return {
            "booking_id": b.get("id") or b.get("customer_package_booking_id"),
            "reference": b.get("booking_ref") or b.get("reference") or b.get("ref"),
            "status": b.get("status"),
            "package_id": pid, "departure_id": depid, "raw": b,
        }
    finally:
        c.close()


def create_merchant_request(label: str = "qa4a4") -> dict:
    """Create an enquiry-led Classic Tours request (merchant raises, admin answers)
    via tests/flows. Returns {id, request_number, status, mtok, atok}."""
    import config as c  # tests/config.py
    import flows
    mtok = c.login(*c.MERCHANT)
    atok = c.login(*c.ADMIN)
    b = flows.make_booking(mtok, atok, upto="draft", label=label)
    return {"id": b["id"], "request_number": b.get("request_number"),
            "status": b.get("status"), "mtok": mtok, "atok": atok}
