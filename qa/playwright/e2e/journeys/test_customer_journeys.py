"""Stage 4A.3 — P1 customer journeys (UI + API + DB + validation/error).

Constraints honored: local seeded data + jpw_qa only; no supplier APIs; customer
sign-up uses dev-OTP echo (NO real OTP); no payments; no app code / no data-testid.
Assertions prefer response-capture + DB probes over brittle toast selectors.
"""
from __future__ import annotations

import time
import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.journey]


# C1 — Registration: form renders (UI), account created via real signup+dev-OTP
#      (API), and the row is persisted (DB).
def test_customer_registration_persists(require_server, page, qa_base_url, db_probe):
    # UI: the registration form is present with its core fields.
    page.goto(qa_base_url + "/register.html", wait_until="domcontentloaded")
    page.wait_for_timeout(500)
    for sel in ("input#firstName, input[name='firstName']",
                "input#email, input[name='email']",
                "input#password, input[name='password']"):
        assert page.locator(sel).first.count() == 1, f"register missing {sel}"
    assert page.get_by_role("button", name="Register").count() >= 1

    # API: create an account through the real signup + dev-OTP path (no real OTP).
    from fixtures import auth as A
    sess = A.create_customer("c1reg")
    cid = (sess["customer"] or {}).get("id")
    assert cid, "signup returned no customer id"

    # DB: the customer row and its auth row persisted in jpw_qa.
    assert db_probe.count("customers", "customer_id = :c", c=cid) == 1
    assert db_probe.count("customer_auth", "customer_id = :c", c=cid) == 1
    assert db_probe.count("customers", "email = :e", e=sess["email"]) == 1


# C2 — Authenticated account (UI) + error handling (API): the authed dashboard
#      renders the customer's own account, and a wrong current password is refused
#      by the API under the customer's own token (authorization + error handling).
def test_customer_dashboard_renders_and_wrong_password_refused(require_server, browser,
                                                               qa_base_url, api, customer_session):
    from fixtures import auth as A
    ctx = browser.new_context(storage_state=A.storage_state_from_customer(customer_session))
    page = ctx.new_page()
    try:
        page.goto(qa_base_url + "/customer/dashboard.html", wait_until="domcontentloaded")
        page.wait_for_timeout(800)
        assert "login" not in page.url.lower(), f"customer bounced to login: {page.url}"
        # The authed account UI is present (Change Password control).
        assert page.get_by_role("button", name="UPDATE PASSWORD").count() >= 1
    finally:
        ctx.close()

    # Error handling + authorization at the API, as the SAME customer: a wrong
    # current password must be refused (4xx), never a 5xx or a silent success.
    import httpx
    r = httpx.post(qa_base_url + "/api/customer/auth/change-password",
                   headers={"Authorization": f"Bearer {customer_session['access']}"},
                   json={"current_password": "WrongCurrent#1",
                         "new_password": "BrandNew#2026",
                         "confirm_password": "BrandNew#2026"}, timeout=30.0)
    assert 400 <= r.status_code < 500, f"expected 4xx for wrong current password, got {r.status_code}"


# C3 — Search: the booking card switches products (UI) and the Tour Packages
#      catalogue renders from seeded data (API), with no console errors.
def test_customer_search_products_and_packages(require_server, page, qa_base_url):
    console_errors: list[str] = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

    page.goto(qa_base_url + "/index.html", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)
    # Switch the booking card to Hotels, then Tour Packages.
    page.get_by_role("tab", name="Hotels").first.click()
    assert page.get_by_placeholder("City, area, hotel or resort").first.is_visible()
    page.get_by_role("tab", name="Tour Packages").first.click()
    page.wait_for_timeout(300)

    # The packages catalogue page is backed by the real (seeded) package DB.
    with page.expect_response(lambda r: "/api/customer/packages" in r.url and r.request.method == "GET") as rinfo:
        page.goto(qa_base_url + "/packages.html", wait_until="domcontentloaded")
    resp = rinfo.value
    assert resp.status == 200, f"packages list {resp.status}"
    body = resp.json()
    assert isinstance(body, list) and len(body) > 0, "no seeded packages returned"
    page.wait_for_timeout(500)
    # No uncaught console errors while rendering the catalogue.
    assert not console_errors, f"console errors: {console_errors[:3]}"
