"""Unit tests for the DATABASE_URL safety gate in ``tests/seed_gate_accounts.py``.

These exercise ONLY the hardened URL validation — no database is created,
connected to, or touched. The seeder lives in the repo-root ``tests/`` directory
(a script dir, not an importable package), so it is loaded by path; its
top-level imports are stdlib-only, so importing it here needs neither a database
nor the backend application.

The gate parses DATABASE_URL with SQLAlchemy's ``make_url`` and validates the
PARSED host (loopback allowlist) and PARSED database name (``*_test`` / ``*_qa``
suffix). The point of parsing instead of substring matching is that a loopback
name smuggled into the credentials / path / query can no longer spoof the host
check, and malformed / host-less / name-less / wrong-scheme URLs fail closed.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# repo_root/backend/tests/test_seed_gate_accounts.py -> parents[2] == repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
SEEDER_PATH = REPO_ROOT / "tests" / "seed_gate_accounts.py"


def _load_seeder():
    spec = importlib.util.spec_from_file_location("gate_seed_under_test", SEEDER_PATH)
    assert spec and spec.loader, f"cannot load seeder at {SEEDER_PATH}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


seed = _load_seeder()


# ---------------------------------------------------------------------------
# URLs that MUST be accepted — local, disposable *_test / *_qa databases.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "url, expect_host, expect_db",
    [
        # Valid localhost test database.
        ("postgresql+psycopg2://gate:gatepw@localhost:5432/jptt_test", "localhost", "jptt_test"),
        # Valid 127.0.0.1 test database.
        ("postgresql+psycopg2://gate:gatepw@127.0.0.1:5432/jptt_qa", "127.0.0.1", "jptt_qa"),
        # Valid IPv6 loopback test database (brackets stripped by the parser).
        ("postgresql+psycopg2://gate:gatepw@[::1]:5432/jptt_test", "::1", "jptt_test"),
    ],
)
def test_accepts_local_test_database(url, expect_host, expect_db):
    parsed = seed._validate_local_test_url(url)
    assert parsed.host == expect_host
    assert parsed.database == expect_db


# ---------------------------------------------------------------------------
# URLs that MUST be refused. Each is crafted so exactly one guard fires, proving
# that guard works on its own.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "url",
    [
        # Production RDS hostname — db name LOOKS disposable, host check must still fire.
        "postgresql+psycopg2://app:pw@jptt-prod.abc123.ap-south-1.rds.amazonaws.com:5432/jptt_test",
        # Production database name on localhost — host is fine, name check must fire.
        "postgresql+psycopg2://app:pw@localhost:5432/jptt_prod",
        # Hostname spoofed through credentials: the loopback token sits in the
        # username/password; the PARSED host is evil.example.com, so it is refused.
        "postgresql+psycopg2://localhost:5432@evil.example.com:5432/app_test",
        # Malformed URL — unparseable, fails closed.
        "this is definitely not a url",
        # Missing database name.
        "postgresql+psycopg2://app:pw@localhost:5432/",
        # Missing hostname.
        "postgresql+psycopg2://app:pw@/jptt_test",
        # Unsupported scheme (not PostgreSQL).
        "mysql+pymysql://app:pw@localhost:3306/jptt_test",
        # Legacy postgres:// alias — backend name "postgres", not "postgresql".
        "postgres://app:pw@localhost:5432/jptt_test",
        # Empty string.
        "",
    ],
    ids=[
        "production_rds_hostname",
        "production_db_name_on_localhost",
        "hostname_spoofed_through_credentials",
        "malformed_url",
        "missing_database_name",
        "missing_hostname",
        "unsupported_scheme",
        "legacy_postgres_alias",
        "empty_url",
    ],
)
def test_rejects_unsafe_database(url):
    with pytest.raises(seed._UnsafeDatabaseURL):
        seed._validate_local_test_url(url)


# ---------------------------------------------------------------------------
# The host check is driven by the parser, not substrings: a loopback token in
# any non-host component (user, password, path, query) must not let a remote
# host through.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg2://localhost:5432@evil.example.com:5432/app_test",      # credentials
        "postgresql+psycopg2://app:pw@evil.example.com:5432/realdb?opt=localhost_test",  # query
        "postgresql+psycopg2://app:pw@evil.example.com:5432/realdb_test#localhost",  # fragment-ish
    ],
)
def test_loopback_token_outside_host_cannot_spoof(url):
    with pytest.raises(seed._UnsafeDatabaseURL):
        seed._validate_local_test_url(url)


# ---------------------------------------------------------------------------
# _refuse_non_local(): reads DATABASE_URL, returns the RAW string on success
# (password intact, so create_engine still connects), exits hard on refusal.
# ---------------------------------------------------------------------------
def test_refuse_non_local_returns_raw_string_on_valid(monkeypatch):
    url = "postgresql+psycopg2://gate:s3cr3t@localhost:5432/jptt_test"
    monkeypatch.setenv("DATABASE_URL", url)
    returned = seed._refuse_non_local()
    # The raw string is returned verbatim — NOT str(parsed_url), which would
    # mask the password as *** and break the real connection.
    assert returned == url


def test_refuse_non_local_exits_on_invalid(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql+psycopg2://app:pw@db.prod.rds.amazonaws.com:5432/app_prod"
    )
    with pytest.raises(SystemExit):
        seed._refuse_non_local()


def test_refuse_non_local_exits_on_missing_env(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(SystemExit):
        seed._refuse_non_local()


# ---------------------------------------------------------------------------
# A refused URL must be rejected BEFORE create_engine() / any connection.
# create_engine is imported inside main() AFTER the gate, so a tripwire on
# sqlalchemy.create_engine must never fire for a refused URL.
# ---------------------------------------------------------------------------
def test_refused_url_never_reaches_create_engine(monkeypatch):
    import sqlalchemy

    calls: list = []

    def _tripwire(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("create_engine must not be called for a refused URL")

    monkeypatch.setattr(sqlalchemy, "create_engine", _tripwire)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+psycopg2://app:pw@jptt-prod.abc123.ap-south-1.rds.amazonaws.com:5432/jptt_test",
    )

    with pytest.raises(SystemExit):
        seed.main()
    assert calls == [], "the gate must refuse before any engine is created"
