"""The Duffel adapter, pinned without a network or a token.

These tests exercise every branch the integration promises: the test-mode token
guard, request building, response mapping (and its refusal to invent), the
currency it carries, offer revalidation (expired / price-changed / gone),
booking success and failure, the NO-RETRY rule on writes, the read retry, the
seat-map mapping, and that demo mode is untouched.

No real Duffel call is made. A ``FakeSession`` returns scripted responses and
counts calls, so "does not retry" is a checkable fact rather than a hope.
"""
from __future__ import annotations

import datetime as dt

import pytest
import requests

from app.integrations.duffel import mapper, schemas
from app.integrations.duffel.client import DuffelClient, safe_detail
from app.integrations.duffel.exceptions import (
    DuffelAPIError,
    DuffelNotConfigured,
    DuffelOfferExpired,
    DuffelPriceChanged,
    DuffelTimeout,
)
from app.services import flight_supplier_service as fss

TEST_TOKEN = "duffel_test_abc123"


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #

class FakeResponse:
    def __init__(self, status_code: int, payload=None, text: str = ""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeSession:
    """Returns queued responses (or raises queued exceptions) and counts calls."""

    def __init__(self, script):
        self._script = list(script)
        self.calls = []

    def request(self, method, url, headers=None, params=None, json=None, timeout=None):
        self.calls.append({"method": method, "url": url, "params": params, "json": json})
        item = self._script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def client_with(script):
    return DuffelClient(token=TEST_TOKEN, session=FakeSession(script))


# --------------------------------------------------------------------------- #
# Fixtures — Duffel-shaped JSON
# --------------------------------------------------------------------------- #

def offer_node(offer_id="off_1", total="123.45", currency="GBP", expires_at=None):
    return {
        "id": offer_id,
        "expires_at": expires_at,
        "total_amount": total,
        "total_currency": currency,
        "base_amount": "100.00",
        "tax_amount": "23.45",
        "owner": {"name": "Duffel Airways", "iata_code": "ZZ"},
        "conditions": {"refund_before_departure": {"allowed": True}},
        "payment_requirements": {"requires_instant_payment": True, "payment_required_by": None},
        "passengers": [{"id": "pas_1"}],
        "slices": [{
            "id": "sli_1",
            "origin": {"iata_code": "LHR", "city_name": "London"},
            "destination": {"iata_code": "JFK", "city_name": "New York"},
            "duration": "PT8H15M",
            "segments": [{
                "id": "seg_1",
                "origin": {"iata_code": "LHR", "city_name": "London"},
                "destination": {"iata_code": "JFK", "city_name": "New York"},
                "departing_at": "2026-06-21T09:15:00",
                "arriving_at": "2026-06-21T12:30:00",
                "duration": "PT8H15M",
                "marketing_carrier": {"iata_code": "ZZ", "name": "Duffel Airways"},
                "marketing_carrier_flight_number": "1000",
                "operating_carrier": {"iata_code": "ZZ"},
                "passengers": [{"baggages": [
                    {"type": "carry_on", "quantity": 1},
                    {"type": "checked", "quantity": 1},
                ]}],
            }],
        }],
    }


# --------------------------------------------------------------------------- #
# 1. Token / authentication guard
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bad", ["", "   ", "duffel_live_xyz", "sk_test_x", "random"])
def test_non_test_token_refused(bad):
    with pytest.raises(DuffelNotConfigured):
        DuffelClient(token=bad)


def test_test_token_accepted():
    c = DuffelClient(token=TEST_TOKEN, session=FakeSession([]))
    assert c._headers()["Authorization"] == f"Bearer {TEST_TOKEN}"
    assert c._headers()["Duffel-Version"]  # a version header is always sent


def test_is_configured_reads_settings(monkeypatch):
    monkeypatch.setattr(fss.settings, "duffel_access_token", None, raising=False)
    assert DuffelClient.is_configured() is False
    monkeypatch.setattr(fss.settings, "duffel_access_token", TEST_TOKEN, raising=False)
    assert DuffelClient.is_configured() is True
    monkeypatch.setattr(fss.settings, "duffel_access_token", "duffel_live_x", raising=False)
    assert DuffelClient.is_configured() is False


def test_safe_detail_strips_token():
    assert "duffel_test_" not in safe_detail("boom duffel_test_secret happened")
    assert safe_detail("") == "no detail"


# --------------------------------------------------------------------------- #
# 2. Request mapping
# --------------------------------------------------------------------------- #

def test_offer_request_body_shape():
    body = schemas.offer_request_body(
        slices=[{"origin": "LHR", "destination": "JFK", "departure_date": "2026-06-21"}],
        passengers=[{"type": "adult"}], cabin_class="economy",
    )
    assert body == {"data": {
        "slices": [{"origin": "LHR", "destination": "JFK", "departure_date": "2026-06-21"}],
        "passengers": [{"type": "adult"}],
        "cabin_class": "economy",
    }}


def test_offer_request_body_omits_optional_cabin():
    body = schemas.offer_request_body(
        slices=[{"origin": "A", "destination": "B", "departure_date": "2026-01-01"}],
        passengers=[{"type": "adult"}],
    )
    assert "cabin_class" not in body["data"]


def test_order_body_instant_pays_from_balance():
    body = schemas.order_body(
        offer_id="off_1", passengers=[{"id": "pas_1"}],
        amount="123.45", currency="GBP", metadata={"booking_ref": "JPB1"},
    )
    d = body["data"]
    assert d["type"] == "instant"
    assert d["selected_offers"] == ["off_1"]
    assert d["payments"] == [{"type": "balance", "amount": "123.45", "currency": "GBP"}]
    assert d["metadata"] == {"booking_ref": "JPB1"}


def test_order_body_hold_has_no_payment():
    body = schemas.order_body(
        offer_id="off_1", passengers=[{"id": "pas_1"}],
        amount="1", currency="GBP", order_type="hold",
    )
    assert "payments" not in body["data"]
    assert body["data"]["type"] == "hold"


# --------------------------------------------------------------------------- #
# 3. Response mapping — and refusal to invent
# --------------------------------------------------------------------------- #

def test_offer_to_flight_core_fields():
    offer = schemas.parse_offer(offer_node())
    f = mapper.offer_to_flight(offer)
    assert f["flight_key"] == "off_1"
    assert f["flightNumber"] == "ZZ 1000"
    assert f["airline"] == "Duffel Airways"
    assert f["origin"]["code"] == "LHR" and f["destination"]["code"] == "JFK"
    assert f["date"] == "2026-06-21"
    assert f["departure"] == "09:15" and f["arrival"] == "12:30"
    assert f["durationMinutes"] == 495          # 8h15m
    assert f["stops"] == 0 and f["nonStop"] is True
    assert f["baggage"] == {"cabin": 1, "checkIn": 1}


def test_offer_to_flight_does_not_invent():
    """seatsLeft is unknown; refundable is Duffel's tri-state, never coerced."""
    offer = schemas.parse_offer(offer_node())
    f = mapper.offer_to_flight(offer)
    assert f["seatsLeft"] is None
    assert f["seatsLow"] is None
    assert f["fareType"] is None
    assert f["refundable"] is True              # conditions said so


def test_refundable_unknown_stays_none():
    node = offer_node()
    node["conditions"] = {}                      # Duffel silent
    f = mapper.offer_to_flight(schemas.parse_offer(node))
    assert f["refundable"] is None               # NOT False


def test_baggage_absent_is_none_not_zero():
    node = offer_node()
    node["slices"][0]["segments"][0]["passengers"] = [{"baggages": []}]
    f = mapper.offer_to_flight(schemas.parse_offer(node))
    assert f["baggage"] == {"cabin": None, "checkIn": None}


def test_duration_parser():
    assert mapper.iso_duration_to_minutes("PT2H15M") == 135
    assert mapper.iso_duration_to_minutes("PT45M") == 45
    assert mapper.iso_duration_to_minutes("P1DT1H") == 1500
    assert mapper.iso_duration_to_minutes(None) is None
    assert mapper.iso_duration_to_minutes("garbage") is None


def test_parse_offers_accepts_both_envelopes():
    embedded = {"data": {"offers": [offer_node("off_a"), offer_node("off_b")]}}
    bare = {"data": [offer_node("off_c")]}
    assert [o.id for o in schemas.parse_offers(embedded)] == ["off_a", "off_b"]
    assert [o.id for o in schemas.parse_offers(bare)] == ["off_c"]


# --------------------------------------------------------------------------- #
# 4. Currency — carried, never assumed INR
# --------------------------------------------------------------------------- #

def test_currency_is_carried_verbatim():
    f = mapper.offer_to_flight(schemas.parse_offer(offer_node(currency="GBP", total="200.00")))
    assert f["currency"] == "GBP"
    assert f["total"] == 200.0
    assert f["supplier_currency"] == "GBP"
    assert f["supplier_total_amount"] == "200.00"   # string, verbatim
    assert f["supplier"] == "duffel"


def test_search_envelope_surfaces_supplier_currency(monkeypatch):
    monkeypatch.setattr(fss.settings, "flight_supplier", "duffel", raising=False)
    monkeypatch.setattr(fss.settings, "duffel_access_token", TEST_TOKEN, raising=False)
    session = FakeSession([FakeResponse(200, {"data": {"offers": [offer_node(currency="USD")]}})])
    out = fss.search_flights(
        {"from": "LHR", "to": "JFK", "date": "2026-06-21"},
        client=DuffelClient(token=TEST_TOKEN, session=session),
    )
    assert out["provider"] == "duffel"
    assert out["currency"] == "USD"              # not INR
    assert out["results"][0]["flight_key"] == "off_1"


# --------------------------------------------------------------------------- #
# 5. Offer revalidation
# --------------------------------------------------------------------------- #

def test_revalidate_ok():
    c = client_with([FakeResponse(200, {"data": offer_node(total="123.45")})])
    fresh = fss.revalidate_offer("off_1", shown_amount="123.45", client=c)
    assert fresh.total_amount == "123.45"


def test_revalidate_price_change_raises():
    c = client_with([FakeResponse(200, {"data": offer_node(total="150.00")})])
    with pytest.raises(DuffelPriceChanged) as ei:
        fss.revalidate_offer("off_1", shown_amount="123.45", client=c)
    assert ei.value.now_amount == "150.00"


def test_revalidate_expired_raises():
    past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat()
    c = client_with([FakeResponse(200, {"data": offer_node(expires_at=past)})])
    with pytest.raises(DuffelOfferExpired):
        fss.revalidate_offer("off_1", shown_amount="123.45", client=c)


def test_offer_gone_code_maps_to_expired():
    c = client_with([FakeResponse(422, {"errors": [
        {"code": "offer_no_longer_available", "title": "gone", "message": "gone"}]})])
    with pytest.raises(DuffelOfferExpired):
        c.get_offer("off_1")


# --------------------------------------------------------------------------- #
# 6. Booking — success, failure, and NO automatic retry
# --------------------------------------------------------------------------- #

def test_create_order_success_parses_pnr():
    order_payload = {"data": {
        "id": "ord_1", "booking_reference": "RZPNX8",
        "total_amount": "123.45", "total_currency": "GBP",
        "payment_status": {"awaiting_payment": False},
        "documents": [{"unique_identifier": "1234567890"}],
        "passengers": [{"id": "pas_1"}],
    }}
    c = client_with([FakeResponse(200, order_payload)])
    order = schemas.parse_order(c.create_order(schemas.order_body(
        offer_id="off_1", passengers=[{"id": "pas_1"}], amount="123.45", currency="GBP")))
    assert order.booking_reference == "RZPNX8"
    assert order.document_numbers == ("1234567890",)


def test_create_order_failure_raises_api_error():
    c = client_with([FakeResponse(422, {"errors": [
        {"code": "airline_error", "title": "declined", "message": "declined"}]})])
    with pytest.raises(DuffelAPIError):
        c.create_order({"data": {}})


def test_create_order_does_not_retry_on_timeout():
    session = FakeSession([requests.Timeout(), FakeResponse(200, {"data": {}})])
    c = DuffelClient(token=TEST_TOKEN, session=session)
    with pytest.raises(DuffelTimeout):
        c.create_order({"data": {}})
    assert len(session.calls) == 1               # exactly one attempt


def test_create_order_does_not_retry_on_5xx():
    session = FakeSession([FakeResponse(500, {"errors": [{"code": "x", "message": "boom"}]}),
                           FakeResponse(200, {"data": {}})])
    c = DuffelClient(token=TEST_TOKEN, session=session)
    with pytest.raises(DuffelAPIError):
        c.create_order({"data": {}})
    assert len(session.calls) == 1


# --------------------------------------------------------------------------- #
# 7. Read retry (the other half of the asymmetry)
# --------------------------------------------------------------------------- #

def test_read_retries_on_5xx_then_succeeds():
    session = FakeSession([
        FakeResponse(500, {"errors": [{"code": "x", "message": "temp"}]}),
        FakeResponse(200, {"data": {"offers": [offer_node()]}}),
    ])
    c = DuffelClient(token=TEST_TOKEN, session=session)
    payload = c.create_offer_request({"data": {}})
    assert len(session.calls) == 2
    assert schemas.parse_offers(payload)[0].id == "off_1"


# --------------------------------------------------------------------------- #
# 8. Seat map
# --------------------------------------------------------------------------- #

def test_seat_map_mapping_uses_duffel_availability_and_price():
    payload = {"data": [{
        "segment_id": "seg_1",
        "cabins": [{"rows": [{"sections": [{"elements": [
            {"type": "seat", "designator": "1A",
             "available_services": [{"id": "s1", "total_amount": "15.00", "total_currency": "GBP"}]},
            {"type": "seat", "designator": "1B", "available_services": []},
        ]}]}]}],
    }]}
    out = mapper.seat_maps_to_contract(payload)
    seats = out["rows"][0]["seats"]
    assert seats[0]["id"] == "1A" and seats[0]["occupied"] is False and seats[0]["price"] == 15.0
    assert seats[1]["id"] == "1B" and seats[1]["occupied"] is True and seats[1]["price"] is None
    assert out["currency"] == "GBP"
    assert out["supplier"] == "duffel"


# --------------------------------------------------------------------------- #
# 9. Passenger mapping for orders
# --------------------------------------------------------------------------- #

def test_passengers_to_order_pairs_by_position():
    ours = [{"first_name": "A", "last_name": "B", "title": "Mr", "gender": "male",
             "date_of_birth": dt.date(1990, 1, 2), "email": "a@b.com", "mobile": "+441234"}]
    out = mapper.passengers_to_order(ours, ["pas_1"])
    assert out[0]["id"] == "pas_1"
    assert out[0]["given_name"] == "A" and out[0]["family_name"] == "B"
    assert out[0]["born_on"] == "1990-01-02"
    assert out[0]["title"] == "mr" and out[0]["gender"] == "m"
    assert out[0]["phone_number"] == "+441234"


def test_passengers_to_order_length_mismatch_raises():
    with pytest.raises(ValueError):
        mapper.passengers_to_order([{"first_name": "A"}], ["pas_1", "pas_2"])


def test_unknown_title_is_omitted_not_guessed():
    out = mapper.passengers_to_order(
        [{"first_name": "A", "last_name": "B", "title": "Captain"}], ["pas_1"])
    assert "title" not in out[0]


# --------------------------------------------------------------------------- #
# 10. Demo mode is untouched
# --------------------------------------------------------------------------- #

def test_default_provider_is_demo(monkeypatch):
    monkeypatch.setattr(fss.settings, "flight_supplier", "demo", raising=False)
    assert fss.active_provider() == "demo"
    assert fss.duffel_available() is False


def test_demo_search_is_client_side_envelope(monkeypatch):
    monkeypatch.setattr(fss.settings, "flight_supplier", "demo", raising=False)
    out = fss.search_flights({"from": "HYD", "to": "DEL", "date": "2026-08-08"})
    assert out["provider"] == "demo"
    assert out["results"] == []
    assert out["currency"] is None


def test_unknown_provider_falls_back_to_demo(monkeypatch):
    monkeypatch.setattr(fss.settings, "flight_supplier", "sabre", raising=False)
    assert fss.active_provider() == "demo"
