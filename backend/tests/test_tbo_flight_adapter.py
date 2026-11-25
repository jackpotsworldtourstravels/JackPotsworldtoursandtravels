"""The TBO flight adapter, pinned without a network or real credentials.

No real TBO call is made. A ``FakeSession`` returns scripted responses keyed by
URL and counts calls, so "does not retry a write" and "authenticates once" are
checkable facts rather than hopes. Every test builds its own
:class:`TBOSession` with throwaway credentials and injects the fake, so nothing
touches settings or a real host.

WHAT IS PINNED
  * the four-credential configuration gate;
  * one Authenticate shared across calls, cached for the day;
  * Search -> internal flight shape, and its refusal to invent (tri-state
    refundable, verbatim baggage label, OfferedFare as the bookable total);
  * the (TraceId|ResultIndex) offer handle round-trip;
  * FareQuote re-price and the price-change guard;
  * session-expiry re-auth-once on a read;
  * the NO-RETRY rule on Book/Ticket writes, and the read retry;
  * that the password never reaches a log line.
"""
from __future__ import annotations

import pytest
import requests

import app.config
from app.integrations.tbo import mapper, schemas
from app.integrations.tbo.client import TBOFlightClient
from app.integrations.tbo.exceptions import (
    TBOAPIError,
    TBONotConfigured,
    TBOPriceChanged,
    TBOTimeout,
)
from app.integrations.tbo.shared import TBOSession, safe_detail
from app.services import flight_supplier_service as fss

TOKEN = "705d0324-56eb-48a0-9e8e-bd6ed9f853d5"
TRACE = "d1f3a9c0-5b2e-4f88-9a10-7c6e2b4d0a31"


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #

class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeSession:
    """Routes POSTs by a URL substring. A list value is consumed in order; an
    Exception value is raised (to simulate a timeout / transport error)."""

    def __init__(self, routes):
        self._routes = routes
        self.calls = []

    def post(self, url, headers=None, json=None, timeout=None):
        self.calls.append(url)
        for needle, value in self._routes.items():
            if needle in url:
                if isinstance(value, list):
                    value = value.pop(0)
                if isinstance(value, Exception):
                    raise value
                return value
        raise AssertionError(f"no fake route for {url}")

    def count(self, needle):
        return sum(1 for u in self.calls if needle in u)


AUTH_OK = FakeResponse(200, {"Status": 1, "TokenId": TOKEN, "Member": {"MemberId": 111, "AgencyId": 222}})


def _session(routes):
    routes = {"/Authenticate": AUTH_OK, **routes}
    fake = FakeSession(routes)
    sess = TBOSession(
        client_id="SANDBOX_CID", username="jackpots-api", password="s3cr3t-pw",
        end_user_ip="203.0.113.9", shared_base_url="http://shared.test/SharedData.svc/rest",
        session=fake,
    )
    return sess, fake


def _client(routes, air_base="http://air.test/AirService.svc/rest"):
    sess, fake = _session(routes)
    return TBOFlightClient(session=sess, air_base_url=air_base), fake


SEARCH_PAYLOAD = {
    "Response": {
        "ResponseStatus": 1, "Error": {"ErrorCode": 0, "ErrorMessage": ""},
        "TraceId": TRACE,
        "Results": [[
            {
                "ResultIndex": "OB1", "Source": 6, "IsLCC": True, "IsRefundable": True,
                "ResultFareType": "RegularFare", "LastTicketDate": None,
                "Fare": {"Currency": "INR", "BaseFare": 5000, "Tax": 900,
                         "PublishedFare": 5900, "OfferedFare": 5750},
                "Segments": [[
                    {
                        "Baggage": "15 KG", "CabinBaggage": "7 KG", "CabinClass": 2,
                        "Duration": 130,
                        "Airline": {"AirlineCode": "6E", "AirlineName": "IndiGo", "FlightNumber": "6523"},
                        "Origin": {"Airport": {"AirportCode": "HYD", "CityName": "Hyderabad"},
                                   "DepTime": "2026-10-10T06:15:00"},
                        "Destination": {"Airport": {"AirportCode": "DEL", "CityName": "Delhi"},
                                        "ArrTime": "2026-10-10T08:25:00"},
                    }
                ]],
            }
        ]],
    }
}


# --------------------------------------------------------------------------- #
# Configuration gate
# --------------------------------------------------------------------------- #

def test_is_configured_needs_all_four_credentials(monkeypatch):
    s = app.config.settings
    for k in ("tbo_client_id", "tbo_username", "tbo_password", "tbo_end_user_ip"):
        monkeypatch.setattr(s, k, None)
    assert TBOFlightClient.is_configured() is False
    monkeypatch.setattr(s, "tbo_client_id", "C")
    monkeypatch.setattr(s, "tbo_username", "U")
    monkeypatch.setattr(s, "tbo_password", "P")
    assert TBOFlightClient.is_configured() is False          # ip still missing
    monkeypatch.setattr(s, "tbo_end_user_ip", "203.0.113.9")
    assert TBOFlightClient.is_configured() is True


def test_unconfigured_session_refuses_to_authenticate():
    sess = TBOSession(client_id="", username="", password="", end_user_ip="", session=FakeSession({}))
    with pytest.raises(TBONotConfigured):
        sess.token_id()


# --------------------------------------------------------------------------- #
# Authenticate is shared and cached
# --------------------------------------------------------------------------- #

def test_authenticate_happens_once_across_calls():
    client, fake = _client({"/Search": [FakeResponse(200, SEARCH_PAYLOAD),
                                        FakeResponse(200, SEARCH_PAYLOAD)]})
    client.search(segments=[{"origin": "HYD", "destination": "DEL", "departure_date": "2026-10-10"}])
    client.search(segments=[{"origin": "HYD", "destination": "DEL", "departure_date": "2026-10-10"}])
    assert fake.count("/Authenticate") == 1                  # cached for the day
    assert fake.count("/Search") == 2


# --------------------------------------------------------------------------- #
# Search mapping
# --------------------------------------------------------------------------- #

def test_search_maps_into_the_internal_flight_shape():
    client, _ = _client({"/Search": FakeResponse(200, SEARCH_PAYLOAD)})
    resp = client.search(segments=[{"origin": "HYD", "destination": "DEL", "departure_date": "2026-10-10"}])
    assert resp.trace_id == TRACE
    flights = mapper.results_to_flights(resp.results, resp.trace_id)
    f = flights[0]
    assert f["flight_key"] == f"{TRACE}|OB1"                 # the composite offer handle
    assert f["airlineCode"] == "6E" and f["flightNumber"] == "6E 6523"
    assert f["origin"]["code"] == "HYD" and f["destination"]["code"] == "DEL"
    assert f["departure"] == "06:15" and f["arrival"] == "08:25"
    assert f["total"] == 5750.0                              # OfferedFare, not PublishedFare
    assert f["currency"] == "INR"
    assert f["refundable"] is True                           # tri-state, stated here
    assert f["baggage"] == {"cabin": "7 KG", "checkIn": "15 KG"}  # verbatim labels
    assert f["supplier"] == "tbo" and f["supplier_is_lcc"] is True


def test_offer_handle_round_trips_and_rejects_malformed():
    h = mapper.offer_handle(TRACE, "OB1")
    assert mapper.parse_offer_handle(h) == (TRACE, "OB1")
    for bad in ["", "no-sep", "|OB1", TRACE + "|"]:
        with pytest.raises(ValueError):
            mapper.parse_offer_handle(bad)


# --------------------------------------------------------------------------- #
# FareQuote + price-change guard
# --------------------------------------------------------------------------- #

FQ_PAYLOAD = {
    "Response": {
        "ResponseStatus": 1, "Error": {"ErrorCode": 0}, "TraceId": TRACE,
        "IsPriceChanged": False,
        "Results": {
            "ResultIndex": "OB1", "Source": 6, "IsLCC": False, "IsRefundable": True,
            "IsPassportRequiredAtBook": True, "IsGSTMandatory": False,
            "LastTicketDate": "2026-10-08T23:59:00",
            "Fare": {"Currency": "INR", "OfferedFare": 5750, "PublishedFare": 5900},
            "FareBreakdown": [{"Currency": "INR", "PassengerType": 1, "BaseFare": 5000, "Tax": 750}],
        },
    }
}


def test_fare_quote_reads_islcc_and_flags_from_the_quote():
    client, _ = _client({"/FareQuote": FakeResponse(200, FQ_PAYLOAD)})
    q = client.fare_quote(TRACE, "OB1")
    assert q.is_lcc is False and q.is_passport_required_at_book is True
    assert q.last_ticket_date == "2026-10-08T23:59:00"
    assert q.fare.offered_fare == 5750.0


def test_revalidate_tbo_passes_when_price_matches():
    client, _ = _client({"/FareQuote": FakeResponse(200, FQ_PAYLOAD)})
    q = fss.revalidate_offer_tbo(mapper.offer_handle(TRACE, "OB1"), shown_amount="5750", client=client)
    assert q.result_index == "OB1"


def test_revalidate_tbo_raises_on_a_price_change():
    client, _ = _client({"/FareQuote": FakeResponse(200, FQ_PAYLOAD)})
    with pytest.raises(TBOPriceChanged) as exc:
        fss.revalidate_offer_tbo(mapper.offer_handle(TRACE, "OB1"), shown_amount="5000", client=client)
    assert exc.value.now_amount == "5750.0"


# --------------------------------------------------------------------------- #
# Session expiry and business refusals
# --------------------------------------------------------------------------- #

def test_expired_session_reauthenticates_once_on_a_read():
    expired = FakeResponse(200, {"Response": {"ResponseStatus": 4, "Error": {"ErrorMessage": "InValidSession"}}})
    client, fake = _client({"/Search": [expired, FakeResponse(200, SEARCH_PAYLOAD)]})
    resp = client.search(segments=[{"origin": "HYD", "destination": "DEL", "departure_date": "2026-10-10"}])
    assert resp.results                                      # recovered
    assert fake.count("/Authenticate") == 2                  # re-authed exactly once
    assert fake.count("/Search") == 2


def test_a_business_refusal_becomes_a_tbo_api_error():
    refused = FakeResponse(200, {"Response": {"ResponseStatus": 2, "Error": {"ErrorCode": 5, "ErrorMessage": "no flights"}}})
    client, _ = _client({"/Search": refused})
    with pytest.raises(TBOAPIError) as exc:
        client.search(segments=[{"origin": "HYD", "destination": "DEL", "departure_date": "2026-10-10"}])
    assert exc.value.code == 5


# --------------------------------------------------------------------------- #
# Write safety
# --------------------------------------------------------------------------- #

def test_ticket_is_not_retried_after_a_timeout():
    client, fake = _client({"/Ticket": requests.Timeout("slow")})
    with pytest.raises(TBOTimeout):
        client.ticket_lcc(trace_id=TRACE, result_index="OB1",
                          passengers=[{"first_name": "A", "last_name": "B"}])
    assert fake.count("/Ticket") == 1                        # exactly one attempt


def test_a_read_is_retried_on_a_5xx():
    client, fake = _client({"/Search": [FakeResponse(503), FakeResponse(200, SEARCH_PAYLOAD)]})
    client.search(segments=[{"origin": "HYD", "destination": "DEL", "departure_date": "2026-10-10"}])
    assert fake.count("/Search") == 2                        # retried then succeeded


def test_book_timeout_leaves_outcome_unknown_no_retry():
    client, fake = _client({"/Book": requests.Timeout("slow")})
    with pytest.raises(TBOTimeout):
        client.book(trace_id=TRACE, result_index="OB1",
                    passengers=[{"first_name": "A", "last_name": "B", "pax_type": "adult"}])
    assert fake.count("/Book") == 1


# --------------------------------------------------------------------------- #
# Passenger mapping
# --------------------------------------------------------------------------- #

def test_passengers_carry_the_matching_fare_breakdown():
    breakdown = [{"PassengerType": 1, "BaseFare": 5000}, {"PassengerType": 2, "BaseFare": 3000}]
    out = mapper.passengers_to_book(
        [{"first_name": "A", "last_name": "B", "pax_type": "adult", "gender": "male"},
         {"first_name": "C", "last_name": "D", "pax_type": "child"}],
        breakdown,
    )
    assert out[0]["IsLeadPax"] is True and out[1]["IsLeadPax"] is False
    assert out[0]["Gender"] == 1 and out[0]["PaxType"] == 1
    assert out[0]["Fare"]["BaseFare"] == 5000 and out[1]["Fare"]["BaseFare"] == 3000


def test_unknown_gender_is_omitted_not_guessed():
    out = mapper.passengers_to_book([{"first_name": "A", "last_name": "B", "gender": "?"}], [])
    assert "Gender" not in out[0]


# --------------------------------------------------------------------------- #
# The password never leaks; the switch recognises tbo
# --------------------------------------------------------------------------- #

def test_safe_detail_redacts_the_password():
    assert "hunter2" not in safe_detail('{"Password":"hunter2"} failed', "hunter2")
    assert "hunter2" not in safe_detail('oops Password: hunter2 here', "hunter2")


def test_switch_recognises_tbo_and_demo_is_unchanged(monkeypatch):
    monkeypatch.setattr(app.config.settings, "flight_supplier", "tbo")
    assert fss.active_provider() == "tbo"
    monkeypatch.setattr(app.config.settings, "flight_supplier", "demo")
    assert fss.active_provider() == "demo"
    env = fss.search_flights({"from": "HYD", "to": "DEL", "date": "2026-10-10"})
    assert env["provider"] == "demo" and env["results"] == []
