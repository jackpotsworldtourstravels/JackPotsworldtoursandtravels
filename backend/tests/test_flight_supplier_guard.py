"""The flight supplier guard (``services/supplier_guard``).

Nothing here touches a network, a real database or a supplier: HDFC's API is
``FakeHDFC``, Duffel's revalidation is replaced, and every test gets its own
in-memory SQLite database, so there is nothing shared to leak between tests or
into any real environment.

WHAT IS PINNED
  * Demo flights are unchanged: local, HDFC UAT/test, any amount.
  * Before a checkout: a live-supplier flight needs an offer id, a price and a
    passing revalidation; an unreachable supplier REFUSES. Live HDFC refuses a
    flight no supplier backs. No payment row exists after a refusal.
  * Before confirmation: a live-supplier flight is confirmed only with a valid
    supplier order id. Paid-but-unreserved stays captured + pending, one audit
    entry, no notification, and duplicates add nothing.
  * Resolution: complete_reservation confirms once; cancelling a held booking
    flags the refund owed; nothing is refunded automatically.
  * Hotels and packages are not touched by any of it.
"""

from __future__ import annotations

import datetime as dt
import decimal

import pytest
from sqlalchemy import func, select

import app.config
from app.integrations.duffel.exceptions import (
    DuffelAPIError,
    DuffelNotConfigured,
    DuffelOfferExpired,
    DuffelPriceChanged,
    DuffelTimeout,
    DuffelTransportError,
)
from app.models_customer import (
    Customer,
    CustomerAuditLog,
    CustomerBooking,
    CustomerBookingPayment,
    CustomerBookingStatus,
    CustomerNotification,
    CustomerPaymentStatus,
)
from app.services import customer_booking_service as flights
from app.services import flight_supplier_service as flight_supplier
from app.services import payment_event_service as events
from app.services import payment_verification_flight_service as flight_verify
from app.services import payments as P
from app.services import supplier_guard as G
from app.services.payments import hdfc_readiness
from app.services.payments.hdfc_provider import HDFCSmartGatewayProvider
from tests.hdfc_fakes import FakeHDFC, FakeResponse, make_provider, order_doc, session_doc, webhook_body
from tests.test_hdfc_products import pdb, provider  # noqa: F401  (fixtures by name)
from tests.test_hdfc_flow import AUTH

PROD_BASE = "https://smartgateway.hdfc.bank.in"
_N = {"n": 90000}


def _id():
    _N["n"] += 1
    return _N["n"]


def _settings(monkeypatch, **values):
    s = app.config.settings
    for k, v in values.items():
        monkeypatch.setattr(s, k, v)
    P.reset_provider_cache()


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    # Every test starts as a laptop on HDFC UAT with the demo supplier.
    _settings(monkeypatch, flight_supplier="demo", payment_environment="test",
              deployed=False, payment_provider="hdfc")
    yield
    P.reset_provider_cache()


def _flight(pdb, *, supplier=None, offer_id=None, order_id=None, supplier_total=None,
            ref="JPF000900", age_minutes=10):
    c = Customer(customer_id=_id(), customer_code=f"CUST{_id()}", full_name="Test Traveller",
                 email=f"t{_id()}@example.test", mobile="9000000000")
    pdb.add(c)
    pdb.flush()
    key = f"mb-{ref}"
    oid = HDFCSmartGatewayProvider.order_id_for(ref, key)
    created = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=age_minutes)
    b = CustomerBooking(
        customer_booking_id=_id(), booking_ref=ref, customer_id=c.customer_id,
        total_amount=decimal.Decimal("56.00"), currency="INR",
        status=CustomerBookingStatus.PENDING.value, created_at=created,
        supplier=supplier, supplier_offer_id=offer_id, supplier_order_id=order_id,
        supplier_total_amount=supplier_total,
    )
    pdb.add(b)
    pdb.flush()
    pay = CustomerBookingPayment(
        customer_booking_payment_id=_id(), customer_booking_id=b.customer_booking_id,
        method="gateway", amount=decimal.Decimal("56.00"), currency="INR",
        status=CustomerPaymentStatus.PENDING.value, provider="hdfc",
        provider_order_id=oid, idempotency_key=key, created_at=created,
    )
    pdb.add(pay)
    pdb.commit()
    return c, b, pay, oid


def _count(pdb, model, *where):
    return pdb.execute(select(func.count()).select_from(model).where(*where)).scalar_one()


def _confirmations(pdb):
    return _count(pdb, CustomerNotification, CustomerNotification.notification_type == "booking_confirmed")


def _held_audits(pdb):
    return _count(pdb, CustomerAuditLog,
                  CustomerAuditLog.action == "Payment captured, supplier reservation missing")


def _pay(monkeypatch, pdb, provider, oid):
    """Deliver HDFC's success: webhook -> Order Status says CHARGED Rs 56."""
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid))})
    return events.handle(pdb, provider.name, provider.verify_webhook(
        webhook_body(oid, event_id=f"evt_{_id()}"), AUTH))


def _reload(pdb, b, pay):
    pdb.expire_all()
    return (pdb.get(CustomerBooking, b.customer_booking_id),
            pdb.get(CustomerBookingPayment, pay.customer_booking_payment_id))


# ===========================================================================
# 1. Demo flights are unchanged
# ===========================================================================
def test_demo_flight_passes_the_checkout_guard_locally(pdb):
    _, b, _, _ = _flight(pdb)
    G.assert_checkout_allowed(b, "hdfc")                    # must not raise


def test_demo_flight_passes_on_hdfc_uat(pdb, monkeypatch):
    _settings(monkeypatch, payment_environment="test", deployed=True)
    _, b, _, _ = _flight(pdb)
    G.assert_checkout_allowed(b, "hdfc")


def test_demo_flight_is_confirmed_exactly_as_before(monkeypatch, pdb, provider):
    _, b, pay, oid = _flight(pdb)
    _pay(monkeypatch, pdb, provider, oid)
    b, pay = _reload(pdb, b, pay)
    assert pay.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert _confirmations(pdb) == 1 and _held_audits(pdb) == 0
    assert b.supplier_status is None


# ===========================================================================
# 2. Live HDFC refuses a flight no supplier backs; UAT does not
# ===========================================================================
@pytest.mark.parametrize("env", ["live", "production"])
def test_live_hdfc_refuses_a_demo_supplier_flight(pdb, monkeypatch, env):
    _settings(monkeypatch, payment_environment=env, flight_supplier="demo")
    _, b, _, _ = _flight(pdb)
    with pytest.raises(G.SupplierUnavailable) as exc:
        G.assert_checkout_allowed(b, "hdfc")
    assert exc.value.code == "live_payment_demo_supplier"
    # The customer is told nothing about suppliers.
    assert exc.value.customer_message == "Online payment is not available on this booking."


def test_the_live_rule_is_for_hdfc_only(pdb, monkeypatch):
    _settings(monkeypatch, payment_environment="live", flight_supplier="demo")
    _, b, _, _ = _flight(pdb)
    G.assert_checkout_allowed(b, "razorpay")                # untouched: not this task


def test_start_checkout_under_live_hdfc_and_demo_supplier_opens_nothing(pdb, monkeypatch):
    _settings(monkeypatch, payment_environment="live", flight_supplier="demo")
    c, b, pay, _ = _flight(pdb)
    pdb.delete(pay)
    pdb.commit()

    class Hdfc:
        name = "hdfc"
        publishable_key = "mid"

        def create_checkout(self, **kw):
            raise AssertionError("a provider order was opened for a refused flight")

    fake = Hdfc()
    monkeypatch.setattr(P, "get_provider_for_booking", lambda ref: fake)
    monkeypatch.setattr(P, "require_customer_access", lambda p, c: None)
    with pytest.raises(G.SupplierUnavailable):
        flights.start_checkout(pdb, c, b, idempotency_key="mb-refused-001")
    assert _count(pdb, CustomerBookingPayment) == 0         # no payment row


# ===========================================================================
# 3. Live-supplier checkout: offer id, price, revalidation, fail closed
# ===========================================================================
def _live(monkeypatch):
    _settings(monkeypatch, flight_supplier="duffel")


def test_live_supplier_flight_needs_an_offer_id(pdb, monkeypatch):
    _live(monkeypatch)
    _, b, _, _ = _flight(pdb, supplier="duffel", supplier_total=decimal.Decimal("10.00"))
    with pytest.raises(G.SupplierUnavailable) as exc:
        G.assert_checkout_allowed(b, "hdfc")
    assert exc.value.code == "supplier_offer_missing"


def test_live_supplier_flight_needs_the_price_shown(pdb, monkeypatch):
    _live(monkeypatch)
    _, b, _, _ = _flight(pdb, supplier="duffel", offer_id="off_123")
    with pytest.raises(G.SupplierUnavailable) as exc:
        G.assert_checkout_allowed(b, "hdfc")
    assert exc.value.code == "supplier_price_missing"


def test_an_unbacked_flight_is_refused_while_a_live_supplier_is_active(pdb, monkeypatch):
    """FLIGHT_SUPPLIER=duffel: even a booking with NO supplier reference is refused."""
    _live(monkeypatch)
    _, b, _, _ = _flight(pdb)
    with pytest.raises(G.SupplierUnavailable) as exc:
        G.assert_checkout_allowed(b, "hdfc")
    assert exc.value.code == "supplier_offer_missing"


def test_unknown_supplier_is_refused(pdb, monkeypatch):
    _live(monkeypatch)
    _, b, _, _ = _flight(pdb, supplier="mystery", offer_id="o1",
                         supplier_total=decimal.Decimal("10.00"))
    with pytest.raises(G.SupplierUnavailable) as exc:
        G.assert_checkout_allowed(b, "hdfc")
    assert exc.value.code == "supplier_unsupported"


def _revalidate_raises(monkeypatch, exc):
    def boom(offer_id, **kw):
        raise exc
    monkeypatch.setattr(flight_supplier, "revalidate_offer", boom)


@pytest.mark.parametrize("exc,code", [
    (DuffelOfferExpired(410, "gone", code="offer_expired"), "supplier_offer_expired"),
    (DuffelPriceChanged("off_1", "10.00", "12.00", "GBP"), "supplier_price_changed"),
    (DuffelNotConfigured("no token"), "supplier_not_configured"),
    (DuffelTimeout("slow"), "supplier_unreachable"),
    (DuffelTransportError("reset"), "supplier_unreachable"),
    (DuffelAPIError(500, "boom"), "supplier_unreachable"),
])
def test_every_revalidation_failure_refuses_the_checkout(pdb, monkeypatch, exc, code):
    _live(monkeypatch)
    _, b, _, _ = _flight(pdb, supplier="duffel", offer_id="off_1",
                         supplier_total=decimal.Decimal("10.00"))
    _revalidate_raises(monkeypatch, exc)
    with pytest.raises(G.SupplierUnavailable) as e:
        G.assert_checkout_allowed(b, "hdfc")
    assert e.value.code == code
    assert e.value.customer_message == "Online payment is not available on this booking."


def test_a_passing_revalidation_allows_checkout_and_is_asked_once(pdb, monkeypatch):
    _live(monkeypatch)
    _, b, _, _ = _flight(pdb, supplier="duffel", offer_id="off_1",
                         supplier_total=decimal.Decimal("10.00"))
    calls = []
    monkeypatch.setattr(flight_supplier, "revalidate_offer",
                        lambda offer_id, **kw: calls.append((offer_id, kw)))
    G.assert_checkout_allowed(b, "hdfc")
    assert calls == [("off_1", {"shown_amount": "10.00"})]


def test_a_supplier_refusal_leaves_no_payment_row(pdb, monkeypatch):
    _live(monkeypatch)
    c, b, pay, _ = _flight(pdb, supplier="duffel", offer_id="off_1",
                           supplier_total=decimal.Decimal("10.00"))
    pdb.delete(pay)
    pdb.commit()
    _revalidate_raises(monkeypatch, DuffelTimeout("slow"))

    class Hdfc:
        name = "hdfc"
        publishable_key = "mid"

        def create_checkout(self, **kw):
            raise AssertionError("a provider order was opened for a refused flight")

    monkeypatch.setattr(P, "get_provider_for_booking", lambda ref: Hdfc())
    monkeypatch.setattr(P, "require_customer_access", lambda p, c: None)
    with pytest.raises(G.SupplierUnavailable):
        flights.start_checkout(pdb, c, b, idempotency_key="mb-refused-002")
    assert _count(pdb, CustomerBookingPayment) == 0


# ===========================================================================
# 4. Confirmation: never without a valid supplier order id
# ===========================================================================
def test_captured_without_a_supplier_order_stays_pending_and_silent(monkeypatch, pdb, provider):
    _live(monkeypatch)
    _, b, pay, oid = _flight(pdb, supplier="duffel", offer_id="off_1",
                             supplier_total=decimal.Decimal("10.00"))
    _pay(monkeypatch, pdb, provider, oid)
    b, pay = _reload(pdb, b, pay)
    assert pay.status == CustomerPaymentStatus.CAPTURED.value      # the money is never lost
    assert b.status == CustomerBookingStatus.PENDING.value         # but not confirmed
    assert b.supplier_status == G.RESERVATION_MISSING
    assert _confirmations(pdb) == 0                                # no notification
    assert _held_audits(pdb) == 1                                  # one audit record


def test_duplicate_and_replayed_webhooks_add_nothing_when_held(monkeypatch, pdb, provider):
    _live(monkeypatch)
    _, b, pay, oid = _flight(pdb, supplier="duffel", offer_id="off_1",
                             supplier_total=decimal.Decimal("10.00"))
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid))})
    body = webhook_body(oid, event_id="evt_dup")
    first = events.handle(pdb, provider.name, provider.verify_webhook(body, AUTH))
    dup = events.handle(pdb, provider.name, provider.verify_webhook(body, AUTH))
    replay = events.handle(pdb, provider.name, provider.verify_webhook(
        webhook_body(oid, event_id="evt_new"), AUTH))
    assert first[0] == events.PROCESSED and dup[0] == "duplicate"
    assert replay[0] == events.PROCESSED
    # Re-asking the guard directly (as a sweep or a second return would) is inert too.
    b, pay = _reload(pdb, b, pay)
    assert flight_verify.confirm_booking(pdb, pay, b) is False
    assert flight_verify.confirm_booking(pdb, pay, b) is False
    pdb.commit()
    assert _held_audits(pdb) == 1 and _confirmations(pdb) == 0


def test_a_valid_supplier_order_id_confirms_once(monkeypatch, pdb, provider):
    _live(monkeypatch)
    _, b, pay, oid = _flight(pdb, supplier="duffel", offer_id="off_1", order_id="ord_0000123",
                             supplier_total=decimal.Decimal("10.00"))
    _pay(monkeypatch, pdb, provider, oid)
    _pay(monkeypatch, pdb, provider, oid)
    b, pay = _reload(pdb, b, pay)
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert _confirmations(pdb) == 1 and _held_audits(pdb) == 0


@pytest.mark.parametrize("bad", ["", "  ", "x", "ab", "has space here", "a" * 81, "<script>"])
def test_an_invalid_supplier_order_id_does_not_count(monkeypatch, pdb, provider, bad):
    _live(monkeypatch)
    _, b, pay, oid = _flight(pdb, supplier="duffel", offer_id="off_1",
                             order_id=bad or None, supplier_total=decimal.Decimal("10.00"))
    _pay(monkeypatch, pdb, provider, oid)
    b, pay = _reload(pdb, b, pay)
    assert b.status == CustomerBookingStatus.PENDING.value and _confirmations(pdb) == 0


def test_live_money_on_a_demo_flight_is_held_not_confirmed(monkeypatch, pdb, provider):
    """Defence in depth: the checkout gate should have refused it, but if a live HDFC
    payment is captured for a demo flight anyway, it is not confirmed."""
    _settings(monkeypatch, payment_environment="live", flight_supplier="demo")
    _, b, pay, oid = _flight(pdb)
    _pay(monkeypatch, pdb, provider, oid)
    b, pay = _reload(pdb, b, pay)
    assert pay.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.PENDING.value
    assert b.supplier_status == G.RESERVATION_MISSING
    assert _confirmations(pdb) == 0 and _held_audits(pdb) == 1


def test_amount_mismatch_still_confirms_nothing_on_a_live_supplier_flight(monkeypatch, pdb, provider):
    _live(monkeypatch)
    _, b, pay, oid = _flight(pdb, supplier="duffel", offer_id="off_1", order_id="ord_0000123",
                             supplier_total=decimal.Decimal("10.00"))
    FakeHDFC(monkeypatch, {f"GET /orders/{oid}": FakeResponse(200, order_doc(oid, amount=1))})
    events.handle(pdb, provider.name, provider.verify_webhook(webhook_body(oid), AUTH))
    b, pay = _reload(pdb, b, pay)
    assert pay.status != CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.PENDING.value and _confirmations(pdb) == 0


# ===========================================================================
# 5. Resolving a held booking
# ===========================================================================
def _held(monkeypatch, pdb, provider):
    _live(monkeypatch)
    c, b, pay, oid = _flight(pdb, supplier="duffel", offer_id="off_1",
                             supplier_total=decimal.Decimal("10.00"))
    _pay(monkeypatch, pdb, provider, oid)
    return c, b, pay, oid


def test_held_bookings_are_listed(monkeypatch, pdb, provider):
    _, b, _, _ = _held(monkeypatch, pdb, provider)
    items = G.held_bookings(pdb)
    assert [i["booking_ref"] for i in items] == [b.booking_ref]
    assert items[0]["amount"] == decimal.Decimal("56.00")


def test_complete_reservation_confirms_once(monkeypatch, pdb, provider):
    _, b, pay, _ = _held(monkeypatch, pdb, provider)
    assert G.complete_reservation(pdb, b.booking_ref, supplier_order_id="ord_0000777",
                                  pnr="ABC123") == "confirmed"
    pdb.commit()
    again = G.complete_reservation(pdb, b.booking_ref, supplier_order_id="ord_0000778")
    pdb.commit()
    b, pay = _reload(pdb, b, pay)
    assert again == "already_confirmed"
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert b.supplier_order_id == "ord_0000777"            # the second call changed nothing
    assert b.pnr == "ABC123"
    assert _confirmations(pdb) == 1
    assert G.held_bookings(pdb) == []


@pytest.mark.parametrize("bad", ["", "ab", "no spaces allowed", "x" * 81])
def test_complete_reservation_rejects_a_bad_order_id(monkeypatch, pdb, provider, bad):
    _, b, _, _ = _held(monkeypatch, pdb, provider)
    assert G.complete_reservation(pdb, b.booking_ref, supplier_order_id=bad) == "invalid_order_id"
    assert _confirmations(pdb) == 0


def test_complete_reservation_unknown_booking(pdb):
    assert G.complete_reservation(pdb, "JPF999999", supplier_order_id="ord_0000777") == "not_found"


def test_complete_reservation_refuses_a_booking_it_is_not_holding(monkeypatch, pdb, provider):
    """Not a way to rewrite any flight booking: demo and unpaid ones are refused."""
    _, b, pay, oid = _flight(pdb)
    assert G.complete_reservation(pdb, b.booking_ref, supplier_order_id="ord_0000777") \
        == "no_captured_payment"
    _pay(monkeypatch, pdb, provider, oid)                  # demo flight, confirmed normally
    assert G.complete_reservation(pdb, b.booking_ref, supplier_order_id="ord_0000777") \
        == "already_confirmed"


def test_cancelling_a_held_booking_flags_the_refund_owed(monkeypatch, pdb, provider):
    _, b, pay, _ = _held(monkeypatch, pdb, provider)
    b, pay = _reload(pdb, b, pay)
    flights.cancel(pdb, b)
    pdb.commit()
    b, pay = _reload(pdb, b, pay)
    assert b.status == CustomerBookingStatus.CANCELLED.value
    assert pay.status == CustomerPaymentStatus.CAPTURED.value        # nothing refunded automatically
    assert _count(pdb, CustomerAuditLog, CustomerAuditLog.action.like("Cancelled with a captured payment%")) == 1
    assert G.held_bookings(pdb) == []                                # it left the held list


def test_cancelling_an_ordinary_booking_is_unchanged(pdb):
    _, b, _, _ = _flight(pdb)
    flights.cancel(pdb, b)
    pdb.commit()
    assert _count(pdb, CustomerAuditLog) == 0


# ===========================================================================
# 6. Readiness: live HDFC + demo supplier is a blocker; UAT is not
# ===========================================================================
def _levels(checks):
    return {c.name: c.level for c in checks}


def test_readiness_blocks_live_with_a_demo_supplier(monkeypatch):
    _settings(monkeypatch, payment_provider="hdfc", payment_environment="live", deployed=True,
              frontend_base_url="https://jackpotsworldtours.com", hdfc_sg_base_url=PROD_BASE,
              hdfc_sg_merchant_id="MID", hdfc_sg_api_key="k" * 20,
              hdfc_sg_webhook_username="user", hdfc_sg_webhook_password="p" * 20,
              hdfc_sg_response_key="r" * 20, hdfc_sg_client_id=None, hdfc_sg_return_url=None,
              flight_supplier="demo")
    checks = hdfc_readiness.evaluate()
    assert _levels(checks)["FLIGHT_SUPPLIER"] == hdfc_readiness.BLOCK
    detail = next(c.detail for c in checks if c.name == "FLIGHT_SUPPLIER")
    assert "Hotels and packages are unaffected" in detail
    _settings(monkeypatch, flight_supplier="duffel")
    assert _levels(hdfc_readiness.evaluate())["FLIGHT_SUPPLIER"] == hdfc_readiness.PASS


def test_readiness_does_not_block_uat_with_a_demo_supplier(monkeypatch):
    _settings(monkeypatch, payment_provider="hdfc", payment_environment="test",
              flight_supplier="demo")
    assert _levels(hdfc_readiness.evaluate())["FLIGHT_SUPPLIER"] == hdfc_readiness.PASS


def test_startup_log_names_the_blocker_without_secrets(monkeypatch, caplog):
    _settings(monkeypatch, payment_provider="hdfc", payment_environment="live", deployed=True,
              frontend_base_url="https://jackpotsworldtours.com", hdfc_sg_base_url=PROD_BASE,
              hdfc_sg_merchant_id="MID", hdfc_sg_api_key="secret-api-key-xyz",
              hdfc_sg_webhook_username="user", hdfc_sg_webhook_password="secret-webhook-pass-1",
              hdfc_sg_client_id=None, hdfc_sg_return_url=None, flight_supplier="demo")
    with caplog.at_level("INFO"):
        P.check_configuration_at_startup()
    assert "FLIGHT_SUPPLIER" in caplog.text
    assert "secret-api-key-xyz" not in caplog.text and "secret-webhook-pass-1" not in caplog.text


# ===========================================================================
# 7. Hotels and packages are not touched
# ===========================================================================
def test_hotel_and_package_modules_do_not_use_the_guard():
    import app.services.customer_hotel_booking_service as hotel
    import app.services.customer_package_booking_service as package
    import app.services.payment_verification_hotel_service as hv
    import app.services.payment_verification_service as pv

    for module in (hotel, package, hv, pv):
        assert "supplier_guard" not in vars(module)
        assert "supplier_guard" not in open(module.__file__, encoding="utf-8").read()


def test_a_live_supplier_deployment_does_not_stop_a_hotel_confirming(monkeypatch, hdb, booking, provider_hotel):
    """FLIGHT_SUPPLIER=duffel and live payments must not change a hotel booking."""
    from tests.test_hdfc_flow import OID, _confirmations as hotel_confirmations, _reload as hotel_reload

    _settings(monkeypatch, flight_supplier="duffel", payment_environment="live")
    FakeHDFC(monkeypatch, {f"GET /orders/{OID}": FakeResponse(200, order_doc(OID))})
    events.handle(hdb, provider_hotel.name, provider_hotel.verify_webhook(webhook_body(OID), AUTH))
    b, pay = hotel_reload(hdb, booking)
    assert pay.status == CustomerPaymentStatus.CAPTURED.value
    assert b.status == CustomerBookingStatus.CONFIRMED.value
    assert hotel_confirmations(hdb) == 1


# fixtures for the hotel test above (the hotel harness lives in test_hdfc_flow.py)
from tests.test_hdfc_flow import booking, hdb  # noqa: E402,F401
from tests.test_hdfc_flow import provider as provider_hotel  # noqa: E402,F401
