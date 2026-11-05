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
from fixtures import auth as authlib  # noqa: E402
from viewports import VIEWPORTS, context_args  # noqa: E402


def pytest_configure(config):
    for marker in (
        "smoke: offline scaffold self-check (no server needed)",
        "e2e: live-server end-to-end (needs the isolated :8099 env)",
        "visual: screenshot baseline comparison",
        "a11y: accessibility (axe-core) scan",
        "workflow: multi-step customer/admin/merchant journey",
        "cross_portal: data-consistency across portals",
        "authz: authorization / access-control checks (API level)",
        "journey: P1 end-to-end user journey (UI + API + DB)",
        "leak: intentional worst-case leak DEMO that fails on purpose — excluded "
        "from the normal suite (-m e2e and the default -m 'not leak'); run with -m leak",
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


# ===========================================================================
# Stage 4A harness hardening
# ===========================================================================
@pytest.fixture(scope="session")
def worker_ns(worker_id="master") -> str:
    """A short per-worker namespace so parallel specs never collide on data.

    `worker_id` is injected by pytest-xdist when present; defaults to 'master'.
    """
    import os
    wid = os.environ.get("PYTEST_XDIST_WORKER", "master")
    return f"{wid}{os.getpid() % 1000:03d}"


@pytest.fixture(scope="session")
def api():
    """API client for authorization checks (status codes)."""
    c = authlib.Api()
    yield c
    c.close()


@pytest.fixture(scope="session")
def db_probe(server_available):
    """Read-only, safety-gated DB probe for verifying persisted state in journeys."""
    if not server_available:
        pytest.skip("Isolated test server not running on JPW_QA_BASE.")
    from fixtures.db import DbProbe
    return DbProbe()


@pytest.fixture(scope="session")
def role_tokens(server_available) -> dict:
    """Cache one token per role for the session (authz checks).

    Staff/merchant from seeded accounts; a fresh throwaway customer; plus an
    invalid and an expired token to exercise the refusal paths. Session-scoped so
    it logs in once (sidestepping the per-IP login/signup rate limit); gated on
    the session-scoped `server_available` to skip cleanly without the env.
    """
    if not server_available:
        pytest.skip("Isolated test server not running on JPW_QA_BASE.")
    toks = {}
    for role in ("admin", "super_admin", "manager", "merchant"):
        try:
            toks[role] = authlib.staff_tokens(role)["access"]
        except Exception as exc:  # pragma: no cover - surfaced in the test
            toks[role] = None
            toks[f"{role}__error"] = str(exc)[:120]
    try:
        toks["customer"] = authlib.create_customer("authz")["access"]
    except Exception as exc:
        toks["customer"] = None
        toks["customer__error"] = str(exc)[:120]
    toks["invalid"] = "not.a.real.token"
    toks["expired"] = authlib.expired_staff_token()
    return toks


@pytest.fixture(scope="session")
def customer_session(server_available, worker_ns) -> dict:
    """One throwaway customer for the session (signup + dev-OTP). Reused so the
    per-IP signup limit is not stressed. Returns {access, refresh, customer, email}."""
    if not server_available:
        pytest.skip("Isolated test server not running on JPW_QA_BASE.")
    return authlib.create_customer(f"sess{worker_ns}")


@pytest.fixture
def new_authed_page(require_server, browser, worker_ns):
    """Factory: new_authed_page(role) -> a Page whose browser context starts
    signed-in as `role` (storage-state injection; no login replay)."""
    contexts = []

    def _make(role: str):
        state = authlib.storage_state_for(role, ns=worker_ns)
        ctx = browser.new_context(storage_state=state)
        contexts.append(ctx)
        return ctx.new_page()

    yield _make
    for ctx in contexts:
        try:
            ctx.close()
        except Exception:
            pass


def collect_responses(page):
    """Record same-origin /api/* response statuses during a page's lifetime."""
    seen: list[tuple[int, str]] = []
    page.on("response", lambda r: seen.append((r.status, r.url))
            if "/api/" in r.url else None)
    page._qa_api_responses = seen
    return seen


@pytest.fixture(scope="session", autouse=True)
def _cleanup_qa_customers(qa_base_url):
    """Best-effort, SAFETY-GATED cleanup of customers this run created.

    Runs only against a local, disposable jpw_qa database (same gate the shell
    script uses); never touches production, RDS or another project's DB. Failures
    are swallowed — the container is disposable and the ultimate cleanup.
    """
    yield
    import os
    url = os.environ.get("DATABASE_URL", "")
    low = url.lower()
    host_ok = ("@localhost:" in low) or ("@127.0.0.1:" in low)
    db_ok = low.rstrip("/").endswith("jpw_qa") or low.rstrip("/").endswith("_qa")
    if not (host_ok and db_ok):
        return  # refuse to delete anything outside a local *_qa database
    emails = list(authlib.CREATED_CUSTOMER_EMAILS)
    if not emails:
        return
    try:
        import sys as _sys
        root = str(authlib.REPO_ROOT / "backend")
        if root not in _sys.path:
            _sys.path.insert(0, root)
        from sqlalchemy import text
        from app.database.session import SessionLocal  # type: ignore
        with SessionLocal() as db:
            db.execute(text("DELETE FROM customers WHERE email = ANY(:e)"),
                       {"e": emails})
            db.commit()
    except Exception:
        pass  # best-effort only; disposable container is the real cleanup


@pytest.fixture
def super_admin_session(require_server, api_client):
    return api_client.login_role("super_admin")
