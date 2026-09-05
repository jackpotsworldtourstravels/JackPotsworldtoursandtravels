"""The company footer, and the pages every one of its links promises.

WHY THIS EXISTS
---------------
The footer is authored twice on purpose. ``SiteFooter.html()`` in
``frontend/assets/js/site-footer.js`` renders it on every page that mounts a
shell; ``index.html`` carries a hand-written copy of the same markup because it
is the marketing front door and the links a crawler follows out of it should be
in the served document rather than injected afterwards.

Two copies drift. The three that preceded them did: index.html, hero-shell.js
and service-shell.js each had their own footer, and by the time they were
replaced two of them still advertised Cruises months after the navigation
dropped it, all three carried a phone number nobody answers, and eight of the
links pointed at ``#``. Nothing rendered them side by side, so nothing noticed.

This file renders them side by side.

WHAT IT ASSERTS, AND WHY EACH ONE
---------------------------------
  1. Both copies link to the same set of pages, with the same labels.
     The whole point of a shared definition.

  2. Every internal link resolves to a file that exists.
     A footer link to a missing page is a 404 on every page of the site at
     once, which is the most expensive kind of broken link there is.

  3. No footer link points at ``#`` or at ``index.html#contact``.
     Both were the previous footer's way of saying "this page does not exist
     yet". A placeholder that ships is indistinguishable from a decision.

  4. The services named are the three that are sold, and no payment provider
     is named. Cruises, visa and passport services, bus and train bookings,
     car rentals and forex have all appeared in this site's copy at some point
     and none of them are offered; a footer is the last place a withdrawn
     service survives. Payment wording is fixed at "our authorized payment
     partners" so that changing processor is not a content migration.

  5. The copyright line and entity name agree across both copies.
     The old one said "Pvt. Ltd." for a proprietorship, which is a statement
     about who you are contracting with rather than a piece of styling.

  6. Every CONTENT page the footer links to is a real page: it has a title, a
     meta description, a canonical URL, exactly one <h1>, and a footer.

WHAT IT DELIBERATELY DOES NOT CHECK
-----------------------------------
The product pages (flights.html, hotels.html, packages.html) are exempt from
checks 4 and 6. Their <h1> lives in ``heroHtml()`` in hero-shell.js and is
mounted at runtime, so a static scan sees zero headings on a page that renders
one correctly. Verifying a served DOM is verify_responsive.py's job and needs a
browser. Content pages are identified by their use of content-page.css.

Check 4 DOES now read the whole of index.html, not just its footer. It did not
at first: the hero eyebrow, the sub-line, the offers carousel and the trending-
routes strip all still sold cruises, holiday packages and honeymoon packages,
and a check that failed on day one would have been switched off by day two. All
four have been rewritten to the three services, so the check is enforceable —
and the landing page is precisely where a withdrawn service comes back, because
marketing copy is edited by people who are not reading TABS in booking-card.js.

NEGATED MENTIONS ARE ALLOWED, and they have to be. The Terms and the Disclaimer
both say "we do not provide passport or visa services", which is the sentence a
traveller most needs to find. A check that cannot tell an offer from a denial
would force those pages to go quiet about the very thing they exist to state.

REQUIREMENTS
------------
None beyond the standard library, and no server. This is a static check of the
files on disk, so it runs anywhere ``run_all.py`` does and cannot be skipped for
want of a browser.
"""

from __future__ import annotations

import re
import sys
from html import unescape
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
INDEX = FRONTEND / "index.html"
FOOTER_JS = FRONTEND / "assets" / "js" / "site-footer.js"

BRAND = "JackpotsWorld Tours &amp; Travels"
COPYRIGHT = "&copy; 2026 JackpotsWorld Tours &amp; Travels. All Rights Reserved."

#: The contact links, which site-footer.js builds by concatenating strings
#: across several source lines. A regex over the file reads the "' + '" between
#: the halves as part of the label, so these are checked by value instead.
CONTACT = [
    ("+91 9177847799", "tel:+919177847799"),
    ("support@jackpotsworldtours.com", "mailto:support@jackpotsworldtours.com"),
]

#: Services this business does not sell. "Package" alone is fine — tour
#: packages ARE sold; it is "holiday package" and "honeymoon package" that
#: are not.
NOT_OFFERED = [
    r"cruise",
    r"visa service",
    r"passport service",
    r"holiday package",
    r"honeymoon package",
    r"bus booking",
    r"train booking",
    r"car rental",
    r"forex",
]

#: Payment processors that must not be named in customer-facing copy.
PROVIDERS = [r"razorpay", r"stripe", r"cashfree", r"phonepe", r"payu"]

#: A mention preceded by one of these inside the preceding ~70 characters is a
#: denial, not an offer.
NEGATIONS = re.compile(
    r"\b(?:do not|don't|does not|no|not|never|without|outside|other than|"
    r"nor|neither)\b", re.I)

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def normalise(raw: str) -> str:
    """One spelling of a link label, whichever copy it came from.

    The static markup writes "Website Terms &amp; Conditions"; the JS holds the
    bare "&" and escapes it at render time. Both produce the same text on the
    page, so both normalise to the same string here — otherwise every ampersand
    in the footer reads as a mismatch."""
    return unescape(re.sub(r"\s+", " ", raw)).strip()


def visible_text(html: str) -> str:
    """The page with HTML and CSS/JS comments stripped.

    Comments explain what was removed from this site and why, and they name the
    removed services to do it. They are not shipped copy and must not trip the
    wording checks."""
    html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    return re.sub(r"/\*.*?\*/", "", html, flags=re.S)


def index_footer_html() -> str:
    """index.html's hand-written footer, from <footer class="jw-footer"> on."""
    html = INDEX.read_text(encoding="utf-8")
    match = re.search(r'<footer class="jw-footer".*?</footer>', html, re.S)
    if not match:
        sys.exit('FAIL  index.html has no <footer class="jw-footer"> block')
    return match.group(0)


def links_from_html(block: str) -> list[tuple[str, str]]:
    """(label, href) for every .jw-f-link anchor, in document order."""
    return [(normalise(m.group(2)), m.group(1)) for m in re.finditer(
        r'<a class="jw-f-link[^"]*" href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)]


def links_from_js() -> list[tuple[str, str]]:
    """(label, href) from the LINKS table in site-footer.js. The table only —
    the contact pair is checked separately, see CONTACT."""
    js = FOOTER_JS.read_text(encoding="utf-8")
    table = re.search(r"const LINKS = \{(.*?)\n  \};", js, re.S)
    if not table:
        sys.exit("FAIL  site-footer.js has no LINKS table")
    return [(normalise(m.group(1)), m.group(2)) for m in
            re.finditer(r"\['([^']+)',\s*'([^']+)'\]", table.group(1))]


def check_wording(name: str, html: str) -> None:
    """No withdrawn service offered, and no payment processor named."""
    text = visible_text(html)
    for word in NOT_OFFERED:
        for hit in re.finditer(rf"\b{word}", text, re.I):
            preceding = text[max(0, hit.start() - 70):hit.start()]
            check(NEGATIONS.search(preceding) is not None,
                  f"{name} mentions {word!r} without denying it — that is not "
                  f"a service this business offers")
    for provider in PROVIDERS:
        check(re.search(provider, text, re.I) is None,
              f"{name} names the payment processor {provider!r}; the agreed "
              f"wording is 'our authorized payment partners'")
    check("Pvt. Ltd." not in text,
          f"{name} says 'Pvt. Ltd.'; the business is a proprietorship")


def main() -> int:
    block = index_footer_html()
    js = FOOTER_JS.read_text(encoding="utf-8")

    # --- 1. the two copies agree -------------------------------------------
    static = links_from_html(block)
    from_js = links_from_js() + CONTACT
    only_static = sorted(set(static) - set(from_js))
    only_js = sorted(set(from_js) - set(static))
    check(not only_static,
          f"in index.html's footer but not site-footer.js: {only_static}")
    check(not only_js,
          f"in site-footer.js but not index.html's footer: {only_js}")
    for label, href in CONTACT:
        check(f'href="{href}"' in js and f'href="{href}"' in block,
              f"the contact link {label} is missing from one of the two copies")

    # --- 2. every internal link resolves ------------------------------------
    internal = sorted({href for _, href in static + from_js
                       if not href.startswith(("tel:", "mailto:", "http", "#"))})
    check(bool(internal), "the footer has no internal links at all")
    for href in internal:
        check((FRONTEND / href.split("#")[0]).is_file(),
              f"footer links to {href}, which does not exist")

    # --- 3. no placeholders -------------------------------------------------
    for text, href in static + from_js:
        check(href not in ("#", ""), f"footer link {text!r} points at {href!r}")
        check(not href.startswith("index.html#"),
              f"footer link {text!r} points at {href!r} — a section of the "
              f"landing page rather than its own document")

    # --- 4/5. wording and entity -------------------------------------------
    # The WHOLE landing page, not just its footer: the hero, the offers
    # carousel and the destinations strip are where a withdrawn service is
    # most likely to reappear, and they are read by more people than any
    # policy page.
    check_wording("index.html", INDEX.read_text(encoding="utf-8"))
    check(COPYRIGHT in block, "index.html's footer is missing the copyright line")
    check(COPYRIGHT in js, "site-footer.js is missing the copyright line")
    check(BRAND in block and BRAND in js, "the brand name differs between copies")

    # --- 4/6. the content pages ---------------------------------------------
    # A content page is one built on content-page.css; the product pages carry
    # their own machinery and are checked in the browser instead.
    content = [FRONTEND / h for h in internal
               if (FRONTEND / h).is_file()
               and "content-page.css" in (FRONTEND / h).read_text(encoding="utf-8")]
    check(len(content) >= 10,
          f"expected at least 10 footer content pages, found {len(content)}")

    for page in content:
        html = page.read_text(encoding="utf-8")
        name = page.name
        check_wording(name, html)
        check(re.search(r"<title>[^<]{10,}</title>", html) is not None,
              f"{name} has no usable <title>")
        check('name="description"' in html, f"{name} has no meta description")
        check('rel="canonical"' in html, f"{name} has no canonical URL")
        heads = re.findall(r"<h1[ >]", html)
        check(len(heads) == 1, f"{name} has {len(heads)} <h1> elements, expected 1")
        check("data-site-footer" in html, f"{name} does not render the footer")

    if failures:
        print(f"FAIL  {len(failures)} problem(s) with the site footer:\n")
        for problem in failures:
            print(f"  - {problem}")
        return 1

    print(f"PASS  footer: {len(static)} links, both copies identical, "
          f"{len(internal)} link targets exist, {len(content)} content pages "
          f"verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
