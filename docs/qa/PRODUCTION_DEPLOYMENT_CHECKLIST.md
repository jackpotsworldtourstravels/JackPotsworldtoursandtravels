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
