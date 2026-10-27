"""Customer wishlist: saved once per item, owner-scoped, removable.

WHY THIS EXISTS
The wishlist endpoints (`GET/POST/DELETE /api/customer/wishlist`) and their
service layer (`customer_account_service.{list,add,get_owned,remove}_wishlist_item`)
shipped and are used by the Account Center and the heart controls on the hotel
and package surfaces, but carried no server-side test — the only coverage was
the client-side enrichment harness in `frontend/tests/`. That left the two
behaviours that actually matter unpinned: that saving the same item twice does
not stack a second "heart" (the UI toggles, so a double-POST is ordinary), and
that one customer can never read, re-save over, or delete another customer's
saved item. These are the invariants this module locks down. Service-level,
mirroring `test_customer_notifications.py`; no HTTP or real database.
"""
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerWishlistItem
from app.services import customer_account_service as acct
from tests.conftest import _next_id


def _make_table(db: Session):
    # The shared `db` fixture creates only the tables its payment tests touch.
    CustomerWishlistItem.__table__.create(db.get_bind(), checkfirst=True)


def _shim_ids(monkeypatch):
    """SQLite has no identity sequence for the BigInteger PK: supply one."""
    orig = CustomerWishlistItem.__init__

    def init(self, **kw):
        kw.setdefault("customer_wishlist_id", _next_id())
        orig(self, **kw)

    monkeypatch.setattr(CustomerWishlistItem, "__init__", init)


def _other_customer(db):
    c = Customer(customer_id=_next_id(), customer_code="CUST0002", full_name="Other",
                 email="other@example.test", mobile="9000000001")
    db.add(c)
    db.flush()
    return c


def test_saving_the_same_item_twice_keeps_one_heart(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)

    first = acct.add_wishlist_item(db, customer, "hotel", 42)
    again = acct.add_wishlist_item(db, customer, "hotel", 42)

    # Idempotent: the second save returns the existing row, does not insert a
    # second, and never trips the unique constraint.
    assert again.customer_wishlist_id == first.customer_wishlist_id
    assert len(acct.list_wishlist(db, customer)) == 1


def test_same_id_different_type_are_distinct_saves(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)

    acct.add_wishlist_item(db, customer, "hotel", 7)
    acct.add_wishlist_item(db, customer, "package", 7)

    # The identity of a saved item is (type, id) — hotel #7 and package #7 are
    # two different things, so both are kept.
    saved = acct.list_wishlist(db, customer)
    assert len(saved) == 2
    assert {(w.item_type, w.item_id) for w in saved} == {("hotel", 7), ("package", 7)}


def test_list_is_scoped_per_customer(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    other = _other_customer(db)

    acct.add_wishlist_item(db, customer, "hotel", 1)
    acct.add_wishlist_item(db, customer, "package", 2)
    acct.add_wishlist_item(db, other, "hotel", 1)

    assert len(acct.list_wishlist(db, customer)) == 2
    assert len(acct.list_wishlist(db, other)) == 1
    # The same (type, id) saved by two customers are independent rows.
    assert acct.list_wishlist(db, other)[0].item_id == 1


def test_one_customer_cannot_reach_anothers_saved_item(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    other = _other_customer(db)

    mine = acct.add_wishlist_item(db, customer, "hotel", 99)

    # The ownership lookup that backs the DELETE route's 404 must refuse a
    # cross-customer id — this is the control that stops one customer deleting
    # another's saved item by guessing its wishlist id.
    assert acct.get_owned_wishlist_item(db, other, mine.customer_wishlist_id) is None
    assert acct.get_owned_wishlist_item(db, customer, mine.customer_wishlist_id) is mine


def test_remove_deletes_only_the_targeted_row(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)

    keep = acct.add_wishlist_item(db, customer, "hotel", 10)
    drop = acct.add_wishlist_item(db, customer, "package", 20)

    acct.remove_wishlist_item(db, drop)
    db.flush()

    remaining = acct.list_wishlist(db, customer)
    assert [w.customer_wishlist_id for w in remaining] == [keep.customer_wishlist_id]

    # Re-saving after removal is allowed (the heart can be toggled back on).
    resaved = acct.add_wishlist_item(db, customer, "package", 20)
    db.flush()
    assert resaved.customer_wishlist_id != drop.customer_wishlist_id
    assert len(acct.list_wishlist(db, customer)) == 2
