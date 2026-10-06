#!/usr/bin/env python3
"""Keep every `?v=` asset tag in the HTML equal to a hash of the file it names.

WHY THIS EXISTS
  The server marks any asset URL that carries a query string as immutable for a
  year (backend/app/main.py, _apply_cache_policy) and serves HTML with no-cache.
  That is the right split - but it only works if the tag CHANGES whenever the
  file does. The tags used to be hand-written (`?v=20261002rc1`), so a file could
  change without its tag, and a browser that had the old URL kept running the
  old script for as long as the tab lived. Pages also drifted: the same file
  carried different tags on different pages.

  Here the tag IS the content: the first 10 hex digits of the SHA-1 of the file
  with line endings normalised to LF (so a Windows and a Linux checkout agree).
  Change a byte and the tag changes on every page that loads it; change nothing
  and no page is touched.

USAGE
  python scripts/stamp_asset_versions.py            rewrite stale tags in place
  python scripts/stamp_asset_versions.py --check    exit 1 if any tag is stale
  python scripts/stamp_asset_versions.py --portals  also stamp the staff portals

  Run it after editing anything under frontend/assets, and in CI/deploy with
  --check. By default the staff portals (admin, manager, merchant, operations,
  super-admin ...) are left alone; their pages keep their own tags.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"

# Staff-portal trees. Not stamped unless --portals is given.
PORTAL_DIRS = {"admin", "manager", "merchant", "merchant-classic", "operations",
               "super-admin", "shared", "tests"}
# Staff/partner entrance pages that sit at the top level next to the B2C pages.
PORTAL_FILES = {"partner-login.html", "portal-login.html"}

# src="..."/href="..." pointing at a local .js/.css, with or without a ?v= tag
# (a reference with no tag is given one: untagged URLs only get a 1-hour cache).
REF = re.compile(
    r'''(?P<pre>(?:src|href)\s*=\s*["'])(?P<path>[^"'?#:]+\.(?:js|css))(?:\?v=(?P<tag>[A-Za-z0-9._-]+))?(?P<post>["'])''')


def digest(path: Path) -> str:
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha1(data).hexdigest()[:10]


def html_files(portals: bool):
    for p in sorted(FRONTEND.rglob("*.html")):
        rel = p.relative_to(FRONTEND).parts
        if not portals and (rel[0] in PORTAL_DIRS or rel[-1] in PORTAL_FILES):
            continue
        yield p


def resolve(page: Path, ref: str) -> Path | None:
    """Where the browser would find `ref` for `page` (site-absolute or relative)."""
    target = (FRONTEND / ref.lstrip("/")) if ref.startswith("/") else (page.parent / ref)
    try:
        target = target.resolve()
        target.relative_to(FRONTEND.resolve())
    except (OSError, ValueError):
        return None
    return target if target.is_file() else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="report stale tags, change nothing, exit 1 if any")
    ap.add_argument("--portals", action="store_true", help="also stamp the staff-portal pages")
    args = ap.parse_args()

    cache: dict[Path, str] = {}
    stale, missing, files_changed, refs = [], [], 0, 0

    for page in html_files(args.portals):
        text = page.read_text(encoding="utf-8")
        crlf = "\r\n" in text

        def swap(m: re.Match) -> str:
            nonlocal refs
            refs += 1
            if m["path"].startswith(("http", "//")):
                return m[0]
            target = resolve(page, m["path"])
            if target is None:
                missing.append(f"{page.relative_to(ROOT).as_posix()}: {m['path']}")
                return m[0]
            want = cache.setdefault(target, digest(target))
            if m["tag"] != want:
                stale.append(f"{page.relative_to(ROOT).as_posix()}: {m['path']}  {m['tag'] or '(none)'} -> {want}")
            return f"{m['pre']}{m['path']}?v={want}{m['post']}"

        new = REF.sub(swap, text)
        if new != text and not args.check:
            page.write_text(new, encoding="utf-8", newline="\r\n" if crlf else "\n")
            files_changed += 1

    print(f"{refs} local js/css references checked, {len(stale)} stale"
          + ("" if args.check else f", {files_changed} page(s) rewritten"))
    for s in stale[:40]:
        print("  stale  ", s)
    if len(stale) > 40:
        print(f"  ... and {len(stale) - 40} more")
    for s in missing:
        print("  MISSING", s)
    if args.check and (stale or missing):
        print("Run: python scripts/stamp_asset_versions.py", file=sys.stderr)
        return 1
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
