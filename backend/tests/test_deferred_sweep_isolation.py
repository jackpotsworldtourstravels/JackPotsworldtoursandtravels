"""One bad deferred event must not hold the others hostage.

``process_deferred_events`` drains events in arrival order, one provider lookup
each. A verifier turns a provider fault into a RETRYABLE answer -- but an
UNEXPECTED fault (a data inconsistency, a driver error) is not a provider error
and used to propagate out of the loop. That aborted the whole sweep tick:

  * every event queued BEHIND the bad one waited, and it raised again on every
    later tick, so the wait never ended; and
  * ``_run_payment_sweep`` calls the stale-payment recovery AFTER this function,
    so HDFC payments nothing else reached us about were not recovered either.

It was already true for package events. Flights and hotels reach this loop now,
so the exposure grew from one product to three. These tests pin the repair: the
bad row stays ``deferred`` (it is asked about again), writes nothing, and costs
only itself.

The provider is a stub and HDFC's HTTP API is ``FakeHDFC``; no money moves.
"""

from __future__ import annotations

import pytest

import app.main as main
from app.models_customer import CustomerBookingStatus, CustomerPaymentStatus
from app.services import payment_event_service as events
from app.services import payment_verification_service as verification
from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider
from tests.hdfc_fakes import FakeHDFC, FakeResponse, make_provider, order_doc
from tests.sweep_fakes import (
    KINDS,
    KeepOpen,
    StubProvider,
    add_deferred,
    add_stale_hdfc_hotel,
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


def _assert_untouched(s):
    """What a row that raised must look like: still queued, nothing written."""
    assert s.event.processing_status == events.DEFERRED
    assert s.payment.status == CustomerPaymentStatus.PENDING.value
    assert s.booking.status == CustomerBookingStatus.PENDING.value


@pytest.mark.parametrize("victim", KINDS)
@pytest.mark.parametrize("poison", KINDS)
def test_one_raising_event_does_not_block_the_event_behind_it(sdb, stub, poison, victim):
    bad = add_deferred(sdb, stub, poison)              # oldest: drained first
    good = add_deferred(sdb, stub, victim)
    stub.explode_for = {bad.pay_id}

    tally = verification.process_deferred_events(sdb)  # must not raise

    assert tally["errors"] == 1 and tally["captured"] == 1
    g = state(sdb, good)
    assert g.event.processing_status == events.PROCESSED
    assert g.payment.status == CustomerPaymentStatus.CAPTURED.value
    assert g.booking.status == CustomerBookingStatus.CONFIRMED.value
    _assert_untouched(state(sdb, bad))
    assert confirmations(sdb) == 1                     # the bad row confirmed nothing


def test_a_raising_event_in_the_middle_costs_only_itself(sdb, stub):
    first = add_deferred(sdb, stub, "package")
    bad = add_deferred(sdb, stub, "hotel")
    last = add_deferred(sdb, stub, "flight")
    stub.explode_for = {bad.pay_id}

    tally = verification.process_deferred_events(sdb)

    assert tally["errors"] == 1 and tally["captured"] == 2
    for case in (first, last):
        assert state(sdb, case).payment.status == CustomerPaymentStatus.CAPTURED.value
    _assert_untouched(state(sdb, bad))
    assert confirmations(sdb) == 2


@pytest.mark.parametrize("poison", KINDS)
def test_the_raising_event_is_asked_about_again_on_the_next_sweep(sdb, stub, poison):
    bad = add_deferred(sdb, stub, poison)
    stub.explode_for = {bad.pay_id}
    assert verification.process_deferred_events(sdb)["errors"] == 1
    _assert_untouched(state(sdb, bad))

    stub.explode_for = set()                           # the fault clears

    second = verification.process_deferred_events(sdb)

    assert second["captured"] == 1 and second["errors"] == 0
    s = state(sdb, bad)
    assert s.payment.status == CustomerPaymentStatus.CAPTURED.value
    assert s.booking.status == CustomerBookingStatus.CONFIRMED.value
    assert confirmations(sdb) == 1


@pytest.mark.parametrize("poison", KINDS)
def test_stale_payment_recovery_still_runs_when_a_deferred_event_raises(
        monkeypatch, sdb, stub, poison):
    """The scheduler's own entry point, end to end.

    A deferred event that raises, and an HDFC payment that was paid but never
    reported (no return, no webhook). The HDFC payment must still be settled by
    the same tick that hit the bad event.
    """
    bad = add_deferred(sdb, stub, poison)
    stub.explode_for = {bad.pay_id}
    oid = HDFCSmartGatewayProvider.order_id_for("JPHSWEEP", "k-sweep")
    stale = add_stale_hdfc_hotel(sdb, oid)
    use_providers(monkeypatch, stub=stub, hdfc=make_provider())
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid))})
    monkeypatch.setattr(main, "SessionLocal", lambda: KeepOpen(sdb))

    main._run_payment_sweep()                          # must not raise

    s = state(sdb, stale)
    assert s.payment.status == CustomerPaymentStatus.CAPTURED.value
    assert s.booking.status == CustomerBookingStatus.CONFIRMED.value
    _assert_untouched(state(sdb, bad))
