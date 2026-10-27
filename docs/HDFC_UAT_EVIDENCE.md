# HDFC SmartGateway — UAT Verification Evidence Runbook

How to produce the evidence HDFC Bank asked for — numbered screenshots of a
successful payment journey and the Order Status API response — from a **genuine**
JackpotsWorld UAT transaction, and how to cross-check and redact it before
sending.

This runbook describes the integration as it actually exists in this repository
(`backend/app/services/payments/hdfc_provider.py`, `payment_returns.py`, the
customer booking routers, and `payment_verification_service.py`). HDFC's
supplied `SG Sample status.txt` is used **only** as the reference for the Order
Status response *format*.

> **Do not** initiate a live payment, present the supplied sample as evidence of
> our own transaction, fabricate any result, expose credentials, or deploy.
> Every figure sent to HDFC must come from a real UAT transaction we performed.

Each claim below is tagged **[Verified]** (true of the code today) or
**[Assumption — confirm with HDFC]** (a choice the integration makes that HDFC's
docs leave open; collected in full in [§9](#9-verified-vs-assumptions)).

---

## 1. UAT prerequisites and environment variables

### 1.1 From the bank / ops (still outstanding)
- **Merchant ID** — issued by HDFC.
- **UAT dashboard access** → Payments → Settings → Security → **API Keys → Create
  New API Key** (downloads as a file; store only in the server's `backend/.env`).
- **Webhook username/password** — chosen on the dashboard's Webhook tab; enable
  at least `ORDER_SUCCEEDED`, `ORDER_FAILED`, `TXN_CHARGED`, `TXN_FAILED`.
- **Response Key** (optional) — Settings → Security; then Settings → General →
  **Use signed response = Yes**.
- **A public HTTPS host** — HDFC cannot reach `localhost`; the return and webhook
  URLs must be publicly reachable over HTTPS. **[Verified]** the adapter refuses
  a local/`http` return URL in a live environment and the app refuses a non-HTTPS
  `FRONTEND_BASE_URL` when `PAYMENT_ENVIRONMENT=live`.
- **The exact UAT base URL for this merchant** — see §1.3.

### 1.2 Environment variables (`backend/.env` on the UAT host)

| Variable | Value for UAT | Required | Notes |
|---|---|---|---|
| `PAYMENT_PROVIDER` | `hdfc` | yes | selects the adapter **[Verified]** |
| `PAYMENT_MODE` | `real` | yes | `demo` is ignored on a deployed/live host; locally it must be `real` to call HDFC **[Verified]** |
| `PAYMENT_ENVIRONMENT` | `test` | yes | refuses the production host; allows a UAT host **[Verified]** |
| `FRONTEND_BASE_URL` | `https://<uat-host>` | yes | the customer is redirected back here; the default return URL is built from it **[Verified]** |
| `HDFC_SG_BASE_URL` | one of the two UAT hosts (§1.3) | yes | no default; pointing at production is deliberate **[Verified]** |
| `HDFC_SG_MERCHANT_ID` | from the bank | yes | also the browser-visible publishable key **[Verified]** |
| `HDFC_SG_API_KEY` | from the dashboard | yes | sent as `Authorization: Basic base64(key)`; never logged/returned **[Verified]** |
| `HDFC_SG_WEBHOOK_USERNAME` | as set on dashboard | yes | webhook Basic-auth **[Verified]** |
| `HDFC_SG_WEBHOOK_PASSWORD` | as set on dashboard | yes | webhook Basic-auth; min 12 chars enforced **only** when live **[Verified]** |
| `HDFC_SG_RESPONSE_KEY` | from the dashboard | optional | when set, the return-URL HMAC signature is required and checked **[Verified]** |
| `HDFC_SG_CLIENT_ID` | usually unset; see §1.3 | optional | `payment_page_client_id`; explicit value always wins **[Verified]** |
| `HDFC_SG_RETURN_URL` | optional | optional | defaults to `{FRONTEND_BASE_URL}/api/payments/hdfc/return`; HTTPS, no query, no IP **[Verified]** |

**Secrets never appear** in logs or any API response; the startup log prints them
only as `<set:N chars>`. **[Verified]**

On boot, confirm the log shows:
```
Payments enabled: provider=hdfc environment=test
HDFC SmartGateway adapter ready: base=https://<uat-host> merchant_id=… client_id=… api_key=<set:N chars> …
```
A misconfiguration logs `PAYMENTS ARE MISCONFIGURED …` and Pay Now is withheld.
**[Verified]**

### 1.3 Which UAT host, and the client id

HDFC uses **more than one UAT hostname**, on different parent domains. Both are
recognised by the adapter (`UAT_HOSTS`):

| Host | Source |
|---|---|
| `smartgateway.hdfcuat.bank.in` | SmartGateway API documentation |
| `smartgatewayuat.hdfcbank.com` | HDFC's supplied `SG Sample status.txt` (`payment_links`) |

**[Verified]** On **either** host, when `HDFC_SG_CLIENT_ID` is left unset the
adapter defaults `payment_page_client_id` to the documented sandbox value
`hdfcmaster`; an explicitly set `HDFC_SG_CLIENT_ID` is never overridden. A host
that is neither of the two above (and is not the production host) is treated as
**neither** UAT nor production — no sandbox client id, no host-based guard — so
for such a host you must set `HDFC_SG_CLIENT_ID` yourself.

- **[Assumption — confirm with HDFC]** which of the two base URLs is issued to
  *this* merchant, and that `hdfcmaster` is the correct `payment_page_client_id`
  for the `smartgatewayuat.hdfcbank.com` host specifically.

### 1.4 Read-only readiness check (never prints a secret)
```bash
cd deploy && docker compose exec app python scripts/check_hdfc_production.py
```
In UAT, the "environment is not live" and "demo mode" lines are **expected
BLOCKs**, not faults. Success in UAT is the adapter line passing and the startup
log reading `Payments enabled: provider=hdfc environment=test`. **[Verified]**

---

## 2. Checkout → success workflow

All **[Verified]** from the routers and `payment-screen.js` / `booking-pay.js`:

1. Customer signs in and opens a booking (package, hotel or flight) with a total
   **under ₹500** (see §2.1).
2. The page calls `GET /api/customer/payments/config?booking_ref=…` → expects
   `{ configured: true, provider: "hdfc", mode: "real", … }`.
3. **Checkout** — `POST /api/customer/{product}/{ref}/checkout` opens an HDFC
   order for the **booking's own amount** (never a figure from the request) and
   returns `redirect_url` = HDFC's hosted `payment_links.web`.
   - packages: `/api/customer/package-bookings/{ref}/checkout`
   - hotels: `/api/customer/hotel-bookings/{ref}/checkout`
   - flights: `/api/customer/bookings/{ref}/checkout`
4. The browser is redirected to HDFC's hosted page and the customer pays.
5. **Return** — HDFC redirects the browser to
   `GET|POST /api/payments/hdfc/return`. The `status` in the query string is
   **ignored**; the order id only selects which payment to re-verify. The server
   calls Order Status (§3), compares against the booking, captures once, then
   `303` → `/my-bookings.html?payment_return=hdfc&kind=…&ref=…`.
6. **Success screen** — My Trips polls `POST /api/customer/{product}/{ref}/reconcile`
   (the same verifier) and shows **Booking ID, Gateway order ID, Amount,
   "Payment Successful / Paid Successfully"** once the booking is confirmed.
7. **Webhook** — `POST /api/webhooks/payments/hdfc` (Basic-auth, deduped by event
   id) independently drives the same verifier; one capture, one confirmation.

**Nothing the browser or the webhook says confirms a booking** — only an
authenticated Order Status read whose order id, amount and currency match the
booking row. **[Verified]**

### 2.1 UAT test data (HDFC Test Resources)
| Outcome | How |
|---|---|
| **Success** | order total **< ₹500** |
| Failure | ₹500 – ₹699.99 |
| Pending → success | ≥ ₹700 |
| Card | VISA `4012 0000 0000 1097`, any future expiry, any CVV, OTP `000000` |

> The supplied `SG Sample status.txt` shows `amount: 12000` — that is HDFC's
> illustrative sample, not a rule. For a guaranteed successful capture, use a
> booking under ₹500.

---

## 3. Retrieving the genuine Order Status API response

The authoritative read, which the server already performs during verification
(`HDFCSmartGatewayProvider.fetch_order`). **[Verified]** request shape:

```
GET https://<UAT base>/orders/<ORDER_ID>
Authorization: Basic <base64(HDFC_SG_API_KEY)>
x-merchantid:  <HDFC_SG_MERCHANT_ID>
x-customerid:  <HDFC_SG_MERCHANT_ID>
x-resellerid:  hdfc_reseller
Accept:        application/json
```

- `<ORDER_ID>` is our **merchant order id** — `JP` + 18 hex, deterministic per
  (booking, idempotency key). It is the `order_id` HDFC echoes in the response
  (distinct from HDFC's own `id`, e.g. `ordeh_…`). **[Verified]**
- **[Assumption — confirm with HDFC]** `x-customerid` on a server-side status
  read carries the **merchant id** (the call has no customer). If HDFC rejects
  it, every status read fails identically — visible on the first UAT read.

**How to capture it for evidence (no simulation):**
1. Perform the real UAT success transaction from §2.
2. The server calls Order Status automatically on return/reconcile. Capture the
   raw response by **either**:
   - **(a)** repeating the read-only GET above with the same `<ORDER_ID>` (a
     status read moves no money), or
   - **(b)** taking it from the server application logs for that order.
3. Record the **HTTP status** (expected `200`) alongside the body.
4. **Redact** before saving/sending (see §6).

The response fields that answer HDFC's questions (names per `SG Sample
status.txt`, read by `_payment_from`): **[Verified]**

| HDFC asks for | Field(s) in the Order Status response |
|---|---|
| Order number (merchant) | `order_id` |
| Order id (HDFC's own) | `id` (e.g. `ordeh_…`) |
| Amount | `amount` (in **rupees**) |
| Currency | `currency` |
| Payment/transaction status | `status` (e.g. `CHARGED`) + `status_id` (`21`) |
| Transaction id | `txn_id` |
| Method | `payment_method_type` |

---

## 4. Evidence HDFC requested

### 4.1 Screenshots (the website URL must be visible in each)
1. **Homepage** — `https://jackpotsworldtours.com/`
2. **Product + amount payable** — the booking detail with the total (< ₹500)
3. **Checkout / payment initiation** — our "Opening payment" screen (our URL)
4. **HDFC hosted payment page** — `smartgatewayuat.hdfcbank.com` (or the issued
   UAT host); **mask the card number and OTP**
5. **Redirect back to JackpotsWorld** — address bar shows
   `…/my-bookings.html?payment_return=hdfc…`
6. **Final success screen** — showing **Booking ID + Gateway order ID + Amount +
   "Payment Successful / Paid Successfully"**

### 4.2 API evidence
- The Order Status **request** structure (Authorization redacted)
- The raw Order Status **response** + HTTP `200` (card/email/phone redacted)
- The field map from §3
- The cross-check table from §5
- A one-line environment statement: *UAT, provider=hdfc, mode=real,
  environment=test, base=<host>*

---

## 5. Cross-checking the identifiers

Every value on the success page is read from the server, and the server's figures
come from the booking row and the Order Status read — not the browser.
**[Verified]** For evidence, show these three sources agree:

| Field | Success page | `…/reconcile` response | Order Status response | Booking / payment row |
|---|---|---|---|---|
| Booking ID | "Booking ID" | `booking_ref` | `udf1` (our ref, alnum) | `booking_ref` |
| Merchant order ID | — | `gateway_order_id` | `order_id` | `provider_order_id` |
| Gateway order ID (HDFC) | "Gateway order ID" | `gateway_order_id` | `order_id` | `provider_order_id` |
| Amount | "Amount paid" | `amount` (major units) | `amount` (rupees) | `total_amount` / payment `amount` |
| Currency | (with amount) | `currency` | `currency` | `currency` (INR) |
| Transaction ID | — | — | `txn_id` | `provider_reference` |
| Payment status | "Paid Successfully" | `payment_status` = `captured` | `status` = `CHARGED` | payment `status` = captured |

> **Note:** "Merchant order ID" and "Gateway order ID" are the **same value** in
> this integration — our deterministic `order_id` (`JP…`) is what we send to
> HDFC and what HDFC echoes. HDFC's internal `id` (`ordeh_…`) is separate and not
> shown to the customer. **[Verified]**

**Required equalities:**
`success-page Amount` == `reconcile.amount` == `Order Status amount` == booking total;
`success-page Gateway order ID` == `reconcile.gateway_order_id` == `Order Status order_id` == `provider_order_id`;
`Order Status status` == `CHARGED` and payment row == `captured`.

The `gateway_order_id` is returned **only** for a captured (server-verified)
payment, so it cannot appear before the money is confirmed. **[Verified]**

---

## 6. Redaction requirements

**Before anything leaves our hands:**

- **Credentials** — never include `HDFC_SG_API_KEY`, the `Authorization` header
  value, `HDFC_SG_WEBHOOK_PASSWORD`, or `HDFC_SG_RESPONSE_KEY`. Show the
  Authorization header as `Basic <redacted>`.
- **Customer PII** — in the Order Status response, redact `customer_email`,
  `customer_phone`, and `customer_id` where it is a phone number.
- **Payment instrument** — redact the entire `card` object (`last_four_digits`,
  `card_fingerprint`, `card_isin`, `name_on_card`, …) and any
  `payment_gateway_response` / SDK token fields.

What the platform **already** redacts when it stores a webhook or status payload
(`_REDACT` in the adapter): `card`, `customer_email`, `customer_phone`,
`payer_vpa`/`upi`, `merchant_payload`, SDK/`clientAuthToken`, mandate and
`gateway_response` fields → stored as `<redacted>`. **[Verified]** The stored
copy is therefore already safe; a raw capture taken outside the app (§3 option a)
must be redacted by hand to the same standard.

---

## 7. Troubleshooting

From the adapter's documented error handling. **[Verified]**

| Symptom | Likely cause | Check |
|---|---|---|
| Startup: `… is HDFC's PRODUCTION host` | production URL with `PAYMENT_ENVIRONMENT=test` | use a UAT host, or set `live` deliberately |
| `PAYMENTS ARE MISCONFIGURED: … needs …` | a required variable empty | the names in the message |
| `HDFC refused our credentials … (HTTP 401)` | wrong API key/merchant id, or key vs host mismatch | `HDFC_SG_API_KEY`, `HDFC_SG_MERCHANT_ID`, `HDFC_SG_BASE_URL` agree with the dashboard the key was generated on |
| `/session` HTTP 400 "Mandatory fields missing" | merchant config, or a client id HDFC rejects on this host | set `HDFC_SG_CLIENT_ID` (e.g. `hdfcmaster`) explicitly for the issued host |
| Customer returns to My Trips "unverified" | return signature mismatch | `HDFC_SG_RESPONSE_KEY`; nothing lost — webhook + reconcile still settle |
| `HDFC returned an unexpected payment link` | `payment_links.web` host not under the base host's parent domain | confirm the issued base URL matches where links are served |
| Payment stays pending, "taking longer than usual" | `PENDING_VBV`/`AUTHORIZING` (UAT amount ≥ ₹700) | normal; reconcile/webhook/sweep keep asking — use < ₹500 for success |
| `PAYMENT VERIFICATION REJECTED … amount_mismatch` | Order Status amount ≠ booking | do **not** confirm by hand; investigate |

---

## 8. Final submission checklist

- [ ] UAT configured: `PAYMENT_PROVIDER=hdfc`, `PAYMENT_MODE=real`,
      `PAYMENT_ENVIRONMENT=test`, base = issued UAT host, `FRONTEND_BASE_URL`
      public HTTPS; startup log confirms `Payments enabled: provider=hdfc
      environment=test`.
- [ ] A **real** UAT success transaction on a booking **< ₹500**.
- [ ] Screenshots 1–6 (§4.1), website URL visible, card/OTP masked.
- [ ] Order Status **request** (Authorization redacted) + **raw response** + HTTP
      `200` (card/email/phone redacted).
- [ ] Cross-check table (§5) filled from the real transaction, all equalities hold.
- [ ] One-line environment statement included.
- [ ] No credential, PII or card data anywhere in the package.
- [ ] Open items from §9 that HDFC still needs to confirm are listed.
- [ ] The supplied `SG Sample status.txt` is referenced as HDFC's **format
      sample only** — never labelled as our transaction.

---

## 9. Verified vs assumptions

**[Verified] in code (with tests):** route paths; amount taken from the booking,
never the request; `order_id = JP + 18 hex`, deterministic; Order Status is the
authority; browser/webhook never confirm on their own; capture-once under a row
lock; `gateway_order_id` returned only when captured; both UAT hosts recognised
with the `hdfcmaster` default and explicit client id preserved; production host
refused in test; secrets never logged/returned; card/email/phone redacted in
stored payloads.

**[Assumption — confirm with HDFC]** (unchanged items carried from the adapter's
own `NOT VERIFIED` notes):
1. Which UAT base URL is issued to this merchant, and that `hdfcmaster` is the
   correct `payment_page_client_id` for `smartgatewayuat.hdfcbank.com`.
2. `x-customerid` = merchant id is accepted on Order Status / Refund reads.
3. Return redirect method (GET vs POST) — both are accepted.
4. Return-URL signature encoding (plain vs percent-encoded base64) — both
   accepted; verify against the first signed UAT return.
5. `effective_amount` semantics (not in the field list; appears in samples).
6. The response for an unknown order / a duplicate `order_id` on `/session`.

**Prerequisites for a genuine UAT transaction (still outstanding):** UAT merchant
id + API key + webhook username/password (and optional response key); a public
HTTPS host for the return and webhook URLs; and confirmation of the issued base
URL per item 1.
