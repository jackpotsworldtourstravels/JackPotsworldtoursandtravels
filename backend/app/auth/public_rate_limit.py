"""Per-IP limits for the public, unauthenticated API endpoints (audit JP-04).

``auth/rate_limit.py`` throttles the endpoints that carry a ``@limiter.limit``
decorator, and 35 public endpoints had none: coupon validation took 60 requests
in a burst, flight search (which costs supplier quota) and the price quotes were
open, and every catalogue read was unmetered.

Decorating 35 handlers would have touched a dozen routers and left the next
public endpoint unprotected by default. This table is one place, applied by one
middleware (``main.py``), and ``tests/test_security_remediation.py`` fails if a
new public route is added that is neither decorated nor listed here.

The numbers are per client IP per minute and are deliberately loose: many
customers share one address on carrier-grade NAT, and the aim is to stop
scripted abuse, not to ration a person. ``Retry-After`` tells a well-behaved
client when to come back. Counters live in this process's memory, which is how
the decorator limits behave too (two gunicorn workers, so the effective ceiling
is up to twice the figure).
"""
from __future__ import annotations

import re

from limits import parse
from limits.storage import MemoryStorage
from limits.strategies import MovingWindowRateLimiter

#: group -> limit. A group is one bucket per client IP.
GROUPS: dict[str, str] = {
    "token_refresh": "30/minute",   # the refresh token is the credential; no reason to hammer it
    "coupon_check": "20/minute",    # guessing codes
    "flight_search": "30/minute",   # each call can spend supplier quota
    "price_quote": "60/minute",     # re-read on every seat / add-on change
    "catalogue": "180/minute",      # cheap reads: destinations, hotels, packages, reference data
}

_SEG = r"[^/]+"

#: (method, path regex, group). Anchored full-path matches.
RULES: list[tuple[str, re.Pattern, str]] = [
    (m, re.compile(f"^{pattern}$"), group)
    for m, pattern, group in [
        ("POST", r"/api/auth/refresh", "token_refresh"),
        ("POST", r"/api/customer/auth/refresh", "token_refresh"),
        ("POST", r"/api/customer/coupons/validate", "coupon_check"),
        ("GET", r"/api/customer/flights/search", "flight_search"),
        ("GET", r"/api/customer/flights/seatmap", "flight_search"),
        ("POST", r"/api/customer/bookings/quote", "price_quote"),
        ("POST", r"/api/customer/hotel-bookings/quote", "price_quote"),
        ("POST", r"/api/customer/package-bookings/quote", "price_quote"),
        ("GET", r"/api/customer/addons", "catalogue"),
        ("GET", r"/api/customer/coupons", "catalogue"),
        ("GET", r"/api/customer/auth/google/config", "catalogue"),
        ("GET", r"/api/customer/payment-methods", "catalogue"),
        ("GET", r"/api/customer/payments/config", "catalogue"),
        ("GET", r"/api/customer/reference", "catalogue"),
        ("GET", r"/api/customer/reviews", "catalogue"),
        ("GET", r"/api/customer/travellers/passport/availability", "catalogue"),
        ("GET", r"/api/customer/destinations", "catalogue"),
        ("GET", rf"/api/customer/destinations/{_SEG}/(attractions|hotels|locations)", "catalogue"),
        ("GET", rf"/api/customer/destinations/{_SEG}/attractions/{_SEG}", "catalogue"),
        ("GET", rf"/api/customer/attractions/{_SEG}/hotels", "catalogue"),
        ("GET", rf"/api/customer/locations/{_SEG}/hotels", "catalogue"),
        ("GET", r"/api/customer/hotels", "catalogue"),
        ("GET", r"/api/customer/hotels/(addons|rooms)", "catalogue"),
        ("GET", rf"/api/customer/hotels/{_SEG}", "catalogue"),
        ("GET", r"/api/customer/packages", "catalogue"),
        ("GET", r"/api/customer/packages/(addons|departures|facets|trip-types)", "catalogue"),
        ("GET", rf"/api/customer/packages/{_SEG}", "catalogue"),
    ]
]

#: Public routes that are intentionally not limited here: health probes (the
#: load balancer and Docker poll them) and routes that already carry their own
#: ``@limiter.limit``. Anything else public must be in RULES.
EXEMPT_PATHS = {"/api/health", "/api/status"}

_storage = MemoryStorage()
_strategy = MovingWindowRateLimiter(_storage)
_items = {name: parse(spec) for name, spec in GROUPS.items()}


def group_for(method: str, path: str) -> str | None:
    for m, rx, group in RULES:
        if m == method and rx.match(path):
            return group
    return None


def check(method: str, path: str, client: str) -> tuple[bool, int]:
    """``(allowed, retry_after_seconds)`` for one request; counts it when it is limited."""
    group = group_for(method, path)
    if group is None:
        return True, 0
    item = _items[group]
    if _strategy.hit(item, group, client):
        return True, 0
    reset, _remaining = _strategy.get_window_stats(item, group, client)
    import time
    return False, max(1, int(reset - time.time()) + 1)


def reset() -> None:
    """Forget every counter. For tests."""
    _storage.reset()
