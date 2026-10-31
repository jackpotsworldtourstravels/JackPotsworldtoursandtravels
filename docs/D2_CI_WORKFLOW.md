# D2 — GitHub Actions CI Workflow

**Date:** 2026-10-31 · **Branch:** `claude/jackpotsworld-competitor-audit-7fe581`
**Scope:** Prepared workflow file only. Not committed, not pushed, no repo settings changed.

---

## 1. Current implementation findings

- **No CI exists.** The repository has no `.github/` directory, no test step in `Dockerfile` or `render.yaml`.
- **Backend tests:** 1090 pytest tests pass on SQLite with `DATABASE_URL=sqlite:///./test.db` and `JWT_SECRET_KEY` set. Python 3.12. Dependencies in `backend/requirements.txt`.
- **Frontend tests:** 14 tests in `frontend/tests/*.test.js` (Node.js built-in `node --test` runner — no npm packages needed). All pass.
- **JS integration tests:** 155 tests in `tests/js/*.test.mjs` (same `node --test` runner). All pass.
- **No `package.json`** anywhere — the JS tests use only Node.js built-ins (`node:test`, `node:assert`, `node:fs`, `node:vm`).
- **Migrations:** 94 Alembic versions (0001 through 0093). Never tested up/down against Postgres in any automated way.

## 2. Proposed changes

### File: `.github/workflows/ci.yml`

Three parallel jobs:

| Job | Runner | What it does | Timeout |
|---|---|---|---|
| `backend-tests` | ubuntu-latest + Python 3.12 | `pip install -r backend/requirements.txt` then `pytest tests -q --tb=short -x` against SQLite | 10 min |
| `frontend-tests` | ubuntu-latest + Node 22 | `node --test frontend/tests/*.test.js` + `node --test tests/js/*.test.mjs` | 5 min |
| `postgres-migrations` | ubuntu-latest + Python 3.12 + Postgres 16 service | `alembic upgrade head` → `alembic downgrade -1` → `alembic upgrade head` | 10 min |

**Security:**
- No real secrets are needed. The SQLite job uses synthetic env vars (`ci-test-secret-key-…`).
- The Postgres job uses a throwaway service container with hardcoded `ci_user` / `ci_pass` — these are not secrets, they exist only for the duration of the job and are destroyed when it ends.
- No payment provider credentials, no AWS keys, no production URLs appear anywhere in the workflow.
- `concurrency` cancels in-flight runs on the same ref to avoid wasted minutes.

**What it does NOT do:**
- Does not change branch protection rules or required-check settings (you asked me not to).
- Does not deploy anything.
- Does not run the `tests/verify_*.py` integration scripts (those require a running server and provider credentials).
- Does not run the browser-based `tests/js/browser/*.test.mjs` tests (those require a running server).

## 3. Files affected

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | **New** — the entire CI configuration |

No existing file is modified.

## 4. Security and operational risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Synthetic secrets in workflow visible in logs | Low | Low | `DATABASE_URL` and `JWT_SECRET_KEY` contain no real values; `--tb=short` limits traceback output |
| Postgres service container credentials in workflow YAML | N/A | None | Throwaway container, destroyed when job ends; not a real database |
| CI run takes too long | Low | Low | Timeouts set; `cancel-in-progress` avoids queuing |
| Workflow passes but production breaks | Medium | Medium | This CI covers logic, migrations, and JS; it does not cover live-server integration or production Postgres |

## 5. Test plan and results

**The workflow itself is the test plan.** Once pushed and run:
- Backend: all 1090 tests should pass (they do locally, verified this session).
- Frontend: all 14 + 155 JS tests should pass (verified locally this session).
- Postgres: `upgrade head` should succeed; `downgrade -1` (from 0093 to 0092) should succeed; `upgrade head` again should succeed.

**Local verification this session:**
- `pytest backend/tests -q -x` → 1090 passed (SQLite)
- `node --test frontend/tests/*.test.js` → 14 pass
- `node --test tests/js/*.test.mjs` → 155 pass
- Postgres up/down: **not tested** (Docker daemon is installed but not running on this machine)

## 6. Rollback strategy

Delete `.github/workflows/ci.yml`. No other file was changed.

## 7. Decisions requiring your approval

| ID | Decision | Recommendation |
|---|---|---|
| CI1 | **Commit and push** this workflow to the current branch so it runs on the next PR? | Yes — it is purely additive |
| CI2 | After verifying it passes, **enable "Require status checks to pass before merging"** on `main` for these three jobs? | Yes, but this is a repo-settings change you said to skip for now |
| CI3 | Add the `tests/verify_*.py` integration tests to CI later (requires server + mocked providers)? | Yes, as a follow-up — separate workflow with Docker Compose |
