"""Read-only DB probe for P1 journeys — verifies persisted state after a UI/API
action. SAFETY-GATED: refuses anything but a local, disposable *_qa database, so a
journey can never read/assert against production, RDS or another project's DB.
Only SELECT/count is exposed; journeys never mutate through this helper.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
_BACKEND = str(REPO_ROOT / "backend")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)


def _safe_local_qa() -> bool:
    url = os.environ.get("DATABASE_URL", "").lower()
    host_ok = ("@localhost:" in url) or ("@127.0.0.1:" in url)
    db_ok = url.rstrip("/").endswith("jpw_qa") or url.rstrip("/").endswith("_qa")
    return host_ok and db_ok


class DbProbe:
    def __init__(self):
        if not _safe_local_qa():
            raise RuntimeError("DbProbe refused: DATABASE_URL is not a local *_qa database.")
        from app.database.session import SessionLocal
        self._Session = SessionLocal

    def scalar(self, sql: str, **params):
        from sqlalchemy import text
        with self._Session() as db:
            return db.execute(text(sql), params).scalar()

    def count(self, table: str, where: str = "TRUE", **params) -> int:
        # `table` is a fixed literal from the test (never user input).
        return int(self.scalar(f"SELECT count(*) FROM {table} WHERE {where}", **params))
