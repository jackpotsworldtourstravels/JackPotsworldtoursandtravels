"""Complete Open Graph + Twitter card metadata on every indexable page.

WHY THIS EXISTS
---------------
When a page is shared — WhatsApp, Instagram DMs, X, Slack, Facebook — the link
preview is built from Open Graph tags. A missing og:image is the common, costly
failure: the share renders as a bare grey link with no picture, which for a
travel brand is the difference between a tap and a scroll-past. The three
benchmarked competitors all ship a full card on every page; this asserts the
same invariant for the indexable set so a new page cannot regress it.

The failure modes this guards against:

  * a page with NO Open Graph tags at all (shares as a plain link);
  * og:title / og:type / og:url / og:description present but NO og:image
    (the imageless grey card);
  * og:url naming a different page than the one it is on (a copy-paste);
  * og:image pointing at an asset that does not exist on disk (a typo'd path
    that 404s in the scraper);
  * no twitter:card (X will not upgrade the link to a card at all).

SOURCE OF TRUTH is sitemap.xml, exactly as verify_canonical.py and
verify_structured_data.py use it, so all three tests cover the same page set and
the url→file mapping is identical. Static only (no app boot): the frontend is
served as static files, these tags are inert <head> markup, and
verify_canonical.py already proves the clean-URL mount resolves each URL to the
file read here. Standard library only.

twitter:title / twitter:description are deliberately NOT required: X falls back
to og:title / og:description when they are absent, so requiring them would push
pure duplication into every page for no gain. twitter:card IS required, because
without it X shows no card regardless of the og:* tags.
"""

from __future__ import annotations

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


def _meta(html: str, attr: str, value: str) -> list[str]:
    """content= of every <meta {attr}="{value}">, attribute order independent."""
    out: list[str] = []
    for tag in re.finditer(r"<meta\b[^>]*>", html, re.I):
        t = tag.group(0)
        if re.search(rf'{attr}\s*=\s*["\']{re.escape(value)}["\']', t, re.I):
            m = re.search(r'content\s*=\s*["\']([^"\']*)["\']', t, re.I)
            out.append(m.group(1).strip() if m else "")
    return out


def indexable() -> list[str]:
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    tree = ElementTree.parse(SITEMAP)
    return [el.text.strip() for el in tree.findall(".//s:url/s:loc", ns) if el.text]


def file_for(loc: str) -> Path:
    path = loc[len(ORIGIN):] if loc.startswith(ORIGIN) else loc
    if path in ("", "/"):
        return FRONTEND / "index.html"
    return FRONTEND / (path.strip("/") + ".html")


def asset_exists(url: str) -> bool:
    """An og:image URL on our own origin must resolve to a file under frontend/."""
    if not url.startswith(ORIGIN + "/"):
        return False
    rel = url[len(ORIGIN) + 1:].split("?", 1)[0]
    return (FRONTEND / rel).is_file()


def first(values: list[str]) -> str:
    return values[0] if values else ""


def check_page(loc: str) -> None:
    page = file_for(loc)
    name = page.name
    if not page.is_file():
        check(False, f"sitemap lists {loc}, but {name} does not exist")
        return
    html = page.read_text(encoding="utf-8")

    for prop in ("og:type", "og:title", "og:description", "og:url", "og:image"):
        check(len(_meta(html, "property", prop)) >= 1,
              f"{name} is missing <meta property=\"{prop}\"> (for {loc})")

    og_url = first(_meta(html, "property", "og:url"))
    if og_url:
        check(og_url == loc,
              f"{name} og:url is {og_url!r}; its sitemap URL is {loc!r} — a "
              f"page's og:url must name its own page")

    og_image = first(_meta(html, "property", "og:image"))
    if og_image:
        check(og_image.startswith("https://"),
              f"{name} og:image {og_image!r} is not an absolute https URL — "
              f"scrapers need an absolute image URL")
        check(asset_exists(og_image),
              f"{name} og:image {og_image!r} does not resolve to a file under "
              f"frontend/ — a shared link would preview a broken image")

    check(len(_meta(html, "name", "twitter:card")) >= 1,
          f"{name} is missing <meta name=\"twitter:card\"> — X will not render "
          f"a card without it (for {loc})")

    tw_image = first(_meta(html, "name", "twitter:image"))
    if tw_image:
        check(asset_exists(tw_image),
              f"{name} twitter:image {tw_image!r} does not resolve to a file "
              f"under frontend/")


def main() -> int:
    locs = indexable()
    for loc in locs:
        check_page(loc)

    print(f"verify_open_graph: checked {len(locs)} indexable page(s).")
    if failures:
        print(f"\nFAILED with {len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: every indexable page carries a complete Open Graph + Twitter card.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
