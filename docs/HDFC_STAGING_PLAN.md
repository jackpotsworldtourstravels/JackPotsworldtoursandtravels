# HDFC SmartGateway UAT: staging environment plan (v3, owner decisions of 2026-11-09)

STATUS: DESIGN AND PREPARATION ONLY. Nothing is provisioned, deployed, pushed, committed or paid
for. No payment has been initiated. Production stays `PAYMENT_PROVIDER=none`; no production file,
AWS parameter, service or customer is touched, and the existing HDFC dashboard webhook URL is NOT
changed.

Companion files (new, local, uncommitted):
- `deploy/staging/`: `docker-compose.staging.yml`, `Caddyfile.staging`, `stack.env.example`,
  `backend.staging.env.example` (compose and Caddy syntax validated locally with dummy values).
- `docs/HDFC_STAGING_CLOUDSHELL.md`: staging-only CloudShell commands, six blocks.
- `docs/HDFC_NEXT_STEPS.md`: remaining UAT work and the LIVE-payments readiness checklist.

Labels: **Code** read in this repo; **Dashboard** seen in the owner's screenshots; **Tested** run on
this machine; **Assumption** not verified.

## 1. Decisions recorded

| # | Decision (owner, 2026-11-09) |
|---|---|
| 1 | `uat.jackpotsworldtours.com` approved in principle. No DNS record until the staging server and its static IP are verified. Never the production instance |
| 2 | Separate EC2 in `ap-south-1`, preference `t4g.medium` (compared below). Postgres in Docker on its own encrypted EBS volume, `DeleteOnTermination=false`, daily backups kept 7 days, no production DB or data. ARM64 verified and a staging image built before provisioning |
| 3 | Contact HDFC first (questions in section 8). Dashboard webhook URL unchanged |
| 4 | Every HDFC UAT payment needs the owner's individual approval; nothing pays automatically |
| 5 | Staging-only customer; proposed address `uat-payments@jackpotsworldtours.com` (a PROPOSAL: the owner creates or confirms the mailbox before SMTP is configured) |
| 6 | Claude writes staging-only CloudShell commands; the owner reviews and runs them; read-only inspection first |
| 7 | Basic Auth on human-facing pages; app authentication on APIs; checkout limited to the staging test customer; HDFC callbacks public under webhook auth + payment verification; **`/api/admin/*` blocked completely at first**; admin access later via SSM or a verified IP allowlist; no exposed Postgres, Redis, Docker or debug |
| 8 | Git: inspect, separate unrelated work, manifest, clean branch from `origin/main`, tests and full diff, **no commit or push yet** (section 6) |
| 9 | This approves design direction and preparation only: not AWS creation, DNS, dashboard changes, payments, commits, pushes or production changes |

## 2. Instance size: t4g.small vs t4g.medium

| | t4g.small | **t4g.medium** (recommended) |
|---|---|---|
| vCPU / RAM | 2 / 2 GB | 2 / 4 GB |
| Baseline CPU credit | 20% per vCPU | 20% per vCPU (same) |
| Why it matters here | App (2 gunicorn workers) + Postgres + Redis + Caddy all share it. `docs/AWS_DEPLOYMENT.md` says 1 GB runs out during the image build; 2 GB passes on production but leaves little headroom for Postgres caches, the build and OCR | Comfortable headroom for the first image build, Postgres, and OCR (the image bundles onnxruntime/OpenCV) |
| Approx. compute cost (24/7, Assumption) | about 12.3 USD/month | about 24.5 USD/month |

**Recommendation: `t4g.medium`**, matching your preference. It costs about 12 USD/month more while
running, and it can be stopped between test windows. If you want to start cheaper, `t4g.small` works
for a single tester and can be resized after a stop (an in-place instance-type change), so the
decision is reversible. (Assumption: neither size was load-tested; the figures come from AWS
instance specs and my reading of the Dockerfile and compose file, not from measurement.)

## 3. Architecture compatibility (ARM64 / Graviton)

- Production already runs this same Dockerfile on a `t4g.small` Arm instance (`docs/AWS_DEPLOYMENT.md`,
  `docker-compose-linux-aarch64`), which is the strongest evidence the image works on Arm.
- **Tested here:** this machine is x86-64; Docker Desktop's buildx has `linux/arm64` emulation and
  `docker run --platform linux/arm64 alpine uname -m` printed `aarch64`.
- **Tested here:** a full `linux/arm64` build of the repo's `Dockerfile` was run, from the working
  tree, result: built and imports verified (section 10).
- `postgres:16-alpine`, `redis:7-alpine` and `caddy:2` are multi-arch images that publish `arm64`
  (Tested: confirmed in section 10).
- The Compose plugin binary is the `aarch64` build, pinned in Block 4a.
- An emulated build proves the image builds and imports; it does not prove runtime speed on Graviton.

## 4. Infrastructure specification

| Item | Specification |
|---|---|
| Region | `ap-south-1` |
| Instance | **t4g.medium**, Amazon Linux 2023 arm64, IMDSv2 required, no SSH key, tag `Project=jpw-staging` |
| Root disk | 20 GB gp3, encrypted, delete on termination |
| Data disk | 20 GB gp3, **encrypted, `DeleteOnTermination=false`**, mounted `/data` (`/data/postgres`, `/data/backups`) |
| Static IP | one Elastic IP, staging only |
| Access | AWS Systems Manager Session Manager via a NEW staging-only role (`AmazonSSMManagedInstanceCore` only). No port 22 |
| Backups | Nightly `pg_dump` kept 7 days on the data disk, plus daily EBS snapshots of the data volume kept 7 (lifecycle policy tagged `Project=jpw-staging`, Block 5) so a backup does not live only on the disk it protects |

### Security group `jpw-staging-sg`

| Direction | Port | Source | Why |
|---|---|---|---|
| In | 80/tcp | 0.0.0.0/0 | Let's Encrypt validation and HTTP to HTTPS redirect |
| In | 443/tcp | 0.0.0.0/0 | the site, and HDFC's webhook and browser return |
| In | 22, 5432, 6379, 8000, Docker 2375/2376 | none | closed |
| Out | all | default | HDFC, SMTP, package and image pulls |

No IP restriction on the callbacks, because HDFC's official source addresses are unconfirmed
(question 6 below). The group is new and named; nothing attaches to the production instance's groups.

### Docker Compose architecture

```
internet --443/80--> caddy --(Caddyfile.staging rules)--> app:8000 --> postgres:5432 (internal)
                                                                  \--> redis:6379   (internal)
```

Compose forces `DEPLOYED=true`, `DEBUG=false`, `OTP_DEV_ECHO=false`, `PAYMENT_ENVIRONMENT=test`, and builds
`DATABASE_URL` from the staging Postgres only, so a production URL pasted into an env file is ignored.
Only Caddy publishes ports.

## 5. DNS instructions

1. Do nothing until Block 2 has run and Block 3 has verified the instance and printed the Elastic IP.
2. Then add: **A** record, name `uat`, value = that IP, TTL 300. No wildcard, no `www.uat`.
3. Verify (Block 3): `uat` resolves to the staging IP; the apex still resolves to production's.
4. Start the stack only after step 3 (Caddy needs the name to resolve to obtain its certificate).
5. Never point `uat` at the production Elastic IP.

Cookies: **Code**: no `set_cookie` anywhere in `backend/app`, and the frontend sends the login token
as `Authorization: Bearer` from per-origin browser storage, so nothing is shared across
`.jackpotsworldtours.com`. Re-check in the browser (DevTools, Application) once staging is up. The staging
Caddyfile omits HSTS `includeSubDomains`.

## 6. Git change manifest (nothing committed or pushed)

`git status` on `main` (`31a23a0`, equal to `origin/main` after `git fetch`; nothing staged):
8 modified, 5 untracked, plus this session's new staging files. They are two separate pieces of work.

**A. Staging + HDFC UAT callbacks (proposed branch `staging/hdfc-uat`)**

| File | Change | Why staging needs it |
|---|---|---|
| `backend/app/routers/payment_webhooks.py` | modified, +7 | Logs every webhook attempt (route and byte count only) before judging it, so "HDFC never called" is distinguishable from "HDFC was refused" |
| `backend/tests/test_hdfc_callbacks.py` | new | Mocked tests: webhook, return, duplicate, captured-booking, proxy |
| `backend/scripts/uat_callback_proxy.py` | new | Local-tunnel callback proxy (optional on staging; kept with its tests) |
| `docs/HDFC_SMARTGATEWAY.md` | modified (callback/tunnel/dashboard sections only, +38) | Runbook for the callback investigation |
| `docs/HDFC_STAGING_PLAN.md`, `docs/HDFC_STAGING_CLOUDSHELL.md`, `docs/HDFC_NEXT_STEPS.md` | new | This plan, the commands, the checklist |
| `deploy/staging/` (4 files) | new | Staging compose, Caddy rules, env examples (no secrets) |

**B. Flight supplier guard (NOT needed for staging; keep out of this branch)**

`backend/app/services/supplier_guard.py` (new), `backend/tests/test_flight_supplier_guard.py` (new),
`backend/tests/test_admin_supplier_reservation_http.py` (new), and modifications to
`backend/app/routers/admin_reconciliation.py`, `backend/app/services/customer_booking_service.py`,
`backend/app/services/payment_verification_flight_service.py`, `backend/app/services/payments/__init__.py`,
`backend/app/services/payments/hdfc_readiness.py`, `backend/tests/test_hdfc_production.py`, plus the
"Flight supplier guard" section of `docs/HDFC_SMARTGATEWAY.md` (removed from branch A's copy). This is a
live-flight safety net; it touches checkout and confirmation for flights and deserves its own review
and branch. Hotels (the test product) are unaffected by it.

**Not touched by either branch:** unrelated frontend and project work was not in the working tree
(the tree contained only the files above), and the three stashes and three worktrees are intact.

**Branch preparation (local only):** `staging/hdfc-uat` was created from `origin/main` in a separate
worktree at `.claude/worktrees/staging-hdfc-uat`, with branch A copied in uncommitted. The main
working tree is unchanged. Proposed commit and push are for you to approve after reviewing this manifest.
Tests in the clean branch are in section 10.

Gap to know about: with `/api/admin/*` blocked, the staging admin cannot create the disposable test
hotel. A small staging seed script run inside the container (`docker compose exec`) is the safe route.
It is not written yet; adding it needs your approval (it would be a third item in branch A).

## 7. Security design (`Caddyfile.staging`, in the order it applies)

| Path | Treatment |
|---|---|
| `POST /api/webhooks/payments/hdfc` | Straight to the app. No Basic Auth (HDFC's own `Authorization: Basic` must reach the app, which verifies it); method pinned; no IP block |
| `GET/POST /api/payments/hdfc/return` | Straight to the app (verified server-side) |
| `/docs`, `/redoc`, `/openapi.json`, `/debug*`, `/metrics` | 404 at the edge (the app also disables docs when `DEPLOYED=true`, Code) |
| `/api/admin/*` | **404 for everyone** (blocked completely) |
| other `/api/*` | The app's own login (emailed code + JWT); checkout limited to `SANDBOX_PAYMENT_CUSTOMER_IDS` |
| everything else | **Basic Auth** |

Basic Auth cannot sit in front of `/api/*` because the app and Basic Auth share the `Authorization`
header (it would break every logged-in call and HDFC's webhook). The API is therefore protected by the
app's own login, as you decided. Later admin access options: an SSM port-forward to the app (needs the
Session Manager plugin, which CloudShell lacks, so it would run from your computer), or a verified IP
allowlist in the Caddyfile. Either is a separate approved change. Postgres, Redis and Docker publish no ports.

## 8. HDFC support questions (ready to send; include no key, password or OTP)

Subject: UAT SmartGateway (merchant SG6226): webhook configuration questions

1. **Secondary webhook URL.** The dashboard offers "Configure Secondary WebHook URL". Does it receive a
   copy of every event, or only act as a failover? Can events be routed by type or environment?
2. **Separate UAT merchant.** Can we be issued a second UAT merchant or sub-merchant account (own keys,
   webhook URL and credentials) so staging and other test targets do not share one webhook destination? Process and lead time?
3. **Retry and resend.** What is the official retry policy (attempts, intervals, which HTTP responses count
   as failure, how long)? Is there a manual resend or replay in the dashboard or an API? The order page we checked has none.
4. **Delivery visibility.** The order's Webhooks tab shows only "Webhook Consumed by Merchant: TRUE". Is there a
   per-attempt log with timestamps and the HTTP status we returned? What exactly does TRUE mean?
5. **Pending, duplicate and failed events.** Can UAT produce duplicate deliveries, "pending" and other non-final
   outcomes, and failures on demand? Which UAT cards or amounts trigger each, including cancelled authentication?
6. **Source IPs.** Which IP ranges send webhooks in UAT and production, and are they stable?
7. **Webhook authentication.** Besides Basic Auth, are webhooks signed (HMAC)? Can the credentials be rotated without losing events?
8. **Return URL.** Is the per-order `return_url` honoured in UAT, and does the response key sign the browser return?
9. **Our order.** For `JP3dc4c19106ba24d657` the dashboard shows `ORDER_SUCCEEDED`
   (`evt_V2_ed8fc73e95914dbfae17ad39887f8fd8`) and `TXN_CHARGED` (`evt_V2_46b2eff2dd024e628b37e7ece265cbf3`),
   both 2026-11-09 11:55:29 IST. Where are the delivery responses for these recorded?

I cannot contact HDFC. Until answers arrive the dashboard webhook URL stays as it is.

## 9. Staging test customer and testing

Customer: dedicated staging-only account on the PROPOSED address `uat-payments@jackpotsworldtours.com`.
No mailbox is assumed to exist. Process once you confirm it and SMTP works (a deployed host returns 503 if
the emailed sign-in code cannot be sent, Code: `customer_otp_service.py`):
1. Sign in on `https://uat.jackpotsworldtours.com` (Basic Auth, then the emailed code) with that address.
   (Assumption: first verification creates the account, as locally.)
2. Read its staging id with `select id, email from customers where email = '...'` (Block 5 pattern).
3. Put that id in `SANDBOX_PAYMENT_CUSTOMER_IDS`, recreate the app. The code refuses an empty list (`sandbox_guard.py`).
4. Create a disposable low-price test hotel with the seed script (section 6 gap).
Never a production account or id. Disable the customer when testing ends.

Test procedures (every payment needs your separate yes; preconditions: healthy staging, callbacks answer, DB
snapshot, a NEW booking, never `JPH000001`, dashboard URL changed only if you approve it):
1. **Genuine webhook:** HDFC order page lists `ORDER_SUCCEEDED` and `TXN_CHARGED`; Caddy log shows
   `POST /api/webhooks/payments/hdfc` 200; the app's receipt log; event ids in the DB. Genuine only if HDFC's
   Basic auth is present and the event ids match HDFC's order page.
2. **Browser return:** the browser hits `uat.../api/payments/hdfc/return`, gets a 303 and lands on `/my-trips` on
   the staging host, never `localhost`; the query `status` is never trusted.
3. **Failed:** an HDFC UAT failure case (from the answer to question 5); expect no capture or confirmation.
4. **Pending:** HDFC's pending case if it exists; otherwise state it and rely on `test_pending_payment_is_retryable_not_failed`.
5. **Duplicate:** per HDFC's answer to question 3. A locally generated replay is a LABELLED probe, not a genuine event.
6. **Consistency after each:** one payment per booking, expected confirmed bookings and notifications, no unprocessed
   events, HDFC's Order Status API agrees.
7. **Reset:** restore the dashboard URL as you choose, remove `ALLOW_SANDBOX_PAYMENTS`, `PAYMENT_PROVIDER=none` on staging, stop the instance.

## 10. Verification run in this session

| Check | Result |
|---|---|
| ARM64 emulation available | Tested: `aarch64` printed by an arm64 container |
| Full `linux/arm64` image build of the Dockerfile | Tested: built (first attempt hit a transient PyPI read timeout, the retry succeeded). Image is `arm64/linux`, about 419 MB, local tag `jpw-staging-arm64-test:local` (not pushed) |
| Imports inside the arm64 image | Tested: `aarch64`, Python 3.12.16, cv2 5.0.0, onnxruntime 1.31.1, fastapi, gunicorn, psycopg2, sqlalchemy, PyMuPDF all import |
| Base images publish arm64 | Tested with `docker buildx imagetools inspect`: postgres:16-alpine, redis:7-alpine, caddy:2 each list linux/arm64 |
| Clean branch `staging/hdfc-uat` (from `origin/main`, branch A only) payment tests | 347 passed (9 files: callbacks, flow, provider, production, webhook router, safety guards, sandbox guard, identity, combined) in 55 s; uses SQLite and a fake HDFC; mocked, not genuine HDFC |
| Branch contents | 2 modified, 5 new items (3 docs, the staging dir, the proxy and its test); uncommitted |
| Caddyfile / compose | Caddy `validate` ok; `docker compose config` ok (dummy values) |
| Full backend suite | not run in the clean branch (only one log line changed in code); say if you want it |

ARM64 limits: this was an emulated build and import check on x86; it shows the image builds and its native libraries load on arm64, not runtime speed on Graviton. The app itself was not started in the arm64 container (it needs a database).

## 11. Cost estimate (confirm in the AWS Pricing Calculator for `ap-south-1`)

Assumptions (not verified): t4g.medium about 0.0336 USD/hour, t4g.small about 0.0168; gp3 about
0.092 USD/GB-month; a public IPv4 address about 0.005 USD/hour (billed even when stopped); EBS snapshots about
0.05 USD/GB-month on changed data only; inbound transfer free; outbound transfer for UAT well inside the
monthly free allowance; GST at 18% if your AWS account is billed in India (Assumption; check your invoice).
Monthly = 730 hours. (`docs/AWS_DEPLOYMENT.md`'s earlier guess for t4g.small, about 8 USD, is lower than
this arithmetic.)

| Item | t4g.medium, 24/7 | t4g.medium, stopped | t4g.small, 24/7 (alt) |
|---|---|---|---|
| Compute | 24.5 | 0 | 12.3 |
| Root EBS 20 GB | 1.8 | 1.8 | 1.8 |
| Data EBS 20 GB | 1.8 | 1.8 | 1.8 |
| Static public IPv4 | 3.7 | 3.7 | 3.7 |
| Snapshots, 7 days (estimate) | up to 1.5 | up to 1.5 | up to 1.5 |
| Data transfer | about 0 | 0 | about 0 |
| SSM, IAM role, security group, DNS, Let's Encrypt | 0 | 0 | 0 |
| **Subtotal (USD)** | **about 33** | **about 9** | **about 21** |
| **With 18% GST (USD)** | **about 39** | **about 10.5** | **about 25** |

Plus any SMTP or mailbox cost for `uat-payments@jackpotsworldtours.com` (none if it is an existing
mailbox plan). Cost control: stop the instance between test windows (the "stopped" column), tear down in
Block 6 when finished. Effort: about half a day to build and verify; testing days separately.

## 12. Decisions and inputs still needed from you

1. **Instance size:** t4g.medium (recommended) or t4g.small, and approval of the cost in section 11.
2. **Branch:** review the section 6 manifest; approve a commit and a push of `staging/hdfc-uat` (never `main`), and
   whether branch B (flight supplier guard) goes in its own branch or stays local for now.
3. **Seed script:** approve adding a staging test-hotel seed script (needed because the admin API is blocked).
4. **Mailbox:** create or confirm `uat-payments@jackpotsworldtours.com` and provide SMTP details (typed on the server, never to Claude).
5. **HDFC:** send the section 8 questions and share the answers.
6. **AWS:** review the CloudShell blocks; run Block 1 (read-only) first; Block 2 only after cost approval.
7. **DNS:** tell me when the Elastic IP is verified, then create the `uat` record yourself.

## 13. What was and was not done

Done: this plan; the staging files and CloudShell commands; a local clean branch and worktree with branch A
uncommitted; local tests; Caddy and compose validation; an emulated ARM64 image build.
NOT done: any AWS action, DNS record, server, secret, deployment, payment, HDFC dashboard change, production
change, commit or push. Production remains `PAYMENT_PROVIDER=none`.
