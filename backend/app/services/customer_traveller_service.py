"""The saved traveller list — what makes passport auto-fetch real.

A customer books for the same handful of people over and over: themselves, a
spouse, two children, a parent. Retyping a passport number every time is the
single most tedious thing about a booking form, so the traveller step offers
"add these travellers to my list" and, on the next booking, fills the form back
in when it recognises a passport.

WHAT AUTO-FETCH MAY AND MAY NOT DO. It looks up a passport number **within one
customer's own list** and returns what that customer previously saved. It never
reaches into another customer's travellers, never queries the merchant-side
``users`` table, and never derives a name, a nationality or a date of birth
from the passport number itself — a passport number does not encode any of
those, and an app that appeared to know them would be making them up. A lookup
that finds nothing returns nothing, and the traveller types their details in.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models_customer import Customer, CustomerTraveller

#: Fields a saved traveller can carry back into the form. Kept explicit so
#: adding a column to the table does not silently start populating the form.
AUTOFILL_FIELDS = (
    "title", "first_name", "last_name", "gender", "date_of_birth", "nationality",
    "passport_number", "passport_expiry", "issuing_country",
    "frequent_flyer_airline", "frequent_flyer_number",
)


def list_for_customer(db: Session, customer: Customer) -> list[CustomerTraveller]:
    return list(
        db.execute(
            select(CustomerTraveller)
            .where(CustomerTraveller.customer_id == customer.customer_id)
            .order_by(CustomerTraveller.first_name, CustomerTraveller.last_name)
        ).scalars()
    )


def find_by_passport(
    db: Session, customer: Customer, passport_number: str
) -> CustomerTraveller | None:
    """The auto-fetch lookup. Scoped to this customer, always."""
    cleaned = (passport_number or "").strip()
    if not cleaned:
        return None
    return db.execute(
        select(CustomerTraveller).where(
            CustomerTraveller.customer_id == customer.customer_id,
            func.lower(CustomerTraveller.passport_number) == cleaned.lower(),
        )
    ).scalar_one_or_none()


def get_owned(
    db: Session, customer: Customer, traveller_id: int
) -> CustomerTraveller | None:
    """Fetch one, but only if it belongs to this customer.

    Every route that takes a traveller id goes through here, so a guessed id
    from another account resolves to nothing rather than to someone else's
    passport.
    """
    traveller = db.get(CustomerTraveller, traveller_id)
    if traveller is None or traveller.customer_id != customer.customer_id:
        return None
    return traveller


def _apply(traveller: CustomerTraveller, data: dict) -> None:
    for field in (
        "traveller_type", "title", "first_name", "last_name", "gender",
        "date_of_birth", "nationality", "passport_number", "passport_expiry",
        "issuing_country", "frequent_flyer_airline", "frequent_flyer_number",
        "mobile", "email",
    ):
        if field in data:
            value = data[field]
            if isinstance(value, str):
                value = value.strip() or None
            setattr(traveller, field, value)


def upsert(db: Session, customer: Customer, data: dict) -> CustomerTraveller:
    """Save a traveller, merging onto the existing row if the passport matches.

    Upsert rather than insert because the traveller step offers the list
    checkbox on every booking: a customer who ticks it three trips running
    means "keep these people up to date", not "give me three copies of my
    daughter". With no passport there is nothing to match on, so it inserts.
    """
    existing = None
    passport = (data.get("passport_number") or "").strip()
    if passport:
        existing = find_by_passport(db, customer, passport)

    if existing is not None:
        _apply(existing, data)
        db.flush()
        return existing

    traveller = CustomerTraveller(customer_id=customer.customer_id,
                                  first_name="", last_name="")
    _apply(traveller, data)
    db.add(traveller)
    db.flush()
    return traveller


def save_many(db: Session, customer: Customer, passengers: list[dict]) -> int:
    """Persist a booking's party into the list. Returns how many were written.

    Called only when the customer ticked the box. A passenger with no surname
    is skipped rather than saved half-formed.
    """
    saved = 0
    for p in passengers:
        if not (p.get("first_name") or "").strip() or not (p.get("last_name") or "").strip():
            continue
        upsert(db, customer, p)
        saved += 1
    return saved


def delete(db: Session, customer: Customer, traveller_id: int) -> bool:
    traveller = get_owned(db, customer, traveller_id)
    if traveller is None:
        return False
    db.delete(traveller)
    db.flush()
    return True


def passport_months_remaining(expiry: dt.date | None, travel_date: dt.date | None) -> int | None:
    """Whole months between the travel date and the passport's expiry.

    Returns ``None`` when either date is missing — "we cannot tell", which the
    caller must not treat as "it is fine".
    """
    if expiry is None or travel_date is None:
        return None
    months = (expiry.year - travel_date.year) * 12 + (expiry.month - travel_date.month)
    if expiry.day < travel_date.day:
        months -= 1
    return months
