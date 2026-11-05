"""Regression: GET /api/customer/packages must reject an invalid `month` with a
clean 422, not an unhandled ValueError (HTTP 500).

THE BUG (Stage-3 finding). `month` carries a Query pattern of ``^\\d{4}-\\d{2}$``,
which gates the *shape* but still admits ``2026-13`` / ``2026-00`` (and year
``0000``). Those reached ``search_packages()``'s
``dt.date.fromisoformat(month + "-01")``, which raised ``ValueError: month must
be in 1..12`` with no handler — so the endpoint answered **500** instead of 422.

These tests pin the behaviour at the HTTP boundary. The invalid-month cases are
refused BEFORE any database access, so no package schema is needed; the valid /
missing cases are allowed through to the catalogue layer, which is stubbed to
return nothing so the test stays about validation, not catalogue data.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.database.session import get_db
from app.main import app
from app.routers import customer_package_bookings as router_mod

PKG = "/api/customer/packages"


@pytest.fixture()
def client(monkeypatch):
    # The endpoint is public (no auth). Stub the catalogue calls so a request that
    # PASSES validation returns 200 with an empty list, without touching a real DB
    # or the package tables. Invalid-month requests never reach these.
    monkeypatch.setattr(router_mod.catalog, "search_packages", lambda *a, **k: [])
    monkeypatch.setattr(router_mod.catalog, "countries", lambda *a, **k: {})

    # get_db is still resolved by FastAPI; yield a sentinel that is never used
    # (both catalogue functions above are stubbed).
    app.dependency_overrides[get_db] = lambda: iter([object()])
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_valid_month_is_accepted(client):
    r = client.get(PKG, params={"month": "2026-11"})
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_missing_month_is_accepted(client):
    # `month` is optional in the API contract (Query default None).
    r = client.get(PKG)
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_month_13_is_rejected_422(client):
    r = client.get(PKG, params={"month": "2026-13"})
    assert r.status_code == 422, r.text
    assert "2026-13" in r.text


def test_month_00_is_rejected_422(client):
    r = client.get(PKG, params={"month": "2026-00"})
    assert r.status_code == 422, r.text
    assert "2026-00" in r.text


def test_year_0000_is_rejected_422(client):
    # \d{4} admits 0000, which date() rejects (year must be >= 1).
    r = client.get(PKG, params={"month": "0000-05"})
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("bad", ["2026-1", "2026-011", "March", "2026/11", "2026-11-01", ""])
def test_invalid_format_is_rejected_422(client, bad):
    # These fail the Query `pattern` (shape) and are refused by FastAPI itself.
    r = client.get(PKG, params={"month": bad})
    assert r.status_code == 422, f"{bad!r} -> {r.status_code} {r.text}"


def test_no_invalid_month_ever_returns_500(client):
    # The whole point: an out-of-range month is a client error, never a server one.
    for bad in ("2026-13", "2026-00", "0000-05"):
        r = client.get(PKG, params={"month": bad})
        assert r.status_code != 500, f"{bad!r} produced a 500"
