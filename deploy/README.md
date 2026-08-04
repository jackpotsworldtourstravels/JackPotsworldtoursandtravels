# Deploying to AWS EC2 — SUPERSEDED

> **Use [../docs/AWS_DEPLOYMENT.md](../docs/AWS_DEPLOYMENT.md) instead.**
>
> This guide predates the Docker image and the S3 document backend, and it
> installs PostgreSQL on the web server — where an instance rebuild takes the
> database with it, and where booking documents live only on that one disk.
> The current guide uses RDS and S3 so the instance stays disposable.
>
> Kept because the nginx and systemd files here are still a working reference
> for a no-Docker deployment. Do not follow both guides: `setup.sh` installs a
> second PostgreSQL and an nginx that will fight the Caddy container for
> port 80.

All-in-one setup: one EC2 instance runs nginx (static frontend + reverse proxy),
the FastAPI backend (gunicorn/uvicorn via systemd), and PostgreSQL.

## 1. Launch the EC2 instance (AWS Console)

1. EC2 → **Launch instance**.
2. AMI: **Ubuntu Server 24.04 LTS**.
3. Instance type: **t3.micro** (free-tier eligible; upgrade later if needed).
4. Key pair: create a new one, download the `.pem` file, keep it safe — you can't
   re-download it later.
5. Network settings → **Edit** → security group rules:
   - SSH (22) — source: **My IP** (not 0.0.0.0/0, to avoid brute-force exposure)
   - HTTP (80) — source: Anywhere (0.0.0.0/0)
   - HTTPS (443) — source: Anywhere (0.0.0.0/0)
   - Do **not** open 8000 or 5432 publicly — nginx proxies to the backend locally,
     and Postgres should only be reachable from the instance itself.
6. Storage: 20 GB gp3 is plenty to start.
7. Launch.

## 2. Allocate an Elastic IP

Instance IPs change if you stop/start the instance. Allocate a static one:
EC2 → **Elastic IPs** → Allocate → Associate with your new instance.
(Free while attached to a running instance; small hourly charge if left unattached.)

## 3. Point your domain at it

In your domain registrar / Route 53, add an **A record** for your domain
(and `www`) pointing at the Elastic IP. DNS propagation can take a few minutes
to a few hours.

## 4. SSH in and deploy

```bash
chmod 400 your-key.pem
ssh -i your-key.pem ubuntu@<ELASTIC_IP>

sudo mkdir -p /opt/jackpots && sudo chown ubuntu:ubuntu /opt/jackpots
git clone <your-repo-url> /opt/jackpots
cd /opt/jackpots
sudo bash deploy/setup.sh
```

`setup.sh` installs nginx/PostgreSQL/Python, creates the database, sets up the
backend venv, generates `backend/.env` with a random DB password and JWT
secret, runs Alembic migrations, installs the `jackpots-backend` systemd
service, and copies the static HTML into `/var/www/jackpots`.

## 5. Set your real domain

Two places still say `YOUR_DOMAIN` — replace both with your actual domain:

```bash
sudo nano /etc/nginx/sites-available/jackpots     # server_name line
sudo nano /opt/jackpots/backend/.env               # CORS_ORIGINS line
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart jackpots-backend
```

## 6. Enable HTTPS

```bash
sudo certbot --nginx -d YOUR_DOMAIN -d www.YOUR_DOMAIN
```

Certbot edits the nginx config to add the TLS server block and sets up
auto-renewal. Visit `https://YOUR_DOMAIN` to confirm.

## 7. Verify

- `https://YOUR_DOMAIN/api/health` → `{"status":"ok"}`
- `https://YOUR_DOMAIN/` → the public site loads and can sign up/search/book
- `https://YOUR_DOMAIN/admin/` → log in with the seeded admin account
  (check `sudo journalctl -u jackpots-backend | grep -i admin` right after
  the first migration ran, for the auto-generated password if you didn't set
  `ADMIN_SEED_PASSWORD`)

## Redeploying after code changes

```bash
ssh -i your-key.pem ubuntu@<ELASTIC_IP>
cd /opt/jackpots && bash deploy/redeploy.sh
```

## Useful commands on the instance

```bash
sudo systemctl status jackpots-backend      # backend health
sudo journalctl -u jackpots-backend -f      # live backend logs
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log
```
