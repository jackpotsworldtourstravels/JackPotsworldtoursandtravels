# Proposed Playwright & Visual-Testing Architecture — Stage 2 (design only)

**Nothing here is built yet and no dependency is installed** — this is the proposal to review before
Stage 3. It is designed to *extend*, not replace, the existing CDP, pytest and node suites.

## Decision: Python Playwright (`pytest-playwright`)

Rationale (matches your "reuse existing conventions" requirement):
- The backend test environment is already Python/pytest (1103 tests). Python Playwright lets UI E2E
  share the same runner, fixtures, seeded-DB setup, reporting and CI job as the API tests.
- The existing CDP browser suite (`tests/js/browser/`) **stays as-is** — it is fast, Chromium-only,
  and already encodes hard-won layout/CLS knowledge. Playwright adds cross-browser + visual baselines
  **alongside** it, not over it. We do not port or delete CDP tests.
- A single language for API-seed + UI-drive makes the cross-portal consistency tests (Phase-7) far
  simpler: one test can create data via the API and assert it in the UI.

## Directory layout (new, additive)

```
qa/
  playwright/
    conftest.py              # base fixtures: base_url, seeded roles, per-test DB reset hook
    pages/                   # page objects (BookingCard, LoginForm, AdminShell, MerchantShell, ...)
    fixtures/                # test data builders that call the API (reuse tests/flows.py patterns)
    e2e/
      customer/              # C1..C10 workflows
      admin/                 # A1..A10
      merchant/              # M-1..M-5
      cross_portal/          # X1..X6 consistency
    visual/                  # screenshot-baseline specs (opt-in, reviewed baselines only)
    a11y/                    # axe-core scans (Stage 8)
    __snapshots__/           # committed baseline PNGs (reviewed), per project/viewport
  playwright.config-notes.md # config rationale (the real config lands in Stage 3)
```

## Browser projects & viewports

| Project | Engine | Viewports |
| --- | --- | --- |
| `desktop-chromium` | Chromium | 1920×1080, 1440×900, 1366×768 |
| `desktop-firefox` | Firefox | 1440×900 |
| `desktop-webkit` | WebKit | 1440×900 |
| `tablet` | Chromium | 1024×768, 768×1024 |
| `mobile` | Chromium (device emu) | 430×932, 390×844, 360×800 |

Full 8-viewport sweep runs on the customer-facing pages and each portal shell; workflow E2E runs on
`desktop-chromium` + one mobile project to keep CI time bounded.

## Selector & stability strategy

- Prefer role/label/text selectors (`get_by_role`, `get_by_label`) and add `data-testid` **only where
  a stable hook is missing** — proposed as a tiny, reviewed, non-behavioural frontend change in Stage 3
  (attributes only, no logic), never auto-applied.
- Reuse `tests/flows.py` + `tests/config.py` account model for seeding and sign-in so UI tests and the
  `verify_*` suite share one source of truth for test data.

## Visual regression

- `expect(page).to_have_screenshot()` with per-project/per-viewport baselines in `__snapshots__/`.
- **Baselines are created only from a reviewed, approved UI state** (your Phase-3E requirement) — the
  first run is proposed in a PR, a human approves the PNGs, and only then do they become the baseline.
  We never treat an arbitrary current render as "correct".
- Masking for known-dynamic regions (dates, prices, live availability) to avoid false diffs.
- Diff artifacts (expected/actual/diff PNG) uploaded on failure.

## Accessibility & performance hooks (wired now, populated Stage 8)

- `qa/playwright/a11y/` runs `axe-core` via the Playwright page on each route; violations recorded with
  page + element + rule id.
- Lighthouse runs separately (Node) against the same seeded server; LCP/CLS/INP thresholds as warnings
  first, gates later.

## CI integration (Stage 15, proposed)

- New job `ui-e2e` (after `backend-tests`): boots the app against the throwaway Postgres service
  container, seeds via Alembic, runs Playwright, uploads traces/videos/screenshots as artifacts.
- `desktop-chromium` + `mobile` on every PR; Firefox/WebKit + full visual sweep nightly/on-label to
  keep PR latency low.
- Existing 3 CI jobs are untouched.

## Reporting

- Playwright HTML report + JSON; merged by the Stage-9 aggregator with pytest-json, node TAP, axe JSON
  and Lighthouse JSON into one `qa/report/index.html` + `qa/report/results.json` and the coverage matrix.

## Explicitly out of scope (per your constraints)

- No Duffel/Hotelbeds activation — flight/hotel UI tested against existing demo/seeded data only.
- No real payments/OTP/refunds/emails — sandbox/dev-echo only.
- No production targets — everything runs against the local isolated env.
