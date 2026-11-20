"""Shared SQLite harness for HTTP-level tests of the B2B (``models_v2``) admin routes.

Why a copy of the metadata: the real tables carry PostgreSQL-only defaults, FKs, CHECKs
and partial indexes that SQLite cannot parse. Each table is cloned onto a private
``MetaData`` with those stripped (everything becomes nullable) so the REAL mapped classes
and the REAL routers/services run unchanged against throw-away in-memory data. The real
tables are never altered. Nothing here can reach PostgreSQL, ``.env`` or ``dev.db``.

What this does NOT prove: PostgreSQL behaviour (constraints, triggers, enums, partial
unique indexes). Workflows that depend on those stay BLOCKED until a verified disposable
PostgreSQL is available.
"""
from __future__ import annotations

import datetime as dt
import itertools
import re

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import CheckConstraint, DefaultClause, ForeignKeyConstraint, MetaData, create_engine, text
from sqlalchemy import event, func, select
from sqlalchemy.dialects.postgresql import CITEXT, INET
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import tests.conftest  # noqa: F401  (installs the ARRAY/JSONB/BIGINT SQLite shims)
from app.auth.security import create_access_token, hash_password
from app.database.session import get_db
from app.models_v2 import Base as V2Base
from app.models_v2 import User, UserRole, UserStatus

_ids = itertools.count(900001)


@compiles(INET, "sqlite")
def _sqlite_inet(element, compiler, **kw):   # noqa: D401 - test shim
    return "TEXT"


@compiles(CITEXT, "sqlite")
def _sqlite_citext(element, compiler, **kw):  # noqa: D401 - test shim
    return "TEXT"


_NOW = re.compile(r"^\(?\s*(now\(\)|current_timestamp|clock_timestamp\(\)|timezone\(.*\))\s*\)?$", re.I)
_LITERAL = re.compile(r"^(-?\d+(\.\d+)?|'[^']*'|true|false|'\{\}'|'\[\]')$", re.I)


def _sqlite_default(col):
    """Keep the harmless server defaults (0, 'active', false, now()) so rows read back as the app expects."""
    sd = col.server_default
    arg = getattr(sd, "arg", None)
    if sd is None or arg is None:
        return None
    if isinstance(arg, str):                      # a bare string default (e.g. 'merchant_portal') renders quoted
        return DefaultClause(text("'" + arg.replace("'", "''") + "'"))
    raw = str(getattr(arg, "text", arg)).strip()
    if _NOW.match(raw):
        return DefaultClause(text("CURRENT_TIMESTAMP"))
    lit = re.sub(r"::[A-Za-z_][A-Za-z0-9_ ]*(\[\])?", "", raw).strip()
    lit = lit[1:-1].strip() if lit.startswith("(") and lit.endswith(")") else lit
    return DefaultClause(text(lit)) if _LITERAL.match(lit) else None


def next_id() -> int:
    return next(_ids)


def make_engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    seqs: dict[str, int] = {}

    @event.listens_for(engine, "connect")
    def _install_nextval(dbapi_conn, _record):      # PostgreSQL sequences used for human-readable numbers
        def nextval(name):
            seqs[name] = seqs.get(name, 0) + 1
            return seqs[name]
        dbapi_conn.create_function("nextval", 1, nextval)

    md = MetaData()
    skipped = []
    for table in V2Base.metadata.sorted_tables:
        t = table.to_metadata(md)
        for con in list(t.constraints):
            if isinstance(con, (ForeignKeyConstraint, CheckConstraint)):
                t.constraints.discard(con)
        for idx in list(t.indexes):
            t.indexes.discard(idx)
        for col in t.columns:
            col.foreign_keys.clear()
            col.server_default = _sqlite_default(col)
            col.computed = None
            if not col.primary_key:
                col.nullable = True
        try:
            t.create(engine)
        except Exception as exc:  # noqa: BLE001 - a table SQLite cannot hold is simply absent
            skipped.append((table.name, type(exc).__name__))
    engine.skipped_tables = skipped
    return engine


class Harness:
    def __init__(self, *routers):
        self.engine = make_engine()
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        app = FastAPI()
        for r in routers:
            app.include_router(r)

        def _db():
            s = self.Session()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_db] = _db
        self.app = app
        self.client = TestClient(app, raise_server_exceptions=False)

    def db(self):
        return self.Session()

    def user(self, role: UserRole, *, permissions=None, merchant_id=None, name="Test User", email=None,
             merchant_role=None):
        db = self.db()
        # SQLite hands app-created rows max(rowid)+1, so a fixed counter would collide.
        uid = (db.scalar(select(func.max(User.user_id))) or 900000) + 1
        u = User(user_id=uid, full_name=name, email=email or f"u{uid}@tt-qa.com",
                 password_hash=hash_password("Throwaway#123"), role=role, status=UserStatus.ACTIVE,
                 permissions=permissions or [], merchant_id=merchant_id, merchant_role=merchant_role,
                 created_at=dt.datetime.now(dt.timezone.utc))
        db.add(u)
        db.commit()
        out = {"id": uid, "headers": {"Authorization": f"Bearer {create_access_token(uid)}"}}
        db.close()
        return out

    def dispose(self):
        self.engine.dispose()
