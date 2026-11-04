#!/usr/bin/env bash
# Start the isolated QA env using a throwaway Docker PostgreSQL (postgres:16-alpine,
# matching the CI service image). This path needs NO access to any existing local
# Postgres password: the container is created with credentials we set here.
#
# Requires: Docker Desktop running.  Usage:  bash qa/scripts/start_test_env.docker.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER="jpw_qa_pg"
PORT_DB=5435            # host port -> container 5432. 5433/5434 are used by other
                        # local project DBs on this machine; 5435 was free. Change if needed.
PORT_APP=8099

export DATABASE_URL="postgresql+psycopg2://jpw_qa:jpw_qa_local@localhost:${PORT_DB}/jpw_qa"
export JWT_SECRET_KEY="qa-local-only-not-a-secret-0123456789abcdef"
export DEPLOYED=false DEBUG=true PAYMENT_PROVIDER=none PAYMENT_ENVIRONMENT=test
export OTP_DEV_ECHO=true STORAGE_BACKEND=local OCR_PROVIDER=none WEB_CONCURRENCY=1
export FRONTEND_BASE_URL="http://127.0.0.1:${PORT_APP}"
export CORS_ORIGINS="http://127.0.0.1:${PORT_APP},http://localhost:${PORT_APP}"
export JPW_QA_BASE="http://127.0.0.1:${PORT_APP}" JPW_BASE="http://127.0.0.1:${PORT_APP}"

# 1. SAFETY GATE first
python -I qa/scripts/check_db_safety.py

# 2. Throwaway Postgres container
if [ -z "$(docker ps -q -f name=^/${CONTAINER}$)" ]; then
  docker rm -f "${CONTAINER}" 2>/dev/null || true
  docker run -d --name "${CONTAINER}" \
    -e POSTGRES_USER=jpw_qa -e POSTGRES_PASSWORD=jpw_qa_local -e POSTGRES_DB=jpw_qa \
    -p ${PORT_DB}:5432 postgres:16-alpine >/dev/null
fi
echo "Waiting for Postgres..."
for i in $(seq 1 30); do
  if docker exec "${CONTAINER}" pg_isready -U jpw_qa >/dev/null 2>&1; then break; fi
  sleep 1
done

# 3. Migrate + seed
( cd backend && alembic upgrade head )

# 4. Boot app (background)
( cd backend && python -m uvicorn app.main:app --host 127.0.0.1 --port ${PORT_APP} --no-access-log \
    > ../qa/scripts/server.out.log 2> ../qa/scripts/server.err.log & echo $! > ../qa/scripts/server.pid )
echo "Started. Health: curl http://127.0.0.1:${PORT_APP}/api/health"
echo "Stop with: bash qa/scripts/stop_test_env.docker.sh"
