"""Where first / middle / last meet the outside world.

A traveller is stored and edited as three independent names. Airlines, hotels
and package operators take a *given name*, so the combination happens in one
place -- here -- at the booking boundary, never earlier and never by splitting a
string back apart.
"""
from __future__ import annotations

#: ``first_name`` columns on the booking tables are String(100).
GIVEN_NAME_MAX = 100


def compose_given_name(first: str | None, middle: str | None = None) -> str:
    """"First Middle" with blanks dropped. Either part may be missing."""
    return " ".join(p for p in ((first or "").strip(), (middle or "").strip()) if p)
