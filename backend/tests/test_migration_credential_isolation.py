"""R2 — migration-credential isolation (static checks; no DB, no execution).

Proves the MIGRATION/owner credential (MIGRATION_DATABASE_URL) is supplied ONLY to
the one-off migration process, never to the serve-only runtime app container, and
that its VALUE never lands on a command line or in printed output. All assertions
read deploy files from disk — no PostgreSQL connection, no Alembic, no deploy.
"""
from __future__ import annotations

from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_COMPOSE = (_REPO / "deploy" / "docker-compose.yml").read_text(encoding="utf-8")
_STAGING = (_REPO / "deploy" / "staging" / "docker-compose.staging.yml").read_text(encoding="utf-8")
_REDEPLOY = (_REPO / "deploy" / "redeploy.sh").read_text(encoding="utf-8")
_MIGRATE = (_REPO / "deploy" / "migrate.sh").read_text(encoding="utf-8")
_ENV_EXAMPLE = (_REPO / "backend" / ".env.example").read_text(encoding="utf-8")
_STAGING_ENV = (_REPO / "deploy" / "staging" / "backend.staging.env.example").read_text(encoding="utf-8")
_GITIGNORE = (_REPO / ".gitignore").read_text(encoding="utf-8")

_PASSTHROUGH = "-e MIGRATION_DATABASE_URL --entrypoint /app/deploy/migrate.sh app"


def test_runtime_app_service_never_receives_the_migration_url():
    # The serve-only app is the only non-infra service in these compose files;
    # the migration credential must not appear in them at all.
    assert "MIGRATION_DATABASE_URL" not in _COMPOSE
    assert "MIGRATION_DATABASE_URL" not in _STAGING
    # Nor in the app's env_file template.
    assert "MIGRATION_DATABASE_URL" not in _ENV_EXAMPLE


def test_migration_step_receives_the_dedicated_url_via_bare_passthrough():
    assert _PASSTHROUGH in _REDEPLOY           # production one-off
    assert _PASSTHROUGH in _STAGING_ENV        # staging example, same form


def test_value_is_never_on_a_command_line_or_printed():
    for src in (_REDEPLOY, _STAGING_ENV):
        assert "-e MIGRATION_DATABASE_URL=" not in src        # no value on docker argv
    # Printing the NAME in an error message is fine; printing the VALUE (the
    # variable expansion) is the leak we forbid.
    for name, src in (("redeploy.sh", _REDEPLOY), ("migrate.sh", _MIGRATE)):
        for line in src.splitlines():
            prints = ("echo" in line or "printf" in line)
            shows_value = "$MIGRATION_DATABASE_URL" in line or "${MIGRATION_DATABASE_URL" in line
            if prints and shows_value:
                raise AssertionError(f"{name} prints the migration URL value: {line.strip()!r}")


def test_credential_sourced_from_protected_file_not_backend_env():
    # redeploy sources the protected, gitignored file (or an exported var), never backend/.env.
    assert ".env.migration" in _REDEPLOY
    assert "export MIGRATION_DATABASE_URL" in _REDEPLOY         # forwarded via env, not argv


def test_migration_failure_stops_deployment_before_app_restart():
    # Ordering by the stable step labels: 3b (migrate) precedes 4 (start containers).
    assert _REDEPLOY.index("3b/6") < _REDEPLOY.index("4/6  Starting the containers")
    i = _REDEPLOY.index(_PASSTHROUGH)                           # the migrate run line
    assert "|| fail" in _REDEPLOY[i:i + 400]                    # aborts on failure


def test_deployed_migration_fails_closed_without_the_credential():
    assert "MIGRATION_DATABASE_URL is not set" in _REDEPLOY     # redeploy refuses
    assert "DEPLOYED:-false" in _MIGRATE and "exit 1" in _MIGRATE  # migrate.sh guard


def test_protected_migration_env_is_gitignored_with_committed_template():
    assert "backend/.env.*" in _GITIGNORE                       # real file ignored
    assert "!backend/.env.migration.example" in _GITIGNORE      # template allowed
    tmpl = _REPO / "backend" / ".env.migration.example"
    assert tmpl.exists()
    body = tmpl.read_text(encoding="utf-8")
    assert "MIGRATION_DATABASE_URL=" in body
    assert "<migration_owner_role>" in body                     # placeholder, not a real secret


def test_staging_and_production_use_a_consistent_passthrough_form():
    # Neither host embeds the value in the docker command; both use the bare -e.
    assert _PASSTHROUGH in _REDEPLOY and _PASSTHROUGH in _STAGING_ENV
    assert "-e MIGRATION_DATABASE_URL=" not in _REDEPLOY
    assert "-e MIGRATION_DATABASE_URL=" not in _STAGING_ENV
