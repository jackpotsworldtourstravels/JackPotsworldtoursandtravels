"""Hotel-side error types for TBO.

TBO is ONE supplier with ONE authentication across flights and hotels, so the
hotel adapter reuses the same vocabulary of failure defined in the flight
package — re-exported here so hotel code can import from its own package and a
future split stays cheap. The only hotel-specific addition is a price/policy
change alias, which reads more naturally than the flight ``TBOPriceChanged`` at
a hotel Book that returns VerifyPrice.
"""
from __future__ import annotations

from app.integrations.tbo.exceptions import (  # noqa: F401  (re-exported)
    TBOAPIError,
    TBOError,
    TBONotConfigured,
    TBOPriceChanged,
    TBOSessionExpired,
    TBOTimeout,
    TBOTransportError,
)


class TBOHotelPriceChanged(TBOPriceChanged):
    """A hotel re-price (PreBook, or a Book returning Status 3 VerifyPrice)
    came back at a new NetAmount. Same contract as the flight price-change: we
    never confirm at a price the customer did not see."""


__all__ = [
    "TBOError",
    "TBONotConfigured",
    "TBOTimeout",
    "TBOTransportError",
    "TBOAPIError",
    "TBOSessionExpired",
    "TBOPriceChanged",
    "TBOHotelPriceChanged",
]
