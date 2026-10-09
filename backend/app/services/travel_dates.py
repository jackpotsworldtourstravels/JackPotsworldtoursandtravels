"""Reading a day out of a sentence — only the days that can be read with certainty.

    parse_day("tomorrow")            -> today + 1
    parse_day("day after tomorrow")  -> today + 2
    parse_day("friday")              -> the next Friday after today
    parse_day("next friday")         -> Friday of NEXT WEEK
    parse_day("12 oct")              -> 12 October (this year, or next if it has passed)
    parse_day("oct 12th", ...)       -> the same
    parse_day("12/10")               -> 12 October (day first, as the site's customers write it)
    parse_day("in 3 days")           -> today + 3
    parse_day("2026-12-24")          -> that day

A day nobody said is None, and so is one that cannot be known ("sometime in March",
"next month"). The assistant asks rather than guessing: a wrong date in a search
box is worse than an empty one.

THE RULES THAT ARE JUDGEMENT CALLS, written down so they are decisions and not
accidents:
  * A bare weekday is the next one STRICTLY AFTER today — "friday" said on a Friday
    is a week away, because someone flying today says "today".
  * "next <weekday>" is that weekday in the following calendar week (Monday-based),
    so "next friday" said on a Wednesday is nine days away, not two.
  * A date with no year is the next time it occurs.
  * Day first for "12/10": the customers are Indian.
"""
from __future__ import annotations

import datetime as dt
import re

_MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3, "april": 4, "apr": 4,
    "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7, "august": 8, "aug": 8,
    "september": 9, "sept": 9, "sep": 9, "october": 10, "oct": 10, "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}
_WEEKDAYS = {
    "monday": 0, "mon": 0, "tuesday": 1, "tue": 1, "tues": 1, "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3, "thur": 3, "thurs": 3, "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5, "sunday": 6, "sun": 6,
}
_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
        "nine": 9, "ten": 10}
_MONTH_RE = "|".join(sorted(_MONTHS, key=len, reverse=True))
_DAY_MONTH = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s*(?:of\s+)?({_MONTH_RE})\b(?:\s*,?\s*(\d{{4}}))?", re.I)
_MONTH_DAY = re.compile(rf"\b({_MONTH_RE})\s+(\d{{1,2}})(?:st|nd|rd|th)?\b(?:\s*,?\s*(\d{{4}}))?", re.I)
# 12/10 or 12/10/2026 — and 12-10-2026 ONLY with a year: "a 3-4 day trip" is not 3 April.
_SLASH = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b|\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b")
_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_IN_DAYS = re.compile(r"\b(?:in|after)\s+(\d{1,2}|" + "|".join(_NUM) + r")\s+days?\b", re.I)
_WEEKDAY = re.compile(r"\b(?:(this|next|coming|on)\s+)?(" + "|".join(sorted(_WEEKDAYS, key=len, reverse=True)) + r")\b", re.I)


def _make(year: int, month: int, day: int) -> dt.date | None:
    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


def _upcoming(month: int, day: int, today: dt.date) -> dt.date | None:
    """The next time month/day occurs, today included."""
    d = _make(today.year, month, day)
    if d is not None and d < today:
        d = _make(today.year + 1, month, day)
    return d


def parse_day(text: str | None, today: dt.date | None = None) -> str | None:
    """An ISO day (yyyy-mm-dd) the sentence names with certainty, else None."""
    today = today or dt.date.today()
    raw = text or ""
    lowered = raw.lower()

    iso = _ISO.search(raw)
    if iso:
        d = _make(int(iso[1]), int(iso[2]), int(iso[3]))
        return d.isoformat() if d else None

    # ORDER MATTERS: "day after tomorrow" contains "tomorrow".
    if re.search(r"\bday after tomorrow\b", lowered):
        return (today + dt.timedelta(days=2)).isoformat()
    if re.search(r"\byesterday\b", lowered):
        # Parsed so a day that has gone can be SAID to have gone, not mistaken for nothing.
        return (today - dt.timedelta(days=1)).isoformat()
    if re.search(r"\b(?:tomorrow|tmrw)\b", lowered):
        return (today + dt.timedelta(days=1)).isoformat()
    if re.search(r"\b(?:today|tonight)\b", lowered):
        return today.isoformat()

    m = _IN_DAYS.search(lowered)
    if m:
        n = int(m[1]) if m[1].isdigit() else _NUM[m[1]]
        return (today + dt.timedelta(days=n)).isoformat()

    m = _DAY_MONTH.search(raw)
    if m:
        year = int(m[3]) if m[3] else None
        d = _make(year, _MONTHS[m[2].lower()], int(m[1])) if year else _upcoming(_MONTHS[m[2].lower()], int(m[1]), today)
        return d.isoformat() if d else None
    m = _MONTH_DAY.search(raw)
    if m:
        year = int(m[3]) if m[3] else None
        d = _make(year, _MONTHS[m[1].lower()], int(m[2])) if year else _upcoming(_MONTHS[m[1].lower()], int(m[2]), today)
        return d.isoformat() if d else None

    m = _SLASH.search(raw)
    if m:
        day, month = int(m[1] or m[4]), int(m[2] or m[5])
        yr = m[3] or m[6]
        if yr:
            year = int(yr) + (2000 if int(yr) < 100 else 0)
            d = _make(year, month, day)
        else:
            d = _upcoming(month, day, today)
        return d.isoformat() if d else None

    if re.search(r"\bnext week\b", lowered):
        return (today + dt.timedelta(days=7)).isoformat()

    m = _WEEKDAY.search(raw)
    if m:
        target = _WEEKDAYS[m[2].lower()]
        if (m[1] or "").lower() == "next":
            monday_next_week = today - dt.timedelta(days=today.weekday()) + dt.timedelta(days=7)
            return (monday_next_week + dt.timedelta(days=target)).isoformat()
        ahead = (target - today.weekday()) % 7 or 7
        return (today + dt.timedelta(days=ahead)).isoformat()
    return None


def is_past(day_iso: str | None, today: dt.date | None = None) -> bool:
    """True when the day is before today. Today itself is not past."""
    if not day_iso:
        return False
    try:
        return dt.date.fromisoformat(day_iso) < (today or dt.date.today())
    except ValueError:
        return False


def speak(day_iso: str) -> str:
    """'Sat 10 Oct' — a day as a person reads it back."""
    d = dt.date.fromisoformat(day_iso)
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b')}"
