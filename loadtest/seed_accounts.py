"""Create test members and mint access tokens for the signed-in load cohort.

WHY THIS EXISTS
    locustfile.py's Member profile needs real access tokens, and it cannot get
    them during the test: sign-in is rate-limited to 5/minute PER IP (both
    /signup and /request-otp) and login codes are EMAILED on a deployed host.
    This script provisions accounts slowly, ahead of time, against a host where
    the OTP comes back in the response (OTP_DEV_ECHO=true), and writes the
    tokens to a file the load test reads.

WHERE TO RUN IT
    Against a STAGING host configured with OTP_DEV_ECHO=true. It will NOT work
    against production, where the code is emailed and never returned -- which
    is correct and by design. Never point a load test at production anyway.

USAGE
    python loadtest/seed_accounts.py --host http://localhost:8000 --count 50
    # writes loadtest/tokens.txt, then:
    TOKENS_FILE=loadtest/tokens.txt locust -f loadtest/locustfile.py --host <same host>

RATE LIMITS ARE REAL
    Signup and request-otp are 5/minute per IP. This script paces itself to
    stay under that. Fifty accounts therefore take ~10 minutes; that is the
    rate limit, not the script being slow. Seed once and reuse tokens.txt.
"""
from __future__ import annotations

import argparse
import secrets
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("This script needs 'requests':  pip install requests")

# Stay comfortably under the 5/minute-per-IP limit on /signup and /request-otp.
# One signup == one request-otp equivalent; 13s between accounts keeps each
# endpoint under ~5/min with margin.
SECONDS_BETWEEN_ACCOUNTS = 13.0


def _password() -> str:
    # A password that satisfies a typical min-8 + mixed-case + digit policy.
    return "Load" + secrets.token_hex(4) + "A9!"


def make_account(host: str, i: int) -> str | None:
    """Sign up + verify one throwaway account. Returns an access token or None."""
    email = f"loadtest+{secrets.token_hex(6)}@example.com"
    mobile = "9" + "".join(secrets.choice("0123456789") for _ in range(9))
    pw = _password()

    r = requests.post(
        f"{host}/api/customer/auth/signup",
        json={
            "full_name": f"Load Test {i}",
            "email": email,
            "mobile": mobile,
            "password": pw,
            "confirm_password": pw,
        },
        timeout=30,
    )
    if r.status_code == 429:
        print("  rate-limited on signup; waiting 60s...")
        time.sleep(60)
        return None
    if r.status_code >= 300:
        print(f"  signup failed ({r.status_code}): {r.text[:200]}")
        return None

    body = r.json()
    challenge = body.get("challenge_token")
    code = body.get("dev_otp")
    if not code:
        print(
            "  no dev_otp in the response -- this host is not in dev OTP mode. "
            "Set OTP_DEV_ECHO=true on the STAGING host (never production)."
        )
        return None

    v = requests.post(
        f"{host}/api/customer/auth/verify-otp",
        json={"challenge_token": challenge, "code": code},
        timeout=30,
    )
    if v.status_code >= 300:
        print(f"  verify failed ({v.status_code}): {v.text[:200]}")
        return None
    return v.json().get("access_token")


def main() -> None:
    ap = argparse.ArgumentParser(description="Provision load-test member tokens.")
    ap.add_argument("--host", required=True, help="Base URL, e.g. http://localhost:8000")
    ap.add_argument("--count", type=int, default=50, help="How many accounts to create")
    ap.add_argument("--out", default="loadtest/tokens.txt", help="Where to write tokens")
    args = ap.parse_args()

    host = args.host.rstrip("/")
    tokens: list[str] = []
    print(
        f"Provisioning {args.count} accounts against {host}. "
        f"Pacing ~{SECONDS_BETWEEN_ACCOUNTS:g}s each to respect the 5/min limit "
        f"(~{args.count * SECONDS_BETWEEN_ACCOUNTS / 60:.0f} min total)."
    )
    for i in range(args.count):
        token = make_account(host, i)
        if token:
            tokens.append(token)
            print(f"  [{len(tokens)}/{args.count}] ok")
        if i < args.count - 1:
            time.sleep(SECONDS_BETWEEN_ACCOUNTS)

    if not tokens:
        sys.exit("No tokens minted. Check the host is in dev OTP mode and reachable.")

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(tokens) + "\n")
    print(f"\nWrote {len(tokens)} tokens to {args.out}")
    print(f"Now run:  TOKENS_FILE={args.out} locust -f loadtest/locustfile.py --host {host}")


if __name__ == "__main__":
    main()
