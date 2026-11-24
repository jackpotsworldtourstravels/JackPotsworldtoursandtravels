"""Supplier markup + festival discount — one place that turns a supplier base
price into the selling price the site shows and charges.

THE FORMULA, ONCE:

    base            what the supplier priced (today: what the pricing services
                    already compute — there is no live TBO feed yet)
    + markup %      the admin's per-service margin on that base
    = selling       the "original" price the site shows
    - festival      a time-boxed discount on the selling price
    = final         what the customer pays

Both inputs are admin-managed and OPTIONAL. No markup row for a service means 0%;
no active festival means no discount. So with an empty config this returns
``final == base`` and nothing about the displayed price changes — the feature is
inert until the owner sets values.

Money is ``Decimal`` end to end, rounded to paise half-up, the way the rest of
the customer pricing path rounds (see customer_pricing_service).
"""
from __future__ import annotations

import datetime as dt
import logging
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models_customer import FestivalDiscount, SupplierMarkup

logger = logging.getLogger(__name__)

TWO_DP = Decimal("0.01")
PRIMARY_SUPPLIER = "TBO"
SERVICES = ("flight", "hotel", "package", "other")


def _money(value) -> Decimal:
    return Decimal(str(value)).quantize(TWO_DP, rounding=ROUND_HALF_UP)


def active_markup_percent(db: Session, service: str, supplier: str = PRIMARY_SUPPLIER) -> Decimal:
    """The active markup percent for a service, or 0 if none is configured.

    Degrades to 0 when there is no session (a fare priced without a db) or the
    config table is absent (a narrow test schema, or a host where the migration
    has not run). Failing to 0 is the SAFE direction — it never overcharges.
    """
    if db is None:
        return Decimal("0")
    try:
        row = db.execute(
            select(SupplierMarkup).where(
                SupplierMarkup.supplier == supplier,
                SupplierMarkup.service == service,
                SupplierMarkup.is_active.is_(True),
            )
        ).scalar_one_or_none()
    except SQLAlchemyError:
        logger.warning("supplier_markups unavailable; pricing without markup", exc_info=True)
        return Decimal("0")
    return _money(row.markup_percent) if row and row.markup_percent is not None else Decimal("0")


def _festival_candidates(db: Session, service: str, on_date: dt.date) -> list[FestivalDiscount]:
    if db is None:
        return []
    try:
        rows = db.execute(
            select(FestivalDiscount).where(
                FestivalDiscount.is_active.is_(True),
                FestivalDiscount.start_date <= on_date,
                FestivalDiscount.end_date >= on_date,
                (FestivalDiscount.applicable_type.is_(None))
                | (FestivalDiscount.applicable_type == service),
            )
        ).scalars().all()
    except SQLAlchemyError:
        logger.warning("festival_discounts unavailable; pricing without discount", exc_info=True)
        return []
    return rows


def _festival_amount(fest: FestivalDiscount, selling: Decimal) -> Decimal:
    """What one festival discount is worth on a selling price."""
    value = _money(fest.discount_value)
    if fest.discount_type == "percent":
        amount = _money(selling * value / Decimal("100"))
    else:
        amount = value
    # A discount never exceeds the price it is taken off.
    return min(amount, selling)


def apply(db: Session, *, service: str, base, on_date: dt.date | None = None) -> dict:
    """Turn a base price into the full selling/discount/final breakdown.

    When the customer gets more than one applicable festival discount, the one
    worth the most on this price wins (ties broken by the later start date), so
    the customer always sees the best live offer.
    """
    on_date = on_date or dt.date.today()
    base_d = _money(base)
    markup_pct = active_markup_percent(db, service)
    selling = _money(base_d * (Decimal("100") + markup_pct) / Decimal("100"))

    best = None
    best_amount = Decimal("0")
    for fest in _festival_candidates(db, service, on_date):
        amount = _festival_amount(fest, selling)
        if amount > best_amount or (
            amount == best_amount and best is not None and fest.start_date >= best.start_date
        ):
            best, best_amount = fest, amount

    festival_amount = best_amount if best else Decimal("0")
    final = _money(selling - festival_amount)
    festival_percent = (
        int((festival_amount / selling * Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP))
        if selling > 0 and festival_amount > 0 else 0
    )

    return {
        "base": base_d,
        "markup_percent": markup_pct,
        "selling": selling,
        "festival_name": best.name if best else None,
        "festival_amount": _money(festival_amount),
        "festival_percent": festival_percent,
        "final": final,
    }


def config_snapshot(db: Session, *, on_date: dt.date | None = None) -> dict:
    """The live markup + active-festival config, for a public endpoint the site
    uses to price listing cards the same way the server prices a quote (so a
    results card and its checkout never disagree)."""
    on_date = on_date or dt.date.today()
    markups = {
        s: str(active_markup_percent(db, s)) for s in SERVICES
    }
    fests = {}
    for s in SERVICES:
        cands = _festival_candidates(db, s, on_date)
        best = None
        for f in cands:
            if best is None or f.discount_value > best.discount_value:
                best = f
        if best:
            fests[s] = {
                "name": best.name,
                "discount_type": best.discount_type,
                "discount_value": str(_money(best.discount_value)),
                "show_on_website": bool(best.show_on_website),
            }
    return {"markups": markups, "festivals": fests}
