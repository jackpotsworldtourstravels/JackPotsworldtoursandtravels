"""Intentional worst-case leak DEMO — NOT part of the normal E2E suite.

This test deliberately FAILS so Playwright retains a trace, to demonstrate what a
failing authed spec would capture (a real bearer token in a request header +
localStorage). It is marked `leak`, not `e2e`, so the normal run (`-m e2e`, and the
default `-m "not leak"` from pytest.ini) never selects it and never reports its
intentional failure. Run it on purpose to regenerate a leaky trace:

    python -m pytest -m leak --browser=chromium

The sanitizer's removal of exactly this material is proved — without any failing
run — by qa/tests/test_sanitize_artifacts.py::test_artifact_leak_regression.
"""
import pytest

pytestmark = [pytest.mark.leak]


def test_builtin_page_with_bearer_then_fail(require_server, page, qa_base_url, role_tokens):
    tok = role_tokens["admin"]
    page.set_extra_http_headers({"Authorization": f"Bearer {tok}"})
    page.goto(qa_base_url + "/index.html", wait_until="domcontentloaded")
    page.evaluate("t => localStorage.setItem('jwt_access', t)", tok)
    page.wait_for_timeout(500)
    assert False, "intentional fail (leak demo; excluded from the normal suite)"
