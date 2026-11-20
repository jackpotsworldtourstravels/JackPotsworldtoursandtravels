# Stage 3 — Staging Deployment Runbook

**Scope.** Deploying the current `main` tree (Stage 3 M0/M1/M2, uncommitted locally) to a **separate** staging instance, using the repository's existing owner‑approved staging stack under `deploy/staging/`. Prepared read‑only; nothing here was executed. No secrets appear in this document.

**Conventions**
- `[APPROVAL REQUIRED]` marks any command that **executes a database migration or a deployment**. Do not run it until the owner has explicitly approved that step.
- *Existing* = already in the repository. *Recommendation* = proposed by this runbook, not yet in the repo.
- Source of truth inspected: `deploy/staging/docker-compose.staging.yml`, `deploy/staging/Caddyfile.staging`, `deploy/staging/stack.env.example`, `deploy/staging/backend.staging.env.example`, `deploy/docker-entrypoint.sh`, `Dockerfile`, `deploy/README.md`, `backend/app/main.py`, `backend/alembic/versions/0095_customer_admin_audit_logs.py`.

**Repository facts** (verified): root `C:/Users/NIKHI/OneDrive/Desktop/TOURS AND TRAVEL`, branch `main`, HEAD `556ce23`. Migration chain is a single linear head **`0095_customer_admin_audit_logs`** (`down_revision = 0094_customer_refund_attempts`). Frontend is **static HTML served by the app** (no React build). Gaming Tour Packages is disabled whenever `GAMING_TOUR_PACKAGES_ENABLED` is unset — **leave it unset**.

---

## TASK 1 — Enabling authorized Stage 3 admin‑API testing (without public exposure)

**The constraint (existing).** `deploy/staging/Caddyfile.staging` rule 3 returns **404 for `/api/admin` and `/api/admin/*` for every caller**, because Basic Auth cannot protect those routes — the admin pages authenticate with `Authorization: Bearer …`, the same header Basic Auth consumes. So the Stage 3 B2C admin endpoints (M0 readiness‑gated routes, M1 block/unblock/password‑reset, M2 communication) are **unreachable through the public staging URL as shipped**. The Caddyfile comment names the two intended later options; both keep the edge 404 in place and reach the app on `:8000` *behind* Caddy. **Do not change the Caddyfile** (per restriction); choose an access method that needs no edge change.

| Option | How it works | Security properties | Downsides |
|---|---|---|---|
| **A. SSM port‑forwarding** (AWS Systems Manager Session Manager) | `aws ssm start-session` with `AWS-StartPortForwardingSession` (or `…ToRemoteHost`) forwards your laptop's `localhost:8000` to the instance's app port. Caddy is bypassed; the app's own JWT + RBAC (`b2c.customers.manage`, `b2c.communication.send`, super‑admin) is the only gate. | No inbound port opened; **no SSH key to manage**; access is IAM‑authenticated and **fully audited in CloudTrail**; can be scoped/revoked by IAM policy; session is encrypted. The repo's own deploy path already uses SSM (`docs/FEATURE_BATCH_2026-10-27.md`, `docs/HDFC_NEXT_STEPS.md`). | Requires the SSM agent + instance IAM role for SSM; operator needs AWS creds. |
| **B. IP allowlisting** | Add `@admin_api … not remote_ip <owner-ip>/32` to the Caddyfile so admin routes reach the app only from a fixed IP. | Simple to reason about. | **Requires editing `Caddyfile.staging`** (prohibited here, and the comment marks it a separate owner‑approved change); brittle against changing/CGNAT IPs; the allowlisted IP still traverses the public edge; no per‑user attribution. |
| **C. SSH local port‑forward** (repo‑supported alternative) | `deploy/README.md` already uses key‑based SSH to the instance. An **SSH tunnel** `ssh -i <key>.pem -L 8000:localhost:8000 ec2-user@<IP>` forwards the app port exactly like option A; `docs/AWS_DEPLOYMENT.md` documents the same `-L` pattern for the database. Caddy bypassed; app JWT+RBAC is the gate. | No edge change; encrypted; uses an access path the repo already relies on. | Depends on an open SSH port + private‑key custody and rotation; less granular/auditable than IAM/SSM. |

**Recommendation: Option A (SSM port‑forwarding).** Safest because it opens no inbound port, needs no shared private key, is IAM‑authenticated and CloudTrail‑audited, matches the repo's existing deploy transport, and requires **no Caddyfile edit**. The admin API stays 404 at the public edge; only an IAM‑authorized operator, tunneled to `:8000`, reaches `/api/admin/*`, and even then must present a valid admin JWT with the correct Stage 3 scopes. Option C is the acceptable fallback where SSM is unavailable; Option B is discouraged (requires the prohibited edge edit and is the weakest of the three).

Illustrative (operator runs locally, not a deploy):
```bash
# A — SSM (no inbound port, IAM-audited). Replace the instance id.
aws ssm start-session \
  --target <staging-instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8000"],"localPortNumber":["8000"]}'
# then: curl -s -H "Authorization: Bearer <admin-jwt>" http://localhost:8000/api/admin/...
```

---

## TASK 2 — Migration 0095 auto‑execution and how to prevent accidental runs

**When it happens (existing).** `deploy/docker-entrypoint.sh` is the container `CMD`. On **every container start**, after dropping to the unprivileged `app` user, it runs — *before* gunicorn:
```sh
cd /app/backend
alembic upgrade head
exec gunicorn app.main:app ...
```
So the schema is brought to head **automatically whenever the `app` service starts or restarts** (first `up`, any `restart`, host reboot with `restart: unless-stopped`, or `redeploy.sh`). There is no separate release phase. `alembic/env.py` reads the URL from `settings.database_url`; in the staging stack `DATABASE_URL` is built by the compose file itself from `POSTGRES_*`, pointing only at the staging `postgres` container (never production).

**Which migrations could execute.** `alembic upgrade head` applies **every revision between the database's current `alembic_version` and head `0095`**:
- **Fresh staging DB (first boot):** the full chain **0001 → 0095** (96 revisions), ending by creating, for 0095: the enum `customer_admin_audit_outcome_enum`; the `customer_admin_audit_logs` table; its indexes; the partial‑unique `uq_cust_admin_audit_refund_success`; and the **append‑only trigger** `trg_block_customer_admin_audit_mutation` (function `fn_block_customer_admin_audit_mutation`, `BEFORE UPDATE OR DELETE`).
- **Existing staging DB already at 0094:** only **0095**.
- 0095 does **not** issue `GRANT`/`REVOKE`; the least‑privilege DBA grants are a separate out‑of‑band step (see Task 3 §7 note).

**How to prevent accidental execution before owner authorization.** The risk is that a normal `docker compose … up` of the `app` service silently migrates. Controls (operational, no file edits):
1. **Stage the bring‑up.** Start only the datastores first, so nothing migrates:
   ```bash
   cd deploy/staging
   docker compose -f docker-compose.staging.yml --env-file stack.env up -d postgres redis
   ```
   Take the backup (Task 3 §5) and verify the revision (§6) **before** the `app` service is ever started.
2. **Inspect without migrating** — run Alembic read‑only by overriding the entrypoint so `alembic upgrade` is *not* the command:
   ```bash
   # read-only: prints the DB's current revision; does NOT upgrade
   docker compose -f docker-compose.staging.yml --env-file stack.env \
     run --rm --no-deps --entrypoint "" app \
     sh -lc 'cd /app/backend && alembic current'
   ```
3. **Gate the app start on approval.** Only after §6 + §7 sign‑off, start `app` — this is the step that migrates, so it is `[APPROVAL REQUIRED]` (Task 3 §8).
4. **Do not** run `redeploy.sh` on staging for the first bring‑up — it is the production script and starts everything (and migrates) in one shot.

**Do not** edit `deploy/docker-entrypoint.sh` or `backend/alembic/versions/0095_*` (restriction). Control execution by *when the `app` service is started*, not by changing the entrypoint.

---

## TASK 3 — Staging runbook (exact sequence)

> Run on a **dedicated staging EC2 instance**, never on the production host (`jackpotsworld-web`) and never against the production database. The staging stack runs its **own** `postgres:16-alpine` and `redis:7-alpine` on the internal compose network.

### 1. Staging host preparation
- Provision a separate EC2 instance (owner‑approved; isolated security group). Attach a **separate EBS volume mounted at `/data`** — the compose file bind‑mounts `/data/postgres` for database persistence, so the instance stays disposable.
  ```bash
  sudo mkdir -p /data/postgres
  ```
- Enable the **SSM agent** and attach an instance role permitting SSM Session Manager (for Task 1 Option A). Confirm the instance appears in **Systems Manager → Fleet Manager**.
- Open only 80/443 inbound at the security group (Caddy); **do not** open 5432/6379/8000.

### 2. Docker installation and verification
```bash
# Amazon Linux 2023 example
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user   # re-login for the group to take effect
docker --version
docker compose version             # Compose v2 (the compose file uses v2 syntax)
```
- Clone/checkout the repository on the instance, on the intended commit of `main`.

### 3. Creation of secret environment files (never committed)
Two files must exist under `deploy/staging/`, created **on the server only** from the `.example` templates:
```bash
cd deploy/staging
cp stack.env.example           stack.env
cp backend.staging.env.example backend.staging.env
chmod 600 stack.env backend.staging.env
```
Generate real values **on the host** (never printed here, never committed):
- `POSTGRES_PASSWORD` → `openssl rand -hex 24`
- `JWT_SECRET_KEY` → `openssl rand -hex 32` (**must differ from production**)
- `STAGING_BASIC_AUTH_HASH` → `docker run --rm caddy:2 caddy hash-password --plaintext '<password>'` (store the **bcrypt hash**; in `stack.env` a literal `$` must be written `$$`)

### 4. Environment configuration
- Fill `stack.env` and `backend.staging.env` per the matrices in **Task 4**. Set the staging‑specific values (domain, CORS, staging HDFC **UAT** keys only).
- **Leave `GAMING_TOUR_PACKAGES_ENABLED` unset** (Gaming stays disabled).
- Confirm the hard guards are present (the compose file also force‑sets them under `environment:`, which overrides the env file): `DEPLOYED=true`, `DEBUG=false`, `OTP_DEV_ECHO=false`, `PAYMENT_ENVIRONMENT=test`.
- Point DNS `A`/`AAAA` for `SITE_DOMAIN` at the instance so Caddy can obtain TLS.

### 5. Database backup and recovery
- **Fresh DB:** no data yet — snapshot the empty volume after first `postgres` start so there is a known‑clean restore point.
- **Existing staging DB (re‑deploy):** back up **before** the migrating `app` start.
  ```bash
  cd deploy/staging
  docker compose -f docker-compose.staging.yml --env-file stack.env up -d postgres redis
  # logical dump to the host (reads the staging container only)
  docker compose -f docker-compose.staging.yml --env-file stack.env exec -T postgres \
    sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ./staging-backup-$(date +%Y%m%d%H%M).dump
  ```
- **Recovery (only if a migration must be reverted):** restore the dump into a fresh volume with `pg_restore`. **Prefer forward‑fix / code rollback over `alembic downgrade`.** Note: `0095.downgrade()` **destroys audit history** (drops the table, trigger, function, enum) and is gated behind the same approval as any destructive op — `[APPROVAL REQUIRED]`.

### 6. Verify the current migration revision (read‑only — no upgrade)
```bash
cd deploy/staging
# (postgres already up from §5)
docker compose -f docker-compose.staging.yml --env-file stack.env \
  run --rm --no-deps --entrypoint "" app \
  sh -lc 'cd /app/backend && alembic current'
# or query the DB directly:
docker compose -f docker-compose.staging.yml --env-file stack.env exec -T postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version_num FROM alembic_version;"'
```
Expect empty/absent on a fresh DB, or `0094_customer_refund_attempts` on a DB one step behind head. Record the result for sign‑off.

### 7. Owner approval for migration 0095  `[APPROVAL REQUIRED]`
- Present to the owner: current revision (from §6), the fact that starting `app` will run `alembic upgrade head` (Task 2), and the list of revisions that will apply (all of 0001→0095 on a fresh DB; only 0095 on an existing one).
- **Record explicit written owner approval** to apply **0095** on staging before proceeding.
- **DBA least‑privilege grants (out‑of‑band, per 0095 docstring & spec D3):** after the table exists, the app DB role should hold **INSERT + SELECT** on `customer_admin_audit_logs` with **UPDATE/DELETE/TRUNCATE revoked** (the append‑only trigger is belt‑and‑braces). This is a separate owner/DBA step, not performed by the migration. *(Recommendation: capture these GRANT/REVOKE statements as a reviewed SQL snippet before go‑live.)*

### 8. Authorized deployment  `[APPROVAL REQUIRED]`
Only after §6–§7 sign‑off. Starting `app` **migrates to head 0095 and then serves**:
```bash
cd deploy/staging
docker compose -f docker-compose.staging.yml --env-file stack.env up -d --build   # [APPROVAL REQUIRED] — runs alembic upgrade head
docker compose -f docker-compose.staging.yml --env-file stack.env logs app | grep -i alembic   # confirm what the schema did
docker compose -f docker-compose.staging.yml --env-file stack.env ps                            # all services healthy
```
`--build` is mandatory (the `deploy/README.md` "failure worth knowing about": `up` without `--build` ships nothing).

### 9. Schema and trigger verification (read‑only SELECTs)
Confirm 0095 landed (operator runs; these are reads, not migrations):
```bash
docker compose -f docker-compose.staging.yml --env-file stack.env exec -T postgres \
  sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version_num FROM alembic_version;"'           # => 0095_customer_admin_audit_logs
# table + columns
#   \d customer_admin_audit_logs
# enum type exists:  SELECT 1 FROM pg_type WHERE typname='customer_admin_audit_outcome_enum';
# append-only trigger present:
#   SELECT tgname FROM pg_trigger WHERE tgname='trg_block_customer_admin_audit_mutation';
# function present:  SELECT proname FROM pg_proc WHERE proname='fn_block_customer_admin_audit_mutation';
# partial-unique index present:
#   SELECT indexname FROM pg_indexes WHERE indexname='uq_cust_admin_audit_refund_success';
```
Expected objects (from `0095`): table `customer_admin_audit_logs`; enum `customer_admin_audit_outcome_enum` (`success|failure|denied|partial`); indexes `ix_customer_admin_audit_logs_request_id`, `ix_cust_admin_audit_actor|entity|action|outcome|retention|created`; partial‑unique `uq_cust_admin_audit_refund_success`; trigger `trg_block_customer_admin_audit_mutation` + function `fn_block_customer_admin_audit_mutation`. Optionally confirm append‑only by attempting an `UPDATE`/`DELETE` on the empty table and expecting the error `customer_admin_audit_logs is append-only`.

Also sanity‑check the public surface:
```bash
curl -fsS https://${SITE_DOMAIN}/api/health          # 200 {"status":"ok"-ish}
curl -s  -o /dev/null -w "%{http_code}\n" https://${SITE_DOMAIN}/api/admin/customers   # => 404 (edge-blocked, expected)
curl -s  -o /dev/null -w "%{http_code}\n" https://${SITE_DOMAIN}/docs                    # => 404 (disabled)
```

### 10. Admin API access verification (via Task 1 Option A)
```bash
# open the SSM tunnel (Task 1), then reach the app directly, bypassing Caddy:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/admin/customers          # 401/403 without a token
curl -s -H "Authorization: Bearer <staging-admin-jwt>" http://localhost:8000/api/admin/customers   # 200 with a scoped admin JWT
```
- Confirm a **B2B‑only admin without** `b2c.customers.manage` gets **403**, and the readiness gate returns **503** only if `customer_admin_audit_logs` is absent (it should be present post‑0095, so expect non‑503).

### 11. Stage 3 application testing (staging data only)
Exercise M0/M1/M2 against a **staging** test customer (never a production id):
- **M0 readiness:** audited admin endpoints succeed now that 0095 is applied; audited sensitive reads work.
- **M1 block/unblock:** block an **active** staging customer → 200, status `blocked`, live sessions invalidated; unblock → `active`; blocking an inactive/suspended customer → **409** unchanged; audit rows written (`customer.block` / `customer.unblock`).
- **M1 password reset:** with a **verified** staging email → `{"status":"reset email sent"}`, no token in the response, SMTP delivers (requires §SMTP configured); no verified email → **422**, no token minted; audit SUCCESS/FAILURE as applicable.
- **M2 communication:** single‑customer send; audit records actor/recipient/channel/outcome (no message body).
- **Gaming stays disabled:** confirm Gaming Tour Packages endpoints/pages remain closed (flag unset).
- **Payments:** HDFC **UAT** only; `PAYMENT_ENVIRONMENT=test` (compose‑forced); use `SANDBOX_PAYMENT_CUSTOMER_IDS` = the staging test customer id. No live payment.

### 12. Final staging sign‑off
Record and attach evidence:
- Deployed commit (`docker compose … logs app` header / `APP_COMMIT`), `alembic current` = `0095_…`, health 200, `/api/admin/*` = 404 at edge, docs = 404.
- Schema/trigger checks from §9 all present; append‑only enforced.
- M0/M1/M2 test results; Gaming confirmed disabled; payments confined to UAT.
- Backup taken (§5) and restore path understood.
- Owner's written approval for 0095 (§7) on file.
- Open items / deviations listed. **No production access occurred.**

---

## TASK 4 — Configuration (variable names; required vs optional; staging‑specific). **No secrets shown.**

Settings load from the process environment (and `backend/app/config.py`; env var = UPPERCASE field name). In the staging stack, `stack.env` feeds compose/Caddy, `backend.staging.env` feeds the app, and the compose file **force‑sets** the guard/DB/payment‑env values via `environment:` (overriding the env file).

### `stack.env` (infra/edge)
| Variable | Req? | Staging‑specific? |
|---|---|---|
| `SITE_DOMAIN` | **Required** | Yes — the staging FQDN (e.g. `uat.…`) |
| `POSTGRES_DB` | **Required** | Yes — staging DB name |
| `POSTGRES_USER` | **Required** | Yes — staging DB user |
| `POSTGRES_PASSWORD` | **Required (secret)** | Yes — generate on host |
| `STAGING_BASIC_AUTH_USER` | **Required** | Yes |
| `STAGING_BASIC_AUTH_HASH` | **Required (secret, bcrypt hash)** | Yes |
| `APP_COMMIT` | Optional | Yes (build provenance; defaults `unknown`) |

### `backend.staging.env` / app environment
**Required (core):**
| Variable | Notes / staging‑specific |
|---|---|
| `DATABASE_URL` | **Built by the compose file** from `POSTGRES_*` → the staging `postgres` container. Do **not** paste a production URL. |
| `JWT_SECRET_KEY` | Secret; **must differ from production**. |
| `FRONTEND_BASE_URL` | Staging URL (`https://<SITE_DOMAIN>`) — used in reset/OTP links. |
| `CORS_ORIGINS` | Staging origin(s). |
| `REDIS_URL` | Compose sets `redis://redis:6379/0` (required: `WEB_CONCURRENCY=2` + chat broker). |

**Deployment guards (compose‑forced; keep as shown):** `DEPLOYED=true`, `DEBUG=false`, `OTP_DEV_ECHO=false`, `FORWARDED_ALLOW_IPS` (`*` behind Caddy), `WEB_CONCURRENCY` (default 2), `PORT` (default 8000).

**Migration execution — role separation (SUPERSEDES any "starting `app` runs `alembic upgrade head`" statement elsewhere in this runbook):** the app container is **serve‑only** — `RUN_MIGRATIONS_ON_START` is OFF, so a normal `up` / restart / reboot does **not** migrate. Schema changes are a **separate, explicit** step: `deploy/migrate.sh` run as a one‑off (see `redeploy.sh` step 3b and the staging env example), executed **before** the app is (re)started; if it fails, the app is not started. On this **deployed** host (`DEPLOYED=true`) that step **requires `MIGRATION_DATABASE_URL`** (the migration/owner credential, passed to the migrate step **only**, never to the app) and **fails closed** when it is missing — it will **not** fall back to the runtime `DATABASE_URL`. The single‑role fallback to `DATABASE_URL` applies only to local dev / CI (`DEPLOYED` unset/false). Example:
```
# Supply the credential transiently (never in backend.staging.env / the app env);
# the bare -e forwards it from the shell so the value is NOT on the command line:
export MIGRATION_DATABASE_URL="postgresql+psycopg2://<migration_role>:<pw>@postgres:5432/<db>"
docker compose -f docker-compose.staging.yml --env-file stack.env \
  run --rm --no-deps -e MIGRATION_DATABASE_URL --entrypoint /app/deploy/migrate.sh app
```

**SMTP (required on a deployed host — OTP/reset emails; a failed send is a 503):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME` (secret), `SMTP_PASSWORD` (secret), `SMTP_USE_TLS`, `SMTP_FROM_EMAIL` (staging sender on the company domain), `SMTP_FROM_NAME`.

**Storage:** `STORAGE_BACKEND` (=`local` for staging), `UPLOAD_ROOT` (defaults to the `app_uploads` volume at `/app/uploads`), `MAX_UPLOAD_MB`. *(S3 vars are optional and only needed if `STORAGE_BACKEND=s3`.)*

**Payments — HDFC UAT only (staging‑specific; never live):** `PAYMENT_PROVIDER` (`hdfc`), `PAYMENT_ENVIRONMENT` (`test`, compose‑forced), `PAYMENT_MODE`, `ALLOW_SANDBOX_PAYMENTS` (`true`), `SANDBOX_PAYMENT_CUSTOMER_IDS` (**staging** customer id, set after it exists), `HDFC_SG_BASE_URL` (UAT host), `HDFC_SG_MERCHANT_ID`, `HDFC_SG_CLIENT_ID`, `HDFC_SG_API_KEY` (secret), `HDFC_SG_RESPONSE_KEY` (secret, if issued), `HDFC_SG_RETURN_URL` (staging), `HDFC_SG_WEBHOOK_USERNAME`, `HDFC_SG_WEBHOOK_PASSWORD` (secret), `PAYMENT_SWEEP_ENABLED`.

**Optional / feature‑gated (leave default unless deliberately testing):** `ADMIN_SEED_PASSWORD` (else a random one is printed once to the app log on first boot), OCR (`OCR_PROVIDER` …), assistant (`ASSISTANT_*`), `TRAVEL_AI_*`, Hotelbeds (`HOTELBEDS_*`), Duffel/flights (`FLIGHT_SUPPLIER`, `DUFFEL_*`), Razorpay/TrustBrick keys, Google OAuth (`GOOGLE_CLIENT_*`), company/invoice metadata.

**Must stay UNSET:** `GAMING_TOUR_PACKAGES_ENABLED` (any explicit truthy token would enable Gaming — do not set it).

---

## TASK 5 — Risks

1. **Dependency pinning.** `backend/requirements.txt` uses mostly `>=` (only `bcrypt==4.0.1` is exact) and there is no lockfile. A staging `--build` can pull newer minors than were tested locally. *Mitigation (recommendation): build once, record resolved versions (`pip freeze`), and pin for the staging image; rebuild deliberately.*
2. **Python version difference.** Image/CI use **3.12** (`Dockerfile`, `ci.yml`); local dev runs 3.13. Low risk, but staging validates 3.12 — treat the container, not the laptop, as the reference runtime. No `runtime.txt`/`.python-version` pins it outside Docker.
3. **SMTP.** On a deployed host, customer OTP and admin‑initiated reset **depend on working SMTP** (a failing send is a 503/502). The staging sender mailbox (`uat-payments@…`) is **proposed, not yet created** per `backend.staging.env.example` — a go‑live blocker until provisioned and test‑verified.
4. **Payment sandbox.** Staging must never take live payments. `PAYMENT_ENVIRONMENT=test` is compose‑forced; use **HDFC UAT** credentials only and set `SANDBOX_PAYMENT_CUSTOMER_IDS` to a **staging** id (never a production id). HDFC callback source IPs are unconfirmed (documented) — the Caddyfile deliberately applies no IP filter to the two callback routes; keep methods pinned as shipped.
5. **Upload storage.** `STORAGE_BACKEND=local` keeps uploads on the `app_uploads` Docker volume. On a disposable instance, ensure the volume (and `/data`) persist across rebuilds, or passport/visa scans are lost on restart. Uploads are never served as a static mount (private by design).
6. **Redis.** Required because `WEB_CONCURRENCY=2` and the live‑chat broker needs a shared registry; the staging compose includes it (internal only). If Redis is unhealthy, multi‑worker chat/WebSocket fan‑out degrades.
7. **Database isolation.** The staging `DATABASE_URL` is built by the compose file from `POSTGRES_*` and points only at the in‑stack `postgres` container; `postgres` has no published port (internal network only). **Never** paste a production `DATABASE_URL` into `backend.staging.env`. Keep staging on its own instance and EBS volume.
8. **Access control.** Public `/api/admin/*` is edge‑404; admin testing must go through the SSM tunnel (Task 1 A) and still requires a valid admin JWT with Stage 3 scopes. Risks: an accidental Caddyfile relaxation exposing admin routes; a shared/over‑broad JWT; or the SSM/IAM (or SSH key) grant being wider than needed. Scope IAM/keys tightly, rotate the staging admin credential, and keep Basic Auth on the human‑facing pages.
9. **Auto‑migration on boot** (cross‑cutting). Starting `app` runs `alembic upgrade head`; an unintended `up`/`restart`/reboot could apply 0095 before approval. Mitigate with the staged bring‑up and read‑only revision check in Task 2 / Task 3 §6–§8.

---

## Appendix — Existing vs. recommendation
- **Existing in repo:** the entire `deploy/staging/` stack (compose, Caddyfile, env examples), `deploy/docker-entrypoint.sh` auto‑migrate, `Dockerfile` single‑origin image, `render.yaml`, `deploy/README.md`, CI (`.github/workflows/ci.yml`, `ui-e2e.yml`), the 0095 DDL (table/enum/indexes/partial‑unique/trigger), SSM/SSH access patterns referenced in `docs/`.
- **Recommendations (not in repo):** dependency pinning/lockfile for the staging image; capturing the DBA GRANT/REVOKE for `customer_admin_audit_logs` as a reviewed SQL snippet; provisioning the staging SMTP sender mailbox; preferring SSM over SSH/IP‑allowlist for admin access.

*Prepared by read‑only inspection. No PostgreSQL connection, no migration run, no source/Docker/Caddy/config/migration edits, no deployment, commit, push or merge. No secrets shown. Gaming Tour Packages left disabled. Stage 4 not started.*
