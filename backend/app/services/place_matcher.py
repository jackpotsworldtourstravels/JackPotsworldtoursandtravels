"""Typo-tolerant matching of spoken place names to the catalogue's own records.

    resolve(text, candidates, parent_slugs=...)  ->  Resolution

WHAT IT IS FOR. Speech recognition hears "Charminnar" and "Hyderbad". The
assistant's exact matcher (travel_ai_assistant._find_place) is right to refuse
them — it must never open a page for a place nobody named — but a refusal is a
poor answer to a near miss. This module finds the REAL record a near miss was
probably meant for, so the assistant can ask "Did you mean Charminar?".

IT NEVER INVENTS. Every Match carries the Candidate it came from, which is a
row the caller loaded from the database (destination, famous place or area:
canonical name, slug, parent). The returned name and slug are those row's own;
nothing is generated, spelt out of the spoken text, or looked up from a list of
known mistakes. There is no table of misspellings anywhere in this file — the
same mechanism covers a place added to the catalogue tomorrow.

THE FOUR OUTCOMES (Resolution.outcome), chosen by score — see the constants:

  exact     the text IS a stored name once case, spacing, punctuation and
            diacritics are ignored ("banjara  HILLS", "Banjara-Hills"). Safe to
            act on: no guess was made.
  suggest   one near miss. Asked about, never acted on.
  multiple  several plausible records — or one name that exists under several
            parents. The customer chooses; the parent is shown to tell them apart.
  none      nothing is close enough. Said plainly; nothing is guessed.

HOW A SCORE IS MADE (similarity()). Names are normalised (normalize), then
compared as:
  * whole strings, by 1 - DamerauLevenshtein / longest, with the spaces removed
    so "hi tec city" and "hitec city" are one string;
  * word by word when both sides have the same number of words, so a mis-spelt
    word in a long name ("Gateway of Indya") is judged on that word and not
    diluted by the rest;
  * with a floor for letters spoken twice or once too often ("Charminnar"):
    collapsing repeats is how speech-to-text most often goes wrong and it never
    maps one place onto another.
A different first letter costs a little (recognisers rarely change it, though
two swapped letters at the start do happen), and a
name shorter than MIN_FUZZY_LEN letters may only match exactly — "Goa" is one
letter from "Gaya" and the two have nothing to do with each other.

WHICH WORDS ARE COMPARED. Only the ones that are not part of the request: the
sentence is split on a vocabulary of request/product words (STOPWORDS — "show",
"hotels near", "places to visit"; no place names) and each run of what is left
is a candidate span. "Hotels near Charminnar" therefore compares "charminnar"
and never "hotels", which is what stops an unrelated word matching by accident.

THE THRESHOLDS WERE SET AGAINST THE REAL CATALOGUE, not chosen by feel:
backend/tests/test_place_matcher.py generates single-edit mistakes of every
stored name to measure recall, and holds a list of real-world places this
business does not sell to measure false positives. The numbers and the margin
are in that file's docstring and in the change report.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache

# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------
#: Below this a name is not "close". Chosen from the data: single-edit mistakes
#: of a name 5+ letters long score >= 0.80, and the nearest UNRELATED pair in
#: the catalogue plus every non-catalogue place in the test list scores < 0.78.
SUGGEST_AT = 0.80
#: Two matches this close to each other are both offered ("several plausible").
AMBIGUITY_MARGIN = 0.04
#: At most this many choices are shown.
MAX_CHOICES = 4
#: A name shorter than this may only match exactly. Fuzzy-matching three-letter
#: names produces unrelated hits (Goa/Gaya, Deira/Delhi is five letters but the
#: first-letter rule handles it).
MIN_FUZZY_LEN = 5
#: ...and what was heard must be at least this long ("dlhi" for Delhi: one
#: letter short, still recognisable; "goa" for anything is not).
MIN_SPOKEN_LEN = 4
#: Longest run of words compared against one name.
MAX_SPAN_WORDS = 8
#: Score assigned when only case, spacing, punctuation or diacritics differ.
EXACT = 1.0
SQUASHED_EXACT = 0.995
#: Floor for "same letters, some spoken twice / once too often".
REPEAT_FLOOR = 0.90
#: Cost of a different first letter.
FIRST_LETTER_PENALTY = 0.03

#: The REQUEST part of a sentence — verbs, prepositions, product and service
#: words. Deliberately no place names and no spellings: it says what is not a
#: place, and a place can never be added here by a typo.
STOPWORDS = frozenset("""
a an the and or of to from in on at by for with near nearby around about into onto
i me my we us you your it its is are be was were am do does did can could would will
shall should may might want wanted wanna need needed like love looking look looks
show shows showing find finding search searching get give take tell explain describe
list see view open go going visit visiting travel travelling traveling explore
exploring plan planning book booking reserve stay staying
please pls thanks thank ok okay
hotel hotels resort resorts room rooms accommodation lodging
flight flights fly ticket tickets
package packages tour tours trip trips holiday holidays vacation vacations getaway
itinerary
destination destinations location locations area areas place places spot spots
attraction attractions landmark landmarks sight sights sightseeing
famous popular best top nice good great beautiful cheap
what which where when how who whats
thing things there here some any all more other another
next this that these those one two three four five six seven eight nine ten
day days night nights week weeks weekend month
family honeymoon adventure beach cruise heritage luxury budget
domestic international pilgrimage
information info details detail
""".split())

_SPACES = re.compile(r"\s+")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


@lru_cache(maxsize=8192)
def normalize(text: str | None) -> str:
    """Case, diacritics, punctuation and spacing flattened.

        "  Banjara--HILLS "  ->  "banjara hills"
        "Dal Lake's"         ->  "dal lakes"
        "Café de Paris"      ->  "cafe de paris"

    '&' is read as "and". Everything that is not a letter or digit becomes one
    space, runs of spaces collapse, and the ends are trimmed.
    """
    if not text:
        return ""
    s = unicodedata.normalize("NFKD", str(text))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    # An apostrophe joins ("Sultan's" -> "sultans"); it does not split the word.
    s = s.lower().replace("&", " and ").replace("'", "").replace("’", "")
    return _SPACES.sub(" ", _NON_ALNUM.sub(" ", s)).strip()


def _letters(squashed: str) -> int:
    """The set of letters in a string, as a bitmask — a very cheap first filter."""
    mask = 0
    for ch in squashed:
        mask |= 1 << (ord(ch) % 64)
    return mask


def squash(norm: str) -> str:
    """A normalised string with the spaces removed — "hi tec city" == "hitec city"."""
    return norm.replace(" ", "")


def _collapse_repeats(s: str) -> str:
    return re.sub(r"(.)\1+", r"\1", s)


def damerau_levenshtein(a: str, b: str) -> int:
    """Edit distance counting an adjacent swap as ONE edit ("Hyderbad"/"Hydearbad").

    The optimal-string-alignment variant: O(len(a) * len(b)), which for place
    names (< 40 letters) is trivially cheap. Written out rather than imported
    because the project has no string-distance dependency and adding one for 20
    lines would be the wrong trade.
    """
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev2: list[int] | None = None
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if (prev2 is not None and i > 1 and j > 1
                    and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]):
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        prev2, prev = prev, cur
    return prev[-1]


def _ratio(a: str, b: str) -> float:
    longest = max(len(a), len(b))
    return 1.0 if longest == 0 else 1.0 - damerau_levenshtein(a, b) / longest


def similarity(spoken: str, stored: str) -> float:
    """How alike two names are, 0..1. Both are normalised here.

    1.0 and 0.995 mean "the same name, written differently" and are the only
    scores that may be acted on without asking. Anything lower is a guess whose
    quality this number reports.
    """
    s, n = normalize(spoken), normalize(stored)
    if not s or not n:
        return 0.0
    if s == n:
        return EXACT
    a, b = squash(s), squash(n)
    if a == b:
        return SQUASHED_EXACT
    # A very short STORED name may only match exactly (see MIN_FUZZY_LEN), and
    # what was heard must still be long enough to carry a mistake.
    if len(b) < MIN_FUZZY_LEN or len(a) < MIN_SPOKEN_LEN:
        return 0.0

    score = _ratio(a, b)
    ca, cb = _collapse_repeats(a), _collapse_repeats(b)
    if ca == cb:
        score = max(score, REPEAT_FLOOR)
    else:
        score = max(score, min(_ratio(ca, cb), REPEAT_FLOOR - 0.02))

    # Word by word, when both have the same number of words: a typo in one word
    # of a long name should be judged on that word.
    ts, tn = s.split(), n.split()
    if len(ts) == len(tn) and len(ts) > 1:
        parts = [(_ratio(x, y) if min(len(x), len(y)) >= 3 else (1.0 if x == y else 0.0))
                 for x, y in zip(ts, tn)]
        if min(parts) >= 0.6:                       # no word may be a different word
            score = max(score, sum(parts) / len(parts))

    # Two swapped letters at the start ("udbai") are one slip, not a different
    # word, so only a genuinely different first letter is penalised.
    if a[0] != b[0] and not (len(a) > 1 and len(b) > 1 and a[0] == b[1] and a[1] == b[0]):
        score -= FIRST_LETTER_PENALTY
    return max(0.0, min(score, 0.99))


# ---------------------------------------------------------------------------
# Candidates and results
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Candidate:
    """One stored place. Built by the caller from a database row, never by us."""

    kind: str                     # 'destination' | 'attraction' | 'area'
    slug: str
    name: str
    parent_slug: str | None = None
    parent_name: str | None = None

    @property
    def label(self) -> str:
        """What a choice button shows: the name, and its parent where it helps."""
        return f"{self.name} · {self.parent_name}" if self.parent_name else self.name


@dataclass(frozen=True)
class Match:
    candidate: Candidate
    score: float
    #: The words of the sentence that were compared (normalised).
    span: str

    @property
    def exact(self) -> bool:
        return self.score >= SQUASHED_EXACT


@dataclass
class Resolution:
    outcome: str                                        # exact | suggest | multiple | none
    matches: list[Match] = field(default_factory=list)
    #: The words of the sentence the best match was made from.
    heard: str | None = None

    @property
    def best(self) -> Match | None:
        return self.matches[0] if self.matches else None


_NONE = Resolution("none")


def _windows(tokens: list[str], name_words: int) -> list[str]:
    """The stretches of the sentence worth comparing with a name of ``name_words`` words.

    CANDIDATE-DRIVEN, because a request word can also be part of a name: "of" in
    "Basilica of Bom Jesus", "place" in a mis-heard "Bangalore Palace". A window
    the SAME length as the name may begin or end on any word — the word-by-word
    rule in similarity() already rejects a window whose words are not the name's
    words — while a window one word longer or shorter (a name spoken with a word
    run together or split apart) must begin and end on a word that is not part of
    the request. A window of nothing but request words is never compared.
    """
    out: list[str] = []
    for length in {name_words - 1, name_words, name_words + 1}:
        if length < 1 or length > MAX_SPAN_WORDS:
            continue
        for i in range(len(tokens) - length + 1):
            window = tokens[i:i + length]
            if all(t in STOPWORDS for t in window):
                continue
            if length != name_words and (window[0] in STOPWORDS or window[-1] in STOPWORDS):
                continue
            out.append(" ".join(window))
    return out


def has_unexplained_words(text: str) -> bool:
    """True if the sentence holds a word that is not part of the request.

    A cheap guard: a sentence made only of request words ("show me hotels")
    names no place, so there is nothing to match and the search is skipped.
    """
    return any(t not in STOPWORDS for t in normalize(text).split())


def resolve(text: str, candidates: list[Candidate], parent_slugs: tuple[str, ...] | list[str] = ()
            ) -> Resolution:
    """The stored places ``text`` most plausibly names.

    ``parent_slugs`` are destinations the sentence (or the conversation) already
    named. A match inside one of them beats an equally good match elsewhere —
    "Charminar" under Hyderabad over a same-named place under Goa — and when a
    name exists under several parents with none of them named, the outcome is
    ``multiple`` so the customer says which.
    """
    tokens = normalize(text).split()
    if not tokens or not candidates or not has_unexplained_words(text):
        return _NONE

    windows: dict[int, list[tuple[str, int, int]]] = {}    # name length -> (span, letters, length)
    best: dict[tuple[str, str, str | None], Match] = {}
    for cand in candidates:
        name_norm = normalize(cand.name)
        name_squashed = squash(name_norm)
        name_len, name_mask = len(name_squashed), _letters(name_squashed)
        words = len(name_norm.split())
        if words not in windows:
            windows[words] = [(w, _letters(squash(w)), len(squash(w)))
                              for w in _windows(tokens, words)]
        for span, span_mask, span_len in windows[words]:
            # TWO CHEAP FILTERS BEFORE THE EDIT DISTANCE, which is the expensive
            # part. Text that long or short cannot be this name with a couple of
            # mistakes; and one or two mistakes change at most a few DISTINCT
            # letters, so a stretch sharing almost no letters with the name is
            # not a candidate. Neither can reject a match the score would accept.
            if abs(span_len - name_len) > max(3, name_len // 3):
                continue
            if bin(span_mask ^ name_mask).count("1") > 6:
                continue
            score = similarity(span, cand.name)
            if score < SUGGEST_AT:
                continue
            key = (cand.kind, cand.slug, cand.parent_slug)
            # A longer span explaining a name beats a shorter one at equal score:
            # "baga beach" should settle on Baga Beach, not on Baga.
            held = best.get(key)
            if held is None or (score, len(span)) > (held.score, len(held.span)):
                best[key] = Match(cand, score, span)
    if not best:
        return _NONE

    matches = list(best.values())
    parents = set(parent_slugs or ())
    if parents:
        inside = [m for m in matches if m.candidate.parent_slug in parents
                  or (m.candidate.kind == "destination" and m.candidate.slug in parents)]
        if inside:
            matches = inside

    # One stored name can be both an attraction and an area (Dal Lake): that is
    # one place, so the attraction — which has a page — stands for both.
    seen: dict[tuple[str, str | None], Match] = {}
    for m in sorted(matches, key=lambda m: (m.candidate.kind != "attraction",)):
        seen.setdefault((normalize(m.candidate.name), m.candidate.parent_slug), m)
    matches = list(seen.values())

    matches.sort(key=lambda m: (-m.score, -len(m.span), m.candidate.name))
    # A LONGER NAME THE SENTENCE ALMOST SAYS BEATS A SHORTER ONE IT SAYS EXACTLY
    # WHEN THE SHORTER IS INSIDE IT. "Calangute bech" contains Calangute exactly
    # and Calangute Beach with one slip: acting on the first would silently drop
    # half of what was said, so both are offered, the longer first.
    exact_words = [set(m.span.split()) for m in matches if m.exact]
    subsuming = [m for m in matches if not m.exact and any(w < set(m.span.split()) for w in exact_words)]
    if subsuming:
        lead = max(subsuming, key=lambda m: (m.score, len(m.span)))
        inside = [m for m in matches if m.exact and set(m.span.split()) < set(lead.span.split())]
        group = [lead] + [m for m in inside if m.candidate != lead.candidate]
        return Resolution("multiple" if len(group) > 1 else "suggest", group[:MAX_CHOICES], lead.span)

    top = matches[0]
    heard = top.span

    if top.exact:
        same = [m for m in matches if m.exact and m.span == top.span]
        if len(same) == 1:
            return Resolution("exact", same, heard)
        return Resolution("multiple", same[:MAX_CHOICES], heard)       # the same name under several parents

    close = [m for m in matches if top.score - m.score <= AMBIGUITY_MARGIN
             and m.span == top.span][:MAX_CHOICES]
    return Resolution("suggest" if len(close) == 1 else "multiple", close, heard)
