#!/bin/sh
# Container start-up: bring the schema to head, then serve.
#
# Running migrations here rather than as a separate deploy step keeps a
# single-service host (Render/Railway/Fly free tiers have no release phase)
# from booting application code against an out-of-date schema.
set -e

# Started as root only to repair volume ownership; everything else runs as the
# unprivileged `app` user (created in the Dockerfile). Re-exec under setpriv so
# migrations and gunicorn never hold root.
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

echo "Running database migrations..."
alembic upgrade head

echo "Starting gunicorn on port ${PORT:-8000}..."
exec gunicorn app.main:app \
    -k uvicorn.workers.UvicornWorker \
    --workers "${WEB_CONCURRENCY:-2}" \
    --bind "0.0.0.0:${PORT:-8000}" \
    --timeout 120 \
    --access-logfile - \
    --error-logfile -
