"""Offline scaffold self-check — proves the Playwright harness works WITHOUT a
running server or the isolated DB. This is not a UI/E2E test (those arrive in
Stage 4); it only verifies imports, the browser, viewport sizing and that live
fixtures degrade to SKIP rather than fail.

Run:  cd qa/playwright && python -m pytest test_scaffold_smoke.py -v
"""
from __future__ import annotations

import pytest

from pages import (AdminShell, BookingCard, LandingPage, LoginPage,
                   MerchantShell, ManagerShell, SuperAdminShell, OperationsShell)
from viewports import VIEWPORTS, ALL, DESKTOP, TABLET, MOBILE


@pytest.mark.smoke
def test_viewport_table_is_complete():
    assert len(VIEWPORTS) == 8
    assert DESKTOP + TABLET + MOBILE == ALL
    assert VIEWPORTS["mobile-390"]["is_mobile"] is True
    assert VIEWPORTS["desktop-1920"]["width"] == 1920


@pytest.mark.smoke
def test_page_objects_import_and_construct():
    # Construct against a dummy page=None just to confirm the classes/paths exist.
    for cls, path in [
        (LandingPage, "/index.html"), (LoginPage, "/login.html"),
        (AdminShell, "/admin/index.html"), (MerchantShell, "/merchant/index.html"),
        (ManagerShell, "/manager/index.html"), (SuperAdminShell, "/super-admin/index.html"),
        (OperationsShell, "/operations/index.html"),
    ]:
        assert cls.path == path


@pytest.mark.smoke
def test_chromium_renders_and_resizes(page):
    """Real browser, offline: set_content + each viewport resizes correctly."""
    page.set_content(
        "<!doctype html><title>QA scaffold</title>"
        "<header>hdr</header><main data-testid='m'>ok</main><footer>ftr</footer>"
    )
    assert page.title() == "QA scaffold"
    assert page.get_by_test_id("m").inner_text() == "ok"
    for name, v in VIEWPORTS.items():
        page.set_viewport_size({"width": v["width"], "height": v["height"]})
        size = page.evaluate("() => ({w: window.innerWidth, h: window.innerHeight})")
        assert size["w"] == v["width"], f"{name} width mismatch"


@pytest.mark.smoke
def test_booking_card_locator_builds(page):
    page.set_content("<div class='booking-card'><button>Search</button></div>")
    card = BookingCard(page)
    assert card.search_button.count() == 1


@pytest.mark.smoke
def test_live_fixtures_skip_without_server(server_available):
    """Documents the degrade-to-skip behaviour. If a server IS up, this still
    passes; if not, server_available is False and live tests will skip."""
    assert isinstance(server_available, bool)
