"""X1 — Customer registration is visible to Admin with the SAME identifiers.

register (dev-OTP) -> customers row -> admin search + by-id show the same
customer_id / email / customer_code. Authz: only staff/admin may look; unknown
id -> 404. jpw_qa only; no real OTP/payment.
"""
from __future__ import annotations

import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.cross_portal]

ADMIN_CUSTOMERS = "/api/admin/customers"


def test_registration_visible_to_admin(require_server, api, role_tokens, db_probe):
    from fixtures import auth as A
    s = A.create_customer("x1")
    cust = s["customer"]
    cid, email, code = cust["id"], s["email"], cust.get("customer_code")

    # DB: the registration persisted.
    assert db_probe.count("customers", "customer_id = :c", c=cid) == 1

    # Admin search returns the SAME record.
    status, body = api.get_json(f"{ADMIN_CUSTOMERS}?search={email}", role_tokens["admin"])
    assert status == 200, status
    items = body if isinstance(body, list) else (body.get("items") or body.get("customers")
                                                 or body.get("results") or [])
    match = [x for x in items if str(x.get("email")) == email]
    assert match, f"admin search did not surface {email}"
    assert str(match[0].get("customer_id") or match[0].get("id")) == str(cid)
    if code:
        assert str(match[0].get("customer_code")) == str(code)

    # Admin by-id returns the SAME customer; unknown id is 404.
    st2, b2 = api.get_json(f"{ADMIN_CUSTOMERS}/{cid}", role_tokens["admin"])
    assert st2 == 200 and str((b2 or {}).get("email")) == email
    assert api.status("GET", f"{ADMIN_CUSTOMERS}/999999999", role_tokens["admin"]) == 404

    # Authorization: this is an admin-only surface.
    assert api.status("GET", ADMIN_CUSTOMERS, None) in (401, 403)
    assert api.status("GET", ADMIN_CUSTOMERS, role_tokens["merchant"]) in (401, 403)
    assert api.status("GET", ADMIN_CUSTOMERS, role_tokens["customer"]) in (401, 403)
