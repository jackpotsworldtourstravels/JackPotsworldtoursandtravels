"""Recently viewed: chronological, deduped, resolved, owner-scoped.

``recommendation_service.get_recently_viewed`` turns the raw `view` signals in
``customer_activity`` into "take me back to what I just looked at" — distinct
from the scorer. These pin the behaviour that matters: newest first, one row per
item (at its most recent view), only hotels/packages (not destinations or other
signals), items missing from the catalogue dropped (never dangling), and one
customer's list never leaking another's.

The catalogue lookups are monkeypatched to small stand-ins so the test is about
the chronology/resolution logic, not the catalogue query machinery (which has
its own tests). Only Customer + CustomerActivity are real, on the SQLite harness.
"""
import datetime as dt
from types import SimpleNamespace

from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerActivity
from app.services import recommendation_service as rs
from tests.conftest import _next_id

UTC = dt.timezone.utc


def _make_table(db: Session):
    CustomerActivity.__table__.create(db.get_bind(), checkfirst=True)


def _shim_ids(monkeypatch):
    orig = CustomerActivity.__init__

    def init(self, **kw):
        kw.setdefault("activity_id", _next_id())
        orig(self, **kw)

    monkeypatch.setattr(CustomerActivity, "__init__", init)


def _view(db, customer, entity_type, entity_id, when):
    db.add(CustomerActivity(
        customer_id=customer.customer_id, activity_type="view",
        entity_type=entity_type, entity_id=str(entity_id), created_at=when,
    ))
    db.flush()


def _other_customer(db):
    c = Customer(customer_id=_next_id(), customer_code="CUST0002", full_name="Other",
                 email="other@example.test", mobile="9000000001")
    db.add(c)
    db.flush()
    return c


def _fake_catalogues(monkeypatch):
    hotels = [
        SimpleNamespace(customer_hotel_id=1, name="Taj Palace", image_key="taj",
                        location="Banjara Hills, Hyderabad", price_per_night=12500),
        SimpleNamespace(customer_hotel_id=2, name="Novotel", image_key=None,
                        location="Vizag", price_per_night=8200),
    ]
    packages = [
        SimpleNamespace(customer_package_id=7, name="Dubai Escape", image_key="dxb",
                        destination="Dubai", price_from=54900, is_active=True),
        SimpleNamespace(customer_package_id=8, name="Retired Goa", image_key=None,
                        destination="Goa", price_from=30000, is_active=False),
    ]
    monkeypatch.setattr(rs.hotels_catalog, "list_hotels", lambda db: hotels)
    monkeypatch.setattr(rs.packages, "list_packages", lambda db: packages)


def test_empty_when_no_activity(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    _fake_catalogues(monkeypatch)
    assert rs.get_recently_viewed(db, customer.customer_id) == []


def test_newest_first_and_deduped_to_most_recent_view(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    _fake_catalogues(monkeypatch)

    base = dt.datetime(2026, 10, 1, 9, 0, tzinfo=UTC)
    _view(db, customer, "hotel", 1, base)                       # oldest
    _view(db, customer, "package", 7, base + dt.timedelta(hours=1))
    _view(db, customer, "hotel", 1, base + dt.timedelta(hours=2))  # hotel 1 again, newest

    items = rs.get_recently_viewed(db, customer.customer_id)
    # Hotel 1 appears ONCE, at its most recent view, so it leads; package 7 next.
    assert [(i.type, i.id) for i in items] == [("hotel", "1"), ("package", "7")]
    # Wall-clock compare: the SQLite harness does not round-trip tzinfo (the real
    # column is timezone=True); the point here is it kept the NEWEST view time.
    assert items[0].viewed_at.replace(tzinfo=None) == (base + dt.timedelta(hours=2)).replace(tzinfo=None)


def test_resolves_names_prices_and_location(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    _fake_catalogues(monkeypatch)
    now = dt.datetime(2026, 10, 2, 12, 0, tzinfo=UTC)
    _view(db, customer, "hotel", 2, now)
    _view(db, customer, "package", 7, now - dt.timedelta(minutes=1))

    items = rs.get_recently_viewed(db, customer.customer_id)
    hotel = next(i for i in items if i.type == "hotel")
    pkg = next(i for i in items if i.type == "package")
    assert (hotel.name, hotel.price, hotel.location) == ("Novotel", 8200.0, "Vizag")
    assert (pkg.name, pkg.price, pkg.location) == ("Dubai Escape", 54900.0, "Dubai")


def test_items_missing_from_catalogue_are_dropped(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    _fake_catalogues(monkeypatch)
    now = dt.datetime(2026, 10, 3, 8, 0, tzinfo=UTC)
    _view(db, customer, "hotel", 999, now)                 # not in catalogue
    _view(db, customer, "package", 8, now - dt.timedelta(minutes=1))  # inactive package
    _view(db, customer, "hotel", 1, now - dt.timedelta(minutes=2))    # real

    items = rs.get_recently_viewed(db, customer.customer_id)
    # The dangling hotel and the inactive package are omitted; only hotel 1 remains.
    assert [(i.type, i.id) for i in items] == [("hotel", "1")]


def test_ignores_destinations_and_non_view_signals(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    _fake_catalogues(monkeypatch)
    now = dt.datetime(2026, 10, 4, 8, 0, tzinfo=UTC)
    _view(db, customer, "destination", "goa", now)   # a destination view
    db.add(CustomerActivity(customer_id=customer.customer_id, activity_type="wishlist",
                            entity_type="hotel", entity_id="1", created_at=now))  # not a view
    db.flush()
    _view(db, customer, "package", 7, now - dt.timedelta(minutes=1))  # the only qualifying row

    items = rs.get_recently_viewed(db, customer.customer_id)
    assert [(i.type, i.id) for i in items] == [("package", "7")]


def test_scoped_per_customer(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    _fake_catalogues(monkeypatch)
    other = _other_customer(db)
    now = dt.datetime(2026, 10, 5, 8, 0, tzinfo=UTC)
    _view(db, customer, "hotel", 1, now)
    _view(db, other, "package", 7, now)

    assert [(i.type, i.id) for i in rs.get_recently_viewed(db, customer.customer_id)] == [("hotel", "1")]
    assert [(i.type, i.id) for i in rs.get_recently_viewed(db, other.customer_id)] == [("package", "7")]
