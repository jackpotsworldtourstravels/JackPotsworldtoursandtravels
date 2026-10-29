"""The Razorpay and TrustBrick test-key guards, and HDFC's, working together.

Each guard has its own file (test_razorpay_test_key_guard.py,
test_trustbrick_test_key_guard.py, test_sandbox_payment_guard.py). This file proves
what only shows when they share one dispatcher: a pilot booking and an ordinary one
each judged on their OWN provider, the learned-key expiry with its single-flight
probe (including under concurrent requests), the three booking routes refusing with
nothing committed, and the boot-time warning.

Synthetic keys only; every provider call is a stub and nothing opens a socket.
"""

from __future__ import annotations

import logging
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app.config
from app import models_customer as m
from app.routers import customer_bookings as flight_routes
from app.routers import customer_hotel_bookings as hotel_routes
from app.routers import customer_package_bookings as package_routes
from app.services import payments as P
from app.services.payments import sandbox_guard
from app.services.payments import trustbrick_provider as tb
from tests.test_hdfc_production import _fresh_provider_cache, _set  # noqa: F401  (autouse fixture)
from tests.test_razorpay_test_key_guard import _razorpay
from tests.test_sandbox_guard_resume_and_hosts import resume_case  # noqa: F401  (fixture)
from tests.test_sandbox_payment_guard import NEUTRAL, _deployed_uat, _person
from tests.test_trustbrick_test_key_guard import (
    LIVE_KEY, TEST_KEY, FakeTrustBrick, _configure, _payment_count, _use_new_key,
)

PILOT = "JPB000777"
OTHER = "JPB000888"
_ROUTES = {"JPB": flight_routes.start_flight_checkout,
           "JPH": hotel_routes.start_hotel_checkout,
           "JPP": package_routes.start_package_checkout}


class Clock:
    """The adapter's clock, moved by hand so no test sleeps."""

    def __init__(self, monkeypatch, start=1000.0):
        self.t = start
        monkeypatch.setattr(tb, "_now", lambda: self.t)

    def advance(self, seconds):
        self.t += seconds


def _tb_provider():
    return P.get_trustbrick_provider()


#: What each route's ``get_owned`` eager-loads, beyond the tables resume_case builds.
_CHILD_TABLES = (m.CustomerBookingPassenger, m.CustomerBookingAddon,
                 m.CustomerHotelBookingRoom, m.CustomerHotelBookingGuest, m.CustomerHotelBookingAddon,
                 m.CustomerPackageBookingTraveller, m.CustomerPackageBookingAddon)


def _route(booking, db, customer, key="route-key-0001"):
    m.Base.metadata.create_all(db.get_bind(), tables=[t.__table__ for t in _CHILD_TABLES], checkfirst=True)
    fn = _ROUTES[booking.booking_ref[:3]]
    return fn(request=SimpleNamespace(), booking_ref=booking.booking_ref,
              payload=SimpleNamespace(idempotency_key=key), db=db, customer=customer)


# ---------------------------------------------------------------------------
# One dispatcher, each booking judged on ITS provider
# ---------------------------------------------------------------------------
def test_direct_razorpay_test_key_refuses_the_ordinary_booking_but_not_the_live_pilot(monkeypatch):
    _razorpay(monkeypatch, deployed=True)                       # default: Razorpay, TEST key
    _configure(monkeypatch, PILOT, key=LIVE_KEY, provider="razorpay")
    _set(monkeypatch, razorpay_key_id="rzp_test_SYNTHETICKEY01", razorpay_key_secret="s",
         razorpay_webhook_secret="w")

    pilot = P.get_provider_for_booking(PILOT)
    assert pilot.name == "trustbrick"
    P.require_customer_access(pilot, _person(1))                # live TrustBrick: allowed

    ordinary = P.get_provider_for_booking(OTHER)
    assert ordinary.name == "razorpay"
    with pytest.raises(P.SandboxPaymentsBlocked) as exc:
        P.require_customer_access(ordinary, _person(1))
    assert exc.value.customer_message == NEUTRAL
    assert "TRUSTBRICK" not in str(exc.value).upper()           # each refusal names its own provider


def test_live_razorpay_default_does_not_rescue_a_trustbrick_test_key(monkeypatch):
    _configure(monkeypatch, PILOT, key=TEST_KEY, provider="razorpay")
    _set(monkeypatch, razorpay_key_id="rzp_live_SYNTHETICKEY01", razorpay_key_secret="s",
         razorpay_webhook_secret="w")

    P.require_customer_access(P.get_provider_for_booking(OTHER), _person(1))     # Razorpay live: fine
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.require_customer_access(P.get_provider_for_booking(PILOT), _person(1))  # TrustBrick test: no


def test_an_unconfigured_pilot_falls_back_to_the_default_and_its_guard_still_applies(monkeypatch):
    _razorpay(monkeypatch, deployed=True)
    _set(monkeypatch, trustbrick_base_url=None, trustbrick_pilot_booking_refs=PILOT)

    fallback = P.get_provider_for_booking(PILOT)
    assert fallback.name == "razorpay"                           # fell back ...
    with pytest.raises(P.SandboxPaymentsBlocked):                # ... and is still refused
        P.require_customer_access(fallback, _person(1))


def test_hdfc_uat_default_is_unchanged_and_a_live_trustbrick_pilot_still_collects(monkeypatch):
    _deployed_uat(monkeypatch)                                   # the incident configuration
    _set(monkeypatch, trustbrick_base_url="https://tb.example.test", trustbrick_key_id="tb_key",
         trustbrick_secret="synthetic-tb-secret", trustbrick_callback_secret="synthetic-tb-callback-secret",
         trustbrick_publishable_key=LIVE_KEY, trustbrick_pilot_booking_refs=PILOT)

    P.require_customer_access(P.get_provider_for_booking(PILOT), _person(1))
    with pytest.raises(P.SandboxPaymentsBlocked):                # HDFC UAT on a deployed host: refused as before
        P.get_provider_for_booking(OTHER)


def test_neither_guard_applies_on_a_local_host(monkeypatch):
    _razorpay(monkeypatch, deployed=False)
    _configure(monkeypatch, PILOT, deployed=False, key=TEST_KEY, provider="razorpay")
    _set(monkeypatch, razorpay_key_id="rzp_test_SYNTHETICKEY01", razorpay_key_secret="s",
         razorpay_webhook_secret="w")

    for ref in (PILOT, OTHER):
        P.require_customer_access(P.get_provider_for_booking(ref), None)


# ---------------------------------------------------------------------------
# The booking routes: neutral 503, nothing committed, nothing left behind
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("learned_first", [False, True], ids=["configured-key", "reported-key"])
def test_each_booking_route_refuses_with_a_neutral_503_and_commits_nothing(
        monkeypatch, resume_case, learned_first):
    service, db, customer, booking, _key, _oid = resume_case    # flight, hotel and package
    _configure(monkeypatch, booking.booking_ref, key=None if learned_first else TEST_KEY)
    fake = FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)
    commits = []
    real_commit = db.commit
    monkeypatch.setattr(db, "commit", lambda: (commits.append(1), real_commit())[1])
    before = _payment_count(db)

    with pytest.raises(HTTPException) as exc:
        _route(booking, db, customer)

    assert exc.value.status_code == 503 and exc.value.detail == NEUTRAL
    assert commits == []                                         # the route commits only on success
    assert len(fake.calls) == (1 if learned_first else 0)        # layer 1 stops it before any call
    db.rollback()                                                # what get_db's close() does
    assert _payment_count(db) == before                          # the flushed claim row is gone


def test_the_refused_attempt_flushes_a_claim_row_that_only_the_missing_commit_discards(
        monkeypatch, resume_case):
    """Documents WHY layer 2 leaves nothing behind: start_checkout claims the key with a
    flushed pending row BEFORE calling the provider; the route never commits it."""
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=None)
    FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)
    before = _payment_count(db)

    with pytest.raises(P.SandboxPaymentsBlocked):
        _use_new_key(service, db, customer, booking)

    assert _payment_count(db) == before + 1                      # visible inside the open transaction ...
    db.rollback()
    assert _payment_count(db) == before                          # ... and gone once it is not committed


# ---------------------------------------------------------------------------
# The learned-key expiry and its single-flight probe
# ---------------------------------------------------------------------------
def _learn_a_test_key(monkeypatch, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=None)
    clock = Clock(monkeypatch)
    fake = FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)
    with pytest.raises(P.SandboxPaymentsBlocked):
        _use_new_key(service, db, customer, booking)
    db.rollback()
    assert len(fake.calls) == 1
    return service, db, customer, booking, clock, fake


def test_a_learned_test_key_blocks_until_the_ttl_and_the_config_hides_it(monkeypatch, resume_case):
    service, db, customer, booking, clock, fake = _learn_a_test_key(monkeypatch, resume_case)
    provider = _tb_provider()

    clock.advance(sandbox_guard.LEARNED_TEST_KEY_TTL_SECONDS - 1)
    assert provider.learned_test_key_state() == "fresh"
    assert P.available_for_customer(booking.booking_ref, customer) is None
    with pytest.raises(P.SandboxPaymentsBlocked):
        _use_new_key(service, db, customer, booking, key="fresh-key-0002")
    assert len(fake.calls) == 1                                  # still no second call to TrustBrick

    clock.advance(2)
    assert provider.learned_test_key_state() == "expired"
    assert P.available_for_customer(booking.booking_ref, customer) is provider


def test_after_expiry_one_probe_recovers_a_host_whose_trustbrick_went_live(monkeypatch, resume_case):
    service, db, customer, booking, clock, fake = _learn_a_test_key(monkeypatch, resume_case)
    clock.advance(sandbox_guard.LEARNED_TEST_KEY_TTL_SECONDS + 1)
    fake.reported_key = LIVE_KEY                                 # TrustBrick moved to live

    payment, session = _use_new_key(service, db, customer, booking, key="fresh-key-0003")

    assert session.publishable_key == LIVE_KEY and len(fake.calls) == 2
    assert _tb_provider().learned_test_key_state() is None       # the live key replaced it
    _use_new_key(service, db, customer, booking, key="fresh-key-0004")   # no probe needed any more
    assert len(fake.calls) == 3


def test_a_probe_that_still_sees_a_test_key_re_arms_the_block(monkeypatch, resume_case):
    service, db, customer, booking, clock, fake = _learn_a_test_key(monkeypatch, resume_case)
    clock.advance(sandbox_guard.LEARNED_TEST_KEY_TTL_SECONDS + 1)

    with pytest.raises(P.SandboxPaymentsBlocked):                # the probe: asks again, refused
        _use_new_key(service, db, customer, booking, key="fresh-key-0005")
    db.rollback()
    assert len(fake.calls) == 2
    assert _tb_provider().learned_test_key_state() == "fresh"

    with pytest.raises(P.SandboxPaymentsBlocked):                # the next one is stopped up front
        _use_new_key(service, db, customer, booking, key="fresh-key-0006")
    assert len(fake.calls) == 2


def test_the_probe_lease_lapses_so_a_dead_probe_cannot_wedge_the_host(monkeypatch, resume_case):
    service, db, customer, booking, clock, fake = _learn_a_test_key(monkeypatch, resume_case)
    provider = _tb_provider()
    clock.advance(sandbox_guard.LEARNED_TEST_KEY_TTL_SECONDS + 1)

    P.require_customer_access(provider, customer)                # claims the lease; the request then dies
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.require_customer_access(provider, customer)            # everyone else waits ...

    clock.advance(sandbox_guard.PROBE_LEASE_SECONDS + 1)
    P.require_customer_access(provider, customer)                # ... until the lease lapses


def test_only_one_of_many_concurrent_requests_probes(monkeypatch, resume_case):
    service, db, customer, booking, clock, fake = _learn_a_test_key(monkeypatch, resume_case)
    provider = _tb_provider()
    clock.advance(sandbox_guard.LEARNED_TEST_KEY_TTL_SECONDS + 1)

    workers = 24
    barrier = threading.Barrier(workers)
    outcomes: list[str] = []
    lock = threading.Lock()

    def request():
        barrier.wait()
        try:
            P.require_customer_access(provider, customer)
            result = "through"
        except P.SandboxPaymentsBlocked:
            result = "refused"
        with lock:
            outcomes.append(result)

    threads = [threading.Thread(target=request) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert outcomes.count("through") == 1 and outcomes.count("refused") == workers - 1


def test_the_predicate_and_the_public_config_never_claim_the_probe(monkeypatch, resume_case):
    service, db, customer, booking, clock, fake = _learn_a_test_key(monkeypatch, resume_case)
    provider = _tb_provider()
    clock.advance(sandbox_guard.LEARNED_TEST_KEY_TTL_SECONDS + 1)

    for _ in range(5):
        assert not sandbox_guard.trustbrick_test_key_blocked(provider)
        assert P.available_for_customer(booking.booking_ref, customer) is provider
    assert provider.try_claim_probe() is True                    # still unclaimed after all those reads


def test_a_configured_test_key_never_expires(monkeypatch, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=TEST_KEY)
    clock = Clock(monkeypatch)
    provider = _tb_provider()

    clock.advance(10 * 24 * 3600)
    assert provider.learned_test_key_state() == "fresh"
    with pytest.raises(P.SandboxPaymentsBlocked):
        P.require_customer_access(provider, customer)


def test_a_live_key_that_flips_to_test_is_caught_by_the_reply_and_then_blocks_up_front(
        monkeypatch, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=None)
    Clock(monkeypatch)
    fake = FakeTrustBrick(monkeypatch, reported_key=LIVE_KEY)
    _use_new_key(service, db, customer, booking, key="fresh-key-0007")            # live: collects
    assert len(fake.calls) == 1

    fake.reported_key = TEST_KEY                                                  # TrustBrick flips to test
    with pytest.raises(P.SandboxPaymentsBlocked):
        _use_new_key(service, db, customer, booking, key="fresh-key-0008")
    db.rollback()
    assert len(fake.calls) == 2
    with pytest.raises(P.SandboxPaymentsBlocked):
        _use_new_key(service, db, customer, booking, key="fresh-key-0009")
    assert len(fake.calls) == 2                                                   # blocked before any call


# ---------------------------------------------------------------------------
# Boot-time warning, independent of the default provider
# ---------------------------------------------------------------------------
def _boot_log(monkeypatch, caplog, **over):
    _configure(monkeypatch, PILOT, **over)
    with caplog.at_level(logging.ERROR):
        P.check_configuration_at_startup()
    return caplog.text


def test_startup_warns_about_a_configured_trustbrick_test_key_even_with_payments_off(monkeypatch, caplog):
    text = _boot_log(monkeypatch, caplog, key=TEST_KEY)         # PAYMENT_PROVIDER=none
    assert "TRUSTBRICK IS CONFIGURED WITH A RAZORPAY TEST KEY" in text
    assert TEST_KEY not in text and "synthetic-tb-secret" not in text


@pytest.mark.parametrize("over", [dict(key=LIVE_KEY), dict(key=None), dict(key=TEST_KEY, deployed=False)],
                         ids=["live-key", "no-key", "local-host"])
def test_startup_is_quiet_when_there_is_nothing_to_warn_about(monkeypatch, caplog, over):
    assert "TRUSTBRICK IS CONFIGURED" not in _boot_log(monkeypatch, caplog, **over)


def test_startup_is_quiet_when_trustbrick_is_not_configured(monkeypatch, caplog):
    _configure(monkeypatch, PILOT, key=TEST_KEY)
    _set(monkeypatch, trustbrick_base_url=None)
    with caplog.at_level(logging.ERROR):
        P.check_configuration_at_startup()
    assert "TRUSTBRICK IS CONFIGURED" not in caplog.text


# ---------------------------------------------------------------------------
# No credential ever reaches a customer or a log
# ---------------------------------------------------------------------------
def test_refusals_by_either_guard_leak_nothing(monkeypatch, caplog, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=TEST_KEY)
    FakeTrustBrick(monkeypatch, reported_key=TEST_KEY)
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(HTTPException) as exc:
            _route(booking, db, customer)
        _razorpay(monkeypatch, deployed=True)
        with pytest.raises(P.SandboxPaymentsBlocked):
            P.require_customer_access(P.get_provider(), _person(1))

    # What THE GUARDS say (their log lines and the customer's answer) names no key at all ...
    guard_log = "\n".join(r.getMessage() for r in caplog.records if r.name.endswith("sandbox_guard"))
    assert guard_log, "the guards must log an operator diagnostic"
    for key in (TEST_KEY, "rzp_test_SYNTHETICKEY01"):
        assert key not in guard_log and key not in str(exc.value.detail)
    # ... and no SECRET reaches any log line or the customer. (The adapters' own "ready" lines print the
    # PUBLISHABLE key id, which is public by design, and mask every secret as <set:N chars>.)
    everything = caplog.text + str(exc.value.detail)
    for secret in ("synthetic-tb-secret", "synthetic-tb-callback-secret", "synthetic-secret", "synthetic-webhook"):
        assert secret not in everything


# ---------------------------------------------------------------------------
# Review finding: an expired learned TEST key must not reach the browser when a reply has no key_id
# ---------------------------------------------------------------------------
def test_a_probe_whose_reply_has_no_key_id_never_hands_out_the_expired_test_key(monkeypatch, resume_case):
    service, db, customer, booking, clock, fake = _learn_a_test_key(monkeypatch, resume_case)
    provider = _tb_provider()
    clock.advance(sandbox_guard.LEARNED_TEST_KEY_TTL_SECONDS + 1)
    fake.reported_key = ""                                       # TrustBrick says nothing about its mode

    with pytest.raises(P.SandboxPaymentsBlocked):                # refused: silence is not "went live"
        _use_new_key(service, db, customer, booking, key="fresh-key-0010")
    db.rollback()
    assert len(fake.calls) == 2

    assert provider.learned_test_key_state() == "fresh"          # the clock restarted ...
    with pytest.raises(P.SandboxPaymentsBlocked):                # ... so the next one is stopped up front
        _use_new_key(service, db, customer, booking, key="fresh-key-0011")
    assert len(fake.calls) == 2


def test_a_reply_without_key_id_is_still_fine_when_the_key_held_is_live(monkeypatch, resume_case):
    service, db, customer, booking, _key, _oid = resume_case
    _configure(monkeypatch, booking.booking_ref, key=LIVE_KEY)   # configured live, learns nothing new
    fake = FakeTrustBrick(monkeypatch, reported_key="")

    payment, session = _use_new_key(service, db, customer, booking, key="fresh-key-0012")

    assert session.publishable_key == LIVE_KEY and len(fake.calls) == 1


def test_resuming_after_expiry_is_refused_and_does_not_hand_back_the_stale_test_key(monkeypatch, resume_case):
    """The resume path gates twice (configured provider, then the provider holding the order). After
    expiry the first call takes the probe lease and the second is refused, so a resumed order never
    returns a link built on a stale test key; nothing is opened because a resume makes no provider call."""
    service, db, customer, booking, clock, fake = _learn_a_test_key(monkeypatch, resume_case)
    provider = _tb_provider()
    row = service.find_payment_by_idempotency_key(db, booking, "resume-key-0001")
    assert row is None                                           # nothing opened by the refused attempts
    clock.advance(sandbox_guard.LEARNED_TEST_KEY_TTL_SECONDS + 1)

    P.require_customer_access(provider, customer)                # the first gate claims the lease ...
    with pytest.raises(P.SandboxPaymentsBlocked):                # ... the second gate (same request) is refused
        P.require_customer_access(provider, customer)
    assert len(fake.calls) == 1                                  # and TrustBrick was not asked anything
