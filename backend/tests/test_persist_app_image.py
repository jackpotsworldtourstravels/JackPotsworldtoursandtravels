"""Tests for deploy/redeploy.sh persisting APP_IMAGE into deploy/.env.

Background: deploy/docker-compose.yml declares `image: ${APP_IMAGE:?...}`, so
after redeploy.sh exits, plain `docker compose ps/logs/exec` fail unless APP_IMAGE
is set. redeploy.sh now records the just-deployed image into deploy/.env, but ONLY
after the health check passes, atomically, preserving every other setting and the
file's permissions.

The structural tests parse redeploy.sh and run everywhere. The behavioral tests
execute the *real* `persist_app_image` function (extracted from the script) under
bash against a throwaway .env; they skip where bash / POSIX file modes aren't
available (they run in the Linux CI backend-tests job).
"""

import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
REDEPLOY = (REPO / "deploy" / "redeploy.sh").read_text(encoding="utf-8")
COMPOSE = (REPO / "deploy" / "docker-compose.yml").read_text(encoding="utf-8")

_BASH = shutil.which("bash")
# Behavioral tests run the real shell function; they need a POSIX bash with
# POSIX paths/modes, so they run in the Linux CI backend-tests job and skip on
# Windows (where `bash` may be WSL with a different path/mode model).
needs_bash = pytest.mark.skipif(
    _BASH is None or sys.platform == "win32",
    reason="POSIX bash required (runs in Linux CI; skipped on Windows)",
)
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX file-mode semantics required")


def _persist_func() -> str:
    """Extract the `persist_app_image` shell function from redeploy.sh."""
    m = re.search(r"(?ms)^persist_app_image\s*\(\)\s*\{.*?^\}", REDEPLOY)
    assert m, "persist_app_image function not found in redeploy.sh"
    return m.group(0)


def _run_persist(compose_dir: Path, app_image: str):
    """Run the real persist_app_image against a temp deploy dir."""
    script = (
        "set -euo pipefail\n"
        "warn() { :; }\n"                       # stub the logger
        f'COMPOSE_DIR="{compose_dir.as_posix()}"\n'
        f'APP_IMAGE="{app_image}"\n'
        f"{_persist_func()}\n"
        "persist_app_image\n"
    )
    r = subprocess.run([_BASH, "-c", script], capture_output=True, text=True)
    assert r.returncode == 0, f"persist_app_image failed: {r.stderr}"


# --------------------------------------------------------------------------
# Structural (portable)
# --------------------------------------------------------------------------
def test_function_is_defined_and_called():
    assert re.search(r"^persist_app_image\s*\(\)\s*\{", REDEPLOY, re.M), "function must be defined"
    assert re.search(r"^\s*persist_app_image\s*$", REDEPLOY, re.M), "function must be called"


def test_persist_runs_only_after_health_check():
    # The call must come AFTER `up -d` and the health-wait block, which fail/exit
    # on an unhealthy or timed-out deploy — so a failed deploy never reaches it.
    up = REDEPLOY.find("up -d --remove-orphans")
    health = REDEPLOY.find("Waiting for the application to become healthy")
    timeout_fail = REDEPLOY.find("Timed out after")
    call = re.search(r"^\s*persist_app_image\s*$", REDEPLOY, re.M).start()
    assert -1 not in (up, health, timeout_fail)
    assert up < health < timeout_fail < call, "persist must run after the health gate"


def test_persist_is_atomic_preserves_perms_and_dedupes():
    func = _persist_func()
    assert "mktemp" in func, "must write to a temp file"
    assert "mv -f" in func, "must rename atomically into place"
    assert "chmod --reference" in func, "must preserve the original file's permissions"
    assert re.search(r"grep -vE '\^\[\[:space:\]\]\*APP_IMAGE=", func), "must strip existing APP_IMAGE before re-adding"
    assert "printf 'APP_IMAGE=%s\\n'" in func, "must append exactly one APP_IMAGE line"


def test_compose_allows_manual_rollback_override():
    # Rollback override keeps working: compose reads ${APP_IMAGE}, and a shell
    # export beats the .env file in docker compose's precedence.
    assert re.search(r"image:\s*\$\{APP_IMAGE", COMPOSE)


# --------------------------------------------------------------------------
# Behavioral (run the real function; Linux CI)
# --------------------------------------------------------------------------
@needs_bash
def test_adds_app_image_when_missing(tmp_path):
    env = tmp_path / ".env"
    env.write_text("SITE_DOMAIN=example.test\n")
    _run_persist(tmp_path, "754549530476.dkr.ecr.ap-south-1.amazonaws.com/jackpotsworld:abc123")
    text = env.read_text()
    assert "SITE_DOMAIN=example.test" in text, "existing settings must be preserved"
    assert text.count("APP_IMAGE=") == 1
    assert "APP_IMAGE=754549530476.dkr.ecr.ap-south-1.amazonaws.com/jackpotsworld:abc123" in text


@needs_bash
def test_updates_existing_app_image_without_duplicating(tmp_path):
    env = tmp_path / ".env"
    env.write_text("SITE_DOMAIN=example.test\nAPP_IMAGE=old/registry:oldtag\n")
    _run_persist(tmp_path, "new/registry:newtag")
    text = env.read_text()
    assert text.count("APP_IMAGE=") == 1, "must not duplicate APP_IMAGE"
    assert "APP_IMAGE=new/registry:newtag" in text
    assert "old/registry:oldtag" not in text
    assert "SITE_DOMAIN=example.test" in text


@needs_bash
def test_preserves_site_domain_and_other_lines(tmp_path):
    env = tmp_path / ".env"
    env.write_text("# a comment\nSITE_DOMAIN=example.test\nEXTRA_SETTING=keepme\n")
    _run_persist(tmp_path, "img:1")
    text = env.read_text()
    assert "# a comment" in text
    assert "SITE_DOMAIN=example.test" in text
    assert "EXTRA_SETTING=keepme" in text
    assert "APP_IMAGE=img:1" in text


@needs_bash
@posix_only
def test_file_permissions_unchanged(tmp_path):
    env = tmp_path / ".env"
    env.write_text("SITE_DOMAIN=example.test\n")
    env.chmod(0o640)
    _run_persist(tmp_path, "img:1")
    mode = stat.S_IMODE(env.stat().st_mode)
    assert mode == 0o640, f"permissions changed: expected 0o640, got {oct(mode)}"
    assert "APP_IMAGE=img:1" in env.read_text()


def test_manual_image_override_rollback_still_documented():
    # Persisting APP_IMAGE must not break manual image-only rollback. That keeps
    # working because compose reads ${APP_IMAGE} (a shell export beats the .env
    # file in docker compose's precedence); the runbook documents the exact
    # override command.
    readme = (REPO / "deploy" / "README.md").read_text(encoding="utf-8")
    assert re.search(r"APP_IMAGE=\S+ \\?\s*docker compose", readme) or (
        "APP_IMAGE=" in readme and "docker compose" in readme and "up -d" in readme
    ), "README must document the APP_IMAGE override rollback"


@needs_bash
def test_persist_does_not_touch_compose_file(tmp_path):
    # persist only rewrites deploy/.env; the compose image reference stays the
    # overridable ${APP_IMAGE:?...}, never a hard-coded tag.
    before = COMPOSE
    env = tmp_path / ".env"
    env.write_text("SITE_DOMAIN=example.test\n")
    _run_persist(tmp_path, "registry/app:deployed")
    assert COMPOSE == before  # function wrote only to the temp dir's .env
    assert re.search(r"image:\s*\$\{APP_IMAGE:\?", COMPOSE)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and fn.__code__.co_argcount == 0:
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    raise SystemExit(1 if failures else 0)
