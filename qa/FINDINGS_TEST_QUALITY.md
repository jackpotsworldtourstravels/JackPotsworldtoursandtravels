# Stage-3 Test-Quality Findings & Remediation Plan

Investigation only — no files modified, no app code changed, no dependency installed, no commit/push,
full 48-script suite NOT run. The two verified fixes (month-validation, A2 interpret-body) and their
regression tests are preserved. The three M9 scripts were executed **standalone** (read-only, no
server/DB) purely to assess readiness.

Summary verdict: **none of these five is an application defect.** Four are test-side quality issues and
one (TrustBrick) is an environment/optional-dependency limitation.

---

## A1 — `verify_assistant` expects 401, app returns 403 for a missing bearer

### Evidence
- Both bearer schemes use `HTTPBearer()` with `auto_error=True`: `auth/deps.py:20` (staff/merchant) and
  `auth/customer_deps.py:31` (customer). FastAPI's `HTTPBearer(auto_error=True)` returns **403 "Not
  authenticated"** when the `Authorization` header is **absent**.
- The **401** path is reserved for a *present but invalid* credential: `_unauthorized(...)` →
  `HTTP_401_UNAUTHORIZED` (`deps.py:27`, `customer_deps.py:36`), raised inside handlers for a bad/expired
  or wrong-audience token.
- The rest of the suite already encodes this split correctly:
  - **Missing token:** `verify_cr2.py:287` → `check("no token at all -> 401/403", status in (401,403))`.
  - **Present-but-invalid token:** `verify_customer_portal.py:355/359/365/387` and `verify_cr2.py:84`
    assert `== 401` — and all passed, because those send a real-but-wrong token (403 is only for the
    *missing* header).
- `verify_assistant.py:109,118` are the outliers: they assert a hard `== 401` for a **missing** token.

### Shared contract (the app's actual, consistent behaviour)
> Missing/omitted `Authorization` header → **403** (framework `HTTPBearer`). Present but
> invalid/expired/wrong-portal token → **401** (handler). This holds across every authenticated router.

### Verdict & recommendation: **update the TEST, not the app**
The application is internally consistent and matches a well-known FastAPI convention; `verify_cr2`
already models it. `verify_assistant` is simply stricter than the contract. Changing the app would mean
replacing `HTTPBearer()` with a custom 401-returning subclass in **both** schemes — a cross-cutting
change affecting every authenticated endpoint and many passing tests — for a cosmetic status difference.
- **Recommended:** relax `verify_assistant.py:109` and `:118` to `status_code in (401, 403)`
  (mirroring `verify_cr2.py:287`). Test-only; no app change.
- **Not recommended now:** app-wide 401 normalisation (large, separate decision if the team wants
  RFC-7235-strict 401s everywhere).

---

## B — `verify_live_chat` concurrent-open: non-deterministic `len(results) == 2`

### Evidence (`verify_live_chat.py:160‑204`)
Two threads, barrier-synced, each call `chat.get_or_create_conversation(db, cid)` then
`results.append(conv.conversation_id)`. Threads are joined with `t.join(timeout=20)` and then the test
asserts `len(results) == 2`. The service (`customer_chat_service.py:82‑112`) is correct: insert, and on
`IntegrityError` rollback + re-select the winner's row — it **always returns a conversation or raises**.
Under Postgres the losing INSERT blocks on the winner's row lock until the winner commits; the loser then
rolls back, re-selects, and appends. The failing run showed `results == [7]` (one append) while
"neither raised", "same conversation", and "exactly one live row" all **passed** — i.e. the loser hadn't
finished appending when the assertion ran after a bounded `join`.

### Verdict & recommendation: **deterministic test improvement only; do not weaken any guarantee**
The DB uniqueness (`uq_customer_conversation_live`) and single-winner assertions stay exactly as they are
— they are the real contract and they passed. The only change is to remove the assertion-vs-thread race:
- **Recommended:** join both threads **without a timeout** (or loop-join until `not t.is_alive()`), then
  assert — so both appends are guaranteed complete before `len(results) == 2` is checked. Keep the
  barrier (it forces the true race) and keep all three integrity checks unchanged.
- Optionally assert `not any(t.is_alive() for t in threads)` before the results check, surfacing a real
  hang as an explicit failure rather than a misleading `len != 2`.
- This removes flakiness without touching application concurrency logic or the unique index.

---

## M9 — three unregistered scripts: ready for inclusion?

### Evidence — executed standalone (read-only, no server/DB), current tree
| Script | Mutating calls | Needs server | Result |
| --- | ---: | --- | --- |
| `verify_image_assets.py` | 0 | No (files+code; `--live` optional) | **exit 0** — `OK: 0 failures, 4 warnings` |
| `verify_open_graph.py` | 0 | No (reads static HTML) | **exit 0** — PASS, 19 pages |
| `verify_structured_data.py` | 0 | No (reads static HTML) | **exit 0** — PASS, 19 pages |

They are the same class as the already-registered, passing `verify_footer.py` / `verify_canonical.py`
(static SEO/asset invariants), are strictly read-only, and are green now.

### Verdict & recommendation: **ready — register all three in `run_all.py`'s SUITE**
Adding them (a `run_all.py`/test-infra change, deferred until approved) makes the suite 51/51 registered
and, as a direct consequence, makes **`verify_m9` pass** (its sole failure is this registration gap).
- Notes for the edit: `verify_image_assets` emits informational WARNs (still exit 0) and has an optional
  `--live` mode; register it in its default no-server mode, matching the other static scripts. Place the
  three next to `verify_footer`/`verify_canonical` in SUITE and in `docs/BOOKING_OPS_MILESTONES.md` §4.

---

## M1 — `verify_m1` Windows encoding crash

### Evidence
`verify_m1` failed with `UnicodeEncodeError: 'charmap' codec can't encode character '→'` raised from
`tests/config.py`'s `Checker.__call__` → `print(f"  {'PASS'/'FAIL'}  {name}{suffix}")`, after **36
checks had passed, 0 failed**. The check *name* contains a `→` (U+2192). On Windows, Python's default
stdout encoding is cp1252, which cannot encode `→`; `run_all.py` captures each child's stdout via a pipe
(also cp1252-encoded), so the child crashes on the `print` and exits non-zero → `run_all` records FAIL.
This is identical in cause to the `✓/✗` issue already worked around in `qa/scripts/check_db_safety.py`.

### Verdict & recommendation: **test-environment (Windows console) issue; not an app or test-logic defect**
- **Recommended (smallest, zero code):** run the suite with `PYTHONUTF8=1` (or
  `PYTHONIOENCODING=utf-8`) in the environment — Python then encodes stdout as UTF-8 and the `→` prints
  fine. Fixes M1 and any other non-ASCII check label, on Windows only (CI/Linux is already UTF-8).
- **Recommended (durable, one line, test-infra):** `sys.stdout.reconfigure(encoding="utf-8",
  errors="replace")` at the top of `tests/config.py` (and/or `run_all.py`), so the suite is robust
  regardless of the launcher's locale. Deferred until approved.
- No application change; the booking-ops behaviour `verify_m1` checks was passing.

---

## TrustBrick — optional dependency + sandbox limitation (no install)

### Evidence
- `verify_trustbrick_payments.py` builds a `starlette.testclient.TestClient` (line 696). Per
  `tests/README.md`, Starlette imports **`httpx2`** first for the TestClient and only falls back to
  `httpx` with a deprecation warning; when `httpx2` is **absent the TestClient raises at construction**,
  so this one script **fails rather than skips** (the other optional-dep scripts skip).
- The script stands up an in-process mock partner server and points `settings.trustbrick_base_url` at it
  (lines 584‑630); the run showed `TrustBrick timed out: POST /api/partner/v1/payments` — the adapter
  could not reach that mock because the TestClient-based mock never came up (no `httpx2`). **No external
  or production endpoint was contacted** — `trustbrick_base_url` defaults to `None` (dormant) and the
  intended target was the local mock.
- Config confirms TrustBrick is dormant by default: `trustbrick_base_url/key_id/secret/callback_secret =
  None` (`config.py:253‑264`), `trustbrick_timeout_seconds = 20.0`.

### Verdict & recommendation: **environment/optional-dependency limitation; remains BLOCKED (not a defect)**
- To execute it later (only if approved): `pip install httpx2` in the **test** environment (never in
  `backend/requirements.txt` — a test client must not ship to production), which restores the in-process
  mock so the script runs fully offline. No live TrustBrick sandbox or credentials are required for the
  script's own mock-based checks; the real adapter stays dormant.
- Leave as a documented, intentionally-skipped item until the team approves adding the test-only dep.

---

## Proposed remediation plan (all test-side / environment; await approval before any change)

| # | Item | Change | Scope | Risk |
| --- | --- | --- | --- | --- |
| 1 | **M9** | Register the 3 read-only SEO/asset scripts in `run_all.py` SUITE (+ docs §4) | test-infra | low — also flips `verify_m9` to PASS |
| 2 | **M1** | Set `PYTHONUTF8=1` for suite runs, and/or `sys.stdout.reconfigure(utf-8)` in `tests/config.py` | env / test-infra | low |
| 3 | **A1** | Relax `verify_assistant.py:109,118` to `in (401,403)` (match `verify_cr2:287`) | test-only | low |
| 4 | **B** | Join both threads without timeout before asserting `len==2`; keep all integrity checks | test-only | low — removes flake, no guarantee weakened |
| 5 | **TrustBrick** | Document as optional-dep BLOCKED; optionally add `httpx2` to a **test-only** requirements file if approved | docs / env | low |

Net effect if items 1‑4 are applied (and the two verified fixes stand): the only remaining non-pass
scripts would be `verify_payments` (SKIP by safety) and `verify_trustbrick_payments` (BLOCKED until the
test-only `httpx2` is approved) — i.e. **46 PASS / 1 SKIP / 1 BLOCKED**, with **0 application defects**
outstanding from this set.

No code was changed in this investigation. Awaiting approval before implementing any remediation item.

---

## Remediation status — APPLIED (test-side only; 2026-11-04)

Items 1–4 implemented and targeted-verified against the live `:8099` app + `jpw_qa` DB with
`PYTHONUTF8=1`; TrustBrick documented as BLOCKED (not installed). No application code changed; no auth
behaviour or rate limits changed; no schema/seed change; full 48-script suite not run.

| Item | Change | Targeted result |
| --- | --- | --- |
| 1 A1 | `tests/verify_assistant.py` — two assertions relaxed to `in (401, 403)` | `verify_assistant` **105 passed, 0 failed** |
| 2 B | `tests/verify_live_chat.py` — bounded 30s overall deadline + explicit "both threads completed" gate before `len==2`; barrier and all uniqueness/same-conversation/one-row assertions unchanged | `verify_live_chat` **161 passed, 0 failed** |
| 3 M9 | `tests/run_all.py` — registered `verify_image_assets`, `verify_open_graph`, `verify_structured_data` next to the static SEO checks | `verify_m9` **27 passed, 0 failed** (completeness holds) |
| 4 M1 | `qa/.env.qa.example` — `PYTHONUTF8=1` in the QA execution environment (no change to `tests/config.py`) | `verify_m1` **59 passed, 0 failed** (the `→` prints) |
| 5 TrustBrick | `qa/requirements-qa.txt` — documented `httpx2` as BLOCKED/optional, not installed | remains BLOCKED (unchanged) |

Both verified application fixes are preserved and untouched: month validation
(`customer_package_bookings.py` + `tests/test_package_month_validation.py`) and the A2 interpret body fix
(`routers/assistant.py` + `tests/test_assistant_interpret_body.py`).
