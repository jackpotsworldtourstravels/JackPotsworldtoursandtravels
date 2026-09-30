"""The shipped image libraries an admin may point a catalogue row at.

Phase 5 of the B2C Admin Portal build-out.

IMAGES ARE KEYS, NOT URLS, AND THIS DOES NOT CHANGE THAT. Every
``image_key`` in ``customer_hotels``/``customer_packages``/
``customer_destinations``/``customer_locations`` names a photograph that
SHIPPED with the frontend — ``assets/destinations/<key>.webp`` plus a
``<key>-480.webp`` small variant, listed in a generated manifest the customer
pages read (see ``destination-images.js``). The page turns a key into a path;
it never accepts a path or URL from the API. So "manage images" here means
"choose which shipped photograph a row points at", validated against what is
actually on disk — NOT uploading a new file. A new photograph still arrives
the way it always has (``scripts/fetch_*_images.py`` + a deploy), because an
upload written to a container's disk would vanish on the next redeploy and
the manifest would not know about it.

VALIDATED AGAINST THE FILES, NOT A COPY OF THE MANIFEST. The manifests are
generated JavaScript; parsing them from Python would be a second reader of a
format that exists for the browser. The art directory is the ground truth the
manifest is generated from, and requiring both size variants is the same
check ``package-listing.js`` makes before it will draw one.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, status

_FRONTEND = Path(__file__).resolve().parents[3] / "frontend"
_ASSETS = _FRONTEND / "assets"

#: kind -> the asset directory each library lives in, relative to ``assets/``.
_DIRS = {
    "destination": "destinations",
    "location": "locations",
    "hotel": "hotels",
}

#: What each catalogue row type may point at. A package's ``image_key`` is
#: either a city slug or a ``city__place`` key, so it draws on both of the
#: place libraries — the same two manifests ``package-listing.js`` tries in
#: order.
_ALLOWED = {
    "hotel": ("hotel",),
    "destination": ("destination",),
    "location": ("location",),
    "package": ("destination", "location"),
}


def _keys(kind: str) -> list[str]:
    directory = _ASSETS / _DIRS[kind]
    if not directory.is_dir():
        return []
    found = []
    for f in directory.glob("*.webp"):
        stem = f.stem
        # Only the base file names a key; the size variants ride along.
        if stem.endswith("-480") or stem.endswith("-1600"):
            continue
        if (directory / f"{stem}-480.webp").is_file():
            found.append(stem)
    return sorted(found)


def library(row_type: str) -> list[dict]:
    """Every key a row of ``row_type`` may use, with a thumbnail path."""
    if row_type not in _ALLOWED:
        raise ValueError(f"Unknown image row type {row_type!r}")
    out: list[dict] = []
    for kind in _ALLOWED[row_type]:
        for key in _keys(kind):
            out.append({
                "key": key,
                "library": kind,
                "thumbnail": f"assets/{_DIRS[kind]}/{key}-480.webp",
            })
    return out


def validate_key(row_type: str, key: str | None) -> str | None:
    """Return the key if it names shipped art for this row type, else 422.

    ``None``/blank clears the image, which the customer pages already handle
    with their own fallback — the column is nullable for exactly that.
    """
    if key is None or not str(key).strip():
        return None
    key = str(key).strip()
    for kind in _ALLOWED[row_type]:
        if key in _keys(kind):
            return key
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        f"{key!r} is not a shipped {row_type} image. Choose one from the image library.",
    )
