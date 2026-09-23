"""Add tour packages to the catalogue from a table you fill in — and refuse to invent the parts you leave blank.

WHY THIS EXISTS. The Tour Packages journey needs rows to show: a pilgrimage
shelf with nothing on it is an empty page however good the page is. The nine
trips below were named in the brief - three domestic, three international,
three pilgrimage - and everything about them that can be stated truthfully
from what this repository already knows is filled in: the name, the
destination, the shelf it belongs on, and the artwork key where a photograph
of that destination shipped with the build.

WHAT IS DELIBERATELY BLANK, AND WHY THE SCRIPT WILL NOT GUESS IT.

    price       What a traveller will be asked to pay and the company will be
                asked to honour.
    days        How long the trip is, which is the other half of the price.
    inclusions  What is promised: hotels, meals, transfers, entries.

Those are commercial decisions about a real product. A plausible number here
becomes a price on a card, a price in a quote, and then a figure in a payment
screen; "Char Dham Yatra, 11 days, Rs 42,000" typed by a program that has
never seen the itinerary is the exact failure this codebase keeps refusing.
So a row without them is REPORTED, NOT INSERTED.

HOW TO USE IT

  1. Fill in `price`, `days` and (optionally) `nights`, `blurb`,
     `description`, `inclusions` for the rows you want live.
  2. Give each one departure dates - a package with no departure cannot be
     booked, because the booking flow starts by choosing one:

         departures=[("2026-11-08", 38000), ("2026-11-22", 38000)]

     The date is the day it leaves; the number is the PER-PERSON price for
     that date, which may differ from the shelf price.
  3. Run it:

         python scripts/seed_packages.py            # says what it would do
         python scripts/seed_packages.py --apply    # writes

A row is matched by (name, destination): running it twice updates rather than
duplicates, and running it after an edit in the admin will overwrite the
columns listed here and leave every other column alone.
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from sqlalchemy import select  # noqa: E402

from app.database.session import SessionLocal  # noqa: E402
from app.models_customer import (  # noqa: E402
    CustomerDestination,
    CustomerPackage,
    CustomerPackageDeparture,
)

#: The nine trips the brief named. `price`, `days` and `departures` are yours
#: to fill; everything else here is either a fact about the row (its name, its
#: shelf) or a pointer at something this repository already holds (the
#: destination, whose photograph and country come from customer_destinations).
#:
#: KEEP `trip_type` HONEST. 'pilgrimage' is not a synonym for "in India" - it
#: is what the trip is for, and it is the one thing no flag in this database
#: could have worked out.
PACKAGES = [
    # --- domestic ---------------------------------------------------------
    dict(name="Goa Holiday Package", destination="Goa", trip_type="domestic",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
    dict(name="Kerala Backwater Tour", destination="Kerala", trip_type="domestic",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
    dict(name="Rajasthan Heritage Tour", destination="Rajasthan", trip_type="domestic",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
    # --- international ----------------------------------------------------
    dict(name="Dubai City Escape", destination="Dubai", trip_type="international",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
    dict(name="Thailand Beach Holiday", destination="Thailand", trip_type="international",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
    dict(name="Europe Explorer", destination="Europe", trip_type="international",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
    # --- pilgrimage -------------------------------------------------------
    dict(name="Char Dham Yatra", destination="Uttarakhand", trip_type="pilgrimage",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
    dict(name="Tirupati Package", destination="Tirupati", trip_type="pilgrimage",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
    dict(name="Varanasi Spiritual Tour", destination="Varanasi", trip_type="pilgrimage",
         days=None, nights=None, price=None, blurb="", description="",
         inclusions=[], exclusions=[], highlights=[], hotel_category=None, departures=[]),
]

TRIP_TYPES = ("domestic", "pilgrimage", "international")


def artwork(db, destination: str) -> str | None:
    """The destination's image key, but only if that destination really exists.

    A key is a promise that a file shipped. This looks the destination up by
    slug in ``customer_destinations``; an unknown one gets no key and the card
    falls back to its tint rather than to a broken image.
    """
    slug = destination.strip().lower().replace(" ", "-")
    row = db.execute(
        select(CustomerDestination)
        .where(CustomerDestination.slug == slug, CustomerDestination.is_active.is_(True))
    ).scalar_one_or_none()
    return row.image_key if row else None


def incomplete(row: dict) -> list[str]:
    """What is missing before this row can be sold. Empty means it can go in."""
    missing = []
    if not row.get("price"):
        missing.append("price")
    if not row.get("days"):
        missing.append("days")
    if not row.get("departures"):
        missing.append("departures")
    if row.get("trip_type") not in TRIP_TYPES:
        missing.append("trip_type")
    return missing


def upsert(db, row: dict) -> tuple[CustomerPackage, bool]:
    existing = db.execute(
        select(CustomerPackage).where(
            CustomerPackage.name == row["name"],
            CustomerPackage.destination == row["destination"],
        )
    ).scalar_one_or_none()

    pkg = existing or CustomerPackage(name=row["name"], category="holiday")
    pkg.destination = row["destination"]
    pkg.trip_type = row["trip_type"]
    pkg.days = int(row["days"])
    pkg.nights = int(row["nights"]) if row.get("nights") is not None else max(int(row["days"]) - 1, 0)
    pkg.price_from = Decimal(str(row["price"]))
    pkg.is_international = row["trip_type"] == "international"
    pkg.blurb = row.get("blurb") or row["name"]
    pkg.description = row.get("description") or None
    pkg.inclusions = list(row.get("inclusions") or [])
    pkg.exclusions = list(row.get("exclusions") or []) or None
    pkg.highlights = list(row.get("highlights") or []) or None
    pkg.hotel_category = row.get("hotel_category")
    pkg.image_key = pkg.image_key or artwork(db, row["destination"])
    pkg.is_active = True
    if existing is None:
        db.add(pkg)
    db.flush()

    # Departures are replaced, not appended: running this twice with the same
    # table should leave the same dates on sale, not two of each.
    for dep in list(pkg.departures):
        if dep.departure_date.isoformat() not in {d[0] for d in row["departures"]}:
            dep.is_active = False
    have = {d.departure_date.isoformat(): d for d in pkg.departures}
    for iso, price in row["departures"]:
        date = dt.date.fromisoformat(iso)
        dep = have.get(iso)
        if dep is None:
            dep = CustomerPackageDeparture(package_id=pkg.customer_package_id, departure_date=date)
            db.add(dep)
        dep.price_per_person = Decimal(str(price))
        dep.is_active = True
    return pkg, existing is None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write to the database (default: dry run)")
    args = ap.parse_args()

    db = SessionLocal()
    ready = [r for r in PACKAGES if not incomplete(r)]
    blocked = [(r, incomplete(r)) for r in PACKAGES if incomplete(r)]

    for row, missing in blocked:
        print(f"  SKIPPED  {row['name']:<26} needs: {', '.join(missing)}")
    for row in ready:
        print(f"  READY    {row['name']:<26} {row['trip_type']}, {row['days']} days, "
              f"from {row['price']}, {len(row['departures'])} departures")

    if not ready:
        print("\nNothing to write. Fill in price, days and departures for the rows above.")
        print("Nothing here will guess them: they are what a traveller pays and what they get.")
        return 0

    if not args.apply:
        print(f"\nDry run. {len(ready)} package(s) would be written. Re-run with --apply.")
        return 0

    created = 0
    for row in ready:
        _pkg, is_new = upsert(db, row)
        created += 1 if is_new else 0
    db.commit()
    print(f"\nWrote {len(ready)} package(s): {created} created, {len(ready) - created} updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
