# Deploying

**One deployment method. This one.**

```bash
ssh -i ~/.ssh/jackpotsworld-key.pem ec2-user@<ELASTIC_IP>
cd ~/JackPotsworldtoursandtravels && bash deploy/redeploy.sh
```

That is the whole procedure for shipping a change. `redeploy.sh` verifies the
checkout, pulls, rebuilds the image, restarts the stack, waits for the app to
report healthy, and prints the deployed commit. It stops at the first failure
and tells you which step failed.

For **first-time infrastructure setup** — RDS, S3, EC2, DNS, TLS — follow
[`../docs/AWS_DEPLOYMENT.md`](../docs/AWS_DEPLOYMENT.md). This file covers
deploying to a server that already exists.

---

## What is running

| Piece | Where |
| --- | --- |
| Application | Docker container, API **and** frontend on port 8000, single origin |
| TLS / public entry | Caddy container, ports 80 and 443 |
| Database | RDS PostgreSQL — **not** on this instance |
| Documents | S3, private bucket, via the instance's IAM role |
| Schema | `alembic upgrade head`, run as a **separate** step (`deploy/migrate.sh`) with the migration role — the serve-only app container no longer migrates on boot (role separation). `redeploy.sh` runs it automatically as step 3b. Single-service hosts (Render) may opt back in with `RUN_MIGRATIONS_ON_START=true`. |

The instance is disposable by design: rebuild it and you lose nothing but
uptime, because neither the database nor the documents live on it.

## Files in this directory

| File | Purpose |
| --- | --- |
| `redeploy.sh` | **The deployment script.** Nothing else deploys this application. |
| `docker-compose.yml` | The production stack: `app` + `caddy`, three named volumes |
| `Caddyfile` | Reverse proxy and automatic TLS |
| `docker-entrypoint.sh` | Container start-up: migrate, then serve |

## Two files that are not in git and must exist on the server

`redeploy.sh` refuses to deploy without both, because each fails in a way that
is confusing to diagnose after the fact.

| File | Holds | If missing |
| --- | --- | --- |
| `../backend/.env` | The **runtime** app settings ONLY: `DATABASE_URL` (least-privilege runtime role), `JWT_SECRET_KEY`, `S3_*`, `CORS_ORIGINS`. **Never put `MIGRATION_DATABASE_URL` here** — this file is the app container's `env_file`, so the migration credential would be exposed to the serve-only runtime process. | The container starts with no database and migrates nothing |
| `../backend/.env.migration` | The **migration/owner** credential `MIGRATION_DATABASE_URL`, used ONLY by the separate migration step. Gitignored (matches `backend/.env.*`); `chmod 600`; template at `../backend/.env.migration.example`. `redeploy.sh` sources it and forwards the value to the one-off migration container with a bare `-e MIGRATION_DATABASE_URL` (value never on the command line). On a **deployed** host it is **required** — the migration step **fails closed** without it (no fallback to the runtime `DATABASE_URL`). The single-role fallback applies only to local dev / CI (`DEPLOYED` unset/false), which need neither this file nor `MIGRATION_DATABASE_URL`. | The deployed migration step fails closed (nothing migrates, nothing restarts) |
| `./.env` | `SITE_DOMAIN` | Caddy cannot tell which certificate to request |

See [`../docs/AWS_DEPLOYMENT.md`](../docs/AWS_DEPLOYMENT.md) for how to produce these.

### Migrating on Render (single-service host — manual one-off)

Render's free tier has **no release phase**, so the app starts **serve-only** and does **not** migrate on deploy (`RUN_MIGRATIONS_ON_START=false`; audited admin actions return 503 until the schema is migrated — fail-safe, no data risk). Run the migration as a **manual one-off**, supplying the credential **transiently** so it is never persisted to the service (a persistent Render env var would be visible to the serve-only app process — the same leak this design avoids):

1. **Initiate:** open the service's **Shell** (Render dashboard → the service → *Shell*) — a documented Render feature for a running service.
2. **Supply the secret for that command only** (not saved as a service env var):
   ```
   DEPLOYED=true MIGRATION_DATABASE_URL="postgresql+psycopg2://<owner>:<pw>@<host>:5432/<db>" /app/deploy/migrate.sh
   ```
3. **Check success/failure:** success prints `Migrations complete.` and exits `0`; failure exits non-zero with the Alembic error (and the fail-closed guard prints a clear message if `MIGRATION_DATABASE_URL` is missing).
4. **Gate the app:** to require migration *before* serving, either run this one-off with the service's **auto-deploy turned off** (enable the service only after it succeeds), or use a Render plan whose **Pre-Deploy Command** runs it (per Render's plan documentation). On the free tier the serve-only app may already be running; it stays fail-safe (503 on audited actions) until the migrate completes.

> **Documented vs verified:** the Render Shell / Pre-Deploy Command steps follow Render's published capabilities; they were **not executed or verified** in this review (read-only, no deploy). No unsupported Render feature is assumed.

## Before you deploy

1. **`python tests/run_all.py` is green** — 22 scripts. That is the release
   gate, not a formality.
2. **Take an RDS snapshot** if the release contains a migration. The console, or
   `aws rds create-db-snapshot`. Migrations run automatically on container
   start, so there is no separate moment to catch one going wrong.

## After you deploy

`redeploy.sh` prints the deployed commit and the health verdict. Then:

```bash
curl -fsS https://${SITE_DOMAIN}/api/health
```

Sign in to `/admin/` and open **Wallet & Top-ups → Wallet Reconciliation**.
**Every merchant's `drift` must read `0.00`.** That single column is the
difference between a display problem and a money problem — see
[`../docs/RUNBOOK.md`](../docs/RUNBOOK.md) §4.1 for what to do if it is not zero.

## When something goes wrong

```bash
cd ~/JackPotsworldtoursandtravels/deploy
docker compose ps                  # what is up, and its health
docker compose logs -f app         # live application log
docker compose logs app | grep -i alembic   # what the schema did on boot
docker compose logs caddy          # TLS and certificate issues
```

**Rolling back** is a `git checkout` of the previous commit followed by
`bash deploy/redeploy.sh` again. **Do not roll a wallet migration back over live
balances** — `0036` deliberately refuses when any merchant's balance is
negative, which is a normal operating state. `../docs/RUNBOOK.md` §6 covers this.

## The failure worth knowing about

`docker compose up -d` **without** `--build` reuses the existing image. The pull
succeeds, compose reports the container recreated, the command exits 0, and none
of the new code is running — a deploy that reports success and ships nothing.
This has bitten the project before. `redeploy.sh` always passes `--build`, which
is the main reason to use the script rather than typing the commands by hand.

---

## What was removed, and why

The pre-Docker deployment tooling — `setup.sh`, `jackpots-backend.service` and
`nginx.conf` — was deleted along with the old `redeploy.sh` it belonged to. That
stack installed PostgreSQL on the web server and served the frontend from disk
behind its own web server, none of which is how this application runs.

Keeping it was not neutral. `setup.sh` installs a second PostgreSQL and a web
server that contends with the Caddy container for port 80, and the old
`redeploy.sh` pointed at an absolute path this repository is not checked out to
— so on the current server it would either fail immediately or, if a stale
checkout happened to sit there, migrate the production database from old code.

Anything genuinely needed from those files is recoverable from git history. The
current deployment is the five files listed above and nothing else.
