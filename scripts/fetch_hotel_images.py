# -*- coding: utf-8 -*-
"""Vendor real hotel photographs from Wikimedia Commons into frontend/assets/hotels/.

    python scripts/fetch_hotel_images.py              # fetch everything that is missing
    python scripts/fetch_hotel_images.py --force      # re-download and re-encode all
    python scripts/fetch_hotel_images.py taj-palace   # just these slugs

Why a script rather than committed binaries alone: the images are re-derivable, the
licence of every file is re-checked against the live Commons metadata on each run,
and CREDITS.md is regenerated from that metadata instead of being hand-maintained
(a hand-maintained attribution file goes stale silently, which is the one failure
mode that actually matters legally).

Nothing here hotlinks. The portal only ever loads files out of assets/hotels/ —
a blocked or rate-limited upload.wikimedia.org must never be able to turn a
result card into a broken image. Same rule as scripts/fetch_airline_logos.mjs.

Only Public Domain / CC0 / CC BY / CC BY-SA files are accepted; anything else
aborts the download for that slug and is reported, never silently substituted.

Requires Pillow (already a dependency of the imaging step: `pip install Pillow`).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request

from PIL import Image

# --------------------------------------------------------------------------- config

API = "https://commons.wikimedia.org/w/api.php"
UA = "JackPotsworld-hotel-images/1.0 (https://jackpotsworld.example; trustbrick2026@gmail.com)"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "frontend", "assets", "hotels")
JS_OUT = os.path.join(ROOT, "frontend", "assets", "js", "hotel-images.js")
CREDITS = os.path.join(OUT_DIR, "CREDITS.md")

# Card art is 4:3 and ships at two widths. 960 covers a full-bleed mobile card on a
# 2x screen (375 CSS px -> 750); 480 covers the desktop thumbnail column (208 CSS px
# -> 416). srcset picks between them, so a phone never downloads desktop-sized art.
WIDTHS = (960, 480)
ASPECT = (4, 3)
WEBP_QUALITY = 80

# Licences that permit redistribution. Matched case-insensitively as a prefix of
# Commons' LicenseShortName ("CC BY-SA 4.0" -> "cc by-sa"). NC and ND are absent
# on purpose: they are not free for a commercial booking portal.
ALLOWED_LICENCES = ("public domain", "cc0", "cc by")
DENIED_MARKERS = ("-nc", "-nd", "noncommercial", "fair use", "non-free")

# slug -> Commons "File:..." title.
#
# Chosen by hand from a Commons search: landscape, exterior, high resolution, and
# unambiguously the property named. An automated "first search hit" picks lobbies,
# logos, floor plans and press photos of people standing in a lobby, so the
# selection is curation, not a query.
PHOTOS = {
    # --- the six brands named in the brief -------------------------------------
    "taj-palace": "File:Taj Mahal Palace Hotel.jpg",
    "novotel-hyderabad": "File:Novotel Hyderabad Airport Exterior.jpg",
    "hyatt-regency": "File:The Hyatt Regency Hotel, Portman Square - geograph.org.uk - 4517534.jpg",
    "marriott": "File:Washington Marriott Marquis 01.JPG",
    "hilton": "File:L00 390 Hilton Molino Stucky.jpg",
    "radisson": "File:Radisson Blu Hotel, Cologne, 2014.jpg",
    # --- the properties actually in the seeded catalogue ------------------------
    # 0027_seed_catalog_inventory.py seeds Taj Coromandel, The Oberoi, Atlantis The
    # Palm, Marina Bay Sands and Novotel Bengaluru. Without these five the brief's
    # six brand files would never match a single real search result.
    "marina-bay-sands": "File:Hotel Marina Bay Sands y museo ArtScience, Marina Bay, Singapur, 2023-08-16, DD 134-136 HDR.jpg",
    "atlantis-the-palm": "File:Vereinigte Arabische Emirate - Atlantis on Palm Jumeirah - أتلانتيس في نخلة جميرا - panoramio.jpg",
    "novotel-bengaluru": "File:Novotel IBIS Outer Ring Road Hotel & Advaith Hyundai 2-18-2011 8-52-20 AM.JPG",
    "oberoi": "File:The Oberoi Gurgaon.jpg",
    # Taj Coromandel (Chennai) has no free exterior photograph on Commons — only
    # press shots of a 2011 State Department visit. It resolves through the Taj
    # brand tier instead; see HOTEL_BRANDS below.
    # --- fallback ---------------------------------------------------------------
    "default-hotel": "File:DZ6 0939 A modern hotel building lit up at night its triangular façade and rows of balconies glowing against the dark sky.jpg",
}

# Exact property names -> slug. Keys are matched after normalisation (lowercased,
# punctuation and a leading "the"/"hotel" stripped), so only real synonyms belong
# here, not casing or spacing variants.
HOTEL_ALIASES = {
    "taj mahal palace": "taj-palace",
    "taj palace": "taj-palace",
    "taj mahal palace hotel": "taj-palace",
    "marina bay sands": "marina-bay-sands",
    "atlantis the palm": "atlantis-the-palm",
    "atlantis palm": "atlantis-the-palm",
    "atlantis": "atlantis-the-palm",
    "novotel hyderabad": "novotel-hyderabad",
    "novotel hyderabad airport": "novotel-hyderabad",
    "novotel bengaluru": "novotel-bengaluru",
    "novotel bangalore": "novotel-bengaluru",
    # "oberoi" is deliberately NOT here. The seeded property is The Oberoi, New
    # Delhi and the only free photograph is The Oberoi Gurgaon, so an Oberoi name
    # must resolve through the brand tier and be reported as matched:'brand'.
    "hyatt regency": "hyatt-regency",
    "hyatt": "hyatt-regency",
    "marriott": "marriott",
    "marriott marquis": "marriott",
    "jw marriott": "marriott",
    "courtyard by marriott": "marriott",
    "hilton": "hilton",
    "hilton garden inn": "hilton",
    "doubletree by hilton": "hilton",
    "radisson": "radisson",
    "radisson blu": "radisson",
    "park inn by radisson": "radisson",
}

# Chain token -> slug, applied only when no property-level match was found. A brand
# hit means "a photograph of this chain", NOT of this property: "Taj Coromandel"
# lands on the Taj Mahal Palace photo. That is a deliberate, documented trade-off
# the brief asked for ("tolerant of minor name variations"); the resolver reports it
# as matched:'brand' so the UI can label or suppress it.
HOTEL_BRANDS = {
    "taj": "taj-palace",
    "oberoi": "oberoi",
    "trident": "oberoi",
    "novotel": "novotel-bengaluru",
    "hyatt": "hyatt-regency",
    "marriott": "marriott",
    "hilton": "hilton",
    "radisson": "radisson",
    "sheraton": "marriott",
    "westin": "marriott",
    "ritz": "marriott",
    "conrad": "hilton",
    "waldorf": "hilton",
}

DEFAULT_SLUG = "default-hotel"

# Slugs whose photograph is a REPRESENTATIVE property of the chain rather than
# the property a card names. "Hilton" resolves to a photo of the Hilton Molino
# Stucky in Venice; a merchant looking at a Hilton in Pune must not be shown that
# as if it were their hotel. Any match onto one of these is reported as
# matched:'brand' however it was reached, and the card labels it.
#
# taj-palace is NOT in this set: its photograph really is the Taj Mahal Palace,
# so "Taj Palace" is a property match. "Taj Coromandel" still reaches it through
# the brand tier and is labelled.
REPRESENTATIVE_SLUGS = [
    "hilton",
    "hyatt-regency",
    "marriott",
    "radisson",
    "oberoi",
]

# ----------------------------------------------------------------------- utilities


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def api(params: dict) -> dict:
    params = dict(params, format="json", formatversion="2")
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def strip_html(value: str) -> str:
    text = re.sub(r"<[^>]+>", "", value or "")
    return re.sub(r"\s+", " ", text).replace("&amp;", "&").strip()


def fetch_metadata(title: str, width: int) -> dict:
    """Commons metadata plus a server-rendered thumbnail URL at `width`.

    The thumbnail is what gets downloaded — the originals here run to 7 MB and
    30 megapixels, and Commons' own scaler produces a better downsample than
    pulling the full file just to throw 95% of it away.
    """
    data = api({
        "action": "query",
        "titles": title,
        "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": str(width),
    })
    pages = data.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        raise LookupError(f"not found on Commons: {title}")
    info = (pages[0].get("imageinfo") or [None])[0]
    if not info:
        raise LookupError(f"no imageinfo: {title}")
    meta = info.get("extmetadata", {})

    def field(key: str) -> str:
        return strip_html(meta.get(key, {}).get("value", ""))

    return {
        "title": title,
        "thumb_url": info.get("thumburl") or info.get("url"),
        "descr_url": info.get("descriptionurl", ""),
        "width": info.get("width"),
        "height": info.get("height"),
        "mime": info.get("mime", ""),
        "licence": field("LicenseShortName"),
        "licence_url": field("LicenseUrl"),
        "artist": field("Artist"),
        "credit": field("Credit"),
        "usage_terms": field("UsageTerms"),
        "attribution_required": field("AttributionRequired"),
    }


def licence_ok(licence: str) -> bool:
    low = (licence or "").lower()
    if not low:
        return False
    if any(bad in low for bad in DENIED_MARKERS):
        return False
    return any(low.startswith(good) for good in ALLOWED_LICENCES)


def download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def to_webp(raw: bytes, slug: str) -> list[tuple[str, int]]:
    """Centre-crop to 4:3 and write one WebP per width. Returns [(filename, bytes)]."""
    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")

    target = ASPECT[0] / ASPECT[1]
    w, h = img.size
    if w / h > target:                      # too wide -> trim the sides
        new_w = round(h * target)
        left = (w - new_w) // 2
        img = img.crop((left, 0, left + new_w, h))
    else:                                   # too tall -> trim top and bottom, biased
        new_h = round(w / target)           # upward so a building keeps its roofline
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


# ------------------------------------------------------------------------ emitters


def write_js(records: dict) -> None:
    """Generate the manifest the browser reads. Data only — the matching logic
    lives in hotel-image-map.js and is hand-written."""
    files = {slug: True for slug in sorted(records)}
    lines = [
        "'use strict';",
        "/* GENERATED by scripts/fetch_hotel_images.py — do not edit by hand.",
        "   Run `python scripts/fetch_hotel_images.py` to add or replace a hotel photo.",
        "",
        "   Every file listed here exists in frontend/assets/hotels/ as <slug>.webp (960w)",
        "   and <slug>-480.webp (480w). Licence and attribution for each are in",
        "   frontend/assets/hotels/CREDITS.md. Matching logic: hotel-image-map.js. */",
        "",
        "const HOTEL_IMAGE_DIR = 'assets/hotels/';",
        "",
        "/* slug -> true. Presence is the whole contract; paths are derived. */",
        "const HOTEL_IMAGE_FILES = " + json.dumps(files, indent=2, sort_keys=True) + ";",
        "",
        "/* Normalised property name -> slug (property-level, exact). */",
        "const HOTEL_IMAGE_ALIASES = " + json.dumps(HOTEL_ALIASES, indent=2, sort_keys=True) + ";",
        "",
        "/* Chain token -> slug. A hit here is a photo of the CHAIN, not this property. */",
        "const HOTEL_IMAGE_BRANDS = " + json.dumps(HOTEL_BRANDS, indent=2, sort_keys=True) + ";",
        "",
        "/* Slugs whose photo is a stand-in for the CHAIN, not the named property.",
        "   A match onto one of these is always reported as matched:'brand'. */",
        "const HOTEL_IMAGE_REPRESENTATIVE = " + json.dumps(sorted(REPRESENTATIVE_SLUGS), indent=2) + ";",
        "",
        "/* Shown when nothing matches. Guaranteed present. */",
        f"const HOTEL_IMAGE_DEFAULT = '{DEFAULT_SLUG}';",
        "",
        "/* Photographer credit per slug, for the attribution surface. */",
        "const HOTEL_IMAGE_CREDITS = " + json.dumps(
            {s: {"artist": r["artist"], "licence": r["licence"], "source": r["descr_url"]}
             for s, r in sorted(records.items())},
            indent=2, sort_keys=True, ensure_ascii=False) + ";",
        "",
    ]
    with open(JS_OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    log(f"  wrote {os.path.relpath(JS_OUT, ROOT)}")


def write_credits(records: dict) -> None:
    rows = [
        "# Hotel photography — sources, licences and attribution",
        "",
        "Every image in this directory is a real photograph downloaded from Wikimedia",
        "Commons and re-encoded to WebP by `scripts/fetch_hotel_images.py`. Nothing is",
        "AI-generated, nothing is an illustration, and nothing is hotlinked.",
        "",
        "Only Public Domain, CC0, CC BY and CC BY-SA files were accepted; the script",
        "re-verifies the licence against the live Commons metadata on every run and",
        "refuses to write a file whose licence falls outside that set.",
        "",
        "**CC BY and CC BY-SA require visible attribution.** The credit strings below are",
        "exposed to the UI in `HOTEL_IMAGE_CREDITS` (assets/js/hotel-images.js) and",
        "rendered on each card as a `Photo: …` overlay. If that overlay is ever removed,",
        "the attribution must be reproduced somewhere else the user can reach.",
        "",
        "CC BY-SA additionally requires that modified copies be shared under the same",
        "licence. The modification made here is a centre-crop to 4:3 and a resize.",
        "",
        "| File | Hotel / use | Photographer | Licence | Source |",
        "| --- | --- | --- | --- | --- |",
    ]
    for slug in sorted(records):
        r = records[slug]
        artist = r["artist"] or "—"
        lic = r["licence"]
        if r["licence_url"]:
            lic = f"[{lic}]({r['licence_url']})"
        commons_title = r["title"].replace("File:", "")
        rows.append(
            f"| `{slug}.webp` | {r['use']} | {artist} | {lic} | "
            f"[{commons_title}]({r['descr_url']}) |"
        )
    rows += [
        "",
        "## Notes",
        "",
        "- Each entry also ships a 480px-wide variant (`<slug>-480.webp`) used by the",
        "  `srcset` on small screens. It carries the same licence and credit.",
        "- **Taj Coromandel (Chennai)** has no freely licensed exterior photograph on",
        "  Commons. It resolves through the brand tier to the Taj Mahal Palace image,",
        "  which is a photograph of a *different property of the same chain*. The",
        "  resolver reports these as `matched: 'brand'` so they can be labelled or",
        "  suppressed — see `hotel-image-map.js`.",
        "- Hotel names and marks are trademarks of their respective owners. Using a",
        "  freely licensed photograph does not grant any trademark right; showing chain",
        "  imagery in a booking portal is standard OTA practice but the call belongs to",
        "  the product owner.",
        "",
    ]
    with open(CREDITS, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(rows))
    log(f"  wrote {os.path.relpath(CREDITS, ROOT)}")


# ---------------------------------------------------------------------------- main

USE_LABELS = {
    "taj-palace": "Taj Mahal Palace, Mumbai — also serves the Taj chain",
    "novotel-hyderabad": "Novotel Hyderabad Airport",
    "hyatt-regency": "Hyatt Regency London, Portman Square — also serves the Hyatt chain",
    "marriott": "Washington Marriott Marquis — also serves the Marriott chain",
    "hilton": "Hilton Molino Stucky, Venice — also serves the Hilton chain",
    "radisson": "Radisson Blu Cologne — also serves the Radisson chain",
    "marina-bay-sands": "Marina Bay Sands, Singapore",
    "atlantis-the-palm": "Atlantis The Palm, Dubai",
    "novotel-bengaluru": "Novotel Bengaluru Outer Ring Road",
    "oberoi": "The Oberoi Gurgaon — serves the Oberoi chain",
    "default-hotel": "Fallback for any hotel with no matching image",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("slugs", nargs="*", help="only fetch these slugs (default: all)")
    ap.add_argument("--force", action="store_true", help="re-download files that exist")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    wanted = args.slugs or sorted(PHOTOS)
    unknown = [s for s in wanted if s not in PHOTOS]
    if unknown:
        log(f"unknown slug(s): {', '.join(unknown)}")
        return 2

    records: dict = {}
    failures: list = []

    for slug in wanted:
        title = PHOTOS[slug]
        primary = os.path.join(OUT_DIR, f"{slug}.webp")
        log(f"\n{slug}")
        try:
            meta = fetch_metadata(title, WIDTHS[0] * 2)
        except Exception as exc:                                # noqa: BLE001
            log(f"  ! metadata failed: {exc}")
            failures.append((slug, str(exc)))
            continue

        if not licence_ok(meta["licence"]):
            log(f"  ! REJECTED licence '{meta['licence']}' — not redistributable, skipping")
            failures.append((slug, f"licence {meta['licence']!r} not allowed"))
            continue
        log(f"  licence OK: {meta['licence']} — {meta['artist'] or 'unknown author'}")

        meta["use"] = USE_LABELS.get(slug, slug)
        records[slug] = meta

        if os.path.exists(primary) and not args.force:
            log("  already downloaded (use --force to refresh)")
            continue

        try:
            raw = download(meta["thumb_url"])
            for name, size in to_webp(raw, slug):
                log(f"  wrote {name} ({size // 1024} KB)")
        except Exception as exc:                                # noqa: BLE001
            log(f"  ! download/encode failed: {exc}")
            failures.append((slug, str(exc)))
            records.pop(slug, None)

    # The manifest and credits describe the whole directory, so only rewrite them
    # on a full run — a partial run would otherwise drop entries for files that are
    # still sitting on disk.
    if not args.slugs and records:
        log("")
        write_js(records)
        write_credits(records)
    elif args.slugs:
        log("\n(partial run: hotel-images.js and CREDITS.md left untouched —"
            " re-run without arguments to regenerate them)")

    log(f"\n{len(records)}/{len(wanted)} ok")
    if failures:
        log("failures:")
        for slug, why in failures:
            log(f"  {slug}: {why}")
        return 1
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
