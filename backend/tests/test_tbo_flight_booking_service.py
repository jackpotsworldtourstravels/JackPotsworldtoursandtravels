"""Mock tests for the TBO flight booking-path orchestration (Phase 2, items 2–5).

No network, no credentials, no database — a FakeTBOClient returns canned
TBO dataclasses and records every call, so success / failure / timeout / retry /
duplicate / price-change / LCC-vs-NonLCC are all exercised deterministically.

These prove the ORCHESTRATION's guarantees (idempotence, no-retry-on-write,
fail-safe ticketed detection, price guard). They do NOT prove a live TBO call —
sandbox access is unavailable; this is mock-verified, not TBO-verified.
"""
from __future__ import annotations

import pytest

from app.integrations.tbo.exceptions import TBOPriceChanged, TBOTimeout
from app.integrations.tbo.schemas import TBOFare, TBOFareQuote, TBOItinerary, TBOTicketInfo
from app.services import tbo_flight_booking_service as svc

HANDLE = "TRACE123|RESULT7"
PAX = [{"title": "Mr", "first_name": "Asha", "last_name": "Rao", "type": "adult",
        "gender": "female", "mobile": "+919000000001", "email": "a@example.com"}]


def _fare(offered=5500.0, cur="INR"):
    return TBOFare(currency=cur, base_fare=5000.0, tax=500.0, published_fare=6000.0, offered_fare=offered)


def _quote(*, is_lcc=True, offered=5500.0, price_changed=False):
    return TBOFareQuote(
        trace_id="TRACE123", result_index="RESULT7", source=1,
        is_price_changed=price_changed, is_lcc=is_lcc, is_refundable=True,
        is_pan_required_at_book=False, is_passport_required_at_book=False,
        is_passport_required_at_ticket=False, is_gst_mandatory=False,
        last_ticket_date="2026-12-01T00:00:00",
        fare=_fare(offered), fare_breakdown=({"PassengerType": 1, "BaseFare": 5000.0},),
    )


def _itin(*, booking_id=98765, pnr="ABCDEF", status=1, is_lcc=True, ticketed=True):
    tickets = (TBOTicketInfo(pax_id=1, ticket_id=11, ticket_number="0577712345678" if ticketed else None,
                             status="Ticketed" if ticketed else "Pending"),)
    return TBOItinerary(booking_id=booking_id, pnr=pnr, status=status, source=1, is_lcc=is_lcc,
                        last_ticket_date=None, invoice_no="INV1", fare=_fare(), tickets=tickets)


class FakeTBOClient:
    """Records calls; returns configured responses; can raise per-method."""

    def __init__(self, **responses):
        self.responses = responses
        self.calls = []

    def _ret(self, name, default=None):
        self.calls.append(name)
        val = self.responses.get(name, default)
        if isinstance(val, Exception):
            raise val
        if callable(val):
            return val()
        return val

    def fare_quote(self, t, r): return self._ret("fare_quote", _quote())
    def fare_rule(self, t, r): return self._ret("fare_rule", {"FareRuleDetail": "No changes within 24h."})
    def ssr(self, t, r): return self._ret("ssr", {})
    def book(self, **k): self.calls.append("book"); return self._book()
    def ticket_lcc(self, **k): self.calls.append("ticket_lcc"); return self._ticket_lcc()
    def ticket_non_lcc(self, **k): self.calls.append("ticket_non_lcc"); return self._ticket_non_lcc()
    def get_booking_details(self, **k): return self._ret("get_booking_details", _itin())
    def send_change_request(self, bid, **k): return self._ret("send_change_request", {"ChangeRequestId": 4242})
    def get_change_request_status(self, crid): return self._ret("get_change_request_status", {})
    def get_cancellation_charges(self, bid, **k): return self._ret("get_cancellation_charges", {})

    # write helpers honour a configured exception/value
    def _book(self):
        v = self.responses.get("book", _itin(status=None, ticketed=False))
        if isinstance(v, Exception): raise v
        return v() if callable(v) else v

    def _ticket_lcc(self):
        v = self.responses.get("ticket_lcc", _itin())
        if isinstance(v, Exception): raise v
        return v() if callable(v) else v

    def _ticket_non_lcc(self):
        v = self.responses.get("ticket_non_lcc", _itin(is_lcc=False))
        if isinstance(v, Exception): raise v
        return v() if callable(v) else v


# ------------------------------------------------------------------ item 2
def test_fare_quote_maps_fields():
    opt = svc.fare_quote(HANDLE, client=FakeTBOClient())
    assert opt.total == 5500.0 and opt.currency == "INR"
    assert opt.is_lcc is True and opt.is_refundable is True
    assert opt.fare_lines and opt.fare_lines[0]["PassengerType"] == 1


def test_fare_quote_price_change_raises():
    c = FakeTBOClient(fare_quote=_quote(offered=6200.0))
    with pytest.raises(TBOPriceChanged):
        svc.fare_quote(HANDLE, shown_amount="5500", client=c)


def test_fare_quote_no_shown_amount_never_raises():
    c = FakeTBOClient(fare_quote=_quote(offered=6200.0))
    assert svc.fare_quote(HANDLE, client=c).total == 6200.0


def test_fare_rules_passthrough():
    assert "FareRuleDetail" in svc.fare_rules(HANDLE, client=FakeTBOClient())


# ------------------------------------------------------------------ item 3
def test_ancillaries_maps_groups_and_names_unsupported():
    c = FakeTBOClient(ssr={"SeatDynamic": [{"Code": "12A"}], "MealDynamic": [], "Baggage": []})
    out = svc.ancillaries(HANDLE, client=c)
    assert out["seats"] and out["meals"] == [] and out["baggage"] == []
    assert set(out["unsupported"]) == {"meals", "baggage"}


# ------------------------------------------------------------------ item 4
def test_reserve_lcc_tickets_in_one_call():
    c = FakeTBOClient()
    res = svc.reserve(offer_handle=HANDLE, passengers=PAX, client=c)
    assert "ticket_lcc" in c.calls and "book" not in c.calls
    assert res.ticketed is True and res.order_id == "98765" and res.pnr == "ABCDEF"
    assert res.ticket_numbers == ("0577712345678",)


def test_reserve_non_lcc_books_then_tickets():
    c = FakeTBOClient(fare_quote=_quote(is_lcc=False),
                      book=_itin(is_lcc=False, ticketed=False, status=1),
                      ticket_non_lcc=_itin(is_lcc=False),
                      get_booking_details=_itin(is_lcc=False))
    res = svc.reserve(offer_handle=HANDLE, passengers=PAX, client=c)
    assert c.calls.count("book") == 1 and c.calls.count("ticket_non_lcc") == 1
    assert "ticket_lcc" not in c.calls
    assert res.ticketed is True


def test_reserve_is_idempotent_when_already_booked():
    c = FakeTBOClient()
    res = svc.reserve(offer_handle=HANDLE, passengers=PAX, existing_order_id="98765", client=c)
    # NEVER books or tickets again — only reconciles.
    assert "book" not in c.calls and "ticket_lcc" not in c.calls and "ticket_non_lcc" not in c.calls
    assert c.calls == ["get_booking_details"]
    assert res.order_id == "98765"


def test_reserve_price_change_blocks_before_any_write():
    c = FakeTBOClient(fare_quote=_quote(offered=6200.0))
    with pytest.raises(TBOPriceChanged):
        svc.reserve(offer_handle=HANDLE, passengers=PAX, shown_amount="5500", client=c)
    assert "book" not in c.calls and "ticket_lcc" not in c.calls


def test_reserve_write_timeout_resolves_via_get_booking_details():
    # Ticket times out; GetBookingDetails(TraceId) finds the booking went through.
    c = FakeTBOClient(ticket_lcc=TBOTimeout("ticket timed out"),
                      get_booking_details=_itin())
    res = svc.reserve(offer_handle=HANDLE, passengers=PAX, client=c)
    assert "get_booking_details" in c.calls
    assert res.ticketed is True and res.order_id == "98765"


def test_reserve_write_timeout_unresolved_reraises():
    # Ticket times out AND GBD cannot find a booking → genuinely unknown → raise.
    c = FakeTBOClient(ticket_lcc=TBOTimeout("ticket timed out"),
                      get_booking_details=_itin(booking_id=None, pnr=None, ticketed=False, status=None))
    with pytest.raises(TBOTimeout):
        svc.reserve(offer_handle=HANDLE, passengers=PAX, client=c)


def test_reserve_not_ticketed_when_status_unsuccessful():
    bad = _itin(status=0, ticketed=False)
    c = FakeTBOClient(ticket_lcc=bad, get_booking_details=bad)
    res = svc.reserve(offer_handle=HANDLE, passengers=PAX, client=c)
    assert res.ticketed is False


def test_reserve_not_ticketed_when_ticket_number_missing():
    nt = _itin(status=1, ticketed=False)
    c = FakeTBOClient(ticket_lcc=nt, get_booking_details=nt)
    res = svc.reserve(offer_handle=HANDLE, passengers=PAX, client=c)
    assert res.ticketed is False


def test_reconcile_booking_reads_state_without_writing():
    c = FakeTBOClient()
    res = svc.reconcile_booking("98765", client=c)
    assert c.calls == ["get_booking_details"] and res.order_id == "98765"


# ------------------------------------------------------------------ item 5
def test_request_cancellation_returns_change_request_id():
    c = FakeTBOClient()
    out = svc.request_cancellation("98765", client=c)
    assert out.change_request_id == 4242 and out.status_label == "requested"


def test_reconcile_cancellation_settles_refund_on_completed():
    c = FakeTBOClient(get_change_request_status={"ChangeRequestStatus": 4, "RefundedAmount": "4800.00",
                                                 "Currency": "INR"})
    out = svc.reconcile_cancellation(4242, client=c)
    assert out.status_code == 4 and out.status_label == "completed"
    assert out.refund_amount == 4800.0 and out.currency == "INR"


def test_reconcile_cancellation_pending_has_no_refund():
    c = FakeTBOClient(get_change_request_status={"ChangeRequestStatus": 2})
    out = svc.reconcile_cancellation(4242, client=c)
    assert out.status_label == "in_progress" and out.refund_amount is None
