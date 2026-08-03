"""Every portal screen, on a phone, in a real browser.

WHY THIS EXISTS
The backend suite is thorough and proves nothing about layout. On 2026-08-03 a
hand audit of the portals found **92 inputs under 16px** — the threshold below
which iOS Safari zooms the entire page on focus and the user has to pinch back
out to see the form they were filling in. Every one of them had been shipped,
reviewed and deployed. They are invisible to `curl`, invisible to a unit test,
and invisible to anyone testing on a desktop; the only thing that catches them
is measuring a real layout at a real phone width.

WHAT IT ASSERTS, AND WHY ONLY THESE THREE
Deliberately not a screenshot-diff: those fail on every intentional design
change and get switched off within a month. These three are objective, and a
failure is always a bug rather than a difference of opinion:

  1. The page does not scroll sideways   (scrollWidth == clientWidth)
  2. Nothing escapes the right edge      (excluding legitimate containers)
  3. No visible input reports < 16px     (the iOS zoom trigger)

THREE THINGS THAT LOOK LIKE OVERFLOW AND ARE NOT — check 2 excludes all three,
and it is worth knowing why, because a naive version of this check reports
300-800 "failures" per page and is useless:

  * Wide data tables (760-1230px here) inside an `overflow-x:auto` scroller.
    That is the correct mobile pattern, not a bug.
  * A carousel track (`.offers-track`, 3598px) clipped by an `overflow:hidden`
    parent. Hidden contains just as effectively as scroll does.
  * A closed slide-in drawer — `.ops-drawer` is `position:fixed` parked at
    `translateX(367px)` until opened.

So an element only counts as escaping if NO ancestor establishes a horizontal
overflow context. Check 1 is the backstop: whatever the per-element walk
misses, the document's own scrollWidth still tells the truth.

REQUIREMENTS, AND WHY IT SKIPS INSTEAD OF FAILING WITHOUT THEM
Needs Playwright and a served frontend. Following ``verify_storage_s3.py``,
both absences exit 0 with a printed reason so the suite still runs on a machine
with only the production dependencies::

    pip install playwright && playwright install chromium

The frontend is a separate origin from the API in local development, hence its
own variable::

    JPW_FRONTEND=http://127.0.0.1:5500 python tests/verify_responsive.py

Logged-in portals are reached by calling the real login endpoints through
``config.login`` and writing the tokens into localStorage under each portal's
own key namespace — the same thing the portals' own auth JS does. There is no
UI-driving of the sign-in form, which would make this a test of the login page
rather than of the 30 screens behind it.
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config  # noqa: E402
from config import Checker  # noqa: E402

check = Checker()

FRONTEND = os.environ.get("JPW_FRONTEND", "http://127.0.0.1:5500").rstrip("/")

#: Phone sizes worth the run time, and why each is here rather than a round
#: number: 320x568 is the narrowest phone still in use and the worst case for a
#: dense filter bar; 390x844 is a current iPhone; 932x430 is that same phone
#: turned sideways, which is a landscape case a width-only breakpoint misses
#: entirely. Windows display scaling matters more than panel size — a 1920x1080
#: monitor at 125% reports 1536x736 to CSS, and at 150% reports 1280x720.
VIEWPORTS = [(320, 568), (390, 844), (932, 430)]

#: localStorage key namespaces, one per portal. Deliberately not shared: a
#: single `jwt_*` namespace would mean signing into the Admin portal silently
#: signed you into the Merchant one in the same browser.
TOKEN_KEYS = {
    "admin": ("jwt_access", "jwt_refresh"),
    "merchant": ("partner_jwt_access", "partner_jwt_refresh"),
    "super_admin": ("super_admin_jwt_access", "super_admin_jwt_refresh"),
}

#: Reachable without a session.
PUBLIC_PAGES = [
    ("public site", "/index.html"),
    ("merchant login", "/partner-login.html"),
    ("forgot password", "/forgot-password.html"),
    ("reset password", "/reset-password.html?token=demo"),
]

#: (label, path, portal whose token unlocks it). The portals are single-page
#: apps, so one entry here becomes many screens once the nav walk runs.
PORTAL_PAGES = [
    ("admin portal", "/admin/index.html", "admin"),
    ("merchant portal", "/merchant-classic/", "merchant"),
    ("super admin portal", "/super-admin/index.html", "super_admin"),
]

#: Never click these while walking a nav — they end the session or leave the
#: app, and the rest of the walk then measures a logged-out page or a 404.
NAV_SKIP = ("sign out", "logout", "back to site", "log out")

# --------------------------------------------------------------------------
# The audit itself, as page JavaScript. Kept as one expression so it can be
# handed to evaluate() unchanged, and so the browser does the geometry — an
# element's real painted box is the only thing that settles this, and it is not
# derivable from the stylesheet.
# --------------------------------------------------------------------------
AUDIT_JS = r"""
() => {
  const root = document.documentElement;

  // An element is "contained" if any ancestor establishes a horizontal overflow
  // context. `hidden` counts: it clips exactly as effectively as `scroll` does,
  // and the carousel track relies on it.
  const contained = (n) => {
    let p = n.parentElement;
    while (p && p !== root) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      p = p.parentElement;
    }
    return false;
  };

  const visible = (n, cs) =>
    cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';

  const escaping = [...document.querySelectorAll('body *')]
    .filter((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return r.width > 0 && r.height > 0 && visible(n, cs)
        && r.right > innerWidth + 1 && !contained(n);
    })
    .map((n) => ({
      sel: (n.className || n.tagName).toString().trim().slice(0, 40),
      w: Math.round(n.getBoundingClientRect().width),
      right: Math.round(n.getBoundingClientRect().right),
    }));

  // ONLY TEXT-ENTRY FIELDS ZOOM. iOS enlarges the page when focus lands
  // somewhere the keyboard will open; a checkbox, radio, button or file picker
  // never triggers it however small its font-size is. Without this exclusion
  // the check fails on the login page's 13px "Remember me" checkbox, which is
  // a false positive — and one noisy false positive is how a suite like this
  // gets switched off.
  const TEXTUAL = new Set(['text', 'email', 'password', 'search', 'tel', 'url',
    'number', 'date', 'datetime-local', 'month', 'week', 'time', '']);

  // offsetParent is null for anything display:none or detached, which is what
  // keeps the inactive pages of a single-page app out of the count.
  const small = [...document.querySelectorAll('input, select, textarea')]
    .filter((i) => i.offsetParent !== null
      && (i.tagName !== 'INPUT' || TEXTUAL.has(i.type))
      && parseFloat(getComputedStyle(i).fontSize) < 16)
    .map((i) => ({
      tag: i.tagName,
      type: i.type || '',
      fs: getComputedStyle(i).fontSize,
      sel: (i.className || '').toString().trim().slice(0, 30),
    }));

  return {
    scrollW: root.scrollWidth,
    clientW: root.clientWidth,
    escaping: escaping.slice(0, 6),
    escapingCount: escaping.length,
    small: small.slice(0, 6),
    smallCount: small.length,
  };
}
"""

NAV_NAMES_JS = """
(skip) => [...document.querySelectorAll('[data-page], .nav-item')]
  .map(n => (n.textContent || '').trim().split('\\n')[0].trim())
  .filter(t => t && !skip.some(s => t.toLowerCase().includes(s)))
  .filter((t, i, a) => a.indexOf(t) === i)
"""

CLICK_NAV_JS = """
(name) => {
  const el = [...document.querySelectorAll('[data-page], .nav-item')]
    .find(n => (n.textContent || '').trim().startsWith(name));
  if (!el) return false;
  el.click();
  return true;
}
"""


def _assert_clean(label, result):
    """Turn one audit result into the three checks."""
    horizontal = result["scrollW"] - result["clientW"]
    check(
        f"{label}: no sideways scroll",
        horizontal <= 1,
        f"scrollWidth {result['scrollW']} vs clientWidth {result['clientW']}",
    )
    check(
        f"{label}: nothing escapes the right edge",
        result["escapingCount"] == 0,
        f"{result['escapingCount']} element(s), e.g. {result['escaping'][:3]}",
    )
    check(
        f"{label}: every input >= 16px (iOS zoom)",
        result["smallCount"] == 0,
        f"{result['smallCount']} under 16px, e.g. {result['small'][:3]}",
    )


def _audit_page(page, label, url, walk_nav=False):
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(700)
    _assert_clean(label, page.evaluate(AUDIT_JS))

    if not walk_nav:
        return

    # A portal is a single-page app: its landing screen is one of a dozen, and
    # the filter bars that carried the 16px defect live on the inner ones.
    try:
        names = page.evaluate(NAV_NAMES_JS, list(NAV_SKIP))
    except Exception as exc:  # a portal with no nav is not a failure
        print(f"     (no nav found for {label}: {exc})")
        return

    for name in names[:16]:
        try:
            if not page.evaluate(CLICK_NAV_JS, name):
                continue
            page.wait_for_timeout(650)
            _assert_clean(f"{label} > {name}", page.evaluate(AUDIT_JS))
        except Exception as exc:
            check(f"{label} > {name}: renders", False, str(exc)[:160])


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        print(f"SKIP: {exc}. Install with:  pip install playwright && playwright install chromium")
        return 0

    import minihttp as requests

    try:
        requests.get(FRONTEND + "/partner-login.html")
    except Exception as exc:
        print(f"SKIP: no frontend served at {FRONTEND} ({exc}).")
        print("      Start one with:  python -m http.server 5500 --directory frontend")
        print("      or point JPW_FRONTEND at a deployed origin.")
        return 0

    # Tokens first, over HTTP. If the backend is down there is no point starting
    # a browser, and the failure reads as "backend down" rather than "every
    # portal screen is broken".
    tokens = {}
    for portal, account in (
        ("admin", config.ADMIN),
        ("merchant", config.MERCHANT),
        ("super_admin", config.SUPER),
    ):
        try:
            tokens[portal] = config.login(*account)
        except Exception as exc:
            print(f"     (no {portal} session: {exc} — its screens will be skipped)")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for width, height in VIEWPORTS:
                size = f"{width}x{height}"
                print(f"\n---- {size} " + "-" * (60 - len(size)))
                ctx = browser.new_context(
                    viewport={"width": width, "height": height},
                    # Without this the headless default is a desktop UA and any
                    # `(pointer:coarse)` rule — which is half of the iOS-zoom
                    # fix — never matches, so the test would pass a page that
                    # is broken on a real phone.
                    is_mobile=True,
                    has_touch=True,
                    device_scale_factor=2,
                )
                page = ctx.new_page()

                for label, path in PUBLIC_PAGES:
                    _audit_page(page, f"{size} {label}", FRONTEND + path)

                for label, path, portal in PORTAL_PAGES:
                    if portal not in tokens:
                        continue
                    access, refresh = TOKEN_KEYS[portal]
                    # Seeded before the app's scripts run on the next load, so
                    # the portal boots straight into its authenticated state.
                    page.goto(FRONTEND + path, wait_until="domcontentloaded")
                    page.evaluate(
                        "([k, v]) => { localStorage.setItem(k[0], v); localStorage.setItem(k[1], v); }",
                        [[access, refresh], tokens[portal]],
                    )
                    _audit_page(page, f"{size} {label}", FRONTEND + path, walk_nav=True)

                ctx.close()
        finally:
            browser.close()

    return check.report()


if __name__ == "__main__":
    sys.exit(main())
