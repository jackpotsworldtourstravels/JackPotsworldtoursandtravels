"""Proof that the test-database isolation guard (tests/_db_guard.py) works.

Every assertion here is either a pure function check or an attempt that the
guard intercepts BEFORE any network I/O: the blocked ``psycopg2.connect``
raises without opening a socket. Nothing here can reach a real database.
"""
from __future__ import annotations

import os

import pytest

from tests import _db_guard as guard

SAFE12 = "postgresql+psycopg2://phase12_admin:pw@127.0.0.1:55432/jackpots_phase12_test"
SAFE13 = "postgresql+psycopg2://phase13_admin:pw@127.0.0.1:55434/jackpots_phase13_test"
V2 = "postgresql+psycopg2://postgres:pw@127.0.0.1:5432/jackpots_v2"

isolated_only = pytest.mark.skipif(guard.mode() != "isolated", reason="runs only in the default isolated mode")


# ================================================================== the decision (pure)
def test_default_run_is_isolated_even_when_dotenv_style_urls_are_present():
    mode, flag, url = guard.resolve({"DATABASE_URL": "sqlite:///./ci_test.db"})
    assert (mode, flag, url) == ("isolated", None, guard.BLOCKED_URL)
    assert guard.resolve({})[2] == guard.BLOCKED_URL


@pytest.mark.parametrize("env", [
    {"DATABASE_URL": V2},                                            # the permanent dev DB, no flag
    {"PHASE13_PG": "1", "DATABASE_URL": V2},                         # flag + jackpots_v2
    {"DATABASE_URL": SAFE13, "MIGRATION_DATABASE_URL": V2},          # migration URL at jackpots_v2
    {"PHASE13_PG": "1", "DATABASE_URL": SAFE13.replace("jackpots_phase13_test", "jackpots_v2")},
])
def test_any_jackpots_v2_url_is_refused(env):
    with pytest.raises(guard.UnsafeTestDatabase, match="jackpots_v2|forbidden"):
        guard.resolve(env)


@pytest.mark.parametrize("flag,url", [
    ("PHASE13_PG", SAFE13.replace("55434", "5432")),                       # wrong port (the native service)
    ("PHASE13_PG", SAFE13.replace("127.0.0.1", "localhost")),               # host must be exactly 127.0.0.1
    ("PHASE13_PG", SAFE13.replace("127.0.0.1", "10.0.0.5")),                # remote host
    ("PHASE13_PG", SAFE13.replace("jackpots_phase13_test", "jackpots_phase13")),  # wrong database name
    ("PHASE13_PG", SAFE13.replace("phase13_admin", "postgres")),            # wrong role
    ("PHASE13_PG", SAFE13 + "?sslmode=disable"),                            # query strings not allowed
    ("PHASE13_PG", SAFE13.replace("postgresql+psycopg2", "postgresql+asyncpg")),
    ("PHASE13_PG", SAFE12),                                                 # Phase 12 DB under the Phase 13 flag
    ("PHASE12_PG", SAFE13),                                                 # and vice versa
    ("PHASE13_PG", None),                                                   # flag without a URL
    ("PHASE13_PG", "not a url"),
])
def test_flag_with_a_non_matching_url_aborts(flag, url):
    env = {flag: "1"}
    if url is not None:
        env["DATABASE_URL"] = url
    with pytest.raises(guard.UnsafeTestDatabase):
        guard.resolve(env)


def test_exact_disposable_urls_are_accepted_only_with_their_own_flag():
    assert guard.resolve({"PHASE13_PG": "1", "DATABASE_URL": SAFE13}) == ("disposable", "PHASE13_PG", SAFE13)
    assert guard.resolve({"PHASE12_PG": "1", "DATABASE_URL": SAFE12}) == ("disposable", "PHASE12_PG", SAFE12)
    # The same URL WITHOUT the flag is still isolated: no flag, no real database.
    assert guard.resolve({"DATABASE_URL": SAFE13})[0] == "isolated"
    # A flag value other than exactly "1" is not an opt-in.
    assert guard.resolve({"PHASE13_PG": "true", "DATABASE_URL": SAFE13})[0] == "isolated"


@pytest.mark.parametrize("env", [
    {"PHASE12_PG": "1", "PHASE13_PG": "1", "DATABASE_URL": SAFE13},
    {"REFUND_TEST_POSTGRES_URL": "postgresql+psycopg2://ci_user:ci_pass@localhost:5432/ci_migrations"},
    {"MIGRATION_DATABASE_URL": "postgresql+psycopg2://x:y@127.0.0.1:5432/other"},
    {"PHASE13_PG": "1", "DATABASE_URL": SAFE13, "MIGRATION_DATABASE_URL": SAFE12},
])
def test_other_unsafe_combinations_abort(env):
    with pytest.raises(guard.UnsafeTestDatabase):
        guard.resolve(env)


def test_install_refuses_when_app_config_was_imported_first(monkeypatch):
    import sys
    monkeypatch.setitem(guard._state, "installed", False)
    monkeypatch.setitem(sys.modules, "app.config", sys.modules.get("app.config") or object())
    with pytest.raises(guard.UnsafeTestDatabase, match="imported before"):
        guard.install()


# ================================================================== this very run
@isolated_only
def test_this_run_uses_the_blocked_sentinel_everywhere():
    from app.config import settings
    from app.database.session import SessionLocal, engine

    assert os.environ["DATABASE_URL"] == guard.BLOCKED_URL
    assert settings.database_url == guard.BLOCKED_URL
    assert guard.effective_alembic_url(settings) == guard.BLOCKED_URL
    if hasattr(type(settings), "alembic_url"):          # Stage 3 checkouts: the REAL value is checked too
        assert settings.alembic_url == guard.BLOCKED_URL
    assert engine.url.render_as_string(hide_password=False) == guard.BLOCKED_URL
    assert SessionLocal.kw["bind"] is engine
    assert "jackpots_v2" not in settings.database_url
    assert engine.url.host == "127.0.0.1" and engine.url.port == 9


@isolated_only
def test_a_real_connection_attempt_is_blocked_recorded_and_attributed():
    from sqlalchemy import text

    from app.database.session import SessionLocal

    before = guard.attempt_count()
    with pytest.raises(Exception) as exc:
        with SessionLocal() as s:
            s.execute(text("select 1"))
    assert "Real PostgreSQL connection attempted" in str(exc.value)
    taken = guard.consume_attempts(before)       # consumed so this deliberate attempt does not fail the test
    assert len(taken) == 1
    assert "test_a_real_connection_attempt_is_blocked_recorded_and_attributed" in taken[0]["test"]


@isolated_only
def test_a_swallowed_attempt_is_still_detected():
    """The B2C audit writer swallows write failures by design; the guard still sees the attempt."""
    from app.models_customer import AdminAuditOutcome
    from app.services import customer_admin_audit_service as b2c_audit

    before = guard.attempt_count()
    b2c_audit.record_independently(admin=None, action="guard.proof", outcome=AdminAuditOutcome.DENIED,
                                   entity_type="test")     # returns normally (resilient writer)...
    taken = guard.consume_attempts(before)
    assert len(taken) == 1, "...but the blocked connection attempt was recorded"


@isolated_only
def test_any_psycopg2_engine_is_blocked_not_just_the_app_engine():
    from sqlalchemy import create_engine, text

    before = guard.attempt_count()
    eng = create_engine(V2)    # would be the permanent dev DB; the connect never leaves the process
    try:
        with pytest.raises(Exception, match="Real PostgreSQL connection attempted"):
            with eng.connect() as c:
                c.execute(text("select 1"))
    finally:
        eng.dispose()
    assert len(guard.consume_attempts(before)) == 1


def test_the_per_test_check_fails_a_test_that_leaks(pytester):
    """End to end in a child pytest run: a test that swallows a blocked attempt is
    reported as an ERROR naming it, and the session fails."""
    pytester.makeconftest(
        "from tests import _db_guard\n"
        "import pytest\n"
        "@pytest.fixture(autouse=True)\n"
        "def _check():\n"
        "    before = _db_guard.attempt_count()\n"
        "    yield\n"
        "    new = _db_guard.attempts()[before:]\n"
        "    if new:\n"
        "        pytest.fail('blocked: ' + new[0]['test'], pytrace=False)\n"
    )
    pytester.makepyfile(test_leaky=(
        "import psycopg2\n"
        "def test_swallows_a_connection():\n"
        "    try:\n"
        "        psycopg2.connect('host=127.0.0.1 port=5432 dbname=jackpots_v2')\n"
        "    except Exception:\n"
        "        pass\n"
    ))
    before = guard.attempt_count()
    result = pytester.runpytest_inprocess("-p", "no:cacheprovider")
    # The child ran in this process, so its (blocked) attempt is in the shared list:
    # take it back out so it is not also charged to this parent test.
    assert len(guard.consume_attempts(before)) == 1
    result.assert_outcomes(passed=1, errors=1)
    result.stdout.fnmatch_lines(["*blocked: *test_leaky.py::test_swallows_a_connection*"])


# ================================================================== CI-only mode
CI_URL = guard.CI_URL
CI_ENV = {
    "CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
    "GITHUB_JOB": "postgres-migrations", "GITHUB_RUN_ID": "123456",
    "JACKPOTS_CI_PG": "1", "DATABASE_URL": CI_URL, "REFUND_TEST_POSTGRES_URL": CI_URL,
}


def test_ci_mode_accepts_exactly_the_job_service():
    assert guard.resolve(dict(CI_ENV)) == ("ci", "JACKPOTS_CI_PG", CI_URL)
    loopback = CI_URL.replace("localhost", "127.0.0.1")
    assert guard.resolve({**CI_ENV, "DATABASE_URL": loopback, "REFUND_TEST_POSTGRES_URL": loopback})[0] == "ci"
    assert guard.resolve({**CI_ENV, "MIGRATION_DATABASE_URL": CI_URL})[0] == "ci"


@pytest.mark.parametrize("marker", ["CI", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS", "GITHUB_JOB",
                                    "GITHUB_RUN_ID"])
def test_ci_mode_refused_without_every_runner_marker(marker):
    env = dict(CI_ENV)
    env.pop(marker)
    with pytest.raises(guard.UnsafeTestDatabase, match="outside the GitHub Actions"):
        guard.resolve(env)


@pytest.mark.parametrize("override", [
    {"GITHUB_JOB": "backend-tests"},             # another job of the same workflow
    {"RUNNER_ENVIRONMENT": "self-hosted"},       # a self-hosted runner may sit next to real databases
    {"RUNNER_OS": "Windows"},
    {"GITHUB_ACTIONS": "false"},
])
def test_ci_mode_refused_on_the_wrong_runner_or_job(override):
    with pytest.raises(guard.UnsafeTestDatabase, match="outside the GitHub Actions"):
        guard.resolve({**CI_ENV, **override})


@pytest.mark.parametrize("url", [
    "postgresql+psycopg2://ci_user:ci_pass@localhost:5432/jackpots_v2",          # the permanent dev DB
    "postgresql+psycopg2://postgres:secret@localhost:5432/jackpots_v2",
    "postgresql+psycopg2://ci_user:ci_pass@db.prod.example.com:5432/ci_migrations",  # remote / production host
    "postgresql+psycopg2://ci_user:ci_pass@10.0.0.5:5432/ci_migrations",
    "postgresql+psycopg2://ci_user:ci_pass@localhost:5433/ci_migrations",       # wrong port
    "postgresql+psycopg2://ci_user:ci_pass@localhost:5432/postgres",            # wrong database
    "postgresql+psycopg2://postgres:ci_pass@localhost:5432/ci_migrations",      # wrong role
    "postgresql+psycopg2://ci_user:real-password@localhost:5432/ci_migrations", # not the throw-away credentials
    "postgresql+psycopg2://ci_user:ci_pass@localhost:5432/ci_migrations?host=10.0.0.5",  # query smuggling
    "postgresql+asyncpg://ci_user:ci_pass@localhost:5432/ci_migrations",         # other driver
    "sqlite:///./ci_test.db",
])
def test_ci_mode_rejects_every_other_url(url):
    with pytest.raises(guard.UnsafeTestDatabase):
        guard.resolve({**CI_ENV, "DATABASE_URL": url, "REFUND_TEST_POSTGRES_URL": url})


@pytest.mark.parametrize("override", [
    {"REFUND_TEST_POSTGRES_URL": CI_URL.replace("localhost", "127.0.0.1")},   # must equal DATABASE_URL
    {"MIGRATION_DATABASE_URL": "postgresql+psycopg2://x:y@localhost:5432/other"},
    {"PHASE13_PG": "1"},
    {"PHASE12_PG": "1"},
    {"JACKPOTS_CI_PG": "true"},                                              # not exactly "1"
    {"REFUND_TEST_POSTGRES_URL": "postgresql+psycopg2://ci_user:ci_pass@localhost:5432/jackpots_v2"},
])
def test_ci_mode_rejects_inconsistent_or_combined_settings(override):
    with pytest.raises(guard.UnsafeTestDatabase):
        guard.resolve({**CI_ENV, **override})


def test_without_the_ci_flag_the_ci_url_is_still_refused_even_on_a_runner():
    env = dict(CI_ENV)
    env.pop("JACKPOTS_CI_PG")
    with pytest.raises(guard.UnsafeTestDatabase, match="REFUND_TEST_POSTGRES_URL"):
        guard.resolve(env)
    env.pop("REFUND_TEST_POSTGRES_URL")
    assert guard.resolve(env)[0] == "isolated", "the SQLite CI job (no flag) stays isolated"


# ------------------------------------------------------------------ the CI allowlist inside the blocker
class _Stub:
    """Stands in for the real psycopg2.connect: proves pass-through without any network."""

    def __init__(self):
        self.calls = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return "stub-connection"


CI_KW = {"host": "localhost", "port": 5432, "dbname": "ci_migrations", "user": "ci_user", "password": "ci_pass"}


@pytest.mark.parametrize("args,kwargs", [
    ((), CI_KW),
    ((), {**CI_KW, "host": "127.0.0.1"}),
    ((), {**CI_KW, "port": "5432"}),
    (("host=localhost port=5432 dbname=ci_migrations user=ci_user password=ci_pass",), {}),
])
def test_ci_blocker_passes_only_the_exact_service(args, kwargs):
    stub = _Stub()
    assert guard.make_blocker(stub, guard.CI_TARGET)(*args, **kwargs) == "stub-connection"
    assert len(stub.calls) == 1


@pytest.mark.parametrize("kwargs", [
    {**CI_KW, "dbname": "jackpots_v2"},
    {**CI_KW, "host": "10.0.0.5"},
    {**CI_KW, "host": "db.prod.example.com"},
    {**CI_KW, "port": 5433},
    {**CI_KW, "user": "postgres"},
    {**CI_KW, "hostaddr": "10.0.0.5"},          # libpq would connect to hostaddr, not host
    {**CI_KW, "service": "prod"},               # pg_service.conf indirection
    {"dsn": "host=localhost port=5432 dbname=jackpots_v2 user=ci_user"},
    {},
])
def test_ci_blocker_blocks_and_records_everything_else(kwargs):
    stub = _Stub()
    before = guard.attempt_count()
    with pytest.raises(guard.RealDatabaseConnectionBlocked):
        guard.make_blocker(stub, guard.CI_TARGET)(**kwargs)
    taken = guard.consume_attempts(before)
    assert stub.calls == [] and len(taken) == 1
    assert "password" not in taken[0]["target"] and "ci_pass" not in taken[0]["target"]


def test_the_default_blocker_has_no_allowlist_even_for_the_ci_service():
    stub = _Stub()
    before = guard.attempt_count()
    with pytest.raises(guard.RealDatabaseConnectionBlocked):
        guard.make_blocker(stub, None)(**CI_KW)
    assert stub.calls == [] and len(guard.consume_attempts(before)) == 1


@isolated_only
def test_this_isolated_run_blocks_the_ci_service_too():
    """Local isolation is not weakened by CI mode: the installed blocker refuses the CI target here."""
    import psycopg2

    before = guard.attempt_count()
    with pytest.raises(guard.RealDatabaseConnectionBlocked):
        psycopg2.connect(**CI_KW)
    assert len(guard.consume_attempts(before)) == 1


# ------------------------------------------------------------------ the workflow stays in sync with the guard
def _workflow_text():
    from pathlib import Path
    return (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")


def test_ci_workflow_matches_the_guard():
    yaml = pytest.importorskip("yaml")
    wf = yaml.safe_load(_workflow_text())
    jobs = wf["jobs"]
    pg = jobs[guard.CI_JOB]
    assert pg["runs-on"] == "ubuntu-latest", "CI mode requires a GitHub-hosted Linux runner"
    svc = pg["services"]["postgres"]
    assert svc["env"] == {"POSTGRES_USER": "ci_user", "POSTGRES_PASSWORD": "ci_pass", "POSTGRES_DB": "ci_migrations"}
    assert svc["ports"] == ["5432:5432"]
    flagged = [s for s in pg["steps"] if guard.CI_FLAG in (s.get("env") or {})]
    assert len(flagged) == 1
    env = flagged[0]["env"]
    assert env[guard.CI_FLAG] == "1"
    assert env["DATABASE_URL"] == env["REFUND_TEST_POSTGRES_URL"] == guard.CI_URL
    assert "tests/test_customer_refunds_postgres.py" in flagged[0]["run"]
    for name, job in jobs.items():
        if name == guard.CI_JOB:
            continue
        for step in job.get("steps", []):
            assert guard.CI_FLAG not in (step.get("env") or {}), (name, step.get("name"))


def test_ci_flag_appears_once_in_the_workflow_text():
    text = _workflow_text()
    assert text.count(f'{guard.CI_FLAG}: "1"') == 1
    assert "jackpots_v2" not in text


# ================================================================== blocker armed in EVERY mode (review fix 1)
P13_KW = {"host": "127.0.0.1", "port": 55434, "dbname": "jackpots_phase13_test", "user": "phase13_admin",
          "password": "pw"}
P12_KW = {"host": "127.0.0.1", "port": 55432, "dbname": "jackpots_phase12_test", "user": "phase12_admin",
          "password": "pw"}


def test_allowlist_for_each_mode():
    assert guard.allowlist_for("isolated", None) is None
    assert guard.allowlist_for("ci", guard.CI_FLAG) == guard.CI_TARGET
    assert guard.allowlist_for("disposable", "PHASE13_PG") == {
        "hosts": ("127.0.0.1",), "port": 55434, "dbname": "jackpots_phase13_test", "user": "phase13_admin"}
    assert guard.allowlist_for("disposable", "PHASE12_PG")["port"] == 55432
    with pytest.raises(guard.UnsafeTestDatabase):
        guard.allowlist_for("anything-else", None)


@pytest.mark.parametrize("flag,args,kwargs", [
    ("PHASE13_PG", (), P13_KW),
    ("PHASE13_PG", (), {**P13_KW, "port": "55434"}),
    ("PHASE13_PG", ("host=127.0.0.1 port=55434 dbname=jackpots_phase13_test user=phase13_admin",), {}),
    ("PHASE12_PG", (), P12_KW),
])
def test_disposable_blocker_passes_only_the_approved_database(flag, args, kwargs):
    stub = _Stub()
    assert guard.make_blocker(stub, guard.disposable_target(flag))(*args, **kwargs) == "stub-connection"
    assert len(stub.calls) == 1


@pytest.mark.parametrize("kwargs", [
    {**P13_KW, "dbname": "postgres"},                     # another database on the same server
    {**P13_KW, "dbname": "jackpots_phase12_test"},        # the other phase's database
    {**P13_KW, "dbname": "jackpots_v2"},                  # the permanent dev database
    {**P13_KW, "user": "jackpots_v2"},                    # jackpots_v2 anywhere is refused
    {**P13_KW, "port": 5432},                             # the native PostgreSQL service
    {**P13_KW, "port": 55432},                            # the Phase 12 port
    {**P13_KW, "host": "localhost"},                      # disposable mode allows exactly 127.0.0.1
    {**P13_KW, "host": "10.0.0.5"},
    {**P13_KW, "user": "postgres"},
    {**P13_KW, "hostaddr": "10.0.0.5"},                   # hostaddr override
    {**P13_KW, "service": "prod"},                        # service override
    {"dsn": "host=127.0.0.1 port=55434 dbname=jackpots_phase13_test user=phase13_admin hostaddr=10.0.0.5"},
    {"dsn": "service=prod"},
    {},
])
def test_disposable_blocker_blocks_every_other_target(kwargs):
    stub = _Stub()
    before = guard.attempt_count()
    with pytest.raises(guard.RealDatabaseConnectionBlocked):
        guard.make_blocker(stub, guard.disposable_target("PHASE13_PG"))(**kwargs)
    assert stub.calls == [] and len(guard.consume_attempts(before)) == 1


@pytest.mark.parametrize("kwargs", [{**CI_KW, "dbname": "jackpots_v2"}, {**CI_KW, "user": "jackpots_v2"},
                                    {"dsn": "host=localhost port=5432 dbname=ci_migrations user=ci_user "
                                            "options='-c search_path=jackpots_v2'"}])
def test_ci_blocker_refuses_jackpots_v2_in_any_parameter(kwargs):
    stub = _Stub()
    before = guard.attempt_count()
    with pytest.raises(guard.RealDatabaseConnectionBlocked):
        guard.make_blocker(stub, guard.CI_TARGET)(**kwargs)
    assert stub.calls == [] and len(guard.consume_attempts(before)) == 1


# ================================================================== unsafe libpq environment (review fix 2)
_MODE_ENVS = {
    "ci": dict(CI_ENV),
    "PHASE13_PG": {"PHASE13_PG": "1", "DATABASE_URL": SAFE13},
    "PHASE12_PG": {"PHASE12_PG": "1", "DATABASE_URL": SAFE12},
}


@pytest.mark.parametrize("mode_name", sorted(_MODE_ENVS))
@pytest.mark.parametrize("var", guard.UNSAFE_LIBPQ_ENV)
def test_unsafe_libpq_variable_aborts_ci_and_disposable_modes(mode_name, var):
    env = {**_MODE_ENVS[mode_name], var: "10.0.0.5"}
    with pytest.raises(guard.UnsafeTestDatabase, match=var):
        guard.resolve(env)


def test_the_listed_libpq_variables_are_exactly_the_redirecting_ones():
    assert set(guard.UNSAFE_LIBPQ_ENV) == {"PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGSYSCONFDIR"}


@pytest.mark.parametrize("mode_name", sorted(_MODE_ENVS))
def test_modes_resolve_when_no_libpq_redirect_is_set(mode_name):
    env = {**_MODE_ENVS[mode_name], "PGHOST": "", "PGPORT": "5432", "PGOPTIONS": "-c statement_timeout=5000"}
    assert guard.resolve(env)[0] in ("ci", "disposable")     # empty PGHOST and non-redirecting vars are fine


@pytest.mark.parametrize("var", guard.UNSAFE_LIBPQ_ENV)
def test_isolated_mode_is_unaffected_by_libpq_variables_because_everything_is_blocked(var):
    assert guard.resolve({var: "10.0.0.5"}) == ("isolated", None, guard.BLOCKED_URL)


# ================================================================== settings / engine consistency
GOOD = SAFE13


def test_settings_problems_empty_when_consistent():
    assert guard.settings_problems("disposable", GOOD, GOOD, GOOD, GOOD) == []
    b = guard.BLOCKED_URL
    assert guard.settings_problems("isolated", b, b, b, b) == []


@pytest.mark.parametrize("mode,expected,db,alembic,engine,needle", [
    ("disposable", GOOD, SAFE12, GOOD, GOOD, "settings.database_url differs"),
    ("disposable", GOOD, GOOD, GOOD, SAFE12, "engine URL differs"),
    ("disposable", GOOD, GOOD, SAFE12, GOOD, "alembic_url differs"),
    ("disposable", GOOD, GOOD, GOOD, V2, "jackpots_v2"),
    ("isolated", guard.BLOCKED_URL, SAFE13, guard.BLOCKED_URL, guard.BLOCKED_URL, "not the blocked sentinel"),
    ("isolated", SAFE13, SAFE13, SAFE13, SAFE13, "not the blocked sentinel"),
    ("ci", CI_URL, CI_URL, V2, CI_URL, "jackpots_v2"),
])
def test_settings_problems_report_every_mismatch(mode, expected, db, alembic, engine, needle):
    problems = guard.settings_problems(mode, expected, db, alembic, engine)
    assert any(needle in p for p in problems), problems


# ================================================================== the REAL install() in a fresh process
_PROBES = {
    "isolated_sentinel": ((), {"host": "127.0.0.1", "port": 9, "dbname": "pytest_blocked_no_such_db",
                               "user": "pytest_blocked"}),
    "ci_service": ((), {"host": "localhost", "port": 5432, "dbname": "ci_migrations", "user": "ci_user"}),
    "phase12": ((), {"host": "127.0.0.1", "port": 55432, "dbname": "jackpots_phase12_test", "user": "phase12_admin"}),
    "phase13": ((), {"host": "127.0.0.1", "port": 55434, "dbname": "jackpots_phase13_test", "user": "phase13_admin"}),
    "jackpots_v2": ((), {"host": "127.0.0.1", "port": 5432, "dbname": "jackpots_v2", "user": "postgres"}),
    "phase13_hostaddr": ((), {"host": "127.0.0.1", "port": 55434, "dbname": "jackpots_phase13_test",
                              "user": "phase13_admin", "hostaddr": "10.0.0.5"}),
    "phase13_service": ((), {"host": "127.0.0.1", "port": 55434, "dbname": "jackpots_phase13_test",
                             "user": "phase13_admin", "service": "prod"}),
}

_CHILD = r"""
import json, os, sys
sys.path.insert(0, os.environ["GUARD_BACKEND"])
import psycopg2
calls = []
def stub(*a, **k):            # stands in for the real connect: NOTHING here can open a socket
    calls.append(1)
    return "STUB"
psycopg2.connect = stub
from tests import _db_guard as g
assert "app.config" not in sys.modules
mode = g.install()
probes = json.loads(os.environ["GUARD_PROBES"])
results = {}
for name, (args, kwargs) in probes.items():
    try:
        psycopg2.connect(*args, **kwargs)
        results[name] = "passed"
    except g.RealDatabaseConnectionBlocked:
        results[name] = "blocked"
print(json.dumps({"mode": mode, "armed": bool(getattr(psycopg2.connect, "_test_db_guard", False)),
                  "results": results, "stub_calls": len(calls), "recorded": len(g.attempts())}))
"""


def _run_install(extra_env):
    import json
    import subprocess
    import sys
    from pathlib import Path

    backend = str(Path(__file__).resolve().parents[1])
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith(("PG", "GITHUB_", "RUNNER_")) or k in (
               "DATABASE_URL", "MIGRATION_DATABASE_URL", "REFUND_TEST_POSTGRES_URL", "PHASE12_PG", "PHASE13_PG",
               "JACKPOTS_CI_PG", "CI"))}
    env.update(extra_env, GUARD_BACKEND=backend, GUARD_PROBES=json.dumps(_PROBES))
    out = subprocess.run([sys.executable, "-I", "-c", _CHILD], env=env, cwd=backend,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def _expect(passing):
    return {name: ("passed" if name in passing else "blocked") for name in _PROBES}


def test_real_install_isolated_mode_blocks_everything():
    r = _run_install({})
    assert r["mode"] == "isolated" and r["armed"] is True
    assert r["results"] == _expect(set()) and r["stub_calls"] == 0 and r["recorded"] == len(_PROBES)


def test_real_install_disposable_phase13_allows_only_its_database():
    r = _run_install({"PHASE13_PG": "1", "DATABASE_URL": SAFE13})
    assert r["mode"] == "disposable" and r["armed"] is True
    assert r["results"] == _expect({"phase13"}) and r["stub_calls"] == 1


def test_real_install_disposable_phase12_allows_only_its_database():
    r = _run_install({"PHASE12_PG": "1", "DATABASE_URL": SAFE12})
    assert r["mode"] == "disposable" and r["armed"] is True
    assert r["results"] == _expect({"phase12"}) and r["stub_calls"] == 1


def test_real_install_ci_mode_allows_only_the_ci_service():
    r = _run_install(dict(CI_ENV))
    assert r["mode"] == "ci" and r["armed"] is True
    assert r["results"] == _expect({"ci_service"}) and r["stub_calls"] == 1


def test_real_install_refuses_libpq_redirect_in_disposable_mode():
    import subprocess
    import sys
    from pathlib import Path

    backend = str(Path(__file__).resolve().parents[1])
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG") and k not in ("DATABASE_URL",)}
    env.update(PHASE13_PG="1", DATABASE_URL=SAFE13, PGHOSTADDR="10.0.0.5", GUARD_BACKEND=backend,
               GUARD_PROBES="{}")
    out = subprocess.run([sys.executable, "-I", "-c", _CHILD], env=env, cwd=backend,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode != 0 and "PGHOSTADDR" in out.stderr and "UnsafeTestDatabase" in out.stderr


# ================================================================== alembic_url compatibility (HEAD has no alembic_url)
class _HeadSettings:
    """Shape of Settings at commit 1e7cd98: database_url only, no alembic_url / migration_database_url."""

    def __init__(self, database_url):
        self.database_url = database_url


class _Stage3Settings:
    """Shape of Settings with the Stage 3 change: alembic_url is a property."""

    def __init__(self, database_url, alembic=None, raise_exc=None):
        self.database_url = database_url
        self._alembic = alembic if alembic is not None else database_url
        self._raise = raise_exc

    @property
    def alembic_url(self):
        if self._raise is not None:
            raise self._raise
        return self._alembic


def test_head_settings_without_alembic_url_fall_back_to_database_url():
    s = _HeadSettings(guard.BLOCKED_URL)
    assert not hasattr(s, "alembic_url")
    assert guard.effective_alembic_url(s) == guard.BLOCKED_URL
    b = guard.BLOCKED_URL
    assert guard.settings_problems("isolated", b, s.database_url, guard.effective_alembic_url(s), b) == []


def test_head_settings_with_an_unsafe_database_url_are_still_rejected():
    s = _HeadSettings(V2)
    problems = guard.settings_problems("isolated", guard.BLOCKED_URL, s.database_url,
                                       guard.effective_alembic_url(s), guard.BLOCKED_URL)
    assert any("jackpots_v2" in p for p in problems) and any("sentinel" in p for p in problems)


def test_stage3_settings_use_the_real_alembic_url():
    assert guard.effective_alembic_url(_Stage3Settings(guard.BLOCKED_URL)) == guard.BLOCKED_URL
    s = _Stage3Settings(guard.BLOCKED_URL, alembic=V2)               # alembic pointing elsewhere
    assert guard.effective_alembic_url(s) == V2, "the real value is used, not the database_url fallback"
    b = guard.BLOCKED_URL
    problems = guard.settings_problems("isolated", b, b, guard.effective_alembic_url(s), b)
    assert any("alembic_url differs" in p for p in problems) and any("jackpots_v2" in p for p in problems)


def test_stage3_alembic_url_errors_are_not_masked_by_the_fallback():
    with pytest.raises(RuntimeError, match="MIGRATION_DATABASE_URL"):
        guard.effective_alembic_url(_Stage3Settings(guard.BLOCKED_URL,
                                                    raise_exc=RuntimeError("MIGRATION_DATABASE_URL required")))
    # Even an AttributeError raised INSIDE an existing property propagates (no silent fallback).
    with pytest.raises(AttributeError):
        guard.effective_alembic_url(_Stage3Settings(guard.BLOCKED_URL, raise_exc=AttributeError("boom")))


def test_this_checkout_matches_its_own_settings_shape():
    """Whichever shape the loaded Settings has, the helper and the session-start check agree with it."""
    from app.config import settings

    if hasattr(type(settings), "alembic_url"):
        assert guard.effective_alembic_url(settings) == settings.alembic_url
    else:
        assert guard.effective_alembic_url(settings) == settings.database_url
