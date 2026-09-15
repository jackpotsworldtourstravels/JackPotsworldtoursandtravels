"""Pull the Hotelbeds static catalogue into our own tables.

WHAT THIS IS AND IS NOT. It copies CONTENT — what a property is, where it is,
what it looks like, what rooms it has. It never stores a price, a rate or an
availability flag, because those are live facts that expire, and a catalogue
row that carries a stale price is worse than one that carries none.

-----------------------------------------------------------------------------
THE MAPPING PROBLEM, AND WHY IT IS A SEPARATE STEP
-----------------------------------------------------------------------------
Our geography and the supplier's are two independent datasets. Our 'goa' is a
slug we chose; theirs is a code they chose. Nothing guarantees they correspond,
and assuming they do is how a Goa page fills with hotels in Ghana.

So mapping is explicit and happens first:

    propose_destination_mapping()   reads both lists and REPORTS candidates
    apply_destination_mapping()     writes the pairs it is given

The proposal step matches on name because that is the only signal available,
but it never acts on its own: exact, unambiguous matches are offered, anything
doubtful is reported unmatched, and a human confirms. Once written, the stored
code is the only thing the hotel sync consults. No name is ever compared again.

This is the same discipline as migration 0072's backfill: matching text is
acceptable ONCE, under supervision, to establish a key. It is never acceptable
at runtime.

-----------------------------------------------------------------------------
IDEMPOTENCY
-----------------------------------------------------------------------------
``customer_hotels.hotelbeds_code`` is UNIQUE. Every synced row is looked up by
it and updated in place, so running the sync twice changes nothing the second
time. Rows with ``source = 'seed'`` are never touched: the six hand-written
properties survive every sync, which is what lets this ship before the
catalogue is trusted.
"""
from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.integrations.hotelbeds.content import HotelbedsContent
from app.integrations.hotelbeds.schemas import HbDestination, HbHotel
from app.models_customer import CustomerDestination, CustomerHotel, CustomerLocation

logger = logging.getLogger(__name__)

#: Marks rows this sync owns. Anything else is left alone, always.
SOURCE = "hotelbeds"


@dataclass
class MappingProposal:
    """What ``propose_destination_mapping`` found. Advice, not an action."""

    exact: list[tuple[str, str, str]] = field(default_factory=list)      # (our slug, hb code, hb name)
    ambiguous: list[tuple[str, list[str]]] = field(default_factory=list)  # (our slug, candidate codes)
    unmatched: list[str] = field(default_factory=list)                    # our slugs with no candidate
    already: list[tuple[str, str]] = field(default_factory=list)          # (our slug, existing code)


@dataclass
class SyncReport:
    """What a hotel sync actually did."""

    destination_slug: str
    fetched: int = 0
    created: int = 0
    updated: int = 0
    located: int = 0        # linked to a specific location via zone code
    unlocated: int = 0      # destination known, zone not mapped
    skipped: int = 0

    def line(self) -> str:
        return (
            f"{self.destination_slug}: fetched {self.fetched}, "
            f"created {self.created}, updated {self.updated}, "
            f"located {self.located}, unlocated {self.unlocated}, skipped {self.skipped}"
        )


def _norm(text: str | None) -> str:
    """Casefolded, whitespace-collapsed — for MAPPING-TIME comparison only."""
    return " ".join(str(text or "").split()).casefold()


# ---------------------------------------------------------------- mapping --
def propose_destination_mapping(
    db: Session, content: HotelbedsContent, country_code: str | None = None,
) -> MappingProposal:
    """Compare our destinations with the supplier's and report candidates.

    Reads only. Nothing is written, so this is safe to run against production
    and cheap in quota: one Content API call for the whole country.
    """
    supplier = content.destinations(country_code)
    by_name: dict[str, list[HbDestination]] = {}
    for d in supplier:
        by_name.setdefault(_norm(d.name), []).append(d)

    ours = db.scalars(
        select(CustomerDestination).order_by(CustomerDestination.sort_order, CustomerDestination.name)
    ).all()

    out = MappingProposal()
    for dest in ours:
        if dest.hotelbeds_destination_code:
            out.already.append((dest.slug, dest.hotelbeds_destination_code))
            continue
        candidates = by_name.get(_norm(dest.name), [])
        if len(candidates) == 1:
            out.exact.append((dest.slug, candidates[0].code, candidates[0].name))
        elif len(candidates) > 1:
            out.ambiguous.append((dest.slug, [c.code for c in candidates]))
        else:
            out.unmatched.append(dest.slug)
    return out


def apply_destination_mapping(db: Session, pairs: dict[str, str]) -> int:
    """Write ``{our slug: supplier code}``. Explicit input, no inference.

    Returns the number of destinations updated.
    """
    written = 0
    for slug, code in pairs.items():
        dest = db.scalar(select(CustomerDestination).where(CustomerDestination.slug == slug))
        if dest is None:
            logger.warning("No destination with slug %r; skipping.", slug)
            continue
        dest.hotelbeds_destination_code = str(code).strip().upper()
        written += 1
    db.commit()
    return written


def sync_zone_codes(
    db: Session, content: HotelbedsContent, destination_slug: str,
    country_code: str | None = None,
) -> tuple[int, list[str]]:
    """Attach supplier zone codes to our locations inside one destination.

    Same rule as destinations: an exact, unambiguous name match is written; a
    location with no confident match keeps a null zone code and its hotels will
    simply land at destination level rather than in the wrong neighbourhood.

    Returns ``(written, unmatched location slugs)``.
    """
    dest = db.scalar(select(CustomerDestination).where(CustomerDestination.slug == destination_slug))
    if dest is None or not dest.hotelbeds_destination_code:
        raise ValueError(
            f"Destination {destination_slug!r} has no hotelbeds_destination_code. "
            "Run the mapping step first."
        )

    supplier = {
        d.code: d for d in content.destinations(country_code)
    }.get(dest.hotelbeds_destination_code)
    if supplier is None:
        raise ValueError(
            f"Supplier has no destination {dest.hotelbeds_destination_code!r} in this country."
        )

    zones_by_name: dict[str, list[int]] = {}
    for z in supplier.zones:
        zones_by_name.setdefault(_norm(z.name), []).append(z.zone_code)

    written, unmatched = 0, []
    for loc in db.scalars(
        select(CustomerLocation).where(CustomerLocation.destination_id == dest.customer_destination_id)
    ).all():
        codes = zones_by_name.get(_norm(loc.name), [])
        if len(codes) == 1:
            loc.hotelbeds_zone_code = codes[0]
            written += 1
        else:
            unmatched.append(loc.slug)
    db.commit()
    return written, unmatched


# ------------------------------------------------------------------ hotels --
def sync_hotels(
    db: Session,
    content: HotelbedsContent,
    destination_slug: str,
    max_pages: int | None = None,
    last_update_time: str | None = None,
    dry_run: bool = False,
) -> SyncReport:
    """Pull every hotel for one destination and upsert it.

    Args:
        destination_slug: OUR slug. Its stored supplier code is what gets sent.
        max_pages: Quota guard — each page is one request against a daily cap.
        last_update_time: ``YYYY-MM-DD`` for an incremental refresh.
        dry_run: Fetch and report, write nothing.
    """
    dest = db.scalar(select(CustomerDestination).where(CustomerDestination.slug == destination_slug))
    if dest is None:
        raise ValueError(f"No destination with slug {destination_slug!r}.")
    if not dest.hotelbeds_destination_code:
        raise ValueError(
            f"Destination {destination_slug!r} has no hotelbeds_destination_code. "
            "Run the mapping step first — this sync will not guess it."
        )

    # zone code -> our location id, built once. This is the ONLY thing that
    # decides a hotel's location; the hotel's own address text is never read.
    zone_to_location = {
        loc.hotelbeds_zone_code: loc.customer_location_id
        for loc in db.scalars(
            select(CustomerLocation).where(
                CustomerLocation.destination_id == dest.customer_destination_id,
                CustomerLocation.hotelbeds_zone_code.is_not(None),
            )
        ).all()
    }

    report = SyncReport(destination_slug=destination_slug)
    now = dt.datetime.now(dt.timezone.utc)

    for hotel in content.iter_hotels(
        destination_code=dest.hotelbeds_destination_code,
        max_pages=max_pages,
        last_update_time=last_update_time,
    ):
        report.fetched += 1
        if dry_run:
            continue
        try:
            created = _upsert(db, hotel, dest, zone_to_location, now, report)
            report.created += 1 if created else 0
            report.updated += 0 if created else 1
        except Exception:                       # noqa: BLE001 — one bad row must not end the sync
            logger.exception("Failed to store hotel %s; skipping.", hotel.code)
            db.rollback()
            report.skipped += 1

    if not dry_run:
        db.commit()
    return report


def _upsert(
    db: Session, hotel: HbHotel, dest: CustomerDestination,
    zone_to_location: dict[int | None, int], now: dt.datetime, report: SyncReport,
) -> bool:
    """Insert or update one property. Returns True when it was created."""
    row = db.scalar(select(CustomerHotel).where(CustomerHotel.hotelbeds_code == hotel.code))
    created = row is None
    if created:
        row = CustomerHotel(hotelbeds_code=hotel.code, source=SOURCE)
        db.add(row)
    elif row.source != SOURCE:
        # A curated row that happens to carry a supplier code. Leave it alone.
        report.skipped += 1
        return False

    location_id = zone_to_location.get(hotel.zone_code)
    if location_id is not None:
        report.located += 1
    else:
        report.unlocated += 1

    row.name = hotel.name[:150]
    row.description = hotel.description
    # Only overwrite the star rating when the supplier actually gave us one.
    # The column defaults to 3, and writing that default over a real value —
    # or presenting it as fact — would be inventing a rating.
    if hotel.star_rating is not None:
        row.star_rating = hotel.star_rating
    row.location = _display_location(hotel, dest)
    row.address = (hotel.address or None) and hotel.address[:255]
    row.postal_code = hotel.postal_code
    row.city = (hotel.city or None) and hotel.city[:120]
    row.country_code = hotel.country_code
    row.latitude = hotel.latitude
    row.longitude = hotel.longitude
    row.amenities = list(hotel.amenities)
    row.images = list(hotel.image_paths)
    row.destination_id = dest.customer_destination_id
    row.location_id = location_id
    row.last_synced_at = now
    row.is_active = True
    # price_per_night stays 0: a catalogue has no price. The listing must read
    # that as "no price to show", never as "free".
    return created


def _display_location(hotel: HbHotel, dest: CustomerDestination) -> str:
    """The human-readable line the results card prints.

    Built from the supplier's city plus our destination name, because that is
    what a customer recognises. Purely cosmetic — nothing resolves geography
    from this string.
    """
    parts = [p for p in (hotel.city, dest.name) if p]
    # 'Panjim, Goa' — but never 'Goa, Goa'.
    if len(parts) == 2 and _norm(parts[0]) == _norm(parts[1]):
        parts = parts[:1]
    return ", ".join(parts)[:200] or dest.name[:200]
