# -*- coding: utf-8 -*-
"""Vendor real photographs of the famous places into frontend/assets/locations/.

    python scripts/fetch_attraction_images.py               # everything missing
    python scripts/fetch_attraction_images.py --force       # re-fetch everything
    python scripts/fetch_attraction_images.py hyderabad     # one destination
    python scripts/fetch_attraction_images.py hyderabad__charminar   # one place
    python scripts/fetch_attraction_images.py --dry-run     # choose, download nothing

THE THIRD SCRIPT IN THIS FAMILY, and it borrows the other two rather than
restating them: ``fetch_metadata``, ``licence_ok``, ``download`` and
``strip_html`` come from fetch_hotel_images, so the licence rules every
photograph on this site is held to are one piece of code.

WHAT IT DOES NOT DO IS GUESS. The destination and hotel scripts carry a curated
Commons file title per subject, because an automated "first search hit" for
"Goa" returns maps, coats of arms and a scan of a 1961 newspaper. Ninety-three
landmarks is too many to hand-pick and too important to guess at, so this takes
a third road: COMMONS' OWN CATEGORIES. ``Category:Charminar`` is maintained by
people, and a file inside it is a photograph OF Charminar — not a file whose
name happens to contain the word. That is the difference between sourcing and
scraping, and it is the only reason this script is allowed to choose at all.

Everything it chooses then has to survive:

  * the licence gate — Public Domain / CC0 / CC BY / CC BY-SA only, never NC or
    ND, which are not free for a commercial booking site;
  * a shape and size floor — at least 1600px wide and between 1.2:1 and 2.2:1,
    which throws out portrait shots that cannot be cropped to a card and the
    3000x400 banners Commons keeps for page headers;
  * a subject filter — a title naming a stamp, map, coat of arms, plan,
    painting, diagram or logo is not a photograph of the place, and those sit
    in these categories too.

WHAT IT WRITES

    frontend/assets/locations/<destination>__<slug>.webp        960w, 4:3
    frontend/assets/locations/<destination>__<slug>-480.webp    480w, 4:3
    frontend/assets/locations/CREDITS.md        every photo, author, licence, source
    frontend/assets/js/location-images.js       the manifest the browser reads
    customer_attractions.image_key              set to <destination>__<slug>

THE DATABASE IS THE SUBJECT LIST. Nothing here names a landmark: it reads
``customer_attractions``, so a place added through the catalogue is fetched by
the next run with no edit to this file. CATEGORY_OVERRIDES exists only for the
handful whose Commons category cannot be derived from their name.

CREDITS.md IS MEANT TO BE READ. It is the record that makes this sourcing
rather than scraping — one line per landmark, with the photographer, the
licence and a link to the Commons page. A photograph nobody can check the
provenance of should not be on the site.

Requires Pillow and the backend's database URL (it reads .env the same way the
application does).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))

from fetch_hotel_images import (  # noqa: E402
    API,
    UA,
    download,
    fetch_metadata,
    licence_ok,
    strip_html,
)

OUT_DIR = os.path.join(ROOT, "frontend", "assets", "locations")
JS_OUT = os.path.join(ROOT, "frontend", "assets", "js", "location-images.js")
CREDITS = os.path.join(OUT_DIR, "CREDITS.md")

#: Same crop and widths as the destination shelf, so the two sets of cards sit
#: together without one looking taller than the other.
WIDTHS = (960, 480)
ASPECT = (4, 3)
WEBP_QUALITY = 80

#: A candidate has to be at least this wide before cropping, or the 960 output
#: is an upscale of something smaller.
MIN_WIDTH = 1600
#: Landscape, but not a page banner. 4:3 is 1.33 and 16:9 is 1.78.
MIN_RATIO, MAX_RATIO = 1.15, 2.30

#: These live in landmark categories and are not photographs of the landmark.
NOT_A_PHOTOGRAPH = re.compile(
    r"\b(stamp|map|maps|coat[ _]of[ _]arms|seal|logo|diagram|plan|plans|drawing"
    r"|painting|sketch|engraving|lithograph|illustration|poster|banner|chart"
    r"|graph|coin|currency|note|ticket|brochure|leaflet|screenshot|infobox"
    r"|signature|flag|emblem|blazon|3d|model|reconstruction|animation|gif)\b",
    re.I)

#: Landmarks whose Commons category is not derivable from their name. Kept
#: deliberately small: every entry is a thing the derivation could not do, and
#: a long list here would mean the derivation is wrong.
CATEGORY_OVERRIDES: dict[str, str] = {}


def log(msg: str) -> None:
    """Print, on a console that cannot necessarily spell what Commons calls things.

    A Windows console is cp1252 and a Commons file title routinely is not -
    an accent, a Devanagari place name, CJK. `print` raising UnicodeEncodeError
    killed a run fifty landmarks in: a logging call losing an afternoon of
    downloads. Whatever the console cannot render is replaced rather than
    raised.
    """
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "ascii"
        print(msg.encode(enc, "replace").decode(enc, "replace"), flush=True)


def api(**params) -> dict:
    """One Commons API call. `format=json` and the project's UA, always."""
    params.setdefault("format", "json")
    params.setdefault("formatversion", "2")
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


# ---------------------------------------------------------------------------
# Which Commons category holds photographs of this place
# ---------------------------------------------------------------------------
def category_exists(title: str) -> bool:
    try:
        data = api(action="query", titles=title, prop="info")
    except Exception:
        return False
    pages = data.get("query", {}).get("pages", [])
    return bool(pages) and not pages[0].get("missing")


def find_category(name: str, city: str, key: str) -> str | None:
    """The category for this landmark, or None.

    Tried in order of how sure each form is: the exact name, the name
    disambiguated by its city (Commons does this a lot — "Birla Mandir,
    Hyderabad"), then a category SEARCH as the last resort, which is only
    accepted when the result still contains the landmark's name.
    """
    if key in CATEGORY_OVERRIDES:
        return CATEGORY_OVERRIDES[key]

    for form in (f"Category:{name}",
                 f"Category:{name}, {city}",
                 f"Category:{name} ({city})",
                 f"Category:{name}, India"):
        if category_exists(form):
            return form

    try:
        data = api(action="query", list="search", srsearch=f"{name} {city}",
                   srnamespace=14, srlimit=5)
    except Exception:
        return None
    needle = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
    first_word = needle.split(" ")[0] if needle else ""
    for hit in data.get("query", {}).get("search", []):
        title = hit.get("title", "")
        flat = re.sub(r"[^a-z0-9]+", " ", title.lower())
        # The whole name, or at least its distinguishing first word: "Category:
        # Forts in Telangana" must not become the photograph of Golconda Fort.
        if needle and needle in flat:
            return title
        if first_word and len(first_word) > 4 and first_word in flat and city.lower() in flat:
            return title
    return None


# ---------------------------------------------------------------------------
# Which file in it
# ---------------------------------------------------------------------------
def candidates(category: str, limit: int = 60) -> list[dict]:
    """Files in the category, with the metadata needed to judge them."""
    try:
        data = api(action="query", generator="categorymembers", gcmtitle=category,
                   gcmtype="file", gcmlimit=str(limit), prop="imageinfo",
                   iiprop="url|size|mime|extmetadata")
    except Exception as exc:
        log(f"      category read failed: {exc}")
        return []
    out = []
    for page in data.get("query", {}).get("pages", []):
        info = (page.get("imageinfo") or [None])[0]
        if not info:
            continue
        meta = info.get("extmetadata", {})
        out.append({
            "title": page.get("title", ""),
            "width": info.get("width") or 0,
            "height": info.get("height") or 0,
            "mime": info.get("mime", ""),
            "licence": strip_html(meta.get("LicenseShortName", {}).get("value", "")),
        })
    return out


def usable(c: dict, relaxed: bool = False) -> bool:
    """Is this a photograph of the place, free enough, and the right shape?

    `relaxed` is the SECOND pass, and only the shape moves. A tall subject -
    a basilica façade, a minaret - is often photographed portrait, and a
    category of nothing but portraits would otherwise leave a famous landmark
    with no picture at all. A square-ish frame still crops to 4:3 by losing
    height; what stays refused is the licence, the subject and anything too
    small to fill a 960px card.
    """
    if not c["mime"].startswith("image/") or "svg" in c["mime"]:
        return False
    if NOT_A_PHOTOGRAPH.search(c["title"]):
        return False
    if not licence_ok(c["licence"]):
        return False
    floor = 1400 if relaxed else MIN_WIDTH
    if c["width"] < floor or not c["height"]:
        return False
    ratio = c["width"] / c["height"]
    lo, hi = (0.95, 2.60) if relaxed else (MIN_RATIO, MAX_RATIO)
    return lo <= ratio <= hi


def pick(category: str) -> dict | None:
    """The best usable file in a category: closest to 4:3, then largest.

    Sorted on the crop rather than on raw pixels — a 6000x2600 panorama loses
    two thirds of itself to a 4:3 card, and a 2400x1700 photograph taken for
    the subject keeps nearly all of it.
    """
    target = ASPECT[0] / ASPECT[1]
    pool = candidates(category)
    good = [c for c in pool if usable(c)]
    if not good:
        good = [c for c in pool if usable(c, relaxed=True)]
    if not good:
        return None
    good.sort(key=lambda c: (round(abs(c["width"] / c["height"] - target), 2),
                             -(c["width"] * c["height"])))
    return good[0]


# ---------------------------------------------------------------------------
# Writing it out
# ---------------------------------------------------------------------------
def to_webp(raw: bytes, key: str) -> list[tuple[str, int]]:
    """Centre-crop to 4:3 and write one WebP per width.

    The vertical bias is the other two scripts', for the same reason: trimming
    a tall photograph evenly cuts the top off a monument, so the crop keeps
    more of the upper third.
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
        top = min(round((h - new_h) * 0.30), h - new_h)
        img = img.crop((0, top, w, top + new_h))

    written = []
    for width in WIDTHS:
        height = round(width / target)
        name = f"{key}.webp" if width == max(WIDTHS) else f"{key}-{width}.webp"
        path = os.path.join(OUT_DIR, name)
        img.resize((width, height), Image.LANCZOS).save(
            path, "WEBP", quality=WEBP_QUALITY, method=6)
        written.append((name, os.path.getsize(path)))
    return written


def write_js(records: dict) -> None:
    """The manifest. The browser resolves a KEY from the API through this.

    Same contract as destination-images.js: a key the API sent, present here,
    or no photograph at all. Nothing in the frontend knows a landmark's name.
    """
    files = {k: True for k in sorted(records)}
    credits = {k: {"title": v["title"], "artist": v["artist"], "licence": v["licence"],
                   "source": v["descr_url"]}
               for k, v in sorted(records.items())}
    lines = [
        "'use strict';",
        "/* GENERATED by scripts/fetch_attraction_images.py - do not edit by hand.",
        "",
        "   Photographs of the famous places, vendored from Wikimedia Commons into",
        "   assets/locations/. The key is the attraction's own id from the API",
        "   ('hyderabad__charminar'), so the browser resolves a picture it was told",
        "   about rather than one it guessed at, and a landmark with no photograph",
        "   falls back to the card's own artwork.",
        "",
        "   Author, licence and source for each are in assets/locations/CREDITS.md. */",
        "const LOCATION_IMAGE_DIR = 'assets/locations/';",
        "const LOCATION_IMAGE_FILES = " + json.dumps(files, indent=2, sort_keys=True) + ";",
        "const LOCATION_IMAGE_CREDITS = " + json.dumps(credits, indent=2, sort_keys=True) + ";",
        "",
    ]
    with open(JS_OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))


def write_credits(records: dict) -> None:
    lines = [
        "# Photographs of the famous places",
        "",
        "Vendored from Wikimedia Commons by `scripts/fetch_attraction_images.py`.",
        "Nothing here is hotlinked: the files are served from this directory.",
        "",
        "Each photograph was taken from the landmark's own Commons **category** -",
        "a human-maintained grouping of photographs OF that place - and then had to",
        "pass the licence gate (Public Domain / CC0 / CC BY / CC BY-SA only; never",
        "NC or ND), a size and shape floor, and a filter that refuses stamps, maps,",
        "plans and paintings.",
        "",
        "**This file is meant to be read.** It is the record that makes the sourcing",
        "checkable: if a photograph here is not the place it claims to be, it should",
        "be replaced, and its landmark added to `CATEGORY_OVERRIDES` in the script.",
        "",
        "| Landmark | File | Author | Licence | Source |",
        "| --- | --- | --- | --- | --- |",
    ]
    for key in sorted(records):
        r = records[key]
        artist = (r["artist"] or "-").replace("|", "/")
        lines.append(
            f"| `{key}` | {r['title'].replace('File:', '')} | {artist} | "
            f"{r['licence'] or '-'} | [Commons]({r['descr_url']}) |")
    lines.append("")
    with open(CREDITS, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))


# ---------------------------------------------------------------------------
def subjects(filters: list[str]) -> list[dict]:
    """The landmarks, from the database. This script names none of them."""
    from sqlalchemy import text

    from app.database.session import SessionLocal

    db = SessionLocal()
    try:
        rows = db.execute(text("""
            SELECT d.slug AS dest, d.name AS city, a.slug AS slug, a.name AS name,
                   a.image_key AS image_key
              FROM customer_attractions a
              JOIN customer_destinations d ON d.customer_destination_id = a.destination_id
             WHERE a.is_active AND d.is_active
             ORDER BY d.sort_order, d.name, a.sort_order, a.name
        """)).mappings().all()
    finally:
        db.close()

    out = [dict(r) | {"key": f"{r['dest']}__{r['slug']}"} for r in rows]
    if not filters:
        return out
    wanted = {f.lower() for f in filters}
    return [s for s in out
            if s["key"].lower() in wanted or s["dest"].lower() in wanted
            or s["slug"].lower() in wanted]


def stamp_keys(keys: list[str]) -> int:
    """Write the image keys back. The API is the source of truth, so the row
    has to carry the key — the frontend must never derive it from a name."""
    from sqlalchemy import text

    from app.database.session import SessionLocal

    db = SessionLocal()
    try:
        n = 0
        for key in keys:
            dest, slug = key.split("__", 1)
            n += db.execute(text("""
                UPDATE customer_attractions a
                   SET image_key = :key
                  FROM customer_destinations d
                 WHERE d.customer_destination_id = a.destination_id
                   AND d.slug = :dest AND a.slug = :slug
                   AND (a.image_key IS DISTINCT FROM :key)
            """), {"key": key, "dest": dest, "slug": slug}).rowcount
        db.commit()
        return n
    finally:
        db.close()


def load_existing() -> dict:
    """Credits from the last run, so a partial run does not lose them."""
    if not os.path.exists(JS_OUT):
        return {}
    try:
        text_ = open(JS_OUT, encoding="utf-8").read()
        m = re.search(r"const LOCATION_IMAGE_CREDITS = (\{.*?\});", text_, re.S)
        if not m:
            return {}
        raw = json.loads(m.group(1))
        return {k: {"title": v.get("title", ""), "artist": v.get("artist", ""),
                    "licence": v.get("licence", ""), "descr_url": v.get("source", "")}
                for k, v in raw.items()}
    except Exception:
        return {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("only", nargs="*", help="destination slugs, attraction slugs or full keys")
    ap.add_argument("--force", action="store_true", help="re-fetch even if the files exist")
    ap.add_argument("--dry-run", action="store_true", help="choose photographs, download nothing")
    ap.add_argument("--limit", type=int, default=0, help="stop after N landmarks")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    todo = subjects(args.only)
    if args.limit:
        todo = todo[:args.limit]
    log(f"{len(todo)} landmark(s) from the database")

    records = load_existing()
    done, skipped, failed = [], 0, []

    for s in todo:
        key = s["key"]
        target = os.path.join(OUT_DIR, f"{key}.webp")
        if os.path.exists(target) and not args.force:
            skipped += 1
            continue

        log(f"  {key}  ({s['name']}, {s['city']})")
        category = find_category(s["name"], s["city"], key)
        if not category:
            log("      no Commons category - left on the fallback artwork")
            failed.append((key, "no category"))
            continue

        chosen = pick(category)
        if not chosen:
            log(f"      {category}: nothing usable (licence, size or subject)")
            failed.append((key, f"nothing usable in {category}"))
            continue
        log(f"      {category} -> {chosen['title']} "
            f"({chosen['width']}x{chosen['height']}, {chosen['licence']})")

        if args.dry_run:
            done.append(key)
            continue

        try:
            meta = fetch_metadata(chosen["title"], max(WIDTHS) * 2)
            if not licence_ok(meta["licence"]):
                log(f"      licence changed under us: {meta['licence']} - skipped")
                failed.append((key, "licence"))
                continue
            written = to_webp(download(meta["thumb_url"]), key)
        except Exception as exc:
            log(f"      failed: {exc}")
            failed.append((key, str(exc)))
            continue

        records[key] = {"title": meta["title"], "artist": meta["artist"],
                        "licence": meta["licence"], "descr_url": meta["descr_url"]}
        done.append(key)
        # WRITTEN EVERY TIME, not once at the end. The first run of this script
        # died on its 51st landmark and the manifest had never been written, so
        # fifty downloaded photographs were invisible to the browser. Rewriting
        # two small files per landmark costs nothing beside a network fetch.
        write_js(records)
        write_credits(records)
        stamp_keys([key])
        log("      " + ", ".join(f"{n} ({b // 1024} KB)" for n, b in written))
        time.sleep(0.4)          # Commons asks for restraint; this is polite

    if args.dry_run:
        log(f"\ndry run: {len(done)} chosen, {len(failed)} without a photograph")
        return 0

    if done:
        write_js(records)
        write_credits(records)
        log(f"  {len(done)} image_key(s) stamped on their attraction rows")

    log(f"\n{len(done)} fetched, {skipped} already present, {len(failed)} without a photograph")
    if done:
        # Said every time, because forgetting it means the new photographs are
        # on disk and invisible: the manifest ships behind a ?v= query, and a
        # browser that already holds the old one will not ask for this one.
        log("")
        log("BUMP THE ?v= ON location-images.js in destination.html and"
            " location.html, or a browser that has the old manifest keeps it.")
    for key, why in failed:
        log(f"  - {key}: {why}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
