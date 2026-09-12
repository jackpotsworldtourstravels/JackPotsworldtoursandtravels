"""A provider payment id is not a stable identity; the order is.

Every test here is the JPH000011 incident in one form or another: the card was
declined, the traveller paid again on the same order, and the id Tours recorded
first stopped resolving at the provider. What must survive that is the ability
to still find out what happened to the money -- and the refusal to believe
anything about an amount, a currency or a booking that does not match.
"""

from __future__ import annotations

import datetime as dt
import decimal

import pytest

from app.models_customer import CustomerPaymentStatus
from app.services import payment_verification_hotel_service as verify
from app.services import payments as payment_providers
from tests.conftest import FakeProvider, FakeRemote, make_booking, make_payment

DECLINED = "pay_declined"
RETRY = "pay_retry"
ORDER = "order_TEST"


def _run(db, payment, provider, monkeypatch):
    """Verify one payment against a provider we control."""
    monkeypatch.setattr(verify.payment_providers, "get_provider_named",
                        lambda *a, **k: provider)
    return verify.verify_and_capture(
        db, payment.customer_hotel_booking_payment_id, provider_name="trustbrick"
    )


def _refunded_retry(**kw):
    return FakeRemote(status=payment_providers.REFUNDED, payment_id=RETRY,
                      order_id=ORDER, **kw)


# ---------------------------------------------------------------------------
# 1. failed attempt -> refunded retry
# ---------------------------------------------------------------------------
def test_failed_attempt_then_refunded_retry_is_recorded(db, customer, monkeypatch):
    b = make_booking(db, customer)
    p = make_payment(db, b)                      # pinned to the declined id
    prov = FakeProvider(order=_refunded_retry())  # the declined id is GONE

    result = _run(db, p, prov, monkeypatch)

    assert result.disposition == verify.DONE
    assert result.code == "refunded_at_provider"
    assert p.status == CustomerPaymentStatus.REFUNDED.value


# ---------------------------------------------------------------------------
# 2. the row adopts the latest payment id
# ---------------------------------------------------------------------------
def test_row_adopts_the_latest_payment_id(db, customer, monkeypatch):
    b = make_booking(db, customer)
    p = make_payment(db, b)
    prov = FakeProvider(order=_refunded_retry())

    _run(db, p, prov, monkeypatch)

    assert p.provider_payment_id == RETRY, "the row must follow the provider"
    assert p.provider_order_id == ORDER, "the order is the stable link and must not move"


# ---------------------------------------------------------------------------
# 3. the old payment id no longer resolves
# ---------------------------------------------------------------------------
def test_falls_back_to_the_order_when_the_old_id_is_gone(db, customer, monkeypatch):
    b = make_booking(db, customer)
    p = make_payment(db, b)
    prov = FakeProvider(order=_refunded_retry())

    _run(db, p, prov, monkeypatch)

    assert prov.fetch_payment_calls == [DECLINED], "it should try the id it holds first"
    assert prov.fetch_order_calls == [ORDER], "then fall back to the order"


def test_a_resolvable_id_is_not_second_guessed(db, customer, monkeypatch):
    """The ordinary case must not gain a round trip."""
    b = make_booking(db, customer)
    p = make_payment(db, b, payment_id=RETRY)
    prov = FakeProvider(known={RETRY: _refunded_retry()})

    _run(db, p, prov, monkeypatch)

    assert prov.fetch_order_calls == [], "no fallback when the payment id resolves"


# ---------------------------------------------------------------------------
# 4. the correct Tours payment is the one updated
# ---------------------------------------------------------------------------
def test_only_the_matching_payment_is_updated(db, customer, monkeypatch):
    b = make_booking(db, customer)
    p = make_payment(db, b)
    other_b = make_booking(db, customer, ref="JPH000998")
    other_p = make_payment(db, other_b, order_id="order_OTHER",
                           payment_id="pay_other")
    prov = FakeProvider(order=_refunded_retry())

    _run(db, p, prov, monkeypatch)

    assert p.status == CustomerPaymentStatus.REFUNDED.value
    assert other_p.status == CustomerPaymentStatus.FAILED.value
    assert other_p.provider_payment_id == "pay_other"


# ---------------------------------------------------------------------------
# 5 & 6. amount and currency are verified before the state changes
# ---------------------------------------------------------------------------
def test_amount_mismatch_is_rejected(db, customer, monkeypatch):
    b = make_booking(db, customer)
    p = make_payment(db, b)
    prov = FakeProvider(order=_refunded_retry(amount_minor=9900))

    result = _run(db, p, prov, monkeypatch)

    assert result.code == "amount_mismatch"
    assert p.status != CustomerPaymentStatus.REFUNDED.value


def test_currency_mismatch_is_rejected(db, customer, monkeypatch):
    b = make_booking(db, customer)
    p = make_payment(db, b)
    prov = FakeProvider(order=_refunded_retry(currency="USD"))

    result = _run(db, p, prov, monkeypatch)

    assert result.code == "currency_mismatch"
    assert p.status != CustomerPaymentStatus.REFUNDED.value


# ---------------------------------------------------------------------------
# 7. repeating it changes nothing
# ---------------------------------------------------------------------------
def test_a_second_identical_verification_is_idempotent(db, customer, monkeypatch):
    b = make_booking(db, customer)
    p = make_payment(db, b)
    prov = FakeProvider(order=_refunded_retry())

    first = _run(db, p, prov, monkeypatch)
    after_first = (p.status, p.provider_payment_id)
    second = _run(db, p, prov, monkeypatch)

    assert first.code == "refunded_at_provider"
    # The second call never reaches the provider at all: a settled row is
    # answered from itself, which is what makes repeated deliveries free.
    assert second.code == "already_refunded"
    assert second.disposition == verify.DONE
    assert (p.status, p.provider_payment_id) == after_first
    assert p.status == CustomerPaymentStatus.REFUNDED.value
    assert prov.fetch_order_calls == [ORDER], "one round trip, not two"


# ---------------------------------------------------------------------------
# 8. a refunded payment cannot be paid again
# ---------------------------------------------------------------------------
def test_a_refunded_payment_blocks_a_new_checkout(db, customer):
    from app.services import customer_hotel_booking_service as hb

    b = make_booking(db, customer, created_at=dt.datetime.now(dt.timezone.utc))
    make_payment(db, b, status=CustomerPaymentStatus.REFUNDED.value)

    assert hb.refunded_payment(db, b) is not None
    with pytest.raises(hb.HotelBookingError) as exc:
        hb.start_checkout(db, customer, b, idempotency_key="probe-refunded-1")
    # Refused for the REFUND, not merely because the window ran out -- the
    # booking above was created just now.
    assert "refunded" in str(exc.value).lower()


# ---------------------------------------------------------------------------
# 9. an unrelated order is never adopted
# ---------------------------------------------------------------------------
def test_a_different_order_is_refused(db, customer, monkeypatch):
    """The order is what makes a differing payment id believable."""
    b = make_booking(db, customer)
    p = make_payment(db, b)
    prov = FakeProvider(order=FakeRemote(
        status=payment_providers.REFUNDED, payment_id="pay_somebody_else",
        order_id="order_SOMEBODY_ELSE",
    ))

    result = _run(db, p, prov, monkeypatch)

    assert result.code == "order_mismatch"
    assert p.status != CustomerPaymentStatus.REFUNDED.value
    assert p.provider_payment_id == DECLINED, "the row must not follow a foreign order"
