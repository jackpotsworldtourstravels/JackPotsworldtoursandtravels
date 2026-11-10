"""ENFORCE_SANDBOX_ALLOWLIST: the sandbox rules on a NON-deployed host, by explicit opt-in.

The guard used to apply only when DEPLOYED=true, so a laptop running controlled HDFC UAT
through a tunnel had no allowlist at all. The flag is off by default (the existing
"local development is not affected" tests still pass unchanged); with it on, a local host
behaves like a deployed one for HDFC checkout: it needs ALLOW_SANDBOX_PAYMENTS=true, a
non-empty SANDBOX_PAYMENT_CUSTOMER_IDS and a recognised UAT host, and only listed
customers may open a checkout. Verification paths (return, webhook, sweep) stay ungated.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import payments as P
from app.services.payments import sandbox_guard as G
from app.services.payments.sandbox_guard import SandboxPaymentsBlocked
from tests.test_hdfc_production import (  # noqa: F401  (fixture used by name)
    _fresh_provider_cache,
    _live_settings,
    _set,
    _uat_settings,
)


def _local(monkeypatch, **over):
    _uat_settings(monkeypatch)                       # deployed=False, UAT host
    _set(monkeypatch, enforce_sandbox_allowlist=True, allow_sandbox_payments=False,
         sandbox_payment_customer_ids="")
    if over:
        _set(monkeypatch, **over)


def _person(customer_id):
    return SimpleNamespace(customer_id=customer_id)


def test_the_flag_defaults_to_off():
    from app.config import Settings
    assert Settings.model_fields["enforce_sandbox_allowlist"].default is False


def test_without_the_flag_a_local_host_is_unrestricted(monkeypatch):
    _uat_settings(monkeypatch)
    assert G.restricted("hdfc") is False


def test_with_the_flag_a_local_hdfc_host_is_restricted(monkeypatch):
    _local(monkeypatch)
    assert G.restricted("hdfc") is True
    assert G.restricted("razorpay") is False         # only HDFC is judged here


def test_flag_alone_opens_nothing(monkeypatch):
    _local(monkeypatch)
    with pytest.raises(SandboxPaymentsBlocked):
        P.get_provider()


def test_flag_and_switch_but_empty_list_allows_nobody(monkeypatch):
    _local(monkeypatch, allow_sandbox_payments=True)
    with pytest.raises(SandboxPaymentsBlocked):
        P.get_provider()


def test_listed_customer_may_open_and_others_may_not(monkeypatch):
    _local(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids="1")
    provider = P.get_provider()
    assert provider.name == "hdfc"
    P.require_customer_access(provider, _person(1))
    for outsider in (_person(2), _person(None), None, _person("1"), _person(True)):
        with pytest.raises(SandboxPaymentsBlocked):
            P.require_customer_access(provider, outsider)
    assert P.available_for_customer(None, _person(2)) is None
    assert P.available_for_customer(None, _person(1)) is provider


def test_a_malformed_list_can_only_shrink_it(monkeypatch):
    _local(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids=" 1 ;x, 2e0,-3, ")
    assert G.allowlist() == frozenset({1})


def test_an_unrecognised_gateway_host_is_refused_even_with_both_controls(monkeypatch):
    _local(monkeypatch, allow_sandbox_payments=True, sandbox_payment_customer_ids="1",
           hdfc_sg_base_url="https://smartgateway.hdfcuat.bank.in.evil.example")
    with pytest.raises(SandboxPaymentsBlocked):
        P.get_provider()


def test_verification_is_never_gated(monkeypatch):
    _local(monkeypatch)                              # closed: no switch, no list
    assert P.get_hdfc_provider().name == "hdfc"      # return / webhook / sweep resolve by name


def test_approved_production_is_not_restricted_by_the_flag(monkeypatch):
    _live_settings(monkeypatch, allow_sandbox_payments=False, sandbox_payment_customer_ids="")
    _set(monkeypatch, enforce_sandbox_allowlist=True)
    assert G.restricted("hdfc") is False
