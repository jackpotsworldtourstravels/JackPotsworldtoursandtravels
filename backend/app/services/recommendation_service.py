"""recommendation_service.py — turn a customer's activity into suggestions.

WHAT IT IS. A small, transparent scorer, not a machine-learning model: with a
catalogue of this size (a few dozen destinations and packages) the honest thing
is a rule you can read, not a black box you cannot. It reads what a customer has
looked at, saved or booked, works out which DESTINATIONS they are interested in,
and offers the trips and stays for those places they have NOT already seen.

WHY DESTINATION-FIRST. Every product here belongs to a place — a package goes to
Goa, a hotel is in Goa — so "interested in Goa" is the signal that ties a hotel
view to a package suggestion. A person who read about Goa and saved a Goa hotel
should be shown Goa packages, and the reason on each card says exactly that.

IT NEVER INVENTS. Suggestions are real rows from the catalogue services, and a
customer with no activity gets an empty list, not a backfill of popular guesses —
the caller (and the frontend) treats an empty list as "not enough yet" and shows
nothing rather than something unearned.

PRIVACY. It reads only the calling customer's own `customer_activity` rows, which
CASCADE with the account; nothing here reaches across customers.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models_customer import CustomerActivity, CustomerPackage
from app.services import customer_destination_service as destinations
from app.services import customer_package_catalog_service as packages

# --- the scoring rule, all in one place ------------------------------------
#: What each kind of signal is worth before recency is applied. A booking says
#: more than a save, a save says more than a look — the ladder the brief sets.
BASE_WEIGHT = {"view": 20.0, "wishlist": 40.0, "booking": 60.0, "search": 20.0}
#: A hotel or package looked at lifts the DESTINATION it belongs to — the
#: cross-category signal that lets a hotel view suggest a package.
SIMILAR_CATEGORY_BONUS = 30.0
#: An extra push for anything done in the last few days, so a fresh interest
#: outranks a stale one of the same kind.
RECENT_BONUS = 20.0
RECENT_DAYS = 7
#: How far back a signal still counts, and the floor its weight decays to.
DECAY_DAYS = 90
DECAY_FLOOR = 0.3
#: Don't score on ancient history, and don't scan an unbounded table.
LOOKBACK_DAYS = 120
MAX_ROWS = 300


ACTIVITY_TYPES = frozenset({"view", "wishlist", "booking", "search"})
ENTITY_TYPES = frozenset({"destination", "hotel", "package"})


@dataclass
class Recommendation:
    type: str          # 'package' | 'hotel'
    id: str
    name: str
    reason: str
    image: str | None
    price: float | None
    destination: str | None
    score: float


def record_activity(
    db: Session,
    customer_id: int,
    activity_type: str,
    entity_type: str,
    entity_id: str,
    meta: dict | None = None,
) -> CustomerActivity:
    """Append one activity row. The caller has already validated the vocabulary
    (the API does, with Pydantic); this trusts it and writes."""
    row = CustomerActivity(
        customer_id=customer_id,
        activity_type=activity_type,
        entity_type=entity_type,
        entity_id=str(entity_id)[:128],
        meta=meta or None,
    )
    db.add(row)
    db.flush()
    return row


def _recency(age_days: float) -> float:
    return max(DECAY_FLOOR, 1.0 - age_days / DECAY_DAYS)


def get_recommendations(db: Session, customer_id: int, limit: int = 8) -> list[Recommendation]:
    """The customer's recommendations, best first. Empty when there is not
    enough activity to stand on — which the caller shows as nothing."""
    now = dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(days=LOOKBACK_DAYS)

    rows = list(
        db.execute(
            select(CustomerActivity)
            .where(
                CustomerActivity.customer_id == customer_id,
                CustomerActivity.created_at >= since,
            )
            .order_by(CustomerActivity.created_at.desc())
            .limit(MAX_ROWS)
        ).scalars()
    )
    if not rows:
        return []

    # Resolve the catalogue once: slug -> {name, image}, and package.destination
    # (a city NAME) -> slug, so a package view can be filed under a destination.
    dest_rows = destinations.list_destinations(db)
    by_slug = {d["id"]: d for d in dest_rows}
    name_to_slug = {str(d["name"]).strip().lower(): d["id"] for d in dest_rows}

    all_packages = [p for p in packages.list_packages(db) if p.is_active]
    pkg_by_id = {str(p.customer_package_id): p for p in all_packages}

    def dest_slug_for_activity(a: CustomerActivity) -> str | None:
        if a.entity_type == "destination":
            slug = a.entity_id.lower()
            return slug if slug in by_slug else None
        if a.entity_type == "package":
            p = pkg_by_id.get(str(a.entity_id))
            if p and p.destination:
                return name_to_slug.get(p.destination.strip().lower())
            return None
        if a.entity_type == "hotel":
            # A hotel's destination lives in meta when the frontend has it; the
            # slug is the reliable key, so use it when present and skip otherwise.
            meta = a.meta or {}
            slug = str(meta.get("destination_slug") or meta.get("destination") or "").strip().lower()
            return slug if slug in by_slug else None
        return None

    # --- score the destinations the customer has shown interest in -----------
    dest_score: dict[str, float] = {}
    # What they have already engaged with, so we do not recommend it back.
    seen_packages: set[str] = set()
    for a in rows:
        if a.entity_type == "package":
            seen_packages.add(str(a.entity_id))
        slug = dest_slug_for_activity(a)
        if not slug:
            continue
        age = (now - a.created_at).total_seconds() / 86400.0
        recency = _recency(age)
        s = BASE_WEIGHT.get(a.activity_type, 10.0) * recency
        if a.entity_type in ("package", "hotel"):
            s += SIMILAR_CATEGORY_BONUS * recency
        if age <= RECENT_DAYS:
            s += RECENT_BONUS
        dest_score[slug] = dest_score.get(slug, 0.0) + s

    if not dest_score:
        return []

    ranked = sorted(dest_score.items(), key=lambda kv: kv[1], reverse=True)

    # --- turn the top destinations into real, unseen suggestions -------------
    recs: list[Recommendation] = []
    used_ids: set[str] = set()
    for slug, score in ranked:
        dest = by_slug.get(slug)
        if not dest:
            continue
        reason = f"Because you explored {dest['name']}"
        for p in all_packages:
            if not p.destination or name_to_slug.get(p.destination.strip().lower()) != slug:
                continue
            pid = str(p.customer_package_id)
            if pid in seen_packages or pid in used_ids:
                continue
            used_ids.add(pid)
            recs.append(Recommendation(
                type="package",
                id=pid,
                name=p.name,
                reason=reason,
                image=p.image_key or dest.get("image"),
                price=float(p.price_from) if p.price_from is not None else None,
                destination=p.destination,
                # Carry the destination's own score so a package inherits how
                # interested the customer is in where it goes.
                score=round(score, 2),
            ))
            if len(recs) >= limit:
                break
        if len(recs) >= limit:
            break

    return recs[:limit]
