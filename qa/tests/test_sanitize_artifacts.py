"""Unit + regression tests for qa/scripts/sanitize_artifacts.py (Stage 4B.1).

Offline, synthetic-only. No browser, no server, no DB, no network. Run with the
project's normal test runner:

    python -m pytest qa/tests

Covers (A) sanitizer robustness across every input shape a Playwright artifact can
hold, and (B) an end-to-end artifact-leak regression: build throwaway trace/JUnit/
log artifacts stuffed with SYNTHETIC secrets, run the sanitizer, and prove nothing
survives and the trace stays a valid, viewer-usable ZIP.

All credentials/tokens here are fabricated for the test and are not real.
"""
import importlib.util
import io
import json
import zipfile
from pathlib import Path

import pytest

SAN_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sanitize_artifacts.py"

# A synthetic JWT (three base64url segments) — matches the JWT shape, not a real token.
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwicm9sZSI6ImFkbWluIn0.sig_abcDEF123_zz"


def load(extra="", drop_raster=""):
    """Import a FRESH copy of the module so its env-derived globals reset per test."""
    import os
    os.environ["SANITIZE_EXTRA_SECRETS"] = extra
    if drop_raster:
        os.environ["SANITIZE_DROP_RASTER"] = drop_raster
    else:
        os.environ.pop("SANITIZE_DROP_RASTER", None)
    spec = importlib.util.spec_from_file_location("san_mod", SAN_PATH)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m._EXTRA_SECRETS = m._load_extra_secrets()
    return m


S = load()


def clean(text, extra=""):
    m = load(extra) if extra else S
    out = m._redact(text)
    assert not m._has_live_secret(out), f"residual after redact: {out!r}"
    return out


def _mkzip(path, members):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
    path.write_bytes(buf.getvalue())


# ===========================================================================
# A. Sanitizer robustness
# ===========================================================================

# 1. URL-encoded JWTs and credentials
def test_plain_jwt():
    assert JWT not in clean(f"Authorization: Bearer {JWT}")

def test_url_encoded_jwt_dots():
    enc = JWT.replace(".", "%2E")
    assert "eyJ" not in clean(f"redirect?x={enc}")

def test_url_encoded_credential():
    m = load("Aurora@2026")
    out = m._redact("cb?u=a&password=Aurora%402026")
    assert "Aurora%402026" not in out and not m._has_live_secret(out)

# 2. Escaped JSON strings
def test_escaped_json_key_value():
    body = '{\\"access_token\\": \\"' + JWT + '\\", \\"password\\": \\"Hunter2xyz\\"}'
    out = clean(body)
    assert JWT not in out and "Hunter2xyz" not in out  # token via JWT, pwd via key

# 3. Nested JSON and HTML
def test_nested_json():
    body = '{"data":{"session":{"access_token":"' + JWT + '","nested":{"refresh_token":"' + JWT + '"}}}}'
    assert "eyJ" not in clean(body)

def test_html_attribute_and_text():
    html = f'<input name="jwt" value="{JWT}"><script>var t="{JWT}";</script>'
    assert JWT not in clean(html)

# 4. Query-string tokens (opaque, non-JWT)
def test_query_string_opaque_token():
    out = clean("GET /cb?code=OPAQUEcode1234567&state=xyz HTTP/1.1")
    assert "OPAQUEcode1234567" not in out

def test_query_string_numeric_otp():
    out = clean("/verify?otp=482913&ok=1")
    assert "482913" not in out

# 5. Case variations of Authorization and Bearer
@pytest.mark.parametrize("hdr", [
    f"Authorization: Bearer {JWT}",
    f"authorization: bearer {JWT}",
    f"AUTHORIZATION: BEARER {JWT}",
    f'"authorization":"Bearer {JWT}"',
    f"Bearer%20{JWT}",
])
def test_bearer_case_variations(hdr):
    assert JWT not in clean(hdr)

def test_opaque_bearer_non_jwt():
    assert "OPAQUEtoken123456" not in clean("Authorization: bearer OPAQUEtoken123456")

# 6. Multiple token formats
def test_numeric_otp_json():
    assert "482913" not in clean('{"dev_otp": 482913, "status": "ok"}')

def test_status_code_200_not_eaten():
    # a plain HTTP status under "status" must survive (no over-redaction of debug data)
    out = clean('{"status": 200, "url": "/api/health"}')
    assert '"status": 200' in out

def test_two_segment_jwt_fragment():
    # pytest truncates a long token in a traceback to header.partial-payload — scrub it too
    frag = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0IiwidHlw"
    assert "eyJ" not in clean(f"role_tokens = {{'admin': '{frag}...Fxk'}}")

# 7. Malformed / partial ZIP -> deleted (fail closed)
def test_malformed_zip_removed(tmp_path):
    bad = tmp_path / "trace.zip"
    bad.write_bytes(b"PK\x03\x04 truncated garbage not a real zip")
    rc = S.main(["prog", str(tmp_path)])
    assert not bad.exists()          # removed, never shipped
    assert rc in (0, 1)              # handled (removed during scrub -> 0; or flagged -> 1)

# 8. Unexpected text & binary ZIP members
def test_zip_unknown_ext_text_member_scrubbed(tmp_path):
    z = tmp_path / "trace.zip"
    _mkzip(z, {"weird_member_no_ext": f"token {JWT}".encode(),
               "frame.jpeg": b"\xff\xd8\xff\xe0\x00\x10JFIF" + bytes(300)})
    rc = S.main(["prog", str(tmp_path)])
    assert rc == 0 and z.exists()
    with zipfile.ZipFile(z) as zz:
        assert JWT.encode() not in zz.read("weird_member_no_ext")   # text sniffed+scrubbed
        assert zz.read("frame.jpeg").startswith(b"\xff\xd8\xff\xe0")  # binary untouched

def test_zip_binary_member_with_jwt_bytes_preserved(tmp_path):
    # a real binary (has NUL) is never scrubbed even if JWT-looking bytes appear
    z = tmp_path / "trace.zip"
    payload = b"\x00\x01" + JWT.encode() + b"\x00PNGDATA"
    _mkzip(z, {"img.png": payload})
    S.main(["prog", str(tmp_path)])
    with zipfile.ZipFile(z) as zz:
        assert zz.read("img.png") == payload

# 9. Error handling / log output
def test_missing_path_is_skipped(capsys):
    rc = S.main(["prog", "does/not/exist/anywhere"])
    assert rc == 0
    assert "skip (absent)" in capsys.readouterr().out

def test_no_args_usage():
    assert S.main(["prog"]) == 64

# Opt-in raster drop: screenshots + screencast frames excluded, trace still opens
def test_drop_raster_mode(tmp_path):
    z = tmp_path / "trace.zip"
    _mkzip(z, {"trace.trace": b'{"type":"frame"}',
               "screencast/f1.jpeg": b"\xff\xd8\xff\xe0" + bytes(300),
               "resources/page.html": b"<html>ok</html>"})
    png = tmp_path / "test-failed-1.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(300))
    m = load(drop_raster="1")
    assert m.main(["prog", str(tmp_path)]) == 0
    assert not png.exists()                       # standalone screenshot dropped
    with zipfile.ZipFile(z) as zz:
        names = zz.namelist()
    assert not any(n.endswith(".jpeg") for n in names)   # screencast frames dropped
    assert "trace.trace" in names and "resources/page.html" in names  # trace still usable

def test_drop_raster_off_by_default(tmp_path):
    z = tmp_path / "trace.zip"
    _mkzip(z, {"screencast/f1.jpeg": b"\xff\xd8\xff\xe0" + bytes(300), "trace.trace": b"{}"})
    assert load().main(["prog", str(tmp_path)]) == 0
    with zipfile.ZipFile(z) as zz:
        assert any(n.endswith(".jpeg") for n in zz.namelist())   # kept by default

# Fail-closed gate: if a secret survives scrub, the file is deleted and exit != 0.
# Simulate a scrub GAP by no-op'ing the scrub path only — verification (which uses
# the shared _redact oracle) must still catch the residual, delete it, and fail.
def test_gate_deletes_residual_and_fails(tmp_path, monkeypatch):
    m = load()
    monkeypatch.setattr(m, "_scrub_text_file", lambda p: None)  # scrub does nothing
    bad = tmp_path / "results.xml"
    bad.write_text(f"<x>{JWT}</x>", encoding="utf-8")
    assert m.main(["prog", str(tmp_path)]) == 1
    assert not bad.exists()


# ===========================================================================
# B. Dedicated artifact-leak regression (synthetic secrets only)
# ===========================================================================
SYN_ACCESS = ("eyJzeW4iOiJhY2Nlc3MifQ.eyJzdWIiOiJTWU5USEVUSUMiLCJyb2xlIjoiYWRtaW4ifQ"
              ".c2lnX1NZTlRIRVRJQ19ETy1OT1QtVVNF")
SYN_REFRESH = "eyJzeW4iOiJyZWZyZXNoIn0.eyJzdWIiOiJTWU5USEVUSUMifQ.cmVmX3NpZ19TWU5USEVUSUM"
SYN_PWD = "Synthetic#Pwd#9999"
SYN_OTP = "135790"
ALL_SECRETS = (SYN_ACCESS, SYN_REFRESH, SYN_PWD, SYN_OTP)


def _build_fake_trace(z: Path):
    """A trace.zip shaped like a real Playwright trace, carrying synthetic secrets."""
    net = json.dumps({
        "type": "resource-snapshot",
        "snapshot": {"request": {"method": "GET", "url": "/api/me",
                                 "headers": [{"name": "Authorization",
                                              "value": f"Bearer {SYN_ACCESS}"}]}},
    })
    trace_lines = "\n".join([
        json.dumps({"type": "context-options", "browserName": "chromium"}),
        json.dumps({"type": "action", "apiName": "page.evaluate",
                    "params": {"expression": f"localStorage.setItem('jwt_access','{SYN_ACCESS}')"}}),
        json.dumps({"type": "frame-snapshot", "snapshot": {"html": f"<meta data-jwt='{SYN_ACCESS}'>"}}),
    ])
    login = json.dumps({"access_token": SYN_ACCESS, "refresh_token": SYN_REFRESH, "dev_otp": SYN_OTP})
    req = json.dumps({"email": "qa.user@example.com", "password": SYN_PWD})
    _mkzip(z, {
        "trace.trace": trace_lines.encode(),
        "trace.network": net.encode(),
        "trace.stacks": b"{}",
        "resources/login.json": login.encode(),
        "resources/req.json": req.encode(),
        "resources/snapshot.html": f"<html><body>{SYN_ACCESS}</body></html>".encode(),
        "screencast/page-1.jpeg": b"\xff\xd8\xff\xe0" + bytes(400),
    })


def _text_members_of_zip(z: Path):
    out = {}
    with zipfile.ZipFile(z) as zz:
        for info in zz.infolist():
            data = zz.read(info.filename)
            if not info.filename.lower().endswith((".jpeg", ".jpg", ".png", ".webm")):
                try:
                    out[info.filename] = data.decode("utf-8")
                except UnicodeDecodeError:
                    pass
    return out


def test_artifact_leak_regression(tmp_path):
    """Full flow: build artifacts with synthetic secrets -> sanitize -> prove clean
    AND prove the trace stays a valid, viewer-usable ZIP."""
    artifacts = tmp_path / "artifacts" / "some-failed-test-chromium"
    artifacts.mkdir(parents=True)
    trace = artifacts / "trace.zip"
    _build_fake_trace(trace)
    (artifacts / "test-failed-1.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(400))
    results = tmp_path / "results.xml"
    results.write_text(
        f'<testsuite><testcase><failure>role_tokens={{"admin":"{SYN_ACCESS}"}} '
        f'GET /verify?otp={SYN_OTP}</failure></testcase></testsuite>', encoding="utf-8")
    server_log = tmp_path / "server.log"
    server_log.write_text(f"POST /api/auth/login Authorization: Bearer {SYN_ACCESS}\n"
                          f"seeded password={SYN_PWD}\n", encoding="utf-8")

    # access + refresh are JWTs (caught generically); password + numeric OTP are passed
    # as known values, exactly as the CI workflow passes its dev-seed credentials.
    m = load(extra=f"{SYN_PWD},{SYN_OTP}")
    rc = m.main(["prog", str(tmp_path / "artifacts"), str(results), str(server_log)])
    assert rc == 0, "sanitizer must succeed and verify clean"

    # (1) No synthetic secret survives in ANY text artifact.
    haystacks = [results.read_text(encoding="utf-8"), server_log.read_text(encoding="utf-8")]
    haystacks += list(_text_members_of_zip(trace).values())
    blob = "\n".join(haystacks)
    for secret in ALL_SECRETS:
        assert secret not in blob, f"LEAK: {secret!r} survived sanitization"
    # the structural JWT shape is gone too (even a truncated fragment)
    assert "eyJ" not in blob or "[REDACTED" in blob
    assert not m._has_live_secret(blob)

    # (2) The sanitized trace is a VALID ZIP with viewer-required structure intact.
    with zipfile.ZipFile(trace) as zz:
        assert zz.testzip() is None                 # not corrupt
        names = zz.namelist()
        assert "trace.trace" in names               # action timeline (viewer core)
        assert "trace.network" in names             # network panel
        assert any(n.startswith("resources/") for n in names)   # snapshots/bodies
        assert any(n.startswith("screencast/") for n in names)  # filmstrip (kept by default)
        # trace.trace / trace.network remain parseable NDJSON
        for member in ("trace.trace", "trace.network"):
            for line in zz.read(member).decode("utf-8").splitlines():
                if line.strip():
                    json.loads(line)                # raises if the rewrite broke JSON
