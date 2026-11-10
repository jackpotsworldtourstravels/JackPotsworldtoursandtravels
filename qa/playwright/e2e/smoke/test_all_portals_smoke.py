"""Stage 4A.2 — all-portal smoke.

For each portal: (a) it loads anonymously without a fatal JS error, and (b) with
a storage-state session it boots as the role (no uncaught error, not bounced to a
login page, and any bootstrap /api call the token drives is accepted).

This is breadth, not depth: no P1 journeys or cross-portal flows here (those need
separate approval). Authorization is covered separately in e2e/authz/.

Runs under -m e2e + require_server, so it SKIPS cleanly without the isolated env.
"""
from __future__ import annotations

import pytest

# (name, url_path) — every portal shell, loaded anonymously.
ANON_PORTALS = [
    ("public", "/"),
    ("customer", "/customer/dashboard.html"),
    ("admin", "/admin/index.html"),
    ("super_admin", "/super-admin/index.html"),
    ("merchant", "/merchant/index.html"),
    ("merchant_classic", "/merchant-classic/index.html"),  # P3 / support unconfirmed
    ("manager", "/manager/index.html"),
    ("operations", "/operations/index.html"),              # role TBD -> anon smoke only
]

# (label, seeded_role, url_path) — portals we can boot signed-in. merchant_classic
# is a different UI for the SAME merchant account, so it uses the merchant role.
AUTHED_PORTALS = [
    ("customer", "customer", "/customer/dashboard.html"),
    ("admin", "admin", "/admin/index.html"),
    ("super_admin", "super_admin", "/super-admin/index.html"),
    ("merchant", "merchant", "/merchant/index.html"),
    ("merchant_classic", "merchant", "/merchant-classic/index.html"),  # P3 basic smoke
    ("manager", "manager", "/manager/index.html"),
]

pytestmark = [pytest.mark.e2e, pytest.mark.smoke]


def _settle(page):
    try:
        page.wait_for_load_state("networkidle", timeout=6000)
    except Exception:
        pass
    page.wait_for_timeout(400)


@pytest.mark.parametrize("name,path", ANON_PORTALS, ids=[p[0] for p in ANON_PORTALS])
def test_portal_loads_anonymously(require_server, page, qa_base_url, name, path):
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(qa_base_url + path, wait_until="domcontentloaded")
    _settle(page)
    assert page.title() is not None and page.title() != "", f"{name}: empty <title>"
    assert page.locator("body").count() == 1, f"{name}: no body"
    # No UNCAUGHT JS error that would blank the shell. (API 401/403 from anon
    # bootstrap calls are expected and fine here — authz is tested separately.)
    assert not errors, f"{name} uncaught pageerror: {errors[:2]}"


@pytest.mark.parametrize("label,role,path", AUTHED_PORTALS, ids=[p[0] for p in AUTHED_PORTALS])
def test_portal_boots_authenticated(new_authed_page, qa_base_url, label, role, path):
    page = new_authed_page(role)
    errors: list[str] = []
    api_responses: list[tuple[int, str]] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response",
            lambda r: api_responses.append((r.status, r.url)) if "/api/" in r.url else None)

    page.goto(qa_base_url + path, wait_until="domcontentloaded")
    _settle(page)

    assert not errors, f"{label} uncaught pageerror: {errors[:2]}"
    # The injected session must not bounce the shell to a login page.
    assert "login" not in page.url.lower(), f"{label} redirected to login: {page.url}"
    # If the shell drove any authed API calls, the token must have worked for at
    # least one (proves the storage-state session was accepted). A shell that
    # makes no /api call on boot is allowed.
    if api_responses:
        ok = [s for s, _ in api_responses if 200 <= s < 300]
        assert ok, f"{label} no successful /api call on boot: {api_responses[:5]}"
