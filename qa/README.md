# QA — Stage 2 Application Inventory

Generated 2026-11-04 by static, read-only extraction of the repository. No application
code was changed. Coverage mapping is **best-effort** (router/tag → observed test files)
and is clearly labelled where it is an inference rather than a verified run.

## Deliverables in this folder

| File | What it is |
| --- | --- |
| `inventory.json` | Machine-readable master inventory: 400 endpoints, 45 pages, test suites, coverage rollup. |
| `COVERAGE_MATRIX.md` | Readable feature-area × test-layer × status matrix (PASS/PARTIAL/BLOCKED/GAP/NOT TESTED). |
| `PAGE_COMPONENT_API_MAP.md` | Pages/portals → UI components → API endpoints. |
| `WORKFLOW_INVENTORY.md` | Customer, admin and merchant end-to-end business workflows. |
| `EXISTING_COVERAGE.md` | Every existing test file and what it covers, across all suites. |
| `MISSING_COVERAGE.md` | The real gaps: 48 untested endpoints + 213 fast-test gaps + missing tooling. |
| `PLAYWRIGHT_VISUAL_ARCHITECTURE.md` | Proposed Playwright + visual-regression architecture (Stage 3, not yet built). |
| `LOCAL_ENV_SETUP_PLAN.md` | Option-A isolated PostgreSQL env: creation, migration, seed, cleanup. |

## Headline numbers (verified by extraction)

- **400** API endpoints across **61** routers (GET 204 / POST 145 / PATCH 24 / PUT 14 / DELETE 13).
- **45** HTML pages; **194** JS files. Admin/merchant/manager/super-admin/operations are **SPA shells**
  (one `index.html` + many JS view modules), so the *page* count understates the UI surface.
- **94** Alembic migrations (head `0093_traveller_middle_name`).
- Existing tests (all green at baseline):
  - **32** pytest files / **1103 passed** (SQLite shim, fast).
  - **19** node:test files / **14 + 155 passed**.
  - **23** CDP browser UI files (not in CI; visual/responsive).
  - **51** `verify_*.py` E2E scripts (need a live server + seeded DB → **BLOCKED** until Option-A env).
  - **2** locust load files (staging only), **1** CI with 3 jobs.

## Coverage rollup (endpoint-level, best-effort)

| Status | Endpoints |
| --- | --- |
| Unit + E2E | 119 |
| Unit only (fast) | 20 |
| E2E only (needs live server) | 213 |
| **No mapped test (GAP)** | **48** |

## Method & honesty notes

- Endpoints were parsed from `@router.*` decorators via AST; paths = router `prefix` + route path.
- Auth role is the auth dependency detected on the signature (`get_current_customer`,
  `get_current_admin`, `require_role`, RBAC `require(P…)`); where only `get_db` was present
  the portal is inferred from the path prefix. This is an inventory signal, **not** a security
  audit of each route.
- `verify_*` E2E coverage is counted as "covered" only in the sense that a script exercises that
  area; those scripts have **not been executed in this session** (no live backend), so their
  current pass/fail is unknown and marked BLOCKED.
