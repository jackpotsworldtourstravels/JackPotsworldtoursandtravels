#!/usr/bin/env python3
"""Strip authentication material from Playwright artifacts before CI upload.

Stage 4B.1 security hardening (artifact-only; no application code, no production
security settings, no change to the three ci.yml jobs).

Problem
-------
`qa/playwright/pytest.ini` retains a Playwright trace (and screenshots) on
failure. A trace bundles the full network log: `Authorization: Bearer <JWT>`
request headers, login/signup *request* bodies (passwords) and *response* bodies
(access/refresh tokens, the dev OTP), plus the localStorage snapshot the SPA uses
to hold `jwt_access` / `jpc_access`. Uploaded as a CI artifact, that trace exposes
live authentication tokens for the seeded QA accounts — and a disposable database
does NOT make an exposed, still-valid token safe.

What this does
--------------
Walks the given artifact roots and, IN PLACE:

  * ``trace.zip`` — rewrites every *text* member (detected by content sniffing,
    not just by extension) with auth material redacted; *binary* members
    (screencast ``*.jpeg``, ``*.png``, ``*.webm`` …) are copied through
    byte-for-byte, so the trace still opens in the Playwright trace viewer and
    keeps its DOM snapshots, action timeline, screencast frames and network
    *timing / URLs / status* — only the secret values go. A member that cannot be
    read, or a malformed/partial zip, is deleted (fail closed), never shipped.
  * ``results.xml`` (JUnit), ``server.log`` and any other text file — redacted.
  * any storage-state JSON (``*storage*state*.json``) — deleted outright (the suite
    writes none today; this is defence in depth so a future ``storage_state(path=…)``
    can never ship a token).

Redaction covers: JWTs (``.`` or ``%2E`` separated), ``Authorization: Bearer``
values (any case, raw or ``%20``-encoded), sensitive JSON fields (raw *and* one
level of ``\\"`` escaping; quoted or numeric), sensitive query-string params, and
exact known credential VALUES (``SANITIZE_EXTRA_SECRETS``, plus their percent- and
plus-encoded forms).

Then it VERIFIES the cleaned tree: a file is residual if re-redacting it would
still change it. It fails CLOSED — any residual file is deleted and the script
exits non-zero — so the upload step that runs afterwards can never publish a token.

Usage
-----
    python qa/scripts/sanitize_artifacts.py <path> [<path> ...]

Stdlib only. Safe to run when a path is missing (it is skipped).
"""
from __future__ import annotations

import io
import os
import re
import sys
import urllib.parse
import zipfile
from pathlib import Path

_REDACTED = "[REDACTED]"
_REDACTED_JWT = "[REDACTED_JWT]"

# Exact secret VALUES to redact verbatim everywhere (plus their URL-encoded forms).
# Populated from ``SANITIZE_EXTRA_SECRETS`` (comma-/newline-separated) so the
# workflow can scrub the known dev-seed credentials it injected — covering a value
# wherever it lands (a trace action param, a query string, a log line), not just a
# JSON body keyed by name. Sorted longest-first so a longer secret is replaced
# before any shorter substring of it.
_EXTRA_SECRETS: list[str] = []


def _expand(secret: str) -> set[str]:
    forms = {secret, urllib.parse.quote(secret, safe=""), urllib.parse.quote_plus(secret)}
    return {f for f in forms if len(f) >= 6}


def _load_extra_secrets() -> list[str]:
    raw = os.environ.get("SANITIZE_EXTRA_SECRETS", "")
    vals: set[str] = set()
    for chunk in raw.split("\n"):
        for v in chunk.split(","):
            v = v.strip()
            if len(v) >= 6:
                vals |= _expand(v)
    return sorted(vals, key=len, reverse=True)


# --- redaction patterns ----------------------------------------------------
# A JWT: three base64url segments, separated by '.' or its %2E url-encoding.
_SEP = r"(?:\.|%2[eE])"
_JWT = re.compile(r"eyJ[A-Za-z0-9_=-]{2,}" + _SEP + r"[A-Za-z0-9_=-]{2,}" + _SEP + r"[A-Za-z0-9_=-]{2,}")
# A JWT header.payload with no (or a truncated) signature — e.g. pytest's elided
# fixture repr "eyJhbGci….eyJzdWI…" in a JUnit traceback. Two consecutive base64url
# segments both starting `eyJ` are a JWT header+payload; redact them too.
_JWT2 = re.compile(r"eyJ[A-Za-z0-9_=-]{2,}" + _SEP + r"eyJ[A-Za-z0-9_=-]{2,}")
# Authorization: Bearer <token> — any case, raw or %20-separated, token may be
# opaque and/or percent-encoded.
_BEARER = re.compile(r"(?i)(bearer(?:\s|%20)+)[A-Za-z0-9._~+/=%-]{8,}")

_SENSITIVE_KEYS = (
    "access_token", "refresh_token", "id_token", "token", "secret",
    "password", "confirm_password", "current_password", "new_password",
    "dev_otp", "otp", "code", "challenge_token", "api_key", "apikey",
    "jwt_access", "jwt_refresh", "jpc_access", "jpc_refresh", "authorization",
)
_KEYS_RE = "|".join(map(re.escape, _SENSITIVE_KEYS))
# "key":"value"  — tolerating one level of backslash-escaped quotes (escaped JSON).
_KV_STR = re.compile(r'(?i)(\\?"(?:' + _KEYS_RE + r')\\?"\s*:\s*\\?")(?:\\.|[^"\\])*(\\?")')
# "key": 123456  — unquoted numeric values (e.g. a numeric OTP).
_KV_NUM = re.compile(r'(?i)(\\?"(?:otp|dev_otp|code|pin|password)\\?"\s*:\s*)(\d{4,})')
# sensitive query-string / form params: ?token=…  &dev_otp=…
_QS_KEYS = ("access_token", "refresh_token", "id_token", "token", "jwt",
            "dev_otp", "otp", "code", "password", "secret", "api_key", "apikey",
            "challenge_token", "authorization")
_QS = re.compile(r'(?i)([?&](?:' + "|".join(map(re.escape, _QS_KEYS)) + r')=)[^&#\s"\'\\]+')
# cookie / set-cookie header values.
_COOKIE = re.compile(r'(?i)(\\?"(?:set-)?cookie\\?"\s*:\s*\\?")(?:\\.|[^"\\])*(\\?")')

# Extensions we always treat as binary (never scrub, never corrupt).
_BINARY_EXT = (".jpeg", ".jpg", ".png", ".webm", ".webp", ".gif", ".avif",
               ".woff", ".woff2", ".ttf", ".otf", ".ico", ".mp4", ".mov",
               ".pdf", ".zip", ".gz", ".br", ".wasm", ".bin")

# Raster/video captures (standalone screenshots + the trace's screencast frames).
# Text sanitizing cannot touch pixels, so if the suite is ever pointed at NON-synthetic
# data (real customer PII, an on-screen OTP), set SANITIZE_DROP_RASTER=1 to exclude
# them. Default OFF: the CI env is isolated and fully synthetic (seeded dev staff +
# @example.com throwaway customers; tokens/OTPs are never rendered), so screenshots
# carry debugging value without exposing anything sensitive. Dropping them still
# leaves the trace openable (DOM snapshots remain; only the filmstrip goes).
_IMAGE_EXT = (".png", ".jpeg", ".jpg", ".webp", ".gif", ".avif", ".webm", ".mp4", ".mov")
_DROP_RASTER = False


def _redact(text: str) -> str:
    text = _KV_STR.sub(lambda m: m.group(1) + _REDACTED + m.group(2), text)
    text = _KV_NUM.sub(lambda m: m.group(1) + _REDACTED, text)
    text = _COOKIE.sub(lambda m: m.group(1) + _REDACTED + m.group(2), text)
    text = _QS.sub(lambda m: m.group(1) + _REDACTED, text)
    text = _JWT.sub(_REDACTED_JWT, text)
    text = _JWT2.sub(_REDACTED_JWT, text)
    text = _BEARER.sub(lambda m: m.group(1) + _REDACTED, text)
    for secret in _EXTRA_SECRETS:  # exact known values (longest first)
        if secret in text:
            text = text.replace(secret, _REDACTED)
    return text


def _has_live_secret(text: str) -> bool:
    """Residual check: anything redaction would still change is a live secret.

    Using ``_redact`` itself as the oracle means scrub and verify can never drift
    apart — a pattern added to one is automatically honoured by the other. Idempotent
    because the ``[REDACTED]`` sentinels match none of the patterns.
    """
    return _redact(text) != text


def _looks_text(data: bytes) -> bool:
    if b"\x00" in data[:16384]:
        return False
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def _member_is_text(name: str, data: bytes) -> bool:
    if name.lower().endswith(_BINARY_EXT):
        return False
    return _looks_text(data)


# --- trace.zip handling ----------------------------------------------------
def _scrub_zip(path: Path) -> None:
    """Rewrite the zip with text members redacted. Raises on a malformed zip so the
    caller can fail closed (delete it)."""
    with zipfile.ZipFile(path, "r") as zin:
        if zin.testzip() is not None:          # a corrupt member -> treat as malformed
            raise zipfile.BadZipFile("CRC check failed")
        members = []
        for info in zin.infolist():
            if _DROP_RASTER and info.filename.lower().endswith(_IMAGE_EXT):
                continue  # drop screencast frames / embedded images
            data = zin.read(info.filename)
            if _member_is_text(info.filename, data):
                data = _redact(data.decode("utf-8")).encode("utf-8")
            members.append((info, data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for info, data in members:
            zout.writestr(info, data)
    path.write_bytes(buf.getvalue())


def _zip_has_secret(path: Path) -> bool:
    """True if any readable text member still holds a secret. A zip that cannot be
    opened is reported as unsafe (caller fails closed)."""
    with zipfile.ZipFile(path, "r") as z:
        for info in z.infolist():
            data = z.read(info.filename)
            if _member_is_text(info.filename, data) and _has_live_secret(data.decode("utf-8")):
                return True
    return False


# --- disk file handling ----------------------------------------------------
def _scrub_text_file(path: Path) -> None:
    data = path.read_bytes()
    if not _member_is_text(path.name, data):
        return
    cleaned = _redact(data.decode("utf-8"))
    if cleaned != data.decode("utf-8"):
        path.write_text(cleaned, encoding="utf-8")


def _iter_files(root: Path):
    if root.is_file():
        yield root
    elif root.is_dir():
        yield from (p for p in root.rglob("*") if p.is_file())


_STORAGE_STATE = re.compile(r"(?i)storage[-_ ]?state.*\.json$")


def main(argv: list[str]) -> int:
    roots = [Path(a) for a in argv[1:]]
    if not roots:
        print("usage: sanitize_artifacts.py <path> [<path> ...]", file=sys.stderr)
        return 64

    global _EXTRA_SECRETS, _DROP_RASTER
    _EXTRA_SECRETS = _load_extra_secrets()
    _DROP_RASTER = os.environ.get("SANITIZE_DROP_RASTER", "").strip() in ("1", "true", "yes")
    if _EXTRA_SECRETS:
        print(f"sanitize: {len(_EXTRA_SECRETS)} known secret form(s) loaded for "
              f"literal redaction")
    if _DROP_RASTER:
        print("sanitize: SANITIZE_DROP_RASTER on — excluding screenshots/screencast frames")

    scrubbed_zips = scrubbed_text = deleted_state = removed_bad = dropped_img = 0
    for root in roots:
        if not root.exists():
            print(f"  skip (absent): {root}")
            continue
        for f in _iter_files(root):
            try:
                if _STORAGE_STATE.search(f.name.lower()):
                    f.unlink(missing_ok=True)
                    deleted_state += 1
                    print(f"  deleted storage-state: {f}")
                elif _DROP_RASTER and f.name.lower().endswith(_IMAGE_EXT):
                    f.unlink(missing_ok=True)
                    dropped_img += 1
                elif f.name.lower().endswith(".zip"):
                    try:
                        _scrub_zip(f)
                        scrubbed_zips += 1
                    except (zipfile.BadZipFile, OSError, EOFError) as exc:
                        f.unlink(missing_ok=True)   # unreadable -> cannot prove safe
                        removed_bad += 1
                        print(f"  removed unreadable zip (fail-closed): {f} [{exc}]",
                              file=sys.stderr)
                else:
                    _scrub_text_file(f)
                    scrubbed_text += 1
            except OSError as exc:
                print(f"  ERROR processing {f}: {exc}", file=sys.stderr)
                return 2  # cannot guarantee safety -> fail closed

    print(f"sanitize: scrubbed {scrubbed_zips} zip(s), {scrubbed_text} text file(s), "
          f"deleted {deleted_state} storage-state file(s), removed {removed_bad} bad zip(s), "
          f"dropped {dropped_img} raster file(s)")

    # --- fail-closed verification ------------------------------------------
    residual: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for f in _iter_files(root):
            try:
                if f.name.lower().endswith(".zip"):
                    if _zip_has_secret(f):
                        residual.append(f)
                else:
                    data = f.read_bytes()
                    if _member_is_text(f.name, data) and _has_live_secret(data.decode("utf-8")):
                        residual.append(f)
            except (OSError, zipfile.BadZipFile, EOFError):
                residual.append(f)  # unverifiable -> unsafe

    if residual:
        print("SECURITY GATE FAILED: residual secret(s) after scrub; deleting:",
              file=sys.stderr)
        for f in residual:
            print(f"  removed (fail-closed): {f}", file=sys.stderr)
            try:
                f.unlink(missing_ok=True)
            except OSError as exc:
                print(f"  COULD NOT DELETE {f}: {exc}", file=sys.stderr)
        return 1

    print("sanitize: verification passed — no JWT / Bearer / known-secret value remains")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
