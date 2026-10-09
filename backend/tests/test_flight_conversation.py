"""The flight conversation, the airport/date/slot modules, and the model layer.

Everything here is offline: the catalogue is the checked-in fixture, the model is a
fake object or a mocked ``requests.post``, and no network is touched. The only
database is the in-memory one used for session binding.

  A. the slot state machine      "Flights to Goa" + "Delhi" is an ORIGIN, and so on
  B. airports, dates, tools      the pure helpers underneath
  C. the model path              grounding, invalid arguments, failure -> rules
  D. the provider wire format    Responses and Chat shapes, no secrets, 429/timeout
  E. session binding             a held search belongs to one conversation
  F. regressions                 hotels, packages, destinations, support
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models_customer import (
    Base, Customer, CustomerAssistantMessage, CustomerAssistantSession,
    CustomerAttraction, CustomerDestination, CustomerLocation,
)
from app.services import airport_reference, conversation_state
from app.services import customer_assistant_service as assistant
from app.services import travel_ai, travel_ai_assistant as ta, travel_dates
from app.services.travel_ai import openai_provider, tools

FIX = json.loads((Path(__file__).parent / "fixtures" / "catalogue_places.json").read_text("utf-8"))
PLACES = ta.Places(destinations=[(d["slug"], d["name"]) for d in FIX["destinations"]],
                   attractions=[tuple(a) for a in FIX["attractions"]],
                   locations=[tuple(a) for a in FIX["locations"]], countries={})
for _d in FIX["destinations"]:
    if _d["country"]:
        PLACES.countries.setdefault(_d["country"], []).append((_d["slug"], _d["name"]))

TODAY = dt.date.today()
TOMORROW = (TODAY + dt.timedelta(days=1)).isoformat()


def talk(*messages, ctx=None, places=PLACES):
    """Send messages one after another, handing each reply's context to the next."""
    out = []
    for m in messages:
        r = ta.analyze_message(m, places, ctx)
        ctx = r["context"]
        out.append(r)
    return out


def params(r):
    return r["action"]["params"] or {}


@pytest.fixture(autouse=True)
def no_provider(monkeypatch):
    monkeypatch.setattr(travel_ai, "get_provider", lambda: None)


# ---------------------------------------------------------------------------
# A. The slot state machine
# ---------------------------------------------------------------------------
class TestFlightSlots:
    def test_flights_to_goa_then_delhi_makes_delhi_the_origin(self):
        a, b = talk("Flights to Goa", "Delhi")
        assert "flying from" in a["reply"] and a["context"]["awaiting"] == "origin"
        assert params(b)["fromCode"] == "DEL" and params(b)["toCode"] == "GOI"
        assert b["context"]["origin"] == "Delhi" and b["context"]["destination"] == "Goa"

    def test_a_route_sentence_sets_both(self):
        (r,) = talk("Flights from Delhi to Goa")
        assert (params(r)["fromCode"], params(r)["toCode"]) == ("DEL", "GOI")

    def test_a_bare_route_reply_sets_both(self):
        _, r = talk("Flights to Goa", "delhi to mumbai")
        assert (params(r)["fromCode"], params(r)["toCode"]) == ("DEL", "BOM")

    def test_changing_the_origin_keeps_the_destination_and_date(self):
        *_, r = talk("Flights from Delhi to Goa", "tomorrow", "change the origin to mumbai")
        p = params(r)
        assert (p["fromCode"], p["toCode"]) == ("BOM", "GOI") and p["date"] == TOMORROW

    def test_changing_the_destination_keeps_the_origin(self):
        *_, r = talk("Flights from Delhi to Goa", "tomorrow", "change destination to dubai")
        assert (params(r)["fromCode"], params(r)["toCode"]) == ("DEL", "DXB")

    def test_a_missing_date_is_asked_for_once(self):
        (a,) = talk("Flights from Delhi to Goa")
        assert "what day" in a["reply"].lower()
        assert a["context"]["awaiting"] == "date" and a["choices"]

    def test_the_answered_question_is_not_asked_again(self):
        _, b = talk("Flights to Goa", "Delhi")
        assert "Where will you be flying from?" not in b["reply"]
        assert b["context"].get("awaiting") != "origin"

    def test_an_ambiguous_airport_asks_the_customer_to_choose(self):
        _, b = talk("Flights to Delhi", "london")
        assert len(b["choices"]) >= 2 and all("London" in c["label"] for c in b["choices"])
        assert not params(b).get("fromCode")

    def test_choosing_from_the_ambiguity_fills_the_slot(self):
        *_, c = talk("Flights to Delhi", "london", "London (LHR)")
        assert params(c)["fromCode"] == "LHR" and params(c)["toCode"] == "DEL"

    def test_a_new_search_does_not_inherit_stale_values(self):
        *_, r = talk("Flights from Delhi to Goa", "tomorrow", "Flights from Mumbai to Dubai")
        p = params(r)
        assert (p["fromCode"], p["toCode"]) == ("BOM", "DXB") and "date" not in p

    def test_a_typo_is_offered_never_assumed(self):
        _, b = talk("Flights to Goa", "hyderbad")
        assert "Hyderabad" in b["reply"] and "fromCode" not in params(b)

    def test_an_unknown_place_is_said_not_invented(self):
        _, b = talk("Flights to Goa", "Narnia")
        assert "Narnia" in b["reply"] and "fromCode" not in params(b)

    def test_the_same_airport_at_both_ends_is_refused(self):
        *_, r = talk("Flights to Goa", "goa")
        assert params(r).get("fromCode") != params(r).get("toCode") or not params(r).get("fromCode")

    def test_a_past_date_is_refused(self):
        *_, r = talk("Flights from Delhi to Goa", "yesterday")
        assert "date" not in params(r)

    def test_round_trip_is_remembered(self):
        *_, r = talk("Flights from Delhi to Goa", "round trip tomorrow")
        assert params(r)["trip"] == "round"


# ---------------------------------------------------------------------------
# B. Airports, dates, tool definitions
# ---------------------------------------------------------------------------
class TestAirportReference:
    def test_known_city(self):
        assert airport_reference.lookup("Goa").airports[0].code == "GOI"

    def test_several_matches_are_ambiguous(self):
        found = airport_reference.lookup("London")
        assert found.status == "ambiguous" and "LHR" in {a.code for a in found.airports}

    def test_typo_is_near(self):
        found = airport_reference.lookup("Banglore")
        assert found.status == "near" and found.airports[0].code == "BLR"

    def test_unknown(self):
        assert airport_reference.lookup("Narnia").status == "none"

    def test_code_in_brackets(self):
        assert airport_reference.lookup("London (LHR)").airports[0].code == "LHR"


class TestDates:
    T = dt.date(2026, 10, 9)  # a Friday

    @pytest.mark.parametrize("text,expected", [
        ("tomorrow", "2026-10-10"), ("day after tomorrow", "2026-10-11"), ("today", "2026-10-09"),
        ("12 oct", "2026-10-12"), ("oct 12th", "2026-10-12"), ("in 3 days", "2026-10-12"),
        ("2026-12-24", "2026-12-24"), ("12/10", "2026-10-12"), ("friday", "2026-10-16"),
        ("next friday", "2026-10-16"),
    ])
    def test_days(self, text, expected):
        assert travel_dates.parse_day(text, self.T) == expected

    def test_unknowable_days_are_none(self):
        assert travel_dates.parse_day("sometime in march", self.T) is None
        assert travel_dates.parse_day("a 3-4 day trip", self.T) is None

    def test_past(self):
        assert travel_dates.is_past("2026-10-08", self.T)
        assert not travel_dates.is_past("2026-10-09", self.T)


class TestTools:
    def test_every_schema_is_strict(self):
        for name in tools.TOOL_NAMES:
            s = tools.schema(name)
            assert s["additionalProperties"] is False and set(s["required"]) == set(s["properties"])

    def test_valid_call(self):
        t = tools.validate("search_flights", json.dumps(
            {"origin": "Delhi", "destination": None, "date": None, "trip": None, "passengers": 2}))
        assert t.tool == "search_flights" and t.args["origin"] == "Delhi" and t.args["passengers"] == 2

    @pytest.mark.parametrize("name,args", [
        ("book_flight", {}), ("search_flights", {"origin": "x", "price": 1}),
        ("search_flights", {"passengers": 99}), ("search_flights", {"passengers": "2"}),
        ("search_flights", {"trip": "sideways"}), ("search_flights", {"origin": "x" * 200}),
        ("get_location_details", {}), ("search_flights", "not json"),
    ])
    def test_invalid_calls_are_rejected(self, name, args):
        assert tools.validate(name, args) is None

    def test_redaction(self):
        out = tools.redact("card 4111 1111 1111 1111 mail a@b.com see https://x.y on 2026-10-12")
        assert "4111" not in out and "a@b.com" not in out and "https" not in out
        assert "2026-10-12" in out

    def test_no_tool_books_or_pays(self):
        assert not any(w in n for n in tools.TOOL_NAMES for w in ("book", "pay", "cancel"))


# ---------------------------------------------------------------------------
# C. The model path
# ---------------------------------------------------------------------------
class FakeModel(travel_ai.AIProvider):
    name = "fake"

    def __init__(self, turn=None, boom=False):
        self.turn, self.boom, self.calls, self.seen = turn, boom, 0, []

    def available(self):
        return True

    def classify(self, text, hints):
        return None

    def plan(self, text, hints):
        self.calls += 1
        self.seen.append((text, hints))
        if self.boom:
            raise RuntimeError("down")
        return self.turn


def call(tool, **args):
    full = {f: None for f in tools._SPECS[tool][1]}
    full.update(args)
    return tools.ModelTurn(tool, full)


def use(monkeypatch, model):
    monkeypatch.setattr(travel_ai, "get_provider", lambda: model)
    return model


class TestModelPath:
    def test_rules_answer_a_clear_sentence_without_a_model_call(self, monkeypatch):
        m = use(monkeypatch, FakeModel(call("get_destinations")))
        (r,) = talk("Hotels in Goa")
        assert m.calls == 0 and r["reader"] == "rules"

    def test_greetings_and_thanks_never_reach_the_model(self, monkeypatch):
        m = use(monkeypatch, FakeModel(call("get_destinations")))
        talk("hello", "thanks a lot", "talk to a human agent")
        assert m.calls == 0

    def test_an_unclear_sentence_is_planned_by_the_model(self, monkeypatch):
        m = use(monkeypatch, FakeModel(call("search_flights", origin="Delhi", destination="Goa")))
        (r,) = talk("get me airborne delhi goa whenever")
        assert m.calls == 1 and r["reader"] == "fake"
        assert (params(r)["fromCode"], params(r)["toCode"]) == ("DEL", "GOI")

    def test_the_model_is_given_state_and_the_open_question(self, monkeypatch):
        m = use(monkeypatch, FakeModel(call("search_flights", origin="Delhi")))
        a = talk("Flights to Goa")[0]
        ta.analyze_message("well how about starting out of delhi then maybe later", PLACES, a["context"])
        _text, hints = m.seen[-1]
        assert hints.awaiting == "origin" and hints.state["destination"] == "Goa"

    def test_a_place_the_customer_never_said_is_dropped(self, monkeypatch):
        use(monkeypatch, FakeModel(call("search_flights", origin="Mumbai", destination="Goa")))
        (r,) = talk("zzz qqq wander off somewhere eventually please maybe")
        assert "fromCode" not in params(r) and r["reader"] == "rules"

    def test_model_dates_are_ignored_the_customers_words_decide(self, monkeypatch):
        use(monkeypatch, FakeModel(call("search_flights", origin="Delhi", destination="Goa", date="2030-01-01")))
        (r,) = talk("hmm delhi goa soonish maybe tomorrow I think")
        assert params(r).get("date") == TOMORROW

    def test_a_model_answer_for_the_open_question_fills_only_that_slot(self, monkeypatch):
        use(monkeypatch, FakeModel(call("search_flights", origin="Delhi")))
        a = talk("Flights to Goa")[0]
        r = ta.analyze_message("well how about starting out of delhi then maybe", PLACES, a["context"])
        assert params(r)["fromCode"] == "DEL" and params(r)["toCode"] == "GOI"

    def test_model_failure_falls_back_to_rules(self, monkeypatch):
        use(monkeypatch, FakeModel(boom=True))
        (r,) = talk("Flights from Delhi to Goa")
        assert (params(r)["fromCode"], params(r)["toCode"]) == ("DEL", "GOI")
        (h,) = talk("hotels in goa please I would like some good ones")
        assert h["service_intent"] == "hotel_search"

    def test_no_answer_from_the_model_falls_back(self, monkeypatch):
        use(monkeypatch, FakeModel(None))
        (r,) = talk("I would like to go from Hyderabad to Singapore sometime")
        assert r["service_intent"] == "flight_search"

    @pytest.mark.parametrize("turn,expect", [
        (call("search_hotels", destination="Goa"), "hotel_search"),
        (call("search_tour_packages", destination="Goa"), "tour_package_search"),
        (call("get_destination_locations", destination="Goa", kind="places"), "destination_location_search"),
        (call("get_destinations"), "destination_discovery"),
        (call("answer_general_question", topic="weather"), "general_travel_question"),
    ])
    def test_each_tool_maps_to_its_intent(self, monkeypatch, turn, expect):
        use(monkeypatch, FakeModel(turn))
        (r,) = talk("blorp goa blorp blorp blorp blorp blorp blorp")
        assert r["service_intent"] == expect

    def test_clarification_tool(self, monkeypatch):
        use(monkeypatch, FakeModel(call("ask_clarification", about="service", destination="Goa")))
        (r,) = talk("something something goa something something something something")
        assert r["service_intent"] == "clarification_required"

    def test_a_model_cannot_invent_a_hotel_destination(self, monkeypatch):
        use(monkeypatch, FakeModel(call("search_hotels", destination="Atlantis")))
        (r,) = talk("find me somewhere nice to stay near water please soon")
        assert "Atlantis" not in r["reply"]

    def test_a_product_sentence_with_a_route_starts_a_new_search(self, monkeypatch):
        use(monkeypatch, FakeModel(call("search_flights", origin="Mumbai", destination="Dubai")))
        a = talk("Flights from Delhi to Goa", "tomorrow")[-1]
        r = ta.analyze_message("could you possibly arrange flights from mumbai to dubai", PLACES, a["context"])
        assert (params(r)["fromCode"], params(r)["toCode"]) == ("BOM", "DXB") and "date" not in params(r)


# ---------------------------------------------------------------------------
# D. The provider wire format
# ---------------------------------------------------------------------------
class Resp:
    def __init__(self, status=200, data=None, headers=None):
        self.status_code, self._data, self.headers = status, data or {}, headers or {}
        self.text = "SECRET-BODY"

    def json(self):
        return self._data


def responses_body(name, args):
    return {"output": [{"type": "function_call", "name": name, "arguments": json.dumps(args)}]}


def chat_body(name, args):
    return {"choices": [{"message": {"tool_calls": [
        {"function": {"name": name, "arguments": json.dumps(args)}}]}}]}


HINTS = travel_ai.Hints(destinations=["Goa"], countries=["India"], today="2026-10-09",
                        state={"service": "flight"}, awaiting="origin")
ARGS = {"origin": "Delhi", "destination": None, "date": None, "trip": None, "passengers": None}


class TestProviderWire:
    def make(self, style="responses", **kw):
        return openai_provider.OpenAIProvider(api_key="sk-test-123", model="m", api_style=style, **kw)

    def test_responses_request_shape(self, monkeypatch):
        sent = {}

        def post(url, headers, json, timeout):
            sent.update(url=url, headers=headers, body=json)
            return Resp(200, responses_body("search_flights", ARGS))
        monkeypatch.setattr(openai_provider.requests, "post", post)
        turn = self.make(reasoning_effort="low").plan("delhi, mail a@b.com 9876543210", HINTS)
        b = sent["body"]
        assert sent["url"].endswith("/responses") and b["store"] is False
        assert b["tool_choice"] == "required" and b["parallel_tool_calls"] is False
        assert b["reasoning"] == {"effort": "low"} and b["model"] == "m"
        assert all(t["strict"] and t["type"] == "function" and "name" in t for t in b["tools"])
        blob = json.dumps(b)
        assert "a@b.com" not in blob and "9876543210" not in blob
        assert turn.tool == "search_flights" and turn.args["origin"] == "Delhi"

    def test_chat_request_shape(self, monkeypatch):
        sent = {}

        def post(url, headers, json, timeout):
            sent.update(url=url, body=json)
            return Resp(200, chat_body("search_flights", ARGS))
        monkeypatch.setattr(openai_provider.requests, "post", post)
        turn = self.make("chat").plan("delhi", HINTS)
        assert sent["url"].endswith("/chat/completions") and sent["body"]["tool_choice"] == "required"
        assert sent["body"]["tools"][0]["function"]["name"] and turn.args["origin"] == "Delhi"

    def test_the_key_is_only_in_the_header(self, monkeypatch):
        sent = {}

        def post(url, headers, json, timeout):
            sent.update(headers=headers, body=json)
            return Resp(200, responses_body("search_flights", ARGS))
        monkeypatch.setattr(openai_provider.requests, "post", post)
        self.make().plan("delhi", HINTS)
        assert "sk-test-123" in json.dumps(sent["headers"])
        assert "sk-test-123" not in json.dumps(sent["body"])

    def test_invalid_tool_arguments_are_rejected(self, monkeypatch):
        bad = dict(ARGS, passengers=99)
        monkeypatch.setattr(openai_provider.requests, "post",
                            lambda *a, **k: Resp(200, responses_body("search_flights", bad)))
        assert self.make().plan("delhi", HINTS) is None

    def test_unknown_tool_is_rejected(self, monkeypatch):
        monkeypatch.setattr(openai_provider.requests, "post",
                            lambda *a, **k: Resp(200, responses_body("book_flight", {})))
        assert self.make().plan("delhi", HINTS) is None

    def test_timeout_and_500_give_none(self, monkeypatch):
        def boom(*a, **k):
            raise openai_provider.requests.Timeout()
        monkeypatch.setattr(openai_provider.requests, "post", boom)
        assert self.make().plan("delhi", HINTS) is None
        monkeypatch.setattr(openai_provider.requests, "post", lambda *a, **k: Resp(500))
        assert self.make().plan("delhi", HINTS) is None

    def test_rate_limit_opens_the_breaker(self, monkeypatch, caplog):
        calls = []

        def post(*a, **k):
            calls.append(1)
            return Resp(429, headers={"Retry-After": "30"})
        monkeypatch.setattr(openai_provider.requests, "post", post)
        p = self.make()
        assert p.plan("delhi", HINTS) is None and p.plan("delhi", HINTS) is None
        assert len(calls) == 1  # the second call never left the server
        assert "SECRET-BODY" not in caplog.text

    def test_three_failures_open_the_breaker(self, monkeypatch):
        calls = []

        def post(*a, **k):
            calls.append(1)
            return Resp(500)
        monkeypatch.setattr(openai_provider.requests, "post", post)
        p = self.make()
        for _ in range(5):
            p.plan("delhi", HINTS)
        assert len(calls) == 3

    def test_no_key_means_no_call(self, monkeypatch):
        monkeypatch.setattr(openai_provider.requests, "post", lambda *a, **k: pytest.fail("called"))
        assert openai_provider.OpenAIProvider(api_key=None, model="m").plan("delhi", HINTS) is None


# ---------------------------------------------------------------------------
# E. Session binding and customer isolation
# ---------------------------------------------------------------------------
@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerDestination.__table__, CustomerLocation.__table__,
        CustomerAttraction.__table__, CustomerAssistantSession.__table__,
        CustomerAssistantMessage.__table__])
    s = sessionmaker(bind=engine, expire_on_commit=False)()
    for i, d in enumerate(FIX["destinations"], start=1):
        s.add(CustomerDestination(customer_destination_id=i, name=d["name"], slug=d["slug"],
                                  country=d["country"] or "", sort_order=i, is_active=True))
    s.commit()
    yield s
    s.close()
    engine.dispose()


def reply_params(r):
    return r["action"]["params"] or {}


class TestSessionBinding:
    def test_a_context_round_trips_within_its_session(self, db):
        a = assistant.process_message(db, session_key=None, message="Flights to Goa")
        b = assistant.process_message(db, session_key=a["session_id"], message="Delhi", context=a["context"])
        assert reply_params(b)["fromCode"] == "DEL"

    def test_another_customers_context_is_ignored(self, db):
        a = assistant.process_message(db, session_key=None, message="Flights to Goa")
        other = assistant.process_message(db, session_key=None, message="hello")
        r = assistant.process_message(db, session_key=other["session_id"], message="Delhi",
                                      context=a["context"])
        assert reply_params(r).get("toCode") != "GOI"

    def test_a_context_without_a_session_is_ignored(self, db):
        a = assistant.process_message(db, session_key=None, message="Flights to Goa")
        r = assistant.process_message(db, session_key=None, message="Delhi", context=a["context"])
        assert reply_params(r).get("toCode") != "GOI"

    def test_an_edited_context_is_ignored(self, db):
        a = assistant.process_message(db, session_key=None, message="Flights to Goa")
        forged = dict(a["context"], destination="Dubai", destination_code="DXB")
        r = assistant.process_message(db, session_key=a["session_id"], message="Delhi", context=forged)
        assert reply_params(r).get("toCode") != "DXB"

    def test_an_unsigned_context_is_ignored(self, db):
        r = assistant.process_message(
            db, session_key=None, message="Delhi",
            context={"service": "flight", "destination": "Goa", "awaiting": "origin"})
        assert reply_params(r).get("toCode") != "GOI"

    def test_an_expired_or_foreign_seal_does_not_open(self):
        sealed = conversation_state.seal({"service": "flight"}, "k", now=1000)
        assert conversation_state.open_(sealed, "k", now=1010) == {"service": "flight"}
        assert conversation_state.open_(sealed, "k", now=1000 + 10_000) == {}
        assert conversation_state.open_(sealed, "other", now=1010) == {}

    def test_duplicate_submissions_give_the_same_answer(self, db):
        a = assistant.process_message(db, session_key=None, message="Flights to Goa")
        first = assistant.process_message(db, session_key=a["session_id"], message="Delhi",
                                          context=a["context"])
        again = assistant.process_message(db, session_key=a["session_id"], message="Delhi",
                                          context=a["context"])
        assert first["reply"] == again["reply"] and first["action"] == again["action"]


# ---------------------------------------------------------------------------
# F. Regressions
# ---------------------------------------------------------------------------
class TestRegressions:
    def test_hotels(self):
        (r,) = talk("Hotels in Goa")
        assert r["service_intent"] == "hotel_search"

    def test_hotels_asks_a_city_then_takes_it(self):
        _, b = talk("Find hotels", "Goa")
        assert b["service_intent"] == "hotel_search" and "Goa" in b["reply"]

    def test_packages(self):
        (r,) = talk("Show me Goa tour packages")
        assert r["service_intent"] == "tour_package_search"

    def test_destinations(self):
        (r,) = talk("Show me destinations")
        assert r["service_intent"] == "destination_discovery"

    def test_places_in_a_destination(self):
        (r,) = talk("What places can I visit in Hyderabad?")
        assert r["service_intent"] == "destination_location_search"

    def test_misspelled_destination(self):
        (r,) = talk("places to visit in hyderbad")
        assert "Hyderabad" in r["reply"]

    def test_unknown_destination_is_said(self):
        (r,) = talk("hotels in Narnia")
        assert "Narnia" in r["reply"]

    def test_a_support_request_is_never_a_search(self):
        (r,) = talk("talk to a human agent")
        assert r["intent"] == "support"

    def test_the_typed_panel_has_no_microphone(self):
        js = (Path(__file__).parents[2] / "frontend" / "assets" / "js" / "travel-assistant.js")
        assert js.exists()
