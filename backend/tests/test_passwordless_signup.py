"""Customer signup WITHOUT a password.

The customer site registers a traveller with a name, email and mobile only. The account is proved by the code
emailed straight away and signs in the same way (request-otp / verify-otp). These tests pin that, and pin that the
password path older clients use (the mobile app, older pages) still works, and that nothing about identity checking
was loosened: no session exists until the emailed code is spent.

Three layers: the request schema, the service, and the real routes over HTTP with a throw-away SQLite database.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models_customer as m
from app.auth.rate_limit import limiter
from app.database.session import get_db
from app.main import app
from app.schemas.customer import CustomerSignupRequest
from app.services import customer_auth_service
from tests.conftest import _next_id

BASE = dict(full_name="Asha Rao", email="asha.rao@example.com", mobile="+919900001234")


# --------------------------------------------------------------------------- #
# The request schema
# --------------------------------------------------------------------------- #

def test_schema_accepts_no_password():
    req = CustomerSignupRequest(**BASE)
    assert req.password is None and req.confirm_password is None


def test_schema_still_accepts_a_matching_password_pair():
    req = CustomerSignupRequest(**BASE, password="Str0ng-pass", confirm_password="Str0ng-pass")
    assert req.password == "Str0ng-pass"


@pytest.mark.parametrize("extra", [
    {"password": "Str0ng-pass"},                                  # a lone password
    {"confirm_password": "Str0ng-pass"},                          # a lone confirmation
    {"password": "Str0ng-pass", "confirm_password": "Other-pass1"},   # mismatch
    {"password": "short", "confirm_password": "short"},           # below the 8-character rule
])
def test_schema_refuses_a_malformed_password_request(extra):
    with pytest.raises(ValidationError):
        CustomerSignupRequest(**BASE, **extra)


def test_schema_still_validates_the_other_fields():
    with pytest.raises(ValidationError):
        CustomerSignupRequest(**{**BASE, "email": "not-an-email"})
    with pytest.raises(ValidationError):
        CustomerSignupRequest(**{**BASE, "mobile": "12"})


# --------------------------------------------------------------------------- #
# Fixtures: a throw-away database, the real routes
# --------------------------------------------------------------------------- #

@pytest.fixture()
def db():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    m.Base.metadata.create_all(engine, tables=[t.__table__ for t in (
        m.Customer, m.CustomerAuth, m.CustomerProfile, m.CustomerSession, m.CustomerOtp,
        m.CustomerAuditLog, m.CustomerNotification, m.CustomerActivity)])

    def assign(mapper, _conn, target):                      # SQLite runs no identity sequences
        key = mapper.get_property_by_column(mapper.primary_key[0]).key
        if getattr(target, key) is None:
            setattr(target, key, _next_id())

    event.listen(m.Base, "before_insert", assign, propagate=True)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    yield session
    event.remove(m.Base, "before_insert", assign)
    session.close()
    engine.dispose()


@pytest.fixture(autouse=True)
def _codes(monkeypatch):
    n = {"i": 0}

    def _next(_db):                                          # SQLite has no seq_customer_code
        n["i"] += 1
        return f"CUST-P{n['i']:04d}"
    monkeypatch.setattr(customer_auth_service, "next_customer_code", _next)


# --------------------------------------------------------------------------- #
# The service
# --------------------------------------------------------------------------- #

def test_service_without_a_password_creates_no_credentials_row(db):
    c = customer_auth_service.signup(db, **BASE)
    assert c.auth is None                                     # the same shape a Google account has
    assert c.profile is not None and c.status is m.CustomerStatus.ACTIVE
    assert db.query(m.CustomerAuth).count() == 0


def test_service_with_a_password_still_stores_its_hash(db):
    c = customer_auth_service.signup(db, **{**BASE, "email": "with.pw@example.com", "mobile": "+919900005678"},
                                     password="Str0ng-pass")
    assert c.auth is not None and c.auth.password_hash and c.auth.password_hash != "Str0ng-pass"


def test_service_duplicate_email_and_mobile_are_still_refused(db):
    customer_auth_service.signup(db, **BASE)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e1:
        customer_auth_service.signup(db, **{**BASE, "mobile": "+919900009999"})
    assert e1.value.status_code == 400 and "email" in e1.value.detail
    with pytest.raises(HTTPException) as e2:
        customer_auth_service.signup(db, **{**BASE, "email": "other@example.com"})
    assert e2.value.status_code == 400 and "mobile" in e2.value.detail


def test_a_passwordless_account_cannot_use_the_password_login(db):
    customer_auth_service.signup(db, **BASE)
    from fastapi import HTTPException
    for guess in ("", "anything-at-all", "Str0ng-pass"):
        with pytest.raises(HTTPException) as e:
            customer_auth_service.authenticate(db, BASE["email"], guess or "x")
        assert e.value.status_code == 401


# --------------------------------------------------------------------------- #
# Over HTTP: signup -> code -> session
# --------------------------------------------------------------------------- #

@pytest.fixture()
def http(db):
    def _db():
        yield db
    limiter.reset()
    app.dependency_overrides[get_db] = _db
    client = TestClient(app, raise_server_exceptions=True)
    yield client
    app.dependency_overrides.pop(get_db, None)
    limiter.reset()


def test_http_signup_without_a_password_issues_a_challenge_and_no_session(http, db):
    r = http.post("/api/customer/auth/signup", json=BASE)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["otp_required"] is True and body["challenge_token"]
    assert "access_token" not in body and "refresh_token" not in body       # no session before the code
    assert db.query(m.CustomerSession).count() == 0


def test_http_the_emailed_code_is_what_starts_the_session(http, db):
    body = http.post("/api/customer/auth/signup", json=BASE).json()
    if not body.get("dev_otp"):
        pytest.skip("delivery mode is email on this host; the code is not returned")
    bad = http.post("/api/customer/auth/verify-otp", json={"challenge_token": body["challenge_token"], "code": "000000"})
    assert bad.status_code == 400
    assert db.query(m.CustomerSession).count() == 0
    ok = http.post("/api/customer/auth/verify-otp", json={"challenge_token": body["challenge_token"], "code": body["dev_otp"]})
    assert ok.status_code == 200, ok.text
    data = ok.json()
    assert data["access_token"] and data["customer"]["email"] == BASE["email"]
    me = http.get("/api/customer/auth/me", headers={"Authorization": "Bearer " + data["access_token"]})
    assert me.status_code == 200 and me.json()["email"] == BASE["email"]


def test_http_the_passwordless_account_signs_in_again_by_code(http, db):
    http.post("/api/customer/auth/signup", json=BASE)
    r = http.post("/api/customer/auth/request-otp", json={"identifier": BASE["email"]})
    assert r.status_code == 200 and r.json()["challenge_token"]


def test_http_password_login_is_refused_for_a_passwordless_account(http, db):
    http.post("/api/customer/auth/signup", json=BASE)
    r = http.post("/api/customer/auth/login", json={"identifier": BASE["email"], "password": "Str0ng-pass"})
    assert r.status_code == 401


def test_http_the_old_password_request_still_works(http, db):
    r = http.post("/api/customer/auth/signup", json={**BASE, "email": "pw@example.com", "mobile": "+919900007777",
                                                     "password": "Str0ng-pass", "confirm_password": "Str0ng-pass"})
    assert r.status_code == 201, r.text
    assert db.query(m.CustomerAuth).count() == 1


def test_http_a_lone_password_is_a_422_not_a_passwordless_signup(http, db):
    r = http.post("/api/customer/auth/signup", json={**BASE, "password": "Str0ng-pass"})
    assert r.status_code == 422
    assert db.query(m.Customer).count() == 0
