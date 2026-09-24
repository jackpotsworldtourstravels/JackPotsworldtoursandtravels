# HDFC SmartGateway (UAT)

HDFC SmartGateway is a payment provider alongside Razorpay, behind the same
provider abstraction (`backend/app/services/payments/`). It is selected by
configuration, exactly like Razorpay:

```
PAYMENT_PROVIDER=hdfc
```

- **Official docs (source of truth):** <https://smartgateway.hdfc.bank.in/docs/smartgateway-api-ref-basicauth/docs/overview/integration-architecture>
- **UAT dashboard:** <https://dashboard.smartgateway.hdfcuat.bank.in/>
  (the docs' own API-key link points at `https://dashboarduat.smartgateway.hdfcuat.bank.in/settings/Security`)
- **Adapter:** `backend/app/services/payments/hdfc_provider.py`
- **Return route:** `backend/app/routers/payment_returns.py`
- **Webhook route:** the existing `POST /api/webhooks/payments/hdfc`

The docs were read verbatim (their `.md` exports) on 2026-09-24. Anything the
docs do not settle is marked **NOT VERIFIED — requires HDFC confirmation** in
the code and at the end of this page.

---

## 1. How it fits the existing architecture

Nothing parallel was built. HDFC is one more adapter implementing
`PaymentProvider`; every layer above it is the one Razorpay already uses.

```
Customer
  -> Pay Now (package / flight / hotel)            unchanged endpoints
  -> start_checkout()                              amount from the booking row
  -> payments.get_provider()  -> HDFCSmartGatewayProvider
  -> POST {HDFC}/session                           HDFC order, payment_links.web
  -> browser redirected to HDFC's hosted page      (iframes are not supported)
  -> customer pays
  -> HDFC redirects browser to  /api/payments/hdfc/return
         -> (optional) HMAC signature check        picks WHICH order
         -> GET {HDFC}/orders/{order_id}           Order Status, server-to-server
         -> payment_verification_*_service         order id, amount, currency vs booking
         -> confirm_booking()                      same transaction, once
         -> 303 to /my-bookings.html               polls /reconcile for the result
  -> HDFC webhook  /api/webhooks/payments/hdfc
         -> Basic-auth check, dedupe by event id
         -> SAME verifier (Order Status again)     idempotent with the return
```

**Nothing the browser or the webhook says confirms a booking.** Both only
trigger the verifier, which re-reads the order from HDFC's Order Status API and
compares the order id, amount (integer paise) and currency with our booking row
before `captured` is ever written. HDFC's own docs require exactly this: "it is
mandatory to do a Server-to-Server Order Status API call to determine the final
payment status. Please ensure that you verify the order ID and amount".

### No migration

The payment tables already carry the provider-agnostic columns from migration
0062 (`provider`, `provider_order_id`, `provider_payment_id`,
`provider_status`, `idempotency_key`, `paid_at`) plus the older
`provider_reference`. HDFC uses them as follows:

| Column | HDFC value |
|---|---|
| `provider` | `hdfc` |
| `provider_order_id` | our HDFC `order_id` (`JP` + 18 hex chars) |
| `provider_payment_id` | the same order id, once a transaction has been attempted — HDFC's status and refund APIs are addressed by order |
| `provider_reference` | HDFC `txn_id` (per attempt; appears in HDFC's reconciliation report) |
| `provider_status` | HDFC's raw order status, lowercased (`charged`, `authorization_failed`, …) |
| `method` | `payment_method_type` lowercased (`card`, `upi`, `nb`, `wallet`) |
| `failure_reason` | `bank_error_message` / `txn_detail.error_message` |

Raw webhook bodies are stored in `payment_provider_events.payload` with card,
e-mail, phone, VPA/UPI and SDK/token fields replaced by `<redacted>`.

---

## 2. Endpoints used (all from HDFC's docs)

| Purpose | HDFC endpoint | Notes |
|---|---|---|
| Create order + payment link | `POST {base}/session` | JSON body; returns `payment_links.web` |
| Order Status | `GET {base}/orders/{order_id}` | the authoritative read |
| Refund | `POST {base}/orders/{order_id}/refunds` | form-encoded `unique_request_id`, `amount` |

`{base}` is `HDFC_SG_BASE_URL`. UAT: `https://smartgateway.hdfcuat.bank.in`.

**Authentication** (every call): `Authorization: Basic base64(API_KEY)` — the
API key alone, per HDFC's example (`1234` → `MTIzNA==`) — plus `x-merchantid`,
`x-customerid` and `x-resellerid: hdfc_reseller`.

### Field mapping (Session API)

| Our concept | HDFC field |
|---|---|
| order id | `order_id` = `"JP"` + first 18 hex of SHA-256(`booking_ref` + `|` + idempotency key). 20 chars, alphanumeric, non-sequential, deterministic |
| amount | `amount` = rupees with exactly 2 decimals, from integer paise (`from_minor`), never float |
| currency | `currency` = `INR` |
| customer id | `customer_id` and header `x-customerid` = `JPC{customer_id}` |
| customer name | `first_name` / `last_name` (restricted to alphanumerics and `().-_`) |
| customer email | `customer_email` |
| customer phone | `customer_phone`, 10 digits, `+91` stripped |
| return URL | `return_url` = `HDFC_SG_RETURN_URL` (https, no query string) |
| callback URL | none per order — the webhook URL is set on the dashboard |
| client id | `payment_page_client_id` = `hdfcmaster` on UAT, merchant id elsewhere |
| action | `paymentPage` |
| booking ref / product | `udf1` / `udf2` |

---

## 3. HDFC status → internal status

From HDFC's "Transaction Status" table. The same function maps the webhook's
`content.order` and the Order Status response, so the two cannot disagree.

| HDFC status (id) | Internal | Meaning / handling |
|---|---|---|
| `NEW` (10) | `pending` | order created, no transaction yet |
| `PENDING_VBV` (23) | `processing` | authentication in progress — keep polling |
| `AUTHORIZING` (28) | `processing` | pending from bank — keep polling |
| `STARTED` (20) | `processing` | HDFC calls this an integration error; not terminal |
| `CHARGED` (21) | `captured` *(only after verification)* | success |
| `CHARGED` + `refunded: true` | `refunded` | fully refunded |
| `AUTHORIZED` (25) | `authorized` | pre-auth only; never requested here — left for an operator |
| `JUSPAY_DECLINED` (22) | `failed` | |
| `AUTHENTICATION_FAILED` (26) | `failed` | this is also how a customer "cancelling" shows up |
| `AUTHORIZATION_FAILED` (27) | `failed` | bank refused |
| `AUTO_REFUNDED` (36) | `refunded` | gateway returned the money |
| `VOIDED` (31) | `cancelled` | pre-auth only |
| `VOID_INITIATED` (32), `VOID_FAILED` (35), `CAPTURE_INITIATED` (33) | `processing` | pre-auth only |
| `CAPTURE_FAILED` (34) | `failed` | pre-auth only |
| anything else | `pending` | **unknown is never success**; raw word kept in `provider_status` |

`expired`: HDFC has no expiry status. The booking's own payment window
(`customer_payment_window.py`) governs expiry, as for Razorpay.
`cancelled`: HDFC documents no customer-cancel status; a customer who backs
out is `AUTHENTICATION_FAILED` → `failed`, and can retry on the same order.

Transitions are forward-only (`payments.base.is_forward`), so a late
`TXN_FAILED` cannot undo a verified capture.

---

## 4. Return URL (callback)

`GET` or `POST /api/payments/hdfc/return` — HDFC appends `order_id`, `status`,
`status_id` and, with "Use signed response" on, `signature` and
`signature_algorithm`.

1. If `HDFC_SG_RESPONSE_KEY` is set, the HMAC-SHA256 signature is **required**
   and checked (HDFC's algorithm: every parameter except the two signature
   fields, percent-encoded, sorted, joined with `&`, percent-encoded again,
   HMAC with the Response Key, base64). A missing or wrong signature: nothing
   is looked up or verified, and the customer lands on My Trips.
2. The payment row is found by `(provider='hdfc', provider_order_id)` only.
3. The verifier runs (Order Status → compare → capture → confirm).
4. `303` to `{FRONTEND_BASE_URL}/my-bookings.html?payment_return=hdfc&kind=…&ref=…`.
   The target is built from configuration; no parameter can choose it.
5. The page shows "confirming" and polls `POST …/{ref}/reconcile`, which runs
   the same verifier — so a bank that settles seconds later still ends on the
   right answer.

The `status` query parameter is never read.

## 5. Webhook

HDFC webhooks **exist and are mandatory** per the docs. They are authenticated
with a dashboard username/password sent as
`Authorization: Basic base64(username:password)` — not an HMAC.

- Route: `POST /api/webhooks/payments/hdfc` (the existing provider-agnostic route).
- Wrong/missing credentials → `401`, nothing recorded.
- Event id = body `id`; `(provider, provider_event_id)` is uniquely indexed, so
  a redelivery answers `200 {"status":"duplicate"}` and changes nothing. HDFC
  re-sends anything that is not `200`, which is why duplicates are `200`.
- Acted on: `ORDER_SUCCEEDED`, `ORDER_FAILED`, `ORDER_AUTHORIZED`,
  `ORDER_REFUNDED`, `TXN_CREATED`, `TXN_CHARGED`, `TXN_FAILED`,
  `AUTO_REFUND_SUCCEEDED`. Everything else (`ORDER_CREATED`,
  `ORDER_REFUND_FAILED`, `AUTO_REFUND_FAILED`, `REFUND_MANUAL_REVIEW_NEEDED`,
  mandate and notification events) is recorded and ignored.
- A money-moving event is **never applied from the body**: it goes to the
  verifier, which calls Order Status. Webhook before return, return before
  webhook, both, or either repeated: one capture, one confirmation.
- An event the provider could not answer for (timeout) stays `deferred` and
  the existing deferred-payment sweep retries it.

## 6. Booking confirmation

HDFC success reaches the existing `confirm_booking()` in the same
transaction as the capture, under the existing payment → booking lock order.

**There is no TBO or Riya integration in this repository.** Confirmation is
the platform's own `confirm_booking()` (status → confirmed, one notification,
one audit entry). When a supplier call is added it belongs behind that
function, which already guarantees it runs once and only after a verified
capture.

**Paid but not confirmable** (e.g. the booking was cancelled meanwhile): the
payment is recorded `captured` — never lost — the booking is left as it is,
and an audit entry "Payment captured on a non-confirmable booking … Needs
review" is written for an operator. This is the existing behaviour for every
provider.

---

## 7. UAT setup

1. From the bank: **Merchant ID** and UAT dashboard access.
2. UAT dashboard → Payments → Settings → Security → API Keys → **Create New API Key**.
   The key downloads as a file; store it only in the server's `backend/.env`.
3. Dashboard → Payments → Settings → **Webhook** tab:
   - Webhook URL: `https://<your-domain>/api/webhooks/payments/hdfc`
   - Username / Password: choose them (no special characters in the username).
   - Enable the Order and Transaction events (at least `ORDER_SUCCEEDED`,
     `ORDER_FAILED`, `TXN_CHARGED`, `TXN_FAILED`).
4. Optional but recommended: Settings → Security → create a **Response Key**;
   Settings → General → **Use signed response = Yes**.
5. `backend/.env` on the server:

   ```env
   PAYMENT_PROVIDER=hdfc
   PAYMENT_ENVIRONMENT=test
   FRONTEND_BASE_URL=https://<your-domain>
   HDFC_SG_BASE_URL=https://smartgateway.hdfcuat.bank.in
   HDFC_SG_MERCHANT_ID=<from the bank>
   HDFC_SG_API_KEY=<from the dashboard>
   HDFC_SG_WEBHOOK_USERNAME=<as set on the dashboard>
   HDFC_SG_WEBHOOK_PASSWORD=<as set on the dashboard>
   HDFC_SG_RESPONSE_KEY=<optional, from the dashboard>
   # HDFC_SG_RETURN_URL defaults to {FRONTEND_BASE_URL}/api/payments/hdfc/return
   ```

6. Restart. The log must say `Payments enabled: provider=hdfc environment=test`
   and `HDFC SmartGateway adapter ready: base=https://smartgateway.hdfcuat.bank.in …`
   (secrets appear only as `<set:N chars>`). A configuration error is logged
   as `PAYMENTS ARE MISCONFIGURED …` and Pay Now is not offered.

The return URL and webhook must be **public HTTPS** — HDFC cannot reach
`localhost`. For a laptop, use a tunnel and set `HDFC_SG_RETURN_URL` to it;
without a webhook the reconcile poll still settles the booking.

### UAT test data (from HDFC's "Test Resources" page)

| Scenario | How |
|---|---|
| Success, any method | order amount **< ₹500** |
| Failure, any method | amount **₹500 – ₹699.99** |
| Pending, then success | amount **≥ ₹700** |
| Card | VISA `4012 0000 0000 1097` or Mastercard `5204 7305 4100 0464`, any future expiry, any CVV, OTP `000000` |
| Net banking | select **Axis Bank** |
| Refund success | any unique refund id |

(UAT outcome is decided by the **amount**, so pick test bookings accordingly.)

### Moving to production (later, deliberately)

Per HDFC: generate a production API key, set `HDFC_SG_BASE_URL=https://smartgateway.hdfc.bank.in`,
use the merchant id as client id (the default off the UAT host), and set
`PAYMENT_ENVIRONMENT=live`. The adapter refuses the production host while
`PAYMENT_ENVIRONMENT=test` and the UAT host while it is `live`.

---

## 8. Troubleshooting

| Symptom | Likely cause | What to check |
|---|---|---|
| Log: `HDFC refused our credentials … (HTTP 401)`; customer: "We couldn't start the payment" | wrong API key or merchant id; UAT key against production or vice versa | `HDFC_SG_API_KEY`, `HDFC_SG_MERCHANT_ID`, `HDFC_SG_BASE_URL` agree with the dashboard you generated the key on |
| Log: `PAYMENTS ARE MISCONFIGURED: PAYMENT_PROVIDER=hdfc needs …` | a required variable is empty | the names listed in the message |
| `… is HDFC's PRODUCTION host` at startup | production URL with `PAYMENT_ENVIRONMENT=test` | use the UAT URL, or switch environment deliberately |
| `HDFC_SG_RETURN_URL must be an https:// URL with no query string` | HDFC's return-URL rules | https, domain name, no `?` |
| `HDFC refused … HTTP 400 … Mandatory fields are missing` | invalid merchant configuration or a customer field HDFC rejects (e-mail/phone format) | the logged `error_message`; the customer's e-mail/mobile |
| Customer returns, lands on My Trips with "unverified" | signature mismatch — wrong/rotated Response Key, or "Use signed response" on without `HDFC_SG_RESPONSE_KEY` set | the key; nothing is lost: the webhook and reconcile still settle the booking |
| Customer never returns / HDFC error "invalid return url" | return URL not HTTPS/public, has a query string, or redirects | `HDFC_SG_RETURN_URL`, the Caddy route |
| Webhook shows "Webhook Notified: FALSE" in the dashboard | our endpoint returned non-200 — usually `401` (credential mismatch) | `HDFC_SG_WEBHOOK_USERNAME/PASSWORD` vs the Webhook tab |
| Payment stays `pending`, screen says "taking longer than usual" | HDFC status `PENDING_VBV`/`AUTHORIZING` (UAT: amount ≥ ₹700) | normal; the reconcile poll, the webhook and the deferred sweep keep asking |
| Payment `failed` | HDFC reported `AUTHENTICATION_FAILED` / `AUTHORIZATION_FAILED` / `JUSPAY_DECLINED` | `failure_reason` on the row; the customer can retry on the same order |
| Log: `PAYMENT VERIFICATION REJECTED … amount_mismatch` / `order_mismatch` / `currency_mismatch` | HDFC's order does not match the booking | **do not confirm by hand** — investigate; the booking is intentionally left unconfirmed |
| Verifier code `provider_timeout` / `provider_error` | status verification failure (HDFC slow or 5xx) | retried automatically; nothing is written until HDFC answers |
| `capture_refused` with `capture_unsupported` | HDFC reported `AUTHORIZED` (pre-auth) — should not happen, pre-auth is never requested | check the dashboard's auto-capture settings with HDFC |

---

## 9. NOT VERIFIED — requires HDFC confirmation

1. **`x-customerid` on Order Status / Refund.** Listed as mandatory, but those
   calls carry no customer. The merchant id is sent. If HDFC rejects it, every
   status check fails identically — UAT test step "verify server-side status"
   will show it immediately.
2. **Duplicate `order_id` on `/session`.** Not documented. The id is
   deterministic, so at most one HDFC order per (booking, key) can exist either
   way; on a refusal the adapter looks the order up and reuses it.
3. **Unknown order on Order Status.** Docs list 400/401/500, not 404. Both
   "not found" answers are treated as "absent" only when deciding to create.
4. **Return redirect method (GET vs POST).** Not stated; both are accepted.
5. **Return-URL signature encoding.** HDFC's samples disagree on whether the
   delivered `signature` is plain or percent-encoded base64; both encodings of
   the same digest are accepted. The docs contain **no reproducible test
   vector** (the Java sample's expected hash was not produced with the
   placeholder key shown), so the implementation is checked against an
   independent rendering of HDFC's PHP sample, not against a real HDFC
   signature. Verify with the first signed UAT return.
6. **`effective_amount`.** In every sample, not in the field list. If it ever
   differs from `amount`, the lower figure is compared — which will not match
   the booking and is refused for review.
7. **Refund content type.** The header list says JSON; the sample request is
   form-encoded. Form encoding (the concrete example) is used. No refund
   endpoint in this platform calls it yet.
8. **`version` header.** Appears in some curl samples (`2023-06-30`,
   `2024-05-01`) but not in any header list; not sent.
