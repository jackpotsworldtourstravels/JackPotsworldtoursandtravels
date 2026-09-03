"""Start the backend with Razorpay TEST MODE switched on.

WHY A LAUNCHER AND NOT JUST AN EDIT TO .env
``tests/verify_payments.py`` drives the gateway through the MOCK provider, and
``app/config.py`` hard-codes ``env_file=BACKEND_DIR / ".env"`` -- there is no
setting that selects a different file. Editing ``.env`` to say ``razorpay``
would therefore reconfigure the test suite as well, which would then sign
webhooks with the mock secret and open real test-mode orders on the account.

Pydantic-settings ranks OS environment variables ABOVE the ``.env`` file, so
exporting the payment settings here overrides them for THIS PROCESS ONLY.
``.env`` keeps saying ``mock``, the suite keeps passing, and no code had to
learn about a second configuration file.

PORT 8000 IS NOT ARBITRARY. The frontend's ``API_BASE`` pins localhost to
``:8000``; served anywhere else the browser would call an origin with no
backend on it. Stop the ordinary dev server before starting this one.

    python run_razorpay.py            # :8000, what the browser needs
    python run_razorpay.py --port 8010  # anywhere else: API testing only

The port option exists because 8000 is often already held -- by the ordinary
dev server, or by a suite run. A server on another port serves the API fine;
it is only the BROWSER flow that needs 8000.

Reads ``.env.razorpay`` (gitignored). Payment settings only -- DATABASE_URL,
JWT_SECRET_KEY and the rest still come from ``.env`` as usual.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
ENV_FILE = BACKEND_DIR / ".env.razorpay"

#: Exported from the file. Anything else in it is ignored rather than trusted:
#: this launcher exists to switch on payments, not to become a second way to
#: reconfigure the database or the JWT secret.
ALLOWED = {
    "PAYMENT_PROVIDER",
    "PAYMENT_ENVIRONMENT",
    "PAYMENT_TIMEOUT_SECONDS",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
}

#: Never printed. The banner below confirms a value is SET without echoing it,
#: because a terminal is scrollback, screen-shared and often pasted into chat.
SECRET = {"RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"}


def load(path: Path) -> dict[str, str]:
    if not path.exists():
        sys.exit(
            f"{path.name} not found.\n\n"
            "Create it next to .env with PAYMENT_PROVIDER=razorpay and your\n"
            "rzp_test_ credentials. It is gitignored by `backend/.env.*`.\n"
            "See .env.example for what each variable means."
        )
    found: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key in ALLOWED:
            # Quotes stripped so KEY="value" and KEY=value behave the same.
            found[key] = value.strip().strip('"').strip("'")
    return found


def port_from_argv(argv: list[str]) -> int:
    """``--port N``, defaulting to the 8000 the browser flow requires."""
    if "--port" in argv:
        i = argv.index("--port")
        try:
            return int(argv[i + 1])
        except (IndexError, ValueError):
            sys.exit("--port needs a number, e.g. --port 8010")
    return 8000


def main() -> None:
    values = load(ENV_FILE)
    port = port_from_argv(sys.argv[1:])

    provider = values.get("PAYMENT_PROVIDER", "").lower()
    if provider != "razorpay":
        sys.exit(
            f"{ENV_FILE.name} says PAYMENT_PROVIDER={provider or '<unset>'!r}.\n"
            "This launcher exists to run Razorpay; use the ordinary dev server "
            "for anything else."
        )

    key_id = values.get("RAZORPAY_KEY_ID", "")
    if not key_id.startswith("rzp_test_"):
        # THE ONE GUARD THAT MATTERS HERE. PAYMENT_ENVIRONMENT does not pick the
        # credentials -- the key prefix does -- so a live key pasted into this
        # file would take real money from a laptop with no other warning.
        sys.exit(
            f"RAZORPAY_KEY_ID is {key_id[:12]!r}..., which is not a test key.\n"
            "This launcher runs TEST MODE only and refuses anything that does "
            "not start with rzp_test_."
        )

    os.environ.update(values)

    print("=" * 68)
    print("  Razorpay TEST MODE")
    print("=" * 68)
    for key in sorted(ALLOWED):
        if key in values:
            shown = "<set>" if key in SECRET else values[key]
            print(f"  {key:<26} {shown}")
    print(f"  {'server':<26} http://127.0.0.1:{port}")
    if port != 8000:
        print(f"  {'NOTE':<26} the browser flow needs :8000 (API_BASE pins it)")
    print("=" * 68)
    print("  Test money only. Orders are real orders on the test account.")
    print("=" * 68)

    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=port, app_dir=str(BACKEND_DIR))


if __name__ == "__main__":
    main()
