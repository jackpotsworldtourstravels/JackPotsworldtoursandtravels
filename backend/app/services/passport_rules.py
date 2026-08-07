"""The passport validity rule, in one place, for every flow that judges one.

WHY THIS MODULE EXISTS
Three unrelated code paths ask the same question — "is this passport good for
this journey?" — and until 2026-08-07 they gave three different answers:

* ``ticket_service._validate_classic_submission`` refused an expiry on or
  before the travel date (Booking Request and Direct Booking).
* ``group_booking_service`` refused an expiry before the travel date on an
  uploaded manifest row.
* ``passport_ocr_service.assess_passport`` *warned* — and only warned — when
  the expiry fell inside six months of travel.

So the platform could tell a merchant, in the scan panel, that a passport would
be refused at the counter and then accept the booking anyway. The six-month
figure is now the rule everywhere and it refuses the submission, which is what
this module is: the figure, the arithmetic, and the sentence, written once.

Deliberately free of every other import in ``app.services`` — ``ticket_service``
and ``passport_ocr_service`` already import each other in one direction, and a
shared helper that sat in either of them would close the cycle.
"""
from __future__ import annotations

import datetime as dt

from app.config import settings

#: The one sentence the merchant reads, whichever surface refuses the booking.
#: Worded exactly as the change request asked for it.
SIX_MONTH_MESSAGE = (
    "Passport must be valid for at least 6 months from the travel date."
)


#: The rule when nothing configures it. Six months is the near-universal
#: carrier and immigration requirement.
DEFAULT_VALIDITY_MONTHS = 6


def validity_months() -> int:
    """How many clear months a passport needs beyond the travel date.

    Read through ``settings`` rather than frozen as a constant so a deployment
    flying only to countries with a three-month requirement can lower it in one
    place — and so the scan panel's assessment and the refusal at submit can
    never quote different figures.

    ``getattr`` WITH A DEFAULT, DELIBERATELY, and this is not defensive
    programming for its own sake: ``passport_validity_months`` is declared
    inside the passport-scanning block of ``config.py``, and this rule is
    enforced on deployments that do not run scanning at all. A hard attribute
    read would make the booking form's own validation depend on a feature it has
    nothing to do with. When the setting is present it wins; when it is not, the
    rule still applies at its default.
    """
    return getattr(settings, "passport_validity_months", DEFAULT_VALIDITY_MONTHS)


def as_date(value: dt.date | str | None) -> dt.date | None:
    """A ``date`` from a date, a datetime or an ISO string; ``None`` otherwise.

    Tolerant on purpose: the callers include a Pydantic model (already a
    ``date``), a spreadsheet cell (anything at all) and a JSON field written by
    an OCR provider (a string).
    """
    if value is None or value == "":
        return None
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def add_months(base: dt.date, months: int) -> dt.date:
    """``base`` plus N calendar months, clamped to the end of a short month.

    31 Aug + 6 months is 28 or 29 February, not "31 February". Written out
    rather than pulled from dateutil, which this project does not depend on.
    """
    month_index = base.month - 1 + months
    year = base.year + month_index // 12
    month = month_index % 12 + 1
    day = min(base.day, _days_in_month(year, month))
    return dt.date(year, month, day)


def required_valid_until(travel_date: dt.date | str | None) -> dt.date | None:
    """The earliest expiry that clears the rule for this journey.

    ``None`` when there is no travel date to measure against — the caller then
    has nothing to check, which is not the same as a pass.
    """
    travel = as_date(travel_date)
    if travel is None:
        return None
    return add_months(travel, validity_months())


def is_long_enough(
    expiry: dt.date | str | None, travel_date: dt.date | str | None
) -> bool:
    """Does ``expiry`` leave the required clear months after ``travel_date``?

    ``True`` when either date is missing: an absent expiry is a *separate*
    question (whether the field is required at all) and answering it here would
    make every caller's "is it long enough" read as "is it present".
    """
    expiry_date = as_date(expiry)
    required = required_valid_until(travel_date)
    if expiry_date is None or required is None:
        return True
    return expiry_date >= required


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (dt.date(year, month + 1, 1) - dt.timedelta(days=1)).day
