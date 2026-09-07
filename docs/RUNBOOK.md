# Runbook — deploying, migrating, rolling back, and what to watch

**Status: AUTHORITATIVE for operations.** Written for M10. Companion documents:
`docs/BOOKING_OPS_MILESTONES.md` (what was built and why),
`docs/WALLET_ARCHITECTURE.md` (money — read before touching it),
`docs/AWS_DEPLOYMENT.md` (the existing environment).

---

## 1. Before any deploy

```bash
python tests/run_all.py
```

**36 scripts must pass.** The suite runs against a live backend and a real PostgreSQL database; a
green run is the release gate, not a formality. If a script is red, do not deploy — every one of
them exists because something was once wrong in that exact place.

Two properties of the suite worth knowing:

- **`verify_m9.py` fails if any `verify_*.py` on disk is missing from `run_all.py`.** Three
  milestones once sat green and unrun because their scripts were never registered. That check is
  what stops it recurring.
- **`verify_m8.py` runs last and deliberately exhausts the auth rate limit.** Anything scheduled
  after it fails on login rather than on its own subject. Do not reorder it.

## 2. Migrating

```bash
cd backend && alembic upgrade head
```

Head is `0063_booking_confirmed_notif`. **64 migrations, one head, one base** — asserted by
`verify_m9.py`, which checks `script.get_heads()` and `get_bases()` and walks base → heads.

### The chain is not linear, and the numbers lie

There is one fork and one merge:

```
... 0052 ── 0053_customer_flight_booking ─┬─ 0054 ─ 0055 ─ 0056 ─┐
                                          │                      ├─ 0057_merge_ocr_customer_heads ─ 0058 ... 0063
                                          └─ 0042 ─ 0043 ────────┘
```

**`0042_passport_ocr` and `0043_passport_details` run AFTER `0053`, not before it.** Passport OCR
forked from `0053` and took numbers that had been reserved earlier, so the filename number is not
the apply order. Reading the directory listing top to bottom will tell you the wrong sequence. The
production upgrade log of 2026-09-05 shows the real one:

```
0052_soft_delete_email_reuse -> 0044_customer_portal -> 0053_customer_flight_booking
  -> 0054 -> 0055 -> 0056, and 0053 -> 0042 -> 0043
  -> 0057_merge_ocr_customer_heads -> 0058 -> ... -> 0063
```

**Never infer order from the number. Run `alembic history` and read the arrows.**

`verify_m9.py` does *not* assert "no branches" — it cannot, because the merge point is a legitimate
branchpoint. Its own comments spell out that a naive parser miscounts this chain as three heads and
two bases. What it asserts is the thing that matters: one head, one base, everything reachable.

### Rolling a migration back

```bash
cd backend && alembic downgrade -1        # one step
cd backend && alembic downgrade 0052_soft_delete_email_reuse
```

**Both directions are verified on production, not on a throwaway:**

- **`0063 → 0052`** — the rollback of 2026-09-03 (`44f5cd1`), 14 migrations down, clean.
- **`0052 → 0063`** — the re-release of 2026-09-05 (`8ea1ec1`), the same 14 up, clean, with the
  wallet ledger reconciled afterwards (see §2.1 below).

> ### A DOWNGRADE MUST RUN FROM THE IMAGE THAT STILL HAS THE REVISIONS, AND IT MUST RUN FIRST
>
> This is the rule the 2026-09-03 rollback was written to teach, and it is not obvious.
>
> `deploy/docker-entrypoint.sh` runs `alembic upgrade head` on every boot. If you ship an image that
> no longer contains revisions the database is stamped at, that image **cannot resolve the stamp**:
> it dies on start, behind a 502, while every deploy command exits 0. Only the *outgoing* image
> holds those revisions and can run their `downgrade()`.
>
> So the order is forced: **downgrade the database with the image you are removing, then ship the
> replacement.** Never the other way round.
>
> The mirror of this on the way up is the pleasant case — the entrypoint applies whatever is missing
> with no manual step at all, which is exactly what happened on 2026-09-05. Take an RDS snapshot
> first regardless; `redeploy.sh` does not, and nothing else will.

> **Do not `alembic downgrade base`.** It fails at `0022_merchant_user_fields`, which references
> `partner_users` — a legacy table `0023_nine_table_redesign` drops and does not restore. This is
> **accepted, not fixed**: going below 0023 would destroy the entire current schema, so it is not a
> path anyone can take in production, and building a restore for a 43-table design that no longer
> exists would be work with no consumer. **0023 is the floor.**

### 2.1 After any migration that touches money

Six SQL checks, read-only, run inside the container. `tests/` is not copied into the image, so
`verify_m9.py` cannot run there — but its money-drift section is just SQL and the app's own session
is available:

```bash
docker compose -f deploy/docker-compose.yml --project-directory deploy exec -T app python -c "
from sqlalchemy import text
from app.database.session import SessionLocal
db = SessionLocal()
for label, sql in [
 ('cached balance == ledger', 'SELECT count(*) FROM merchants m WHERE m.wallet_balance <> COALESCE((SELECT SUM(w.credit - w.debit) FROM wallet_transactions w WHERE w.merchant_id = m.merchant_id), 0)'),
 ('balance chain unbroken', 'SELECT count(*) FROM (SELECT balance_before, LAG(balance_after) OVER (PARTITION BY merchant_id ORDER BY txn_id) prev FROM wallet_transactions) c WHERE prev IS NOT NULL AND balance_before <> prev'),
 ('no booking billed twice', \"SELECT count(*) FROM (SELECT request_id FROM wallet_transactions WHERE txn_type='booking_debit' AND request_id IS NOT NULL GROUP BY request_id HAVING count(*)>1) x\"),
 ('no top-up credited twice', 'SELECT count(*) FROM (SELECT topup_id FROM wallet_transactions WHERE topup_id IS NOT NULL GROUP BY topup_id HAVING count(*)>1) x'),
 ('no row both debit and credit', 'SELECT count(*) FROM wallet_transactions WHERE debit > 0 AND credit > 0'),
 ('no row moves nothing', 'SELECT count(*) FROM wallet_transactions WHERE debit = 0 AND credit = 0'),
]:
    n = db.execute(text(sql)).scalar()
    print(('PASS ' if n == 0 else 'FAIL ') + label + ('' if n == 0 else f'  ({n})'))
db.close()"
```

All six must read `PASS`. This is the admin screen's "drift must read 0.00", plus five things that
screen does not show. **Verified `PASS` on 2026-09-05** after the `0052 → 0063` re-release.

If any of them fails, **do not reach for a downgrade** — see `0036_wallet_ledger` below, which will
refuse over live balances anyway. Forward fixes only.

> **Do not `alembic downgrade base`.** It fails at `0022_merchant_user_fields`, which references
> `partner_users` — a legacy table `0023_nine_table_redesign` drops and does not restore. This is
> **accepted, not fixed**: going below 0023 would destroy the entire current schema, so it is not a
> path anyone can take in production, and building a restore for a 43-table design that no longer
> exists would be work with no consumer. **0023 is the floor.**

### Two migrations that can refuse to roll back, on purpose

- **`0036_wallet_ledger`** restores `ck_merchants_wallet_non_negative` on downgrade. If any merchant
  is running a negative balance — which is *normal* under CR-4 — the downgrade **fails**. That is
  deliberate: a negative balance is real money owed, and a rollback must stop rather than silently
  pretend otherwise. Settle those accounts first, then downgrade.
- **`0037_topup_credit_once`** is a plain index; it drops safely.

Still two, after the B2C release. All fourteen of `0042`–`0044` and `0053`–`0063` were checked for
downgrades that restore a constraint or raise: none do, and the `0063 → 0052` rollback of
2026-09-03 ran the whole set down without incident. **`0036` remains the only migration that will
stop you**, and it stops you for the right reason.

## 3. Deploying

```bash
ssh -i ~/.ssh/jackpotsworld-key.pem ec2-user@<ELASTIC_IP>
cd ~/JackPotsworldtoursandtravels && bash deploy/redeploy.sh
```

**That is the only supported way to deploy.** The script derives the repository path from its own
location, checks the environment files exist, pulls, rebuilds, restarts, waits on the container's
health check and prints the deployed commit. It stops at the first failure.

`docs/AWS_DEPLOYMENT.md` covers first-time infrastructure; `deploy/README.md` covers the deploy
itself.

> **Why a script rather than typed commands.** `docker compose up -d` **without** `--build` reuses
> the existing image: the pull succeeds, the container is recreated, the command exits 0, and none
> of the new code is running — a deploy that reports success and ships nothing. `redeploy.sh` always
> passes `--build`. Deploying by hand is how that trap gets hit.

### Frontend cache-busting — the failure that looks like "the change didn't work"

Every `frontend/**` script and stylesheet is loaded with a `?v=` query string. **Changing a JS file
without bumping its `?v=` ships nothing to a returning browser.** The symptom is a change that works
in a private window and not in yours. Bump it in the HTML that loads it.

## 4. What to watch, in priority order

### 4.1 Wallet drift — the one that is an incident, not a metric

```
GET /api/admin/wallet/reconciliation      (payment.verify)
```

`drift` must be **`0.00` for every merchant, always**. It is `wallet_balance` minus
`SUM(credit) - SUM(debit)` recomputed from the ledger. A non-zero value means the cached balance and
its ledger disagree, which means some code moved money without going through `wallet_service.post`.

**If drift is non-zero: stop taking payments and investigate.** Do not "correct" the balance — the
ledger is the truth, and the balance is the cache. Find the write that bypassed `post()`.

The same invariant is asserted by `verify_m9.py` and after every scenario in `verify_cr4a/b/c/d.py`.

### 4.2 The top-up queue

```
GET /api/admin/wallet/topups/counts       (payment.verify)
```

`pending` is money a merchant says it has sent and nobody has confirmed. `pending_amount` is how
much. A growing backlog here means merchants are waiting on credit they have already paid for.
Never add `pending` to any balance — it is not money the platform has.

### 4.3 Delivery failures

```
GET /api/admin/messages/counts            (notification.send)
```

**With SMTP unconfigured, every send is recorded `failed`** with "SMTP is not configured…". That is
the platform being honest, not an outage. In an environment where SMTP *is* configured, a rising
`failed_total` is a real mail problem.

### 4.4 Operations health

```
GET /api/analytics/operations             (system.activity.view)
```

Watch `unassigned` with `unassigned_oldest_hours` — a booking nobody owns is one nobody has looked
at — and `time_to_issue.p90_hours`, which is what merchants actually experience. The mean hides the
tail.

## 5. Secrets and configuration

Set in `backend/.env`; **never committed**. `backend/.env.example` lists every key.

| Key | Notes |
| --- | --- |
| `DATABASE_URL` | If a fresh deploy logs "Zero users found at startup", this is pointed at the wrong database. The startup hook warns for exactly this reason. |
| `JWT_SECRET_KEY` | Rotating it invalidates every session — deliberate, and the way to force a global logout. |
| `SMTP_*` | Unset means no mail is sent and every attempt is logged `failed`. |
| `UPLOAD_ROOT` | **Outside any served directory.** Passport scans, payment screenshots and QR images live here and are served only through authenticated, scope-checked endpoints. There is no `StaticFiles` mount for it and there must not be. |
| `CORS_ORIGINS` | Comma-separated. |

## 6. Rolling back a release

1. **Redeploy the previous image.** Application code is stateless.
2. **Only migrate down if the new release added a migration and you must.** Prefer forward fixes —
   see the two migrations above that can legitimately refuse.
3. **Never roll a wallet migration back over live balances.** `0036`'s downgrade will refuse, which
   is the correct outcome.

## 7. Known operational limitations

| Limitation | Impact | Mitigation |
| --- | --- | --- |
| **Email sends synchronously** | An SMTP server's latency is added to the request that triggered it. With SMTP unset it is a no-op. | Delivery is fully swallowed — a mail failure never breaks a booking. A queue + worker is the fix; `delivery_service._send_email` is the only seam that moves. |
| **`alembic downgrade base` fails at 0022** | Cannot roll back below the nine-table redesign. | Accepted. 0023 is the floor; going below destroys the schema anyway. |
| **Super Admin holds no payment codes** | Cannot verify top-ups or read the wallet desk. | Pre-existing and consistent with the M4 payments desk. Use an Admin account. |
| **`finance_service.statement()` still reads `discount_meta`** | `adjust_wallet` dual-writes a `payments` row beside the ledger row. | They cannot drift — the payments row is derived from the posted transaction. Retiring it touches the locked M4 Payments screen and needs its own approval. |
| **No background job runner** | Nothing is scheduled or retried. | Every path is request-driven by design. |
