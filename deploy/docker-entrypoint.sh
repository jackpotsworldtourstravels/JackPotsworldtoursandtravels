#!/bin/sh
# Container start-up.
#
# ROLE SEPARATION (default): the application container is SERVE-ONLY and does NOT
# run database migrations. It connects with the least-privilege runtime
# DATABASE_URL, which need not hold DDL rights. Migrations are a SEPARATE, explicit
# step run with the migration/owner role — see deploy/migrate.sh and
# docs/STAGE_3_DATABASE_ROLE_SEPARATION_FINAL_SPECIFICATION.md.
#
# OPT-IN escape hatch for single-service hosts that have no release phase
# (Render/Railway/Fly free tiers): set RUN_MIGRATIONS_ON_START=true to run
# `alembic upgrade head` before serving. Only do this where this container's
# effective Alembic URL (MIGRATION_DATABASE_URL, else DATABASE_URL) holds DDL
# rights. It is OFF by default, so migrations never run automatically here.
set -e

# Started as root only to repair volume ownership; everything else runs as the
# unprivileged `app` user (created in the Dockerfile). Re-exec under setpriv so
# any migration and gunicorn never hold root.
if [ "$(id -u)" = "0" ]; then
    UPLOAD_DIR="${UPLOAD_ROOT:-/app/uploads}"
    mkdir -p "$UPLOAD_DIR"
    if [ "$(stat -c %u "$UPLOAD_DIR")" != "10001" ]; then
        echo "Fixing ownership of $UPLOAD_DIR for the app user..."
        chown -R 10001:10001 "$UPLOAD_DIR"
    fi
    exec setpriv --reuid=10001 --regid=10001 --init-groups "$0" "$@"
fi

cd /app/backend

if [ "${RUN_MIGRATIONS_ON_START:-false}" = "true" ]; then
    # Opt-in migrate-on-start (single-service hosts with no release phase). On a
    # deployed host this STILL fails closed without a dedicated migration
    # credential — we never migrate with the restricted runtime DATABASE_URL.
    if [ "${DEPLOYED:-false}" = "true" ] && [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
        echo "ERROR: RUN_MIGRATIONS_ON_START=true on a deployed host but MIGRATION_DATABASE_URL" >&2
        echo "       is not set. Refusing to migrate with the runtime DATABASE_URL. Set" >&2
        echo "       MIGRATION_DATABASE_URL, or run migrations as a separate step (deploy/migrate.sh)." >&2
        exit 1
    fi
    echo "RUN_MIGRATIONS_ON_START=true: running 'alembic upgrade head' before serving..."
    alembic upgrade head
else
    echo "Serve-only: migrations are a separate step (deploy/migrate.sh) and are NOT run here."
fi

echo "Starting gunicorn on port ${PORT:-8000}..."
exec gunicorn app.main:app \
    -k uvicorn.workers.UvicornWorker \
    --workers "${WEB_CONCURRENCY:-2}" \
    --bind "0.0.0.0:${PORT:-8000}" \
    --timeout 120 \
    --access-logfile - \
    --error-logfile -
