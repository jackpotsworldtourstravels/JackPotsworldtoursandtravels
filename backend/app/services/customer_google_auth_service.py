"""Turn a VERIFIED Google identity into a customer — sign in, link, or create.

This never verifies a token itself; it is handed already-verified claims by
:mod:`google_identity_service` and only decides which existing customer they
belong to, or that a new one must be made. The rules, in order:

  1. KNOWN IDENTITY. A ``customer_identities`` row for this (google, sub)
     already exists -> that customer signs in. This is what makes a repeat
     Google login land on the same account and never a duplicate.

  2. LINK BY VERIFIED EMAIL. No identity yet, but the Google-verified email
     matches an existing real customer -> link the identity to that customer
     and sign in, PRESERVING their customer_id. Only when Google says the email
     is verified; an unverified email is never allowed to seize an account.

  3. NEW USER. No identity, no email match -> we do NOT create the account
     here, because ``customers.mobile`` is required and Google does not provide
     one. Instead we mint a short-lived "finish sign-up" token carrying the
     verified subject, and the customer supplies the mobile; :func:`complete_signup`
     then creates the customer + identity together.

Only the minimum is stored: provider, subject, customer_id, and the verified
email for display. No Google token of any kind is kept.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any, Optional

from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models_customer import (
    Customer,
    CustomerIdentity,
    CustomerProfile,
    CustomerStatus,
)
from app.services import customer_auth_service as auth

PROVIDER = "google"
_PENDING_SCOPE = "google_pending"


class GoogleAuthError(Exception):
    """A Google sign-in could not be completed. Safe to show/log (no token)."""


class GoogleLinkNotAllowed(GoogleAuthError):
    """Email matches an existing account but Google did not verify it.

    Auto-linking on an unverified email would be an account-takeover path, so we
    refuse and direct the customer to sign in their usual way and link from
    account settings instead.
    """


@dataclass
class GoogleResolution:
    #: "authenticated" (customer set) or "needs_signup" (pending_token + prefill).
    status: str
    customer: Optional[Customer] = None
    linked: bool = False          # True when this call created the identity link
    pending_token: Optional[str] = None
    prefill: Optional[dict] = None


# --------------------------------------------------------------------------- #
# Lookups
# --------------------------------------------------------------------------- #

def _identity_for(db: Session, sub: str) -> CustomerIdentity | None:
    return db.execute(
        select(CustomerIdentity).where(
            CustomerIdentity.provider == PROVIDER,
            CustomerIdentity.provider_user_id == sub,
        )
    ).scalar_one_or_none()


def _link_identity(db: Session, customer: Customer, sub: str, email: str | None) -> CustomerIdentity:
    ident = CustomerIdentity(
        customer_id=customer.customer_id,
        provider=PROVIDER,
        provider_user_id=sub,
        email=(auth.normalise_email(email) if email else None),
    )
    db.add(ident)
    db.commit()
    db.refresh(ident)
    return ident


# --------------------------------------------------------------------------- #
# Resolve a verified token
# --------------------------------------------------------------------------- #

def resolve(db: Session, claims: dict[str, Any]) -> GoogleResolution:
    """Decide the customer for a set of VERIFIED Google claims.

    ``claims`` come from :func:`google_identity_service.verify_id_token`; this
    function trusts them and reads the identity only from here.
    """
    sub = str(claims.get("sub") or "").strip()
    if not sub:
        raise GoogleAuthError("verified token had no subject")
    email = (claims.get("email") or "").strip() or None
    email_verified = bool(claims.get("email_verified"))
    name = (claims.get("name") or "").strip() or None

    # 1. Known identity -> that customer, always the same one.
    ident = _identity_for(db, sub)
    if ident is not None:
        customer = db.get(Customer, ident.customer_id)
        if customer is None:
            raise GoogleAuthError("linked account no longer exists")
        return GoogleResolution(status="authenticated", customer=customer)

    # 2. Link to an existing customer by VERIFIED email.
    if email:
        existing = auth.get_by_email(db, email)
        if existing is not None and not existing.is_guest:
            if not email_verified:
                raise GoogleLinkNotAllowed(
                    "An account with this email already exists. Please sign in the "
                    "usual way and link Google from your account settings."
                )
            _link_identity(db, existing, sub, email)
            return GoogleResolution(status="authenticated", customer=existing, linked=True)

    # 3. New user -> collect the one field Google does not give us (mobile).
    pending = _make_pending_token(sub=sub, email=email, email_verified=email_verified, name=name)
    return GoogleResolution(
        status="needs_signup",
        pending_token=pending,
        prefill={"name": name, "email": email},
    )


# --------------------------------------------------------------------------- #
# Finish sign-up (new user supplies a mobile)
# --------------------------------------------------------------------------- #

def _make_pending_token(*, sub: str, email: str | None, email_verified: bool, name: str | None) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    exp = now + dt.timedelta(minutes=settings.google_pending_signup_ttl_minutes)
    payload = {
        "scope": _PENDING_SCOPE,
        "provider": PROVIDER,
        "sub": sub,
        "email": email,
        "email_verified": email_verified,
        "name": name,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def _read_pending_token(token: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise GoogleAuthError("sign-up session expired or invalid; please try again") from exc
    if payload.get("scope") != _PENDING_SCOPE or not payload.get("sub"):
        raise GoogleAuthError("invalid sign-up session")
    return payload


def complete_signup(db: Session, *, pending_token: str, full_name: str | None, mobile: str) -> Customer:
    """Create the customer + identity for a new Google user who supplied a mobile.

    The Google subject is taken from the signed pending token, never from the
    request body, so the account is created for the identity Google actually
    verified. Races (the identity or email appearing between resolve and here)
    are turned into the same friendly errors the OTP signup gives.
    """
    payload = _read_pending_token(pending_token)
    sub = str(payload["sub"])
    email = (payload.get("email") or "").strip() or None
    email_verified = bool(payload.get("email_verified"))
    name = (full_name or payload.get("name") or "").strip()
    if not name:
        raise GoogleAuthError("a name is required to finish sign-up")

    mobile_n = auth.normalise_mobile(mobile)

    # If the same Google identity was completed a moment ago, return it rather
    # than making a second account.
    ident = _identity_for(db, sub)
    if ident is not None:
        existing = db.get(Customer, ident.customer_id)
        if existing is not None:
            return existing

    if email and (found := auth.get_by_email(db, email)) is not None and not found.is_guest:
        # The email got an account between resolve and now. If it was verified,
        # link to it; otherwise refuse rather than duplicate.
        if email_verified:
            _link_identity(db, found, sub, email)
            return found
        raise GoogleAuthError("An account with this email already exists.")
    if auth.get_by_mobile(db, mobile_n) is not None:
        raise GoogleAuthError("An account with this mobile number already exists.")

    customer = Customer(
        customer_code=auth.next_customer_code(db),
        full_name=name,
        email=auth.normalise_email(email) if email else "",
        mobile=mobile_n,
        status=CustomerStatus.ACTIVE,
        # Google verified the mailbox; carry that through so we don't re-OTP it.
        email_verified=email_verified,
    )
    # No CustomerAuth row: a Google customer has no password. record_login and
    # issue_tokens already tolerate customer.auth is None.
    customer.profile = CustomerProfile()
    db.add(customer)
    try:
        db.flush()
        db.add(CustomerIdentity(
            customer_id=customer.customer_id,
            provider=PROVIDER,
            provider_user_id=sub,
            email=auth.normalise_email(email) if email else None,
        ))
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise GoogleAuthError("Could not complete sign-up; please try again.") from exc
    db.refresh(customer)
    auth.welcome_notification(db, customer)
    return customer
