# HDFC SmartGateway: remaining UAT work, staging plan, live-readiness checklist

Written 2026-11-09. **Production stays `PAYMENT_PROVIDER=none`. Nothing here changes
production, its `.env` or its SSM parameters, and no production customer ID is used.**

## 0. Where things stand

| Item | State | Evidence |
|---|---|---|
| First UAT payment (JPH000001, 280 INR, order `JP3dc4c19106ba24d657`) | CHARGED at HDFC; payment captured, booking confirmed, 1 payment / 1 notification / 1 event locally | HDFC Order Status API + disposable DB |
| HDFC dashboard webhook URL | Points at `https://jackpotsworldtours.com/api/webhooks/payments/hdfc`, NOT the test tunnel | Dashboard screenshot, 2026-11-09 |
| HDFC webhook events for the order | `ORDER_SUCCEEDED` (`evt_V2_ed8fc73e...`) and `TXN_CHARGED` (`evt_V2_46b2eff2...`), both 11:55:29 IST, "consumed" = TRUE | Dashboard order page |
| Genuine HDFC webhook reached the local app | **No** (never aimed at it) | Proxy + app logs |
| Webhook auth | Username matches locally; password length matches (18); values unproven | Local config, dashboard |
| Browser return | Order's return URL is the tunnel `/api/payments/hdfc/return`; HDFC's real browser return not yet observed | Dashboard order page |
| Resend of an event | Not offered on the order's Webhooks tab | Dashboard |

## 1. Remaining UAT work (local, disposable DB, tunnel only)

The dashboard has ONE primary webhook URL, so a live webhook test needs that URL
pointed at the tunnel for the duration of the test. That is a dashboard setting change:
ask the owner each time, and restore it afterwards.

Already proven by MOCKED tests (fake HDFC, in-memory SQLite; not genuine delivery):

| Scenario | Tests |
|---|---|
| Success | `test_successful_payment_confirms_booking_via_status_api` |
| Failed / cancelled / voided | `test_failed_payment`, `test_cancelled_payment_...`, `test_voided_order_is_not_captured` |
| Pending / unknown | `test_pending_payment_is_retryable_not_failed`, `test_unknown_provider_status_is_retryable` |
| Duplicate / replayed webhook | `test_duplicate_webhook_confirms_once`, `test_replayed_webhook_with_new_event_id_confirms_once`, `test_a_new_webhook_event_for_a_captured_confirmed_booking_changes_nothing` |
| Late failure after capture | `test_late_failure_event_cannot_undo_a_capture` |
| Return + webhook race | `test_return_and_webhook_racing_confirm_once` |
| Tampered amount / order / currency | `test_tampered_*`, `test_currency_mismatch_is_rejected` |
| Bad credentials | `test_http_webhook_bad_credentials_401_and_nothing_recorded` |
| Proxy exposes only the two callback routes; oversized body refused | `test_hdfc_callbacks.py` |

Still needing GENUINE HDFC (each needs the owner's explicit approval and a NEW disposable
test booking; do not reuse JPH000001):

1. **Genuine webhook delivery.** Owner sets the dashboard primary URL to
   `<tunnel>/api/webhooks/payments/hdfc`; run ONE new small test payment; confirm in the
   proxy log (`POST /api/webhooks/payments/hdfc -> 200`), the app's receipt log and the DB
   that HDFC's own request arrived with valid auth, for both `ORDER_SUCCEEDED` and
   `TXN_CHARGED`; confirm still captured/confirmed exactly once. Owner then restores the URL.
2. **Genuine browser return.** Same payment: confirm the browser lands via the tunnel's
   `/api/payments/hdfc/return` and ends on the test frontend (8099), not 8000.
3. **Failed and pending, genuine.** Use HDFC UAT's documented failure test cards / simulated
   outcomes (from the HDFC UAT kit) on separate new test bookings; confirm no confirmation
   and the sweep keeps pending orders retryable.
4. **Duplicate, genuine.** Only if HDFC offers a resend. It does not on the order page
   (checked 2026-11-09); ask HDFC support whether a replay exists. Otherwise rely on the mocked
   duplicate tests plus a locally replayed HDFC-shaped request that is labelled as a local probe.
5. **Consistency query** after each: payments = 1, bookings confirmed = 1, confirmation
   notifications = 1, no events left unprocessed.

Tunnel caveat: `trycloudflare.com` URLs change if the tunnel restarts. Never restart it
mid-test; a named tunnel or staging host removes the problem.

## 2. Staging plan (no production changes)

Why: a second environment lets the dashboard point at a stable HTTPS URL that is not
production and not a laptop, and it can run the real deploy path.

Requirements:
- **Host:** a separate small instance (or container host) with its own DNS name, e.g.
  `staging.<your-domain>`, HTTPS via Caddy/Let's Encrypt, same Docker image as production.
- **Database:** its own PostgreSQL (a second RDS instance or a container). Never the
  production RDS. Restore only synthetic data; no real customer rows.
- **Secrets:** separate `.env`: HDFC UAT keys only, `PAYMENT_ENVIRONMENT=test`,
  `PAYMENT_PROVIDER=hdfc`, `ALLOW_SANDBOX_PAYMENTS=true`, `SANDBOX_PAYMENT_CUSTOMER_IDS=<staging test customers>`,
  `FRONTEND_BASE_URL=https://staging.<domain>`, `HDFC_SG_RETURN_URL=https://staging.<domain>/api/payments/hdfc/return`,
  its own webhook username/password, `DEPLOYED=true` so the guards behave as in production.
- **Dashboard:** HDFC UAT webhook primary URL = `https://staging.<domain>/api/webhooks/payments/hdfc`.
  (One URL per merchant: moving it from production to staging means production stops
  receiving UAT webhooks, which is the point.)
- **Access control:** basic-auth or IP-allowlist the whole staging site so the public cannot
  reach it; keep search engines out (`X-Robots-Tag: noindex`).
- **Email/SMS/OTP:** dev delivery or a sink, never real customers.
- **Cost/teardown:** stop the instance when idle; document it in `docs/RUNBOOK.md`.
- **Deploy path:** same SSM procedure, separate instance id; owner approves each deploy.

## 3. Production-readiness checklist for LIVE HDFC payments (separate from UAT)

Do not start until UAT sections above are complete and the owner approves a go-live date.

**Merchant and credentials**
- [ ] HDFC production merchant onboarding complete; live merchant id, client id, API key, response key issued by HDFC.
- [ ] Production gateway host (not `hdfcuat`), `PAYMENT_ENVIRONMENT=live`, `PAYMENT_PROVIDER=hdfc`.
- [ ] Live keys stored only in the server secret store (SSM/Secrets Manager), never in git or chat.
- [ ] Separate live webhook username/password; HDFC production dashboard webhook URL = production URL; Order + Transaction (+ Refund) events enabled.
- [ ] `HDFC_SG_RESPONSE_KEY` set so browser returns are signature-verified.
- [ ] Return URL and `FRONTEND_BASE_URL` equal the real HTTPS site; `scripts/check_hdfc_production.py` passes.

**Money correctness**
- [ ] Amount, currency and order id checked against our records on every webhook/return (tests exist; re-run against live-shaped data).
- [ ] Server-side Order Status verification before confirming (never trust the browser or the webhook body).
- [ ] Reconciliation: scheduled sweep on, daily report vs HDFC settlement file, mismatches routed to admin review.
- [ ] Settlement and fee reconciliation process agreed with accounts.

**Refunds and failures**
- [ ] Refund flow implemented against HDFC refund API, with idempotency, partial refunds, and webhook confirmation (`docs/REFUND_ARCHITECTURE_CORRECTIONS.md`).
- [ ] Chargeback handling and notification path defined.
- [ ] Failed/pending/abandoned payments release inventory and never confirm.
- [ ] Customer-facing wording for pending and failed states approved.

**Supplier booking**
- [ ] Hotel and flight supplier bookings are triggered only after verified capture, idempotently, with a defined path if the supplier fails after payment (auto-refund or manual queue). Flight (TBO) integration is not built yet; keep flights closed until it is.
- [ ] `supplier_guard` behaviour verified against the real supplier sandbox.

**Security and operations**
- [ ] Rotate the super-admin default password and demo merchant logins (open item).
- [ ] Webhook endpoint rate limits, body cap, and credential comparison in constant time verified.
- [ ] No secrets in logs; log retention agreed; alerting on webhook 4xx/5xx and sweep failures.
- [ ] Database backups and restore drill; rollback plan for the deploy.
- [ ] Terms, refund policy, privacy policy and payment-gateway disclosures on the site; PCI scope confirmed (card data stays on HDFC's hosted page).
- [ ] Rollout plan: first live transaction by the owner for a small amount, then monitored soft launch; owner approves each step.

**Gate:** production remains `PAYMENT_PROVIDER=none` until every box above is ticked and the owner approves in writing.
