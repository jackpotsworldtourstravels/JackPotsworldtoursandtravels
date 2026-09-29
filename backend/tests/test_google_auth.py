"""Google sign-in: identity verification, and the sign-in / link / create rules.

Two layers, no network and no real Google account:

  * The VERIFIER (:func:`google_identity_service.verify_id_token`) is tested for
    real — tokens are signed here with a throwaway RSA key whose public half is
    injected as Google's JWKS, so audience, issuer, expiry and signature are all
    genuinely checked.

  * The RESOLVER (:mod:`customer_google_auth_service`) is tested by handing it
    already-verified claims (which is exactly what the real verifier returns),
    so the known-identity / link-by-verified-email / new-user paths, and the
    no-duplicate guarantee, are exercised directly.
"""
from __future__ import annotations

import base64
import datetime as dt

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models_customer import Base, Customer, CustomerIdentity, CustomerProfile
from app.services import customer_auth_service
from app.services import customer_google_auth_service as gauth
from app.services import google_identity_service as gid


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerProfile.__table__, CustomerIdentity.__table__,
    ])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


_CODE = {"n": 0}


@pytest.fixture(autouse=True)
def _stub_customer_code(monkeypatch):
    # SQLite has no seq_customer_code; hand out distinct codes for creation tests.
    def _next(_db):
        _CODE["n"] += 1
        return f"CUST-T{_CODE['n']:04d}"
    monkeypatch.setattr(customer_auth_service, "next_customer_code", _next)


def _make_customer(db, *, email, mobile, name="Existing User", guest=False):
    c = Customer(customer_code=f"CUST-E{mobile[-4:]}", full_name=name,
                 email=email, mobile=mobile, is_guest=guest)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def claims(sub="google-sub-1", email="new@example.com", email_verified=True, name="New User"):
    return {"sub": sub, "email": email, "email_verified": email_verified, "name": name,
            "iss": "https://accounts.google.com", "aud": "test-client-id"}


# --------------------------------------------------------------------------- #
# Verifier — real RSA, injected JWKS
# --------------------------------------------------------------------------- #

@pytest.fixture()
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _priv_pem(key):
    return key.private_bytes(serialization.Encoding.PEM,
                             serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()


def _b64u(n: int) -> str:
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _jwks_for(key, kid="test-kid"):
    pub = key.public_key().public_numbers()
    return {kid: {"kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256",
                  "n": _b64u(pub.n), "e": _b64u(pub.e)}}


@pytest.fixture()
def configure_google(monkeypatch, rsa_key):
    monkeypatch.setattr(settings, "google_client_id", "test-client-id", raising=False)
    monkeypatch.setattr(gid, "_keys_by_kid", lambda force=False: _jwks_for(rsa_key))


def _token(key, *, aud="test-client-id", iss="https://accounts.google.com",
           exp_delta=3600, sub="sub-1", extra=None, kid="test-kid", sign_key=None):
    now = dt.datetime.now(dt.timezone.utc)
    payload = {"iss": iss, "aud": aud, "sub": sub, "email": "u@example.com",
               "email_verified": True, "name": "U",
               "iat": int(now.timestamp()),
               "exp": int((now + dt.timedelta(seconds=exp_delta)).timestamp())}
    if extra:
        payload.update(extra)
    return jwt.encode(payload, _priv_pem(sign_key or key), algorithm="RS256",
                      headers={"kid": kid})


def test_valid_token_verifies(configure_google, rsa_key):
    out = gid.verify_id_token(_token(rsa_key))
    assert out["sub"] == "sub-1" and out["aud"] == "test-client-id"


def test_wrong_audience_rejected(configure_google, rsa_key):
    with pytest.raises(gid.GoogleAuthError):
        gid.verify_id_token(_token(rsa_key, aud="some-other-client"))


def test_expired_token_rejected(configure_google, rsa_key):
    with pytest.raises(gid.GoogleAuthError):
        gid.verify_id_token(_token(rsa_key, exp_delta=-60))


def test_wrong_issuer_rejected(configure_google, rsa_key):
    with pytest.raises(gid.GoogleAuthError):
        gid.verify_id_token(_token(rsa_key, iss="https://evil.example.com"))


def test_bad_signature_rejected(configure_google, rsa_key):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(gid.GoogleAuthError):
        gid.verify_id_token(_token(rsa_key, sign_key=other))  # signed by a key not in JWKS


def test_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "google_client_id", None, raising=False)
    with pytest.raises(gid.GoogleNotConfigured):
        gid.verify_id_token("anything")


def test_empty_credential_rejected(configure_google):
    with pytest.raises(gid.GoogleAuthError):
        gid.verify_id_token("")


# --------------------------------------------------------------------------- #
# Resolver — sign in / link / create, and no duplicates
# --------------------------------------------------------------------------- #

def test_new_user_needs_signup_then_creates(db):
    r = gauth.resolve(db, claims(sub="sub-new", email="fresh@example.com"))
    assert r.status == "needs_signup" and r.pending_token
    assert r.prefill["email"] == "fresh@example.com"

    customer = gauth.complete_signup(db, pending_token=r.pending_token,
                                     full_name=None, mobile="9811111111")
    assert customer.customer_id is not None
    assert customer.email == "fresh@example.com"
    assert customer.email_verified is True          # Google verified the mailbox
    # identity linked
    ident = db.query(CustomerIdentity).filter_by(provider_user_id="sub-new").one()
    assert ident.customer_id == customer.customer_id


def test_existing_identity_signs_into_same_customer(db):
    c = _make_customer(db, email="has@example.com", mobile="9822222222")
    db.add(CustomerIdentity(customer_id=c.customer_id, provider="google",
                            provider_user_id="sub-known", email="has@example.com"))
    db.commit()
    r = gauth.resolve(db, claims(sub="sub-known", email="has@example.com"))
    assert r.status == "authenticated" and r.customer.customer_id == c.customer_id
    assert r.linked is False


def test_repeated_login_no_duplicate(db):
    r1 = gauth.resolve(db, claims(sub="sub-rep", email="rep@example.com"))
    c1 = gauth.complete_signup(db, pending_token=r1.pending_token, full_name=None, mobile="9833333333")
    # Same Google subject signs in again:
    r2 = gauth.resolve(db, claims(sub="sub-rep", email="rep@example.com"))
    assert r2.status == "authenticated"
    assert r2.customer.customer_id == c1.customer_id
    assert db.query(Customer).count() == 1
    assert db.query(CustomerIdentity).count() == 1


def test_link_by_verified_email(db):
    c = _make_customer(db, email="link@example.com", mobile="9844444444")
    r = gauth.resolve(db, claims(sub="sub-link", email="link@example.com", email_verified=True))
    assert r.status == "authenticated" and r.linked is True
    assert r.customer.customer_id == c.customer_id           # SAME account, id preserved
    assert db.query(Customer).count() == 1                   # no second customer
    assert db.query(CustomerIdentity).filter_by(provider_user_id="sub-link").count() == 1


def test_unverified_email_does_not_seize_account(db):
    _make_customer(db, email="secure@example.com", mobile="9855555555")
    with pytest.raises(gauth.GoogleLinkNotAllowed):
        gauth.resolve(db, claims(sub="sub-x", email="secure@example.com", email_verified=False))
    assert db.query(CustomerIdentity).count() == 0           # nothing linked


def test_duplicate_mobile_rejected_on_complete(db):
    _make_customer(db, email="other@example.com", mobile="9866666666")
    r = gauth.resolve(db, claims(sub="sub-dup", email="dup@example.com"))
    with pytest.raises(gauth.GoogleAuthError):
        gauth.complete_signup(db, pending_token=r.pending_token, full_name=None, mobile="9866666666")


def test_pending_token_tamper_rejected(db):
    r = gauth.resolve(db, claims(sub="sub-t", email="t@example.com"))
    with pytest.raises(gauth.GoogleAuthError):
        gauth.complete_signup(db, pending_token=r.pending_token + "x", full_name=None, mobile="9877777777")


def test_google_customer_can_mint_session_tokens(db):
    # A password-less Google customer still yields a session pair (issue_tokens
    # needs only customer_id), which is what "session creation" relies on.
    r = gauth.resolve(db, claims(sub="sub-s", email="s@example.com"))
    c = gauth.complete_signup(db, pending_token=r.pending_token, full_name=None, mobile="9888888888")
    access, refresh = customer_auth_service.issue_tokens(c)
    assert access and refresh and access != refresh
