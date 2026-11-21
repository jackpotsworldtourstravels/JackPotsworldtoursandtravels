"""Bug 6 — hotel coupons and the misleading "flight bookings" message.

`customer_pricing_service.validate_coupon` is shared by the flight, hotel and
package pricing services. It used to answer a product-type mismatch with a
hardcoded "{code} does not apply to flight bookings." — which was simply wrong
for a hotel or package customer whose coupon was valid, just not for that
product. These tests pin:

  * a product-scoped coupon applies to a matching booking (discount computed),
  * a mismatch names the product the coupon IS for AND the one being booked,
    for hotel, package and flight callers (no more hardcoded "flight"),
  * the other eligibility gates (expiry, minimum spend, percent cap, and the
    discount never exceeding the fare) still hold.

The harness builds its own in-memory SQLite session holding only the coupons
table — validate_coupon reads nothing else.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models_customer import Base, CustomerCoupon
from app.services import customer_pricing_service as pricing


@pytest.fixture()
def coupon_db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[CustomerCoupon.__table__])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


_ID = {"n": 1}


def _add_coupon(db, **kw):
    _ID["n"] += 1
    defaults = dict(
        customer_coupon_id=_ID["n"],
        code="SAVE",
        title="Test coupon",
        discount_type="percent",
        discount_value=Decimal("10"),
        min_amount=Decimal("0"),
        is_active=True,
    )
    defaults.update(kw)
    c = CustomerCoupon(**defaults)
    db.add(c)
    db.flush()
    return c


def test_hotel_coupon_applies_to_hotel_booking(coupon_db):
    _add_coupon(coupon_db, code="HOTEL10", product_type="hotel",
                discount_type="percent", discount_value=Decimal("10"))
    discount, coupon = pricing.validate_coupon(
        coupon_db, "HOTEL10", product_type="hotel",
        is_international=False, amount=Decimal("10000"),
    )
    assert discount == Decimal("1000.00")
    assert coupon.code == "HOTEL10"


def test_flight_coupon_rejected_on_hotel_names_both_products(coupon_db):
    """The regression: a flight coupon on a hotel booking must NOT say the
    coupon does not apply to *flight* bookings."""
    _add_coupon(coupon_db, code="FLYONLY", product_type="flight")
    with pytest.raises(pricing.PricingError) as exc:
        pricing.validate_coupon(
            coupon_db, "FLYONLY", product_type="hotel",
            is_international=False, amount=Decimal("10000"),
        )
    msg = str(exc.value).lower()
    assert "hotel" in msg                 # the product being booked is named
    assert "applies to flight" in msg     # and the coupon's real product
    # The old hardcoded sentence must be gone.
    assert "does not apply to flight bookings." not in str(exc.value)


def test_hotel_coupon_rejected_on_flight_names_both_products(coupon_db):
    _add_coupon(coupon_db, code="HOTELONLY", product_type="hotel")
    with pytest.raises(pricing.PricingError) as exc:
        pricing.validate_coupon(
            coupon_db, "HOTELONLY", product_type="flight",
            is_international=False, amount=Decimal("10000"),
        )
    msg = str(exc.value).lower()
    assert "hotel" in msg and "flight" in msg


def test_package_coupon_rejected_on_hotel(coupon_db):
    _add_coupon(coupon_db, code="PKGONLY", product_type="package")
    with pytest.raises(pricing.PricingError) as exc:
        pricing.validate_coupon(
            coupon_db, "PKGONLY", product_type="hotel",
            is_international=False, amount=Decimal("10000"),
        )
    assert "tour package" in str(exc.value).lower()


def test_flight_coupon_applies_to_flight_booking(coupon_db):
    _add_coupon(coupon_db, code="FLY20", product_type="flight",
                discount_type="percent", discount_value=Decimal("20"))
    discount, _ = pricing.validate_coupon(
        coupon_db, "FLY20", product_type="flight",
        is_international=False, amount=Decimal("5000"),
    )
    assert discount == Decimal("1000.00")


def test_untyped_coupon_applies_to_any_product(coupon_db):
    _add_coupon(coupon_db, code="ANY5", product_type=None,
                discount_type="fixed", discount_value=Decimal("500"))
    for product in ("flight", "hotel", "package"):
        discount, _ = pricing.validate_coupon(
            coupon_db, "ANY5", product_type=product,
            is_international=False, amount=Decimal("5000"),
        )
        assert discount == Decimal("500.00")


def test_expired_coupon_rejected(coupon_db):
    _add_coupon(coupon_db, code="OLD", product_type="hotel",
                valid_to=dt.date.today() - dt.timedelta(days=1))
    with pytest.raises(pricing.PricingError) as exc:
        pricing.validate_coupon(
            coupon_db, "OLD", product_type="hotel",
            is_international=False, amount=Decimal("10000"),
        )
    assert "expired" in str(exc.value).lower()


def test_minimum_spend_enforced_on_hotel(coupon_db):
    _add_coupon(coupon_db, code="MIN", product_type="hotel",
                min_amount=Decimal("20000"))
    with pytest.raises(pricing.PricingError) as exc:
        pricing.validate_coupon(
            coupon_db, "MIN", product_type="hotel",
            is_international=False, amount=Decimal("10000"),
        )
    assert "at least" in str(exc.value).lower()


def test_percent_discount_capped_by_max_discount(coupon_db):
    _add_coupon(coupon_db, code="CAP", product_type="hotel",
                discount_type="percent", discount_value=Decimal("50"),
                max_discount=Decimal("2000"))
    discount, _ = pricing.validate_coupon(
        coupon_db, "CAP", product_type="hotel",
        is_international=False, amount=Decimal("10000"),
    )
    assert discount == Decimal("2000.00")   # 50% of 10000 is 5000, capped at 2000


def test_discount_never_exceeds_fare(coupon_db):
    _add_coupon(coupon_db, code="BIG", product_type="hotel",
                discount_type="fixed", discount_value=Decimal("9999"))
    discount, _ = pricing.validate_coupon(
        coupon_db, "BIG", product_type="hotel",
        is_international=False, amount=Decimal("3000"),
    )
    assert discount == Decimal("3000.00")


def test_unknown_coupon_rejected(coupon_db):
    with pytest.raises(pricing.PricingError) as exc:
        pricing.validate_coupon(
            coupon_db, "NOPE", product_type="hotel",
            is_international=False, amount=Decimal("10000"),
        )
    assert "not a valid coupon" in str(exc.value).lower()
