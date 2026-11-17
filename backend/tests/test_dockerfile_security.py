"""Regression checks for the Debian base-image security remediation.

The Dockerfile's system-package layer must refresh the Debian (Trixie / deb13)
base, enforce a minimum fixed `zlib1g` (DSA-6613-1 / CVE-2026-85091) as a
fail-closed build gate, and use only Debian's official repositories. Most tests
parse the Dockerfile; one behavioral test uses the real `dpkg --compare-versions`
to prove the gate rejects the pre-fix zlib and accepts the fixed one (runs in the
Linux CI backend-tests job, where `dpkg` exists; skipped elsewhere).
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DOCKERFILE = (REPO / "Dockerfile").read_text(encoding="utf-8")

# The DSA-6613-1 fixed version the build must enforce (CVE-2026-85091).
ZLIB_FIXED = "1:1.3.dfsg+really1.3.1-1+deb13u1"

needs_dpkg = pytest.mark.skipif(shutil.which("dpkg") is None, reason="dpkg required (Debian / Linux CI)")


def _noncomment() -> str:
    """Dockerfile with comment lines removed, so prose can't satisfy a test."""
    return "\n".join(l for l in DOCKERFILE.splitlines() if not l.lstrip().startswith("#"))


def test_apt_indexes_refreshed():
    assert "apt-get update" in _noncomment(), "the system layer must refresh APT indexes"


def test_installed_packages_upgraded():
    assert re.search(r"apt-get upgrade -y", _noncomment()), "must upgrade already-installed OS packages"


def test_zlib1g_explicitly_installed():
    assert re.search(r"apt-get install[^\n]*\bzlib1g\b", _noncomment()), \
        "zlib1g must be named in the apt-get install line"


def test_zlib_minimum_fixed_version_pinned():
    assert ZLIB_FIXED in _noncomment(), "the DSA-6613-1 fixed zlib version must be the enforced minimum"


def test_zlib_gate_compares_installed_against_fixed():
    assert re.search(r"dpkg --compare-versions[^\n]*\bge\b", _noncomment()), \
        "must compare the installed zlib against the fixed version with `ge`"


def test_security_gate_fails_closed():
    # A non-zero exit when the installed zlib is below the fix, so the build can
    # never silently pass with the vulnerable version.
    code = _noncomment()
    assert re.search(r"if\s+!\s+dpkg --compare-versions", code), "gate must branch on the comparison"
    assert re.search(r"exit\s+1", code), "gate must exit non-zero on a stale zlib"


def test_no_debian_unstable_repositories():
    code = _noncomment()  # ignore the comment that says 'no Sid/Forky'
    bad = re.findall(r"\b(sid|forky|unstable|experimental)\b", code, re.I)
    assert not bad, f"directives must not reference Debian unstable channels: {bad}"
    assert "sources.list" not in code, "must not add custom APT sources"


def test_apt_lists_cleaned():
    assert "rm -rf /var/lib/apt/lists/*" in _noncomment(), "APT lists must be removed to avoid cache bloat"


@needs_dpkg
def test_dpkg_gate_rejects_prefix_version_and_accepts_fixed():
    # Behavioral proof the gate direction is correct: the pre-DSA Trixie zlib
    # (without the +deb13u1 security suffix) does NOT satisfy `ge FIXED`, while
    # the fixed version does. This is exactly the comparison the Dockerfile runs.
    pre_fix = "1:1.3.dfsg+really1.3.1-1"  # Trixie zlib before the security update
    rejected = subprocess.run(["dpkg", "--compare-versions", pre_fix, "ge", ZLIB_FIXED])
    accepted = subprocess.run(["dpkg", "--compare-versions", ZLIB_FIXED, "ge", ZLIB_FIXED])
    assert rejected.returncode != 0, "pre-fix zlib must FAIL the >= gate"
    assert accepted.returncode == 0, "the fixed zlib must PASS the >= gate"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and fn.__code__.co_argcount == 0 and "dpkg" not in name:
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    raise SystemExit(1 if failures else 0)
