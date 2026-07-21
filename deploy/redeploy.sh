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

cp "${REPO_DIR}"/index.html "${REPO_DIR}"/login.html "${REPO_DIR}"/register.html "${REPO_DIR}"/forgot-password.html "${REPO_DIR}"/reset-password.html "${REPO_DIR}"/admin.html /var/www/jackpots/
if [ -d "${REPO_DIR}/assets" ]; then
  cp -r "${REPO_DIR}/assets" /var/www/jackpots/
fi

sudo systemctl restart jackpots-backend
sudo systemctl reload nginx

echo "==> Redeployed."
