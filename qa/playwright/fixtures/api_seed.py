"""API-level seeding + sign-in, reused by UI E2E fixtures.

This REUSES the existing suite's account model (``tests/config.py``) so the
Playwright suite and the ``verify_*`` suite share one source of truth for test
data. It is import-safe: no network happens at import time, only when a method
is called against a running server.

SAFETY: customer OTPs are read from the API response (OTP_DEV_ECHO=true on the
isolated env) — never a real SMS/email. Nothing here talks to a payment gateway.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import httpx


def _accounts():
    """Seeded dev role accounts, imported from the existing tests/config.py.

    Falls back to env-only if the import path is unavailable, so this module
    never hard-fails at collection time.
    """
    try:
        import sys
        from pathlib import Path
        root = Path(__file__).resolve().parents[3]  # repo root
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        from tests import config as c  # type: ignore
        return {
            "admin": c.ADMIN, "admin2": c.ADMIN2, "super_admin": c.SUPER,
            "manager": c.MANAGER, "merchant": c.MERCHANT,
        }
    except Exception:
        return {}


@dataclass
class Session:
    role: str
    token: str | None
    raw: dict


class ApiClient:
    """Thin wrapper over the JSON API for seeding + auth during UI tests."""

    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or os.environ.get("JPW_QA_BASE", "http://127.0.0.1:8099")).rstrip("/")
        self.http = httpx.Client(base_url=self.base_url, timeout=30.0)

    def close(self):
        self.http.close()

    def health(self) -> bool:
        try:
            return self.http.get("/api/health").status_code == 200
        except Exception:
            return False

    # --- role sign-in (staff/merchant/manager/admin) ------------------
    def login_role(self, role: str) -> Session:
        accts = _accounts()
        if role not in accts:
            raise RuntimeError(f"No seeded account for role {role!r}; run the seed migrations.")
        email, password, portal = accts[role]
        # The exact login path differs by portal; the verify suite's config.login()
        # encapsulates it. Delegated there in Stage 4 to avoid duplicating the flow.
        from tests import config as c  # type: ignore
        token, raw = c.login(email, password, portal)
        return Session(role=role, token=token, raw=raw)

    # --- customer register via dev-OTP echo (no real OTP) -------------
    def register_customer(self, email: str, mobile: str, full_name: str = "QA Traveller") -> Session:
        r = self.http.post("/api/customer/auth/register",
                            json={"email": email, "mobile": mobile, "full_name": full_name})
        r.raise_for_status()
        body = r.json()
        otp = body.get("dev_otp") or body.get("otp")  # OTP_DEV_ECHO returns it
        if not otp:
            raise RuntimeError("OTP not echoed — set OTP_DEV_ECHO=true on the isolated env.")
        v = self.http.post("/api/customer/auth/verify", json={"email": email, "otp": otp})
        v.raise_for_status()
        vb = v.json()
        return Session(role="customer", token=vb.get("access_token") or vb.get("token"), raw=vb)
