"""Database safety gate — REFUSES to proceed unless DATABASE_URL points at a
local, throwaway QA database. Run this BEFORE any migration or cleanup.

Exit 0 = safe to proceed. Exit 1 = refused (prints why). No DB connection is
made here; this is a pure string/host check so it is safe to run anywhere.

Usage:
    python qa/scripts/check_db_safety.py            # reads DATABASE_URL from env
    python qa/scripts/check_db_safety.py <url>      # or pass explicitly
"""
from __future__ import annotations

import os
import sys
from urllib.parse import urlparse

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}

# Any of these in the URL means it is NOT a throwaway local DB -> refuse hard.
PROD_MARKERS = (
    "rds.amazonaws.com", "amazonaws.com", "neon.tech", "render.com",
    "supabase", "azure", "googleapis", "trustbrick", "api.jackpotsworld",
    "jackpotsworldtours.com", "prod", "production", "live",
)

# The QA database name must look disposable.
OK_DB_SUFFIXES = ("jpw_qa", "_qa", "_test", "_ci")


def check(url: str) -> list[str]:
    problems: list[str] = []
    if not url:
        return ["DATABASE_URL is empty — refusing."]
    low = url.lower()
    for marker in PROD_MARKERS:
        if marker in low:
            problems.append(f"URL contains production/remote marker {marker!r}.")
    # normalise scheme for urlparse (postgresql+psycopg2 -> postgresql)
    p = urlparse(url.replace("postgresql+psycopg2", "postgresql")
                    .replace("postgresql+asyncpg", "postgresql"))
    host = (p.hostname or "").lower()
    if host not in LOCAL_HOSTS:
        problems.append(f"Host {host!r} is not local (allowed: {sorted(LOCAL_HOSTS)}).")
    dbname = (p.path or "").lstrip("/").lower()
    if not any(dbname.endswith(s) or dbname == s for s in OK_DB_SUFFIXES):
        problems.append(f"DB name {dbname!r} does not end with a disposable suffix "
                        f"{OK_DB_SUFFIXES} — refusing to touch it.")
    return problems


def check_env_flags() -> list[str]:
    warns: list[str] = []
    if os.environ.get("DEPLOYED", "false").lower() == "true":
        warns.append("DEPLOYED=true — must be false on the isolated env.")
    pp = os.environ.get("PAYMENT_PROVIDER", "none").lower()
    if pp not in ("", "none"):
        warns.append(f"PAYMENT_PROVIDER={pp!r} — expected 'none' on the isolated env.")
    return warns


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DATABASE_URL", "")
    problems = check(url)
    flagwarn = check_env_flags()

    shown = url
    # redact any password in the shown URL
    if "@" in shown and "://" in shown:
        head, tail = shown.split("://", 1)
        if "@" in tail:
            creds, rest = tail.split("@", 1)
            if ":" in creds:
                user = creds.split(":", 1)[0]
                shown = f"{head}://{user}:***@{rest}"
    print(f"DATABASE_URL = {shown or '(unset)'}")

    if problems:
        print("\nREFUSED - this does not look like a throwaway local QA database:")
        for pr in problems:
            print(f"  [X] {pr}")
        return 1

    print("  [OK] host is local, db name is disposable, no production markers")
    for w in flagwarn:
        print(f"  [!] {w}")
    if flagwarn:
        print("\nREFUSED - environment flags are unsafe for the isolated env.")
        return 1
    print("\nSAFE - ok to migrate/seed/cleanup this database.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
