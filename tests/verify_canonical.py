"""The canonical URL on every indexable page.

WHY THIS EXISTS
---------------
Duplicate URLs indexing the same content split a page's search ranking and let
a tracking-parameter or trailing-slash variant outrank the real page. The fix
is a single rel="canonical" on each indexable page, pointing at that page's own
preferred address on the https://jackpotsworldtours.com origin. The failure
modes this guards against are specific and all have been shipped by sites
before:

  * a page with NO canonical at all (its variants compete with each other);
  * a page with TWO canonicals (Google ignores both and picks for you);
  * every page pointing at the homepage (collapses the whole site to one URL);
  * a canonical carrying ?utm_* or a session id (names a URL that should never
    be indexed);
  * a canonical on http://, on www., or with a stray trailing slash (names a
    non-preferred variant that then 301s — a canonical must be a final URL).

WHAT DECIDES "INDEXABLE"
------------------------
sitemap.xml is the source of truth, not a hand-kept list here. It already
enumerates exactly the legitimate, indexable customer pages (its own comment
says so), and robots.txt disallows the rest. Driving the check from the sitemap
means a page added to or removed from the sitemap is covered or dropped here
automatically, and a canonical that disagrees with the sitemap's own spelling
of the URL is itself the bug.

The sitemap's <loc> IS the preferred URL, so each page's canonical must equal
its <loc> verbatim. That single equality folds in the origin, the path, the
absence of query parameters and the trailing-slash convention (only "/" carries
one) — the sitemap fixes all four and the canonical must match.

RENDERED, NOT JUST THE FILE
---------------------------
The frontend is served as static files with no template engine, so the bytes on
disk are the bytes a browser receives — but the mapping from a URL to a file is
the server's, so the last section boots the app and reads the canonical out of
the actual HTTP response for the homepage and a handful of representative pages.

That mapping is itself load-bearing and has been wrong: a canonical names the
EXTENSIONLESS clean URL (`/about`), and `CleanUrlStaticFiles` must resolve that
to `about.html` — nginx's `try_files` does it in the EC2 layout, and the app
must do it in the single-container layout. A regression once left every clean
URL but `/` serving the 404 page with a 404 status while the `.html` twin
worked, so the canonical pointed at an error page. The rendered section now
asserts each sample resolves at BOTH its clean URL and its `.html` twin with the
same single canonical, and that an unknown route still 404s.

REQUIREMENTS
------------
The static section needs only the standard library and no server. The rendered
section boots the FastAPI app in-process (no lifespan, so no database is
touched) and sets dummy secrets if none are present; it skips cleanly if FastAPI
is not installed, exactly as the other serverless scripts tolerate a missing
optional surface.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SITEMAP = FRONTEND / "sitemap.xml"

ORIGIN = "https://jackpotsworldtours.com"

#: A handful of pages to read back out of a live HTTP response, rather than all
#: of them: the homepage (its canonical is the one most often got wrong, the
#: bare origin with a trailing slash), one product page, one policy page, and
#: the two service pages whose canonical this change added. Each is checked at
#: BOTH its clean URL and its `.html` twin.
RENDERED_SAMPLE = ["/", "/flights", "/about", "/activities", "/visa"]

#: A path that is not a page and has no `.html` twin, so it must stay a 404 -
#: proof the clean-URL `.html` retry does not turn every unknown URL into a 200.
UNKNOWN_ROUTE = "/this-page-does-not-exist-9f3a7c"

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def canonicals(html: str) -> list[str]:
    """Every rel="canonical" href in a document, in order. Matches the tag
    whichever order its attributes fall in, so a reordered edit is still seen."""
    hrefs: list[str] = []
    for tag in re.finditer(r"<link\b[^>]*>", html, re.I):
        if re.search(r'rel\s*=\s*["\']canonical["\']', tag.group(0), re.I):
            href = re.search(r'href\s*=\s*["\']([^"\']*)["\']', tag.group(0), re.I)
            hrefs.append(href.group(1).strip() if href else "")
    return hrefs


def indexable() -> list[str]:
    """The <loc> of every url in sitemap.xml — the pages declared indexable."""
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    tree = ElementTree.parse(SITEMAP)
    locs = [el.text.strip() for el in tree.findall(".//s:url/s:loc", ns) if el.text]
    return locs


def file_for(loc: str) -> Path:
    """The static file the clean URL resolves to: "/" -> index.html,
    "/flights" -> flights.html. The sitemap only ever holds single-segment
    customer URLs, which is the whole range this mapping has to cover."""
    path = loc[len(ORIGIN):] if loc.startswith(ORIGIN) else loc
    if path in ("", "/"):
        return FRONTEND / "index.html"
    return FRONTEND / (path.strip("/") + ".html")


def check_static(locs: list[str]) -> None:
    """Exactly one canonical per indexable page, equal to that page's own
    sitemap URL — self-referencing, on the preferred origin, no query string."""
    for loc in locs:
        page = file_for(loc)
        name = page.name
        if not page.is_file():
            check(False, f"sitemap lists {loc}, but {name} does not exist")
            continue

        found = canonicals(page.read_text(encoding="utf-8"))
        check(len(found) == 1,
              f"{name} has {len(found)} canonical tags, expected exactly 1 "
              f"(for {loc})")
        if len(found) != 1:
            continue

        href = found[0]
        check(href == loc,
              f"{name} canonical is {href!r}; its sitemap URL is {loc!r} — a "
              f"page's canonical must name its own preferred URL")
        # These are implied by the equality above, but a mismatch reads far more
        # clearly as the specific thing that is wrong.
        check("?" not in href and "#" not in href,
              f"{name} canonical {href!r} carries a query or fragment — a "
              f"canonical must exclude tracking and query parameters")
        check(href.startswith(ORIGIN + "/") or href == ORIGIN + "/",
              f"{name} canonical {href!r} is not on the preferred origin "
              f"{ORIGIN} (no http://, no www.)")

    # No page but the homepage may claim the homepage's canonical — the classic
    # copy-paste that collapses every page onto "/".
    home = ORIGIN + "/"
    for loc in locs:
        if loc == home:
            continue
        page = file_for(loc)
        if page.is_file():
            check(home not in canonicals(page.read_text(encoding="utf-8")),
                  f"{page.name} points its canonical at the homepage {home} "
                  f"instead of its own URL {loc}")


def check_rendered() -> None:
    """Read the canonical back out of the served HTTP response, so the check
    covers what a crawler receives and not only the file on disk."""
    try:
        from fastapi.testclient import TestClient
    except ImportError:
        print("     (rendered check skipped: FastAPI not installed)")
        return

    # The app's settings require these; a static GET never uses them, but the
    # import fails without them. setdefault never overrides a real configured
    # value, so this is inert on a live backend and supplies a throwaway on a
    # bare checkout.
    os.environ.setdefault("DATABASE_URL", "sqlite://")
    os.environ.setdefault("JWT_SECRET_KEY", "canonical-verify-not-a-real-secret")
    sys.path.insert(0, str(ROOT / "backend"))
    try:
        from app.main import app
    except Exception as exc:  # noqa: BLE001 - a bare checkout may lack deps
        print(f"     (rendered check skipped: app did not import - {exc})")
        return

    # Plain client, NOT a context manager: entering it would run the lifespan,
    # which starts background sweeps and touches the database. Static serving
    # takes no such dependency, so the plain client exercises it alone.
    client = TestClient(app)

    def one_canonical(resp, request: str, loc: str) -> None:
        found = canonicals(resp.text)
        check(len(found) == 1,
              f"served {request} has {len(found)} canonical tags, expected 1")
        if len(found) == 1:
            check(found[0] == loc,
                  f"served {request} canonical is {found[0]!r}, expected {loc!r}")

    for url in RENDERED_SAMPLE:
        loc = ORIGIN + url
        # The EXTENSIONLESS clean URL is the one the canonical names and the one
        # nginx serves in production; CleanUrlStaticFiles has to resolve it to
        # the backing .html in the single-container (no-nginx) layout too. This
        # 200 is the regression guard for that routing: before the fix every
        # clean URL but "/" served the 404.html page with a 404 status.
        clean = client.get(url)
        check(clean.status_code == 200,
              f"GET {url} returned {clean.status_code}, expected 200 - the clean "
              f"URL must resolve, not serve the 404 page (canonical target)")
        if clean.status_code == 200:
            one_canonical(clean, url, loc)

        # The .html twin must keep working and carry the same canonical, so the
        # two spellings never disagree about the preferred URL.
        if url != "/":
            twin = client.get(f"{url}.html")
            check(twin.status_code == 200,
                  f"GET {url}.html returned {twin.status_code}, expected 200")
            if twin.status_code == 200:
                one_canonical(twin, f"{url}.html", loc)

    # A genuinely unknown route must still 404 - the .html retry must not turn
    # every path into a 200. Both the clean and the .html spellings.
    for unknown in (UNKNOWN_ROUTE, f"{UNKNOWN_ROUTE}.html"):
        resp = client.get(unknown)
        check(resp.status_code == 404,
              f"GET {unknown} returned {resp.status_code}, expected 404 - an "
              f"unknown route must not resolve")


def main() -> int:
    locs = indexable()
    check(bool(locs), "sitemap.xml lists no indexable URLs")
    check(ORIGIN + "/" in locs, "sitemap.xml does not list the homepage")

    check_static(locs)
    check_rendered()

    if failures:
        print(f"FAIL  {len(failures)} canonical problem(s):\n")
        for problem in failures:
            print(f"  - {problem}")
        return 1

    print(f"PASS  canonical: {len(locs)} indexable pages, each with exactly one "
          f"self-referencing canonical on {ORIGIN}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
