"""Customer wishlist NOTES: owner-scoped CRUD, blank == NULL, re-save safe.

WHY THIS EXISTS
A signed-in customer can attach a short note to a saved hotel or package
("ask about the May rate"). The note lives on ``customer_wishlist.note`` and is
set/cleared through ``PATCH /api/customer/wishlist/{id}`` (or carried on the
first save). This module pins the behaviour that matters:

  * CRUD          — add with/without a note, change it, clear it.
  * persistence   — the note is what a later read returns.
  * ownership     — one customer can never set or clear another's note.
  * invalid input — an over-long note is refused at the schema edge (422),
                    never truncated.
  * blank == NULL — "", "   " and None are one state, not three.
  * missing item  — a note update on an unknown/foreign id is a 404, not a 500.
  * regression    — a re-save stays idempotent AND never erases an existing
                    note; plain add/remove are unchanged.

Service- and schema-level, mirroring ``test_customer_notifications.py`` — the
SQLite harness, no HTTP, no real database. The HTTP wrapper (`patch_wishlist_note`)
is a thin commit-around-the-service, so the service IS the behaviour.
"""
import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerWishlistItem
from app.schemas.customer_account import (
    WISHLIST_NOTE_MAX_LEN,
    WishlistCreate,
    WishlistNoteUpdate,
)
from app.services import customer_account_service as acct
from tests.conftest import _next_id


def _make_table(db: Session):
    CustomerWishlistItem.__table__.create(db.get_bind(), checkfirst=True)


def _shim_ids(monkeypatch):
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


# --- create -----------------------------------------------------------------

def test_save_with_a_note_persists_it(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)

    row = acct.add_wishlist_item(db, customer, "hotel", 42, note="  ask about the May rate  ")
    # Stored trimmed, and it is what a later read returns.
    assert row.note == "ask about the May rate"
    assert acct.list_wishlist(db, customer)[0].note == "ask about the May rate"


def test_save_without_a_note_is_null(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)

    row = acct.add_wishlist_item(db, customer, "package", 7)
    assert row.note is None


@pytest.mark.parametrize("blank", [None, "", "   ", "\n\t "])
def test_blank_note_on_save_is_null_not_empty_string(db, customer, monkeypatch, blank):
    _make_table(db)
    _shim_ids(monkeypatch)

    row = acct.add_wishlist_item(db, customer, "hotel", 1, note=blank)
    assert row.note is None  # one canonical "no note" state


# --- update / clear ---------------------------------------------------------

def test_update_sets_changes_and_clears_the_note(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    saved = acct.add_wishlist_item(db, customer, "hotel", 42)

    set_ = acct.update_wishlist_note(db, customer, saved.customer_wishlist_id, "near the beach")
    assert set_.note == "near the beach"

    changed = acct.update_wishlist_note(db, customer, saved.customer_wishlist_id, "actually, rooftop pool")
    assert changed.note == "actually, rooftop pool"

    cleared = acct.update_wishlist_note(db, customer, saved.customer_wishlist_id, "   ")
    assert cleared.note is None  # blank clears, consistently with save
    assert acct.list_wishlist(db, customer)[0].note is None


# --- ownership --------------------------------------------------------------

def test_one_customer_cannot_touch_anothers_note(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    other = _other_customer(db)
    mine = acct.add_wishlist_item(db, customer, "hotel", 99, note="my private note")

    # The other customer's update finds nothing to update (the router 404s)...
    assert acct.update_wishlist_note(db, other, mine.customer_wishlist_id, "hijacked") is None
    # ...and the note is untouched for the real owner.
    assert acct.list_wishlist(db, customer)[0].note == "my private note"


# --- missing item -----------------------------------------------------------

def test_note_update_on_a_missing_item_is_none(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    # No such wishlist id for anyone → None → router answers 404, not a 500.
    assert acct.update_wishlist_note(db, customer, 123456789, "nope") is None


# --- invalid input (schema edge) -------------------------------------------

def test_note_over_the_cap_is_refused_by_the_schema():
    too_long = "x" * (WISHLIST_NOTE_MAX_LEN + 1)
    with pytest.raises(ValidationError):
        WishlistNoteUpdate(note=too_long)
    with pytest.raises(ValidationError):
        WishlistCreate(item_type="hotel", item_id=1, note=too_long)


def test_note_exactly_at_the_cap_is_accepted():
    ok = "x" * WISHLIST_NOTE_MAX_LEN
    assert WishlistNoteUpdate(note=ok).note == ok


# --- regression: existing save/remove behaviour is unchanged ----------------

def test_resave_is_idempotent_and_never_erases_an_existing_note(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    first = acct.add_wishlist_item(db, customer, "hotel", 42, note="keep me")

    # A double-tap on the heart (re-save), even carrying a different note, must
    # return the same row and must NOT overwrite the note the customer set.
    again = acct.add_wishlist_item(db, customer, "hotel", 42, note="overwrite attempt")
    assert again.customer_wishlist_id == first.customer_wishlist_id
    assert again.note == "keep me"
    assert len(acct.list_wishlist(db, customer)) == 1


def test_remove_still_deletes_and_note_goes_with_it(db, customer, monkeypatch):
    _make_table(db)
    _shim_ids(monkeypatch)
    keep = acct.add_wishlist_item(db, customer, "hotel", 10, note="stay")
    drop = acct.add_wishlist_item(db, customer, "package", 20, note="go")

    acct.remove_wishlist_item(db, drop)
    db.flush()

    remaining = acct.list_wishlist(db, customer)
    assert [w.customer_wishlist_id for w in remaining] == [keep.customer_wishlist_id]
    assert remaining[0].note == "stay"
