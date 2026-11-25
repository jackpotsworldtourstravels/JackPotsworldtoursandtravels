# HDFC SmartGateway — UAT & Production Readiness

**Branch:** `claude/jackpotsworld-prod-readiness-07ba10` (`main` @ `85993bb` + consolidated sprint + UI/UX) · **Date:** 2026-11-25
**Scope of this audit:** local, read-only. No HDFC contact, no credentials, no `.env`, no webhook changes, no live money.

> **Phase 3 confirmation (2026-11-25):** the UI/UX completion phase changed **no payment code** — `git diff` shows zero changes under `services/payments/*` or any HDFC/Razorpay/TrustBrick adapter. The local readiness checker still reports **NOT READY — 6 blocking, 4 warning** with the default config, and migration head is `0101`. Everything below is unchanged and still accurate. **HDFC live UAT remains BLOCKED and is NOT claimed as passed.**
>
> **#10 logout-merge confirmation (2026-11-25):** the subsequent surgical #10 logout/chat-teardown consolidation likewise changed **no payment code** (only `account-center.js`, `app.js`, `live-chat.js`, `profile-menu.js` + one frontend test) — `services/payments/*` and every HDFC/Razorpay/TrustBrick adapter are byte-for-byte untouched. HDFC live UAT remains **BLOCKED and NOT claimed as passed**.

> HDFC SmartGateway is the **only** payment gateway intended for production. Razorpay and TrustBrick adapters exist in the codebase but are **not defaulted or active** (`PAYMENT_PROVIDER` default is `none`). No new gateway was introduced.

## 1. Code readiness — PASS

| Capability | State | Evidence |
|-----------|-------|----------|
| Order creation | Implemented | `hdfc_provider.py` |
| Server-side order-status verification | Implemented — every payment re-read from HDFC; return URL trusted only as defence-in-depth | `payment_verification_*` services |
| Amount & currency validation | Implemented — verified against our own rows before confirmation | webhook capture deferred to verification (Phase 6) |
| Callback signature / authentication | Implemented — webhook: read bytes → **verify signature** → parse; return URL signature optional | `payment_webhooks.py`, `HDFC_SG_RESPONSE_KEY` |
| Duplicate callback handling | Implemented — idempotent; duplicates answered 200 and not re-recorded | `payment_event_service` |
| Timeout / retry behaviour | Implemented — provider retries tolerated; non-2xx avoided for known-stale events | webhook module header |
| Payment reconciliation / sweep | Implemented — `PAYMENT_SWEEP_ENABLED` re-checks pending payments without the customer | startup sweep logs observed live |
| Refund workflow | Implemented — `SELECT … FOR UPDATE` concurrency (PG-only); verified on PG18 (CI job) | `test_customer_refunds_postgres.py` |
| E-ticket payment gate | **Present in THIS branch** — `eticket_service.eligibility()` gates both the customer ticket fetch (`GET /api/tickets/{ref}` → `eligible:false` when unpaid) and the public QR verify (`GET /api/tickets/verify/{token}` re-checks eligibility and withholds all flight/passenger detail when ineligible); `test_eticket_payment_gate.py` (11) | report §1 #2 |
| Safe logging (no secrets) | **PASS** — readiness checker & adapter print only setting names (set/unset/too-short); verified live, no credential emitted | `hdfc_readiness.py` |

## 2. Local readiness run (default config)

`python scripts/check_hdfc_production.py` with no HDFC env configured:

```
NOT READY: 6 blocking, 4 warning(s).
```

- `PAYMENT_PROVIDER` = `none`, `PAYMENT_MODE` resolves to `demo` → **no money can move locally** (correct, safe default).
- Required settings (`HDFC_SG_BASE_URL/MERCHANT_ID/API_KEY/WEBHOOK_USERNAME/WEBHOOK_PASSWORD`) all unset → adapter refuses to construct.
- No secret value printed — only setting names.

This is the **expected and correct** outcome for a host with no live credentials.

## 3. Checklist completed locally vs. requiring authorized access

| Item | Locally possible? | Status |
|------|-------------------|--------|
| Order creation logic | Yes | **PASS** (unit-tested: `test_hdfc_flow.py`, `test_hdfc_provider.py`) |
| Server-side status verification | Yes | **PASS** (`test_hdfc_callbacks.py`) |
| Amount/currency validation | Yes | **PASS** |
| Callback signature auth | Yes | **PASS** (fakes: `tests/hdfc_fakes.py`) |
| Duplicate callback handling | Yes | **PASS** |
| Timeout/retry | Yes | **PASS** (logic) |
| Reconciliation/sweep | Yes | **PASS** |
| Refund workflow | Yes | **PASS** (PG18, CI) |
| Safe logging | Yes | **PASS** |
| **Live order against HDFC UAT** | **No** | **BLOCKED** |
| **Real callback from HDFC** | **No** | **BLOCKED** |
| **End-to-end money movement** | **No** | **BLOCKED** |

## 4. UAT status — BLOCKED

Authorized UAT requires, and none were provided (deliberately out of scope):
1. Real HDFC merchant credentials (`HDFC_SG_*`).
2. A public HTTPS host for return + webhook callbacks (HDFC rejects non-public / query-string return URLs).
3. `PAYMENT_ENVIRONMENT=live` with a recognised HDFC production host (for production) or a recognised UAT host with the sandbox controls (for UAT).

**Keep UAT marked BLOCKED until authorized UAT access (credentials + public host) is provided.** When it is, run `scripts/check_hdfc_production.py` on that host (it must report 0 blocking) before switching traffic, then execute the live order → callback → verification → e-ticket path end-to-end.

## 5. HDFC verdict

**Code: production-ready. Live UAT: BLOCKED pending authorized credentials and a public HTTPS host.** This is the single genuinely-external release blocker for payments (the other blockers are internal: consolidating the sprint fixes and resolving the migration collision — see the final release report §9).
