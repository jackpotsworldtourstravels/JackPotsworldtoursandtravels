"""Is this server ready for live HDFC SmartGateway charges?

Read-only. Opens no connection to HDFC, writes nothing, and never prints a
secret value -- only setting NAMES and set / unset / too-short verdicts.

Run it where the production settings live, e.g. on the server:

    cd deploy && docker compose exec app python scripts/check_hdfc_production.py

Exit status 0 means no blocking gap (warnings may remain); 1 means at least one
blocker, so it can gate a deploy script.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Runnable as `python scripts/check_hdfc_production.py` from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.payments import hdfc_readiness  # noqa: E402


def main() -> int:
    checks = hdfc_readiness.evaluate()
    print(hdfc_readiness.render(checks))
    return 1 if hdfc_readiness.blockers(checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
