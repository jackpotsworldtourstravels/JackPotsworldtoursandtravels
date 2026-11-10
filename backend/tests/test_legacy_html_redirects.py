"""Clean URLs for the public B2C site: `/flights` serves, `/flights.html` 301s to it.

WHAT THIS PINS
  * every audited public page answers at its CLEAN URL (200, the right file) and `/` is the landing page;
  * every legacy `<page>.html` address answers 301 -> the clean URL, GET and HEAD, with the query string
    carried over untouched (`?signin=1`, search parameters, `?token=` reset links);
  * the redirect target is fixed by the server -- no request parameter can steer it (no open redirect);
  * there is no loop: the redirect target itself is a 200, never another redirect;
  * what is NOT on the list keeps answering at its `.html` address (partner / portal sign-in, the design
    reference, the templates behind dynamic routes), and the portal directories are untouched;
  * the SEO tags agree: one self-referencing canonical per page, og:url equal to it, sitemap entries clean
    and every one of them on the redirect list;
  * nothing in the public markup or scripts links to an audited page by its `.html` address any more.

NO DATABASE. `TestClient(app)` without a context manager does not run startup, and the static mount and the
redirect routes need nothing but the files on disk.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import FRONTEND_DIR, LEGACY_HTML_REDIRECTS, app

SITE = "https://jackpotsworldtours.com"
client = TestClient(app, follow_redirects=False)


def clean(page: str) -> str:
    return "/" if page == "index" else f"/{page}"


# Served at their .html address on purpose; see the comment on LEGACY_HTML_REDIRECTS in app/main.py.
NOT_REDIRECTED = ["partner-login", "portal-login", "design-system", "destination", "destination-hotels",
                  "location", "package", "ticket-verify", "404"]
PORTAL_DIRS = ["admin", "manager", "merchant", "merchant-classic", "operations", "super-admin", "customer"]


# --- the clean URL serves --------------------------------------------------------------------------------

@pytest.mark.parametrize("page", LEGACY_HTML_REDIRECTS)
def test_clean_url_serves_the_page_file(page):
    r = client.get(clean(page))
    assert r.status_code == 200, f"{clean(page)} -> {r.status_code}"
    assert r.headers["content-type"].startswith("text/html")
    assert r.content == (FRONTEND_DIR / f"{page}.html").read_bytes()


def test_root_is_the_landing_page():
    r = client.get("/")
    assert r.status_code == 200
    assert r.content == (FRONTEND_DIR / "index.html").read_bytes()


# --- the legacy URL redirects ----------------------------------------------------------------------------

@pytest.mark.parametrize("page", LEGACY_HTML_REDIRECTS)
def test_legacy_url_is_a_permanent_redirect(page):
    r = client.get(f"/{page}.html")
    assert r.status_code == 301
    assert r.headers["location"] == clean(page)


@pytest.mark.parametrize("page", LEGACY_HTML_REDIRECTS)
def test_head_redirects_too(page):
    r = client.head(f"/{page}.html")
    assert r.status_code == 301 and r.headers["location"] == clean(page)


@pytest.mark.parametrize("page", LEGACY_HTML_REDIRECTS)
def test_redirect_target_is_not_itself_a_redirect(page):
    """No loop and no chain: one hop, then a 200."""
    target = client.get(f"/{page}.html").headers["location"]
    assert client.get(target).status_code == 200


@pytest.mark.parametrize("legacy,expected", [
    ("/index.html", "/"),
    ("/index.html?signin=1", "/?signin=1"),
    ("/index.html?account=profile", "/?account=profile"),
    ("/flights.html?trip=oneway&from=HYD&to=BLR&depart=2026-11-10&adults=1&cabin=economy",
     "/flights?trip=oneway&from=HYD&to=BLR&depart=2026-11-10&adults=1&cabin=economy"),
    ("/flights.html?trip=multi&legs=HYD:BLR:2026-11-12,BLR:HYD:2026-11-14&adults=2&cabin=business",
     "/flights?trip=multi&legs=HYD:BLR:2026-11-12,BLR:HYD:2026-11-14&adults=2&cabin=business"),
    ("/hotels.html?dest=Banjara%20Hills&rooms=1", "/hotels?dest=Banjara%20Hills&rooms=1"),
    ("/packages.html?type=Goa&month=2026-10", "/packages?type=Goa&month=2026-10"),
    ("/reset-password.html?token=abc.DEF-123_x", "/reset-password?token=abc.DEF-123_x"),
    ("/my-bookings.html?pay=AG000123", "/my-bookings?pay=AG000123"),
    ("/gaming-packages.html?x=%E2%82%B9", "/gaming-packages?x=%E2%82%B9"),
])
def test_query_string_is_preserved_byte_for_byte(legacy, expected):
    r = client.get(legacy)
    assert r.status_code == 301
    assert r.headers["location"] == expected


def test_a_fragment_is_left_to_the_browser():
    """The server never receives #fragments; the browser re-applies them to the redirect target."""
    r = client.get("/index.html")
    assert "#" not in r.headers["location"]


def test_redirects_are_cacheable_for_a_bounded_time_only():
    cc = client.get("/flights.html").headers.get("cache-control", "")
    assert "max-age=3600" in cc and "immutable" not in cc


def test_request_parameters_cannot_steer_the_redirect():
    """A default-valued handler parameter would be exposed as a query parameter (open redirect)."""
    for evil in ("//evil.test", "https://evil.test/", "/admin/"):
        r = client.get(f"/flights.html?_clean={evil}&target={evil}&next={evil}")
        assert r.status_code == 301
        assert r.headers["location"].startswith("/flights?"), r.headers["location"]
        assert not r.headers["location"].startswith(("//", "http"))
    assert client.get("/flights.html").headers["location"] == "/flights"


def test_the_redirect_routes_are_hidden_from_the_api_docs():
    assert not any(p.endswith(".html") for p in app.openapi()["paths"])


# --- what must NOT move ----------------------------------------------------------------------------------

@pytest.mark.parametrize("page", NOT_REDIRECTED)
def test_unlisted_pages_keep_answering_at_their_html_address(page):
    assert (FRONTEND_DIR / f"{page}.html").is_file()
    r = client.get(f"/{page}.html")
    assert r.status_code == 200, f"/{page}.html -> {r.status_code}"
    assert "location" not in r.headers


@pytest.mark.parametrize("portal", PORTAL_DIRS)
def test_portal_directories_are_untouched(portal):
    assert client.get(f"/{portal}/").status_code == 200
    r = client.get(f"/{portal}/index.html")
    assert r.status_code == 200 and "location" not in r.headers, f"/{portal}/index.html"


def test_customer_portal_pages_are_not_swept_up():
    """`/customer/register.html` shares a file NAME with the public /register page; only the public one moves."""
    assert client.get("/register.html").status_code == 301
    for p in ("register", "forgot-password", "reset-password"):
        f = FRONTEND_DIR / "customer" / f"{p}.html"
        if f.is_file():
            r = client.get(f"/customer/{p}.html")
            assert r.status_code == 200 and "location" not in r.headers


def test_unknown_pages_are_still_404():
    assert client.get("/no-such-page").status_code == 404
    assert client.get("/no-such-page.html").status_code == 404


def test_api_and_assets_are_not_affected():
    assert client.get("/api/health").json() == {"status": "ok"}
    js = client.get("/assets/js/site-footer.js")
    assert js.status_code == 200 and "javascript" in js.headers["content-type"]
    assert client.get("/assets/css/flights-ref.css").status_code == 200


def test_dynamic_routes_are_not_affected():
    for path in ("/destination/goa", "/destination/goa/baga", "/hotels/goa/baga", "/package/1", "/package-details/1"):
        assert client.get(path).status_code == 200, path


# --- SEO -------------------------------------------------------------------------------------------------

def _read(page: str) -> str:
    return (FRONTEND_DIR / f"{page}.html").read_text(encoding="utf-8")


@pytest.mark.parametrize("page", LEGACY_HTML_REDIRECTS)
def test_canonical_and_og_url_use_the_clean_url(page):
    html = _read(page)
    canon = re.findall(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', html)
    og = re.findall(r'<meta[^>]+property="og:url"[^>]+content="([^"]+)"', html)
    assert len(canon) <= 1, f"{page}: {len(canon)} canonical tags"
    for url in canon + og:
        assert not url.endswith(".html"), f"{page}: {url}"
        assert url == SITE + ("/" if page == "index" else clean(page)), f"{page}: {url}"
    if canon:
        assert og == canon, f"{page}: og:url {og} != canonical {canon}"


def test_sitemap_lists_only_clean_urls_that_resolve_and_are_redirect_pages():
    xml = (FRONTEND_DIR / "sitemap.xml").read_text(encoding="utf-8")
    urls = re.findall(r"<loc>([^<]+)</loc>", xml)
    assert urls and len(urls) == len(set(urls)), "duplicate sitemap entries"
    for url in urls:
        assert url.startswith(SITE) and not url.endswith(".html"), url
        path = url[len(SITE):] or "/"
        assert client.get(path).status_code == 200, path
        page = "index" if path == "/" else path.lstrip("/")
        assert page in LEGACY_HTML_REDIRECTS, f"{path} is in the sitemap but its .html address does not redirect"


def test_no_two_pages_share_a_canonical():
    seen = {}
    for page in LEGACY_HTML_REDIRECTS:
        for url in re.findall(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', _read(page)):
            assert url not in seen, f"{page} and {seen[url]} both canonicalise to {url}"
            seen[url] = page


# --- nothing links to the old addresses any more ---------------------------------------------------------

_ALT = "|".join(sorted(map(re.escape, LEGACY_HTML_REDIRECTS), key=len, reverse=True))
# A quoted URL that STARTS with an audited page's .html name: href="flights.html", '/hotels.html?x', `index.html#c`.
_OLD_LINK = re.compile(r"""["'`](?:\./|/)?(?:%s)\.html(?=[?#"'`])""" % _ALT)
_OLD_ABSOLUTE = re.compile(r"https?://[A-Za-z0-9.-]+/(?:%s)\.html" % _ALT)
_META_REFRESH = re.compile(r"""url=(?:%s)\.html""" % _ALT)


def _public_sources() -> list[Path]:
    return sorted(FRONTEND_DIR.glob("*.html")) + sorted((FRONTEND_DIR / "assets" / "js").glob("*.js"))


def test_no_public_link_uses_an_html_address():
    offenders = []
    for f in _public_sources():
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if _OLD_LINK.search(line) or _OLD_ABSOLUTE.search(line) or _META_REFRESH.search(line):
                offenders.append(f"{f.relative_to(FRONTEND_DIR)}:{n}: {line.strip()[:110]}")
    assert not offenders, "public pages still link to .html addresses:\n" + "\n".join(offenders)
