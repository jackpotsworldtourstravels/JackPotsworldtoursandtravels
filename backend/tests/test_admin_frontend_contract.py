"""Static CONTRACT check: every ``/api/...`` call the Admin Portal and Operations
workspace make must exist in the backend's real route table with the same HTTP method.

This is the class of defect that produced DEFECT-1 (the picker asking for
``page_size=200`` against a ``le=100`` endpoint is a *parameter* contract; this test
covers the *route + verb* contract, and also pins the broadcast request shape).

Nothing is executed against a server: the frontend JS is read as text and compared with
``app.openapi()``.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.main import app

ROOT = Path(__file__).resolve().parents[2]
JS_FILES = sorted((ROOT / "frontend" / "assets" / "js").glob("admin*.js")) + [
    ROOT / "frontend" / "shared" / "ops-api.js",
]

# axios.get(`${API_BASE}/api/admin/x/${id}`  /  axios.post(`${API_BASE}/api/...`
_AXIOS = re.compile(
    r"axios\.(get|post|put|patch|delete)\(\s*`\$\{API_BASE\}(/api/[^`?]*)", re.S)
# ops-api.js: this._req('post', '/api/admin/...'  /  `/api/.../${id}`
_OPS = re.compile(r"_req\(\s*'(get|post|put|patch|delete)'\s*,\s*[`']((?:/api/)[^`'?]*)", re.S)


def _norm(path: str) -> str:
    path = re.sub(r"\$\{[^}]*\}", "{}", path)          # JS interpolation
    path = re.sub(r"\{[^}]*\}", "{}", path)             # OpenAPI params
    return path.rstrip("/") or "/"


def _backend_routes() -> set[tuple[str, str]]:
    routes = set()
    for path, ops in app.openapi()["paths"].items():
        for method in ops:
            if method in {"get", "post", "put", "patch", "delete"}:
                routes.add((method, _norm(path)))
    return routes


def _frontend_calls() -> set[tuple[str, str, str]]:
    calls = set()
    for f in JS_FILES:
        text = f.read_text(encoding="utf-8")
        for rx in (_AXIOS, _OPS):
            for m in rx.finditer(text):
                path = m.group(2)
                calls.add((m.group(1), _norm(path), f.name))
    return calls


def test_every_frontend_admin_call_has_a_backend_route():
    routes = _backend_routes()
    missing = sorted(
        f"{method.upper()} {path}  ({fname})"
        for method, path, fname in _frontend_calls()
        # A path that is wholly a template variable (e.g. `${action}`) cannot be resolved statically.
        if "{}" not in path.split("/api/", 1)[-1].split("/")[0]
        and (method, path) not in routes
        # Dynamic tail segments like /requests/{}/${action} resolve to a family of routes.
        and not path.endswith("/{}")
        # A variable glued onto a literal (`/communication${suffix}`) is a helper building the
        # URL at runtime; it cannot be resolved statically.
        and not re.search(r"[A-Za-z_\-]\{\}", path)
    )
    assert not missing, "Frontend calls with no matching backend route:\n" + "\n".join(missing)


def test_the_scan_actually_finds_calls():
    # Guards against the regexes silently matching nothing (which would make the test vacuous).
    calls = _frontend_calls()
    assert len(calls) > 60
    assert ("post", "/api/admin/notifications/broadcast", "admin.js") in calls
    assert ("post", "/api/admin/customers/{}/{}", "admin-b2c-customers.js") in calls


def test_broadcast_frontends_send_send_to_all_explicitly():
    admin = (ROOT / "frontend/assets/js/admin.js").read_text(encoding="utf-8")
    ops_api = (ROOT / "frontend/shared/ops-api.js").read_text(encoding="utf-8")
    ops_ui = (ROOT / "frontend/operations/js/ops-settings.js").read_text(encoding="utf-8")
    assert "send_to_all" in admin and "send_to_all" in ops_api
    assert "sendToAll" in ops_ui
    # Neither client may reintroduce "omit merchant_ids == everyone".
    assert "merchant_ids && merchantIds.length ? merchantIds : undefined" not in ops_api


@pytest.mark.parametrize("html,tokens", [
    ("frontend/admin/index.html", ["assets/js/admin.js?v=", "assets/js/admin-b2c-customers.js?v="]),
    ("frontend/operations/index.html", ["shared/ops-api.js?v=", "js/ops-settings.js?v="]),
])
def test_changed_scripts_carry_a_cache_busting_version(html, tokens):
    text = (ROOT / html).read_text(encoding="utf-8")
    for t in tokens:
        assert t in text, f"{html} must reference {t}<version>"


# ---------------------------------------------------------------- Phase 13
def test_phase13_scripts_were_re_versioned():
    """Every script changed in Phase 13 carries the new cache-busting token, so a browser holding the old copy
    (which offered every status, opened the chat console for anyone, etc.) is forced to re-fetch."""
    text = (ROOT / "frontend/admin/index.html").read_text(encoding="utf-8")
    for script in ("admin.js", "admin-live-support.js", "admin-b2c-bookings.js", "admin-b2c-reports.js"):
        m = re.search(r"assets/js/" + re.escape(script) + r"\?v=([A-Za-z0-9]+)", text)
        assert m, script
        assert m.group(1).startswith("20261117p13"), (script, m.group(1))


def test_phase13_booking_controls_offer_only_backend_allowed_transitions():
    js = (ROOT / "frontend/assets/js/admin-b2c-bookings.js").read_text(encoding="utf-8")
    # gated on the manage scope via the shared admin.js helper
    assert "adminCan('b2c.customers.manage')" in js
    m = re.search(r"const BKG_ALLOWED_TARGETS = \{(.*?)\};", js, re.S)
    assert m, "transition table missing"
    table = dict(re.findall(r"(\w+):\s*\[([^\]]*)\]", m.group(1)))
    targets = {k: set(re.findall(r"'(\w+)'", v)) for k, v in table.items()}
    assert targets == {"pending": {"confirmed", "cancelled"}, "confirmed": {"cancelled"}}, targets
    # no hard-coded list of all four statuses any more (that list offered Confirmed -> Completed and reopening)
    assert "['pending', 'confirmed', 'cancelled', 'completed']" not in js


def test_phase13_live_support_respects_server_refusals():
    js = (ROOT / "frontend/assets/js/admin-live-support.js").read_text(encoding="utf-8")
    admin = (ROOT / "frontend/assets/js/admin.js").read_text(encoding="utf-8")
    assert "event.code === 4403" in js, "a 4403 close must stop the reconnect loop"
    assert "error.status === 403" in js, "a 403 from /ws-ticket must not be retried"
    assert "adminCan('b2c.chat.manage')" in admin, "the console boots only for eligible agents"


def test_phase13_report_downloads_need_both_export_codes():
    js = (ROOT / "frontend/assets/js/admin-b2c-reports.js").read_text(encoding="utf-8")
    assert "adminCan('b2c.reports.export')" in js and "adminCan('b2c.customers.export')" in js
