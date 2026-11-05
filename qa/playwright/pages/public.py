"""Public B2C page objects: landing, booking card, auth forms."""
from __future__ import annotations

from playwright.sync_api import Page
from .base import BasePage


class BookingCard:
    """The shared search/booking card (booking-card.js) reused on landing,
    flights, hotels and results. Scoped to its container so it works wherever
    the card is embedded."""

    def __init__(self, page: Page, root_selector: str = ".booking-card, .search-card"):
        self.page = page
        self.root = page.locator(root_selector).first

    def tab(self, name: str):
        return self.root.get_by_role("tab", name=name)

    @property
    def search_button(self):
        return self.root.get_by_role("button", name="Search")

    @property
    def pax_selector(self):
        return self.root.locator(".pax-selector, [data-pax]").first

    @property
    def rooms_selector(self):
        return self.root.locator(".rooms-selector, [data-rooms]").first


class LandingPage(BasePage):
    path = "/index.html"

    @property
    def booking_card(self) -> BookingCard:
        return BookingCard(self.page)


class LoginPage(BasePage):
    path = "/login.html"

    def sign_in(self, email: str, password: str):
        self.page.get_by_label("Email").fill(email)
        self.page.get_by_label("Password").fill(password)
        self.page.get_by_role("button", name="Sign in").click()


class RegisterPage(BasePage):
    path = "/register.html"
