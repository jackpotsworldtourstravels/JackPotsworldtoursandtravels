# Issue #10 — Logout does not reset customer-owned state (wishlist / chat / profile)

**Status: RESOLVED and live-verified on the combined release candidate (2026-11-25).**
Frontend-only; **no payment code and no backend files changed.** Branch
`claude/jackpotsworld-prod-readiness-07ba10`. **Uncommitted** (no commit/push/merge per the task rules).

> Verification evidence for the surgical #10 consolidation merged into this
> prod-readiness worktree. It records the one gap that remained after this
> worktree's own #10/#17 work, the surgical fix, and the live combined-target run.

## Background — what this worktree already had (preserved, not overwritten)

This release candidate already carried an independent, newer #10/#17 implementation,
which the merge **kept intact**:

- **Issue #17 wishlist-count engine** — `wishlist.js` keeps a de-duplicated `saved`
  set, exposes `count()` and `reset()`, and fires a `wishlist:change` DOM event;
  `account-center.js setWishlistCount()` paints the Wishlist-tab badge from it.
- **Account-switch owner guard** — `acctEnsureSessionOwner()` (called when the
  Account Center opens) resets the cached profile/tabs/wishlist when the signed-in
  `sub` changes, so a different customer never inherits the previous one's view.
- **`doAccountLogout()`** already cleared tokens, cached user, `acctCacheOwner`,
  loaded tabs, `resetWishlist()` and `Wishlist.reset()`.
- **ChatOutbox** (`chat-outbox.js`, #12/#24) — offline unsent-message persistence
  wired into `live-chat.js`.

## The gap that remained (the open #10 logout defect)

The profile-dropdown Logout (`profile-menu.js logout()`) checks `AccountCenter.logout`
and, finding it **undefined**, fell through to a token-only fallback — `doAccountLogout`
was bound only to `#profileLogoutBtn` and never exposed. So signing out from the
dropdown left the wishlist badge/hearts + in-memory cache, and the customer's chat,
in place. The worktree's own matrix had already diagnosed this and named the fix.

Separately, **nothing** tore down the customer's **chat** on sign-out — the original
#10 brief required clearing customer-owned chat state, and neither `doAccountLogout`
nor the fallbacks did.

## The surgical merge (4 JS files edited + 1 new test; newer code preserved)

- **`account-center.js`** — expose `logout: doAccountLogout` on the public object
  (the diagnosed one-liner); add `LiveChat.reset()` into `doAccountLogout` after the
  existing `Wishlist.reset()`.
- **`live-chat.js`** — add `reset()` (drop socket, forget conversation + messages,
  repaint unread badge to 0, remove panel DOM, unboot) and expose it; it **deliberately
  leaves the ChatOutbox untouched** (persisted per `conversation_id`, so it neither
  breaks nor leaks across accounts). ChatOutbox integration unchanged.
- **`profile-menu.js`** — the Account-Center-less fallback now also calls
  `Wishlist.reset()` + `LiveChat.reset()`.
- **`app.js`** — the auth-nav "Sign Up"-slot sign-out fallback now also calls
  `Wishlist.reset()` + `LiveChat.reset()`.
- **`wishlist.js`** — **not changed**; its existing `reset()` (count-aware) already met
  the need and was preserved.
- **New test:** `frontend/tests/logout-clears-customer-state.test.js`.

Every logout entry point now routes through one shared teardown that clears:
(1) auth tokens/session, (2) wishlist in-memory state + count, (3) wishlist badge/hearts
(reset, not hidden), (4) cached profile + account tabs, (5) customer chat — while the
ChatOutbox and the #17 count engine are preserved.

## Live verification on the COMBINED target (real backend on :8012, shared local dev DB, dev-OTP)

All logouts actuated via the **real profile-dropdown Logout control**.

**Landing/flights page — Customer A signed in, chat mounted:**
- after Logout: `jpc_access`/`jpc_refresh` absent, name null, `.lc-root` 1→0,
  `LiveChat.isSignedIn()` false, **ChatOutbox still loaded**, nav signed-out.

**hotels.html — Customer A, Wishlist module active:**

| Signal | Before | After real-dropdown Logout |
|---|---|---|
| wishlist count badge (`Wishlist.count()`) | **2** | **0** |
| `wishlist:change` event on reset | — | **fires `0`** |
| filled hearts (`.wl-btn.is-on`) | 3 | **0** |
| `Wishlist.has('hotel',2)` / `('package',1)` | true | **false** |
| chat DOM (`.lc-root`) | 1 | **0** |
| `ChatOutbox` loaded | true | **true (preserved)** |
| `localStorage.jpc_access` | present | **absent** |

**Account switch A→B (hotels.html):** as A, count 1 + Account Center opened (owner=A);
switch to B + reopen Account Center → `acctEnsureSessionOwner` resets to **count 0,
A's hearts gone, `has('hotel',2)` false**; server `GET /wishlist` for B = `[]` (A's row
stays A's) — in-memory **and** server-side isolation hold. Account switching works.

## Tests (combined target)

- `node --test frontend/tests/*.test.js` → **27 passed, 0 failed** (incl. new logout test + `wishlist-count.test.js`).
- `node --test tests/js/*.test.mjs` → **157 passed, 0 failed**.
- Backend `pytest` (SQLite, `fastapi==0.122.0` pinned, DB-guard isolated) → **2953 passed, 33 skipped, 0 failed**.
- Alembic on disposable **PG18**: `0099→0100→0101` up, `0101→0100` down, `0100→0101` re-up — clean; single head `0101`.
- `node --check` on all four edited JS files → OK.

## Not claimed

HDFC live UAT and live-agent attachment delivery (#13) are **not** exercised here and are **not** claimed as verified.
