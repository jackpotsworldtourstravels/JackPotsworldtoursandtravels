"""Stage 4A harness: role auth, browser storage-state, and an authz probe client.

Design (per Stage-4A plan + review conditions):
- Storage-state lets a browser spec START signed-in WITHOUT replaying the login
  rate limit (the Stage-3 verify_customer_portal flake). It is a SPEED mechanism.
- It does NOT replace authorization testing: `Api` below drives unauthenticated,
  invalid/expired, wrong-role and cross-role checks at the API boundary (see
  e2e/authz/).

The SPA persists auth in localStorage (frontend/assets/js/auth.js):
  staff/merchant -> jwt_access / jwt_refresh / jwt_user_{name,role,id}
  customer       -> jpc_access / jpc_refresh / jpc_customer (JSON) + jpc_user_*
So a storage_state is just the API-issued tokens written into those keys.

SAFETY: customers are created via the real signup + dev-OTP echo (OTP_DEV_ECHO=
true) — no real OTP. All data lands in jpw_qa only. No payments. Emails are
namespaced per run for isolation + cleanup.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
# tests/config.py imports `minihttp` as a top-level module, so tests/ must be on
# the path too (it ships its own stdlib HTTP client there).
_TESTS_DIR = str(REPO_ROOT / "tests")
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

# Staff/merchant accounts come from the existing suite config (seeded dev creds,
# env-overridable). Customer accounts are created fresh per run.
from tests import config as suite_config  # noqa: E402

STAFF_ROLES = {
    "admin": suite_config.ADMIN,
    "admin2": suite_config.ADMIN2,
    "super_admin": suite_config.SUPER,
    "manager": suite_config.MANAGER,
    "merchant": suite_config.MERCHANT,
}

#: Customers this process created, for scoped cleanup (jpw_qa only).
CREATED_CUSTOMER_EMAILS: list[str] = []


def base_url() -> str:
    return os.environ.get("JPW_QA_BASE", "http://127.0.0.1:8099").rstrip("/")


# --------------------------------------------------------------------------
# Token acquisition
# --------------------------------------------------------------------------
def staff_tokens(role: str) -> dict:
    """Sign in a seeded staff/merchant role via the suite's two-step OTP login."""
    email, password, portal = STAFF_ROLES[role]
    access, user = suite_config.login(email, password, portal, with_user=True)
    return {"access": access, "refresh": "", "user": user, "portal": portal}


def _post_retrying_429(client, path: str, json_body: dict, *,
                       max_attempts: int = 4, max_total_wait: float = 45.0):
    """POST, retrying ONLY on an explicit HTTP 429 (Retry-After honoured).

    Bounded by `max_attempts` and `max_total_wait` seconds. Any other outcome —
    a non-429 status, a connection error, or a read timeout — is returned/raised
    immediately and never retried.
    """
    waited = 0.0
    resp = client.post(path, json=json_body)   # non-429 errors propagate, not retried
    for attempt in range(1, max_attempts):
        if resp.status_code != 429:
            return resp
        ra = resp.headers.get("Retry-After", "")
        delay = float(ra) if ra.strip().isdigit() else min(5.0 * attempt, 15.0)
        if waited + delay > max_total_wait:
            return resp                        # bounded total wait exceeded -> give up
        time.sleep(delay)
        waited += delay
        resp = client.post(path, json=json_body)
    return resp                                # caller's raise_for_status surfaces a final 429


def create_customer(ns: str) -> dict:
    """Sign up a throwaway customer (dev-OTP) and return tokens + customer object.

    The signup endpoint is rate-limited (5/min per IP). Under a full CI run several
    signups can bunch on one IP; `_post_retrying_429` retries ONLY an explicit HTTP
    429 (honouring Retry-After), with bounded attempts and total wait. Network
    timeouts, connection errors and any non-429 status are NOT retried — they
    propagate. This is a test-client courtesy to the limiter; the production rate
    limit is unchanged.
    """
    bu = base_url()
    stamp = f"{int(time.time()*1000)%10_000_000}"
    email = f"qa.{ns}.{stamp}@example.com"
    mobile = "9" + f"{int(time.time()*1000)%10**9:09d}"
    with httpx.Client(base_url=bu, timeout=30.0) as c:
        r = _post_retrying_429(c, "/api/customer/auth/signup", {
            "email": email, "mobile": mobile, "full_name": "QA Smoke",
            "password": "QaSmoke#2026", "confirm_password": "QaSmoke#2026"})
        r.raise_for_status()
        ch = r.json()
        otp = ch.get("dev_otp")
        if not otp:
            raise RuntimeError("No dev_otp — set OTP_DEV_ECHO=true on the isolated env.")
        v = _post_retrying_429(c, "/api/customer/auth/verify-otp",
                               {"challenge_token": ch["challenge_token"], "code": otp})
        v.raise_for_status()
        body = v.json()
    CREATED_CUSTOMER_EMAILS.append(email)
    return {"access": body["access_token"], "refresh": body.get("refresh_token", ""),
            "customer": body.get("customer") or {}, "email": email}


# --------------------------------------------------------------------------
# Browser storage-state
# --------------------------------------------------------------------------
def _storage_state(origin: str, items: dict) -> dict:
    return {"cookies": [], "origins": [
        {"origin": origin, "localStorage": [{"name": k, "value": v}
                                            for k, v in items.items()]}]}


def staff_storage_state(role: str) -> dict:
    t = staff_tokens(role)
    u = t["user"] or {}
    items = {
        "jwt_access": t["access"],
        "jwt_refresh": t["refresh"] or "",
        "jwt_user_name": str(u.get("full_name") or u.get("name") or role),
        "jwt_user_role": str(u.get("role") or role),
        "jwt_user_id": str(u.get("id") or u.get("user_id") or ""),
    }
    return _storage_state(base_url(), items)


def storage_state_from_customer(session: dict) -> dict:
    """Build a browser storage-state from an existing customer session dict
    (so a test can drive the UI and call the API as the SAME customer)."""
    cust = session.get("customer") or {}
    items = {
        "jpc_access": session["access"],
        "jpc_refresh": session.get("refresh") or "",
        "jpc_customer": json.dumps(cust),
        "jpc_user_name": str(cust.get("full_name") or "QA Smoke"),
        "jpc_user_role": "customer",
        "jpc_user_id": str(cust.get("id") or ""),
    }
    return _storage_state(base_url(), items)


def customer_storage_state(ns: str) -> dict:
    return storage_state_from_customer(create_customer(ns))


def operations_storage_state() -> dict:
    """Operations has NO role/namespace of its own (ops-core.js: "permission-driven,
    not role-driven"). It ADOPTS an existing admin session: it reads jwt_access and
    an `ops_active_portal` marker. So reuse the seeded admin and tell ops-core to
    adopt the 'admin' portal — no new account, no role change."""
    state = staff_storage_state("admin")
    state["origins"][0]["localStorage"].append(
        {"name": "ops_active_portal", "value": "admin"})
    return state


def storage_state_for(role: str, ns: str = "p") -> dict:
    if role == "customer":
        return customer_storage_state(ns)
    if role == "operations":
        return operations_storage_state()
    return staff_storage_state(role)


# --------------------------------------------------------------------------
# Authorization probe client (API-level; the real authz coverage)
# --------------------------------------------------------------------------
def expired_staff_token() -> str:
    """A syntactically-valid but EXPIRED JWT, signed with the local test secret,
    to exercise the expired-session path (expect 401)."""
    from jose import jwt
    secret = os.environ.get("JWT_SECRET_KEY", "")
    claims = {"sub": "1", "role": "admin", "type": "access",
              "exp": dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)}
    return jwt.encode(claims, secret, algorithm="HS256")


class Api:
    """Minimal client for status-code authorization checks."""

    def __init__(self):
        self.http = httpx.Client(base_url=base_url(), timeout=30.0)

    def close(self):
        self.http.close()

    def status(self, method: str, path: str, token: str | None = None) -> int:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return self.http.request(method, path, headers=headers).status_code

    def get_json(self, path: str, token: str | None = None):
        """(status_code, parsed_json_or_None) for a GET."""
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        r = self.http.get(path, headers=headers)
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, None
