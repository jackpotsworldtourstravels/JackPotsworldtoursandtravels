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

**22 scripts must pass.** The suite runs against a live backend and a real PostgreSQL database; a
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

Head is `0037_topup_credit_once`. **37 migrations, single chain, no branches** — asserted by
`verify_m9.py`.

**A clean database migrates cleanly.** Verified for M10 against a throwaway database: empty → head,
all 37, no errors.

### Rolling a migration back

```bash
cd backend && alembic downgrade -1        # one step
cd backend && alembic downgrade 0036_wallet_ledger
```

**Verified: `head → 0023 → head` is clean**, all 14 modern migrations, both directions.

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

## 3. Deploying

See `docs/AWS_DEPLOYMENT.md` for the environment. The three-step redeploy documented there still
applies, and the trap it records still bites: **the checkout is not `/opt/jackpots`, and skipping
the image build ships nothing while exiting 0.** Confirm the image was rebuilt before believing a
deploy happened.

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
