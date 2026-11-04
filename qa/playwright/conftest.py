"""Shared Playwright fixtures for the QA suite.

Design goals:
- Reuse the existing account model (tests/config.py) via ApiClient.
- Degrade gracefully: when no isolated server is running, live tests SKIP
  (never fail, never silently pass) so the scaffold is usable before the DB
  exists. Unexecuted E2E is reported as skipped/blocked, per Stage-3 rules.
- Per-viewport contexts, console-error capture, screenshot/trace on failure.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from fixtures.api_seed import ApiClient  # noqa: E402
from viewports import VIEWPORTS, context_args  # noqa: E402


def pytest_configure(config):
    for marker in (
        "smoke: offline scaffold self-check (no server needed)",
        "e2e: live-server end-to-end (needs the isolated :8099 env)",
        "visual: screenshot baseline comparison",
        "a11y: accessibility (axe-core) scan",
        "workflow: multi-step customer/admin/merchant journey",
        "cross_portal: data-consistency across portals",
    ):
        config.addinivalue_line("markers", marker)


@pytest.fixture(scope="session")
def qa_base_url() -> str:
    return os.environ.get("JPW_QA_BASE", "http://127.0.0.1:8099").rstrip("/")


@pytest.fixture(scope="session")
def api_client(qa_base_url) -> ApiClient:
    c = ApiClient(qa_base_url)
    yield c
    c.close()


@pytest.fixture(scope="session")
def server_available(api_client) -> bool:
    return api_client.health()


@pytest.fixture
def require_server(server_available):
    """Use in live tests: skips (does NOT fail) when the isolated env is down."""
    if not server_available:
        pytest.skip("Isolated test server not running on JPW_QA_BASE "
                    "(start it with qa/scripts/start_test_env — see LOCAL_ENV docs).")


@pytest.fixture
def collect_console(page):
    """Attach a console-error collector to the page. Returns the live list."""
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page._qa_console_errors = errors  # read by BasePage.console_errors()
    return errors


@pytest.fixture
def set_viewport(page):
    """Callable: set_viewport('mobile-390') resizes the current page."""
    def _apply(name: str):
        v = VIEWPORTS[name]
        page.set_viewport_size({"width": v["width"], "height": v["height"]})
        return v
    return _apply


# Parametrized viewport fixture for responsive sweeps (opt-in via indirect use).
@pytest.fixture(params=list(VIEWPORTS), ids=list(VIEWPORTS))
def viewport_name(request):
    return request.param


# --- role sessions (live) ------------------------------------------------
@pytest.fixture
def admin_session(require_server, api_client):
    return api_client.login_role("admin")


@pytest.fixture
def merchant_session(require_server, api_client):
    return api_client.login_role("merchant")


@pytest.fixture
def manager_session(require_server, api_client):
    return api_client.login_role("manager")


@pytest.fixture
def super_admin_session(require_server, api_client):
    return api_client.login_role("super_admin")
