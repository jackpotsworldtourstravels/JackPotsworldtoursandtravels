# Payments in the mobile app

What the app does when a customer pays, what it trusts, what has been verified, and what has not.
Everything here was checked against the backend's code (`backend/app/services/payments/`,
`backend/app/routers/payment_returns.py`, the customer booking routers) and, where stated, run against a
local backend using the **mock** payment provider. **No real HDFC page has ever been opened by this app.**

## The flow

1. **Quote** (`POST /{hotel,package}-bookings/quote`): the server prices the exact choices. No money in the request.
2. **Create** (`POST /{hotel,package}-bookings`, with an `idempotency_key`): a *pending* booking. The server re-prices.
   Nothing is charged. The booking can be paid for 30 minutes (`created_at` + 30 min; the server enforces it).
3. **Checkout** (`POST …/checkout`, body `{idempotency_key}`, **no amount**): the backend asks the provider for an
   order and returns `redirect_url`. The key is `pay-<booking_ref>-<n>`, derived from the booking, so pressing Pay
   twice, or again after a restart, resumes the same order. `n` goes up only after an attempt has failed,
   expired or been cancelled.
4. **Hosted page**: the app opens `redirect_url` in the system browser, only if it is `https`. The backend
   independently refuses any HDFC link not on HDFC's own host (`HDFCSmartGatewayProvider._payment_link`).
5. **Back in the app**: the app asks `POST …/reconcile` (empty body). The backend asks the provider and compares
   order, amount and currency with the booking it priced. Only then does it say captured.
6. **"Paid"** is shown only when the backend reports a **captured** payment **and** a **confirmed/completed**
   booking. A closed browser, a redirect, the `captured` flag in a reconcile answer, and anything in a URL are
   ignored. A captured payment on an unconfirmed booking is shown as "Payment under review: don't pay again".

## What the customer sees after paying (important)

HDFC redirects the browser to the backend's return route (`/api/payments/hdfc/return`), which re-verifies with
the provider server-side and then **303-redirects to the website**: `FRONTEND_BASE_URL/my-bookings.html?payment_return=…`.
So the in-app browser ends on the **website's My Bookings page**, which asks for a website sign-in. The app cannot
land the customer back in the app from there without a backend change. What the app does instead:

- The progress line tells the customer: complete the payment, and if the website appears, close it.
- On **iOS** `openBrowserAsync` resolves when the browser closes; the app then asks the backend.
- On **Android** it resolves as soon as the page *opens* (documented behaviour of `expo-web-browser`). The app
  therefore waits for the app to leave the foreground and return (`features/booking/hostedPage.ts`, 20-minute
  limit) before asking the backend. Without this it would have polled for about a minute while the customer was
  still at the bank, given up, and never looked again.
- If the app is killed while the customer is paying, opening the booking later checks an open payment once, quietly.
  *Check payment status* is always available.

## Safety behaviours (each has a test that fails if it breaks)

- Requests carry no price; amounts are decimal strings, compared as strings.
- One order per intention: deterministic checkout key; single-flight against double taps.
- An unrecognised payment status (the backend grows one) is treated as **in progress**, never as failed, so the
  customer is never told it is safe to pay again while money may be moving.
- Cancel is offered only for an unpaid booking with no open order (a paid booking gets a *cancellation request* to
  the desk instead, which moves no money).
- A server in `demo` payment mode, an unconfigured server, a missing or non-https `redirect_url` are all refused
  with an honest message. Nothing pretends to pay.
- The **Payments** screen lists every attempt recorded on the customer's hotel and package bookings, newest first,
  with refunds shown as the backend reports them. It is built from the bookings themselves because
  `GET /payments/history` reads only **flight** payments and is always empty for hotel and package customers.
  Flight payments are not shown (the app does not sell flights).

## Verified, and how

| Claim | How |
|---|---|
| The eight statuses the app knows match the backend's (`payments/base.py`) | Read the code |
| Checkout, hosted-page hand-off, reconcile, cancel, retry, double tap, wrong amount, timeouts | Automated tests (mock network) |
| Quote → create → checkout → webhook → reconcile → Confirmed; wrong-amount event refused; cancel unpaid | Run by hand against a local backend with the **mock** provider (2026-10-21) |
| The honest "can't be completed here" message when the provider returns no page | Run by hand (mock returns `redirect_url: null`), and a test |
| Android return handling | **Unit tests only** (fake app state). Not run on a device. |

## Not verified

- **The real HDFC hosted page**, UPI/card/net-banking journeys, 3-D Secure, and HDFC's UAT behaviour.
- Android and iOS devices (browser hand-off, app backgrounding, what each platform shows after the redirect).
- Whether HDFC redirects with GET or POST (the backend accepts both and its code says this is unconfirmed).
- Refunds actually reaching a customer: the app only displays what the backend records.

## Test plan for the first real payment (needs your go-ahead and a UAT or staging backend)

Use HDFC's **UAT** host (`smartgateway.hdfcuat.bank.in`) with its test credentials, on a staging deployment, never
production, and never a real card for the first run. The backend's own `hdfc_readiness` checklist tells you whether
the configuration is complete.

1. Build the app against the staging API (`EXPO_PUBLIC_API_BASE_URL=https://<staging>`).
2. Book a hotel room; confirm the quote and the booking total match.
3. Pay with a test instrument that **succeeds**. Expect: hosted page opens; after paying, the website's page may
   appear; close it; the booking reads **Confirmed**, *Payments* shows **Paid**.
4. Pay with a test instrument that **fails**. Expect: *Payment not completed*, **no** "paid", and Pay again works
   (a new checkout key, a new order).
5. Start a payment and **abandon** it (close the browser on the bank's page). Expect: "We haven't heard back from
   the bank", a working *Check payment status*, and no duplicate order after pressing Pay again.
6. Start a payment, **kill the app**, reopen, open the booking. Expect it to check the open payment.
7. Pay, then **wait past 30 minutes** on a second booking before paying. Expect the server's refusal sentence.
8. On **Android**, repeat 3 and 5 specifically: confirm the app does not poll while the bank page is showing and
   does check when you return.
9. Ask for a refund through the desk; confirm *Payments* shows **Refunded** only once the backend says so.

## Backend options that would improve this (none made; each needs your approval)

1. **Return to the app.** Let the return route redirect to a deep link (for example `jackpotsworld://payment-return?ref=…`)
   when the payment started from the app, so the browser closes itself and the app checks immediately. Today the
   return URL is fixed to the website by design (`payment_returns.py`: "the redirect target is fixed").
2. **A customer read route for hotel and package payments** that includes refund status, or fix
   `GET /payments/history` to include them. The app works without it.
3. **A read route for cancellation-request status**, so a refund request's progress can be shown.
