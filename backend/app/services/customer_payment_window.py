"""How long a booking stays payable, in one place.

WHY THIS IS NOT THREE COPIES
Flights, hotels and packages each have their own booking service, and each one
guards its own checkout. The rule about *when* a booking stops being payable is
the same for all three, and a rule copied three times is a rule that will one
day mean three different things -- which, here, means one product quietly taking
money for a booking the other two would have refused.

WHY A BOOKING EXPIRES AT ALL
A booking is written before the traveller pays, because the provider needs
something to open an order against. For hotels that write also decrements room
inventory -- that is what stops two people taking the last room while one of
them is still typing. So an abandoned booking holds a room, and without a
window it holds it forever.

WHY IT IS COMPUTED AND NEVER STORED
Nothing writes an ``expired`` row. The window is derived from the booking's own
``created_at`` every time payability is asked about, so there is no sweep job to
stall, no row to fall out of step with the clock, and no migration. A booking
that is confirmed or cancelled is not subject to it at all -- the window governs
the gap between creating a booking and paying for it, and nothing else.
"""

from __future__ import annotations

import datetime as dt

#: The gap a traveller gets between booking and paying.
#:
#: Thirty minutes is about how long somebody takes to pay in one sitting, with
#: room for a declined card and a second attempt. It is deliberately short
#: because hotel inventory is held for the whole of it.
PAYMENT_WINDOW_MINUTES = 30


def window_closed(created_at: dt.datetime | None, *, now: dt.datetime | None = None) -> bool:
    """Has this booking's payment window passed?

    ``created_at`` may be naive or aware -- rows written by different paths have
    differed historically, and a comparison that raises here would refuse a
    payment that should have been allowed. A missing timestamp returns False:
    when we cannot tell how old a booking is, the safe answer is to let the
    traveller pay and let the ordinary guards decide, not to refuse them.
    """
    if created_at is None:
        return False

    now = now or dt.datetime.now(dt.timezone.utc)
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)

    age = now - created_at
    return age > dt.timedelta(minutes=PAYMENT_WINDOW_MINUTES)


def expired_message(booking_ref: str) -> str:
    """What the traveller is told. Says what happened and what to do next."""
    return (
        f"{booking_ref} was held for {PAYMENT_WINDOW_MINUTES} minutes and that "
        "time has passed, so it can no longer be paid for. Please make a new "
        "booking -- nothing has been charged."
    )


def refunded_message(booking_ref: str) -> str:
    return (
        f"The payment for {booking_ref} was refunded, so it cannot be paid for "
        "again. Please make a new booking."
    )
