"""A package departure that has already left cannot be sold.

THE BUG. `GET /packages/departures` listed every active departure, past ones
included, and `get_departure()` — the lookup the quote endpoint and
`create_booking()` both price from — checked only id, package and
`is_active`. So a departure from last month could be offered on the Departure
step, quoted, booked and handed to payment. The package detail endpoint and
the facets already applied `departure_date >= today`; the selling paths did
not.

WHAT IS PINNED HERE
  * get_bookable_departure(): past -> None; today and future -> the row;
    inactive -> None (as before).
  * get_departure() still finds a past departure — cancelling a booking whose
    trip has happened must still release its seats.
  * The pricing path create_booking() uses rejects a past departure with the
    same "not available" message an unknown one gets, and prices a future one.
  * The departures list the Departure step reads contains only live dates,
    in the same shape as before.
"""
from __future__ import annotations

import datetime as dt
from types import SimpleNamespace

import pytest

from app.models_customer import Base, CustomerPackageDeparture
from app.services import customer_package_booking_service as booking_service
from app.services import customer_package_catalog_service as catalog

TODAY = dt.date.today()


@pytest.fixture()
def pkg_db(db):
    """The harness's session, plus the departures table. The package row
    itself is not stored: its ARRAY columns cannot bind on SQLite, SQLite does
    not enforce the foreign key, and everything here reads the package only
    through catalog.get_package(), which each test stubs."""
    Base.metadata.create_all(db.get_bind(), tables=[CustomerPackageDeparture.__table__])
    return db


def _package(db, pid=501):
    return SimpleNamespace(customer_package_id=pid, is_international=False, departures=[])


def _departure(db, pkg, did, when, *, active=True, seats=10, price=21000):
    d = CustomerPackageDeparture(
        customer_package_departure_id=did, package_id=pkg.customer_package_id,
        departure_date=when, price_per_person=price, seats_left=seats, is_active=active,
    )
    db.add(d)
    db.flush()
    return d


@pytest.fixture()
def trip(pkg_db):
    pkg = _package(pkg_db)
    rows = {
        "past": _departure(pkg_db, pkg, 1, TODAY - dt.timedelta(days=30)),
        "yesterday": _departure(pkg_db, pkg, 2, TODAY - dt.timedelta(days=1)),
        "today": _departure(pkg_db, pkg, 3, TODAY),
        "future": _departure(pkg_db, pkg, 4, TODAY + dt.timedelta(days=21)),
        "inactive": _departure(pkg_db, pkg, 5, TODAY + dt.timedelta(days=28), active=False),
    }
    # The router reads `package.departures`, as the ORM relationship would give it.
    pkg.departures.extend(sorted(rows.values(), key=lambda d: d.departure_date))
    return {"pkg": pkg, **rows}


# --- the lookup ----------------------------------------------------------------

def test_past_departures_are_not_bookable(pkg_db, trip):
    pid = trip["pkg"].customer_package_id
    assert catalog.get_bookable_departure(pkg_db, pid, 1) is None
    assert catalog.get_bookable_departure(pkg_db, pid, 2) is None


def test_today_and_future_departures_are_bookable(pkg_db, trip):
    pid = trip["pkg"].customer_package_id
    assert catalog.get_bookable_departure(pkg_db, pid, 3) is trip["today"]
    assert catalog.get_bookable_departure(pkg_db, pid, 4) is trip["future"]


def test_inactive_and_foreign_departures_stay_unbookable(pkg_db, trip):
    pid = trip["pkg"].customer_package_id
    assert catalog.get_bookable_departure(pkg_db, pid, 5) is None
    assert catalog.get_bookable_departure(pkg_db, pid + 1, 4) is None   # wrong package


def test_plain_lookup_still_finds_past_departures_for_cancellation(pkg_db, trip):
    """cancel_booking() releases seats through get_departure(); a trip that
    has already happened must still be found."""
    pid = trip["pkg"].customer_package_id
    assert catalog.get_departure(pkg_db, pid, 1) is trip["past"]


# --- the selling path ----------------------------------------------------------

def test_pricing_a_past_departure_is_refused(pkg_db, trip, monkeypatch):
    monkeypatch.setattr(catalog, "get_package", lambda db, pid: trip["pkg"])
    called = []
    monkeypatch.setattr(booking_service.pricing, "quote", lambda *a, **k: called.append(1) or {})
    with pytest.raises(booking_service.PackageBookingError, match="not available"):
        booking_service._price_trip(
            pkg_db, {"package_id": trip["pkg"].customer_package_id, "departure_id": 1, "pax_count": 2},
            [], None,
        )
    assert not called, "a past departure must be refused before it is priced"


def test_pricing_a_future_departure_still_works(pkg_db, trip, monkeypatch):
    monkeypatch.setattr(catalog, "get_package", lambda db, pid: trip["pkg"])
    monkeypatch.setattr(booking_service.pricing, "quote", lambda *a, **k: {"total": 42000})
    priced = booking_service._price_trip(
        pkg_db, {"package_id": trip["pkg"].customer_package_id, "departure_id": 4, "pax_count": 2},
        [], None,
    )
    assert priced["departure"] is trip["future"]
    assert priced["pax_count"] == 2


# --- the list the Departure step reads -----------------------------------------

def test_departures_list_offers_only_live_dates(pkg_db, trip, monkeypatch):
    from app.routers import customer_package_bookings as router

    pkg = trip["pkg"]
    monkeypatch.setattr(router.catalog, "get_package", lambda db, pid: pkg)
    rows = router.get_package_departures(package=pkg.customer_package_id, db=pkg_db)
    assert [r["id"] for r in rows] == ["3", "4"]
    # Same shape as before: the frontend's Departure step reads exactly these.
    assert set(rows[0]) == {"id", "date", "seatsLeft", "price"}
    assert all(r["date"] >= TODAY.isoformat() for r in rows)


# --- Issue #5: international packages must show their departure dates ----------
# Reproduction attempt + regression guard. The report said departure dates were
# not visible for INTERNATIONAL packages. The selling/listing paths filter a
# departure only on is_active + "date >= today" (see get_bookable_departure and
# get_package_departures); NOTHING keys off is_international. This pins that: a
# package with is_international=True exposes exactly the same live departures a
# domestic one would, so a future change that accidentally gates dates on the
# international flag fails here.

def test_international_package_departures_are_visible_like_domestic(pkg_db, monkeypatch):
    from app.routers import customer_package_bookings as router

    intl = SimpleNamespace(customer_package_id=777, is_international=True, departures=[])
    past = _departure(pkg_db, intl, 101, TODAY - dt.timedelta(days=10))
    today = _departure(pkg_db, intl, 102, TODAY)
    future = _departure(pkg_db, intl, 103, TODAY + dt.timedelta(days=40))
    intl.departures.extend([past, today, future])

    monkeypatch.setattr(router.catalog, "get_package", lambda db, pid: intl)
    rows = router.get_package_departures(package=intl.customer_package_id, db=pkg_db)

    # The international package's own live departures are offered on the Departure
    # step — the past one trimmed, today and future shown, dates present.
    assert [r["id"] for r in rows] == ["102", "103"]
    assert all(r["date"] >= TODAY.isoformat() and r["date"] for r in rows)
    # And they are bookable (the quote/create path prices them), just like domestic.
    assert catalog.get_bookable_departure(pkg_db, intl.customer_package_id, 103) is future


def test_international_flag_does_not_filter_departures(pkg_db, monkeypatch):
    """The SAME departures, read once as domestic and once as international, must
    produce the identical visible list — proving visibility is flag-independent."""
    from app.routers import customer_package_bookings as router

    def with_flag(flag, base_id):
        p = SimpleNamespace(customer_package_id=base_id, is_international=flag, departures=[])
        p.departures.append(_departure(pkg_db, p, base_id * 10 + 1, TODAY + dt.timedelta(days=15)))
        monkeypatch.setattr(router.catalog, "get_package", lambda db, pid: p)
        return [r["date"] for r in router.get_package_departures(package=p.customer_package_id, db=pkg_db)]

    assert with_flag(False, 80) == with_flag(True, 81), \
        "an international package must show the same departure dates a domestic one does"
