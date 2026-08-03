"""Completing a booking once its journey has actually finished.

WHY THIS EXISTS
Issuing a ticket used to end the booking: ``issue_ticket`` moved it to Ticket
Issued and an Admin then pressed "Mark Completed", usually in the same minute.
So a booking for next March was Completed in August, "Completed Tickets" on
every dashboard meant *tickets sold* rather than *trips taken*, and Booking
History told a merchant a journey was over before anyone had left.

Completion is not a decision anybody takes — it is a fact about the calendar.
This module is the only thing that walks ``Ticket Issued -> Completed``
(``lifecycle.AUTO_TRANSITIONS``), and it walks it for one reason: the scheduled
journey is behind us.

WHAT IT DELIBERATELY DOES NOT DO
Nothing financial, and nothing that generates or sends anything. The wallet is
debited at issuance and stays debited at issuance; documents are generated at
issuance; the merchant is notified at issuance. This service changes a status
and writes one history row. If you find yourself adding a payment, a document or
an email here, it belongs in ``ticket_service.issue_ticket`` instead — a job
that runs on a timer must not be the thing that moves money, because "did it
run twice?" then stops being a harmless question.

THE END OF THE JOURNEY IS THE RETURN LEG WHEN THERE IS ONE
A round trip is not over when the outbound lands. ``return_date`` /
``return_preferred_time`` are used when present and the outbound otherwise, so a
merchant does not see a trip marked finished while its passengers are still
away. A group trip has no return leg by definition (see ``schemas/enquiry.py``)
and is judged on its outbound like a one-way.
"""
from __future__ import annotations

import datetime
import logging

from sqlalchemy import BigInteger, cast, func, literal, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models_v2 import RequestStatus as S
from app.models_v2 import RequestType, ServiceRequest
from app.services import lifecycle

logger = logging.getLogger("jackpots.completion")

#: A 24-hour "HH:MM" we could not parse, or one that was never recorded, must
#: never complete a booking EARLY — so an unknown departure is treated as the
#: last minute of its day rather than the first. A booking with no time at all
#: completes at local midnight following its travel date, which is the latest
#: reading of "that day has passed" and the only safe one.
_FALLBACK_TIME = datetime.time(23, 59)

#: One arbitrary but fixed key, so every process that runs this sweep contends
#: for the same PostgreSQL advisory lock. Changing it would let two deployments
#: sweep concurrently.
#:
#: IT MUST FIT IN A SIGNED 64-BIT INTEGER, and it is cast to one at every use.
#: ``pg_try_advisory_lock`` is only overloaded for ``bigint`` and for a pair of
#: ``int4``; hand it anything else and PostgreSQL raises *"function
#: pg_try_advisory_lock(numeric) does not exist"*. SQLAlchemy infers ``numeric``
#: for a bare Python int of this size, so the cast is load-bearing rather than
#: decorative — without it every sweep would raise, the loop in ``main`` would
#: log it and carry on, and nothing would ever complete.
_ADVISORY_LOCK_KEY = 0x3AC4_0175_C0BB_1E00
assert -(2 ** 63) <= _ADVISORY_LOCK_KEY <= 2 ** 63 - 1, "advisory lock key must fit in bigint"


def _local_tz() -> datetime.timezone:
    """The timezone the travel dates and times are written in.

    ``travel_date`` is a bare DATE and ``preferred_time`` a bare "HH:MM", both
    entered by an Indian merchant against an Indian departure board. Nothing in
    either value records a zone, so one has to be supplied to turn them into an
    instant — and reading them as UTC (which is what every other timestamp in
    this database is) would complete every booking 5½ hours late.
    """
    return datetime.timezone(
        datetime.timedelta(minutes=settings.booking_local_utc_offset_minutes)
    )


def _parse_hhmm(value: object) -> datetime.time | None:
    if not isinstance(value, str):
        return None
    try:
        hour, _, minute = value.strip().partition(":")
        return datetime.time(int(hour), int(minute))
    except (ValueError, TypeError):
        return None


def journey_end(request: ServiceRequest) -> datetime.datetime | None:
    """When this booking's travel is scheduled to be over.

    A timezone-**aware** datetime, carrying the local offset rather than UTC. It
    is the same instant either way and compares correctly against a UTC ``now``;
    it is left in local time because that is the wall clock the value was
    written against, and converting it would only make the number harder to
    check against the booking on screen. Do not ``.replace(tzinfo=utc)`` it —
    that would move the instant by the offset rather than express it differently.

    ``None`` when there is no travel date to judge it by — a booking with no
    itinerary date is never completed by this service, because guessing would
    mean closing a booking nobody can prove has travelled.
    """
    details = request.travel_details or {}

    # The return leg decides, when there is one.
    if request.return_date is not None:
        end_date = request.return_date
        end_time = _parse_hhmm(details.get("return_preferred_time"))
    else:
        end_date = request.travel_date
        end_time = _parse_hhmm(details.get("preferred_time"))

    if end_date is None:
        return None

    naive = datetime.datetime.combine(end_date, end_time or _FALLBACK_TIME)
    scheduled = naive.replace(tzinfo=_local_tz())
    return scheduled + datetime.timedelta(hours=settings.booking_completion_buffer_hours)


def is_due(request: ServiceRequest, now: datetime.datetime | None = None) -> bool:
    """Has this booking's scheduled journey finished?"""
    end = journey_end(request)
    if end is None:
        return False
    return (now or datetime.datetime.now(datetime.timezone.utc)) > end


def _candidates(db: Session, now: datetime.datetime) -> list[ServiceRequest]:
    """Ticket-issued bookings whose travel date could plausibly have passed.

    A COARSE DATE FILTER IN SQL, THE EXACT ANSWER IN PYTHON.
    The departure time lives in JSONB and the offset is a setting, so the true
    cutoff is not something an index can be asked about. What SQL *can* do
    cheaply — via ``ix_sr_travel_date`` — is discard everything travelling after
    today, which is nearly all of it. Whatever survives is then judged to the
    minute by :func:`is_due`. The window is a day wide on purpose: a booking
    departing at 23:50 local is still "today" hours after UTC has rolled over.
    """
    local_today = now.astimezone(_local_tz()).date()
    horizon = local_today + datetime.timedelta(days=1)

    end_date = func.coalesce(ServiceRequest.return_date, ServiceRequest.travel_date)
    return list(
        db.scalars(
            select(ServiceRequest)
            .where(
                ServiceRequest.status == S.TICKET_ISSUED,
                ServiceRequest.request_type == RequestType.BOOKING,
                or_(
                    ServiceRequest.travel_date.is_not(None),
                    ServiceRequest.return_date.is_not(None),
                ),
                end_date <= horizon,
            )
            .order_by(end_date)
            .limit(settings.booking_completion_batch_size)
        )
    )


def sweep(db: Session, now: datetime.datetime | None = None) -> int:
    """Complete every ticketed booking whose journey is over. Returns the count.

    Idempotent and restartable. It only ever reads rows that are *currently*
    Ticket Issued, so a booking already completed, cancelled or rescheduled is
    invisible to the next run — and a run that dies halfway has still committed
    the bookings it got to, because each is committed on its own. One row that
    fails must not strand the rest: a booking with an unparseable itinerary is
    logged and skipped, not allowed to abort the sweep.

    A booking whose travel passed while this was switched off is completed on
    the next run. There is no catch-up mode because there is nothing to catch up
    on — "is the journey behind us?" gives the same answer whenever it is asked.
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    completed = 0

    for booking in _candidates(db, now):
        # RE-READ, DELIBERATELY. Committing the previous booking expired every
        # object in this session, so touching `booking` here reloads it — which
        # is what makes the two checks below reflect the row as it is NOW rather
        # than as it was when the candidate query ran. A booking cancelled or
        # rescheduled in that window is skipped quietly instead of being fought
        # over, and the cost is one SELECT on a job that runs every 15 minutes.
        if booking.status is not S.TICKET_ISSUED:
            continue
        if not is_due(booking, now):
            continue
        try:
            lifecycle.transition(
                db, booking, S.COMPLETED, None,
                note="Scheduled travel completed",
                commit=False, automatic=True,
            )
            db.commit()
            completed += 1
        except Exception:
            # Genuinely unexpected: the status was re-checked a line ago, so
            # this is not a lost race. Full traceback, and carry on — one bad
            # row must not strand the rest of the batch.
            db.rollback()
            logger.exception(
                "Could not complete booking %s (request_id=%s); leaving it as-is",
                booking.request_number, booking.request_id,
            )

    if completed:
        logger.info("Completed %d booking(s) whose travel has finished.", completed)
    return completed


def sweep_once_locked(db: Session) -> int:
    """:func:`sweep`, but only in one process at a time.

    THE DEPLOYMENT RUNS SEVERAL WORKERS AND EACH ONE STARTS THIS TIMER.
    gunicorn is configured with multiple uvicorn workers, so without this every
    worker would sweep on its own schedule and race for the same rows. The
    damage would be bounded — the second writer finds the booking is no longer
    Ticket Issued and ``_find`` refuses the edge — but it would be a stream of
    logged exceptions that mean nothing, which is how a real failure gets
    ignored. A PostgreSQL *session-level* advisory lock costs one round trip and
    makes the loser skip the run entirely.

    ``pg_try_advisory_lock`` never waits: a worker that cannot take the lock has
    nothing to do, because the worker holding it is doing exactly the work this
    one was going to do.
    """
    key = cast(literal(_ADVISORY_LOCK_KEY), BigInteger)
    got_lock = db.scalar(select(func.pg_try_advisory_lock(key)))
    if not got_lock:
        logger.debug("Completion sweep already running elsewhere; skipping this tick.")
        return 0
    try:
        return sweep(db)
    finally:
        # Session-level, so it MUST be released explicitly — a pooled connection
        # is reused, and a leaked lock would silence every later sweep in this
        # process for as long as the app stays up.
        db.execute(select(func.pg_advisory_unlock(key)))
        db.commit()
