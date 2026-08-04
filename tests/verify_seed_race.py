"""The admin seed, run concurrently — the way gunicorn actually runs it.

WHAT THIS CATCHES
``user_service.ensure_default_admin`` is a FastAPI startup hook, and gunicorn
boots ``WEB_CONCURRENCY`` workers that each run it against the same database.
On a fresh deploy every worker passes the "does an admin exist?" check before
any of them commits, so they all insert and only one can win ``uq_users_email``.

The losers used to raise ``IntegrityError`` straight out of the startup event,
which killed the worker — production logged *"[ERROR] Reason: Worker failed to
boot."* on every cold start. It self-healed, because gunicorn restarted the
worker and by then the row existed, so the container still went healthy and the
crash looked like noise in the log rather than a bug.

Measured against the pre-fix code: **7 of 8 workers raised**. This script fails
if any of them does.

NO SERVER NEEDED, like verify_storage.py — the thing under test is a startup
hook, not an endpoint. Driving it over HTTP would only prove that a server which
already booted can serve a request.

IT DOES NOT TOUCH THE REAL ADMIN. ``ADMIN_SEED_EMAIL`` is pointed at a
``.example`` address, which is what the function reads, so the row created and
deleted here is its own. A test that seeded the actual admin account would
either collide with it or delete it.
"""
import os
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

#: Set before importing the service — it reads the environment at call time,
#: but pinning it up here keeps the real admin out of reach for the whole run.
SEED_EMAIL = "seed.race.verify@jackpotsworldtours.example"
os.environ["ADMIN_SEED_EMAIL"] = SEED_EMAIL
os.environ["ADMIN_SEED_PASSWORD"] = "SeedRace#Verify2026"

from sqlalchemy import delete, func, select  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_v2 import User  # noqa: E402
from app.services import user_service  # noqa: E402

from config import Checker  # noqa: E402  (after sys.path surgery)

check = Checker()

#: More than the two workers production runs — a race that only shows up under
#: contention should be given some.
WORKERS = 8


def _remove_seed_row():
    db = SessionLocal()
    try:
        db.execute(delete(User).where(User.email == SEED_EMAIL))
        db.commit()
    finally:
        db.close()


def _seed_concurrently() -> list[BaseException]:
    """Release ``WORKERS`` threads into the seed at the same instant."""
    barrier = threading.Barrier(WORKERS)
    raised: list[BaseException] = []
    lock = threading.Lock()

    def worker():
        db = SessionLocal()
        try:
            # Each worker gets its own session, as each gunicorn worker does.
            barrier.wait()
            user_service.ensure_default_admin(db)
        except BaseException as exc:  # noqa: BLE001 — anything at all is a failure
            with lock:
                raised.append(exc)
        finally:
            db.close()

    threads = [threading.Thread(target=worker) for _ in range(WORKERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return raised


def _seed_row_count() -> int:
    db = SessionLocal()
    try:
        return db.scalar(select(func.count()).select_from(User).where(User.email == SEED_EMAIL)) or 0
    finally:
        db.close()


print(f"== cold start: {WORKERS} workers, no admin row yet ==")
_remove_seed_row()
errors = _seed_concurrently()
for exc in errors:
    print(f"    raised {type(exc).__name__}: {str(exc)[:100]}")
check(f"no worker raised (all {WORKERS} booted)", not errors,
      f"{len(errors)} raised: {sorted({type(e).__name__ for e in errors})}")
check("exactly one admin row was created", _seed_row_count() == 1, f"count={_seed_row_count()}")

print("\n== a session that lost the race is still usable ==")
# An IntegrityError leaves the transaction aborted: without the rollback, every
# later query on that session fails too, so one lost race would poison the rest
# of startup rather than just this call.
db = SessionLocal()
try:
    user_service.ensure_default_admin(db)
    total = db.scalar(select(func.count()).select_from(User)) or 0
    check("the session can still query after the seed", total > 0, total)
finally:
    db.close()

print("\n== warm start: the row already exists ==")
errors = _seed_concurrently()
check("still no raises", not errors, f"{len(errors)} raised")
check("still exactly one admin row", _seed_row_count() == 1, f"count={_seed_row_count()}")

_remove_seed_row()
check("the test cleaned up after itself", _seed_row_count() == 0)

sys.exit(check.report())
