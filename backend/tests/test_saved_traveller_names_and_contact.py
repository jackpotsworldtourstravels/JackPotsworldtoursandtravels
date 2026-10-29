"""Saved travellers keep first / middle / last apart, keep their own phone and
email, and are never blanked by a booking-driven merge. Synthetic data only."""
import pytest
from pydantic import ValidationError
from sqlalchemy import event

from app.integrations.duffel.mapper import passengers_to_order
from app.models_customer import CustomerTraveller
from app.person_names import compose_given_name
from app.routers import customer_travellers as router
from app.schemas.customer_booking import PassengerInput, TravellerCreate, TravellerResponse
from app.schemas.customer_hotel_booking import GuestInput
from app.schemas.customer_package_booking import TravellerInput
from app.services import customer_traveller_service as svc
from tests.conftest import _next_id


@pytest.fixture()
def tdb(db):
    # conftest builds only three tables; SQLite also has no identity sequences.
    CustomerTraveller.__table__.create(db.get_bind(), checkfirst=True)

    def _ids(_mapper, _conn, row):
        row.customer_traveller_id = row.customer_traveller_id or _next_id()

    event.listen(CustomerTraveller, "before_insert", _ids)
    yield db
    event.remove(CustomerTraveller, "before_insert", _ids)


def _pax(**kw):
    """What PassengerInput.model_dump() hands save_many: every key, None where unset."""
    d = {k: None for k in (
        "title", "first_name", "middle_name", "last_name", "gender", "date_of_birth",
        "nationality", "passport_number", "passport_expiry", "issuing_country",
        "frequent_flyer_airline", "frequent_flyer_number", "mobile", "email")}
    d.update(traveller_type="adult", is_contact=False)
    d.update(kw)
    return d


def _only(db, customer):
    rows = svc.list_for_customer(db, customer)
    assert len(rows) == 1
    return rows[0]


def test_create_and_retrieve_keeps_names_distinct(tdb, customer):
    payload = TravellerCreate(first_name="Asha", middle_name="Kumari", last_name="Rao")
    row = svc.upsert(tdb, customer, payload.model_dump(exclude_unset=True))
    out = TravellerResponse.model_validate(row)
    assert (out.first_name, out.middle_name, out.last_name) == ("Asha", "Kumari", "Rao")


def test_edit_without_middle_name_does_not_lose_it(tdb, customer):
    row = svc.upsert(tdb, customer, {"first_name": "Asha", "middle_name": "Kumari", "last_name": "Rao"})
    patch = TravellerCreate(first_name="Asha", last_name="Rao-Nair").model_dump(exclude_unset=True)
    svc.apply_update(row, patch)
    assert (row.first_name, row.middle_name, row.last_name) == ("Asha", "Kumari", "Rao-Nair")


def test_traveller_phone_and_email_round_trip(tdb, customer):
    payload = TravellerCreate(first_name="Ravi", last_name="Rao", mobile="+919000000001",
                              email="ravi.test@example.com")
    row = svc.upsert(tdb, customer, payload.model_dump(exclude_unset=True))
    out = TravellerResponse.model_validate(row)
    assert out.mobile == "+919000000001" and out.email == "ravi.test@example.com"


def test_booking_merge_never_erases_stored_values(tdb, customer):
    svc.upsert(tdb, customer, {
        "first_name": "Priya", "middle_name": "Devi", "last_name": "Sharma",
        "passport_number": "TP000111", "mobile": "+919000000002", "email": "priya.test@example.com",
        "frequent_flyer_airline": "AI", "nationality": "India"})
    # a later booking form: same passport, everything it did not ask is None
    svc.save_many(tdb, customer, [_pax(first_name="Priya", last_name="Sharma", passport_number="TP000111")])
    row = _only(tdb, customer)
    assert (row.middle_name, row.mobile, row.email, row.frequent_flyer_airline, row.nationality) == (
        "Devi", "+919000000002", "priya.test@example.com", "AI", "India")


def test_booking_merge_updates_values_that_are_provided(tdb, customer):
    svc.upsert(tdb, customer, {"first_name": "Priya", "last_name": "Sharma", "passport_number": "TP000111"})
    svc.save_many(tdb, customer, [_pax(first_name="Priya", middle_name="Devi", last_name="Sharma",
                                       passport_number="TP000111", nationality="India")])
    row = _only(tdb, customer)
    assert (row.middle_name, row.nationality) == ("Devi", "India")


def test_explicit_clear_through_the_traveller_api(tdb, customer):
    row = svc.upsert(tdb, customer, {"first_name": "Asha", "middle_name": "Kumari", "last_name": "Rao",
                                     "mobile": "+919000000003"})
    clear = TravellerCreate(first_name="Asha", last_name="Rao", middle_name=None, mobile=None)
    router.update_traveller(row.customer_traveller_id, clear, tdb, customer)
    assert row.middle_name is None and row.mobile is None


def test_patch_omitting_contact_leaves_it_untouched(tdb, customer):
    row = svc.upsert(tdb, customer, {"first_name": "Asha", "last_name": "Rao",
                                     "mobile": "+919000000003", "email": "asha.test@example.com"})
    router.update_traveller(row.customer_traveller_id,
                            TravellerCreate(first_name="Asha", last_name="Rao"), tdb, customer)
    assert (row.mobile, row.email) == ("+919000000003", "asha.test@example.com")


def test_legacy_combined_first_name_is_left_alone(tdb, customer):
    # a row saved before middle_name existed: "Asha Kumari" lives in first_name
    tdb.add(CustomerTraveller(customer_id=customer.customer_id, first_name="Asha Kumari",
                              last_name="Rao", passport_number="TP000222"))
    tdb.flush()
    svc.save_many(tdb, customer, [_pax(first_name="Asha Kumari", last_name="Rao", passport_number="TP000222")])
    row = _only(tdb, customer)
    assert (row.first_name, row.middle_name) == ("Asha Kumari", None)


def test_booking_contact_is_not_copied_onto_the_traveller(tdb, customer):
    svc.upsert(tdb, customer, {"first_name": "Arjun", "last_name": "Mehta", "passport_number": "TP000333",
                               "mobile": "+919000000004", "email": "arjun.own@example.com"})
    lead = _pax(first_name="Arjun", last_name="Mehta", passport_number="TP000333", is_contact=True,
                mobile="+919000000099", email="booker@example.com")
    svc.save_many(tdb, customer, [lead])
    row = _only(tdb, customer)
    assert (row.mobile, row.email) == ("+919000000004", "arjun.own@example.com")


def test_booking_contact_does_not_create_a_traveller_contact(tdb, customer):
    lead = _pax(first_name="Neha", last_name="Iyer", passport_number="TP000444", is_contact=True,
                mobile="+919000000098", email="booker2@example.com")
    svc.save_many(tdb, customer, [lead])
    row = _only(tdb, customer)
    assert row.mobile is None and row.email is None


def test_every_booking_schema_accepts_middle_name_and_limits_the_combined_length():
    base = dict(first_name="Asha", middle_name="Kumari", last_name="Rao")
    assert PassengerInput(**base).middle_name == "Kumari"
    assert GuestInput(**base).middle_name == "Kumari"
    assert TravellerInput(**base).middle_name == "Kumari"
    too_long = dict(first_name="A" * 60, middle_name="B" * 60, last_name="Rao")
    for model in (PassengerInput, GuestInput, TravellerInput, TravellerCreate):
        with pytest.raises(ValidationError):
            model(**too_long)


def test_given_name_is_composed_only_at_the_provider_boundary():
    assert compose_given_name("Asha", "Kumari") == "Asha Kumari"
    assert compose_given_name(" Asha ", None) == "Asha"
    assert compose_given_name("Asha", "  ") == "Asha"
    # an old client that already sent "Asha Kumari" as first_name is unchanged
    assert compose_given_name("Asha Kumari", None) == "Asha Kumari"
    # the booking row (composed) is what the Duffel mapper reads
    row = {"first_name": compose_given_name("Asha", "Kumari"), "last_name": "Rao", "mobile": "+919000000005"}
    order = passengers_to_order([row], ["pas_1"])
    assert order[0]["given_name"] == "Asha Kumari" and order[0]["family_name"] == "Rao"


def test_reading_back_a_stored_pair_longer_than_the_request_limit_does_not_fail(tdb, customer):
    # PATCH checks only what was sent; first_name (max 100) and a stored middle_name can together
    # exceed the combined limit. The response model must still serialise the saved record.
    row = svc.upsert(tdb, customer, {"traveller_type": "adult", "first_name": "A" * 80,
                                     "middle_name": "B" * 90, "last_name": "Rao"})
    out = TravellerResponse.model_validate(row)
    assert len(out.first_name) == 80 and len(out.middle_name) == 90
    with pytest.raises(ValidationError):
        TravellerCreate(first_name="A" * 80, middle_name="B" * 90, last_name="Rao")
