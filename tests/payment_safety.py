"""Refuse to run the B2C payment fixtures anywhere that can take real money.

WHY THIS FILE EXISTS
``payfix.py`` books through the real API and opens a real provider checkout, and
it takes the provider from live settings::

    self.provider = (C.settings.payment_provider or "mock")

So with ``PAYMENT_PROVIDER=trustbrick`` it drives Tours -> TrustBrick -> Razorpay
and opens orders on the live merchant account. Nothing stopped that except an
unset environment variable: ``config.BASE`` defaults to localhost, but honours
``JPW_BASE``, and one exported variable was the whole distance between a suite
run and live Razorpay orders.

THE TWO CONDITIONS, BOTH REQUIRED
    * the target is loopback -- a machine that cannot be production;
    * the payment provider is ``mock`` -- an adapter that opens orders nobody
      can pay and that moves no money by construction.

Either alone is not enough. Loopback with a real provider still reaches
Razorpay, because the provider is chosen by configuration and not by the address
the test posts to. A real host with the mock provider still writes bookings and
holds inventory in a database customers are using.

THERE IS NO OVERRIDE, DELIBERATELY
No flag, no environment variable, no argument turns this off. An escape hatch
gets used -- in a hurry, by someone who has read less of this than you have --
and the thing on the other side of it is somebody's money. To run these tests
against a different environment, point them at it properly: run a local server,
or set ``PAYMENT_PROVIDER=mock`` where they are aimed.
"""

from __future__ import annotations

import urllib.parse

#: Hosts that cannot be production by construction. Loopback, plus the two TLDs
#: RFC 6761 reserves for testing and which can never resolve publicly.
_LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0", ""})
_SAFE_SUFFIXES = (".localhost", ".test")

#: The only provider these fixtures may drive. The mock opens orders that can
#: never be paid, which is exactly what a test needs and exactly what production
#: must never have.
REQUIRED_PROVIDER = "mock"


class UnsafePaymentEnvironment(RuntimeError):
    """Raised instead of doing anything. Carries every reason, not the first."""


def is_local(base: str) -> bool:
    """Is this a target that cannot possibly be production?

    Judged on the HOST, not on the string: ``http://localhost.evil.com`` is not
    local and a substring check would have said it was.
    """
    host = urllib.parse.urlsplit(base or "").hostname
    if host is None:
        # No scheme, so urlsplit found no host. Treat the whole value as one.
        host = (base or "").split("/")[0].split(":")[0]
    host = (host or "").lower().strip("[]")
    if host in _LOOPBACK:
        return True
    return any(host.endswith(sfx) for sfx in _SAFE_SUFFIXES)


def problems(base: str, provider: str | None) -> list[str]:
    """Every reason this environment is unsafe. Empty means safe.

    Pure: reads nothing, opens nothing, writes nothing. That is what lets the
    caller check before it has done anything it would regret.
    """
    found = []
    if not is_local(base):
        found.append(
            f"target is {base!r}, which is not a loopback or .test address -- "
            f"these fixtures create bookings and open provider checkouts, and "
            f"must never be pointed at a real deployment"
        )
    normalised = (provider or "").strip().lower()
    if normalised != REQUIRED_PROVIDER:
        found.append(
            f"PAYMENT_PROVIDER is {provider!r}, not {REQUIRED_PROVIDER!r} -- "
            f"any other provider opens orders on a real merchant account"
        )
    return found


#: Distinguishes "not supplied, read the live value" from "supplied as None".
#: The second is the unset-provider case, which is precisely what must be
#: refused -- so it must not be mistaken for a request to go and look it up.
_UNSET = object()


def enforce(base=_UNSET, provider=_UNSET) -> None:
    """Raise unless both conditions hold. Call before doing ANYTHING else.

    Arguments exist so the guard can be tested without touching the process's
    real configuration. They are not an override: omitting them reads the live
    values, and supplying them still has to pass the same two checks.
    """
    if base is _UNSET:
        from config import BASE

        base = BASE
    if provider is _UNSET:
        import app.config as C

        provider = getattr(C.settings, "payment_provider", None)

    found = problems(base, provider)
    if found:
        raise UnsafePaymentEnvironment(
            "Refusing to run B2C payment fixtures.\n  - "
            + "\n  - ".join(found)
        )


def guard_or_exit() -> None:
    """``enforce``, but ending the process cleanly instead of with a traceback.

    Used at import time by the fixtures themselves, where a stack trace would
    bury the one sentence that matters.
    """
    import sys

    try:
        enforce()
    except UnsafePaymentEnvironment as exc:
        print(f"\n{exc}\n", file=sys.stderr)
        raise SystemExit(2)
