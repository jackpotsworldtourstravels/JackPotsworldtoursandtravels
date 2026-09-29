"""Verify a Google ID token — the ONLY thing that decides a Google identity is real.

Nothing above this module trusts anything the browser says about who the user
is. The browser sends one thing: the raw ID token (a JWT) that Google's Identity
Services minted. This module proves it, or refuses:

  * SIGNATURE — RS256, against Google's published JWKS (fetched from Google's
    OIDC discovery document and cached). A token we cannot verify against a
    current Google key is rejected.
  * AUDIENCE — ``aud`` must equal our own ``GOOGLE_CLIENT_ID``. A token minted
    for a different application is not ours to accept.
  * ISSUER — ``iss`` must be one of Google's documented issuers.
  * EXPIRY — ``exp`` in the past is rejected (jose enforces this).

Only after all four does it return the claims, and even then the caller reads
the EMAIL and SUB from these verified claims, never from the request body.

This is the seam the tests mock: they replace :func:`verify_id_token` with a
stub that returns claims, so the whole login/link/create path is exercised
without a network or a real Google account.
"""
from __future__ import annotations

import threading
import time
from typing import Any

import requests
from jose import jwt, jwk
from jose.exceptions import JWTError
from jose.utils import base64url_decode  # noqa: F401  (kept for parity/testing)

from app.config import settings

#: Google's OIDC discovery document. jwks_uri is read from here rather than
#: hardcoded, so a key-endpoint move by Google needs no code change.
_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"

#: Cache Google's signing keys; they rotate, so re-fetch on a cache miss for the
#: token's kid and at most this often.
_JWKS_TTL_SECONDS = 3600

_lock = threading.Lock()
_jwks_cache: dict[str, Any] = {"fetched_at": 0.0, "keys_by_kid": {}, "jwks_uri": None}


class GoogleAuthError(Exception):
    """The ID token could not be verified. Message is safe to log (no token)."""


class GoogleNotConfigured(GoogleAuthError):
    """No GOOGLE_CLIENT_ID — the feature is off, not misused."""


def _allowed_issuers() -> set[str]:
    return {i.strip() for i in (settings.google_allowed_issuers or "").split(",") if i.strip()}


def _discover_jwks_uri() -> str:
    uri = _jwks_cache.get("jwks_uri")
    if uri:
        return uri
    resp = requests.get(_DISCOVERY_URL, timeout=10)
    resp.raise_for_status()
    uri = resp.json()["jwks_uri"]
    _jwks_cache["jwks_uri"] = uri
    return uri


def _keys_by_kid(force: bool = False) -> dict[str, Any]:
    now = time.time()
    with _lock:
        fresh = (now - _jwks_cache["fetched_at"]) < _JWKS_TTL_SECONDS
        if _jwks_cache["keys_by_kid"] and fresh and not force:
            return _jwks_cache["keys_by_kid"]
        resp = requests.get(_discover_jwks_uri(), timeout=10)
        resp.raise_for_status()
        keys = {k["kid"]: k for k in resp.json().get("keys", []) if k.get("kid")}
        _jwks_cache["keys_by_kid"] = keys
        _jwks_cache["fetched_at"] = now
        return keys


def _signing_key(kid: str) -> dict[str, Any]:
    keys = _keys_by_kid()
    if kid not in keys:
        # A token signed with a key we have not seen may mean Google rotated;
        # force one refresh before giving up.
        keys = _keys_by_kid(force=True)
    key = keys.get(kid)
    if key is None:
        raise GoogleAuthError("token key id is not a current Google signing key")
    return key


def verify_id_token(credential: str) -> dict[str, Any]:
    """Verify a Google ID token and return its claims, or raise GoogleAuthError.

    The returned claims are the ONLY trustworthy source of the user's identity:
    ``sub`` (stable Google user id), ``email``, ``email_verified``, ``name``.
    """
    client_id = (settings.google_client_id or "").strip()
    if not client_id:
        raise GoogleNotConfigured("Google sign-in is not configured (no GOOGLE_CLIENT_ID)")
    if not credential or not isinstance(credential, str):
        raise GoogleAuthError("no credential supplied")

    try:
        kid = jwt.get_unverified_header(credential).get("kid")
    except JWTError as exc:
        raise GoogleAuthError(f"malformed token: {exc}") from exc
    if not kid:
        raise GoogleAuthError("token has no key id")

    key_dict = _signing_key(kid)
    try:
        # jose verifies signature, audience and expiry here. Issuer is checked
        # explicitly below against our allowed set (Google uses two spellings).
        claims = jwt.decode(
            credential,
            jwk.construct(key_dict, "RS256"),
            algorithms=["RS256"],
            audience=client_id,
            options={"verify_iss": False},
        )
    except JWTError as exc:
        raise GoogleAuthError(f"token rejected: {exc}") from exc

    if claims.get("iss") not in _allowed_issuers():
        raise GoogleAuthError("unexpected token issuer")
    if not claims.get("sub"):
        raise GoogleAuthError("token has no subject")
    return claims
