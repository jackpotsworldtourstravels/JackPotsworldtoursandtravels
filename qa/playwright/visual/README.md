# visual/ — screenshot visual-regression (Stage 4, not yet implemented)

`@pytest.mark.visual` specs using `expect(page).to_have_screenshot()`. Baselines are created
ONLY from a reviewed, approved UI state (Stage 2 §Phase-3E) and committed under `__snapshots__/`.
No baselines exist yet — creating them without review would wrongly bless the current render.
