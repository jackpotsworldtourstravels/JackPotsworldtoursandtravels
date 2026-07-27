#!/usr/bin/env bash
# Run on the EC2 instance to pull the latest code and restart everything.
#   cd /opt/jackpots && bash deploy/redeploy.sh
set -euo pipefail

REPO_DIR=/opt/jackpots

cd "${REPO_DIR}"
git pull

cd "${REPO_DIR}/backend"
venv/bin/pip install -r requirements.txt
venv/bin/python -m alembic upgrade head

cp -r "${REPO_DIR}/frontend/." /var/www/jackpots/

sudo systemctl restart jackpots-backend
sudo systemctl reload nginx

echo "==> Redeployed."
