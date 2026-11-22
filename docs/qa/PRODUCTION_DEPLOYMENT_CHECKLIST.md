# Production Deployment Checklist — Phase 1 Bug Sprint

**Branch:** `claude/jackpotsworld-12-bug-sprint-c59a3f`
**Scope of this deploy:** the 8 resolved/verified bugs (11, 4, 7, 8, 9, 6, 10, 12-code).
**Not in this deploy:** Bugs 1, 3, 2, 5 (not yet implemented).

> Safety: this branch has **not** been pushed, merged, or deployed. No production
> database, environment variable or infrastructure has been changed. Nothing
> below should be run against production without explicit human approval.

## 1. What actually ships here

| Change | Kind | Action to deploy |
|---|---|---|
| Bugs 11, 4, 7, 8, 9 — `frontend/assets/js/*`, `index.html` | Static frontend | Publish the frontend bundle; bump cache-busting `?v=` on changed `.js` so clients re-fetch |
| Bug 6 — `customer_pricing_service.py` | Backend (message only, no schema) | Restart the API (uvicorn has no `--reload` in prod — see memory) |
| Bug 10 | Already in production (PR #52) | No action |
| Bug 12 | Code already in production (`d0bfa0c2`) | No code action — **operations only**, §3 |

No database migration is introduced by this sprint. No new environment variable is **required** by the 8 shipped items (Bug 12's TURN vars are an operations task, not new to this branch).

## 2. Pre-deploy verification
- [ ] `git diff --check` clean (done — no whitespace errors).
- [ ] Backend suite green with CI env (see `PHASE1_TEST_RESULTS.md`).
- [ ] Frontend suites green: `node --test frontend/tests/*.test.js` and `node --test tests/js/*.test.mjs`.
- [ ] Manual smoke (see §5).
- [ ] Code review of commit `372c14b`.

## 3. Bug 12 — voice-call secure operations (coturn / TURN)

**Do not expose the TURN secret.** It is a server-side value only; browsers receive short-lived derived credentials, never the secret.

### 3.1 Required production environment (on the API host)
Preferred (time-limited credentials — `turn_credentials()` HMAC path):
```
VOICE_CALLS_ENABLED=true
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:<public-ip-or-host>:3478?transport=udp,turn:<public-ip-or-host>:3478?transport=tcp
TURN_STATIC_AUTH_SECRET=<the coturn static-auth-secret>   # never logged, never sent to the browser
TURN_CREDENTIAL_TTL_SECONDS=3600
```
Legacy static-credential path (documented in CR-10, but not rotation-safe):
```
TURN_USERNAME=jwt-turn
TURN_PASSWORD=<long random secret, == coturn user secret>
```
`settings.turn_configured` is True only when `TURN_URLS` is set **and** one auth method is present. `/api/customer/chat/ice` logs a warning when TURN is unconfigured.

### 3.2 coturn deployment
- [ ] Run `sudo bash deploy/setup-coturn.sh` on the relay host (writes `static-auth-secret` into `turnserver.conf` and prints the matching `TURN_*` env). `TURN_PUBLIC_IP=<ip>` if IMDS cannot resolve it.
- [ ] Security group / firewall: **3478 TCP+UDP**, **5349 TCP** (TLS), **49152–65535 UDP** (relay range).
- [ ] (Optional TLS) add `cert=`/`pkey=`/`tls-listening-port=5349` and a `turns:...:5349` entry to `TURN_URLS`.
- [ ] Keep `VOICE_CALLS_ENABLED=false` until coturn is confirmed up; flip to `true` only then.
- [ ] Confirm the secret in `turnserver.conf` equals `TURN_STATIC_AUTH_SECRET` exactly.

### 3.3 Cross-network acceptance test (the external verification)
- [ ] Agent console + customer on **different networks** (ideally one on mobile/CGNAT).
- [ ] Customer places a call → agent console rings.
- [ ] Agent Accepts → **the agent's own call stays live** (the `d0bfa0c2` regression) and the customer connects.
- [ ] Verify ringtone, two-way audio, clean disconnection from each side.
- [ ] `GET /api/customer/chat/ice` returns `turn_configured: true`.
- [ ] A call across strict NATs connects via the relay (not STUN-only).

## 4. Bug 1 dependency (when it ships later)
Not in this deploy. When implemented it will need:
- SMTP already configured (`SMTP_HOST`, `SMTP_FROM_EMAIL`, auth, TLS) — else confirmation emails are skipped with a logged warning.
- A chosen SMS provider + credentials (new settings, default `none`). No hardcoded secrets.
- Confirmation delivery status must be recorded; a failed send must never be reported as delivered.

## 5. Manual smoke test (post-deploy)
- [ ] Footer on any page: **no** "Image Credits" link; other legal links present; `/image-credits` still loads by direct URL.
- [ ] Account → Wishlist: a saved package title links to its detail page; a saved hotel opens the hotel detail; Remove still works; a deleted item shows as plain text.
- [ ] Packages: search, open a result, Edit Search, refresh → destination + month restored; browser Back restores them too.
- [ ] Signed in, open Contact Us and each policy page: header greets by name (not "My Account"); sign out → "Login / Create".
- [ ] Apply a hotel-only coupon to a flight (and vice-versa): the error names the right products, not a hardcoded "flight bookings".
- [ ] Account → Payment History: flight, hotel and package payments all appear with the correct Service tag; pagination works.

## 6. Rollback
- **Frontend:** redeploy the previous frontend bundle (static files); revert the `?v=` tokens. No data involved.
- **Backend (Bug 6):** message-only change, no schema — redeploy the previous image / `git revert 372c14b` and restart the API.
- **No migration** was applied, so there is no down-migration to run for this sprint.
- **Bug 12 ops:** to disable voice calls instantly, set `VOICE_CALLS_ENABLED=false` and redeploy; coturn can be left running or stopped independently.

## 7. Post-deploy monitoring
- API logs for `SMTP not configured` (expected until Bug 1 + SMTP) and for the `/chat/ice` TURN-unconfigured warning (should disappear once §3 is done).
- Error rates on `/api/customer/*` after the frontend cache-bust.

---

# Phase 2 deploy — Bugs 1 & 3

**Branch:** `claude/jackpotsworld-phase-2-bugs-1080f3` (Phase 1 merged in). **Not pushed, merged or deployed.** No production database, env var or infrastructure changed. Nothing below runs against production without explicit human approval.

## P2.1 What ships

| Change | Kind | Action to deploy |
|---|---|---|
| Bug 1 — `sms_service.py`, `booking_confirmation_service.py`, confirm-hook edits, outbox sweep | Backend + **migration 0096** | Run migration; restart the API |
| Bug 1 — `customer_booking_notifications` table | **DB migration 0096** | `alembic upgrade head` (see P2.2) |
| Bug 3 — enquiry admin service/router/RBAC | Backend + **migration 0097** | Run migration; restart the API |
| Bug 3 — enquiry admin columns + status CHECK widen | **DB migration 0097** | `alembic upgrade head` (see P2.2) |
| Bug 3 — `admin-tour-package-enquiries.js`, `admin.js`, `admin/index.html` | Static admin frontend | Publish bundle; the script is already cache-busted (`?v=20261122p2`) |

## P2.2 Database migrations — **run and verify before the API restart**
- [ ] **Confirm migration ordering first.** Phase 2 adds `0096_customer_booking_notifications` and `0097_tour_package_enquiry_admin` chained on `0095`. The unmerged multi-segment branch (Bugs 2/5) **also** numbers a migration `0096` — if that work is being integrated too, one side must be renumbered. Do not deploy both `0096`s.
- [ ] `alembic upgrade head` on a **staging PostgreSQL 18** clone first; confirm both revisions apply.
- [ ] `alembic downgrade -2` then `upgrade head` to prove 0096/0097 are reversible (0097 drops + recreates the `ck_tour_package_enq_status` CHECK — verify both directions on real PostgreSQL; the SQLite harness does not prove CHECK/constraint DDL).
- [ ] Both migrations are **additive** (a new table; three new nullable columns + a widened CHECK). No data backfill, no destructive change.

## P2.3 New settings (Bug 1) — all optional, safe defaults

```
# SMS — OFF by default. Nothing sends a live SMS until sms_enabled=true.
SMS_ENABLED=false
SMS_PROVIDER=console            # console (log-only) | http (generic gateway)
SMS_SENDER_ID=JKPOTS
# only for SMS_PROVIDER=http:
SMS_HTTP_URL=                   # gateway endpoint
SMS_HTTP_API_KEY=               # bearer token — never logged, never sent to the browser
SMS_HTTP_TO_FIELD=to
SMS_HTTP_BODY_FIELD=message
SMS_HTTP_SENDER_FIELD=sender

# Booking-confirmation outbox
BOOKING_CONFIRMATION_ENABLED=true
BOOKING_CONFIRMATION_SWEEP_ENABLED=true
BOOKING_CONFIRMATION_SWEEP_INTERVAL_MINUTES=1
BOOKING_CONFIRMATION_BATCH_SIZE=100
BOOKING_CONFIRMATION_MAX_ATTEMPTS=5
```

- **Email** reuses the existing SMTP config. With SMTP unset, confirmation emails are recorded `suppressed` (a logged non-event), **never falsely `sent`**.
- **SMS** stays off until `SMS_ENABLED=true` **and** a provider is configured. Leave it off until a gateway account exists.
- The outbox sweep is a bare asyncio loop like the completion/payment sweeps; `BOOKING_CONFIRMATION_SWEEP_ENABLED=false` disables it (rows still queue; nothing sends).

## P2.4 Bug 3 — RBAC
- [ ] The new permission `tour_package.enquiry.manage` is granted to **ADMIN** in code (`rbac._ADMIN`). No DB seeding is required (permissions are role-derived + per-user `users.permissions`); to grant an individual non-admin, add the code to their `users.permissions` array.
- [ ] SUPER_ADMIN does **not** hold it by design (a granular operational grant, same as the Gaming desk) — confirm the desk operators who need it have the ADMIN role or the explicit code.

## P2.5 Pre-deploy verification
- [ ] Phase 2 backend tests green (`PHASE1_TEST_RESULTS.md` Phase 2 section) — 35 passed.
- [ ] Frontend: `node frontend/tests/admin-tour-package-enquiries.test.js` → PASS.
- [ ] `alembic upgrade/downgrade` on staging PostgreSQL 18 (P2.2).
- [ ] Code review of the Phase 2 commit.

## P2.6 Manual smoke (post-deploy)
- [ ] Pay for a flight/hotel/package end-to-end → booking CONFIRMED; a `customer_booking_notifications` row is written per channel; with SMTP live the confirmation email arrives; the row reads `sent` (or `suppressed` if SMTP/SMS off), never a false `sent`.
- [ ] Admin portal → **Tour Package Enquiries**: the queue lists submissions; filter by status and search work; open one → change status, assign to self (a NEW row moves to ASSIGNED), add an internal note, Save; the History panel shows the change with the actor and transition.
- [ ] Submit the Contact Us "Enquire about dates" form → still returns a `TPE-…` reference and appears in the admin queue as NEW (public path preserved).

## P2.7 Rollback
- **Frontend:** redeploy the previous admin bundle; revert the `?v=` token.
- **Backend:** redeploy the previous image / `git revert` the Phase 2 commit and restart.
- **Migrations:** `alembic downgrade` by two revisions removes 0097 then 0096 (both reversible; 0097 restores the original three-value status CHECK — safe only while no enquiry has moved to a new status, the normal precondition for reverting an unused feature).
- **Kill switches without a rollback:** `BOOKING_CONFIRMATION_ENABLED=false` (stop queuing confirmations), `BOOKING_CONFIRMATION_SWEEP_ENABLED=false` (stop sending), `SMS_ENABLED=false` (stop SMS only).
