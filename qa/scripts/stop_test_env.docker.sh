#!/usr/bin/env bash
# Stop the Docker-based QA env. Drops the container (and its data) by default —
# that IS the cleanup, since the container is the throwaway database.
set -euo pipefail
cd "$(dirname "$0")/../.."
CONTAINER="jpw_qa_pg"

# 1. Stop the app
if [ -f qa/scripts/server.pid ]; then
  kill "$(cat qa/scripts/server.pid)" 2>/dev/null || true
  rm -f qa/scripts/server.pid
fi

# 2. Remove the throwaway Postgres container (destroys its data = cleanup)
if [ -n "$(docker ps -aq -f name=^/${CONTAINER}$ 2>/dev/null)" ]; then
  docker rm -f "${CONTAINER}" >/dev/null
  echo "Removed container ${CONTAINER} (database destroyed)."
fi
echo "Done."
