#!/bin/sh
# Container start-up: bring the schema to head, then serve.
#
# Running migrations here rather than as a separate deploy step keeps a
# single-service host (Render/Railway/Fly free tiers have no release phase)
# from booting application code against an out-of-date schema.
set -e

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
