# Deploying

**One deployment method. This one.**

```bash
ssh -i ~/.ssh/jackpotsworld-key.pem ec2-user@<ELASTIC_IP>
cd ~/JackPotsworldtoursandtravels && bash deploy/redeploy.sh
```

That is the whole procedure for shipping a change. `redeploy.sh` verifies the
checkout, pulls the latest code, pulls the matching prebuilt image from Amazon
ECR (it does **not** build on the host), restarts the stack, waits for the app
to report healthy, and prints the deployed commit. It stops at the first failure
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

## Where the image comes from (Amazon ECR)

The app image is **built off-host** by GitHub Actions and pushed to Amazon ECR.
The EC2 instance only *pulls* it — it has no buildx and too little RAM to build
reliably. `redeploy.sh` sets `APP_IMAGE` to the immutable ECR tag for the commit
it just checked out (the 40-character commit SHA) and pulls exactly that.

| Piece | Value |
| --- | --- |
| Registry / repo | `754549530476.dkr.ecr.ap-south-1.amazonaws.com/jackpotsworld` |
| Tag | the deployed commit SHA (immutable) |
| Platform | `linux/arm64` (the t4g.small is 64-bit Arm) |
| Build workflow | `.github/workflows/build-image.yml` — **manual** (`workflow_dispatch`) |
| Auth, CI → ECR | GitHub OIDC, no static keys |
| Auth, EC2 → ECR | the instance role, no stored credentials |

**Build, then deploy** — the image must exist for the exact commit the host will run:

1. **Merge first.** Merge the intended change into `main`. The workflow only
   builds commits reachable from `origin/main`; anything else is rejected.
2. **Build.** Run the **Build & Push image to ECR** workflow (Actions tab). Leave
   the `git_ref` input at its default **`main`** to build the current tip, or
   enter a specific full commit SHA that is already on `main`. It builds
   `linux/arm64` and pushes `…/jackpotsworld:<full-sha>`. **Record the full
   40-character SHA** from the workflow's run summary.
3. **Deploy.** On the host, `bash deploy/redeploy.sh` fast-forwards the checkout
   to `origin/main` and pulls `…/jackpotsworld:<that checkout's SHA>`. Deploy only
   when the checkout's SHA matches an image you built — i.e. the SHA you recorded.
4. **If `main` advanced** between build and deploy, the host resolves the new tip
   and its image won't exist yet: build that new SHA first, then re-run.

If the image for the deployed commit was never built, the pull fails and the
running stack is left untouched — build it first, then re-run.

**One-time AWS prerequisites (not created by this repo):** an ECR repository
`jackpotsworld` with immutable tags; a GitHub OIDC provider in the account; an
IAM role `github-actions-ecr-push` trusted by this repository (push-scoped); and
an ECR *pull* policy on the instance role `jackpotsworld-ec2-role`. See
[`../docs/AWS_DEPLOYMENT.md`](../docs/AWS_DEPLOYMENT.md).

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

**Rolling back is manual** — `redeploy.sh` does not revert automatically, so an
unhealthy new container keeps serving until an operator rolls it back. Two ways.
Fastest — re-point at a previous image, which stays in ECR because tags are
immutable:

```bash
APP_IMAGE=754549530476.dkr.ecr.ap-south-1.amazonaws.com/jackpotsworld:<previous-sha> \
  docker compose -f deploy/docker-compose.yml --project-directory deploy up -d
```

On the very first ECR deploy the previous release is the local `deploy-app`
image (never pushed to ECR); `redeploy.sh` records it as the rollback target and
never prunes it, so `APP_IMAGE=deploy-app docker compose … up -d` restores it.
Or roll the code back with a `git checkout` of the previous commit and re-run
`bash deploy/redeploy.sh`. **Do not roll a wallet migration back over live
balances** — `0036` deliberately refuses when any merchant's balance is
negative, which is a normal operating state. `../docs/RUNBOOK.md` §6 covers this.
Migration `0094` must **never** be downgraded over live refund-attempt data
without a verified backup and an explicit recovery plan: its `downgrade()` drops
`customer_refund_attempts`, deleting every refund-attempt audit record. Treat a
rollback that would cross `0094` as an **image rollback only** — the additive
table is harmless to older code — unless you have taken that backup.

## The failure worth knowing about

The old trap was `docker compose up -d` **without** `--build` reusing a stale
local image. That trap is gone: there is no local build. The image is addressed
by immutable commit-SHA tag, so the running container is provably the deployed
commit. The rule is simpler now — **build the image for a commit before you
deploy that commit.** `redeploy.sh` enforces it: if the tag is not in ECR the
pull fails and nothing is restarted.

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
