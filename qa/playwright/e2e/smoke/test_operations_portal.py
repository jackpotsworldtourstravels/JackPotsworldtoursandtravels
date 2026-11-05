"""Stage 4A.2 (follow-up) — Operations portal smoke + permission gates.

Operations is PERMISSION-DRIVEN, not role-driven (ops-core.js): no role/namespace
of its own, it adopts an existing admin/super_admin session and takes its
authority from /api/auth/me. We reuse the seeded ADMIN account — no new role, no
backend change.

IMPORTANT ENVIRONMENT LIMITATION (verified, not an app defect):
ops-core.js:23 hardcodes `OPS_API_BASE = 'http://127.0.0.1:8000'` on localhost, so
the Operations SPA calls its API on :8000 regardless of where the page is served.
Our isolated app runs on :8099, so the in-browser authed boot cannot reach the API
and redirects to `session-expired`. The browser-boot check is therefore SKIPPED
with that reason recorded, and Operations is verified at the API/permission level
instead (which is portable and is the substantive "permission gates + API access"
check). The static shell still loads anonymously (see test_all_portals_smoke).

Permission model confirmed live:
  /api/admin/users, /api/requests  -> anon 403, merchant 200, admin 200  (shared ops surface)
  /api/admin/customers             -> anon 403, merchant 403, admin 200  (admin-only surface)
  /api/super-admin/admins          -> anon 403, admin 403               (super-admin-only)

Runs under -m e2e + require_server, so it SKIPS cleanly without the isolated env.
"""
from __future__ import annotations

import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.smoke]

# Endpoints the Operations SPA drives (frontend/operations/js/*) that admin reaches.
OPS_SHARED_ENDPOINTS = ["/api/admin/users", "/api/requests"]


def test_operations_identity_is_staff(api, role_tokens):
    # ops-core reads /api/auth/me as its authority; the reused admin session must
    # resolve to a staff role the portal admits (admin/super_admin).
    status, body = api.get_json("/api/auth/me", role_tokens["admin"])
    assert status == 200, status
    assert (body or {}).get("role") in ("admin", "super_admin"), body


@pytest.mark.parametrize("path", OPS_SHARED_ENDPOINTS)
def test_operations_shared_surface_admin_allowed_anon_refused(api, role_tokens, path):
    # Positive API access for the Operations authority; unauthenticated refused.
    assert api.status("GET", path, role_tokens["admin"]) == 200, f"admin denied {path}"
    assert api.status("GET", path, None) in (401, 403), f"anon reached {path}"


def test_operations_admin_only_surface_gates_merchant(api, role_tokens):
    # An admin-only Operations surface: admin in, merchant and anon out.
    p = "/api/admin/customers"
    assert api.status("GET", p, role_tokens["admin"]) == 200
    assert api.status("GET", p, None) in (401, 403)
    assert role_tokens["merchant"], role_tokens.get("merchant__error")
    assert api.status("GET", p, role_tokens["merchant"]) in (401, 403)


def test_operations_superadmin_only_surface_gates_admin(api, role_tokens):
    # Permission-driven gating cuts both ways: even the Operations admin is
    # refused a super-admin-only surface (proves no role is implicitly omnipotent).
    assert api.status("GET", "/api/super-admin/admins", role_tokens["admin"]) in (401, 403)


@pytest.mark.skip(reason="ops-core.js:23 hardcodes OPS_API_BASE=http://127.0.0.1:8000 on "
                         "localhost; the isolated app runs on :8099, so the in-browser authed "
                         "boot cannot reach the API. Covered at the API level above. See report.")
def test_operations_boots_in_browser(new_authed_page, qa_base_url):  # pragma: no cover
    page = new_authed_page("operations")
    page.goto(qa_base_url + "/operations/index.html", wait_until="domcontentloaded")
    assert "login" not in page.url.lower()
