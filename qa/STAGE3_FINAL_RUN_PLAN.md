# Plan — One Final Seeded E2E Run (for approval; NOT executed)

Prepared 2026-11-04. This document is a plan only. Nothing here has been run. It covers the single
remaining action: one complete seeded E2E run against the isolated DB, to measure the true post-seed
pass rate. Guardrails: only `localhost:5435/jpw_qa`; payments skipped; **no** `httpx2`; no production
or external payment contact; no application/test code changes.

## Validation gaps — resolved (read-only)

1. **`15/48` vs `14 PASS + 33 FAIL + 1 MISSING`.** `run_all.py` line 285 prints
   `len(results) - failed` / `len(results)`. A MISSING/skip entry is stored as `code=None` and is **not**
   counted in `failed`, so it falls into the "passed" numerator. 48 − 33 = **15** = 14 real PASS +
   1 safety-MISSING (`verify_payments`). The two statements are the same data; no discrepancy.
2. **48 verdicts re-verified** against the final summary block of `e2e_run2.log`: exactly 14 PASS,
   33 FAIL, 1 MISSING (full list in `qa/STAGE3_FINAL_REPORT.md` §2).
3. **Seeded accounts (via `backend/scripts/seed_account.py`, into `jpw_qa` only):**
   - `priya.raghavan@jackpotsworldtours.com` — role **admin**
   - `ops.desk@jackpotsworldtours.com` — role **admin**
   - `manager.desk@jackpotsworldtours.com` — role **manager**
   **Merchant used (not created):** the already-seeded **Aurora** merchant_admin
   `jackpotsworldtours.travels@gmail.com` (merchant_id 1), referenced via env override
   `JPW_MERCHANT_EMAIL`/`JPW_MERCHANT_PASSWORD` (the Aurora seed password from migration 0023 — not
   reproduced here). `other_merchant` is satisfied by the second
   seeded merchant, Blueline (merchant_id 2). SUPER = `admin@jackpotsworldtours.com` (migration seed).
   All 5 logins were verified working at seed time (correct role/portal).
4. **Sufficiency for all 48 — partial.** The 3 staff + Aurora override are sufficient to get **past login**
   for all 31 account-blocked scripts and to satisfy the "two different merchants" requirement. They are
   **not** sufficient for two scripts by design:
   - `verify_trustbrick_payments` needs optional `httpx2` (Starlette TestClient) + a live TrustBrick
     sandbox — both excluded → expected to stay **BLOCKED**.
   - `verify_m9` requires the 3 unregistered scripts to be in `run_all.py`'s SUITE → expected to stay
     **FAIL** until that (separate) change is approved.
   `websockets` is optional for the socket sections of `verify_live_chat` / `verify_voice_calls` /
   `verify_call_management`; without it those sections skip (exit 0). So the realistic post-seed outcome is
   **~45/48**, with 3 known residuals (payments SKIP-safety, trustbrick BLOCKED, m9 FAIL). This is an
   expectation, not a guarantee — some scripts may surface second-order issues once past login; any such
   finding will be reported honestly, not masked.
5. **Why Docker/app are stopped.** Read-only checks: no Docker Desktop/`dockerd` process running (engine
   DOWN), `:8099` and `:5435` not listening. The app was a session-scoped background process that ended
   with the previous session; Docker Desktop was closed between sessions (machine/app shutdown). **Not**
   caused by any QA action — the teardown script was never run. The container `jpw_qa_pg` was created
   without `--rm`, so it should still exist **stopped** with migrated+seeded data intact (unverifiable
   while the engine is down).
8. **The 3 unregistered scripts** are `verify_image_assets.py`, `verify_open_graph.py`,
   `verify_structured_data.py` (51 on disk, 48 in SUITE). **Recommendation: yes, add them** — they are
   real SEO/asset checks and `verify_m9` exists specifically to assert they are registered, so their
   absence is a genuine (pre-existing) suite gap. **But not as part of this run:** adding them edits
   `run_all.py` (changes what the suite *is*), which is out of scope for "do not run/modify yet". Propose
   it as a separate, small, reviewed change after the final run, so this run measures the suite as-shipped.

## The plan (to run only on approval)

### Prerequisites (need your action / go-ahead)
- **P1. Start Docker Desktop** (engine is down; I will not start it without your OK). This is the only
  non-QA prerequisite.

### Pre-flight — all safety-gated, fail-closed
- **S1.** `docker start jpw_qa_pg` (resume the existing stopped container — keeps the seeded data).
  - If the container no longer exists, fall back to `bash qa/scripts/start_test_env.docker.sh` (recreates
    on 5435, re-migrates, re-seeds base data) **and** re-seed the 3 staff accounts (step S4).
- **S2.** Confirm container identity: name `jpw_qa_pg`, published **5435→5432**, DB `jpw_qa`, user `jpw_qa`.
- **S3.** Run `python qa/scripts/check_db_safety.py` with the run env — **must exit 0** (local host,
  disposable name, no prod markers; refuses `DEPLOYED=true`/`PAYMENT_PROVIDER!=none`) before anything
  touches the DB.
- **S4.** Verify the 5 role logins (SUPER/ADMIN/ADMIN2/MANAGER/MERCHANT). Re-seed only if S1 fell back to a
  fresh container (via `seed_account.py`, same 3 staff; Aurora override for merchant). No account overwritten.

### Environment (identical to run 2, isolated)
```
DATABASE_URL=postgresql+psycopg2://jpw_qa:jpw_qa_local@localhost:5435/jpw_qa
JWT_SECRET_KEY=qa-local-only-not-a-secret-0123456789abcdef
DEPLOYED=false  DEBUG=true  PAYMENT_PROVIDER=none  PAYMENT_ENVIRONMENT=test
OTP_DEV_ECHO=true  STORAGE_BACKEND=local  OCR_PROVIDER=none  WEB_CONCURRENCY=1
FRONTEND_BASE_URL=http://127.0.0.1:8099  CORS_ORIGINS=http://127.0.0.1:8099,http://localhost:8099
JPW_BASE=http://127.0.0.1:8099  JPW_QA_BASE=http://127.0.0.1:8099
JPW_MERCHANT_EMAIL=jackpotsworldtours.travels@gmail.com  JPW_MERCHANT_PASSWORD=<Aurora seed pwd, migration 0023>
```

### Boot + run
- **R1.** Boot the app: `uvicorn app.main:app --host 127.0.0.1 --port 8099 --no-access-log` (background).
- **R2.** Health-gate: poll `GET /api/health` until `{"status":"ok"}`.
- **R3.** One run: `python tests/run_all.py` → capture to `scratchpad/e2e_run_final.log`.
  - `verify_payments` self-skips (safety) — kept skipped.
  - `httpx2` **not** installed → `verify_trustbrick_payments` expected BLOCKED.
  - `run_all.py` **not** modified → `verify_m9` expected FAIL.
- Runtime ~10–15 min (login rate-limit backoff, 10/min/IP shared) — run in background.

### Post
- **A1.** Parse `e2e_run_final.log` into PASS/FAIL/SKIP/BLOCKED + a before→after delta vs run 2.
- **A2.** Report every verdict with root cause; distinguish environment vs genuine application defect.
- **A3.** Teardown when finished: stop app; `docker stop jpw_qa_pg` (keep data) or
  `bash qa/scripts/stop_test_env.docker.sh` (destroys the container). Your choice.

## Safety constraints honored throughout
- Only `localhost:5435/jpw_qa`; safety gate blocks anything else. Other project DBs (5433/5434) untouched.
- Payments skipped; `PAYMENT_PROVIDER=none`; **no** real payment/refund; **no** `httpx2` install.
- No production or external payment-service contact; Duffel/Hotelbeds dormant.
- No application or test code changed; no migration beyond `upgrade head`; no commit/push/deploy.
