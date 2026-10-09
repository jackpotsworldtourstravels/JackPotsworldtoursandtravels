"""The Travel / Voice Assistant — service intents, entities, follow-ups, routing.

WHAT THIS PINS
The assistant used to treat a bare destination as a hotel request, opened the
packages page (and left the conversation behind) for a package request, had no
way to browse destinations, and kept no memory between sentences. These tests
hold the replacement to the brief's examples, one group per behaviour:

  1.  destination discovery            "Show me destinations", "I want to visit Goa"
  2.  places in a destination          "What places can I visit in Hyderabad?"
  3.  a destination we do not sell     answered, with alternatives — never a silent miss
  4.  tour packages, with and without a destination
  5.  a package with a length          "a three-day trip", "3 nights"
  6.  a package with a style           "family"; and that no filter is invented for it
  7.  hotels, one place                "Hotels in Goa", "Resorts in Bali"
  8.  flights, two ends                "Hyderabad to Delhi", "Flights to Singapore"
  9.  ambiguity is asked about         two places, a bare "holiday"
  10. follow-ups change the last search, and a NEW search replaces it
  11. failures: nothing said, a hostile context, an unknown destination
  12. regression: the flight / hotel / support behaviour that predates all this

The catalogue is a hand-built ``Places`` (no network, no database) in every
test except the last group, which runs the real ``process_message`` over an
in-memory database so the response is validated against the real response model.

Run:  python -m pytest backend/tests/test_travel_assistant_voice.py -q
"""
from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models_customer import (
    Base,
    Customer,
    CustomerAssistantMessage,
    CustomerAssistantSession,
    CustomerAttraction,
    CustomerDestination,
    CustomerLocation,
)
from app.schemas.customer_assistant import AssistantMessageResponse
from app.services import customer_assistant_service as assistant
from app.services import travel_ai_assistant as ta

# ---------------------------------------------------------------------------
# The catalogue, as load_places() would have built it from the database.
# ---------------------------------------------------------------------------
_DEST = [
    ("hyderabad", "Hyderabad", "India"), ("goa", "Goa", "India"),
    ("mumbai", "Mumbai", "India"), ("delhi", "Delhi", "India"),
    ("kashmir", "Kashmir", "India"), ("dubai", "Dubai", "United Arab Emirates"),
    ("bali", "Bali", "Indonesia"), ("singapore", "Singapore", "Singapore"),
    ("maldives", "Maldives", "Maldives"),
]
PLACES = ta.Places(
    destinations=[(s, n) for s, n, _ in _DEST],
    attractions=[("hyderabad", "charminar", "Charminar"), ("goa", "fort-aguada", "Fort Aguada")],
    countries={},
)
for _s, _n, _c in _DEST:
    PLACES.countries.setdefault(_c, []).append((_s, _n))

CATALOGUE_NAMES = {n for _, n, _ in _DEST}


def say(text: str, ctx: dict | None = None) -> dict:
    return ta.analyze_message(text, PLACES, ctx)


def act(result: dict) -> str:
    return result["action"]["type"]


def params(result: dict) -> dict:
    return result["action"]["params"]


def talk(*sentences: str) -> list[dict]:
    """A conversation: each reply's context is sent back with the next sentence,
    exactly as the browser does."""
    out, ctx = [], None
    for s in sentences:
        r = say(s, ctx)
        out.append(r)
        ctx = r["context"]
    return out


# ---------------------------------------------------------------------------
# 1. Destination discovery
# ---------------------------------------------------------------------------
class TestDestinationDiscovery:
    def test_generic_request_opens_the_shelf(self):
        r = say("Show me destinations.")
        assert r["service_intent"] == "destination_discovery"
        assert act(r) == "show_destinations"
        assert params(r) == {}
        assert r["entities"]["destination"] is None

    def test_the_reply_names_only_catalogue_destinations(self):
        r = say("Show me destinations")
        named = [n for n in CATALOGUE_NAMES if n in r["reply"]]
        assert named, "the reply should list some destinations we actually sell"

    def test_a_country_is_answered_with_its_cities(self):
        r = say("Show destinations in India")
        assert r["service_intent"] == "destination_discovery"
        assert act(r) == "show_destinations"
        assert params(r) == {"country": "India"}
        assert "Goa" in r["reply"] and "Dubai" not in r["reply"]

    @pytest.mark.parametrize("sentence", ["I want to visit Goa.", "Goa", "planning to travel to Goa"])
    def test_a_named_destination_is_shown(self, sentence):
        r = say(sentence)
        assert r["service_intent"] == "destination_discovery"
        assert act(r) == "show_destination"
        assert params(r) == {"destination": "goa", "name": "Goa"}      # slug, as the API's id
        # The three things worth doing next are offered as sentences it understands.
        assert {"Places to visit in Goa", "Goa tour packages", "Hotels in Goa"} <= set(r["suggestions"])

    def test_every_offered_follow_up_is_understood(self):
        # An unanswerable suggestion is worse than none.
        for chip in say("I want to visit Goa")["suggestions"]:
            assert say(chip)["intent"] != "fallback", chip


# ---------------------------------------------------------------------------
# 2 + 3. Places inside a destination, and a destination we do not sell
# ---------------------------------------------------------------------------
class TestPlaces:
    @pytest.mark.parametrize("sentence", [
        "What places can I visit in Hyderabad?", "Places to visit in Hyderabad",
        "Show famous places in Hyderabad", "things to do in Hyderabad",
    ])
    def test_places_are_listed_from_the_destinations_attractions(self, sentence):
        r = say(sentence)
        assert r["service_intent"] == "destination_location_search"
        assert act(r) == "show_places"
        assert params(r) == {"destination": "hyderabad", "name": "Hyderabad", "list": "attractions"}

    def test_locations_and_areas_ask_for_the_other_list(self):
        for sentence in ("Show locations in Mumbai", "What areas does Mumbai have"):
            r = say(sentence)
            assert act(r) == "show_places"
            assert params(r)["list"] == "locations"
        # ...and an area has no page of its own, so the reply must not promise one.
        assert "page" not in say("Show locations in Mumbai")["reply"]

    def test_a_destination_we_do_not_sell_is_answered_not_dropped(self):
        r = say("places to visit in Paris")
        assert r["service_intent"] == "destination_location_search"
        assert act(r) == "none"
        assert "Paris" in r["reply"] and "couldn't find that location" in r["reply"]
        # Alternatives come from the catalogue, so they are true today.
        assert any(n in r["reply"] for n in CATALOGUE_NAMES)
        assert any(s.startswith("Show me ") for s in r["suggestions"])

    def test_an_unknown_destination_is_not_silently_sent_to_hotels(self):
        r = say("I want to visit Paris")
        assert r["service_intent"] == "destination_discovery"
        assert act(r) == "none"
        assert "Paris" in r["reply"]
        assert "Hotels in Paris" in r["suggestions"]       # the one search that is not limited to the shelf

    def test_places_without_a_destination_asks_which(self):
        r = say("show me places to visit")
        assert act(r) == "none" and "destination" in r["reply"].lower()


# ---------------------------------------------------------------------------
# 4 + 5 + 6. Tour packages
# ---------------------------------------------------------------------------
class TestTourPackages:
    def test_without_a_destination_shows_the_whole_shelf(self):
        r = say("Show tour packages.")
        assert r["service_intent"] == "tour_package_search"
        assert act(r) == "show_packages"
        assert params(r) == {}
        assert r["suggestions"], "offers destinations to narrow by"

    @pytest.mark.parametrize("sentence,dest", [
        ("I want a Goa tour package.", "Goa"),
        ("Find holiday packages for Bali.", "Bali"),
        ("Bali tour package", "Bali"),
        ("Show me Dubai packages", "Dubai"),
    ])
    def test_with_a_destination(self, sentence, dest):
        r = say(sentence)
        assert r["service_intent"] == "tour_package_search"
        assert act(r) == "show_packages"
        assert params(r) == {"dest": dest}

    @pytest.mark.parametrize("sentence,days", [
        ("I need a three-day trip", 3), ("a 5 day Goa package", 5),
        ("3 nights in Bali package", 4),               # the API counts DAYS
        ("a week in Dubai package", 7), ("two weeks Maldives tour", 14),
    ])
    def test_a_length(self, sentence, days):
        r = say(sentence)
        assert act(r) == "show_packages"
        assert params(r)["days"] == days
        assert r["entities"]["days"] == days

    def test_a_trip_with_a_length_is_a_package_but_a_bare_trip_is_a_question(self):
        assert say("I need a three-day trip")["service_intent"] == "tour_package_search"
        assert say("I need a trip")["service_intent"] == "clarification_required"

    def test_a_length_that_is_not_a_trip_length_is_ignored(self):
        assert "days" not in params(say("Goa tour package for 60 days"))
        assert say("Goa tour package")["entities"]["days"] is None

    def test_family_preference(self):
        r = say("Show family tour packages.")
        assert act(r) == "show_packages"
        assert params(r) == {"preference": "family"}
        # The packages API has no style filter, so none is sent: the browser
        # matches the packages' own text and says so when nothing matches.
        assert "pkgType" not in params(r)

    def test_a_package_type_the_api_does_support(self):
        assert params(say("international tour packages")) == {"pkgType": "international"}
        assert params(say("pilgrimage packages")) == {"pkgType": "pilgrimage"}

    def test_a_weekend_names_a_month_and_a_saturday(self):
        month, day = ta._find_package_when("packages for next weekend", dt.date(2026, 10, 9))
        # 9 Oct 2026 is a Friday; "this weekend" is the 10th, "next weekend" the 17th.
        assert (month, day) == ("2026-10", "2026-10-17")
        assert dt.date.fromisoformat(day).weekday() == 5
        assert ta._find_package_when("packages this weekend", dt.date(2026, 10, 9)) == ("2026-10", "2026-10-10")

    def test_a_month_is_its_next_occurrence(self):
        assert ta._find_package_when("Goa packages in March", dt.date(2026, 10, 9))[0] == "2027-03"
        assert ta._find_package_when("packages in December", dt.date(2026, 10, 9))[0] == "2026-12"
        assert ta._find_package_when("packages next month", dt.date(2026, 12, 20))[0] == "2027-01"

    def test_may_is_a_month_only_after_a_preposition(self):
        assert ta._find_package_when("may I see packages")[0] is None
        assert ta._find_package_when("packages in May", dt.date(2026, 10, 9))[0] == "2027-05"

    def test_packages_for_next_weekend_sends_the_month_filter(self):
        r = say("Show packages for next weekend")
        assert act(r) == "show_packages"
        assert len(params(r)["month"]) == 7 and params(r)["month"][4] == "-"

    def test_the_reply_never_states_a_result_or_a_price(self):
        # What exists, and what it costs, is read from the packages API by the
        # browser. A figure or a count here could only have been invented.
        for s in ("Show tour packages", "I want a Goa tour package", "family packages"):
            reply = say(s)["reply"].lower()
            assert "₹" not in reply and "rs." not in reply
            assert "found" not in reply and "available" not in reply and "we have" not in reply

    def test_a_route_inside_a_package_is_still_about_where_it_goes(self):
        r = say("tour package from Hyderabad to Goa")
        assert r["service_intent"] == "tour_package_search"
        assert params(r) == {"dest": "Goa"}                      # not Hyderabad, and not a flight
        assert r["entities"]["origin"] == "Hyderabad"

    def test_a_package_to_a_city_we_do_not_sell_is_about_that_city(self):
        assert params(say("package from Hyderabad to Colombo"))["dest"] == "Colombo"


# ---------------------------------------------------------------------------
# 7 + 8. Hotels and flights
# ---------------------------------------------------------------------------
class TestHotelsAndFlights:
    @pytest.mark.parametrize("sentence,dest", [
        ("Hotels in Goa", "Goa"), ("Resorts in Bali", "Bali"),
        ("find me a hotel in Dubai", "Dubai"), ("I need accommodation in Mumbai", "Mumbai"),
    ])
    def test_one_place_and_a_stay_is_a_hotel_search(self, sentence, dest):
        r = say(sentence)
        assert r["service_intent"] == "hotel_search"
        assert act(r) == "search_hotels"
        assert params(r)["dest"] == dest

    def test_a_landmark_gets_hotels_near_it(self):
        r = say("Show hotels near Charminar")
        assert act(r) == "hotels_near"
        assert params(r) == {"destination": "hyderabad", "attraction": "charminar"}

    def test_a_route_is_a_flight(self):
        r = say("Hyderabad to Delhi")
        assert r["service_intent"] == "flight_search"
        assert act(r) == "search_flights"
        assert (params(r)["from"], params(r)["to"]) == ("Hyderabad", "Delhi")
        assert (params(r)["fromCode"], params(r)["toCode"]) == ("HYD", "DEL")

    def test_flights_to_a_city_asks_for_the_origin(self):
        r = say("Flights to Singapore")
        assert r["service_intent"] == "flight_search"
        assert params(r)["to"] == "Singapore" and "from" not in params(r)
        assert "from" in r["reply"].lower()

    def test_a_city_the_catalogue_has_never_heard_of_is_still_a_flight(self):
        r = say("Hyderabad to Colombo")
        assert (act(r), params(r)["to"]) == ("search_flights", "Colombo")


# ---------------------------------------------------------------------------
# 9. Ambiguity is asked about, not guessed at
# ---------------------------------------------------------------------------
class TestAmbiguity:
    def test_a_holiday_in_a_place_asks_what_to_look_up(self):
        r = say("I want a holiday in Goa")
        assert r["service_intent"] == "clarification_required"
        assert act(r) == "none"                                  # no page opened before it is resolved
        assert {"Goa tour packages", "Hotels in Goa", "Flights to Goa"} <= set(r["suggestions"])

    def test_every_clarification_choice_is_understood_and_resolves_it(self):
        want = {"Goa tour packages": "tour_package_search", "Hotels in Goa": "hotel_search",
                "Flights to Goa": "flight_search"}
        for chip, service in want.items():
            assert say(chip)["service_intent"] == service, chip

    def test_a_bare_holiday_with_no_place_asks_too(self):
        r = say("plan a holiday")
        assert r["service_intent"] == "clarification_required"
        assert r["suggestions"]

    def test_two_places_and_no_service_is_not_a_flight(self):
        r = say("Goa Hyderabad")
        assert r["service_intent"] == "clarification_required"
        assert act(r) == "none"
        assert "Goa" in r["reply"] and "Hyderabad" in r["reply"]
        assert "Flights from Goa to Hyderabad" in r["suggestions"]

    def test_two_places_do_not_force_a_flight_when_a_package_was_asked_for(self):
        assert say("tour package from Hyderabad to Goa")["service_intent"] == "tour_package_search"
        assert say("hotels in Goa near Hyderabad")["service_intent"] == "hotel_search"

    def test_a_trip_from_a_to_b_asks_and_is_about_b(self):
        r = say("a trip from Hyderabad to Goa")
        assert r["service_intent"] == "clarification_required"
        assert "Goa" in r["reply"] and "Hyderabad" not in r["reply"]

    def test_a_question_about_a_place_is_not_a_request_to_go_there(self):
        r = say("best time to visit Goa")
        assert r["service_intent"] == "general_travel_question"
        assert act(r) == "none"
        assert "Goa" in r["reply"]
        # ...and a product word makes it a request again.
        assert say("how long is the flight to Dubai")["service_intent"] == "flight_search"


# ---------------------------------------------------------------------------
# 10. Follow-ups
# ---------------------------------------------------------------------------
class TestFollowUps:
    def test_the_brief_s_conversation(self):
        goa, family, four, bali = talk(
            "Show me Goa tour packages", "Only family packages", "For four people",
            "Change the destination to Bali")
        assert params(goa) == {"dest": "Goa"}
        # "Only family packages" changes the SAME search.
        assert params(family) == {"dest": "Goa", "preference": "family"}
        assert "Updated" in family["reply"]
        assert params(four) == {"dest": "Goa", "preference": "family", "travellers": 4}
        # The destination changes; everything else is kept.
        assert params(bali) == {"dest": "Bali", "preference": "family", "travellers": 4}
        assert bali["context"]["destination_slug"] == "bali"

    @pytest.mark.parametrize("sentence,expected", [
        ("make it 5 days", {"days": 5}), ("in December", {"month": "-12"}),
        ("only international ones", {"pkgType": "international"}),
        ("for two adults", {"travellers": 2}), ("honeymoon instead", {"preference": "honeymoon"}),
    ])
    def test_each_kind_of_change(self, sentence, expected):
        _, after = talk("Show me Goa tour packages", sentence)
        assert act(after) == "show_packages"
        assert params(after)["dest"] == "Goa"
        for key, value in expected.items():
            got = params(after)[key]
            assert got.endswith(value) if key == "month" else got == value

    def test_bare_words_after_a_search_are_a_follow_up(self):
        _, after = talk("Show me Goa tour packages", "Dubai instead")
        assert params(after)["dest"] == "Dubai"

    def test_a_new_search_replaces_the_context_it_does_not_merge_into_it(self):
        *_, dubai = talk("Show me Goa tour packages", "Only family packages", "For four people",
                         "Show me Dubai packages")
        # Not "family" and not "4 travellers": a different search.
        assert params(dubai) == {"dest": "Dubai"}
        assert dubai["context"] == {"service": "package", "destination": "Dubai",
                                    "destination_slug": "dubai"}

    def test_a_different_product_starts_a_different_search(self):
        *_, hotels = talk("Show me Goa tour packages", "Only family packages", "Hotels in Goa")
        assert hotels["service_intent"] == "hotel_search"
        assert "preference" not in hotels["context"]

    def test_dates_and_destinations_do_not_leak_into_an_unrelated_search(self):
        *_, flight = talk("hotels in Goa", "tomorrow", "Flights from Hyderabad to Delhi")
        assert flight["service_intent"] == "flight_search"
        assert "Goa" not in str(flight["context"]) and "date" not in flight["context"]

    def test_a_hotel_search_can_be_changed_too(self):
        _, tomorrow = talk("hotels in Goa", "tomorrow")
        assert tomorrow["service_intent"] == "hotel_search"
        assert params(tomorrow)["dest"] == "Goa" and params(tomorrow)["checkIn"]

    def test_a_places_search_can_change_destination(self):
        _, other = talk("places to visit in Goa", "what about Hyderabad")
        assert act(other) == "show_places" and params(other)["destination"] == "hyderabad"

    def test_small_talk_and_nonsense_leave_the_search_alone(self):
        *_, thanks = talk("Show me Goa tour packages", "thanks")
        assert thanks["context"]["destination"] == "Goa"
        *_, mumble = talk("Show me Goa tour packages", "qwerty zxcv")
        assert mumble["context"]["destination"] == "Goa"        # a mis-hear must not wipe a good search

    def test_leaving_for_support_clears_the_search(self):
        *_, support = talk("Show me Goa tour packages", "talk to support")
        assert support["intent"] == "support" and support["context"] is None

    def test_a_follow_up_with_no_context_is_just_a_sentence(self):
        assert say("Only family packages")["service_intent"] == "tour_package_search"
        assert say("For four people")["intent"] != "package"

    def test_a_sentence_that_changes_nothing_is_read_afresh(self):
        # Not every sentence after a search is a change to it.
        assert say("thanks", {"service": "package", "destination": "Goa"})["intent"] == "thanks"

    def test_for_three_days_is_a_length_not_a_party_of_three(self):
        assert ta._find_passengers("packages for 3 days") is None
        assert ta._find_passengers("packages for three people") == 3
        assert ta._find_passengers("a family of four") == 4


# ---------------------------------------------------------------------------
# 11. Failures and hostile input
# ---------------------------------------------------------------------------
class TestRobustness:
    def test_nothing_said(self):
        r = say("   ")
        assert r["intent"] == "fallback" and r["action"]["type"] == "none"

    def test_gibberish_is_a_fallback_with_a_way_forward(self):
        r = say("asdkj qweoiu")
        assert r["intent"] == "fallback" and r["suggestions"]

    @pytest.mark.parametrize("hostile", [
        "not a dict", ["service", "package"], {"service": "<script>"}, {"service": "package", "days": 9999},
        {"service": "package", "destination": "x" * 500, "month": "banana", "preference": "'; DROP"},
        {"service": "package", "passengers": True, "days": "3", "pkg_type": {"a": 1}},
        {"__proto__": {"service": "package"}}, {"service": "flight", "origin": ["a"], "trip": "sideways"},
    ])
    def test_a_hostile_context_is_cleaned_not_trusted(self, hostile):
        cleaned = ta.clean_context(hostile)
        assert set(cleaned) <= {"service", *ta._CTX_TEXT_KEYS, "days", "passengers"}
        assert cleaned.get("days", 1) <= 30 and cleaned.get("passengers", 1) <= 9
        assert all(len(v) <= 80 for v in cleaned.values() if isinstance(v, str))
        assert cleaned.get("month", "2026-01") != "banana" and cleaned.get("preference", "family") == "family"
        # And it cannot crash a request.
        assert say("Only family packages", hostile)["reply"]

    def test_a_context_cannot_widen_what_a_sentence_could_do(self):
        # The context only fills fields a follow-up sentence leaves out; the
        # action it produces is still one of the fixed set.
        r = say("for four people", {"service": "package", "destination": "Goa"})
        assert act(r) in {"show_packages", "none"}

    def test_the_reply_to_a_sentence_never_echoes_markup_as_an_action(self):
        r = say("<img src=x onerror=alert(1)> packages")
        assert r["action"]["type"] in {"show_packages", "none"}


# ---------------------------------------------------------------------------
# 12. Regression — what predates this change must still hold
# ---------------------------------------------------------------------------
class TestRegression:
    @pytest.mark.parametrize("sentence", [
        "Hyderabad to Colombo", "Book a flight from Hyderabad to Colombo",
        "I need a ticket Hyderabad Colombo", "Fly me from Hyderabad to Colombo",
        "Take me from Hyderabad airport to Colombo", "I want to travel from Hyderabad to Colombo",
        "I would like to go from Hyderabad to Colombo",
    ])
    def test_a_spoken_route_is_a_flight_both_ends_the_right_way_round(self, sentence):
        r = say(sentence)
        assert r["intent"] == "flight" and act(r) == "search_flights"
        assert (r["entities"]["origin"], r["entities"]["destination"]) == ("Hyderabad", "Colombo")

    def test_a_route_carries_a_date_only_when_one_was_spoken(self):
        assert "date" not in params(say("Hyderabad to Delhi"))
        assert "date" in params(say("Hyderabad to Delhi tomorrow"))

    def test_hyderabad_and_hyd_are_the_same_airport(self):
        assert params(say("hyd to cmb"))["fromCode"] == "HYD"

    def test_the_same_place_at_both_ends_is_not_a_route(self):
        assert "to" not in params(say("Goa to Goa flights"))

    def test_a_package_with_a_route_inside_it_stays_a_package(self):
        assert say("honeymoon package from Delhi to Goa")["intent"] == "package"

    def test_hotels_in_a_country_are_answered_with_its_cities(self):
        r = say("Show hotels in India")
        assert r["intent"] == "hotel" and act(r) == "none"
        assert "Goa" in r["reply"] and r["suggestions"]

    def test_a_country_with_one_city_goes_straight_through(self):
        r = say("hotels in Singapore")
        assert (act(r), params(r)["dest"]) == ("search_hotels", "Singapore")
        r = say("tour packages in Indonesia")
        assert (act(r), params(r)["dest"]) == ("show_packages", "Bali")

    @pytest.mark.parametrize("sentence,intent", [
        ("Talk to support", "support"), ("I want to talk to someone", "support"),
        ("cancel my ticket", "support"), ("where is my booking", "bookings"),
        ("hello", "greeting"), ("thanks", "thanks"),
    ])
    def test_a_person_still_outranks_a_search_box(self, sentence, intent):
        assert say(sentence)["intent"] == intent

    def test_the_legacy_intent_values_are_unchanged(self):
        # Stored history and the browser key off these; service_intent is additive.
        assert say("hotels in Goa")["intent"] == "hotel"
        assert say("Hyderabad to Delhi")["intent"] == "flight"
        assert say("Goa tour package")["intent"] == "package"
        assert say("places to visit in Goa")["intent"] == "places"

    def test_it_still_quotes_no_fare_and_claims_no_availability(self):
        for s in ("Hyderabad to Delhi", "hotels in Goa", "Goa tour package", "places to visit in Goa",
                  "Show me destinations", "I want a holiday in Goa"):
            reply = say(s)["reply"]
            assert "₹" not in reply and "available" not in reply.lower() and "from Rs" not in reply

    def test_a_destination_added_to_the_catalogue_is_understood_without_an_edit(self):
        extra = ta.Places(destinations=PLACES.destinations + [("kerala", "Kerala")],
                          attractions=[], countries=dict(PLACES.countries))
        r = ta.analyze_message("Kerala tour package", extra)
        assert params(r) == {"dest": "Kerala"}


# ---------------------------------------------------------------------------
# Integration — the real service over a real (in-memory) database
# ---------------------------------------------------------------------------
@pytest.fixture()
def seeded_db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[
        Customer.__table__, CustomerDestination.__table__, CustomerLocation.__table__,
        CustomerAttraction.__table__, CustomerAssistantSession.__table__,
        CustomerAssistantMessage.__table__,
    ])
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    for i, (slug, name, country) in enumerate(_DEST, start=1):
        session.add(CustomerDestination(customer_destination_id=i, name=name, slug=slug,
                                        country=country, sort_order=i, is_active=True))
    session.commit()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


class TestOverTheRealService:
    def test_a_conversation_is_stored_and_validates_against_the_response_model(self, seeded_db):
        first = assistant.process_message(seeded_db, session_key=None, kind="voice",
                                          message="Show me Goa tour packages")
        model = AssistantMessageResponse.model_validate(first)
        assert model.service_intent == "tour_package_search"
        assert model.action.type == "show_packages" and model.action.params == {"dest": "Goa"}
        # The held search is sealed (signature + issue time) on its way out.
        assert {k: v for k, v in model.context.items() if not k.startswith("_")} == {
            "service": "package", "destination": "Goa", "destination_slug": "goa"}
        assert model.context["_sig"] and model.context["_at"]

        second = assistant.process_message(
            seeded_db, session_key=first["session_id"], kind="voice",
            message="Only family packages", context=first["context"])
        assert second["session_id"] == first["session_id"]
        assert second["action"]["params"] == {"dest": "Goa", "preference": "family"}
        assert second["entities"]["preference"] == "family"
        AssistantMessageResponse.model_validate(second)

        history = assistant.history(seeded_db, first["session_id"])
        assert [m["sender"] for m in history] == ["user", "assistant"] * 2

    def test_the_catalogue_comes_from_the_database_not_from_the_code(self, seeded_db):
        r = assistant.process_message(seeded_db, session_key=None, message="Show destinations in India")
        assert "Goa" in r["reply"] and "Dubai" not in r["reply"]
        seeded_db.add(CustomerDestination(customer_destination_id=99, name="Jaipur", slug="jaipur",
                                          country="India", sort_order=99, is_active=True))
        seeded_db.commit()
        r = assistant.process_message(seeded_db, session_key=None, message="I want to visit Jaipur")
        assert r["action"]["params"] == {"destination": "jaipur", "name": "Jaipur"}

    def test_an_inactive_destination_is_not_offered(self, seeded_db):
        seeded_db.query(CustomerDestination).filter_by(slug="bali").update({"is_active": False})
        seeded_db.commit()
        r = assistant.process_message(seeded_db, session_key=None, message="Show me Bali")
        assert r["action"]["type"] != "show_destination"

    def test_an_empty_message_is_a_gentle_miss_and_keeps_the_context(self, seeded_db):
        held = {"service": "package", "destination": "Goa", "destination_slug": "goa"}
        first = assistant.process_message(seeded_db, session_key=None, message="Show me Goa tour packages")
        r = assistant.process_message(seeded_db, session_key=first["session_id"], message="   ",
                                      context=first["context"])
        body = {k: v for k, v in r["context"].items() if not k.startswith("_")}
        assert r["intent"] == "fallback" and body == held

    def test_a_hostile_context_through_the_service(self, seeded_db):
        r = assistant.process_message(seeded_db, session_key=None, message="Only family packages",
                                      context={"service": "package", "destination": "x" * 999})
        AssistantMessageResponse.model_validate(r)
        assert len(str(r["context"])) < 400
