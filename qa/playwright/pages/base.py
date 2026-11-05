"""Base page object: navigation + common chrome shared by every page."""
from __future__ import annotations

from playwright.sync_api import Page, expect


class BasePage:
    #: route relative to base_url; subclasses override
    path = "/"

    def __init__(self, page: Page, base_url: str):
        self.page = page
        self.base_url = base_url.rstrip("/")

    # --- navigation ---------------------------------------------------
    def goto(self, path: str | None = None, **kw):
        rel = path if path is not None else self.path
        self.page.goto(self.base_url + rel, wait_until="domcontentloaded", **kw)
        return self

    def reload(self):
        self.page.reload(wait_until="domcontentloaded")
        return self

    # --- shared chrome (jw-header.js / site-footer.js) ----------------
    @property
    def header(self):
        return self.page.locator("header, .jw-header").first

    @property
    def footer(self):
        return self.page.locator("footer, .site-footer").first

    def expect_loaded(self):
        """A page is loaded when it has a non-empty title and no blank body."""
        expect(self.page).not_to_have_title("")
        expect(self.page.locator("body")).not_to_be_empty()
        return self

    def console_errors(self) -> list[str]:
        """Caller must have attached collect_console() first (see conftest)."""
        return getattr(self.page, "_qa_console_errors", [])
