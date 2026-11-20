#!/bin/sh
# Explicit, separate database schema migration step (database role separation).
#
# Runs `alembic upgrade head` using the MIGRATION/owner role. The application
# container is serve-only (see deploy/docker-entrypoint.sh) and never runs this.
# Alembic resolves its connection from settings.alembic_url =
# MIGRATION_DATABASE_URL when set, else DATABASE_URL (single-role fallback).
#
# Run this BEFORE starting/upgrading the app, with the migration credential, e.g.
# on the staging stack:
#
#   docker compose -f deploy/staging/docker-compose.staging.yml --env-file stack.env \
#     run --rm --no-deps --entrypoint /app/deploy/migrate.sh \
#     -e MIGRATION_DATABASE_URL="postgresql+psycopg2://<migration_role>:<pw>@postgres:5432/<db>" \
#     app
#
# Applying a migration is an owner-approved action — see the Stage 3 runbook.
set -e

# FAIL CLOSED in deployed (staging/production) environments: a dedicated
# MIGRATION_DATABASE_URL must be supplied; we never silently migrate with the
# restricted runtime DATABASE_URL. DEPLOYED=true marks a deployed host (set in
# render.yaml and the compose stacks). Local dev / CI (DEPLOYED unset/false) keep
# the single-role fallback — Alembic then uses DATABASE_URL via settings.alembic_url.
if [ "${DEPLOYED:-false}" = "true" ] && [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
    echo "ERROR: MIGRATION_DATABASE_URL is required to migrate a deployed (staging/production)" >&2
    echo "       environment. Refusing to fall back to the runtime DATABASE_URL. Pass the" >&2
    echo "       migration/owner credential to this step only (see this script's header)." >&2
    exit 1
fi

cd /app/backend

echo "Running database migrations (alembic upgrade head) as the migration role..."
alembic upgrade head
echo "Migrations complete."
