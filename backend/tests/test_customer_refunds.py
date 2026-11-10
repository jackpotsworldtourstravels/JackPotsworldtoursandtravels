"""The B2C refund lifecycle, end to end, against a fake provider.

NO REAL PROVIDER IS EVER CALLED. Every gateway here is a test double or an
adapter whose single HTTP method is replaced; no network, no credential, no
money. The database is SQLite in memory (or a temp file where two sessions are
needed), carrying the same constraints migration 0094 defines.
"""
from __future__ import annotations

import datetime as dt
import decimal
import hashlib
import hmac
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models_customer import (
    Base,
    Customer,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerCancellationRequest,
    CustomerHotelBooking,
    CustomerHotelBookingPayment,
    CustomerPackageBooking,
    CustomerPackageBookingPayment,
    CustomerPaymentStatus,
    CustomerRefundAttempt,
)
from app.models_v2 import UserRole
from app.services import customer_refund_service as svc
from app.services import payment_event_service
from app.services import payments as payment_providers
from app.services.payments import base as P
from tests.conftest import _next_id, make_booking, make_payment

KEY_PREFIX = "rfnd-"


# ---------------------------------------------------------------------------
# Fixtures and builders
# ---------------------------------------------------------------------------
def _tables():
    return [
        Customer.__table__, CustomerHotelBooking.__table__, CustomerHotelBookingPayment.__table__,
        CustomerBooking.__table__, CustomerBookingPayment.__table__,
        CustomerPackageBooking.__table__, CustomerPackageBookingPayment.__table__,
        CustomerCancellationRequest.__table__, CustomerRefundAttempt.__table__,
    ]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=_tables())
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    # The admin `users` table is a different model base with Postgres-only
    # defaults; names are resolved in one function, replaced here.
    monkeypatch.setattr(svc, "_user_names", lambda db, ids: {i: SimpleNamespace(full_name=f"Admin {i}") for i in ids})
    # Default: maker-checker OFF so a test opts IN to the two-person flow it is about.
    monkeypatch.setattr(settings, "refund_approval_threshold_minor", 10**12)
    monkeypatch.setattr(settings, "refund_reconcile_min_age_seconds", 0)


def actor(user_id: int, *grants: str, role=UserRole.ADMIN, name: str | None = None):
    return SimpleNamespace(
        user_id=user_id, role=role, merchant_role=None, permissions=list(grants),
        full_name=name or f"Admin {user_id}", merchant_id=None,
    )


MAKER = actor(1)
OTHER_MAKER = actor(2)
CHECKER = actor(3, "refund.authorize")
CHECKER_2 = actor(4, "refund.authorize")


class Gateway:
    """A fake Razorpay/HDFC that records every call and honours idempotency."""

    def __init__(self, name="razorpay", mode="ok"):
        self.name = name
        self.mode = mode
        self.calls: list[dict] = []
        self.by_key: dict[str, P.ProviderRefund] = {}
        self.fetch_calls: list[dict] = []
        self.status_override: str | None = None   # what fetch_refund reports
        self.fetch_raises: Exception | None = None
        self.on_refund = None                      # hook run inside the provider call
        self.id_prefix = "rfnd_"                   # unique per run when the database outlives the test

    def _make(self, key, amount, pid, status=P.REFUNDED):
        return P.ProviderRefund(
            provider_refund_id=f"{self.id_prefix}{len(self.by_key) + 1:04d}", status=status,
            provider_status={P.REFUNDED: "processed", P.PROCESSING: "pending", P.FAILED: "failed"}[status],
            amount_minor=amount, currency="INR", raw={"id": "x"}, request_ref=key, provider_payment_id=pid,
        )

    def refund(self, *, provider_payment_id, amount_minor, idempotency_key, notes=None):
        self.calls.append({"payment": provider_payment_id, "amount": amount_minor, "key": idempotency_key})
        if self.on_refund:
            self.on_refund()
        if idempotency_key in self.by_key:
            return self.by_key[idempotency_key]
        if self.mode == "refuse":
            e = P.PaymentFailed("refused")
            e.definitive = True
            raise e
        if self.mode == "unsupported":
            raise P.PaymentProviderError("none", code="refund_unsupported")
        if self.mode == "timeout_executed":
            self.by_key[idempotency_key] = self._make(idempotency_key, amount_minor, provider_payment_id)
            raise P.PaymentTimeout("timed out")
        if self.mode == "timeout_lost":
            raise P.PaymentTimeout("timed out")
        if self.mode == "server_error":
            raise P.PaymentFailed("HTTP 502")          # NOT definitive
        status = P.PROCESSING if self.mode == "pending" else P.REFUNDED
        r = self._make(idempotency_key, amount_minor, provider_payment_id, status)
        self.by_key[idempotency_key] = r
        return r

    def fetch_refund(self, *, provider_payment_id, provider_refund_id=None, idempotency_key=None):
        self.fetch_calls.append({"id": provider_refund_id, "key": idempotency_key})
        if self.fetch_raises:
            raise self.fetch_raises
        for r in self.by_key.values():
            if (provider_refund_id and r.provider_refund_id == provider_refund_id) or \
               (idempotency_key and r.request_ref == idempotency_key):
                if self.status_override:
                    return P.ProviderRefund(**{**r.__dict__, "status": self.status_override,
                                               "provider_status": self.status_override})
                return r
        return None


@pytest.fixture()
def gateway(monkeypatch):
    gw = Gateway()
    monkeypatch.setattr(payment_providers, "get_provider_named", lambda name: gw)
    return gw


@pytest.fixture()
def customer(db):
    c = Customer(customer_id=_next_id(), customer_code="CUST-R1", full_name="Refund Traveller",
                 email="refund@example.test", mobile="9000000001")
    db.add(c)
    db.flush()
    return c


def captured_payment(db, customer, *, ref="JPH100001", amount="100.00", provider="razorpay", pid="pay_R1"):
    booking = make_booking(db, customer, ref=ref, total=amount, status="cancelled")
    pay = make_payment(db, booking, amount=amount, status=CustomerPaymentStatus.CAPTURED.value,
                       provider=provider, order_id=f"order_{ref}", payment_id=pid)
    db.commit()
    return booking, pay


_CXL = {"n": 0}


def cancellation(db, booking, customer, *, refund_amount="100.00", status="approved"):
    _CXL["n"] += 1
    c = CustomerCancellationRequest(
        cancellation_id=_next_id(), cancellation_ref=f"CXL-T-{_CXL['n']:06d}", customer_id=customer.customer_id,
        product="hotel", booking_ref=booking.booking_ref, status=status,
        refund_amount=decimal.Decimal(refund_amount) if refund_amount is not None else None,
    )
    db.add(c)
    db.commit()
    return c


def attempts(db, ref=None):
    q = select(CustomerRefundAttempt).order_by(CustomerRefundAttempt.refund_attempt_id)
    if ref:
        q = q.where(CustomerRefundAttempt.cancellation_ref == ref)
    return list(db.execute(q).scalars().all())


def go(db, ref, who=MAKER, **kw):
    return svc.initiate_refund(db, ref, who, **kw)


def refresh(db, *objs):
    for o in objs:
        db.refresh(o)


# ---------------------------------------------------------------------------
# Full, partial and multiple partial refunds
# ---------------------------------------------------------------------------
def test_full_refund_succeeds_and_closes_everything(db, customer, gateway):
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer)

    attempt, outcome = go(db, c.cancellation_ref)

    assert outcome == "succeeded"
    refresh(db, c, pay, attempt)
    assert attempt.status == svc.SUCCEEDED and attempt.amount_minor == 10000
    assert attempt.provider_refund_id == "rfnd_0001" and attempt.completed_at is not None
    assert c.status == "refunded"
    assert pay.status == CustomerPaymentStatus.REFUNDED.value
    assert len(gateway.calls) == 1
    assert gateway.calls[0] == {"payment": "pay_R1", "amount": 10000, "key": attempt.idempotency_key}
    assert attempt.idempotency_key == f"rfnd-{c.cancellation_ref}-{pay.customer_hotel_booking_payment_id}-1"


def test_partial_refund_leaves_payment_captured_and_balance_open(db, customer, gateway):
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer, refund_amount="30.00")

    attempt, outcome = go(db, c.cancellation_ref)

    refresh(db, c, pay)
    assert outcome == "succeeded" and attempt.amount_minor == 3000
    assert c.status == "refunded"                                   # THIS cancellation is whole
    assert pay.status == CustomerPaymentStatus.CAPTURED.value        # the payment is not
    ov = svc.refund_overview(db, c.cancellation_ref)
    assert ov["captured_amount"] == decimal.Decimal("100.00")
    assert ov["previously_refunded"] == decimal.Decimal("30.00")
    assert ov["remaining_refundable"] == decimal.Decimal("70.00")


def test_multiple_partial_refunds_in_one_cancellation(db, customer, gateway):
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer, refund_amount="100.00")

    a1, _ = go(db, c.cancellation_ref, amount_minor=4000)
    refresh(db, c)
    assert c.status == "refund_processing"                           # 40 of 100 only
    a2, _ = go(db, c.cancellation_ref, amount_minor=6000)

    refresh(db, c, pay)
    assert (a1.attempt_number, a2.attempt_number) == (1, 2)
    assert a1.idempotency_key != a2.idempotency_key
    assert c.status == "refunded" and pay.status == CustomerPaymentStatus.REFUNDED.value


# ---------------------------------------------------------------------------
# Cumulative protection across cancellations
# ---------------------------------------------------------------------------
def test_refund_exceeding_remaining_is_refused_before_the_provider(db, customer, gateway):
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer, refund_amount="100.00")
    with pytest.raises(svc.RefundError) as e:
        go(db, c.cancellation_ref, amount_minor=10001)
    assert e.value.code == "exceeds_cancellation"
    assert gateway.calls == []


def test_two_cancellations_on_one_payment_cannot_exceed_the_capture(db, customer, gateway):
    booking, pay = captured_payment(db, customer)
    a = cancellation(db, booking, customer, refund_amount="70.00")
    go(db, a.cancellation_ref)                                       # 70 of 100 refunded
    # A second cancellation of the same booking/payment asks for 50: 70 + 50 > 100.
    b = cancellation(db, booking, customer, refund_amount="50.00")
    with pytest.raises(svc.RefundError) as e:
        go(db, b.cancellation_ref)
    assert e.value.code == "exceeds_remaining"
    assert "30.00" in str(e.value)
    assert len(gateway.calls) == 1
    # ...but what is genuinely left can be refunded.
    b.refund_amount = decimal.Decimal("30.00")
    db.commit()
    attempt, outcome = go(db, b.cancellation_ref)
    refresh(db, pay)
    assert outcome == "succeeded" and pay.status == CustomerPaymentStatus.REFUNDED.value


def test_processing_refund_counts_against_the_balance(db, customer, gateway):
    gateway.mode = "pending"
    booking, _ = captured_payment(db, customer)
    a = cancellation(db, booking, customer, refund_amount="70.00")
    attempt, outcome = go(db, a.cancellation_ref)
    assert outcome == "processing" and attempt.status == svc.PROCESSING

    b = cancellation(db, booking, customer, refund_amount="50.00")
    with pytest.raises(svc.RefundError) as e:
        go(db, b.cancellation_ref)
    assert e.value.code == "exceeds_remaining"                       # the in-flight 70 counts
    ov = svc.refund_overview(db, a.cancellation_ref)
    assert ov["in_progress"] == decimal.Decimal("70.00") and ov["previously_refunded"] == 0
    assert ov["remaining_refundable"] == decimal.Decimal("30.00")


def test_pending_and_failed_attempts_do_not_block_the_balance(db, customer, gateway, monkeypatch):
    booking, pay = captured_payment(db, customer)
    monkeypatch.setattr(settings, "refund_approval_threshold_minor", 0)
    a = cancellation(db, booking, customer, refund_amount="100.00")
    attempt, outcome = go(db, a.cancellation_ref)                    # pending approval
    assert outcome == "awaiting_approval"
    ov = svc.refund_overview(db, a.cancellation_ref)
    assert ov["remaining_refundable"] == decimal.Decimal("100.00")   # pending is not money out


def test_concurrent_request_during_a_provider_call_sees_the_processing_row(tmp_path, customer, monkeypatch):
    """Two sessions, one payment. The first commits `processing` BEFORE it calls
    the provider, so a second admin acting while that call is in flight is
    refused instead of both reading the same 'remaining'."""
    engine = create_engine(f"sqlite:///{tmp_path / 'r.db'}", connect_args={"timeout": 5})
    Base.metadata.create_all(engine, tables=_tables())
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    s1, s2 = Session(), Session()
    cust = Customer(customer_id=_next_id(), customer_code="CUST-C1", full_name="Concurrent",
                    email="c@example.test", mobile="9000000002")
    s1.add(cust)
    s1.flush()
    booking, pay = captured_payment(s1, cust, ref="JPH200001")
    c1 = cancellation(s1, booking, cust, refund_amount="70.00")
    c2 = cancellation(s1, booking, cust, refund_amount="50.00")

    gw = Gateway()
    monkeypatch.setattr(payment_providers, "get_provider_named", lambda name: gw)
    seen = {}

    def second_admin_acts_mid_call():
        try:
            svc.initiate_refund(s2, c2.cancellation_ref, OTHER_MAKER)
        except svc.RefundError as exc:
            seen["code"] = exc.code
    gw.on_refund = second_admin_acts_mid_call

    _, outcome = svc.initiate_refund(s1, c1.cancellation_ref, MAKER)

    assert outcome == "succeeded"
    assert seen["code"] == "exceeds_remaining"
    assert len(gw.calls) == 1
    s1.close()
    s2.close()
    engine.dispose()


def test_payment_row_is_locked_for_update(db, customer, gateway, monkeypatch):
    """The balance decision is made under SELECT ... FOR UPDATE on the payment row."""
    from sqlalchemy.orm import Session as SASession

    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    locked = []
    real = SASession.execute

    def spy(self, statement, *a, **k):
        arg = getattr(statement, "_for_update_arg", None)
        if arg is not None:
            locked.append(str(statement))
        return real(self, statement, *a, **k)

    monkeypatch.setattr(SASession, "execute", spy)
    go(db, c.cancellation_ref)
    assert any("customer_hotel_booking_payments" in s for s in locked), locked


# ---------------------------------------------------------------------------
# Failure, retry, idempotency, uncertainty
# ---------------------------------------------------------------------------
def test_clean_failure_frees_the_balance_and_a_retry_uses_a_new_key(db, customer, gateway):
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    gateway.mode = "refuse"
    a1, outcome = go(db, c.cancellation_ref)
    assert outcome == "failed" and a1.status == svc.FAILED and "refused" in a1.failure_reason
    refresh(db, c)
    assert c.status == "refund_processing"                           # not refunded
    assert svc.refund_overview(db, c.cancellation_ref)["remaining_refundable"] == decimal.Decimal("100.00")

    gateway.mode = "ok"
    a2, outcome = go(db, c.cancellation_ref)                         # SAFE retry
    assert outcome == "succeeded" and a2.attempt_number == 2
    assert a2.idempotency_key != a1.idempotency_key


def test_repeated_request_returns_the_open_attempt_and_calls_nothing_new(db, customer, gateway):
    gateway.mode = "pending"
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a1, o1 = go(db, c.cancellation_ref)
    a2, o2 = go(db, c.cancellation_ref, who=OTHER_MAKER)
    a3, o3 = go(db, c.cancellation_ref)
    assert o1 == "processing" and o2 == o3 == "existing"
    assert a1.refund_attempt_id == a2.refund_attempt_id == a3.refund_attempt_id
    assert len(gateway.calls) == 1 and len(attempts(db)) == 1


def test_provider_side_idempotency_same_key_same_refund(db, customer, gateway):
    r1 = gateway.refund(provider_payment_id="p", amount_minor=100, idempotency_key="k")
    r2 = gateway.refund(provider_payment_id="p", amount_minor=100, idempotency_key="k")
    assert r1.provider_refund_id == r2.provider_refund_id and len(gateway.by_key) == 1


def test_timeout_is_uncertain_counts_and_is_never_retried_blindly(db, customer, gateway):
    gateway.mode = "timeout_executed"          # the provider DID refund; we never saw the answer
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)

    a, outcome = go(db, c.cancellation_ref)

    assert outcome == "uncertain" and a.status == svc.PROCESSING and a.provider_status == "uncertain"
    assert a.provider_refund_id is None and "unknown" in a.failure_reason.lower()
    refresh(db, c)
    assert c.status == "refund_processing"
    # The unknown amount STILL counts, and a second click does not re-send.
    assert svc.refund_overview(db, c.cancellation_ref)["in_progress"] == decimal.Decimal("100.00")
    b, again = go(db, c.cancellation_ref)
    assert again == "existing" and len(gateway.calls) == 1

    # Reconciliation finds the refund by the idempotency key and settles it.
    tally = svc.reconcile_pending_refunds(db)
    refresh(db, c, a)
    assert tally["succeeded"] == 1 and a.status == svc.SUCCEEDED and a.provider_refund_id
    assert c.status == "refunded"
    assert gateway.fetch_calls[-1]["key"] == a.idempotency_key


@pytest.mark.parametrize("mode", ["timeout_lost", "server_error"])
def test_uncertain_and_unconfirmed_needs_an_operator_to_close(db, customer, gateway, mode):
    gateway.mode = mode
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, outcome = go(db, c.cancellation_ref)
    assert outcome == "uncertain"

    tally = svc.reconcile_pending_refunds(db)
    assert tally["not_found"] == 1 and tally["succeeded"] == 0
    refresh(db, a)
    assert a.status == svc.PROCESSING                                 # "not found" is not permission

    with pytest.raises(svc.RefundError) as e:                          # needs refund.reconcile + a reason
        svc.resolve_uncertain_as_failed(db, a.refund_attempt_id, actor(9, role=UserRole.SUPER_ADMIN), "checked")
    assert e.value.code == "forbidden"
    with pytest.raises(svc.RefundError):
        svc.resolve_uncertain_as_failed(db, a.refund_attempt_id, MAKER, "  ")
    svc.resolve_uncertain_as_failed(db, a.refund_attempt_id, MAKER, "Checked Razorpay dashboard: none")
    refresh(db, a)
    assert a.status == svc.FAILED and "operator" in a.failure_reason.lower()

    gateway.mode = "ok"
    again, outcome = go(db, c.cancellation_ref)
    assert outcome == "succeeded" and again.attempt_number == 2


def test_provider_reporting_a_different_amount_is_flagged_not_trusted(db, customer, gateway):
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer, refund_amount="30.00")
    real = gateway.refund

    def wrong(**kw):
        r = real(**kw)
        return P.ProviderRefund(**{**r.__dict__, "amount_minor": 9000})   # asked 3000, provider says 9000
    gateway.refund = wrong
    a, outcome = go(db, c.cancellation_ref)
    assert outcome == "uncertain" and a.status == svc.PROCESSING
    assert a.amount_minor == 9000 and "manual review" in a.failure_reason  # larger figure counted


# ---------------------------------------------------------------------------
# Eligibility
# ---------------------------------------------------------------------------
def test_no_captured_payment_cannot_be_refunded(db, customer, gateway):
    booking = make_booking(db, customer, ref="JPH300001", status="cancelled")
    make_payment(db, booking, amount="56.00", status=CustomerPaymentStatus.PENDING.value, provider="razorpay")
    db.commit()
    c = cancellation(db, booking, customer, refund_amount="56.00")
    with pytest.raises(svc.RefundError) as e:
        go(db, c.cancellation_ref)
    assert e.value.code == "no_captured_payment" and gateway.calls == []


def test_wrong_cancellation_state_and_zero_amount(db, customer, gateway):
    booking, _ = captured_payment(db, customer)
    req = cancellation(db, booking, customer, status="requested")
    with pytest.raises(svc.RefundError) as e:
        go(db, req.cancellation_ref)
    assert e.value.code == "wrong_state"
    ok = cancellation(db, booking, customer)
    with pytest.raises(svc.RefundError) as e:
        go(db, ok.cancellation_ref, amount_minor=0)
    assert e.value.code == "invalid_amount"


def test_a_payment_without_a_provider_is_not_refundable_here(db, customer, gateway):
    booking = make_booking(db, customer, ref="JPH300002", status="cancelled")
    make_payment(db, booking, amount="56.00", status=CustomerPaymentStatus.CAPTURED.value, provider=None)
    db.commit()
    c = cancellation(db, booking, customer, refund_amount="56.00")
    with pytest.raises(svc.RefundError) as e:
        go(db, c.cancellation_ref)
    assert e.value.code == "no_provider"


def test_refund_uses_the_provider_that_collected_the_money(db, customer, monkeypatch):
    asked = []
    gw = Gateway(name="hdfc")
    monkeypatch.setattr(payment_providers, "get_provider_named", lambda name: (asked.append(name), gw)[1])
    booking, _ = captured_payment(db, customer, provider="hdfc", pid="ORD_HDFC_1")
    c = cancellation(db, booking, customer)
    go(db, c.cancellation_ref)
    assert asked == ["hdfc"]                                          # not the configured default


def test_gateway_that_turns_out_to_have_no_refund_api_goes_manual(db, customer, gateway):
    gateway.mode = "unsupported"
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, outcome = go(db, c.cancellation_ref)
    assert outcome == "manual_required" and a.status == svc.MANUAL_REQUIRED and a.is_manual


# ---------------------------------------------------------------------------
# Maker-checker
# ---------------------------------------------------------------------------
@pytest.fixture()
def maker_checker(monkeypatch):
    monkeypatch.setattr(settings, "refund_approval_threshold_minor", 0)


def test_with_approval_required_nothing_moves_until_a_different_authoriser(db, customer, gateway, maker_checker):
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)

    a, outcome = go(db, c.cancellation_ref)
    assert outcome == "awaiting_approval" and a.status == svc.PENDING and a.approval_required
    assert gateway.calls == []
    refresh(db, c)
    assert c.status == "refund_processing"                            # not refunded

    with pytest.raises(svc.RefundError) as e:                          # the maker cannot approve
        svc.authorize_refund(db, a.refund_attempt_id, actor(1, "refund.authorize"))
    assert e.value.code == "self_approval" and gateway.calls == []

    with pytest.raises(svc.RefundError) as e:                          # holds no refund.authorize
        svc.authorize_refund(db, a.refund_attempt_id, OTHER_MAKER)
    assert e.value.code == "forbidden" and gateway.calls == []

    done, outcome = svc.authorize_refund(db, a.refund_attempt_id, CHECKER)
    assert outcome == "succeeded" and len(gateway.calls) == 1
    refresh(db, done, c)
    assert done.initiated_by_user_id == 1 and done.approved_by_user_id == 3
    assert c.status == "refunded"

    again, outcome = svc.authorize_refund(db, a.refund_attempt_id, CHECKER_2)   # replay is harmless
    assert outcome == "existing" and len(gateway.calls) == 1


def test_initiating_needs_refund_execute(db, customer, gateway):
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    with pytest.raises(svc.RefundError) as e:
        go(db, c.cancellation_ref, who=actor(5, role=UserRole.SUPER_ADMIN))   # view only
    assert e.value.code == "forbidden" and gateway.calls == []


def test_balance_that_shrinks_while_waiting_for_approval_fails_it_cleanly(db, customer, gateway, maker_checker, monkeypatch):
    booking, _ = captured_payment(db, customer)
    a_c = cancellation(db, booking, customer, refund_amount="70.00")
    b_c = cancellation(db, booking, customer, refund_amount="70.00")
    a, _ = go(db, a_c.cancellation_ref)
    b, _ = go(db, b_c.cancellation_ref)                              # both pending: neither counts yet
    svc.authorize_refund(db, a.refund_attempt_id, CHECKER)           # 70 goes out
    done, outcome = svc.authorize_refund(db, b.refund_attempt_id, CHECKER)
    assert outcome == "failed" and "Not sent" in done.failure_reason
    assert len(gateway.calls) == 1


# ---------------------------------------------------------------------------
# TrustBrick: a controlled MANUAL workflow, never a pretend gateway refund
# ---------------------------------------------------------------------------
class ExplodingTrustBrick:
    name = "trustbrick"

    def refund(self, **kw):
        raise AssertionError("TrustBrick has no refund API; it must never be called")


def trustbrick_cancellation(db, customer, monkeypatch, *, ref="JPH400001", amount="100.00", refund="100.00"):
    monkeypatch.setattr(payment_providers, "get_provider_named", lambda name: ExplodingTrustBrick())
    booking, pay = captured_payment(db, customer, ref=ref, amount=amount, provider="trustbrick", pid="tb_pay_1")
    return booking, pay, cancellation(db, booking, customer, refund_amount=refund)


def test_trustbrick_refund_is_manual_required_and_calls_no_gateway(db, customer, monkeypatch):
    _, pay, c = trustbrick_cancellation(db, customer, monkeypatch)
    a, outcome = go(db, c.cancellation_ref)
    assert outcome == "manual_required" and a.status == svc.MANUAL_REQUIRED and a.is_manual
    refresh(db, c, pay)
    assert c.status == "refund_processing"                           # NEVER 'refunded' yet
    assert pay.status == CustomerPaymentStatus.CAPTURED.value
    ov = svc.refund_overview(db, c.cancellation_ref)
    assert ov["manual_only"] and ov["previously_refunded"] == 0 and ov["remaining_refundable"] == decimal.Decimal("100.00")


def test_trustbrick_manual_record_needs_override_reference_and_reason(db, customer, monkeypatch):
    _, _, c = trustbrick_cancellation(db, customer, monkeypatch)
    go(db, c.cancellation_ref)
    for kw, code in [
        (dict(admin_override=False, reference="UTR1", reason="paid"), "override_required"),
        (dict(admin_override=True, reference="", reason="paid"), "details_required"),
        (dict(admin_override=True, reference="UTR1", reason=" "), "details_required"),
    ]:
        with pytest.raises(svc.RefundError) as e:
            svc.record_manual_refund(db, c.cancellation_ref, MAKER, amount_minor=None, **kw)
        assert e.value.code == code
    assert attempts(db)[0].status == svc.MANUAL_REQUIRED


def test_trustbrick_manual_record_audited_with_operator_and_maker_checker(db, customer, monkeypatch, maker_checker):
    _, pay, c = trustbrick_cancellation(db, customer, monkeypatch)
    go(db, c.cancellation_ref)                                       # maker = user 1
    args = dict(amount_minor=None, reference="UTR-778899", reason="Bank transfer to customer", admin_override=True)

    with pytest.raises(svc.RefundError) as e:                          # execute-only user cannot record
        svc.record_manual_refund(db, c.cancellation_ref, OTHER_MAKER, **args)
    assert e.value.code == "forbidden"
    with pytest.raises(svc.RefundError) as e:                          # nor can the maker, even if granted
        svc.record_manual_refund(db, c.cancellation_ref, actor(1, "refund.authorize"), **args)
    assert e.value.code == "self_approval"

    a = svc.record_manual_refund(db, c.cancellation_ref, CHECKER, **args)

    refresh(db, c, pay)
    assert a.status == svc.SUCCEEDED and a.is_manual and a.admin_override
    assert a.manual_reference == "UTR-778899" and a.manual_reason == "Bank transfer to customer"
    assert a.initiated_by_user_id == 1 and a.completed_by_user_id == 3 and a.approved_by_user_id == 3
    assert a.provider_refund_id is None and a.provider_status == "manual_recorded"
    assert c.status == "refunded" and pay.status == CustomerPaymentStatus.REFUNDED.value


def test_trustbrick_manual_amount_is_checked_against_the_cumulative_balance(db, customer, monkeypatch):
    booking, pay, c1 = trustbrick_cancellation(db, customer, monkeypatch, refund="80.00")
    go(db, c1.cancellation_ref)
    svc.record_manual_refund(db, c1.cancellation_ref, MAKER, amount_minor=None, reference="U1",
                             reason="paid", admin_override=True)
    c2 = cancellation(db, booking, customer, refund_amount="50.00")
    go(db, c2.cancellation_ref) if False else None                    # initiating already trips the check
    with pytest.raises(svc.RefundError) as e:
        go(db, c2.cancellation_ref)
    assert e.value.code == "exceeds_remaining"
    c2.refund_amount = decimal.Decimal("20.00")
    db.commit()
    go(db, c2.cancellation_ref)
    with pytest.raises(svc.RefundError) as e:                          # operator tries to record more than is left
        svc.record_manual_refund(db, c2.cancellation_ref, MAKER, amount_minor=2500, reference="U2",
                                 reason="paid", admin_override=True)
    assert e.value.code in ("exceeds_cancellation", "exceeds_remaining")


def test_trustbrick_adapter_never_pretends(monkeypatch):
    from app.services.payments.trustbrick_provider import TrustBrickProvider

    tb = TrustBrickProvider.__new__(TrustBrickProvider)
    with pytest.raises(P.PaymentProviderError) as e:
        tb.refund(provider_payment_id="x", amount_minor=100, idempotency_key="k")
    assert e.value.code == "refund_unsupported"
    with pytest.raises(P.PaymentProviderError) as e:
        tb.fetch_refund(provider_payment_id="x", provider_refund_id="r")
    assert e.value.code == "refund_unsupported"          # unsupported, not "no refund exists"


# ---------------------------------------------------------------------------
# Provider adapters: Razorpay and HDFC response handling
# ---------------------------------------------------------------------------
def razorpay():
    from app.services.payments.razorpay_provider import RazorpayProvider

    return RazorpayProvider("rzp_test_key", "secret", "whsec")


@pytest.mark.parametrize("vendor,expected", [("processed", P.REFUNDED), ("pending", P.PROCESSING), ("failed", P.FAILED)])
def test_razorpay_refund_response_mapping(monkeypatch, vendor, expected):
    rz = razorpay()
    seen = {}

    def fake(method, path, json_body=None, params=None):
        seen.update(method=method, path=path, body=json_body)
        return {"id": "rfnd_RZ1", "amount": 2500, "currency": "INR", "status": vendor,
                "payment_id": "pay_RZ", "receipt": json_body["receipt"]}

    monkeypatch.setattr(rz, "_request", fake)
    r = rz.refund(provider_payment_id="pay_RZ", amount_minor=2500, idempotency_key="rfnd-CXL-1-9-1")
    assert (seen["method"], seen["path"]) == ("POST", "/payments/pay_RZ/refund")
    assert seen["body"]["amount"] == 2500 and seen["body"]["receipt"] == "rfnd-CXL-1-9-1"
    assert r.status == expected and r.provider_refund_id == "rfnd_RZ1" and r.amount_minor == 2500
    assert r.request_ref == "rfnd-CXL-1-9-1"


def test_razorpay_fetch_refund_by_id_and_by_receipt(monkeypatch):
    rz = razorpay()
    items = [{"id": "rfnd_A", "amount": 100, "currency": "INR", "status": "pending", "receipt": "other", "payment_id": "p"},
             {"id": "rfnd_B", "amount": 200, "currency": "INR", "status": "processed", "receipt": "mykey", "payment_id": "p"}]

    def fake(method, path, json_body=None, params=None):
        if path == "/refunds/rfnd_A":
            return items[0]
        assert path == "/payments/p/refunds"
        return {"items": items}

    monkeypatch.setattr(rz, "_request", fake)
    assert rz.fetch_refund(provider_payment_id="p", provider_refund_id="rfnd_A").status == P.PROCESSING
    by_receipt = rz.fetch_refund(provider_payment_id="p", idempotency_key="mykey")
    assert by_receipt.provider_refund_id == "rfnd_B" and by_receipt.status == P.REFUNDED
    assert rz.fetch_refund(provider_payment_id="p", idempotency_key="nope") is None


def test_razorpay_error_classification_definitive_vs_unknown():
    rz = razorpay()

    def resp(code):
        return SimpleNamespace(status_code=code, text="{}", json=lambda: {"error": {"code": "BAD", "description": "d"}})

    assert rz._error_for(resp(400)).definitive is True
    assert rz._error_for(resp(404)).definitive is True
    assert rz._error_for(resp(429)).definitive is False
    assert rz._error_for(resp(502)).definitive is False


def test_hdfc_refund_response_and_lookup(monkeypatch):
    from tests.hdfc_fakes import FakeHDFC, FakeResponse, make_provider, order_doc

    p = make_provider()
    oid = "JPH500001X1"

    def answer(call):
        uid = call["data"]["unique_request_id"]
        doc = order_doc(oid, refunded=False)
        doc["refunds"] = [{"unique_request_id": uid, "id": "hdfc_rf_1", "status": "SUCCESS",
                           "amount": 25.5, "error_message": ""}]
        return FakeResponse(200, doc)

    fake = FakeHDFC(monkeypatch, {f"POST /orders/{oid}/refunds": answer})
    r = p.refund(provider_payment_id=oid, amount_minor=2550, idempotency_key="rfnd-CXL-1-9-1")
    assert r.status == P.REFUNDED and r.provider_refund_id == "hdfc_rf_1" and r.amount_minor == 2550
    assert r.request_ref.startswith("RF") and len(r.request_ref) <= 20

    doc = order_doc(oid)
    doc["refunds"] = [{"unique_request_id": r.request_ref, "id": "hdfc_rf_1", "status": "PENDING", "amount": 25.5}]
    fake.routes[f"GET /orders/{oid}"] = FakeResponse(200, doc)
    found = p.fetch_refund(provider_payment_id=oid, idempotency_key="rfnd-CXL-1-9-1")
    assert found.status == P.PROCESSING and found.provider_refund_id == "hdfc_rf_1"
    assert p.fetch_refund(provider_payment_id=oid, idempotency_key="other-key") is None


def test_hdfc_4xx_is_definitive_and_5xx_is_not(monkeypatch):
    from tests.hdfc_fakes import FakeHDFC, FakeResponse, make_provider

    p = make_provider()
    oid = "JPH500002X1"
    FakeHDFC(monkeypatch, {f"POST /orders/{oid}/refunds": FakeResponse(400, {"error_message": "bad amount"})})
    with pytest.raises(P.PaymentFailed) as e:
        p.refund(provider_payment_id=oid, amount_minor=100, idempotency_key="k1")
    assert e.value.definitive is True
    FakeHDFC(monkeypatch, {f"POST /orders/{oid}/refunds": FakeResponse(503, {})})
    with pytest.raises(P.PaymentTimeout) as e:
        p.refund(provider_payment_id=oid, amount_minor=100, idempotency_key="k1")
    assert e.value.definitive is False


# ---------------------------------------------------------------------------
# Webhooks: correlation and verification
# ---------------------------------------------------------------------------
def report(refund_id="rfnd_0001", amount=10000, request_ref=None):
    return P.ProviderRefund(provider_refund_id=refund_id, status=P.REFUNDED, provider_status="processed",
                            amount_minor=amount, currency="INR", request_ref=request_ref)


def webhook_event(pay, reports, event_id="evt_1", event_type="refund.processed"):
    payment = P.ProviderPayment(status=P.REFUNDED, provider_status=event_type, provider_payment_id=pay.provider_payment_id,
                                currency="INR", refunds=tuple(reports))
    return P.ProviderEvent(event_id=event_id, event_type=event_type, payment=payment, supported=True)


def deliver(db, ev, provider="razorpay"):
    return payment_event_service.apply_event(db, SimpleNamespace(provider=provider), ev)


def test_webhook_for_a_processing_refund_is_verified_with_the_provider_then_applied(db, customer, gateway):
    gateway.mode = "pending"
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, _ = go(db, c.cancellation_ref)
    rid = a.provider_refund_id
    gateway.status_override = P.REFUNDED                         # the provider API now says processed

    status, note = deliver(db, webhook_event(pay, [report(rid)]))

    assert status == "processed"
    refresh(db, a, c)
    assert a.status == svc.SUCCEEDED and c.status == "refunded"
    assert gateway.fetch_calls, "the refund must be re-read from the provider, not believed"


def test_a_webhook_alone_never_marks_a_refund_successful(db, customer, gateway):
    gateway.mode = "pending"
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, _ = go(db, c.cancellation_ref)
    # The body CLAIMS processed; the provider's own API still says pending.
    status, _ = deliver(db, webhook_event(pay, [report(a.provider_refund_id)]))
    refresh(db, a, c)
    assert a.status == svc.PROCESSING and c.status == "refund_processing"


def test_webhook_that_cannot_be_verified_is_deferred(db, customer, gateway):
    gateway.mode = "pending"
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, _ = go(db, c.cancellation_ref)
    gateway.fetch_raises = P.PaymentTimeout("down")
    status, note = deliver(db, webhook_event(pay, [report(a.provider_refund_id)]))
    assert status == "deferred" and "could not verify" in note
    refresh(db, a)
    assert a.status == svc.PROCESSING


def test_duplicate_webhook_deliveries_are_harmless(db, customer, gateway):
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, _ = go(db, c.cancellation_ref)                            # already succeeded via the API
    before = (a.status, a.updated_at, gateway.calls[:])
    s1, _ = deliver(db, webhook_event(pay, [report(a.provider_refund_id)], event_id="e1"))
    s2, n2 = deliver(db, webhook_event(pay, [report(a.provider_refund_id)], event_id="e2"))
    assert s1 == s2 == "processed" and "already succeeded" in n2
    refresh(db, a)
    assert a.status == svc.SUCCEEDED and len(attempts(db)) == 1 and gateway.calls == before[2]


def test_ambiguous_events_are_deferred_not_guessed(db, customer, gateway):
    gateway.mode = "timeout_lost"
    booking, pay = captured_payment(db, customer)
    c1 = cancellation(db, booking, customer, refund_amount="40.00")
    c2 = cancellation(db, booking, customer, refund_amount="40.00")
    a1, _ = go(db, c1.cancellation_ref)
    a2, _ = go(db, c2.cancellation_ref)                          # two processing, same amount, no refund ids
    assert a1.status == a2.status == svc.PROCESSING

    status, note = deliver(db, webhook_event(pay, [report("rfnd_unknown", amount=4000)]))

    assert status == "deferred" and "could not be matched" in note
    refresh(db, a1, a2)
    assert a1.status == a2.status == svc.PROCESSING and a1.provider_refund_id is None


def test_unmatched_and_contradicting_events_are_deferred(db, customer, gateway):
    booking, pay = captured_payment(db, customer)
    # no attempt exists at all
    assert deliver(db, webhook_event(pay, [report("rfnd_x")]))[0] == "deferred"
    gateway.mode = "timeout_lost"
    c = cancellation(db, booking, customer, refund_amount="40.00")
    go(db, c.cancellation_ref)
    # the amount contradicts the only candidate
    assert deliver(db, webhook_event(pay, [report("rfnd_y", amount=9999)]))[0] == "deferred"


def test_event_correlated_by_the_providers_echo_of_our_idempotency_key(db, customer, gateway):
    gateway.mode = "timeout_executed"
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer, refund_amount="40.00")
    a, _ = go(db, c.cancellation_ref)
    rep = gateway.by_key[a.idempotency_key]
    status, _ = deliver(db, webhook_event(pay, [report(rep.provider_refund_id, 4000, request_ref=a.idempotency_key)]))
    refresh(db, a)
    assert status == "processed" and a.status == svc.SUCCEEDED and a.provider_refund_id == rep.provider_refund_id


def test_trustbrick_refund_event_is_deferred_and_never_completes_a_manual_refund(db, customer, monkeypatch):
    _, pay, c = trustbrick_cancellation(db, customer, monkeypatch, ref="JPH600001")
    a, _ = go(db, c.cancellation_ref)
    status, _ = deliver(db, webhook_event(pay, [report("rfnd_tb")]), provider="trustbrick")
    refresh(db, a, c)
    assert status == "deferred" and a.status == svc.MANUAL_REQUIRED and c.status == "refund_processing"


def test_razorpay_refund_webhook_is_parsed_from_the_refund_entity():
    from app.services.payments.razorpay_provider import RazorpayProvider

    rz = RazorpayProvider("rzp_test_key", "secret", "whsec")
    body = json.dumps({
        "event": "refund.processed",
        "payload": {"refund": {"entity": {"id": "rfnd_WH1", "payment_id": "pay_WH", "amount": 4000, "currency": "INR",
                                          "status": "processed", "receipt": "rfnd-CXL-1-9-1"}}},
    }).encode()
    sig = hmac.new(b"whsec", body, hashlib.sha256).hexdigest()
    ev = rz.verify_webhook(body, {"x-razorpay-signature": sig, "x-razorpay-event-id": "evt_wh1"})
    assert ev.supported and ev.payment.provider_payment_id == "pay_WH"
    (rep,) = ev.payment.refunds
    assert (rep.provider_refund_id, rep.amount_minor, rep.request_ref) == ("rfnd_WH1", 4000, "rfnd-CXL-1-9-1")
    # a refund.failed notice is recognised too, and reports FAILED
    body2 = body.replace(b"refund.processed", b"refund.failed").replace(b'"processed"', b'"failed"')
    sig2 = hmac.new(b"whsec", body2, hashlib.sha256).hexdigest()
    ev2 = rz.verify_webhook(body2, {"x-razorpay-signature": sig2, "x-razorpay-event-id": "evt_wh2"})
    assert ev2.supported and ev2.payment.refunds[0].status == P.FAILED
    # an unsigned/forged delivery is discarded before any of this
    with pytest.raises(P.WebhookVerificationError):
        rz.verify_webhook(body, {"x-razorpay-signature": "0" * 64, "x-razorpay-event-id": "e"})


def test_hdfc_refund_webhook_carries_the_refunds_array():
    from tests.hdfc_fakes import WEBHOOK_PASS, WEBHOOK_USER, basic, make_provider, order_doc

    p = make_provider()
    doc = order_doc("JPH700001X1")
    doc["refunds"] = [{"unique_request_id": "RFabc", "id": "hdfc_rf_9", "status": "SUCCESS", "amount": 40.0}]
    body = json.dumps({"id": "evt_hd1", "event_name": "ORDER_REFUNDED", "content": {"order": doc}}, default=str).encode()
    ev = p.verify_webhook(body, {"authorization": basic(WEBHOOK_USER, WEBHOOK_PASS)})
    assert ev.supported
    (rep,) = ev.payment.refunds
    assert (rep.provider_refund_id, rep.amount_minor, rep.request_ref) == ("hdfc_rf_9", 4000, "RFabc")


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------
def test_reconcile_settles_pending_refunds_and_is_idempotent(db, customer, gateway):
    gateway.mode = "pending"
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, _ = go(db, c.cancellation_ref)

    t1 = svc.reconcile_pending_refunds(db)
    assert t1["seen"] == 1 and t1["still_processing"] == 1
    refresh(db, a)
    assert a.status == svc.PROCESSING

    gateway.status_override = P.REFUNDED
    t2 = svc.reconcile_pending_refunds(db)
    t3 = svc.reconcile_pending_refunds(db)
    refresh(db, a, c, pay)
    assert t2["succeeded"] == 1 and t3["seen"] == 0
    assert a.status == svc.SUCCEEDED and c.status == "refunded" and pay.status == CustomerPaymentStatus.REFUNDED.value


def test_reconcile_frees_the_balance_of_a_refund_the_provider_failed(db, customer, gateway):
    gateway.mode = "pending"
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, _ = go(db, c.cancellation_ref)
    gateway.status_override = P.FAILED
    t = svc.reconcile_pending_refunds(db)
    refresh(db, a, c)
    assert t["failed"] == 1 and a.status == svc.FAILED and c.status == "refund_processing"
    assert svc.refund_overview(db, c.cancellation_ref)["remaining_refundable"] == decimal.Decimal("100.00")


def test_reconcile_leaves_recent_attempts_alone_and_survives_provider_errors(db, customer, gateway, monkeypatch):
    gateway.mode = "pending"
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    go(db, c.cancellation_ref)
    assert svc.reconcile_pending_refunds(db, min_age_seconds=3600)["seen"] == 0
    gateway.fetch_raises = P.PaymentTimeout("down")
    t = svc.reconcile_pending_refunds(db)
    assert t["errors"] == 1 and t["succeeded"] == 0


def test_late_processed_report_for_a_locally_failed_attempt_is_flagged_not_flipped(db, customer, gateway):
    gateway.mode = "timeout_lost"
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    a, _ = go(db, c.cancellation_ref)
    svc.resolve_uncertain_as_failed(db, a.refund_attempt_id, MAKER, "looked at the dashboard")
    out = svc.apply_provider_refund(db, a.refund_attempt_id, report("rfnd_late", 10000))
    refresh(db, a)
    assert out == svc.FAILED and a.status == svc.FAILED and "WARNING" in a.failure_reason


# ---------------------------------------------------------------------------
# Database guarantees
# ---------------------------------------------------------------------------
def _attempt(c, pay_id, *, n, key, status="processing", refund_id=None):
    return CustomerRefundAttempt(
        refund_attempt_id=_next_id(), cancellation_ref=c.cancellation_ref, attempt_number=n, payment_table="customer_hotel_booking_payments",
        payment_row_id=pay_id, provider="razorpay", idempotency_key=key, amount_minor=100, status=status,
        provider_refund_id=refund_id,
    )


def test_one_in_flight_attempt_per_cancellation(db, customer):
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    db.add(_attempt(c, 1, n=1, key="k1", status="pending"))
    db.commit()
    db.add(_attempt(c, 1, n=2, key="k2", status="processing"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    db.add(_attempt(c, 1, n=2, key="k2", status="failed"))        # a finished one beside it is fine
    db.commit()


def test_idempotency_key_attempt_number_and_provider_refund_id_are_unique(db, customer):
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    d = cancellation(db, booking, customer)
    db.add(_attempt(c, 1, n=1, key="same", status="failed", refund_id="r1"))
    db.commit()
    for bad in (_attempt(d, 1, n=1, key="same", status="failed"),            # key reuse
                _attempt(c, 1, n=1, key="other", status="failed"),           # attempt number reuse
                _attempt(d, 1, n=1, key="third", status="failed", refund_id="r1")):  # refund id reuse
        db.add(bad)
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


def test_amount_must_be_positive(db, customer):
    booking, _ = captured_payment(db, customer)
    c = cancellation(db, booking, customer)
    bad = _attempt(c, 1, n=1, key="z", status="failed")
    bad.amount_minor = 0
    db.add(bad)
    with pytest.raises(IntegrityError):
        db.commit()


def test_migration_0094_extends_the_previous_head_without_forking():
    from pathlib import Path
    import re

    versions = Path(__file__).resolve().parents[1] / "alembic" / "versions"
    children = [
        f.name for f in versions.glob("*.py")
        if re.search(r'^down_revision[^=]*=\s*"0093_traveller_middle_name"', f.read_text(encoding="utf-8"), re.M)
    ]
    assert children == ["0094_customer_refund_attempts.py"], children
    text = (versions / "0094_customer_refund_attempts.py").read_text(encoding="utf-8")
    for needle in ("uq_refund_attempt_idempotency", "uq_refund_attempt_one_in_flight", "ck_refund_attempt_status"):
        assert needle in text


def test_target_amount_can_be_set_once_before_any_money_moves(db, customer, gateway):
    booking, pay = captured_payment(db, customer)
    c = cancellation(db, booking, customer, refund_amount="100.00")
    a, outcome = go(db, c.cancellation_ref, target_minor=3000)           # a PARTIAL refund of this booking
    refresh(db, c)
    assert outcome == "succeeded" and a.amount_minor == 3000 and c.status == "refunded"
    assert c.refund_amount == decimal.Decimal("30.00")
    with pytest.raises(svc.RefundError) as e:                              # locked once money has gone
        go(db, c.cancellation_ref, target_minor=9000)
    assert e.value.code in ("target_locked", "wrong_state")
