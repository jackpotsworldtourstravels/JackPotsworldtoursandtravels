# Sprint Verification Matrix — Release Candidate (phases 1–3)

**Branch:** `claude/jackpotsworld-prod-readiness-07ba10` (main `85993bb` + consolidated sprint fixes + UI/UX completion) · **Date:** 2026-11-25 · **State:** UNCOMMITTED.

> Full narrative, evidence and go/no-go: [`docs/qa/FINAL_RELEASE_READINESS_REPORT.md`](docs/qa/FINAL_RELEASE_READINESS_REPORT.md).
> **Status taxonomy:** **IMPL+TEST** implemented and tested · **VERIFIED** verified, no defect · **PARTIAL** partially tested · **BLOCKED-AGENT** needs a live support agent · **BLOCKED-HDFC** needs authorized HDFC UAT.

## Test gates

| Gate | Result |
|------|--------|
| Backend pytest (SQLite, `fastapi==0.122.0`) | **PASS — 2953 passed / 33 skipped / 0 failed**, exit 0 — **independently re-run 2026-11-25** (15m05s, 41 warnings on this host; pass/skip/fail counts match exactly) |
| Frontend `frontend/tests` | **PASS — 27 / 0** (incl. new `logout-clears-customer-state.test.js`) |
| Frontend `tests/js` | **PASS — 157 / 0** |
| JS total | **PASS — 184 / 0** |
| Targeted suites (HDFC + e-ticket + review + notif + resend + attachments + departures) | **PASS — 299 / 0** |
| Alembic migrations (PG18.7) | **PASS** — single head `0101`, downgrade→re-upgrade + deep `0101→0094→head`, no dup revisions |
| Browser verification (desktop + mobile), app on PG18 | **PASS** — #3/#4/#5/#8/#12/#17/#18/#24 pass; **#10 now PASSES in full** — account-switch isolation AND logout-clearing live-verified on the combined target 2026-11-25 (real profile-dropdown Logout: wishlist count 2→0, `wishlist:change` fired 0, hearts cleared, chat torn down, ChatOutbox preserved, tokens cleared; A→B switch isolates in-memory + server-side) |
| HDFC sole gateway / money-guard | **PASS** — no `services/payments/*` change; default `none`; readiness NOT READY |
| Security (SQLi/XSS/webhook/IDOR/401-403/secrets) | **PASS** — unchanged; new code adds no new surface |

## 25-issue status

| # | Issue | Status | · | # | Issue | Status |
|---|-------|--------|---|---|-------|--------|
| 1 | Round-trip / multi-segment | **IMPL+TEST** | | 14 | Enquiry acknowledgement | **VERIFIED** |
| 2 | E-ticket payment gate | **IMPL+TEST** (money: BLOCKED-HDFC) | | 15 | Mandatory traveller validation | **VERIFIED** |
| 3 | Payment-success popup contrast | **IMPL+TEST** | | 16 | Secure resend confirmation | **IMPL+TEST** |
| 4 | Group Deals button + form reset | **IMPL+TEST** | | 17 | Wishlist count sync | **IMPL+TEST** |
| 5 | Intl package departure visibility | **VERIFIED** (+2 guard tests) | | 18 | Wishlist navigation | **VERIFIED** |
| 6 | Hide Change Password | **IMPL+TEST** | | 19 | Review eligibility | **IMPL+TEST** |
| 7 | Hotel results layout | **VERIFIED** | | 20 | Review edit/delete | **IMPL+TEST** (+3 tests) |
| 8 | Notification action contrast | **IMPL+TEST** | | 21 | Notification preferences | **IMPL+TEST** (migration 0101) |
| 9 | View Ticket about:blank | **IMPL+TEST** | | 22 | Chat history persistence | **VERIFIED** |
| 10 | Account switch / stale profile | **VERIFIED** — switch + logout both fixed | | 23 | Chat ticket creation | **VERIFIED** |
| 11 | Manage-booking cancel | **VERIFIED** | | 24 | Chat offline persistence/retry/dedup | **IMPL+TEST** |
| 12 | Chat close/reopen restore | **IMPL+TEST** | | 25 | Chat message ordering | **VERIFIED** |
| 13 | Chat PDF attachments | **PARTIAL + BLOCKED-AGENT** | | | | |

**Tally:** IMPL+TEST 13 · VERIFIED 11 · PARTIAL 1 (#13 live-agent attachment delivery — BLOCKED-AGENT). Every issue addressed; **#10 logout-clearing now fixed and live-verified** (see Key fixes).

## Key fixes this phase (phase 3)

- **#3** solid `background-color` fallback on `.jpay-cta` (gradient-only → invisible in forced-colors).
- **#4 / #8** explicit navy-on-white buttons replacing the white-on-transparent `btn-ghost` → **17.26:1** (desktop + mobile).
- **#5** no defect — intl departures visible on detail/listing/booking; backend has no `is_international` gate; 2 guard tests.
- **#10** TWO parts, **both now fixed and live-verified on the combined target (2026-11-25)**: (a) **account-switch** — the JWT-`sub` identity guard (`acctEnsureSessionOwner`) resets profile/tabs/wishlist when a different customer opens the Account Center (as A: count 2 → swap to B + reopen → count 0, A's hearts/badge gone, B sees only B's rows; server `GET /wishlist` is per-customer — zero cross-leak). (b) **logout** — the former open defect is **RESOLVED** by the surgical #10 merge: `account-center.js` now exposes `logout: doAccountLogout`, so the profile-dropdown Logout runs the full `doAccountLogout` teardown. Live-verified via the **real dropdown**: wishlist count 2→0, `wishlist:change` fires 0, hearts cleared, `Wishlist.has()` false, tokens cleared. Chat teardown `LiveChat.reset()` was added to the same shared boundary (and the fallback paths) — it drops the conversation/socket/unread badge while **leaving the ChatOutbox intact** (persisted per `conversation_id`). Regression: `frontend/tests/logout-clears-customer-state.test.js`.
- **#17** unique-count engine + `wishlist:change` event + tab badge + reset on logout/switch.
- **#12 / #24** new `chat-outbox.js` — offline persistence, owner-scoped (account-switch isolation), dedup, auto-retry on reconnect — wired into `live-chat.js`.
- **#13** EXIF strip + type/size/access tested; live-agent send + WebSocket delivery NOT claimed.
- **#18 / #20** independently re-verified (not assumed): `/package-details/{id}` renders; review edit/delete IDOR-safe (+3 tests).

## Release decision

**NO-GO** — because (a) the work is uncommitted, (b) **HDFC live UAT is BLOCKED** (not claimed verified), and (c) **live-agent attachment delivery (#13) is BLOCKED** (not claimed verified). **#10 logout-clearing is now RESOLVED and live-verified (2026-11-25)** and is no longer a blocker. HDFC UAT and real-agent attachment delivery remain **not claimed** as passed. See report §9.
