"""Provider Management schemas (0039).

Every money field is ``Decimal`` and reaches the browser as a decimal **string**,
the rule stated in `docs/WALLET_ARCHITECTURE.md` §2.4 and applied by
`schemas/payment_admin.py`. Provider totals are sums over booking amounts, so
they are money and are typed accordingly — a float here would drop paise on a
supplier's yearly total.

**Nothing in this module has a password, a role or a permission field.** A
provider is a supplier we buy from, not a user of this application, and the
absence is deliberate rather than an oversight.
"""
import datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, EmailStr, Field


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------
class CreateProvider(BaseModel):
    """Only the name. ``provider_code`` is allocated from a sequence and is
    never accepted from a client — see ``provider_service.create_provider``."""

    provider_name: str = Field(min_length=2, max_length=200)


class UpdateProvider(BaseModel):
    """Both optional: this is a PATCH, and sending neither is a no-op 400."""

    provider_name: Optional[str] = Field(default=None, min_length=2, max_length=200)
    status: Optional[Literal["active", "inactive"]] = None


class CreateProviderUser(BaseModel):
    user_name: str = Field(min_length=2, max_length=150)
    #: Validated as an address because it is how the desk contacts this person.
    #: It is **not** a login — see the ProviderUser model docstring.
    email: EmailStr
    phone_number: Optional[str] = Field(default=None, max_length=30)


class UpdateProviderUser(BaseModel):
    user_name: Optional[str] = Field(default=None, min_length=2, max_length=150)
    email: Optional[EmailStr] = None
    phone_number: Optional[str] = Field(default=None, max_length=30)
    status: Optional[Literal["active", "inactive"]] = None


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------
class ProviderUserOut(BaseModel):
    """One person at a provider, with their derived booking totals.

    ``tickets_booked`` and ``total_amount`` are computed from bookings on every
    read — there is no stored counter to drift out of step. A user who has
    booked nothing reads 0 / "0.00" rather than being omitted.
    """

    id: int
    provider_id: int
    user_name: str
    email: str
    phone_number: Optional[str] = None
    status: str
    tickets_booked: int = 0
    total_amount: Decimal = Decimal("0.00")
    created_at: datetime.datetime
    updated_at: datetime.datetime


class ProviderOut(BaseModel):
    """A row on the Provider Management list."""

    id: int
    provider_code: str
    provider_name: str
    status: str
    total_tickets: int = 0
    total_amount: Decimal = Decimal("0.00")
    #: Included on the list so the UI can say "cannot be deleted" without a
    #: second call. The module exposes no delete at all, so this drives wording
    #: rather than a button.
    user_count: int = 0
    created_at: datetime.datetime
    updated_at: datetime.datetime


class ProviderListResponse(BaseModel):
    items: list[ProviderOut]
    total: int
    page: int
    page_size: int


class ProviderBookingOut(BaseModel):
    """A recent booking bought through this provider.

    Deliberately a *projection*, not the full booking: this screen answers "what
    did we buy from this supplier", and re-serialising the whole
    ``ServiceRequest`` here would duplicate the booking API's shape in a second
    place that then has to be kept in step with it.
    """

    id: int
    request_number: str
    passenger_name: Optional[str] = None
    airline: Optional[str] = None
    travel_date: Optional[datetime.date] = None
    amount: Decimal = Decimal("0.00")
    provider_user_name: Optional[str] = None
    ticket_issued_at: Optional[datetime.datetime] = None
    ticket_number: Optional[str] = None


class ProviderStats(BaseModel):
    total_tickets: int = 0
    total_amount: Decimal = Decimal("0.00")
    #: Sent rather than left to the client to divide: a browser doing
    #: ``total / count`` on two decimal strings is a float division, and this is
    #: money. Zero bookings gives "0.00", not a division by zero.
    average_ticket_value: Decimal = Decimal("0.00")
    provider_user_count: int = 0


class ProviderDetailResponse(BaseModel):
    provider: ProviderOut
    stats: ProviderStats
    users: list[ProviderUserOut]
    recent_bookings: list[ProviderBookingOut]


class ProviderOptionUser(BaseModel):
    id: int
    user_name: str


class ProviderOption(BaseModel):
    """One entry in the Booking Operations provider dropdown, with its people
    already attached so selecting a provider needs no second round trip."""

    id: int
    provider_code: str
    provider_name: str
    users: list[ProviderOptionUser]


class ProviderOptionsResponse(BaseModel):
    items: list[ProviderOption]
