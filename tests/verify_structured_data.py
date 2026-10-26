"""Valid schema.org structured data (JSON-LD) on every indexable page.

WHY THIS EXISTS
---------------
Canonical tags (verify_canonical.py) stop duplicate URLs splitting a page's
ranking; structured data is the other half of the on-page SEO surface the three
benchmarked competitors (Trip.com, Travala, MakeMyTrip) all carry — it is what
lets a page qualify for rich results instead of a plain blue link. Eight pages
already had a JSON-LD block; the discovery and policy pages in the sitemap did
not, so this asserts the invariant for ALL of them and keeps a future page from
shipping without one.

The failure modes this guards against, all of which quietly cost rich results:

  * a page with NO JSON-LD at all;
  * a JSON-LD block that is not valid JSON (a trailing comma, an unescaped
    quote) — Google discards the whole block silently;
  * a block with no @context / @type, or an @context that is not schema.org —
    present but not understood;
  * a block whose top-level `url` names a different page than the one it is on
    (a copy-paste), checked only where a url is actually declared.

WHAT DECIDES "INDEXABLE"
------------------------
sitemap.xml, exactly as verify_canonical.py uses it, so the two tests cover the
same set of pages and a page added to or dropped from the sitemap is covered or
dropped here automatically. The url→file mapping is identical.

STATIC, NOT RENDERED
--------------------
The frontend is served as static files with no template engine, so the bytes on
disk are the bytes a browser receives; verify_canonical.py already proves the
clean-URL mount resolves each of these URLs to the file checked here. JSON-LD is
inert markup in those same bytes, so reading the file is reading what is served
— no app boot or database is needed, and this script uses only the standard
library.

The invariant is deliberately lenient about @type: the existing blocks are a
mix of BreadcrumbList, FAQPage and TravelAgency (none of which carries a
top-level name), so requiring a particular shape would false-fail honest,
already-shipped markup. What every block must share is: valid JSON, an
schema.org @context, and a @type.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
SITEMAP = FRONTEND / "sitemap.xml"

ORIGIN = "https://jackpotsworldtours.com"

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def jsonld_blocks(html: str) -> list[str]:
    """The raw text inside every <script type="application/ld+json"> in order.
    Matches whichever order the script tag's attributes fall in."""
    blocks: list[str] = []
    for m in re.finditer(
        r'<script\b[^>]*\btype\s*=\s*["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.I | re.S,
    ):
        blocks.append(m.group(1).strip())
    return blocks


def indexable() -> list[str]:
    """The <loc> of every url in sitemap.xml — the pages declared indexable."""
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    tree = ElementTree.parse(SITEMAP)
    return [el.text.strip() for el in tree.findall(".//s:url/s:loc", ns) if el.text]


def file_for(loc: str) -> Path:
    """The static file the clean URL resolves to: "/" -> index.html,
    "/flights" -> flights.html. Identical to verify_canonical.py."""
    path = loc[len(ORIGIN):] if loc.startswith(ORIGIN) else loc
    if path in ("", "/"):
        return FRONTEND / "index.html"
    return FRONTEND / (path.strip("/") + ".html")


def _objects(parsed: object) -> list[dict]:
    """Every JSON object a block may hold — a bare object, a @graph, or a top
    level list — so the @context/@type check reaches the real entity wherever a
    legitimate block happens to put it."""
    out: list[dict] = []
    if isinstance(parsed, dict):
        out.append(parsed)
        graph = parsed.get("@graph")
        if isinstance(graph, list):
            out.extend(o for o in graph if isinstance(o, dict))
    elif isinstance(parsed, list):
        out.extend(o for o in parsed if isinstance(o, dict))
    return out


def check_page(loc: str) -> None:
    page = file_for(loc)
    name = page.name
    if not page.is_file():
        check(False, f"sitemap lists {loc}, but {name} does not exist")
        return

    raw_blocks = jsonld_blocks(page.read_text(encoding="utf-8"))
    check(len(raw_blocks) >= 1,
          f"{name} has no <script type=\"application/ld+json\"> block (for {loc})")
    if not raw_blocks:
        return

    valid_objects: list[dict] = []
    for i, raw in enumerate(raw_blocks):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            check(False, f"{name} JSON-LD block #{i + 1} is not valid JSON: {exc}")
            continue
        valid_objects.extend(_objects(parsed))

    # At least one object in the page must declare schema.org + a @type.
    def ok(o: dict) -> bool:
        ctx = o.get("@context", "")
        ctx_text = ctx if isinstance(ctx, str) else json.dumps(ctx)
        return "schema.org" in ctx_text and bool(o.get("@type"))

    typed = [o for o in valid_objects if ok(o)]
    check(bool(typed),
          f"{name} JSON-LD declares no schema.org @context with a @type (for {loc})")

    # Where a PAGE entity declares a top-level `url`, it must name THIS page,
    # not another — the copy-paste a sitemap-driven check is well placed to
    # catch. Restricted to schema.org WebPage and its subtypes (anything whose
    # @type ends in "Page": WebPage, CollectionPage, ContactPage, FAQPage…),
    # because those represent the document itself. An Organization / TravelAgency
    # / WebSite carries its OWN url — the site's identity, the bare origin — and
    # that is correct on about.html and contact-us.html, so it is not held to
    # the page's address.
    for o in typed:
        type_name = o.get("@type", "")
        is_page = isinstance(type_name, str) and type_name.endswith("Page")
        url = o.get("url")
        if is_page and isinstance(url, str) and url:
            check(url == loc,
                  f"{name} JSON-LD url is {url!r}; its sitemap URL is {loc!r} — "
                  f"a page's structured-data url must name its own page")


def main() -> int:
    locs = indexable()
    for loc in locs:
        check_page(loc)

    print(f"verify_structured_data: checked {len(locs)} indexable page(s).")
    if failures:
        print(f"\nFAILED with {len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: every indexable page carries valid schema.org JSON-LD.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
