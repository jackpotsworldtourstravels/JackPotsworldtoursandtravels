# Load testing — how many members before the site gets stuck

This answers "is the site fine at 500 / 2000 members, or does it crash?" by
**simulating** that many users and measuring what the server does. The largest
user count where responses stay fast and errors stay near zero is your real
capacity. Everything here is a measurement, not a guess.

> ## Run this against STAGING, never production
> A load test is a deliberate attempt to overload the site. Point it at a
> staging copy of the stack (same EC2 + RDS instance types as production, or
> the number you get back is not *your* number), or a throwaway local copy.
> Running it at your live site will slow it down for real customers.

---

## What's here

| File | What it does |
| --- | --- |
| `locustfile.py` | The virtual users: mostly anonymous browsers, plus an optional signed-in cohort. |
| `seed_accounts.py` | Provisions test members and writes `tokens.txt` for the signed-in cohort. |
| `watch_server.sh` | Run on the deploy host during the test; flags DB-pool exhaustion and worker timeouts. |
| `requirements.txt` | `locust` + `requests`. |

## Setup

```bash
python -m venv .venv-loadtest
. .venv-loadtest/Scripts/activate      # Windows;  use  source .venv-loadtest/bin/activate  on Linux/Mac
pip install -r loadtest/requirements.txt
```

## Step 1 — the quick browsing test (no login)

Most real traffic is people browsing the catalogue, and that alone stresses the
shared ~30-connection database pool, so start here. It needs no accounts.

```bash
locust -f loadtest/locustfile.py --host https://staging.your-domain.com
```

Open <http://localhost:8089>, then enter:
- **Number of users** — start at 100.
- **Ramp up** — e.g. 20 users/second.

Watch the live charts. Then repeat at higher user counts (see the ramp plan).

## Step 2 — add signed-in members (optional but more realistic)

Signing in is **rate-limited to 5/minute per IP**, and on a deployed host the
login code is emailed — so you can't log 2000 users in during the test. Instead
provision accounts ahead of time against a staging host that returns the code
in the response (`OTP_DEV_ECHO=true`):

```bash
python loadtest/seed_accounts.py --host https://staging.your-domain.com --count 50
```

That writes `loadtest/tokens.txt` (takes ~10 min — the rate limit, not the
script). Then run the test with the tokens, and ~20% of users become members:

```bash
# Windows PowerShell:
$env:TOKENS_FILE="loadtest/tokens.txt"; locust -f loadtest/locustfile.py --host https://staging.your-domain.com
# Linux/Mac:
TOKENS_FILE=loadtest/tokens.txt locust -f loadtest/locustfile.py --host https://staging.your-domain.com
```

## Step 3 — watch the server while it runs

In a second terminal **on the deploy host**:

```bash
bash loadtest/watch_server.sh
```

It prints, every 5 seconds: live DB connection count, pool-timeout errors, and
gunicorn worker-timeout kills. When `db_conns` pins near 30 or `pool_timeouts`
goes above 0, you have found the wall.

---

## The ramp plan

Don't jump straight to 2000 — climb, holding each level ~3–5 minutes so numbers
settle. Headless example (no web UI, writes a CSV report):

```bash
locust -f loadtest/locustfile.py --host https://staging.your-domain.com \
  --headless -u 500 -r 25 -t 5m --csv loadtest/run_500
```

Run it at `-u 100`, `250`, `500`, `1000`, `2000`, each as its own `--csv`
file, and compare. `-u` = users, `-r` = ramp rate/sec, `-t` = duration.

## How to read the result — the pass/fail line

Decide "healthy" *before* you look, so it's a fact and not a feeling. At each
user level, the run **passes** only if all of these hold:

| Metric (in the Locust report) | Healthy target |
| --- | --- |
| **95%ile response time** | under ~1000 ms |
| **Failure rate** | under ~0.1% |
| **`db_conns`** (from watch_server) | comfortably below 30 |
| **`pool_timeouts` / `WORKER TIMEOUT`** | zero |

**Your capacity is the highest user count where the run still passes.** Above
it, you'll see the 95%ile time climb steeply and failures appear — that's the
site "getting stuck". Example conclusion: *"smooth to 400 concurrent users;
95%ile latency degrades past that; pool timeouts and errors from ~700."*

## If the number is lower than you want

The ceiling is set by the ~30-connection DB pool and by slow synchronous calls
(payments, email) holding connections. In rough order of impact:

1. Set an explicit, larger pool in `backend/app/database/session.py`
   (e.g. `pool_size=10, max_overflow=20`) — **only** after checking your RDS
   `max_connections` can take `workers × (pool_size + max_overflow)`.
2. Move email and payment-provider calls off the request thread.
3. Add workers / a bigger instance, or a second instance behind a load balancer
   (which also removes the single-point-of-failure of one EC2 box).

Re-run the same ramp after each change to see the ceiling move.
