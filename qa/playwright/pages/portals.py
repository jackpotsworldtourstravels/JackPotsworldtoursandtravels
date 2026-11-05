"""Portal SPA shells. Each is one index.html loading many JS view modules;
the page objects expose the shell nav and a generic view switcher so Stage-4
specs can drive each view without re-finding the nav each time."""
from __future__ import annotations

from .base import BasePage


class _Shell(BasePage):
    """A single-page portal shell with a left/top nav of named views."""

    def nav_to(self, view_name: str):
        # Portal navs render as links or buttons depending on the shell.
        link = self.page.get_by_role("link", name=view_name)
        if link.count() == 0:
            link = self.page.get_by_role("button", name=view_name)
        link.first.click()
        return self

    @property
    def toast(self):
        return self.page.locator(".toast, [role=status]").first


class AdminShell(_Shell):
    path = "/admin/index.html"


class MerchantShell(_Shell):
    #: modern partner portal; the classic shell lives at /merchant-classic/index.html
    path = "/merchant/index.html"


class MerchantClassicShell(_Shell):
    path = "/merchant-classic/index.html"


class ManagerShell(_Shell):
    path = "/manager/index.html"


class SuperAdminShell(_Shell):
    path = "/super-admin/index.html"


class OperationsShell(_Shell):
    path = "/operations/index.html"
