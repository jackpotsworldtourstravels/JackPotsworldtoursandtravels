# e2e/ — live-server end-to-end specs (Stage 4+, not yet implemented)

Planned subfolders, driven by `qa/WORKFLOW_INVENTORY.md`:
- `customer/` — C1..C10
- `admin/` — A1..A10
- `merchant/` — M-1..M-5
- `cross_portal/` — X1..X6 data-consistency

All specs use `@pytest.mark.e2e` + the `require_server` fixture, so they SKIP (not fail)
until the isolated `:8099` env is running. No specs live here yet, per Stage-3 scope.
