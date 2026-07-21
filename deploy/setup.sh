#!/usr/bin/env bash
# Run this ONCE on a fresh Ubuntu 22.04/24.04 EC2 instance, as the ubuntu user, from the repo root:
#   git clone <your-repo-url> /opt/jackpots
#   cd /opt/jackpots && sudo bash deploy/setup.sh
#
# It installs nginx/postgres/python, creates the DB, sets up the venv, installs the
# systemd service, and configures nginx. You still need to: edit backend/.env,
# run alembic migrations, and set the domain in nginx before it works end to end.
set -euo pipefail

REPO_DIR=/opt/jackpots
DB_NAME=jackpotsworldtours
DB_USER=jackpots
DB_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")

echo "==> Installing system packages"
apt-get update -y
apt-get install -y nginx postgresql postgresql-contrib python3-venv python3-pip certbot python3-certbot-nginx

echo "==> Creating PostgreSQL role and database"
sudo -u postgres psql -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'; END IF; END \$\$;"
sudo -u postgres psql -c "SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec"

echo "==> Setting up Python virtualenv"
cd "${REPO_DIR}/backend"
python3 -m venv venv
venv/bin/pip install --upgrade pip
venv/bin/pip install -r requirements.txt

if [ ! -f .env ]; then
  echo "==> Writing backend/.env (edit CORS_ORIGINS / JWT_SECRET_KEY as needed)"
  JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  cat > .env <<EOF
DATABASE_URL=postgresql+psycopg2://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
JWT_SECRET_KEY=${JWT_SECRET}
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
REFRESH_TOKEN_EXPIRE_DAYS=7
CORS_ORIGINS=https://YOUR_DOMAIN,https://www.YOUR_DOMAIN
EOF
  echo "    Generated DB password and JWT secret. Database credentials saved only in backend/.env."
fi

echo "==> Running Alembic migrations"
venv/bin/python -m alembic upgrade head

echo "==> Installing systemd service"
cp "${REPO_DIR}/deploy/jackpots-backend.service" /etc/systemd/system/jackpots-backend.service
systemctl daemon-reload
systemctl enable --now jackpots-backend

echo "==> Deploying static frontend"
mkdir -p /var/www/jackpots
cp "${REPO_DIR}"/index.html "${REPO_DIR}"/login.html "${REPO_DIR}"/register.html "${REPO_DIR}"/forgot-password.html "${REPO_DIR}"/reset-password.html "${REPO_DIR}"/admin.html /var/www/jackpots/
if [ -d "${REPO_DIR}/assets" ]; then
  cp -r "${REPO_DIR}/assets" /var/www/jackpots/
fi

echo "==> Configuring nginx"
cp "${REPO_DIR}/deploy/nginx.conf" /etc/nginx/sites-available/jackpots
ln -sf /etc/nginx/sites-available/jackpots /etc/nginx/sites-enabled/jackpots
rm -f /etc/nginx/sites-enabled/default
echo "    NOTE: edit /etc/nginx/sites-available/jackpots and replace YOUR_DOMAIN with your real domain,"
echo "    then run: sudo nginx -t && sudo systemctl reload nginx"
echo "    Once DNS points at this instance, get HTTPS with: sudo certbot --nginx -d YOUR_DOMAIN -d www.YOUR_DOMAIN"

nginx -t && systemctl reload nginx || echo "==> nginx config needs YOUR_DOMAIN replaced before it will reload cleanly"

echo "==> Done. Backend status:"
systemctl status jackpots-backend --no-pager -l | head -20
