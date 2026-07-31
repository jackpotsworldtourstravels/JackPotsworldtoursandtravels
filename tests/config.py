"""Shared configuration for the verification suite.

WHY THE ACCOUNTS LIVE HERE AND NOT IN EACH SCRIPT
They were copy-pasted into every script, which meant a password rotation broke
the suite in five places and one of them always got missed. One definition, and
every value is overridable from the environment so a run against a staging
database needs no edit to a tracked file::

    JPW_BASE=https://staging.example.com \
    JPW_ADMIN_EMAIL=... JPW_ADMIN_PASSWORD=... python tests/verify_m1.py

The defaults are the **seeded development accounts** created by the alembic seed
migrations on a local database. They are not production credentials and are not
secret — they are already reproducible from `backend/alembic/versions/`. Do not
add a real credential to this file; export it instead.
"""
import os

BASE = os.environ.get("JPW_BASE", "http://127.0.0.1:8000").rstrip("/")


def _account(prefix, email, password, portal):
    return (
        os.environ.get(f"JPW_{prefix}_EMAIL", email),
        os.environ.get(f"JPW_{prefix}_PASSWORD", password),
        portal,
    )


MERCHANT = _account("MERCHANT", "demo.merchant@example.com", "4dU*!TEC$NYKn9", "merchant")
ADMIN = _account("ADMIN", "priya.raghavan@jackpotsworldtours.com", "97TJ96JtTfRSVC", "admin")

#: A *second* Admin, not the Super Admin. ``_SUPER_ADMIN`` in ``auth/rbac.py``
#: deliberately omits ``ticket.view`` ("explicitly cannot raise tickets"), so a
#: Super Admin is the wrong stand-in when a test needs a second operator.
ADMIN2 = _account("ADMIN2", "ops.desk@jackpotsworldtours.com", "OpsDesk#2026x", "admin")
SUPER = _account("SUPER", "admin@jackpotsworldtours.com", "AdminPass#2026", "super_admin")

#: The platform Manager (CR-2) — its own role, its own portal, and the only
#: account that can approve a Classic Tours booking request. Deliberately not an
#: Admin: the whole point of the role is that the desk which answered the ticket
#: enquiry cannot also sign off the booking, so a suite that reused ADMIN here
#: would prove nothing.
MANAGER = _account("MANAGER", "manager.desk@jackpotsworldtours.com", "MgrDesk#2026x", "manager")

#: Smallest byte sequences that pass the upload signature check, so a test can
#: exercise the document paths without carrying binary fixtures in the repo.
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 200


#: Tokens already obtained in this process, keyed by (email, portal). A script
#: that signs the same account in twice would otherwise spend two of the ten
#: logins the rate limiter allows per minute.
_TOKENS: dict[tuple[str, str], tuple[str, dict]] = {}


def login(email, password, portal, *, with_user=False):
    """Sign in through the real two-step OTP flow and return an access token.

    Uses ``dev_otp`` from the login challenge, which the backend only returns
    outside production — the suite therefore exercises the genuine endpoint pair
    rather than minting a token behind the API's back.

    ``POST /api/auth/login`` is rate-limited to **10 per minute per IP address**
    (``auth/rate_limit.py``, keyed by remote address, so it is a budget shared by
    every account and every script). A full suite run needs more than that, so a
    429 is waited out and retried rather than treated as a failure — the limit is
    correct behaviour worth keeping, and backing off is the caller's job.
    """
    import time

    import minihttp as requests

    cached = _TOKENS.get((email, portal))
    if cached:
        return cached if with_user else cached[0]

    for attempt in range(6):
        r = requests.post(
            f"{BASE}/api/auth/login",
            json={"email": email, "password": password, "portal": portal},
        )
        if r.status_code != 429:
            break
        wait = 12
        print(f"     (login rate-limited; waiting {wait}s and retrying — attempt {attempt + 1}/6)")
        time.sleep(wait)

    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text[:300]}"
    challenge = r.json()
    r = requests.post(
        f"{BASE}/api/auth/verify-otp",
        json={"challenge_token": challenge["challenge_token"], "code": challenge["dev_otp"]},
    )
    assert r.status_code == 200, f"verify-otp {email}: {r.status_code} {r.text[:300]}"
    body = r.json()

    _TOKENS[(email, portal)] = (body["access_token"], body["user"])
    return _TOKENS[(email, portal)] if with_user else body["access_token"]


def H(token):
    """Authorization header for a token."""
    return {"Authorization": f"Bearer {token}"}


class Checker:
    """Collects pass/fail results and prints them as they happen."""

    def __init__(self):
        self.passed = []
        self.failed = []

    def __call__(self, name, cond, detail=""):
        (self.passed if cond else self.failed).append(name)
        suffix = f"   -- {detail}" if detail and not cond else ""
        print(f"  {'PASS' if cond else 'FAIL'}  {name}{suffix}")
        return bool(cond)

    def report(self) -> int:
        """Print the summary and return a process exit code."""
        print(f"\n==== {len(self.passed)} passed, {len(self.failed)} failed ====")
        for name in self.failed:
            print(f"  FAILED: {name}")
        return 1 if self.failed else 0
