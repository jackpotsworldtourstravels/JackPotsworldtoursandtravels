"""Test-database isolation guard (Phase 13 safety fix).

WHY. Until this existed, ``tests/conftest.py`` never touched ``DATABASE_URL``, so
any code path that opens the real ``app.database.session.SessionLocal`` without a
test patch (the B2C audit writer ``record_independently`` is the known one) used
``backend/.env`` -> the local permanent ``jackpots_v2`` database. Such writes are
swallowed by design, so the test still passed and nobody noticed.

WHAT THIS DOES (installed from the very top of ``tests/conftest.py``, BEFORE any
``app`` module is imported, so ``app.config.settings`` and the app engine are
built from the values set here):

1. DEFAULT (no opt-in flag): ``DATABASE_URL`` is replaced, for this process only,
   by :data:`BLOCKED_URL` (a closed port on 127.0.0.1). ``.env`` is not read for
   it any more because a process environment variable wins over ``.env``.
2. OPT-IN: exactly one of ``PHASE12_PG=1`` / ``PHASE13_PG=1`` AND a
   ``DATABASE_URL`` that passes :func:`is_allowed_disposable_url` for THAT flag
   (exact driver, user, host ``127.0.0.1``, port, database name, no query string,
   never ``jackpots_v2``). Anything else with a flag set aborts the whole run. The
   blocker stays ARMED and passes only connects to that exact target.
3. UNSAFE INPUTS abort the run: both flags at once, a flag with a non-matching
   URL, any URL mentioning ``jackpots_v2``, ``app.config`` already imported, a
   ``MIGRATION_DATABASE_URL`` that is not the same approved URL,
   ``REFUND_TEST_POSTGRES_URL`` (not an approved flag), and — in CI and
   disposable modes — any of :data:`UNSAFE_LIBPQ_ENV` (never silently unset).
4. CI-ONLY: ``JACKPOTS_CI_PG=1`` inside the GitHub Actions ``postgres-migrations``
   job (runner markers checked) with exactly the job's throw-away service URL. The
   blocker stays ARMED and passes only connects to that service (see CI_TARGET).
5. THE BLOCKER IS ARMED IN EVERY MODE (:func:`allowlist_for`): isolated runs block
   every ``psycopg2.connect`` (which every SQLAlchemy psycopg2 engine calls);
   disposable and CI runs block everything except their single approved target.
   Every blocked attempt raises :class:`RealDatabaseConnectionBlocked` and is
   RECORDED with the running test's id. ``conftest.py`` fails that test at
   teardown and fails the session at the end, so an attempt that application
   code swallows is still loud.

Nothing here connects to anything.
"""
from __future__ import annotations

import os
import sys
import threading

BLOCKED_URL = "postgresql+psycopg2://pytest_blocked:pytest_blocked@127.0.0.1:9/pytest_blocked_no_such_db"

#: flag -> the ONLY disposable database it may use (user, port, database).
DISPOSABLE_TARGETS: dict[str, tuple[str, int, str]] = {
    "PHASE12_PG": ("phase12_admin", 55432, "jackpots_phase12_test"),
    "PHASE13_PG": ("phase13_admin", 55434, "jackpots_phase13_test"),
}

_FORBIDDEN_FRAGMENTS = ("jackpots_v2",)

#: libpq environment variables that can change WHERE a connection goes even when
#: host/port/dbname/user are passed explicitly (explicit parameters win, but these
#: supply parameters we never pass, or change where service definitions come from):
#:   PGHOSTADDR    - used as the address when no `hostaddr` is passed (we never pass one)
#:   PGSERVICE     - a pg_service.conf entry fills every parameter not given, incl. hostaddr
#:   PGSERVICEFILE - points libpq at a different service file
#:   PGSYSCONFDIR  - relocates the system-wide pg_service.conf
#:   PGHOST        - overridden by our explicit host today; rejected as defence in depth
#: Not included (explained in the tracker): PGPORT/PGDATABASE/PGUSER (the blocker
#: requires these explicitly, so they cannot apply), PGOPTIONS/PGSSL*/PGPASSWORD/
#: PGTARGETSESSIONATTRS etc. (session/TLS/credential behaviour, not the destination).
UNSAFE_LIBPQ_ENV = ("PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGSYSCONFDIR")


def disposable_target(flag: str) -> dict:
    """The blocker allowlist for a Phase 12 / Phase 13 disposable database."""
    user, port, database = DISPOSABLE_TARGETS[flag]
    return {"hosts": ("127.0.0.1",), "port": port, "dbname": database, "user": user}


def _reject_unsafe_libpq_env(environ, mode_name: str) -> None:
    present = [v for v in UNSAFE_LIBPQ_ENV if environ.get(v) not in (None, "")]
    if present:
        raise UnsafeTestDatabase(
            f"{', '.join(present)} set in {mode_name} mode: libpq could redirect the connection away from the "
            "approved database. Unset it and re-run (the guard never unsets it for you)."
        )

# ---------------------------------------------------------------------------
# CI-ONLY MODE. The `postgres-migrations` job in .github/workflows/ci.yml starts a
# throw-away `postgres:16-alpine` service container (ci_user / ci_pass /
# ci_migrations, published on localhost:5432) that exists only for that job. Its
# URL is written literally in the workflow — this is the ONLY URL CI mode accepts.
# As in every mode, the connection blocker stays ARMED in CI mode and
# lets through only a connect whose host/port/dbname/user are exactly these.
# ---------------------------------------------------------------------------
CI_FLAG = "JACKPOTS_CI_PG"
CI_JOB = "postgres-migrations"
CI_URL = "postgresql+psycopg2://ci_user:ci_pass@localhost:5432/ci_migrations"
CI_TARGET = {"hosts": ("localhost", "127.0.0.1"), "port": 5432, "dbname": "ci_migrations", "user": "ci_user"}
#: GitHub Actions sets these on every hosted runner; together with the job id they
#: tie CI mode to that job, so it cannot switch on by accident on a workstation
#: (where localhost:5432 is the local server that hosts jackpots_v2).
_CI_RUNNER_MARKERS = {"CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                      "RUNNER_OS": "Linux", "GITHUB_JOB": CI_JOB}


def is_ci_service_url(url: str | None) -> bool:
    """True only for the exact throw-away CI service URL (credentials included)."""
    if not url or any(f in url.lower() for f in _FORBIDDEN_FRAGMENTS):
        return False
    from sqlalchemy.engine import make_url  # parsing only
    try:
        u = make_url(url)
    except Exception:  # noqa: BLE001
        return False
    return (
        u.drivername == "postgresql+psycopg2"
        and u.username == CI_TARGET["user"] and u.password == "ci_pass"
        and u.host in CI_TARGET["hosts"] and u.port == CI_TARGET["port"]
        and u.database == CI_TARGET["dbname"] and not u.query
    )


def _resolve_ci(environ) -> tuple[str, str, str]:
    missing = [k for k, v in _CI_RUNNER_MARKERS.items() if environ.get(k) != v]
    if missing or not environ.get("GITHUB_RUN_ID"):
        raise UnsafeTestDatabase(
            f"{CI_FLAG}=1 outside the GitHub Actions '{CI_JOB}' job (missing/mismatched: "
            f"{', '.join(missing + ([] if environ.get('GITHUB_RUN_ID') else ['GITHUB_RUN_ID']))}). Refusing to run tests."
        )
    if any(environ.get(f) == "1" for f in DISPOSABLE_TARGETS):
        raise UnsafeTestDatabase(f"{CI_FLAG} cannot be combined with PHASE12_PG / PHASE13_PG.")
    _reject_unsafe_libpq_env(environ, "CI")
    url = environ.get("DATABASE_URL")
    refund = environ.get("REFUND_TEST_POSTGRES_URL")
    migration = environ.get("MIGRATION_DATABASE_URL")
    if not is_ci_service_url(url):
        raise UnsafeTestDatabase(f"{CI_FLAG}=1 but DATABASE_URL is not the CI service database. Refusing to run tests.")
    if refund and refund != url:
        raise UnsafeTestDatabase(f"{CI_FLAG}=1 but REFUND_TEST_POSTGRES_URL differs from DATABASE_URL.")
    if migration and migration != url:
        raise UnsafeTestDatabase(f"{CI_FLAG}=1 but MIGRATION_DATABASE_URL differs from DATABASE_URL.")
    return "ci", CI_FLAG, url


class UnsafeTestDatabase(RuntimeError):
    """The environment asks the test run to use a database it may not use."""


class RealDatabaseConnectionBlocked(RuntimeError):
    """A test tried to open a real PostgreSQL connection while isolated."""


_state = {"installed": False, "mode": None, "flag": None}
_attempts: list[dict] = []
_lock = threading.Lock()


def is_allowed_disposable_url(url: str | None, flag: str) -> bool:
    """True only if ``url`` is exactly the disposable database ``flag`` allows."""
    if not url or flag not in DISPOSABLE_TARGETS:
        return False
    lowered = url.lower()
    if any(f in lowered for f in _FORBIDDEN_FRAGMENTS):
        return False
    from sqlalchemy.engine import make_url  # parsing only; no connection
    try:
        u = make_url(url)
    except Exception:  # noqa: BLE001 - unparsable is unsafe
        return False
    user, port, database = DISPOSABLE_TARGETS[flag]
    return (
        u.drivername == "postgresql+psycopg2"
        and u.username == user
        and u.host == "127.0.0.1"
        and u.port == port
        and u.database == database
        and not u.query
    )


def resolve(environ) -> tuple[str, str | None, str]:
    """Decide the run mode from an environment mapping (pure; testable).

    Returns ``(mode, flag, database_url)`` where mode is ``"isolated"``,
    ``"disposable"`` or ``"ci"``. Raises :class:`UnsafeTestDatabase` for every unsafe input.
    """
    flags = [f for f in DISPOSABLE_TARGETS if environ.get(f) == "1"]
    url = environ.get("DATABASE_URL")
    migration = environ.get("MIGRATION_DATABASE_URL")

    for name in ("DATABASE_URL", "MIGRATION_DATABASE_URL", "REFUND_TEST_POSTGRES_URL"):
        value = environ.get(name)
        if value and any(f in value.lower() for f in _FORBIDDEN_FRAGMENTS):
            raise UnsafeTestDatabase(f"{name} points at a forbidden database (jackpots_v2). Refusing to run tests.")
    if environ.get(CI_FLAG) == "1":
        return _resolve_ci(environ)
    if environ.get(CI_FLAG):
        raise UnsafeTestDatabase(f"{CI_FLAG} must be exactly '1' or unset.")
    if environ.get("REFUND_TEST_POSTGRES_URL"):
        raise UnsafeTestDatabase(
            "REFUND_TEST_POSTGRES_URL is set, but only the Phase 12 / Phase 13 disposable-database flags or "
            f"the CI-only mode ({CI_FLAG}=1 inside the GitHub Actions '{CI_JOB}' job) may enable a real "
            "PostgreSQL test run. Unset it."
        )
    for name, value in (("DATABASE_URL", url), ("MIGRATION_DATABASE_URL", migration)):
        if value and any(f in value.lower() for f in _FORBIDDEN_FRAGMENTS):
            raise UnsafeTestDatabase(f"{name} points at a forbidden database (jackpots_v2). Refusing to run tests.")
    if len(flags) > 1:
        raise UnsafeTestDatabase("Both PHASE12_PG and PHASE13_PG are set; choose exactly one disposable database.")
    if flags:
        flag = flags[0]
        _reject_unsafe_libpq_env(environ, flag)
        if not is_allowed_disposable_url(url, flag):
            user, port, database = DISPOSABLE_TARGETS[flag]
            raise UnsafeTestDatabase(
                f"{flag}=1 but DATABASE_URL is not the approved disposable database "
                f"(postgresql+psycopg2://{user}:…@127.0.0.1:{port}/{database}). Refusing to run tests."
            )
        if migration and migration != url:
            raise UnsafeTestDatabase(f"{flag}=1 but MIGRATION_DATABASE_URL differs from the disposable DATABASE_URL.")
        return "disposable", flag, url
    if migration:
        raise UnsafeTestDatabase(
            "MIGRATION_DATABASE_URL is set for an isolated test run; unset it (tests must not resolve a real "
            "migration database)."
        )
    return "isolated", None, BLOCKED_URL


def install() -> str:
    """Apply :func:`resolve` to ``os.environ`` and arm the connection blocker.

    Idempotent. Must run before ``app.config`` is imported."""
    if _state["installed"]:
        return _state["mode"]
    if "app.config" in sys.modules or "app.database.session" in sys.modules:
        raise UnsafeTestDatabase(
            "app.config was imported before the test-database guard ran; settings may already hold a real "
            "DATABASE_URL. Refusing to run tests."
        )
    mode, flag, url = resolve(os.environ)
    os.environ["DATABASE_URL"] = url
    _state.update(installed=True, mode=mode, flag=flag)
    _arm_psycopg2_blocker(allow=allowlist_for(mode, flag))   # armed in EVERY mode
    return mode


def allowlist_for(mode: str, flag: str | None) -> dict | None:
    """``None`` (everything blocked) for isolated runs; the single approved target otherwise."""
    if mode == "isolated":
        return None
    if mode == "ci":
        return CI_TARGET
    if mode == "disposable":
        return disposable_target(flag)
    raise UnsafeTestDatabase(f"unknown guard mode {mode!r}")


def effective_alembic_url(settings) -> str:
    """The URL Alembic would use, for the consistency check.

    COMPATIBILITY: ``Settings.alembic_url`` (and ``migration_database_url``) come
    from the Stage 3 role-separation change, which is not in every checkout (it is
    absent at commit 1e7cd98). Only when the Settings CLASS has no such attribute
    do we fall back to ``database_url`` — exactly what Alembic itself used before
    Stage 3. When the attribute exists, its REAL value is read and validated, and
    anything it raises (e.g. the deployed-without-migration-URL RuntimeError)
    propagates rather than being masked."""
    if hasattr(type(settings), "alembic_url") or "alembic_url" in getattr(settings, "__dict__", {}):
        return settings.alembic_url
    return settings.database_url


def settings_problems(mode: str, expected_url: str, database_url: str, alembic_url: str, engine_url: str) -> list[str]:
    """Why the loaded app settings / engine do not match what the guard chose
    (empty list = consistent). Pure; used by conftest's pytest_sessionstart."""
    problems = []
    if database_url != expected_url:
        problems.append("settings.database_url differs from the guarded DATABASE_URL")
    if engine_url != expected_url:
        problems.append("the app engine URL differs from the guarded DATABASE_URL")
    if alembic_url != expected_url:
        problems.append("settings.alembic_url differs from the guarded DATABASE_URL")
    if any(f in (database_url + alembic_url + engine_url).lower() for f in _FORBIDDEN_FRAGMENTS):
        problems.append("a forbidden database (jackpots_v2) is configured")
    if mode == "isolated" and database_url != BLOCKED_URL:
        problems.append("isolated run but the runtime URL is not the blocked sentinel")
    return problems


def connect_target(args, kwargs) -> dict:
    """host/port/dbname/user of a psycopg2.connect call, from kwargs and/or a DSN
    string. Parsing only (``parse_dsn`` opens no connection)."""
    params: dict = {}
    dsn = args[0] if args else kwargs.get("dsn")
    if dsn:
        from psycopg2.extensions import parse_dsn
        params.update(parse_dsn(dsn))
    params.update({k: v for k, v in kwargs.items() if k != "dsn"})
    if "database" in params and "dbname" not in params:
        params["dbname"] = params["database"]
    return params


def matches_target(args, kwargs, allow) -> bool:
    """True only if this connect names exactly ``allow``'s host/port/dbname/user,
    with no hostaddr/service indirection and nothing mentioning jackpots_v2."""
    try:
        p = connect_target(args, kwargs)
        port = int(p.get("port")) if p.get("port") is not None else None
    except Exception:  # noqa: BLE001 - unparsable is not allowed
        return False
    if any(f in str(v).lower() for v in p.values() for f in _FORBIDDEN_FRAGMENTS):
        return False
    return (p.get("host") in allow["hosts"] and port == allow["port"]
            and p.get("dbname") == allow["dbname"] and p.get("user") == allow["user"]
            and not p.get("service") and not p.get("hostaddr"))


def matches_ci_target(args, kwargs, allow=CI_TARGET) -> bool:   # kept for existing callers/tests
    return matches_target(args, kwargs, allow)


def mode() -> str | None:
    return _state["mode"]


def _arm_psycopg2_blocker(allow: dict | None = None) -> None:
    try:
        import psycopg2
    except ImportError:  # pragma: no cover - psycopg2 is a backend requirement
        return
    if getattr(psycopg2.connect, "_test_db_guard", False):
        return
    psycopg2.connect = make_blocker(psycopg2.connect, allow)


def make_blocker(original, allow: dict | None = None):
    """A ``psycopg2.connect`` replacement. With ``allow=None`` every call is
    blocked; with ``allow=CI_TARGET`` only an exact CI-service connect reaches
    ``original``. Every blocked call is recorded (host/port/dbname only — never
    the password) with the running test's id, then raises."""

    def _blocked_connect(*args, **kwargs):
        if allow is not None and matches_target(args, kwargs, allow):
            return original(*args, **kwargs)
        try:
            p = connect_target(args, kwargs)
            target = f"host={p.get('host')} port={p.get('port')} dbname={p.get('dbname')}"
        except Exception:  # noqa: BLE001
            target = "<unparsable>"
        with _lock:
            _attempts.append({
                "test": os.environ.get("PYTEST_CURRENT_TEST", "<outside a test>"),
                "target": target,
                "thread": threading.current_thread().name,
            })
        raise RealDatabaseConnectionBlocked(
            f"Real PostgreSQL connection attempted during a guarded test run ({target}; "
            f"test: {os.environ.get('PYTEST_CURRENT_TEST', '<outside a test>')}). "
            "Patch the code path to use the test database."
        )

    _blocked_connect._test_db_guard = True
    return _blocked_connect


def attempts() -> list[dict]:
    with _lock:
        return list(_attempts)


def attempt_count() -> int:
    with _lock:
        return len(_attempts)


def consume_attempts(since: int) -> list[dict]:
    """Remove and return attempts recorded after index ``since`` (for tests that
    deliberately prove the blocker works)."""
    with _lock:
        taken = _attempts[since:]
        del _attempts[since:]
        return taken
