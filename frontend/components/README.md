# `components/`

Reusable UI helpers shared across portals.

| File | Status |
|---|---|
| `toast.js` | Real — extracted from `assets/js/app.js` (existed there since before this restructure), now loaded by all four portals |
| `spinner.js` | New — a small loading-spinner helper, additive; existing "Loading…" text placeholders throughout the app are untouched |
| `confirm-dialog.js` | New — a promise-based themed confirmation dialog built on the exact `.modal-overlay`/`.modal-card` markup already used everywhere (e.g. Super Admin's Sign Out confirmation); additive, existing native `confirm()`/`alert()` calls are untouched |

## Why there's no `navbar.html`, `sidebar.html`, or `footer.html`

Each portal's navbar/sidebar is not a standalone piece of markup — it's
wired directly into that portal's own state: the theme toggle, the
notification bell polling, JWT-based user display, section-switching
(`data-section` click handlers), and (for Admin/Partner) breadcrumb
updates. Extracting it into a separate `.html` partial loaded via
`fetch()` would mean either duplicating all of that wiring in a second
place or introducing a new load-order dependency between the partial and
the portal script that references it — real behavior risk for a job
scoped to "reorganize, don't rewrite."

Each portal's sidebar/topbar markup stays where it is, in
`index.html` / `admin/index.html` / `merchant/index.html` /
`super-admin/index.html`. If a future task wants to unify them,
that's a genuine UI rewrite (matching markup + behavior across all four
first) — a separate, deliberate piece of work, not a byproduct of a folder
reorganization.
