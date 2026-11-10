"""SANDBOX_ALLOW_ALL_CUSTOMERS: the explicit, temporary "any signed-in customer" sandbox opt-in.

Default OFF. It needs ALLOW_SANDBOX_PAYMENTS=true AND a recognised HDFC UAT host, and it can never
apply to production or an unknown gateway. Anonymous requests and non-integer ids are still refused.
A sandbox takes no money but confirms the booking, so this is for supervised testing only.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import payments as P
from app.services.payments import hdfc_readiness, sandbox_guard as G
from app.services.payments.sandbox_guard import SandboxPaymentsBlocked
from tests.test_hdfc_production import (  # noqa: F401  (fixture used by name)
    _fresh_provider_cache,
    _live_settings,
    _set,
    _uat_settings,
)


def _deployed_uat(monkeypatch, **over):
    _uat_settings(monkeypatch)
    _set(monkeypatch, deployed=True, allow_sandbox_payments=True, sandbox_payment_customer_ids="",
         sandbox_allow_all_customers=False)
    if over:
        _set(monkeypatch, **over)


def _person(customer_id):
    return SimpleNamespace(customer_id=customer_id)


def test_the_opt_in_defaults_to_off():
    from app.config import Settings
    assert Settings.model_fields["sandbox_allow_all_customers"].default is False


def test_without_the_opt_in_an_empty_list_still_allows_nobody(monkeypatch):
    _deployed_uat(monkeypatch)
    assert G.allow_all_customers() is False
    with pytest.raises(SandboxPaymentsBlocked):
        P.get_provider()


def test_the_opt_in_without_the_sandbox_switch_does_nothing(monkeypatch):
    _deployed_uat(monkeypatch, allow_sandbox_payments=False, sandbox_allow_all_customers=True)
    assert G.allow_all_customers() is False
    with pytest.raises(SandboxPaymentsBlocked):
        P.get_provider()


def test_with_the_opt_in_any_signed_in_customer_may_open_a_checkout(monkeypatch):
    _deployed_uat(monkeypatch, sandbox_allow_all_customers=True)
    assert G.allow_all_customers() is True
    provider = P.get_provider()
    assert provider.name == "hdfc"
    for cid in (1, 56, 60, 61, 99999):
        P.require_customer_access(provider, _person(cid))


def test_the_opt_in_still_refuses_anonymous_and_malformed_ids(monkeypatch):
    _deployed_uat(monkeypatch, sandbox_allow_all_customers=True)
    provider = P.get_provider()
    for who in (None, _person(None), _person("1"), _person(True), SimpleNamespace()):
        with pytest.raises(SandboxPaymentsBlocked):
            P.require_customer_access(provider, who)
    assert P.available_for_customer(None, None) is None


def test_the_opt_in_cannot_apply_to_an_unrecognised_gateway_host(monkeypatch):
    _deployed_uat(monkeypatch, sandbox_allow_all_customers=True,
                  hdfc_sg_base_url="https://smartgateway.hdfcuat.bank.in.evil.example")
    assert G.allow_all_customers() is False
    with pytest.raises(SandboxPaymentsBlocked):
        P.get_provider()


def test_the_opt_in_is_meaningless_on_the_production_host(monkeypatch):
    _live_settings(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids="")
    _set(monkeypatch, sandbox_allow_all_customers=True)
    assert G.allow_all_customers() is False            # not a UAT host


def test_the_allowlist_still_works_when_the_opt_in_is_off(monkeypatch):
    _deployed_uat(monkeypatch, sandbox_payment_customer_ids="1,56,60")
    provider = P.get_provider()
    P.require_customer_access(provider, _person(56))
    with pytest.raises(SandboxPaymentsBlocked):
        P.require_customer_access(provider, _person(61))


def test_readiness_flags_the_opt_in_as_a_warning_not_a_pass(monkeypatch):
    _deployed_uat(monkeypatch, sandbox_allow_all_customers=True)
    checks = {c.name: c for c in hdfc_readiness.evaluate()}
    c = checks["SANDBOX_PAYMENTS"]
    assert c.level == hdfc_readiness.WARN and "ANY signed-in customer" in c.detail
