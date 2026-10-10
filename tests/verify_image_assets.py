"""Image assets: what ships, what the code points at, and what the server delivers.

    python tests/verify_image_assets.py                       # files + code (no server needed)
    python tests/verify_image_assets.py --live http://127.0.0.1:8000
    python tests/verify_image_assets.py --live https://your-domain      # production, read-only GETs

WHAT IT CHECKS (each is a reason an image shows on one machine and not another)

  1. MANIFESTS vs DISK   Every key in destination-images.js, location-images.js and
                         hotel-images.js has its files (base, -480, and -1600 for
                         destinations), they are real WebP (RIFF....WEBP), they are not
                         empty, and the name matches CASE-EXACTLY. Windows and macOS
                         ignore case; the Linux container does not, so `Goa.webp` works
                         on a laptop and 404s in production.
  2. CODE vs DISK        Every image path written in an HTML page, a stylesheet or a
                         script literal exists, case-exactly. (Paths built at run time from
                         a key are covered by 1 and 3.)
  3. DATA vs MANIFESTS   (--live) Every destination, attraction, area, hotel and package
                         the API returns resolves to art that ships, or is reported as
                         "will use the fallback" — never silently.
  4. DELIVERY            (--live) Every file above is fetched: 200, an image/* type (WebP
                         as image/webp), the length the file has, and a cache policy.
  5. EXTERNAL            Image URLs that point at another site (hotlink / expiry risk).

Exit status 1 on any FAIL; WARN lines never fail the run.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONT = ROOT / "frontend"
JS = FRONT / "assets" / "js"

fails: list[str] = []
warns: list[str] = []


def ok(msg: str) -> None:
    print(f"  PASS  {msg}")


def fail(msg: str) -> None:
    fails.append(msg)
    print(f"  FAIL  {msg}")


def warn(msg: str) -> None:
    warns.append(msg)
    print(f"  WARN  {msg}")


def exact_exists(path: Path) -> bool:
    """True only if every component matches the name on disk exactly (case-sensitive)."""
    try:
        rel = path.resolve().relative_to(FRONT.resolve())
    except ValueError:
        return path.exists()
    cur = FRONT
    for part in rel.parts:
        if part not in {p.name for p in cur.iterdir()}:
            return False
        cur = cur / part
    return True


def is_webp(path: Path) -> bool:
    head = path.read_bytes()[:12]
    return head[:4] == b"RIFF" and head[8:12] == b"WEBP"


def manifest(js_file: str, const: str) -> dict:
    """The keys of `const NAME = { "k": ..., }` in a generated manifest."""
    text = (JS / js_file).read_text(encoding="utf-8")
    m = re.search(r"const " + const + r"\s*=\s*\{(.*?)\n\};", text, re.S)
    return dict(re.findall(r'"([^"]+)":\s*("[^"]*"|true)', m.group(1))) if m else {}


# ---------------------------------------------------------------------------
print("\n== 1. Manifests against the files on disk ==")
# ---------------------------------------------------------------------------
SETS = [
    ("destinations", "destination-images.js", "DESTINATION_IMAGE_FILES", "destinations", ("", "-480", "-1600")),
    ("attraction photos", "location-images.js", "LOCATION_IMAGE_FILES", "locations", ("", "-480")),
    ("hotels", "hotel-images.js", "HOTEL_IMAGE_FILES", "hotels", ("", "-480")),
]
shipped: dict[str, set[str]] = {}
for label, js_file, const, folder, sizes in SETS:
    keys = manifest(js_file, const)
    shipped[label] = set(keys)
    bad = []
    for key in keys:
        for sfx in sizes:
            p = FRONT / "assets" / folder / f"{key}{sfx}.webp"
            if not p.exists():
                bad.append(f"missing {p.name}")
            elif not exact_exists(p):
                bad.append(f"CASE MISMATCH {p.name}")
            elif p.stat().st_size < 500:
                bad.append(f"empty {p.name}")
            elif not is_webp(p):
                bad.append(f"not WebP {p.name}")
    (ok if not bad else fail)(f"{label}: {len(keys)} keys, {len(keys) * len(sizes)} files" + ("" if not bad else " — " + "; ".join(bad[:6])))
    on_disk = {re.sub(r"(-480|-1600)?\.webp$", "", f.name) for f in (FRONT / "assets" / folder).glob("*.webp")}
    orphans = sorted(on_disk - set(keys))
    if orphans:
        warn(f"{label}: files with no manifest entry (never shown): {', '.join(orphans[:8])}")

# every ASSET FILE NAME is lower-case-safe: a mixed-case name is a bug waiting for a Linux host
upper = [str(p.relative_to(FRONT)) for p in (FRONT / "assets").rglob("*")
         if p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".ico") and p.name != p.name.lower()]
if upper:
    warn(f"{len(upper)} image file names contain capitals (fine only while every reference matches exactly): "
         + ", ".join(upper[:6]) + (" ..." if len(upper) > 6 else ""))

# ---------------------------------------------------------------------------
print("\n== 2. Image paths written in pages, stylesheets and scripts ==")
# ---------------------------------------------------------------------------
IMG_EXT = r"(?:png|jpe?g|webp|svg|gif|ico|avif)"
ATTR = re.compile(r"""(?:src|poster|data-src|href|content)\s*=\s*["']([^"'#?]+\.""" + IMG_EXT + r""")(?:\?[^"']*)?["']""", re.I)
SRCSET = re.compile(r"""srcset\s*=\s*["']([^"']+)["']""", re.I)
CSS_URL = re.compile(r"""url\(\s*["']?([^"')\s]+\.""" + IMG_EXT + r""")(?:\?[^"')]*)?["']?\s*\)""", re.I)
JS_LIT = re.compile(r"""["']((?:\.\./|\./|/)?assets/[A-Za-z0-9_\-./]+\.""" + IMG_EXT + r""")(?:\?[^"']*)?["']""", re.I)
missing: dict[str, list[str]] = {}
case_bad: dict[str, list[str]] = {}
external: dict[str, set[str]] = {}
checked = 0


def resolve(ref: str, source: Path) -> Path:
    if ref.startswith("/"):
        return FRONT / ref.lstrip("/")
    if source.suffix == ".css":
        return (source.parent / ref).resolve()
    if source.suffix == ".js":
        base = FRONT / "customer" if "customer" in source.parts and not ref.startswith("assets/") else FRONT
        return (base / ref).resolve()
    return (source.parent / ref).resolve()


for src in sorted(FRONT.rglob("*")):
    if src.suffix not in (".html", ".css", ".js") or "vendor" in src.parts:
        continue
    text = src.read_text(encoding="utf-8", errors="ignore")
    refs = [m.group(1) for m in ATTR.finditer(text)]
    for m in SRCSET.finditer(text):
        refs += [part.split()[0] for part in m.group(1).split(",") if part.strip()]
    if src.suffix == ".css":
        refs += [m.group(1) for m in CSS_URL.finditer(text)]
    if src.suffix in (".js", ".html"):
        refs += [m.group(1) for m in JS_LIT.finditer(text)] + ([m.group(1) for m in CSS_URL.finditer(text)] if src.suffix == ".html" else [])
    for ref in set(refs):
        if ref.startswith("data:") or "${" in ref or "{{" in ref:
            continue
        if re.match(r"https?://|//", ref):
            external.setdefault(ref, set()).add(str(src.relative_to(FRONT)))
            continue
        checked += 1
        target = resolve(ref, src)
        label = f"{ref}  <- {src.relative_to(FRONT)}"
        if not target.exists():
            missing.setdefault(label, [])
        elif not exact_exists(target):
            case_bad.setdefault(label, [])
if missing:
    for label in sorted(missing)[:30]:
        fail("missing: " + label)
else:
    ok(f"{checked} written image paths all exist")
if case_bad:
    for label in sorted(case_bad)[:30]:
        fail("CASE mismatch (breaks on Linux): " + label)
else:
    ok("and every one matches its file name case-exactly")
if external:
    for url, where in sorted(external.items()):
        warn(f"external image: {url[:90]}  ({', '.join(sorted(where))[:70]})")
else:
    ok("no page, stylesheet or script hot-links an image from another site")

# ---------------------------------------------------------------------------
ap = argparse.ArgumentParser()
ap.add_argument("--live", help="base URL to check data and delivery against")
args = ap.parse_args()

if not args.live:
    print(f"\n{'FAILED' if fails else 'OK'}: {len(fails)} failure(s), {len(warns)} warning(s)  (add --live URL for data + delivery)")
    sys.exit(1 if fails else 0)

import requests  # noqa: E402

BASE = args.live.rstrip("/")
API = BASE + "/api/customer"
S = requests.Session()


def get_json(path: str):
    r = S.get(API + path, timeout=20)
    r.raise_for_status()
    return r.json()


print(f"\n== 3. What the API returns, against the art that ships ({BASE}) ==")
dests = get_json("/destinations")
no_art = [d["id"] for d in dests if d.get("image") not in shipped["destinations"]]
(ok if not no_art else warn)(f"destinations: {len(dests) - len(no_art)}/{len(dests)} have art"
                              + (f" — fall back for: {', '.join(no_art)}" if no_art else ""))
bad_key = [d["id"] for d in dests if d.get("image") and d["image"] not in shipped["destinations"]]
(ok if not bad_key else fail)("every destination image key the API sends is a key that ships" if not bad_key
                               else f"image key sent but not shipped: {bad_key}")
att_total = att_art = area_total = 0
missing_att = []
for d in dests:
    for a in get_json(f"/destinations/{d['id']}/attractions"):
        att_total += 1
        if a["id"] in shipped["attraction photos"]:
            att_art += 1
        else:
            missing_att.append(a["id"])
    area_total += len(get_json(f"/destinations/{d['id']}/locations"))
(ok if att_art == att_total else warn)(
    f"attractions: {att_art}/{att_total} have a photograph" + ("" if not missing_att else f" — fall back for {len(missing_att)}: {', '.join(missing_att[:5])}..."))
print(f"        ({area_total} areas have no photograph of their own by design — they show their destination's art)")
hotels = get_json("/hotels?limit=200")
hot_no = [h["name"] for h in hotels if (h.get("image") or "") not in shipped["hotels"] and not h.get("provider_images")]
(ok if not hot_no else warn)(f"hotels: {len(hotels) - len(hot_no)}/{len(hotels)} have art" + (f" — fall back for: {', '.join(hot_no[:6])}" if hot_no else ""))
pk = get_json("/packages")
pk_no = [p["name"] for p in pk if p.get("image") not in shipped["destinations"] | shipped["attraction photos"]]
(ok if not pk_no else warn)(f"packages: {len(pk) - len(pk_no)}/{len(pk)} resolve to shipped art (destination or landmark)" + (f" — fall back for: {', '.join(pk_no)}" if pk_no else ""))
ext_api = [h["name"] for h in hotels if any(str(u).startswith("http") for u in (h.get("provider_images") or []))]
if ext_api:
    warn(f"{len(ext_api)} hotel(s) carry provider image URLs (hosted by the supplier — hotlink/expiry risk): {', '.join(ext_api[:4])}")

print("\n== 4. Delivery: status, type and length of every shipped file ==")
bad = []
n = 0
for label, js_file, const, folder, sizes in SETS:
    for key in sorted(shipped[label]):
        for sfx in sizes:
            url = f"{BASE}/assets/{folder}/{key}{sfx}.webp"
            r = S.get(url, timeout=30)
            n += 1
            size = (FRONT / "assets" / folder / f"{key}{sfx}.webp").stat().st_size
            if r.status_code != 200:
                bad.append(f"{r.status_code} {url}")
            elif r.headers.get("content-type", "").split(";")[0] != "image/webp":
                bad.append(f"type {r.headers.get('content-type')} {url}")
            elif len(r.content) != size:
                bad.append(f"length {len(r.content)} != {size} {url}")
for rel in ["assets/images/hero-sunset.webp", "assets/images/jackpots-logo-full.png", "assets/images/favicon.ico",
            "assets/images/hero-dubai-1600.webp", "assets/images/login-collage.jpg"]:
    r = S.get(f"{BASE}/{rel}", timeout=30)
    n += 1
    want = {"webp": "image/webp", "png": "image/png", "ico": ("image/x-icon", "image/vnd.microsoft.icon"), "jpg": "image/jpeg"}[rel.rsplit(".", 1)[1]]
    got = r.headers.get("content-type", "").split(";")[0]
    if r.status_code != 200 or got not in (want if isinstance(want, tuple) else (want,)):
        bad.append(f"{r.status_code} {got} {rel}")
(ok if not bad else fail)(f"{n} files fetched: 200, correct image type, full length" if not bad else "; ".join(bad[:8]))
sample = S.head(f"{BASE}/assets/destinations/goa.webp", timeout=20)
cc = sample.headers.get("cache-control", "")
(ok if cc else warn)(f"cache policy on art: {cc or 'none'}")
nosniff = sample.headers.get("x-content-type-options", "")
(ok if nosniff == "nosniff" else warn)(f"X-Content-Type-Options: {nosniff or 'absent'}")
print(f"\n{'FAILED' if fails else 'OK'}: {len(fails)} failure(s), {len(warns)} warning(s)")
sys.exit(1 if fails else 0)
