"""Small shapes shared across schema modules that would otherwise import each
other in a cycle.

``BookingContact`` used to live in ``schemas/enquiry.py``, which is fine as
long as only modules "above" ``enquiry.py`` in the dependency order need it.
``schemas/hotel_booking.py`` broke that: it needs ``BookingContact`` but is
itself imported by ``schemas/ticket.py`` (for ``HotelGuestResponse``), and
``schemas/enquiry.py`` imports ``schemas/ticket.py`` (for ``PassengerInput``)
— so importing ``BookingContact`` from ``enquiry.py`` closed a real cycle:
hotel_booking -> enquiry -> ticket -> hotel_booking. Moving it here, a leaf
module with no imports of its own from this package, means both
``enquiry.py`` and ``hotel_booking.py`` can depend on it without depending on
each other.
"""
from pydantic import BaseModel, Field


class BookingContact(BaseModel):
    """Who to reach about this booking.

    Held on the request rather than per passenger/guest: the airline (or the
    hotel desk) contacts one person about a party, and duplicating it onto
    every traveller would just be several copies to keep in sync.
    """

    name: str | None = Field(default=None, max_length=120)
    email: str = Field(min_length=3, max_length=255)
    phone: str = Field(min_length=5, max_length=30)
    alternate_phone: str | None = Field(default=None, max_length=30)
