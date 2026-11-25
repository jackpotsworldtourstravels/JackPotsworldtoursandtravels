"""The TBO hotel adapter, pinned without a network or real credentials.

Reuses the same FakeSession idea as the flight adapter test: scripted responses
keyed by URL, call counting, throwaway credentials. No real TBO call is made.

WHAT IS PINNED
  * the lite Search envelope (Status.Code): 200 maps rooms, 201 is an empty but
    successful result, anything else is a refusal;
  * PreBook's authoritative NetAmount + requirement flags;
  * the classic Book / cancel envelope (top-level ResponseStatus) and its
    re-auth-once on an expired session;
  * the NO-RETRY rule on the Book write;
  * BookingCode threaded from Search into the mapped room;
  * the catalogue default of the hotel supplier switch (unchanged behaviour).
"""
from __future__ import annotations

import pytest
import requests

import app.config
from app.integrations.tbo.shared import TBOSession
from app.integrations.tbo_hotel import mapper, schemas
from app.integrations.tbo_hotel.client import TBOHotelClient
from app.integrations.tbo_hotel.exceptions import TBOAPIError, TBOTimeout
from app.services import hotel_supplier_service as hss

TOKEN = "705d0324-56eb-48a0-9e8e-bd6ed9f853d5"


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text

    def json(self):
        return self._payload


class FakeSession:
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


AUTH_OK = FakeResponse(200, {"Status": 1, "TokenId": TOKEN, "Member": {"MemberId": 1, "AgencyId": 2}})


def _client(routes):
    fake = FakeSession({"/Authenticate": AUTH_OK, **routes})
    sess = TBOSession(
        client_id="SANDBOX_CID", username="jackpots-api", password="pw",
        end_user_ip="203.0.113.9", shared_base_url="http://shared.test/SharedData.svc/rest",
        session=fake,
    )
    client = TBOHotelClient(
        session=sess,
        search_base_url="http://affiliate.test/HotelAPI",
        book_base_url="http://hotelbe.test/hotelservice.svc/rest",
        static_base_url="http://static.test/TBOHolidays_HotelAPI",
    )
    return client, fake


SEARCH_OK = FakeResponse(200, {
    "Status": {"Code": 200, "Description": "Successful"},
    "HotelResult": [{
        "HotelCode": "1402689", "Currency": "INR",
        "Rooms": [{
            "Name": ["Standard Room"], "BookingCode": "BC-1", "MealType": "Breakfast_For_2",
            "IsRefundable": True, "TotalFare": 5000, "TotalTax": 500, "BasePrice": 4500,
            "CancelPolicies": [{"FromDate": "2026-10-01", "CancellationCharge": 500}],
        }],
    }],
})


def _search_args(**over):
    args = dict(
        check_in="2026-10-10", check_out="2026-10-12", hotel_codes="1402689",
        guest_nationality="IN", pax_rooms=[{"adults": 2, "children": 0}],
    )
    args.update(over)
    return args


# --------------------------------------------------------------------------- #
# Search (lite surface)
# --------------------------------------------------------------------------- #

def test_search_200_maps_rooms_with_the_booking_code():
    client, _ = _client({"/Search": SEARCH_OK})
    options = client.search(**_search_args())
    hotels = mapper.options_to_hotels(options)
    assert hotels[0]["supplier_hotel_code"] == "1402689" and hotels[0]["currency"] == "INR"
    room = hotels[0]["rooms"][0]
    assert room["booking_code"] == "BC-1" and room["supplier_booking_code"] == "BC-1"
    assert room["total"] == 5000.0 and room["refundable"] is True
    assert room["mealPlan"] == "Breakfast_For_2"


def test_search_201_is_an_empty_but_successful_result():
    client, _ = _client({"/Search": FakeResponse(200, {"Status": {"Code": 201, "Description": "No rooms"}})})
    assert client.search(**_search_args()) == ()


def test_search_other_code_is_a_refusal():
    client, _ = _client({"/Search": FakeResponse(200, {"Status": {"Code": 500, "Description": "upstream error"}})})
    with pytest.raises(TBOAPIError) as exc:
        client.search(**_search_args())
    assert exc.value.code == 500


# --------------------------------------------------------------------------- #
# PreBook
# --------------------------------------------------------------------------- #

def test_prebook_reads_net_amount_and_flags():
    payload = {"Status": {"Code": 200}, "HotelResult": [{"Currency": "INR", "Rooms": [{
        "BookingCode": "BC-1", "NetAmount": 5100, "PanMandatory": False, "PassportMandatory": True,
        "GSTAllowed": True, "TaxBreakup": [{"TaxType": "Tax_CGST", "TaxAmount": 90}],
        "CancelPolicies": [{"FromDate": "2026-10-01"}],
    }]}]}
    client, _ = _client({"/PreBook": FakeResponse(200, payload)})
    pb = client.prebook("BC-1")
    assert pb.net_amount == 5100.0 and pb.booking_code == "BC-1"
    assert pb.requirement_flags["PassportMandatory"] is True
    assert pb.tax_breakup[0]["TaxType"] == "Tax_CGST"


# --------------------------------------------------------------------------- #
# Book + cancel (classic surface, top-level ResponseStatus)
# --------------------------------------------------------------------------- #

BOOK_OK = FakeResponse(200, {
    "VoucherStatus": True, "Status": 1, "HotelBookingStatus": "Confirmed",
    "BookingId": 1288527, "ConfirmationNo": "CNF1", "BookingRefNo": "REF1",
    "IsPriceChanged": False, "ResponseStatus": 1, "Error": {"ErrorCode": 0},
})


def test_book_parses_confirmation_and_ids():
    client, _ = _client({"/book/": BOOK_OK})
    rooms = mapper.rooms_to_book([[{"first_name": "A", "last_name": "B", "mobile": "9", "email": "x@y.z"}]])
    b = client.book(booking_code="BC-1", net_amount=5100, guest_nationality="IN",
                    is_voucher_booking=True, rooms=rooms)
    assert b.booking_id == 1288527 and b.confirmation_no == "CNF1"
    assert b.status == 1 and b.status_label == "Confirmed" and b.voucher_status is True


def test_book_is_not_retried_after_a_timeout():
    client, fake = _client({"/book/": requests.Timeout("slow")})
    with pytest.raises(TBOTimeout):
        client.book(booking_code="BC-1", net_amount=5100, guest_nationality="IN",
                    is_voucher_booking=True, rooms=[{"HotelPassenger": []}])
    assert fake.count("/book/") == 1


def test_expired_session_reauths_once_on_a_classic_read():
    expired = FakeResponse(200, {"ResponseStatus": 4, "Error": {"ErrorMessage": "InValidSession"}})
    ok = FakeResponse(200, {"ChangeRequestId": 199350, "CancellationCharge": 100,
                            "RefundAmount": 3560, "ChangeRequestStatus": 3, "ResponseStatus": 1, "Error": {}})
    client, fake = _client({"/GetChangeRequestStatus": [expired, ok]})
    r = client.get_change_request_status(199350)
    assert r.refund_amount == 3560.0 and r.change_request_status == 3
    assert fake.count("/Authenticate") == 2
    assert fake.count("/GetChangeRequestStatus") == 2


# --------------------------------------------------------------------------- #
# The switch's catalogue default is unchanged
# --------------------------------------------------------------------------- #

def test_switch_defaults_to_catalogue(monkeypatch):
    monkeypatch.setattr(app.config.settings, "hotel_supplier", "catalogue")
    assert hss.active_provider() == "catalogue"
    env = hss.search_hotels({})
    assert env["provider"] == "catalogue" and env["results"] == []


def test_switch_recognises_tbo(monkeypatch):
    monkeypatch.setattr(app.config.settings, "hotel_supplier", "tbo")
    assert hss.active_provider() == "tbo"
    monkeypatch.setattr(app.config.settings, "hotel_supplier", "nonsense")
    assert hss.active_provider() == "catalogue"             # unknown -> safe default


def test_rooms_to_book_marks_one_lead_with_contact():
    rooms = mapper.rooms_to_book([[
        {"first_name": "A", "last_name": "B", "mobile": "9", "email": "x@y.z"},
        {"first_name": "C", "last_name": "D", "type": "child", "age": 8},
    ]])
    pax = rooms[0]["HotelPassenger"]
    assert pax[0]["LeadPassenger"] is True and pax[0]["Email"] == "x@y.z"
    assert pax[1]["LeadPassenger"] is False and pax[1]["Age"] == 8 and pax[1]["PaxType"] == 2
    assert "Email" not in pax[1]
