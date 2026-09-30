"""Moderating B2C reviews for the admin desk — Phase 6 of the B2C Admin Portal
build-out.

REUSES ``customer_reviews``, the table customers already write to from their
account page. Migration 0090 added the moderation columns (``status``,
``admin_reply``, ``replied_at``, ``moderated_at``); the customer's own rating
and words are never editable from here, only whether they are shown and what
the desk says back.

MODERATION IS WHAT MAKES A REVIEW PUBLIC. The public ``GET /api/customer/
reviews`` serves only ``approved`` rows (see ``customer_account_service``), new
reviews start ``pending``, and a customer editing theirs sends it back to
``pending``. So "approve" and "reject" here decide what other visitors see, not
just a label.

PRODUCT IS DERIVED, NOT STORED. ``customer_reviews.item_type`` is
``flight|hotel|cruise|package``; a gaming package is a ``package`` whose
``customer_packages.category`` is ``gaming``, so the desk's Gaming filter is
that join rather than a fifth stored value. Item names come from the hotel and
package tables; a flight or cruise has no catalogue table (flights are
supplier-driven), so it is shown as "Flight #n" instead of inventing a name.

ANALYTICS COUNT APPROVED REVIEWS ONLY — the ones the public can see. A score
that included spam awaiting rejection, or reviews nobody has read, would
disagree with the page a customer is looking at.
"""
from __future__ import annotations

import datetime as dt
import math
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerHotel, CustomerPackage, CustomerReview
from app.services.catalogue_common import blank_to_none

PRODUCTS = ("flight", "hotel", "package", "gaming", "cruise")
STATUSES = ("pending", "approved", "rejected")

_TWO = Decimal("0.01")


def _dec(value) -> Decimal:
    return Decimal(str(value)).quantize(_TWO)


def _is_gaming():
    return CustomerReview.item_id.in_(
        select(CustomerPackage.customer_package_id).where(CustomerPackage.category == "gaming")
    )


def _product_condition(product: str):
    if product in ("flight", "hotel", "cruise"):
        return CustomerReview.item_type == product
    if product == "gaming":
        return and_(CustomerReview.item_type == "package", _is_gaming())
    return and_(CustomerReview.item_type == "package", ~_is_gaming())


def _filters(product: str | None, rating: int | None, search: str | None) -> list:
    conds = []
    if product:
        conds.append(_product_condition(product))
    if rating:
        conds.append(CustomerReview.rating == rating)
    if search:
        like = f"%{search.strip()}%"
        conds.append(or_(
            Customer.full_name.ilike(like), Customer.email.ilike(like),
            CustomerReview.comment.ilike(like),
        ))
    return conds


def _names(db: Session, keys: set[tuple[str, int]]) -> dict[tuple[str, int], tuple[str, str]]:
    """(item_type, item_id) -> (display name, product). Batched per table."""
    out: dict[tuple[str, int], tuple[str, str]] = {}
    hotel_ids = {i for t, i in keys if t == "hotel"}
    package_ids = {i for t, i in keys if t == "package"}
    if hotel_ids:
        for hid, name in db.execute(
            select(CustomerHotel.customer_hotel_id, CustomerHotel.name)
            .where(CustomerHotel.customer_hotel_id.in_(hotel_ids))
        ):
            out[("hotel", hid)] = (name, "hotel")
    if package_ids:
        for pid, name, category in db.execute(
            select(CustomerPackage.customer_package_id, CustomerPackage.name, CustomerPackage.category)
            .where(CustomerPackage.customer_package_id.in_(package_ids))
        ):
            out[("package", pid)] = (name, "gaming" if category == "gaming" else "package")
    for t, i in keys:
        if (t, i) not in out:
            label = {"flight": "Flight", "cruise": "Cruise", "hotel": "Hotel (removed)", "package": "Package (removed)"}[t]
            out[(t, i)] = (f"{label} #{i}", t)
    return out


def _row(review: CustomerReview, customer: Customer, names: dict) -> dict:
    name, product = names[(review.item_type, review.item_id)]
    return {
        "review_id": review.customer_review_id,
        "customer": {"id": customer.customer_id, "name": customer.full_name, "email": customer.email},
        "product": product, "item_id": review.item_id, "item_name": name,
        "rating": review.rating, "comment": review.comment, "status": review.status,
        "admin_reply": review.admin_reply, "replied_at": review.replied_at,
        "created_at": review.created_at, "updated_at": review.updated_at,
    }


def list_reviews(
    db: Session, *, page: int, page_size: int, status_: str | None = None,
    product: str | None = None, rating: int | None = None, search: str | None = None,
) -> dict:
    conds = _filters(product, rating, search)
    base = select(CustomerReview, Customer).join(Customer, Customer.customer_id == CustomerReview.customer_id)

    counts = {s: 0 for s in STATUSES}
    for st, n in db.execute(
        select(CustomerReview.status, func.count())
        .join(Customer, Customer.customer_id == CustomerReview.customer_id)
        .where(*conds).group_by(CustomerReview.status)
    ):
        counts[st] = n

    listed = base.where(*conds)
    if status_:
        listed = listed.where(CustomerReview.status == status_)
    total = counts[status_] if status_ else sum(counts.values())
    rows = db.execute(
        listed.order_by(CustomerReview.created_at.desc(), CustomerReview.customer_review_id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    names = _names(db, {(r.item_type, r.item_id) for r, _ in rows})
    return {
        "items": [_row(r, c, names) for r, c in rows], "total": total, "page": page,
        "page_size": page_size, "total_pages": max(1, math.ceil(total / page_size)),
        "counts": counts,
    }


def get_review(db: Session, review_id: int) -> dict | None:
    hit = db.execute(
        select(CustomerReview, Customer)
        .join(Customer, Customer.customer_id == CustomerReview.customer_id)
        .where(CustomerReview.customer_review_id == review_id)
    ).first()
    if hit is None:
        return None
    review, customer = hit
    return _row(review, customer, _names(db, {(review.item_type, review.item_id)}))


def moderate(db: Session, review_id: int, changes: dict) -> tuple[dict, list[str]] | None:
    review = db.get(CustomerReview, review_id)
    if review is None:
        return None
    now = dt.datetime.now(dt.timezone.utc)
    changed: list[str] = []

    new_status = changes.get("status")
    if new_status is not None:
        if new_status not in ("approved", "rejected"):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Status must be approved or rejected.")
        if review.status != new_status:
            review.status = new_status
            review.moderated_at = now
            changed.append("status")

    if "admin_reply" in changes:
        reply = blank_to_none(changes["admin_reply"])
        if reply != review.admin_reply:
            review.admin_reply = reply
            review.replied_at = now if reply else None
            changed.append("admin_reply")

    db.flush()
    return get_review(db, review_id), changed


def analytics(db: Session) -> dict:
    counts = {s: 0 for s in STATUSES}
    for st, n in db.execute(select(CustomerReview.status, func.count()).group_by(CustomerReview.status)):
        counts[st] = n

    approved = CustomerReview.status == "approved"
    avg = db.scalar(select(func.avg(CustomerReview.rating)).where(approved))
    dist = dict(db.execute(
        select(CustomerReview.rating, func.count()).where(approved).group_by(CustomerReview.rating)
    ).all())

    grouped = db.execute(
        select(CustomerReview.item_type, CustomerReview.item_id, func.count(), func.avg(CustomerReview.rating))
        .where(approved).group_by(CustomerReview.item_type, CustomerReview.item_id)
    ).all()
    names = _names(db, {(t, i) for t, i, _, _ in grouped})

    items, product_totals = [], {}
    for t, i, n, a in grouped:
        name, product = names[(t, i)]
        items.append({"product": product, "item_id": i, "item_name": name, "count": n, "average": _dec(a)})
        c, s = product_totals.get(product, (0, Decimal(0)))
        product_totals[product] = (c + n, s + Decimal(str(a)) * n)   # weighted by review count
    by_product = [
        {"product": p, "count": c, "average": _dec(s / c)}
        for p, (c, s) in sorted(product_totals.items())
    ]

    ranked = sorted(items, key=lambda x: (-x["average"], -x["count"], x["item_name"]))
    top = ranked[:5]
    lowest = [x for x in sorted(items, key=lambda x: (x["average"], -x["count"], x["item_name"])) if x not in top][:5]

    since = (dt.date.today().replace(day=1) - dt.timedelta(days=150)).replace(day=1)
    month = func.to_char(func.date_trunc("month", CustomerReview.created_at), "YYYY-MM")
    monthly = [
        {"month": m, "count": n, "average": _dec(a)}
        for m, n, a in db.execute(
            select(month, func.count(), func.avg(CustomerReview.rating))
            .where(approved, CustomerReview.created_at >= since).group_by(month).order_by(month)
        )
    ]

    return {
        "basis": "Approved reviews only — the ones customers can see.",
        "approved": counts["approved"], "pending": counts["pending"], "rejected": counts["rejected"],
        "average": _dec(avg) if avg is not None else None,
        "distribution": [{"rating": r, "count": dist.get(r, 0)} for r in (5, 4, 3, 2, 1)],
        "by_product": by_product, "top_items": top, "lowest_items": lowest, "monthly": monthly,
    }


def item_names(db: Session, keys: set[tuple[str, int]]) -> dict[tuple[str, int], tuple[str, str]]:
    """Public wrapper on ``_names`` for other modules (Phase 8's report export
    resolves review items the same way instead of a second implementation).
    ``(item_type, item_id)`` -> ``(display name, product)``."""
    return _names(db, keys)
