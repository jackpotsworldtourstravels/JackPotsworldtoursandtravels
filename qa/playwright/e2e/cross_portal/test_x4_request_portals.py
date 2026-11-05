"""X4 — A merchant-raised (enquiry-led) request is visible to Admin with the SAME
       request id/number.
X5 — Operations (reused admin session) and Admin read the identical request the
       merchant sees (cross-portal consistency).

The request is created through the real Classic Tours enquiry workflow (merchant
raises, admin answers; payment bypassed for Classic). jpw_qa only; no supplier/
payment. Operations is verified at the API level (its SPA hardcodes :8000, so the
in-browser boot can't reach :8099 — documented, not claimed as browser coverage).
"""
from __future__ import annotations

import httpx
import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.cross_portal]


def _get(base, path, token):
    r = httpx.get(base + path, headers={"Authorization": f"Bearer {token}"}, timeout=30.0)
    return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else None)


def test_request_visible_across_portals(require_server, qa_base_url, api, role_tokens, db_probe):
    from fixtures import journeys as J
    req = J.create_merchant_request("qa_x4")
    rid, rnum = req["id"], req["request_number"]
    assert rid and rnum, "request not created"

    # DB: the request persisted (match by its unique request_number).
    assert db_probe.count("service_requests", "request_number = :n", n=rnum) == 1

    # Merchant (the raiser) sees it in its own request list.
    st, body = _get(qa_base_url, "/api/requests", req["mtok"])
    assert st == 200
    items = body if isinstance(body, list) else (body.get("items") or body.get("requests") or [])
    assert any(str(x.get("request_number")) == rnum or x.get("id") == rid for x in items), \
        "merchant cannot see its own request"

    # X4: Admin reads the SAME request by id (detail wraps it under "request"),
    # same request_number/status.
    ast, abody = _get(qa_base_url, f"/api/requests/{rid}", req["atok"])
    assert ast == 200, ast
    adet = abody.get("request") or abody
    assert str(adet.get("request_number")) == rnum and adet.get("id") == rid
    admin_status = adet.get("status")

    # X5: Operations authority = reused admin session -> identical record/state.
    ost, obody = _get(qa_base_url, f"/api/requests/{rid}", role_tokens["admin"])
    odet = (obody or {}).get("request") or obody
    assert ost == 200 and str(odet.get("request_number")) == rnum
    assert odet.get("status") == admin_status, "operations/admin see a different state"

    # Authorization: a DIFFERENT merchant and the unauthenticated are refused;
    # a customer token (wrong scheme) is refused; unknown id -> 404.
    # (journeys.py already put tests/ on sys.path, so flows is importable.)
    import flows
    rival = flows.rival_merchant(req["atok"])  # a merchant of a different company
    rst, _ = _get(qa_base_url, f"/api/requests/{rid}", rival["token"])
    assert rst in (403, 404), f"rival merchant reached the request: {rst}"
    assert api.status("GET", f"/api/requests/{rid}", None) in (401, 403)
    assert api.status("GET", f"/api/requests/{rid}", role_tokens["customer"]) in (401, 403)
    assert api.status("GET", "/api/requests/999999999", req["atok"]) == 404
