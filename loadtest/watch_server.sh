#!/usr/bin/env bash
# Watch the server DURING a load test, and flag the two failure modes that mean
# "the site is getting stuck": the database connection pool filling up, and
# gunicorn killing requests that ran past its 120s timeout.
#
# Run this ON THE DEPLOY HOST, in a second terminal, while the load test runs
# from your machine. Ctrl-C to stop.
#
#   bash loadtest/watch_server.sh
#
# It uses docker compose the same way the RUNBOOK does. Override the compose
# invocation with $DC if your setup differs.

set -u

DC=${DC:-"docker compose -f deploy/docker-compose.yml --project-directory deploy"}
INTERVAL=${INTERVAL:-5}     # seconds between samples

# The live database connection count. The pool ceiling is ~30 (2 workers x 15);
# when this pins near 30 and stays there, requests are queuing for a connection.
conn_sql="SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();"

echo "Watching every ${INTERVAL}s. DB pool ceiling is ~30. Ctrl-C to stop."
echo "-------------------------------------------------------------------------"
printf '%-20s %-14s %-16s %-16s\n' "time" "db_conns" "pool_timeouts" "worker_timeouts"

while true; do
  ts=$(date '+%Y-%m-%d %H:%M:%S')

  conns=$($DC exec -T app python -c "
from sqlalchemy import text
from app.database.session import SessionLocal
db = SessionLocal()
print(db.execute(text(\"$conn_sql\")).scalar())
db.close()" 2>/dev/null | tr -d '[:space:]')
  [ -z "$conns" ] && conns="?"

  # Count the tell-tale errors in the last 2 minutes of app logs.
  logs=$($DC logs --since 2m app 2>/dev/null)
  pool=$(printf '%s' "$logs" | grep -c "QueuePool limit")
  wtim=$(printf '%s' "$logs" | grep -c "WORKER TIMEOUT")

  flag=""
  [ "$conns" != "?" ] && [ "$conns" -ge 28 ] 2>/dev/null && flag="  <-- pool nearly full"
  [ "$pool" -gt 0 ] 2>/dev/null && flag="  <-- STUCK: pool timeouts"

  printf '%-20s %-14s %-16s %-16s%s\n' "$ts" "$conns" "$pool" "$wtim" "$flag"
  sleep "$INTERVAL"
done
