"""Unit tests for the Offers & Coupons + Suppliers & Pricing additions.

Covers the pieces with real logic: the markup/festival math (the owner's
₹5,000 → ₹5,500 → ₹4,950 example), airline- and usage-targeted coupon
validation, and carrier derivation. Builds only the three tables it needs on an
in-memory SQLite engine (the root conftest registers the SQLite type shims).
"""
import datetime as dt
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models_customer import Base, CustomerCoupon, FestivalDiscount, SupplierMarkup
from app.services import customer_markup_service as markup
from app.services import customer_pricing_service as pricing


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        CustomerCoupon.__table__,
        SupplierMarkup.__table__,
        FestivalDiscount.__table__,
    ])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _coupon(db, **kw):
    defaults = dict(
        code="FLY", title="Test", discount_type="percent", discount_value=Decimal("10"),
        min_amount=Decimal("0"), times_used=0, show_on_website=True, is_active=True,
    )
    defaults.update(kw)
    c = CustomerCoupon(**defaults)
    db.add(c)
    db.flush()
    return c


# --------------------------------------------------------------- markup math
def test_markup_example_matches_the_spec(db):
    """TBO base ₹5,000 → +10% markup → ₹5,500 → −10% festival → ₹4,950."""
    db.add(SupplierMarkup(supplier="TBO", service="flight", markup_percent=Decimal("10"), is_active=True))
    today = dt.date.today()
    db.add(FestivalDiscount(
        name="Diwali", discount_type="percent", discount_value=Decimal("10"),
        applicable_type=None, start_date=today - dt.timedelta(days=1),
        end_date=today + dt.timedelta(days=1), is_active=True, show_on_website=True,
    ))
    db.flush()

    out = markup.apply(db, service="flight", base=Decimal("5000"))
    assert out["base"] == Decimal("5000.00")
    assert out["selling"] == Decimal("5500.00")
    assert out["festival_amount"] == Decimal("550.00")
    assert out["festival_percent"] == 10
    assert out["final"] == Decimal("4950.00")


def test_markup_inert_when_unconfigured(db):
    out = markup.apply(db, service="flight", base=Decimal("5000"))
    assert out["selling"] == Decimal("5000.00")
    assert out["festival_amount"] == Decimal("0.00")
    assert out["final"] == Decimal("5000.00")


def test_festival_only_applies_to_its_service(db):
    today = dt.date.today()
    db.add(FestivalDiscount(
        name="Hotel Week", discount_type="flat", discount_value=Decimal("500"),
        applicable_type="hotel", start_date=today, end_date=today, is_active=True, show_on_website=True,
    ))
    db.flush()
    assert markup.apply(db, service="flight", base=Decimal("5000"))["festival_amount"] == Decimal("0.00")
    assert markup.apply(db, service="hotel", base=Decimal("5000"))["festival_amount"] == Decimal("500.00")


# --------------------------------------------------------------- carrier
def test_flight_carrier_derivation():
    assert pricing.flight_carrier("6E 815") == "6E"
    assert pricing.flight_carrier("AI302") == "AI"
    assert pricing.flight_carrier("6e815") == "6E"


# --------------------------------------------------------------- coupon targeting
def test_airline_coupon_matches_only_its_carrier(db):
    _coupon(db, code="INDIGO25", airline="6E", product_type="flight")
    discount, _ = pricing.validate_coupon(
        db, "INDIGO25", product_type="flight", is_international=False,
        amount=Decimal("5000"), airline="6E",
    )
    assert discount == Decimal("500.00")

    with pytest.raises(pricing.PricingError):
        pricing.validate_coupon(
            db, "INDIGO25", product_type="flight", is_international=False,
            amount=Decimal("5000"), airline="AI",
        )


def test_domestic_international_targeting(db):
    _coupon(db, code="INTL", international_only=True, product_type="flight")
    # International flight: applies.
    assert pricing.validate_coupon(
        db, "INTL", product_type="flight", is_international=True, amount=Decimal("5000"),
    )[0] == Decimal("500.00")
    # Domestic flight: refused.
    with pytest.raises(pricing.PricingError):
        pricing.validate_coupon(
            db, "INTL", product_type="flight", is_international=False, amount=Decimal("5000"),
        )


def test_usage_limit_blocks_when_exhausted(db):
    _coupon(db, code="ONCE", usage_limit=1, times_used=1)
    with pytest.raises(pricing.PricingError):
        pricing.validate_coupon(db, "ONCE", product_type="flight", is_international=False, amount=Decimal("5000"))


def test_record_redemption_increments_and_then_caps(db):
    c = _coupon(db, code="CAP", usage_limit=1, times_used=0)
    pricing.record_redemption(db, "CAP")
    assert c.times_used == 1
    with pytest.raises(pricing.PricingError):
        pricing.record_redemption(db, "CAP")


def test_available_coupons_hides_website_off_and_exhausted(db):
    _coupon(db, code="SHOWN", show_on_website=True)
    _coupon(db, code="HIDDEN", show_on_website=False)
    _coupon(db, code="SPENT", show_on_website=True, usage_limit=2, times_used=2)
    codes = {c.code for c in pricing.available_coupons(db, product_type="flight")}
    assert "SHOWN" in codes
    assert "HIDDEN" not in codes
    assert "SPENT" not in codes
