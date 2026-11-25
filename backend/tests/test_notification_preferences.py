"""Issue #21 — notification preferences service.

Booking (transactional) channels default ON, promotional default OFF. A read
never writes. Updates are partial and scoped to one customer. The booking
category is fail-open so a preference outage never swallows a confirmation.
In-app notifications are not governed here. Service-level, no HTTP, mirroring
``test_customer_notifications`` / ``test_customer_wishlist``.
"""
import pydantic
import pytest

from app.models_customer import Customer
from app.schemas.customer_account import NotificationPreferencesUpdate
from app.services import customer_notification_preferences_service as prefs
from tests.conftest import _next_id

ALL_DEFAULTS = {"booking_email": True, "booking_sms": True, "promo_email": False, "promo_sms": False}


def _other(db):
    c = Customer(customer_id=_next_id(), customer_code="CUSTNP2", full_name="Other NP",
                 email="other-np@example.test", mobile="9000000111")
    db.add(c)
    db.flush()
    return c


def test_defaults_are_booking_on_promo_off_without_a_row(db, customer):
    assert prefs.get(db, customer) == ALL_DEFAULTS


def test_get_is_a_pure_read_and_creates_no_row(db, customer):
    prefs.get(db, customer)
    assert prefs._row(db, customer.customer_id) is None


def test_update_persists_and_is_partial(db, customer):
    out = prefs.update(db, customer, {"promo_email": True, "booking_sms": False})
    assert out == {"booking_email": True, "booking_sms": False, "promo_email": True, "promo_sms": False}
    assert prefs.get(db, customer) == out  # survives a re-read


def test_update_only_changes_named_switches(db, customer):
    prefs.update(db, customer, {"promo_email": True})
    prefs.update(db, customer, {"promo_sms": True})  # must not reset promo_email
    got = prefs.get(db, customer)
    assert got["promo_email"] is True and got["promo_sms"] is True


def test_update_is_scoped_to_one_customer(db, customer):
    other = _other(db)
    prefs.update(db, customer, {"booking_email": False, "promo_email": True})
    assert prefs.get(db, other) == ALL_DEFAULTS  # another customer is untouched


def test_allows_reflects_the_stored_switches(db, customer):
    prefs.update(db, customer, {"booking_email": False, "promo_sms": True})
    assert prefs.allows(db, customer.customer_id, "email", "booking") is False
    assert prefs.allows(db, customer.customer_id, "sms", "booking") is True
    assert prefs.allows(db, customer.customer_id, "sms", "promo") is True
    assert prefs.allows(db, customer.customer_id, "email", "promo") is False


def test_allows_unknown_channel_or_category_is_false(db, customer):
    assert prefs.allows(db, customer.customer_id, "pigeon", "booking") is False
    assert prefs.allows(db, customer.customer_id, "email", "mystery") is False


def test_booking_is_fail_open_but_promo_stays_off_on_lookup_error(db, customer, monkeypatch):
    # Turn booking channels off for real, then simulate a lookup failure.
    prefs.update(db, customer, {"booking_email": False, "booking_sms": False})
    monkeypatch.setattr(prefs, "_row", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    assert prefs.booking_channels_allowed(db, customer.customer_id) == {"email": True, "sms": True}
    assert prefs.allows(db, customer.customer_id, "email", "booking") is True   # fail-open
    assert prefs.allows(db, customer.customer_id, "email", "promo") is False    # opt-in stays off


def test_schema_rejects_unknown_fields():
    with pytest.raises(pydantic.ValidationError):
        NotificationPreferencesUpdate(unknown_switch=True)


def test_schema_rejects_non_boolean():
    with pytest.raises(pydantic.ValidationError):
        NotificationPreferencesUpdate(booking_email="definitely-not-a-bool")


def test_schema_partial_update_is_valid():
    m = NotificationPreferencesUpdate(promo_email=True)
    assert m.model_dump(exclude_unset=True) == {"promo_email": True}
