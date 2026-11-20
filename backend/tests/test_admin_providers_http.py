"""HTTP-level verification of Admin PROVIDER MANAGEMENT (supplier directory — records only; no
supplier action, booking or payment is performed): create / rename / activate-deactivate a
provider, add / edit / deactivate a person, uniqueness rules, validation, permissions, audit.

Real router + services on throw-away SQLite data. The PRD### code comes from a PostgreSQL
sequence (``seq_provider_code``); the harness emulates ``nextval``. Case-insensitive uniqueness
that PostgreSQL enforces with an index (if any) is checked here at the application layer only.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models_v2 import Provider, ProviderUser, SystemLog, UserRole
from app.routers import providers as providers_router
from tests._v2_harness import Harness

BASE = "/api/admin"


@pytest.fixture()
def h():
    harness = Harness(providers_router.router)
    yield harness
    harness.dispose()


@pytest.fixture()
def admin(h):
    return h.user(UserRole.ADMIN, name="Ada Admin")


def _actions(h):
    db = h.db()
    out = [(l.action, l.user_id) for l in db.scalars(select(SystemLog)).all()]
    db.close()
    return out


def _add(h, admin, name="Skyline Travels"):
    return h.client.post(f"{BASE}/providers", json={"provider_name": name}, headers=admin["headers"])


def test_create_provider_allocates_a_code_persists_and_audits(h, admin):
    r = _add(h, admin)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["provider_code"].startswith("PRD") and body["provider_name"] == "Skyline Travels"
    assert body["status"] in ("active", "Active")
    db = h.db()
    p = db.get(Provider, body["id"])
    assert p is not None and p.provider_name == "Skyline Travels"
    db.close()
    assert any(a[1] == admin["id"] for a in _actions(h)), "an actor-attributed audit entry is written"


def test_client_cannot_supply_the_provider_code(h, admin):
    r = h.client.post(f"{BASE}/providers", json={"provider_name": "Code Co", "provider_code": "HACK1"},
                      headers=admin["headers"])
    assert r.status_code in (201, 422)
    if r.status_code == 201:
        assert r.json()["provider_code"] != "HACK1"


@pytest.mark.parametrize("name", ["", "   "], ids=["empty", "blank"])
def test_blank_provider_name_is_rejected(h, admin, name):
    """Regression for DEFECT-3: "   " passed min_length=2, was stripped to "" and stored."""
    r = _add(h, admin, name)
    assert r.status_code in (400, 422), r.text
    db = h.db()
    assert db.scalars(select(Provider)).all() == []
    db.close()


def test_provider_name_is_unique_case_insensitively(h, admin):
    assert _add(h, admin, "Skyline Travels").status_code == 201
    dup = _add(h, admin, "SKYLINE travels")
    assert dup.status_code in (400, 409), dup.text
    db = h.db()
    assert len(db.scalars(select(Provider)).all()) == 1
    db.close()


def test_rename_and_deactivate_provider_keeps_the_record(h, admin):
    pid = _add(h, admin).json()["id"]
    r = h.client.patch(f"{BASE}/providers/{pid}", json={"provider_name": "Skyline Holidays"},
                       headers=admin["headers"])
    assert r.status_code == 200 and r.json()["provider_name"] == "Skyline Holidays"
    r = h.client.patch(f"{BASE}/providers/{pid}", json={"status": "inactive"}, headers=admin["headers"])
    assert r.status_code == 200, r.text
    db = h.db()
    p = db.get(Provider, pid)
    assert p is not None and str(getattr(p.status, "value", p.status)) == "inactive"
    db.close()
    assert h.client.patch(f"{BASE}/providers/{pid}", json={"status": "bogus"},
                          headers=admin["headers"]).status_code == 422
    assert h.client.patch(f"{BASE}/providers/424242", json={"provider_name": "Xy"},
                          headers=admin["headers"]).status_code == 404


def test_there_is_no_delete_endpoint_for_providers(h, admin):
    pid = _add(h, admin).json()["id"]
    assert h.client.delete(f"{BASE}/providers/{pid}", headers=admin["headers"]).status_code in (404, 405)


def test_provider_person_lifecycle_and_uniqueness_within_a_provider(h, admin):
    a = _add(h, admin, "Alpha Air").json()["id"]
    b = _add(h, admin, "Beta Bus").json()["id"]
    mk = lambda pid, email: h.client.post(
        f"{BASE}/providers/{pid}/users",
        json={"user_name": "John Doe", "email": email, "phone_number": "9000000000"},
        headers=admin["headers"])
    r = mk(a, "john@alpha.qa-mail.com")
    assert r.status_code == 201, r.text
    uid = r.json()["id"]
    assert mk(a, "john@alpha.qa-mail.com").status_code in (400, 409), "duplicate within a provider"
    assert mk(b, "john@alpha.qa-mail.com").status_code == 201, "the same email at another provider is allowed"
    ed = h.client.patch(f"{BASE}/provider-users/{uid}", json={"user_name": "Johnny Doe"}, headers=admin["headers"])
    assert ed.status_code == 200 and ed.json()["user_name"] == "Johnny Doe"
    off = h.client.patch(f"{BASE}/provider-users/{uid}", json={"status": "inactive"}, headers=admin["headers"])
    assert off.status_code == 200
    db = h.db()
    assert str(getattr(db.get(ProviderUser, uid).status, "value", None)) == "inactive"
    db.close()


@pytest.mark.parametrize("body", [{"email": "x@y.qa-mail.com"}, {"user_name": "A"},
                                  {"user_name": "A", "email": "not-an-email"}],
                         ids=["no-name", "no-email", "bad-email"])
def test_provider_person_validation(h, admin, body):
    pid = _add(h, admin).json()["id"]
    assert h.client.post(f"{BASE}/providers/{pid}/users", json=body, headers=admin["headers"]).status_code == 422
    assert h.client.post(f"{BASE}/providers/424242/users",
                         json={"user_name": "Al", "email": "a@b.qa-mail.com"},
                         headers=admin["headers"]).status_code == 404


def test_provider_writes_require_provider_manage(h, admin):
    pid = _add(h, admin).json()["id"]
    calls = [("post", f"{BASE}/providers", {"provider_name": "Zed"}),
             ("patch", f"{BASE}/providers/{pid}", {"provider_name": "Qq"}),
             ("post", f"{BASE}/providers/{pid}/users", {"user_name": "Al", "email": "a@b.qa-mail.com"}),
             ("patch", f"{BASE}/provider-users/1", {"user_name": "Qq"})]
    for method, url, body in calls:
        assert getattr(h.client, method)(url, json=body).status_code == 401, url
    for role in (UserRole.MANAGER, UserRole.MERCHANT_ADMIN):
        who = h.user(role, name="No Access")
        for method, url, body in calls:
            r = getattr(h.client, method)(url, json=body, headers=who["headers"])
            assert r.status_code == 403, (role, url, r.status_code)
    db = h.db()
    assert [p.provider_name for p in db.scalars(select(Provider)).all()] == ["Skyline Travels"]
    db.close()
