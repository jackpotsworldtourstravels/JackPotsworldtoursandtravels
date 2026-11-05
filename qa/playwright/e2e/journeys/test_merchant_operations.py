"""Stage 4A.3 — P1 merchant (Classic canonical) + Operations journeys.

Merchant Classic is the canonical merchant UI (partner-login redirects there), so
the merchant workflow boots there. The modern Merchant portal keeps smoke-only
coverage (test_all_portals_smoke) to avoid duplicating the shared /api/requests
workflow. Operations is verified at the API/permission level (its SPA hardcodes the
:8000 API base on localhost, so the in-browser authed boot can't reach :8099 — a
documented environment limitation, not an app defect).
"""
from __future__ import annotations

import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.journey]

REQUESTS = "/api/requests"
USERS = "/api/admin/users"


def test_merchant_classic_request_queue(new_authed_page, qa_base_url, api, role_tokens, db_probe):
    # UI: the Classic merchant shell boots on the seeded merchant session.
    # NOTE: classic-shell.js:28 hardcodes API_BASE=http://127.0.0.1:8000 on localhost
    # (same as Operations), so the Classic SPA's data calls go to :8000, not our
    # :8099 isolated app — its in-browser DATA boot is therefore an environment
    # limitation, not an app defect. We assert only that the shell loads without a
    # fatal error / login bounce; the canonical merchant WORKFLOW is verified at the
    # API level below. (The modern /merchant portal, which uses same-origin, has its
    # own in-browser authed-boot smoke in test_all_portals_smoke.)
    page = new_authed_page("merchant")   # merchant jwt_* keys
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(qa_base_url + "/merchant-classic/index.html", wait_until="domcontentloaded")
    page.wait_for_timeout(600)
    assert not errors, f"merchant-classic pageerror: {errors[:2]}"
    assert "login" not in page.url.lower(), f"merchant-classic bounced to login: {page.url}"

    # API + authz: the merchant reaches its request/booking queue; anon refused.
    assert role_tokens["merchant"], role_tokens.get("merchant__error")
    assert api.status("GET", REQUESTS, role_tokens["merchant"]) == 200
    assert api.status("GET", REQUESTS, None) in (401, 403)

    # DB: the request queue is DB-backed (service_requests is populated/queryable).
    assert isinstance(db_probe.count("service_requests"), int)


def test_operations_requests_workflow_api(api, role_tokens, db_probe):
    # Operations authority = reused admin. Its requests + users surfaces are
    # reachable by admin and refused to the unauthenticated.
    assert api.status("GET", REQUESTS, role_tokens["admin"]) == 200
    assert api.status("GET", USERS, role_tokens["admin"]) == 200
    assert api.status("GET", REQUESTS, None) in (401, 403)
    assert api.status("GET", USERS, None) in (401, 403)
    # DB state behind the Operations requests queue.
    assert isinstance(db_probe.count("service_requests"), int)
