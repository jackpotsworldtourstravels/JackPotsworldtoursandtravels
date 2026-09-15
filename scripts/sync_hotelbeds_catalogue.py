# -*- coding: utf-8 -*-
"""Populate the hotel catalogue from Hotelbeds.

    python scripts/sync_hotelbeds_catalogue.py verify                 # cheapest: prove the key works
    python scripts/sync_hotelbeds_catalogue.py map                    # propose destination codes
    python scripts/sync_hotelbeds_catalogue.py map --apply-exact      # write the unambiguous ones
    python scripts/sync_hotelbeds_catalogue.py zones goa              # attach zone codes to Goa
    python scripts/sync_hotelbeds_catalogue.py sync goa --dry-run     # fetch, report, write nothing
    python scripts/sync_hotelbeds_catalogue.py sync goa               # populate

MIND THE QUOTA. A fresh sandbox key allows FIFTY REQUESTS PER DAY and answers
403 after that — no grace, and it does not reset early. Every subcommand here
prints how many calls it intends to make before it makes them, and ``verify``
is deliberately the cheapest thing that can prove an end-to-end connection: it
spends three calls and answers the questions the architecture audit could not.

RUN ORDER. verify -> map -> zones -> sync. Each step depends on the stored
output of the one before it, and none of them guesses: a destination with no
mapped code is skipped with an explanation rather than matched on the fly.

Nothing here writes to Hotelbeds. Every call is a read.
"""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app.database.session import SessionLocal                      # noqa: E402
from app.integrations.hotelbeds import HotelbedsContent            # noqa: E402
from app.integrations.hotelbeds.exceptions import (                # noqa: E402
    HotelbedsError, HotelbedsNotConfigured, HotelbedsQuotaExceeded,
)
from app.services import hotelbeds_sync_service as sync            # noqa: E402


def log(msg: str = "") -> None:
    print(msg, flush=True)


# ------------------------------------------------------------------ verify --
def cmd_verify(args, content: HotelbedsContent) -> int:
    """Three calls that answer the questions the audit had to leave open.

    Deliberately minimal. This is what to run first with a brand-new key.
    """
    slug = args.destination
    log(f"Budget: 3 requests. Verifying {slug!r} in {args.country}.\n")

    log("[1/3] GET /locations/destinations")
    destinations = content.destinations(args.country)
    log(f"      {len(destinations)} destinations in {args.country}")

    match = next((d for d in destinations if d.name.strip().casefold() == slug.casefold()), None)
    if match is None:
        log(f"\n  {slug!r} was NOT found by name among them.")
        log("  Closest names, for a manual decision:")
        for d in sorted(destinations, key=lambda d: d.name)[:15]:
            log(f"    {d.code:<6} {d.name}")
        log("\n  Nothing was written. Pick the right code and pass it to `map --set`.")
        return 1

    log(f"\n  FOUND: code={match.code}  name={match.name}  zones={len(match.zones)}")
    for z in match.zones[:20]:
        log(f"    zone {z.zone_code:<7} {z.name}")
    if len(match.zones) > 20:
        log(f"    … and {len(match.zones) - 20} more")

    log(f"\n[2/3] GET /hotels?destinationCode={match.code}  (count only)")
    total = content.count_hotels(destination_code=match.code)
    log(f"      {total} hotels available for {match.name}")

    log(f"\n[3/3] GET /hotels?destinationCode={match.code}&fields=all  (first page, 3 rows)")
    sample = []
    for h in content.iter_hotels(destination_code=match.code, page_size=3, max_pages=1):
        sample.append(h)
        if len(sample) >= 3:
            break
    for h in sample:
        stars = f"{h.star_rating}*" if h.star_rating else "—"
        log(f"      [{h.code}] {h.name}")
        log(f"          {h.city or '—'} | zone={h.zone_code} | {stars} | "
            f"{len(h.image_paths)} images | {len(h.amenities)} amenities | {len(h.rooms)} room types")

    log(f"\nVERIFIED. {match.name} = {match.code}, {total} hotels, content present.")
    log("Nothing was written. Next: `map --apply-exact`, then `zones`, then `sync`.")
    return 0


# --------------------------------------------------------------------- map --
def cmd_map(args, content: HotelbedsContent) -> int:
    db = SessionLocal()
    try:
        if args.set:
            pairs = {}
            for item in args.set:
                if "=" not in item:
                    log(f"  --set expects slug=CODE, got {item!r}")
                    return 2
                slug, code = item.split("=", 1)
                pairs[slug.strip()] = code.strip()
            written = sync.apply_destination_mapping(db, pairs)
            log(f"Wrote {written} destination code(s).")
            return 0

        log("Budget: 1 request.\n")
        proposal = sync.propose_destination_mapping(db, content, args.country)

        if proposal.already:
            log(f"Already mapped ({len(proposal.already)}):")
            for slug, code in proposal.already:
                log(f"   {slug:<14} -> {code}")
        if proposal.exact:
            log(f"\nExact, unambiguous matches ({len(proposal.exact)}):")
            for slug, code, name in proposal.exact:
                log(f"   {slug:<14} -> {code:<6} {name}")
        if proposal.ambiguous:
            log(f"\nAMBIGUOUS — choose one and pass it with --set ({len(proposal.ambiguous)}):")
            for slug, codes in proposal.ambiguous:
                log(f"   {slug:<14} -> {', '.join(codes)}")
        if proposal.unmatched:
            log(f"\nNo candidate ({len(proposal.unmatched)}) — these need --set or have no supplier cover:")
            log("   " + ", ".join(proposal.unmatched))

        if args.apply_exact and proposal.exact:
            written = sync.apply_destination_mapping(
                db, {slug: code for slug, code, _ in proposal.exact}
            )
            log(f"\nApplied {written} exact match(es).")
        elif proposal.exact:
            log("\nNothing written. Re-run with --apply-exact to store the exact matches.")
        return 0
    finally:
        db.close()


# ------------------------------------------------------------------- zones --
def cmd_zones(args, content: HotelbedsContent) -> int:
    db = SessionLocal()
    try:
        log("Budget: 1 request.\n")
        written, unmatched = sync.sync_zone_codes(db, content, args.destination, args.country)
        log(f"Mapped {written} location(s) to supplier zones.")
        if unmatched:
            log(f"Unmatched ({len(unmatched)}) — hotels there will sit at destination level:")
            log("   " + ", ".join(unmatched))
        return 0
    finally:
        db.close()


# -------------------------------------------------------------------- sync --
def cmd_sync(args, content: HotelbedsContent) -> int:
    db = SessionLocal()
    try:
        if args.max_pages:
            log(f"Budget: up to {args.max_pages} request(s).")
        else:
            log("Budget: one request per page until exhausted — use --max-pages on a sandbox key.")
        log("")
        report = sync.sync_hotels(
            db, content, args.destination,
            max_pages=args.max_pages,
            last_update_time=args.since,
            dry_run=args.dry_run,
        )
        log(("DRY RUN — " if args.dry_run else "") + report.line())
        if report.unlocated:
            log(f"  {report.unlocated} hotel(s) had no mapped zone; they are filed under the "
                f"destination only. Run `zones` to improve this.")
        return 0
    finally:
        db.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--country", default=None, help="ISO country (default: settings)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("verify", help="prove the key works and answer the Goa questions")
    p.add_argument("destination", nargs="?", default="Goa",
                   help="destination NAME as the supplier spells it (default: Goa)")
    p.set_defaults(fn=cmd_verify)

    p = sub.add_parser("map", help="propose or write destination code mappings")
    p.add_argument("--apply-exact", action="store_true", help="store unambiguous matches")
    p.add_argument("--set", action="append", metavar="slug=CODE", help="write one pair explicitly")
    p.set_defaults(fn=cmd_map)

    p = sub.add_parser("zones", help="attach supplier zone codes to our locations")
    p.add_argument("destination", help="OUR destination slug, e.g. goa")
    p.set_defaults(fn=cmd_zones)

    p = sub.add_parser("sync", help="populate hotels for one destination")
    p.add_argument("destination", help="OUR destination slug, e.g. goa")
    p.add_argument("--max-pages", type=int, default=None, help="quota guard")
    p.add_argument("--since", default=None, metavar="YYYY-MM-DD", help="incremental refresh")
    p.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    p.set_defaults(fn=cmd_sync)

    args = ap.parse_args()
    content = HotelbedsContent()

    try:
        return args.fn(args, content)
    except HotelbedsNotConfigured as exc:
        log(f"\nNOT CONFIGURED\n  {exc}")
        return 3
    except HotelbedsQuotaExceeded as exc:
        log(f"\nQUOTA EXHAUSTED\n  {exc.detail}")
        log("  A sandbox key allows 50 requests per day. Nothing was written by this call.")
        return 4
    except HotelbedsError as exc:
        log(f"\nSUPPLIER ERROR\n  {exc}")
        return 5
    except ValueError as exc:
        log(f"\n{exc}")
        return 2


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
