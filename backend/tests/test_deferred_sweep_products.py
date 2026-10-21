"""The deferred-event sweep, for every product.

``process_deferred_events`` drains webhook events left ``deferred`` because the
provider could not yet say whether a payment succeeded. It used to look the
payment up in the PACKAGE table only, so a deferred flight or hotel event was
marked ``ignored: no local payment`` and never retried: a customer who had paid
stayed unconfirmed until they opened My Trips.

These tests pin, for all three products and a drop-in provider (not HDFC's
hosted page), what the sweep must do -- the same as the webhook path that left
the event deferred in the first place. A paid package behaved this way before
the change; flights and hotels are what the change added. The provider is a
stub; no money moves.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models_customer import (
    CustomerBookingStatus,
    CustomerPaymentStatus,
    PaymentProviderEvent,
)
from app.services import payment_event_service as events
from app.services import payment_verification_service as verification
from app.services.payments.base import CAPTURED, PROCESSING
from tests.sweep_fakes import (
    KINDS,
    StubProvider,
    add_deferred,
    add_deferred_event_without_payment,
    confirmations,
    make_db,
    state,
    use_providers,
)


@pytest.fixture()
def sdb():
    engine, session = make_db()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def stub(monkeypatch):
    s = StubProvider()
    use_providers(monkeypatch, stub=s)
    return s


@pytest.fixture(params=KINDS)
def kind(request):
    return request.param


def test_a_paid_deferred_event_confirms_the_booking_once(sdb, stub, kind):
    case = add_deferred(sdb, stub, kind)

    tally = verification.process_deferred_events(sdb)

    assert tally["seen"] == 1 and tally["captured"] == 1
    assert tally["ignored"] == 0 and tally["retryable"] == 0
    s = state(sdb, case)
    assert s.event.processing_status == events.PROCESSED
    assert s.payment.status == CustomerPaymentStatus.CAPTURED.value
    assert s.booking.status == CustomerBookingStatus.CONFIRMED.value
    assert confirmations(sdb) == 1

    # A processed event is not drained again, so a second sweep confirms nothing.
    assert verification.process_deferred_events(sdb)["seen"] == 0
    assert confirmations(sdb) == 1


def test_a_payment_still_in_flight_stays_deferred_and_is_asked_again(sdb, stub, kind):
    case = add_deferred(sdb, stub, kind)
    stub.status = PROCESSING

    first = verification.process_deferred_events(sdb)

    # Not "ignored": ignored is final, deferred is the queue.
    assert first["retryable"] == 1 and first["ignored"] == 0
    s = state(sdb, case)
    assert s.event.processing_status == events.DEFERRED
    assert s.payment.status != CustomerPaymentStatus.CAPTURED.value
    assert confirmations(sdb) == 0

    stub.status = CAPTURED                                   # the bank settles
    second = verification.process_deferred_events(sdb)

    assert second["captured"] == 1
    s = state(sdb, case)
    assert s.payment.status == CustomerPaymentStatus.CAPTURED.value
    assert s.booking.status == CustomerBookingStatus.CONFIRMED.value
    assert confirmations(sdb) == 1


def test_a_wrong_amount_is_refused_and_confirms_nothing(sdb, stub, kind):
    case = add_deferred(sdb, stub, kind)
    stub.amount_minor = 100                                  # Rs 1.00 against a Rs 56.00 booking

    tally = verification.process_deferred_events(sdb)

    assert tally["rejected"] == 1 and tally["captured"] == 0 and tally["ignored"] == 0
    s = state(sdb, case)
    assert s.event.processing_status == events.FAILED
    assert s.payment.status != CustomerPaymentStatus.CAPTURED.value
    assert s.booking.status == CustomerBookingStatus.PENDING.value
    assert confirmations(sdb) == 0


def test_a_provider_that_is_not_configured_leaves_the_event_deferred(monkeypatch, sdb, stub, kind):
    """The state of a deployment that moved from one provider to another while
    events were queued: the payment is not wrong, the sweep just cannot ask yet."""
    case = add_deferred(sdb, stub, kind)
    use_providers(monkeypatch, stub=stub, razorpay_unconfigured=True)

    tally = verification.process_deferred_events(sdb)

    assert tally["retryable"] == 1 and tally["ignored"] == 0 and tally["captured"] == 0
    assert state(sdb, case).event.processing_status == events.DEFERRED
    assert confirmations(sdb) == 0


def test_an_event_for_an_unknown_payment_is_ignored_with_a_reason(sdb, stub):
    case = add_deferred_event_without_payment(sdb)

    tally = verification.process_deferred_events(sdb)

    assert tally["ignored"] == 1 and tally["captured"] == 0
    row = sdb.execute(select(PaymentProviderEvent).where(
        PaymentProviderEvent.provider_payment_id == case.pay_id)).scalar_one()
    assert row.processing_status == events.IGNORED
    assert row.processing_note.startswith("No local payment")


def test_one_sweep_settles_a_package_a_flight_and_a_hotel_together(sdb, stub):
    cases = [add_deferred(sdb, stub, k) for k in KINDS]

    tally = verification.process_deferred_events(sdb)

    assert tally["seen"] == 3 and tally["captured"] == 3 and tally["ignored"] == 0
    for case in cases:
        s = state(sdb, case)
        assert s.payment.status == CustomerPaymentStatus.CAPTURED.value
        assert s.booking.status == CustomerBookingStatus.CONFIRMED.value
    assert confirmations(sdb) == 3
