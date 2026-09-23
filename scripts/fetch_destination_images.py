# -*- coding: utf-8 -*-
"""Vendor destination photographs from Wikimedia Commons into frontend/assets/destinations/.

    python scripts/fetch_destination_images.py            # fetch everything missing
    python scripts/fetch_destination_images.py --force    # re-download and re-encode all
    python scripts/fetch_destination_images.py goa delhi  # just these slugs

THE SIBLING OF fetch_hotel_images.py, AND IT BORROWS THAT SCRIPT'S CORE rather
than restating it: ``fetch_metadata``, ``licence_ok`` and ``download`` are
imported, so the licence rules the hotel photos are held to are literally the
same code, not a copy that can drift away from them. What is local here is the
curated file list, the output directory and the two emitters.

WHY A CURATED LIST AND NOT A SEARCH. The same reason the hotel script gives:
an automated "first search hit" for "Goa" returns maps, coats of arms, government
buildings and a scan of a 1961 newspaper. Each title below was chosen from a
Commons search by hand — landscape, high resolution, recognisably the place, and
free enough to ship.

Only Public Domain / CC0 / CC BY / CC BY-SA are accepted; NC and ND are refused
because they are not free for a commercial booking portal. A slug whose licence
does not pass is REPORTED AND SKIPPED, never silently substituted — the card
falls back to its tint, which is a worse-looking card and an honest one.

Nothing hotlinks. The portal only ever loads files out of assets/destinations/,
so a blocked or rate-limited upload.wikimedia.org cannot turn the homepage into a
row of broken images.

Requires Pillow: `pip install Pillow`.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

# The licence gate, the Commons client and the downloader, shared with the hotel
# script. Importing is safe: that module does its work under a __main__ guard.
from fetch_hotel_images import (  # noqa: E402
    download,
    fetch_metadata,
    licence_ok,
    strip_html,
)

OUT_DIR = os.path.join(ROOT, "frontend", "assets", "destinations")
JS_OUT = os.path.join(ROOT, "frontend", "assets", "js", "destination-images.js")
CREDITS = os.path.join(OUT_DIR, "CREDITS.md")

#: 4:3 at two widths, matching the hotel art so the two shelves crop alike.
#: 960 covers a full-bleed mobile card on a 2x screen; 480 the desktop column.
WIDTHS = (960, 480)
ASPECT = (4, 3)
WEBP_QUALITY = 80

#: destination slug -> Commons "File:..." title.
#:
#: THE SLUG IS THE ONE IN customer_destinations. That is the whole join: the
#: database stores the slug in image_key, this script writes <slug>.webp, and the
#: browser derives the path. No name appears in frontend JavaScript, and adding a
#: destination is a row plus an entry here — not a code change.
PHOTOS = {
    # Replaced on request: the old Palolem panoramio shot was a beached boat
    # under a white sky, which read as a grey card wherever Goa appeared -
    # the homepage shelf, the destination hero and the package cards. This is
    # the same beach at golden hour, with the palms, the huts and the curve of
    # the bay, which is what the page is selling.
    "goa":        "File:Palolem Beach (5580920479).jpg",
    "hyderabad":  "File:Charminar, Hyderabad, Telangana.jpg",
    "mumbai":     "File:Gateway of India in the evening, Mumbai, India.jpg",
    "delhi":      "File:India Gate, New Delhi from West.jpg",
    "bengaluru":  "File:Vidhana Soudha LE.jpg",
    "kashmir":    "File:Dal Lake, Srinagar, July 2012.jpg",
    "jaipur":     "File:Hawa Mahal in Jaipur India.jpg",
    "kolkata":    "File:Victoria Memorial, Kolkata - West facade 01.jpg",
    "vijayawada": "File:Vijayawada durga temple.JPG",
    "tirupati":   "File:Tirumala 090615.jpg",
    "dubai":      "File:Burj Khalifa (worlds tallest building) and the Dubai skyline (25781049892).jpg",
    "bali":       "File:Tanah-Lot Bali Indonesia Pura-Tanah-Lot-01.jpg",
    "maldives":   "File:Maldives RBR beach 6.jpg",
    "singapore":  "File:Singapore Skyline Marina Bay Sands.jpg",
    "thailand":   "File:Templo Wat Arun, Bangkok, Tailandia, 2013-08-22, DD 30.jpg",
}


def log(msg: str) -> None:
    print(msg, flush=True)


def to_webp(raw: bytes, slug: str) -> list[tuple[str, int]]:
    """Centre-crop to 4:3 and write one WebP per width.

    The vertical bias is the hotel script's, for the same reason: trimming a tall
    photograph evenly cuts the top off a skyline, so the crop keeps more of the
    upper third where the landmark usually is.
    """
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    target = ASPECT[0] / ASPECT[1]
    w, h = img.size
    if w / h > target:
        new_w = round(h * target)
        left = (w - new_w) // 2
        img = img.crop((left, 0, left + new_w, h))
    else:
        new_h = round(w / target)
        top = round((h - new_h) * 0.35)
        img = img.crop((0, top, w, top + new_h))

    written = []
    for width in WIDTHS:
        height = round(width / target)
        resized = img.resize((width, height), Image.LANCZOS)
        name = f"{slug}.webp" if width == WIDTHS[0] else f"{slug}-{width}.webp"
        path = os.path.join(OUT_DIR, name)
        resized.save(path, "WEBP", quality=WEBP_QUALITY, method=6)
        written.append((name, os.path.getsize(path)))
    return written


def _stamp(slug: str) -> str:
    """Eight hex of the 960w file's MD5 — the cache key for that picture."""
    path = os.path.join(OUT_DIR, f"{slug}.webp")
    try:
        with open(path, "rb") as fh:
            return hashlib.md5(fh.read()).hexdigest()[:8]
    except OSError:
        # No file means no stamp, and the manifest should not claim one. The
        # entry stays truthy so presence still reads correctly.
        return "1"


def write_js(records: dict) -> None:
    """The manifest the browser reads. Data only, and presence is the contract.

    Mirrors hotel-images.js: a slug listed here has both widths on disk, so the
    frontend derives ``assets/destinations/<slug>.webp`` without a second lookup
    and without an existence check per card.
    """
    # A CONTENT STAMP, NOT JUST `true`. The path a browser fetches is derived
    # from the slug, so replacing a photograph changes the bytes at a URL that
    # never changes - and every browser that has been to the site keeps the
    # old picture until its copy expires. (That is exactly what happened when
    # Goa's photograph was replaced: the file on the server was new, every
    # visitor's screen was not.)
    #
    # The value is the first 8 hex of the file's MD5. Clients append it as a
    # `?v=`, so new bytes mean a new URL and the swap is immediate. It is also
    # still TRUTHY, which is the whole contract older readers of this manifest
    # rely on - nothing that only asks "is this slug present" has to change.
    files = {slug: _stamp(slug) for slug in sorted(records)}
    credits = {
        slug: {"artist": rec["artist"], "licence": rec["licence"],
               "source": rec["descr_url"]}
        for slug, rec in sorted(records.items())
    }
    lines = [
        "'use strict';",
        "/* GENERATED by scripts/fetch_destination_images.py — do not edit by hand.",
        "   Run `python scripts/fetch_destination_images.py` to add or replace one.",
        "",
        "   Every slug listed here exists in frontend/assets/destinations/ as",
        "   <slug>.webp (960w) and <slug>-480.webp (480w). Licence and attribution",
        "   for each are in frontend/assets/destinations/CREDITS.md.",
        "",
        "   THE SLUG IS THE DATABASE'S image_key. The API sends the key, this file",
        "   says whether art for it shipped, and the path is derived from the two.",
        "   No destination name appears in either — see home-destinations.js. */",
        "",
        "const DESTINATION_IMAGE_DIR = 'assets/destinations/';",
        "",
        "/* image_key -> a short content stamp of that file (truthy, like the",
        "   `true` it replaced). Presence still means 'this slug has artwork';",
        "   the value is what the client appends as ?v= so that REPLACING a",
        "   photograph reaches browsers that already cached the old one. */",
        "const DESTINATION_IMAGE_FILES = " + json.dumps(files, indent=2, sort_keys=True) + ";",
        "",
        "/* Photographer credit per slug, for the attribution surface. */",
        "const DESTINATION_IMAGE_CREDITS = " + json.dumps(credits, indent=2, sort_keys=True) + ";",
        "",
    ]
    with open(JS_OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    log(f"  wrote {os.path.relpath(JS_OUT, ROOT)}")


def write_credits(records: dict) -> None:
    """Regenerated from live Commons metadata, never hand-maintained.

    A stale attribution file is the one failure mode here that actually matters
    legally, and hand-maintenance is how it goes stale silently.
    """
    out = [
        "# Destination photograph credits",
        "",
        "Generated by `scripts/fetch_destination_images.py` from Wikimedia Commons",
        "metadata. Do not edit by hand — re-run the script instead.",
        "",
        "Every file here is Public Domain, CC0, CC BY or CC BY-SA. Nothing under a",
        "NonCommercial or NoDerivatives licence is accepted.",
        "",
        "| Destination | Photographer | Licence | Source |",
        "| --- | --- | --- | --- |",
    ]
    for slug, rec in sorted(records.items()):
        artist = (rec["artist"] or "Unknown").replace("|", "/")
        out.append(
            f"| `{slug}` | {artist} | {rec['licence']} | [{rec['title']}]({rec['descr_url']}) |"
        )
    out.append("")
    with open(CREDITS, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out))
    log(f"  wrote {os.path.relpath(CREDITS, ROOT)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("slugs", nargs="*", help="only these (default: all missing)")
    ap.add_argument("--force", action="store_true", help="re-download everything")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    wanted = args.slugs or sorted(PHOTOS)
    unknown = [s for s in wanted if s not in PHOTOS]
    if unknown:
        log(f"unknown slug(s): {', '.join(unknown)}")
        return 2

    records: dict[str, dict] = {}
    skipped: list[str] = []

    for slug in wanted:
        title = PHOTOS[slug]
        primary = os.path.join(OUT_DIR, f"{slug}.webp")
        if os.path.exists(primary) and not args.force:
            log(f"{slug}: present, skipping download")
        log(f"{slug}: {title}")
        try:
            meta = fetch_metadata(title, WIDTHS[0])
        except Exception as exc:                      # noqa: BLE001 — reported, not raised
            log(f"  ! metadata failed: {exc}")
            skipped.append(slug)
            continue

        if not licence_ok(meta["licence"]):
            log(f"  ! licence refused: {meta['licence'] or '(none reported)'}")
            skipped.append(slug)
            continue

        if not os.path.exists(primary) or args.force:
            try:
                raw = download(meta["thumb_url"])
                for name, size in to_webp(raw, slug):
                    log(f"  {name}  {size // 1024} KB")
            except Exception as exc:                  # noqa: BLE001
                log(f"  ! download/encode failed: {exc}")
                skipped.append(slug)
                continue
            time.sleep(0.4)                           # be polite to Commons

        records[slug] = meta
        log(f"  ok  {meta['licence']}  {strip_html(meta['artist'])[:60]}")

    if records:
        write_js(records)
        write_credits(records)

    log("")
    log(f"done: {len(records)} with art, {len(skipped)} skipped")
    if skipped:
        log(f"skipped: {', '.join(skipped)} — these keep the tinted fallback")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
