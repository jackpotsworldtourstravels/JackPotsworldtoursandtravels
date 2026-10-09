"""Typo-tolerant place matching, and what the assistant does with a near miss.

Two layers, one catalogue. ``tests/fixtures/catalogue_places.json`` is a snapshot
of the production names (15 destinations, 93 famous places, 83 areas, each with
the slug and parent the endpoints return), so these tests run against real
spellings, real near-neighbours ("Baga" / "Baga Beach", "MG Road" / "MI Road")
and real structure — and never need a database or a network.

THE THRESHOLD, AS EVIDENCE (place_matcher.SUGGEST_AT = 0.80). Measured on this
catalogue by the tests below and by the sweep in the change report:

    threshold   recall on single mistakes   false positives (96 places/words we don't sell)
      0.70            100.0%                      0
      0.78            100.0%                      0
      0.80            100.0%                      0      <- chosen: the lowest value that keeps
      0.84             93.7%                      0         every single-edit mistake of a 5-letter name
      0.88             76.4%                      0
      0.92             40.4%                      0

A 5-letter name with one slip scores exactly 0.80, so a higher threshold starts
losing real mistakes at once; a lower one admits nothing more that a speaker
would plausibly mean while narrowing the gap to the nearest pair of genuinely
different names (0.833 — MG Road / MI Road, which is a real ambiguity).

Run:  python -m pytest backend/tests/test_place_matcher.py -q
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from app.services import place_matcher as pm
from app.services import travel_ai_assistant as ta

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "catalogue_places.json")
                     .read_text(encoding="utf-8"))


def build_places(extra_destinations=(), extra_attractions=(), extra_locations=()) -> ta.Places:
    dests = FIXTURE["destinations"]
    places = ta.Places(
        destinations=[(d["slug"], d["name"]) for d in dests] + list(extra_destinations),
        attractions=[tuple(a) for a in FIXTURE["attractions"]] + list(extra_attractions),
        locations=[tuple(a) for a in FIXTURE["locations"]] + list(extra_locations),
        countries={},
    )
    for d in dests:
        if d["country"]:
            places.countries.setdefault(d["country"], []).append((d["slug"], d["name"]))
    return places


PLACES = build_places()
CANDS = PLACES.candidates()


def say(text, ctx=None, places=PLACES):
    return ta.analyze_message(text, places, ctx)


def act(r):
    return r["action"]["type"]


def names(res: pm.Resolution) -> list[str]:
    return [m.candidate.name for m in res.matches]


# ===========================================================================
# normalize / similarity
# ===========================================================================
class TestNormalise:
    @pytest.mark.parametrize("raw,want", [
        ("  Banjara--HILLS ", "banjara hills"),
        ("banjara     hills", "banjara hills"),
        ("Café  de  Paris", "cafe de paris"),
        ("Dal Lake's", "dal lakes"),
        ("Tipu Sultan’s Summer Palace", "tipu sultans summer palace"),
        ("Bandra-Worli Sea Link", "bandra worli sea link"),
        ("Atlantis, The Palm", "atlantis the palm"),
        ("Hi-Tec & City", "hi tec and city"),
        ("", ""), (None, ""), ("   ", ""), ("!!!", ""),
    ])
    def test_case_whitespace_punctuation_and_diacritics(self, raw, want):
        assert pm.normalize(raw) == want

    def test_squash_removes_spaces_only(self):
        assert pm.squash("hi tec city") == pm.squash("hitec city")

    def test_a_swap_is_one_edit(self):
        assert pm.damerau_levenshtein("hyderabad", "hydearabad") == 1
        assert pm.damerau_levenshtein("kitten", "sitting") == 3
        assert pm.damerau_levenshtein("", "abc") == 3 and pm.damerau_levenshtein("abc", "abc") == 0


class TestSimilarity:
    def test_only_presentation_differences_are_exact(self):
        assert pm.similarity("  BANJARA   hills ", "Banjara Hills") == pm.EXACT
        assert pm.similarity("Banjara-Hills", "Banjara Hills") == pm.EXACT
        assert pm.similarity("banjarahills", "Banjara Hills") == pm.SQUASHED_EXACT

    def test_a_slip_is_close_and_a_different_word_is_not(self):
        assert pm.similarity("Charminnar", "Charminar") >= pm.SUGGEST_AT
        assert pm.similarity("Hyderbad", "Hyderabad") >= pm.SUGGEST_AT
        assert pm.similarity("Delhi", "Dubai") < pm.SUGGEST_AT
        assert pm.similarity("Mumbai", "Dubai") < pm.SUGGEST_AT

    def test_short_names_may_only_match_exactly(self):
        # Goa is one letter from Gaya and has nothing to do with it.
        assert pm.similarity("Gaya", "Goa") == 0.0
        assert pm.similarity("Goa", "Goa") == pm.EXACT
        assert pm.similarity("Bagga", "Baga") == 0.0         # 4 letters stored: exact only

    def test_what_was_heard_must_be_long_enough_to_carry_a_slip(self):
        assert pm.similarity("dlh", "Delhi") == 0.0
        assert pm.similarity("dlhi", "Delhi") >= pm.SUGGEST_AT

    def test_words_are_judged_one_by_one(self):
        # A slip in one word of a long name is judged on that word.
        assert pm.similarity("Gateway of Indya", "Gateway of India") >= 0.9
        # ...but a different word is a different place.
        assert pm.similarity("North Goa", "South Goa") < pm.SUGGEST_AT

    def test_two_swapped_first_letters_are_one_slip(self):
        assert pm.similarity("najuna", "Anjuna") >= pm.SUGGEST_AT

    def test_unrelated_words_sharing_a_few_letters_do_not_match(self):
        for a, b in [("Salem", "Delhi"), ("Pariss", "Palace"), ("Banana", "Bangkok"),
                     ("Holiday", "Hyderabad"), ("Mountain", "Maldives")]:
            assert pm.similarity(a, b) < pm.SUGGEST_AT, (a, b)


# ===========================================================================
# resolve — the brief's scenarios, against the real catalogue
# ===========================================================================
class TestResolve:
    # 1. exact destination -------------------------------------------------
    def test_exact_destination(self):
        r = pm.resolve("Hyderabad", CANDS)
        assert r.outcome == "exact"
        m = r.best.candidate
        assert (m.kind, m.slug, m.name, m.parent_slug) == ("destination", "hyderabad", "Hyderabad", None)

    # 2. exact location ----------------------------------------------------
    def test_exact_famous_place_carries_its_parent(self):
        r = pm.resolve("Charminar", CANDS)
        assert r.outcome == "exact"
        m = r.best.candidate
        assert (m.kind, m.slug, m.name, m.parent_slug, m.parent_name) == (
            "attraction", "charminar", "Charminar", "hyderabad", "Hyderabad")

    def test_exact_area_carries_its_parent(self):
        m = pm.resolve("Panaji", CANDS).best.candidate
        assert (m.kind, m.slug, m.parent_slug) == ("area", "panaji", "goa")

    # 3. a misspelling -----------------------------------------------------
    def test_charminnar_suggests_charminar_with_the_stored_name_slug_and_parent(self):
        r = pm.resolve("Charminnar", CANDS)
        assert r.outcome == "suggest"
        m = r.best.candidate
        # The CANONICAL record, not a corrected spelling generated from the input.
        assert (m.name, m.slug, m.parent_slug) == ("Charminar", "charminar", "hyderabad")
        assert r.heard == "charminnar"
        assert 0.80 <= r.best.score < pm.SQUASHED_EXACT

    @pytest.mark.parametrize("heard,want", [
        ("Hyderbad", "Hyderabad"), ("Hydrabad", "Hyderabad"), ("Bengaluru", "Bengaluru"),
        ("Mumbay", "Mumbai"), ("Maldivs", "Maldives"), ("Singapor", "Singapore"),
        ("Golconda Fortt", "Golconda Fort"), ("Gateway of Indya", "Gateway of India"),
        ("Burj Khalifah", "Burj Khalifa"), ("Banjara Hils", "Banjara Hills"),
    ])
    def test_common_mispronunciations_resolve_to_the_real_record(self, heard, want):
        r = pm.resolve(heard, CANDS)
        assert r.outcome in ("exact", "suggest"), (heard, r)
        assert want in names(r)

    def test_the_matcher_returns_only_stored_records(self):
        stored = {(c.kind, c.slug, c.name, c.parent_slug) for c in CANDS}
        for heard in ("Charminnar", "Hyderbad", "Banjara Hils", "Calangute bech"):
            for m in pm.resolve(heard, CANDS).matches:
                c = m.candidate
                assert (c.kind, c.slug, c.name, c.parent_slug) in stored

    # 4. case and whitespace -----------------------------------------------
    @pytest.mark.parametrize("heard", ["charminar", "CHARMINAR", "  Charminar  ", "Char minar", "charminar."])
    def test_case_and_whitespace_are_not_mistakes(self, heard):
        r = pm.resolve(heard, CANDS)
        assert r.outcome == "exact" and r.best.candidate.slug == "charminar"

    @pytest.mark.parametrize("heard", ["banjara hills", "BANJARA  HILLS", "Banjara-Hills", "  banjara   hills "])
    def test_punctuation_differences_are_not_mistakes(self, heard):
        assert pm.resolve(heard, CANDS).outcome == "exact"

    # 5. several plausible matches -----------------------------------------
    def test_a_slip_between_two_real_places_offers_both(self):
        r = pm.resolve("mh road", CANDS)
        assert r.outcome == "multiple"
        assert {"MG Road", "MI Road"} <= set(names(r))
        assert len({m.candidate.parent_slug for m in r.matches}) >= 1

    def test_the_same_name_under_two_destinations_asks_which(self):
        twin = [pm.Candidate("attraction", "old-fort", "Old Fort", "delhi", "Delhi"),
                pm.Candidate("attraction", "old-fort", "Old Fort", "jaipur", "Jaipur")]
        r = pm.resolve("old fort", twin)
        assert r.outcome == "multiple"
        assert [m.candidate.parent_name for m in r.matches] == ["Delhi", "Jaipur"]
        assert r.best.candidate.label in ("Old Fort · Delhi", "Old Fort · Jaipur")

    def test_the_named_parent_settles_it(self):
        twin = [pm.Candidate("attraction", "old-fort", "Old Fort", "delhi", "Delhi"),
                pm.Candidate("attraction", "old-fort", "Old Fort", "jaipur", "Jaipur")]
        r = pm.resolve("old fort", twin, parent_slugs=("jaipur",))
        assert r.outcome == "exact" and r.best.candidate.parent_slug == "jaipur"

    def test_a_place_that_is_also_an_area_is_one_place(self):
        # Dal Lake is both a famous place and an area of Kashmir.
        r = pm.resolve("Dal Lake", CANDS)
        assert r.outcome == "exact" and r.best.candidate.kind == "attraction"

    def test_at_most_four_choices(self):
        many = [pm.Candidate("area", f"s{i}", f"Harbour View {c}", "x", "X")
                for i, c in enumerate("ABCDEFGH")]
        assert len(pm.resolve("harbour view", many).matches) <= pm.MAX_CHOICES

    # prefix names ---------------------------------------------------------
    def test_a_shorter_name_is_not_confused_with_the_longer_one_it_begins(self):
        assert pm.resolve("Baga", CANDS).best.candidate.name == "Baga"
        assert pm.resolve("Baga Beach", CANDS).best.candidate.name == "Baga Beach"
        assert pm.resolve("Calangute", CANDS).best.candidate.name == "Calangute"

    def test_a_slip_after_a_stored_prefix_offers_the_longer_name_first(self):
        r = pm.resolve("Calangute bech", CANDS)
        assert r.outcome == "multiple"
        assert names(r)[0] == "Calangute Beach" and "Calangute" in names(r)

    # 6. an unrelated name must not match ----------------------------------
    UNSOLD = ("Paris London Colombo Kerala Tokyo Sydney Rome Madrid Berlin Cairo Lisbon Vienna Prague "
              "Dublin Oslo Seoul Hanoi Manila Jakarta Nairobi Lima Havana Venice Florence Munich Zurich "
              "Geneva Amsterdam Brussels Athens Istanbul Karachi Lahore Dhaka Kathmandu Thimphu Pune "
              "Chennai Jodhpur Udaipur Shimla Manali Ooty Munnar Madurai Mysore Nagpur Surat Agra "
              "Varanasi Amritsar Rishikesh Haridwar Gaya Gwalior Bhopal Indore Patna Ranchi Lucknow "
              "Kanpur Hyde-Park Big-Ben Eiffel-Tower Taj-Mahal Golden-Temple Banana Weather Money Sunday "
              "Mountain Airport Station Garden Palace Delta Gokarna Gangtok Guwahati Calcutta Madras "
              "Bombay").split()

    @pytest.mark.parametrize("word", UNSOLD)
    def test_a_real_place_we_do_not_sell_matches_nothing(self, word):
        spoken = word.replace("-", " ")
        for sentence in (spoken, f"Show {spoken}", f"hotels near {spoken}", f"places to visit in {spoken}"):
            assert pm.resolve(sentence, CANDS).outcome == "none", sentence

    def test_request_words_alone_never_match_a_place(self):
        for s in ("show me hotels", "tour packages please", "places to visit", "what can I do there"):
            assert pm.resolve(s, CANDS).outcome == "none", s

    def test_nonsense_and_empty_input(self):
        assert pm.resolve("zzzzqqq", CANDS).outcome == "none"
        assert pm.resolve("", CANDS).outcome == "none"
        assert pm.resolve("Hyderabad", []).outcome == "none"

    # 7. a destination with no locations -----------------------------------
    def test_a_destination_with_no_locations_is_still_a_destination(self):
        lone = pm.Candidate("destination", "nowhere", "Nowhere Bay")
        assert pm.resolve("Nowhere Bay", [lone]).outcome == "exact"
        assert pm.resolve("Nowhere Baay", [lone]).outcome == "suggest"

    # parent context -------------------------------------------------------
    def test_a_misspelt_place_is_matched_inside_the_named_destination_first(self):
        twins = [pm.Candidate("attraction", "city-palace", "City Palace", "jaipur", "Jaipur"),
                 pm.Candidate("attraction", "city-pallace", "City Palaces", "udaipur", "Udaipur")]
        r = pm.resolve("city palase", twins, parent_slugs=("udaipur",))
        assert [m.candidate.parent_slug for m in r.matches] == ["udaipur"]

    def test_no_match_inside_the_parent_falls_back_to_the_whole_catalogue(self):
        r = pm.resolve("Charminnar", CANDS, parent_slugs=("goa",))
        assert r.outcome == "suggest" and r.best.candidate.parent_slug == "hyderabad"

    # evidence for the threshold -------------------------------------------
    @staticmethod
    def _slips(name):
        """Deterministic single mistakes of one name: a deletion, an insertion, a
        substitution, a swap and a doubled letter, at a middle position."""
        n, mid = name.lower(), len(name) // 2
        out = [n[:mid] + n[mid + 1:], n[:mid] + "e" + n[mid:], n[:mid] + "u" + n[mid + 1:],
               n[:mid] + n[mid] + n[mid:]]
        if mid > 1 and n[mid] != n[mid - 1] and " " not in n[mid - 1:mid + 1]:
            out.append(n[:mid - 1] + n[mid] + n[mid - 1] + n[mid + 1:])
        return [m for m in out if m != n]

    def test_recall_on_single_mistakes_of_every_stored_name(self):
        stored = sorted({c.name for c in CANDS if len(pm.squash(pm.normalize(c.name))) >= pm.MIN_FUZZY_LEN})
        total = hit = 0
        misses = []
        for name in stored:
            for slip in self._slips(name):
                total += 1
                r = pm.resolve(slip, CANDS)
                if r.outcome in ("exact", "suggest", "multiple") and any(
                        pm.normalize(n) == pm.normalize(name) for n in names(r)):
                    hit += 1
                else:
                    misses.append((slip, name, r.outcome))
        assert total > 600
        assert hit / total >= 0.99, (hit, total, misses[:10])

    def test_the_nearest_pair_of_different_names_stays_below_any_exact_score(self):
        distinct = sorted({pm.normalize(c.name) for c in CANDS})
        worst = max(pm.similarity(a, b) for i, a in enumerate(distinct) for b in distinct[i + 1:]
                    if a not in b and b not in a)
        assert worst < 0.90, worst           # measured 0.833 (MG Road / MI Road)

    def test_a_request_is_matched_in_milliseconds(self):
        pm.resolve("warm", CANDS)
        started = time.perf_counter()
        for _ in range(5):
            pm.resolve("hotels near charminnar in hyderabad please", CANDS)
        assert (time.perf_counter() - started) / 5 < 0.15


# ===========================================================================
# The assistant, with a near miss in the sentence
# ===========================================================================
class TestAssistantNearMisses:
    # B. a likely typo: asked about, never acted on --------------------------
    def test_show_charminnar_asks_and_opens_nothing(self):
        r = say("Show Charminnar")
        assert r["service_intent"] == "clarification_required"
        assert act(r) == "none"                               # nothing navigated or shown
        assert r["reply"] == "Did you mean Charminar (Hyderabad)?"
        assert r["choices"] == [{"label": "Charminar · Hyderabad", "message": "Show Charminar"}]

    def test_choosing_the_suggestion_is_exactly_the_request_that_was_made(self):
        choice = say("Show Charminnar")["choices"][0]
        chosen = say(choice["message"])
        assert act(chosen) == "show_place"
        assert chosen["action"]["params"] == {
            "destination": "hyderabad", "destinationName": "Hyderabad", "kind": "attraction",
            "slug": "charminar", "name": "Charminar"}

    @pytest.mark.parametrize("typo,service,action", [
        ("Hotels near Charminnar", "hotel_search", "hotels_near"),
        ("hotels in Hyderbad", "hotel_search", "search_hotels"),
        ("Hyderbad tour packages", "tour_package_search", "show_packages"),
        ("places to visit in Hyderbad", "destination_location_search", "show_places"),
        ("tell me about Hyderbad", "destination_discovery", "show_destination"),
    ])
    def test_the_requested_service_survives_the_correction(self, typo, service, action):
        r = say(typo)
        assert r["service_intent"] == "clarification_required" and act(r) == "none"
        chosen = say(r["choices"][0]["message"])
        assert (chosen["service_intent"], act(chosen)) == (service, action), (typo, r["choices"])

    def test_a_hotel_search_for_an_unknown_place_is_still_a_hotel_search(self):
        r = say("Hotels in Kerala")
        assert (r["service_intent"], act(r), r["action"]["params"]["dest"]) == (
            "hotel_search", "search_hotels", "Kerala")

    def test_a_package_search_for_an_unknown_place_is_still_a_package_search(self):
        r = say("tour packages for Paris")
        assert (r["service_intent"], act(r)) == ("tour_package_search", "show_packages")
        assert r["action"]["params"]["dest"] == "Paris"

    def test_an_exact_hotel_or_package_request_is_untouched(self):
        assert act(say("Hotels in Hyderabad")) == "search_hotels"
        assert act(say("Hyderabad tour packages")) == "show_packages"
        assert act(say("Show hotels near Charminar")) == "hotels_near"

    # C. several plausible matches --------------------------------------------
    def test_several_plausible_places_are_listed_with_their_parent(self):
        r = say("show me Calangute bech")
        assert r["reply"] == "Which of these did you mean?"
        assert [c["label"] for c in r["choices"]] == ["Calangute Beach · Goa", "Calangute · Goa"]
        assert act(r) == "none"

    def test_a_name_in_two_destinations_is_told_apart_by_its_parent(self):
        twin_places = build_places(extra_attractions=[("goa", "ghat", "Old Ghat"), ("delhi", "ghat", "Old Ghat")])
        r = say("show old gaht", places=twin_places)
        labels = [c["label"] for c in r["choices"]]
        assert sorted(labels) == ["Old Ghat · Delhi", "Old Ghat · Goa"]
        # ...and the sentence each sends names its parent, so the answer is unambiguous.
        for c in r["choices"]:
            shown = say(c["message"], places=twin_places)
            assert act(shown) == "show_place"
            assert c["label"].endswith(shown["action"]["params"]["destinationName"])

    # D. nothing close ---------------------------------------------------------
    def test_a_location_that_is_not_stored_is_said_plainly(self):
        r = say("Show Chandni Chowk")
        assert r["service_intent"] == "destination_discovery" and act(r) == "none"
        assert r["reply"].startswith("We couldn't find that location: Chandni Chowk.")
        assert "Hyderabad" in r["reply"]                     # real destinations are offered
        assert "choices" in r and r["choices"] == []
        assert not any(w in r["reply"].lower() for w in ("₹", "rs.", "available", "price"))

    def test_nothing_is_fabricated_for_an_unknown_place(self):
        r = say("places to visit in Atlantis")
        assert act(r) == "none" and "Atlantis" in r["reply"]
        assert not r["action"]["params"]

    # the place is real, the destination named with it is not its parent --------
    def test_a_real_place_under_the_wrong_destination_is_corrected_aloud(self):
        r = say("Charminar in Goa")
        assert act(r) == "none"
        assert "We don't have Charminar in Goa" in r["reply"] and "Hyderabad" in r["reply"]
        assert r["choices"] == [{"label": "Charminar · Hyderabad", "message": "Charminar"}]

    def test_the_named_parent_is_used_when_it_is_the_right_one(self):
        assert act(say("Show Charminar in Hyderabad")) == "show_place"

    def test_a_misspelt_place_inside_its_named_destination(self):
        r = say("Show Charminnar in Hyderabad")
        assert r["choices"] == [{"label": "Charminar · Hyderabad", "message": "Show Charminar in Hyderabad"}]


# ===========================================================================
# A destination, a place, an area — told apart by what is asked, not by counting
# ===========================================================================
class TestDestinationVersusLocation:
    @pytest.mark.parametrize("sentence,service,action,params", [
        ("Show destinations", "destination_discovery", "show_destinations", {}),
        ("Show destinations in Hyderabad", "destination_discovery", "show_destination",
         {"destination": "hyderabad", "name": "Hyderabad"}),
        ("Tell me about Hyderabad", "destination_discovery", "show_destination",
         {"destination": "hyderabad", "name": "Hyderabad"}),
        ("What places can I visit in Hyderabad?", "destination_location_search", "show_places",
         {"destination": "hyderabad", "name": "Hyderabad", "list": "attractions"}),
        ("Show Charminar", "destination_location_search", "show_place",
         {"destination": "hyderabad", "destinationName": "Hyderabad", "kind": "attraction",
          "slug": "charminar", "name": "Charminar"}),
        ("Show Banjara Hills", "destination_location_search", "show_place",
         {"destination": "hyderabad", "destinationName": "Hyderabad", "kind": "area",
          "slug": "banjara-hills", "name": "Banjara Hills"}),
        ("Hotels near Charminar", "hotel_search", "hotels_near",
         {"destination": "hyderabad", "attraction": "charminar"}),
        ("Hyderabad tour packages", "tour_package_search", "show_packages", {"dest": "Hyderabad"}),
        ("Hotels in Hyderabad", "hotel_search", "search_hotels", {"dest": "Hyderabad", "checkIn": None}),
    ])
    def test_each_request_goes_where_it_asks(self, sentence, service, action, params):
        r = say(sentence)
        assert (r["service_intent"], act(r)) == (service, action)
        assert r["action"]["params"] == params

    def test_a_requested_service_wins_over_the_choice_screen(self):
        # "Hotels in Hyderabad" must not ask which service is wanted.
        for s, a in (("Hotels in Hyderabad", "search_hotels"), ("Hyderabad tour packages", "show_packages"),
                     ("places to visit in Hyderabad", "show_places")):
            assert act(say(s)) == a

    def test_a_destination_alone_offers_the_choice(self):
        r = say("Hyderabad")
        assert act(r) == "show_destination"
        assert r["suggestions"] == ["Places to visit in Hyderabad", "Hyderabad tour packages", "Hotels in Hyderabad"]

    def test_the_word_count_is_not_the_classifier(self):
        # Same number of words and of place names; different requests.
        assert act(say("hotels near Charminar")) == "hotels_near"
        assert act(say("show Charminar please")) == "show_place"
        assert act(say("tell me everything about Charminar")) == "show_place"
        assert act(say("Hyderabad to Goa")) == "search_flights"
        assert act(say("Hyderabad Goa tour package")) == "show_packages"

    # 11. EVERY destination's response actions open the correct existing flow ----
    @pytest.mark.parametrize("slug,name", [(d["slug"], d["name"]) for d in FIXTURE["destinations"]])
    def test_every_destination_response_has_three_working_actions(self, slug, name):
        card = say(f"Tell me about {name}")
        assert act(card) == "show_destination"
        assert card["action"]["params"] == {"destination": slug, "name": name}   # -> destination/{slug}
        places_s, packages_s, hotels_s = card["suggestions"]
        assert (places_s, packages_s, hotels_s) == (
            f"Places to visit in {name}", f"{name} tour packages", f"Hotels in {name}")
        places = say(places_s)
        assert (act(places), places["action"]["params"]["destination"]) == ("show_places", slug)
        packages = say(packages_s)
        assert (act(packages), packages["action"]["params"]["dest"]) == ("show_packages", name)
        hotels = say(hotels_s)
        assert (act(hotels), hotels["action"]["params"]["dest"]) == ("search_hotels", name)

    def test_a_destination_added_later_works_with_no_code_change(self):
        extra = build_places(extra_destinations=[("kerala", "Kerala")])
        card = say("Tell me about Kerala", places=extra)
        assert card["action"]["params"] == {"destination": "kerala", "name": "Kerala"}
        assert say("Keralla", places=extra)["choices"][0]["label"] == "Kerala"      # and its typos
        assert say("Hotels in Keralla", places=extra)["choices"][0]["message"] == "Hotels in Kerala"

    def test_a_retired_place_is_no_longer_matched(self):
        gone = ta.Places(destinations=PLACES.destinations, attractions=[a for a in PLACES.attractions
                         if a[1] != "charminar"], locations=PLACES.locations, countries=PLACES.countries)
        r = say("Show Charminnar", places=gone)
        assert not r["choices"] and "couldn't find that location" in r["reply"]


# ===========================================================================
# The typed Travel Assistant's starting points and its context-aware suggestions
# ===========================================================================
class TestSuggestions:
    # The four buttons the panel opens with each send one of these sentences.
    @pytest.mark.parametrize("sentence,service,action", [
        ("Show me destinations", "destination_discovery", "show_destinations"),
        ("Show tour packages", "tour_package_search", "show_packages"),
        ("Find hotels", "hotel_search", "none"),             # asks which city — and offers real ones
        ("Search flights", "flight_search", "none"),         # asks which cities
    ])
    def test_every_starting_suggestion_has_a_real_answer(self, sentence, service, action):
        r = say(sentence)
        assert (r["service_intent"], act(r)) == (service, action)
        assert r["intent"] != "fallback" and r["reply"]

    def test_a_question_with_no_city_offers_cities_that_exist(self):
        r = say("Find hotels")
        real = {d["name"] for d in FIXTURE["destinations"]}
        assert r["suggestions"] and all(s.removeprefix("Hotels in ") in real for s in r["suggestions"])
        assert all(act(say(s)) == "search_hotels" for s in r["suggestions"])

    def test_after_packages_for_a_destination_the_next_steps_are_about_it(self):
        r = say("Show Goa tour packages")
        assert r["suggestions"] == ["Places to visit in Goa", "Hotels in Goa"]
        assert [act(say(s)) for s in r["suggestions"]] == ["show_places", "search_hotels"]

    def test_after_the_places_in_a_destination_the_next_steps_are_about_it(self):
        r = say("Places to visit in Hyderabad")
        assert r["suggestions"] == ["Hyderabad tour packages", "Hotels in Hyderabad"]
        assert [act(say(s)) for s in r["suggestions"]] == ["show_packages", "search_hotels"]

    def test_packages_with_no_destination_offer_real_destinations_to_narrow_by(self):
        r = say("Show tour packages")
        real = {d["name"] for d in FIXTURE["destinations"]}
        assert r["suggestions"] and all(s.removesuffix(" tour packages") in real for s in r["suggestions"])

    def test_a_reply_that_has_nothing_to_suggest_offers_nothing_rather_than_the_starters(self):
        # The panel clears its chips when a reply brings none, so the starting
        # four are not shown after every answer.
        assert say("Hotels in Goa")["suggestions"] == []
        assert say("Hyderabad to Delhi")["suggestions"] == []

    @pytest.mark.parametrize("sentence", ["Show tour packages", "Show Goa tour packages", "Places to visit in Hyderabad",
                                          "Tell me about Hyderabad", "Find hotels", "Show Charminar", "I want a holiday in Goa",
                                          "Show Charminnar", "Show Chandni Chowk"])
    def test_every_suggestion_any_reply_makes_is_itself_understood(self, sentence):
        r = say(sentence)
        for chip in [*r["suggestions"], *[c["message"] for c in r["choices"]]]:
            assert say(chip)["intent"] != "fallback", (sentence, chip)
