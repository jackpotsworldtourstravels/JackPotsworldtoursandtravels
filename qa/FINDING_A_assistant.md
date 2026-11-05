# Finding A — Partner Assistant API (`verify_assistant.py`)

Investigation only. No code changed. Evidence from `e2e_run_final.log`, source inspection, and a
live read-only probe of the running `:8099` app (current code). Two distinct sub-issues (A1, A2).

## A1 — unauthenticated requests return 403, test expects 401

### 1. Failing assertion
```
FAIL  config:    unauthenticated is refused   -- 403
FAIL  interpret: unauthenticated is refused   -- 403
```
`tests/verify_assistant.py`:
- `GET /api/assistant/config` with no token → `check(..., r.status_code == 401)`; actual **403**.
- `POST /api/assistant/interpret` with no token → expects **401**; actual **403**.

### 2. Trace
`assistant_config` / `interpret` depend on `_merchant_only` → `Depends(get_current_user)`
(`routers/assistant.py:55,72,94`). `get_current_user` uses `bearer_scheme = HTTPBearer()`
(`auth/deps.py:20`). FastAPI's `HTTPBearer(auto_error=True)` returns **403 "Not authenticated"**
when the `Authorization` header is **missing**. The module's 401 helper (`auth/deps.py:27`) is raised
only for a *present but invalid* token.

### 3. Expected vs actual
- Test expects 401 for a missing credential (RFC 7235 semantics).
- App returns 403 (FastAPI `HTTPBearer` default). Live-confirmed: `config no-auth -> 403 {"detail":"Not authenticated"}`.

### 4. Verdict: **outdated / overly-strict test expectation** (not an assistant defect)
The 403-on-missing-bearer behaviour is a **FastAPI framework default used app-wide** via `HTTPBearer()`,
not something specific to the assistant. The app does distinguish missing-header (403, framework) from
bad-token (401, handler). 401 would be the more correct status, but that is an app-wide convention
question, not an assistant bug. Classed as a test-expectation mismatch.

### 5. Related code / tests
`auth/deps.py` (bearer scheme, 401 helper); every router using `HTTPBearer()` shares this behaviour.

### 6. Smallest appropriate fix
- **Preferred (test-side):** relax the two assertions to accept the app's convention —
  `r.status_code in (401, 403)` — since missing-bearer → 403 is consistent across the app. (Edits
  `tests/verify_assistant.py` only; no app change.)
- **Optional (app-wide, larger, separate task):** introduce a custom `HTTPBearer` subclass that raises
  401 on a missing header and adopt it everywhere, if the team wants RFC-correct 401s. Out of scope for
  a single-endpoint fix.

---

## A2 — `POST /api/assistant/interpret` rejects a JSON body with `422` (demands `payload` as a query param) — **GENUINE DEFECT**

### 1. Failing assertion
```
AssertionError: interpret 'what is my wallet balance': 422
  {"detail":[{"type":"missing","loc":["query","payload"],"msg":"Field required","input":null}]}
```
The test helper `interpret()` (`verify_assistant.py:80`) does a normal
`POST /api/assistant/interpret` with `json={"message","page","history"}` and a merchant token.

### 2. Trace (frontend → router → schema)
- **Frontend** `frontend/shared/merchant-api.js:1019` `assistantInterpret()` → `_req('post',
  '/api/assistant/interpret', {data:{message,page,history}})` — i.e. a real client sends a **JSON body**.
- **Router** `routers/assistant.py:89‑94`:
  ```python
  @router.post("/interpret", response_model=InterpretResponse)
  @limiter.limit(lambda: f"{settings.assistant_rate_per_minute}/minute")
  def interpret(request: Request, payload: InterpretRequest, current_user=Depends(_merchant_only)):
  ```
- **Schema** `schemas/assistant.py:15` `class InterpretRequest(BaseModel)` — a proper Pydantic v2 model
  (should be resolved as a **request body**).

### 3. Expected vs actual
- Expected: `payload` is the JSON **body**; a body POST returns 200 (or the agreed intent payload).
- Actual (live-confirmed, current code): FastAPI treats `payload` as a **required query parameter**
  → every body POST gets `422 loc:["query","payload"]`. The endpoint is effectively unusable by its
  own frontend.

### 4. Verdict: **genuine application defect**
Root cause, confirmed by differential evidence:
- `routers/assistant.py:32` has **`from __future__ import annotations`**, so `payload`'s annotation is
  the *string* `"InterpretRequest"`. FastAPI must resolve that string to the class via the function's
  globals. The `@limiter.limit` (slowapi 0.1.10) wrapper obscures that resolution, so FastAPI fails to
  recognise `InterpretRequest` as a Pydantic body model and falls back to treating `payload` as a
  scalar **query** parameter.
- **Control:** `routers/customer_auth.py` has **no** `from __future__ import annotations`; its
  rate-limited, body-taking `login` works and `verify_customer_portal`'s login checks passed. The only
  material difference is the future-import, which turns the body annotation into an unresolved string
  under the limiter wrapper.
- Versions in this env: fastapi 0.115.0, slowapi 0.1.10, pydantic 2.13.5, starlette 0.38.6. Because
  `backend/requirements.txt` pins `fastapi>=0.115` / `slowapi>=0.1.9`, production can carry the same
  combination — so this likely breaks the real merchant assistant too (its frontend posts a body).

### 5. Related code / tests
`routers/assistant.py` (future-import + limiter + body), `schemas/assistant.py`. **No backend unit test
exercises partner `interpret`** (`grep` of `backend/tests/` → none), which is why it was only caught at
the E2E layer. The `config` endpoint works because it is a GET with no body param.

### 6. Smallest appropriate fix (for approval)
- **Preferred, one line:** force body resolution explicitly, independent of annotation-string lookup:
  ```python
  from fastapi import Body
  ...
  payload: InterpretRequest = Body(...),
  ```
  This disambiguates the parameter as the request body even through the slowapi wrapper /
  future-annotations combination.
- **Alternative:** remove `from __future__ import annotations` from `routers/assistant.py` so the
  annotation is a live class object (broader; touches every annotation in the module).
- **Add a regression test:** a backend `TestClient` POST to `/api/assistant/interpret` with a JSON body
  (auth dependency overridden) asserting it is **not** 422-for-query and reaches the handler.
- **Verify-before-finalise:** confirm the chosen fix makes the live endpoint accept a body (and keeps
  the rate limiter working) before closing.

> Scope note: a fix here touches only the `interpret` endpoint signature (+ a new test). No change to
> business logic, rate limits, DB, or other endpoints.
