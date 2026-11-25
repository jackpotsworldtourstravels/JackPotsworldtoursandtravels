"""Issue #2 — e-ticket payment gate.

A valid ticket (token, QR, PNR) must never be reachable before the booking is
genuinely paid: CONFIRMED/COMPLETED **and** backed by a CAPTURED payment whose
amount and currency match the booking's own total. Eligibility is computed only
from our own rows, never a client status or webhook body.
"""
from decimal import Decimal
from types import SimpleNamespace

from app.services import eticket_service as et


def _pay(status="captured", amount="5000.00", currency="INR"):
    return SimpleNamespace(status=status, amount=Decimal(amount), currency=currency)


def _booking(status="confirmed", total="5000.00", currency="INR", payments=None):
    return SimpleNamespace(
        booking_ref="JPB000042",
        status=status,
        total_amount=Decimal(total),
        currency=currency,
        payments=payments if payments is not None else [_pay()],
    )


def test_eligible_when_confirmed_and_captured_amount_matches():
    ok, reason = et.eligibility(_booking())
    assert ok is True and reason == "eligible"
    assert et.is_eligible(_booking()) is True


def test_completed_booking_with_matching_capture_is_eligible():
    ok, reason = et.eligibility(_booking(status="completed"))
    assert ok is True and reason == "eligible"


def test_pending_booking_is_not_eligible():
    ok, reason = et.eligibility(_booking(status="pending"))
    assert ok is False and reason == "not_confirmed"


def test_cancelled_booking_is_not_eligible():
    ok, reason = et.eligibility(_booking(status="cancelled"))
    assert ok is False and reason == "cancelled"


def test_unpaid_confirmed_booking_is_not_eligible():
    # Confirmed but only a pending attempt — no captured money.
    ok, reason = et.eligibility(_booking(payments=[_pay(status="pending")]))
    assert ok is False and reason == "unpaid"


def test_failed_payment_is_not_eligible():
    ok, reason = et.eligibility(_booking(payments=[_pay(status="failed")]))
    assert ok is False and reason == "unpaid"


def test_no_payment_rows_is_not_eligible():
    ok, reason = et.eligibility(_booking(payments=[]))
    assert ok is False and reason == "unpaid"


def test_amount_mismatch_is_not_eligible():
    ok, reason = et.eligibility(_booking(total="5000.00", payments=[_pay(amount="4500.00")]))
    assert ok is False and reason == "amount_mismatch"


def test_currency_mismatch_is_not_eligible():
    ok, reason = et.eligibility(_booking(currency="INR", payments=[_pay(currency="USD")]))
    assert ok is False and reason == "amount_mismatch"


def test_zero_amount_booking_is_not_eligible():
    ok, reason = et.eligibility(_booking(total="0.00", payments=[_pay(amount="0.00")]))
    assert ok is False and reason == "unusable_amount"


def test_a_matching_capture_among_failed_attempts_is_eligible():
    # Several attempts; exactly one captured and matching -> eligible.
    ok, reason = et.eligibility(
        _booking(payments=[_pay(status="failed"), _pay(status="captured"), _pay(status="pending")])
    )
    assert ok is True and reason == "eligible"
