"""Load test for the JackpotsWorld customer site.

WHAT THIS MEASURES
    The point at which the site stops responding well as concurrent users
    climb -- "the knee in the curve". You ramp users up (100 -> 2000), watch
    response times and error rate, and the largest user count where both stay
    healthy is your real capacity. See loadtest/README.md.

TWO USER PROFILES, MIXED THE WAY REAL TRAFFIC IS
    * Visitor  (default, the majority) -- anonymous browsing of the public
      catalogue. No login, so no rate-limit blockers, and it is what most
      stresses the shared ~30-connection database pool in aggregate.
    * Member   (optional cohort) -- signed-in traffic (My Trips, notifications).
      Uses PRE-MINTED tokens read from a file, because the login endpoints are
      rate-limited to 5/minute PER IP (see README) and cannot be driven at
      scale from one load generator. Generate the file with seed_accounts.py.

RUN
    pip install -r loadtest/requirements.txt
    locust -f loadtest/locustfile.py --host http://localhost:8000

    Then open http://localhost:8089 and set the user count + spawn rate,
    or run headless (see README for the ramp command).

CONFIG (environment variables)
    TOKENS_FILE   path to a file of access tokens, one per line. If present,
                  a share of virtual users become signed-in Members.
    MEMBER_RATIO  0..1 -- fraction of users that are Members when tokens exist
                  (default 0.2, i.e. 20% signed-in / 80% browsing).
"""
from __future__ import annotations

import os
import random

from locust import HttpUser, between, task

TOKENS_FILE = os.environ.get("TOKENS_FILE", "").strip()
MEMBER_RATIO = float(os.environ.get("MEMBER_RATIO", "0.2"))

# Load pre-minted access tokens once, at import, shared across all users.
_TOKENS: list[str] = []
if TOKENS_FILE and os.path.exists(TOKENS_FILE):
    with open(TOKENS_FILE, encoding="utf-8") as fh:
        _TOKENS = [line.strip() for line in fh if line.strip()]


class Visitor(HttpUser):
    """An anonymous browser: the shape of most real traffic.

    Every task hits a public endpoint that runs a genuine database query, so
    the aggregate load is a faithful test of the shared connection pool.
    """

    # Think-time between actions, so N users != N requests/sec. A real person
    # reads a page for a few seconds before clicking again.
    wait_time = between(2, 6)
    # Weight relative to Member below: this class is picked ~4x as often.
    weight = 4

    def on_start(self) -> None:
        # Prime a package id to browse into. Failing this is not fatal --
        # the browse tasks re-fetch the list if they have no id yet.
        self._package_ids: list[int] = []
        self._refresh_ids()

    def _refresh_ids(self) -> None:
        with self.client.get(
            "/api/customer/packages", name="GET /packages", catch_response=True
        ) as r:
            if r.status_code == 200:
                try:
                    self._package_ids = [
                        p["customer_package_id"]
                        for p in r.json()
                        if isinstance(p, dict) and "customer_package_id" in p
                    ]
                except ValueError:
                    r.failure("packages: response was not JSON")

    @task(6)
    def browse_grid(self) -> None:
        """The Tour Packages grid -- the most-hit page."""
        self._refresh_ids()

    @task(3)
    def open_package(self) -> None:
        """A package detail page + its departures -- two real queries."""
        if not self._package_ids:
            self._refresh_ids()
        if not self._package_ids:
            return
        pid = random.choice(self._package_ids)
        # name= collapses per-id URLs into one line in the Locust report,
        # otherwise every package id is its own row and the stats are noise.
        self.client.get(f"/api/customer/packages/{pid}", name="GET /packages/{id}")
        self.client.get(
            f"/api/customer/packages/departures?package={pid}",
            name="GET /packages/departures",
        )

    @task(2)
    def filters(self) -> None:
        """The filter rail: facets + the three category tiles."""
        self.client.get("/api/customer/packages/facets", name="GET /packages/facets")
        self.client.get("/api/customer/packages/trip-types", name="GET /packages/trip-types")

    @task(1)
    def payment_config(self) -> None:
        """The check the checkout page makes on load."""
        self.client.get("/api/customer/payments/config", name="GET /payments/config")


class Member(HttpUser):
    """A signed-in traveller. Only active when TOKENS_FILE has tokens.

    Uses a pre-minted access token rather than logging in, because the login
    path is rate-limited per IP and cannot be exercised at scale from one host.
    """

    wait_time = between(3, 8)
    weight = 1

    def on_start(self) -> None:
        if not _TOKENS:
            # No tokens supplied -> behave as a stopped user (does nothing).
            self._token = None
            self.stop()
            return
        # Skew the population toward Visitors regardless of the weight, using
        # the configured ratio, so the traffic mix matches MEMBER_RATIO.
        if random.random() > MEMBER_RATIO:
            self.stop()
            return
        self._token = random.choice(_TOKENS)
        self.client.headers.update({"Authorization": f"Bearer {self._token}"})

    @task(3)
    def my_trips(self) -> None:
        self.client.get("/api/customer/package-bookings", name="GET /package-bookings (auth)")

    @task(2)
    def notifications(self) -> None:
        self.client.get("/api/customer/notifications", name="GET /notifications (auth)")

    @task(1)
    def also_browse(self) -> None:
        # Signed-in users still browse the catalogue.
        self.client.get("/api/customer/packages", name="GET /packages")
