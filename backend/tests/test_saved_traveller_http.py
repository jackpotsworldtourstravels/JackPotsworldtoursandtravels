"""The saved-traveller routes, over real HTTP (FastAPI's TestClient) rather than by calling the handlers.

What only the HTTP layer can show: JSON ``null`` versus an omitted key, the 422 a bad body gets, the status
codes, and that one customer can never reach another's traveller. Two synthetic customers; the session
and the signed-in customer are the only things replaced (the customer by the ``X-Test-Customer`` header).
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models_customer as m
from app.auth.customer_deps import get_current_customer
from app.database.session import get_db
from app.main import app
from tests.conftest import _next_id

BASE = "/api/customer/travellers"
ASHA = dict(first_name="Asha", middle_name="Kumari", last_name="Rao", gender="female",
            date_of_birth="1990-04-12", nationality="India", passport_number="TW000111",
            passport_expiry="2032-05-01", mobile="+919000000011", email="asha.own@example.com")


@pytest.fixture()
def http():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    m.Base.metadata.create_all(engine, tables=[t.__table__ for t in (
        m.Customer, m.CustomerTraveller, m.CustomerAuditLog)])

    def assign(mapper, _conn, target):                      # SQLite runs no identity sequences
        key = mapper.get_property_by_column(mapper.primary_key[0]).key
        if getattr(target, key) is None:
            setattr(target, key, _next_id())

    event.listen(m.Base, "before_insert", assign, propagate=True)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    setup = Session()
    people = {}
    for name in ("a", "b"):
        c = m.Customer(customer_id=_next_id(), customer_code=f"CUST{_next_id()}", full_name=f"Customer {name}",
                       email=f"{name}@example.com", mobile="9000000000")
        setup.add(c)
        people[name] = c
    setup.commit()

    def _db():
        with Session() as s:
            yield s

    def _current(request: Request):
        who = request.headers.get("x-test-customer")
        if who not in people:
            raise HTTPException(status_code=401, detail="not signed in")
        return people[who]

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_customer] = _current
    client = TestClient(app, raise_server_exceptions=True)
    client.as_ = lambda who: {"x-test-customer": who}
    yield client
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_customer, None)
    event.remove(m.Base, "before_insert", assign)
    setup.close()
    engine.dispose()


def _create(http, who="a", **body):
    r = http.post(BASE, json={**ASHA, **body}, headers=http.as_(who))
    assert r.status_code in (200, 201), r.text
    return r.json()


# ---------------------------------------------------------------------------
# Create and read back
# ---------------------------------------------------------------------------
def test_post_stores_distinct_names_and_the_travellers_own_contact(http):
    t = _create(http)
    assert (t["first_name"], t["middle_name"], t["last_name"]) == ("Asha", "Kumari", "Rao")
    assert (t["mobile"], t["email"]) == ("+919000000011", "asha.own@example.com")
    listed = http.get(BASE, headers=http.as_("a")).json()
    assert [(x["first_name"], x["middle_name"], x["last_name"]) for x in listed] == [("Asha", "Kumari", "Rao")]


def test_post_accepts_an_explicit_null_for_the_optional_fields(http):
    t = _create(http, middle_name=None, mobile=None, email=None, gender=None)
    assert (t["middle_name"], t["mobile"], t["email"], t["gender"]) == (None, None, None, None)


def test_post_cleans_a_phone_number_and_refuses_a_bad_body(http):
    assert _create(http, mobile="+91 90000-00012")["mobile"] == "+919000000012"
    for bad in (dict(mobile="abc"), dict(email="not-an-email"), dict(first_name=""),
                dict(first_name="A" * 60, middle_name="B" * 60)):
        r = http.post(BASE, json={**ASHA, "passport_number": "TW9", **bad}, headers=http.as_("a"))
        assert r.status_code == 422, (bad, r.text)


def test_posting_the_same_passport_again_merges_instead_of_duplicating(http):
    _create(http)
    _create(http, last_name="Rao-Nair", passport_number="tw000111")           # same passport, other case
    listed = http.get(BASE, headers=http.as_("a")).json()
    assert len(listed) == 1 and listed[0]["last_name"] == "Rao-Nair" and listed[0]["middle_name"] == "Kumari"


# ---------------------------------------------------------------------------
# PATCH: omitted keeps, explicit null clears
# ---------------------------------------------------------------------------
def _patch(http, tid, who="a", **body):
    return http.patch(f"{BASE}/{tid}", json=body, headers=http.as_(who))


def test_patch_without_the_optional_keys_leaves_them_untouched(http):
    tid = _create(http)["customer_traveller_id"]
    r = _patch(http, tid, first_name="Asha", last_name="Rao-Nair")
    assert r.status_code == 200
    body = r.json()
    assert (body["last_name"], body["middle_name"], body["mobile"], body["email"]) == (
        "Rao-Nair", "Kumari", "+919000000011", "asha.own@example.com")


def test_patch_with_an_explicit_null_clears_only_what_was_nulled(http):
    tid = _create(http)["customer_traveller_id"]
    body = _patch(http, tid, first_name="Asha", last_name="Rao", middle_name=None).json()
    assert (body["middle_name"], body["mobile"], body["email"]) == (None, "+919000000011", "asha.own@example.com")
    body = _patch(http, tid, first_name="Asha", last_name="Rao", mobile=None, email=None).json()
    assert (body["mobile"], body["email"], body["nationality"]) == (None, None, "India")


def test_patch_turns_a_blank_middle_name_into_a_cleared_field_but_a_blank_email_is_invalid(http):
    tid = _create(http)["customer_traveller_id"]
    body = _patch(http, tid, first_name="Asha", last_name="Rao", middle_name="   ").json()
    assert body["middle_name"] is None
    # An email is cleared with null (what Account Center sends), never with "" -- that is not an address.
    assert _patch(http, tid, first_name="Asha", last_name="Rao", email="").status_code == 422


def test_patch_still_requires_both_names_and_validates(http):
    tid = _create(http)["customer_traveller_id"]
    assert _patch(http, tid, middle_name="Kumari").status_code == 422                 # names are required
    assert _patch(http, tid, first_name="Asha", last_name="Rao", mobile="abc").status_code == 422
    assert _patch(http, tid, first_name="Asha", last_name="Rao", email="x").status_code == 422


# ---------------------------------------------------------------------------
# Ownership
# ---------------------------------------------------------------------------
def test_another_customer_cannot_read_change_delete_or_look_up_a_traveller(http):
    tid = _create(http, "a")["customer_traveller_id"]

    assert http.get(BASE, headers=http.as_("b")).json() == []
    assert _patch(http, tid, "b", first_name="X", last_name="Y").status_code == 404
    assert http.delete(f"{BASE}/{tid}", headers=http.as_("b")).status_code == 404
    assert http.get(f"{BASE}/lookup", params={"passport_number": "TW000111"}, headers=http.as_("b")).status_code == 404

    # and none of that touched it
    mine = http.get(BASE, headers=http.as_("a")).json()
    assert [(x["first_name"], x["last_name"]) for x in mine] == [("Asha", "Rao")]


def test_two_customers_may_hold_the_same_passport_independently(http):
    _create(http, "a")
    _create(http, "b", first_name="Bina")
    assert [x["first_name"] for x in http.get(BASE, headers=http.as_("a")).json()] == ["Asha"]
    assert [x["first_name"] for x in http.get(BASE, headers=http.as_("b")).json()] == ["Bina"]


def test_no_session_no_access(http):
    app.dependency_overrides.pop(get_current_customer)          # the real dependency, no token
    for call in (lambda: http.get(BASE), lambda: http.post(BASE, json=ASHA),
                 lambda: http.patch(f"{BASE}/1", json={"first_name": "A", "last_name": "B"}),
                 lambda: http.delete(f"{BASE}/1"),
                 lambda: http.get(f"{BASE}/lookup", params={"passport_number": "TW000111"})):
        assert call().status_code in (401, 403)


# ---------------------------------------------------------------------------
# Passport lookup
# ---------------------------------------------------------------------------
def test_lookup_returns_the_owners_traveller_whatever_the_case_and_includes_the_middle_name(http):
    _create(http)
    r = http.get(f"{BASE}/lookup", params={"passport_number": "tw000111"}, headers=http.as_("a"))
    assert r.status_code == 200
    body = r.json()
    assert (body["first_name"], body["middle_name"], body["last_name"]) == ("Asha", "Kumari", "Rao")


def test_lookup_of_an_unknown_passport_is_a_plain_404(http):
    _create(http)
    r = http.get(f"{BASE}/lookup", params={"passport_number": "NOPE123"}, headers=http.as_("a"))
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------
def test_the_owner_can_delete_and_it_is_gone(http):
    tid = _create(http)["customer_traveller_id"]
    assert http.delete(f"{BASE}/{tid}", headers=http.as_("a")).status_code == 204
    assert http.get(BASE, headers=http.as_("a")).json() == []
