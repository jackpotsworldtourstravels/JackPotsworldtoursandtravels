"""Database role separation — MIGRATION_DATABASE_URL vs the runtime DATABASE_URL.

Verifies, WITHOUT connecting to any database:
* Alembic's URL (``settings.alembic_url``) prefers ``MIGRATION_DATABASE_URL`` and
  falls back to ``DATABASE_URL`` (single-role local dev / CI unchanged);
* the runtime application engine binds ``DATABASE_URL`` and never the migration URL;
* the migration credential is isolated to Alembic — the runtime session module
  never references it;
* ``alembic/env.py`` connects via ``settings.alembic_url`` using its own NullPool
  migration engine (not a second application engine).

No PostgreSQL connection, no migrations. create_engine is lazy, so importing the
session module and reading engine.url does not open a connection.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.engine import make_url

import app.database.session as session_mod
from app.config import Settings, settings

_RUNTIME = "postgresql+psycopg2://runtime_role:pw@db-host:5432/jpw"
_MIGRATION = "postgresql+psycopg2://migration_role:pw@db-host:5432/jpw"


def _settings(**over):
    base = dict(database_url=_RUNTIME, jwt_secret_key="x")
    base.update(over)
    return Settings(**base)


# --- configuration validation + URL separation ------------------------------
def test_alembic_url_prefers_migration_url_when_set():
    s = _settings(migration_database_url=_MIGRATION)
    assert s.alembic_url == _MIGRATION
    assert s.database_url == _RUNTIME            # runtime URL is untouched


def test_alembic_url_falls_back_to_database_url_when_unset(monkeypatch):
    monkeypatch.delenv("MIGRATION_DATABASE_URL", raising=False)
    s = _settings()
    assert s.migration_database_url is None
    assert s.alembic_url == _RUNTIME            # single-role fallback (unchanged behaviour)


def test_setting_a_migration_url_does_not_change_the_runtime_url():
    s = _settings(migration_database_url=_MIGRATION)
    assert s.database_url == _RUNTIME and s.alembic_url != s.database_url


# --- runtime engine behaviour ------------------------------------------------
def test_runtime_engine_binds_database_url_not_migration():
    assert session_mod.engine.url == make_url(settings.database_url)
    if settings.migration_database_url and settings.migration_database_url != settings.database_url:
        assert str(session_mod.engine.url) != settings.migration_database_url


def test_runtime_session_module_never_reads_the_migration_credential():
    src = Path(session_mod.__file__).read_text(encoding="utf-8")
    assert "migration_database_url" not in src
    assert "alembic_url" not in src
    assert "settings.database_url" in src       # it DOES bind the runtime URL


# --- migration configuration -------------------------------------------------
def test_alembic_env_connects_via_alembic_url():
    env_py = Path(session_mod.__file__).resolve().parents[2] / "alembic" / "env.py"
    src = env_py.read_text(encoding="utf-8")
    assert "settings.alembic_url" in src                 # migration-URL selection
    assert "settings.database_url" not in src            # not the runtime URL directly
    assert "create_engine(DATABASE_URL" in src           # its own short-lived migration engine


# --- Stage 3 migration-safety: fail closed in deployed (staging/production) --
_REPO = Path(session_mod.__file__).resolve().parents[3]   # repo root (… /backend/app/database/session.py)


def test_deployed_without_migration_url_fails_closed():
    """Staging/production migration FAILS without MIGRATION_DATABASE_URL."""
    s = _settings(deployed=True)
    assert s.migration_database_url is None
    with pytest.raises(RuntimeError, match="MIGRATION_DATABASE_URL"):
        _ = s.alembic_url            # refuses to fall back to the runtime DATABASE_URL


def test_deployed_uses_dedicated_migration_url_when_supplied():
    """Migration uses the dedicated URL when supplied (deployed)."""
    s = _settings(deployed=True, migration_database_url=_MIGRATION)
    assert s.alembic_url == _MIGRATION
    assert s.database_url == _RUNTIME            # runtime URL still the runtime role


def test_runtime_uses_only_database_url_even_when_deployed():
    """Runtime continues using ONLY DATABASE_URL (never the migration URL)."""
    assert session_mod.engine.url == make_url(settings.database_url)


def test_local_dev_fallback_behaves_as_documented_when_not_deployed():
    """Local development fallback: not deployed + no migration URL → DATABASE_URL, no raise."""
    s = _settings(deployed=False)
    assert s.alembic_url == _RUNTIME


def test_normal_application_startup_never_executes_alembic():
    """The serve-only entrypoint runs Alembic ONLY behind the explicit opt-in,
    and render.yaml no longer opts in — so a normal start never migrates."""
    entry = (_REPO / "deploy" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    assert "RUN_MIGRATIONS_ON_START:-false" in entry                       # default OFF
    assert "Serve-only: migrations are a separate step" in entry           # default branch does not migrate
    import re
    render = (_REPO / "render.yaml").read_text(encoding="utf-8")
    m = re.search(r'-\s*key:\s*RUN_MIGRATIONS_ON_START\s*\n\s*value:\s*"(\w+)"', render)
    assert m and m.group(1) == "false"                                     # no migrate-on-start


def test_deploy_scripts_fail_closed_without_migration_url_when_deployed():
    """deploy/migrate.sh and the entrypoint opt-in both refuse to migrate a
    deployed host without MIGRATION_DATABASE_URL (no silent runtime fallback)."""
    mig = (_REPO / "deploy" / "migrate.sh").read_text(encoding="utf-8")
    assert 'DEPLOYED:-false' in mig and "MIGRATION_DATABASE_URL" in mig and "exit 1" in mig
    entry = (_REPO / "deploy" / "docker-entrypoint.sh").read_text(encoding="utf-8")
    assert 'DEPLOYED:-false' in entry and "MIGRATION_DATABASE_URL" in entry and "exit 1" in entry
