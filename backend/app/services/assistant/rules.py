"""Deterministic intent matching — the default, and always the fallback.

This provider needs no API key, no network call and no vendor, which is why it
is what ``ASSISTANT_PROVIDER=none`` runs and what every other provider falls
back to when it fails. A merchant typing "balance?" gets the same answer here as
they would from a model; what a model buys is the unusual phrasing, not the
common one.

HOW IT SCORES
Each intent owns a list of phrases. A phrase that appears in the message scores
its own length, so a specific phrase beats a general one that is a substring of
it — "pending payment" (15) beats "payment" (7) — and the highest total wins.
Length-as-weight is crude but it is predictable, which matters more here: a
merchant who found the words that work yesterday must get the same answer today.

ORDER IS THE DESIGN, NOT AN ACCIDENT. Refusals are checked before lookups, an
explicit reference beats any keyword, and help is checked before the list
intents — otherwise "how do I cancel a booking" scores on "booking" and returns
a list of the merchant's bookings instead of telling them how to cancel one.
"""
from __future__ import annotations

import re

from .base import Intent, IntentResult, StatusFilter, find_help_topic, find_reference

# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------
# NOT A SECURITY BOUNDARY, AND MUST NEVER BE TREATED AS ONE. Tenant isolation is
# enforced by the merchant's own JWT on every data call the browser makes — a
# question about another company returns that company's data only if the API is
# broken, and no phrasing here changes that. This list exists so the assistant
# gives a straight answer to a question it will not serve, instead of running a
# lookup and showing the merchant their own figures under someone else's name,
# which reads like a data leak even though it is the opposite of one.
_OTHER_TENANT = re.compile(
    r"\b(?:"
    r"another|other|others|different|someone else'?s?|somebody else'?s?|"
    r"all (?:the )?(?:merchants?|partners?|agencies|companies)|"
    r"every (?:merchant|partner|agency|company)|"
    r"(?:merchant|partner|agency|company) (?:id|code)\s*\S+"
    r")\b.{0,40}?\b(?:merchant|partner|agency|compan|wallet|booking|balance|account|ledger)",
    re.IGNORECASE,
)

#: Asked of the platform rather than of the merchant's own account.
_SYSTEM_PROBE = re.compile(
    r"\b(?:system prompt|your prompt|api key|database|db password|env var|"
    r"environment variable|source code|admin panel|sql)\b",
    re.IGNORECASE,
)


_PHRASES: dict[Intent, list[str]] = {
    Intent.GREETING: [
        "hello", "hi ", "hey", "good morning", "good afternoon", "good evening",
        "namaste", "greetings",
    ],
    Intent.CAPABILITIES: [
        "what can you do", "what do you do", "help me with", "how can you help",
        "what can i ask", "your features", "can you help", "need help",
        "what do you know",
    ],
    Intent.WALLET_BALANCE: [
        "wallet balance", "my balance", "balance", "how much money", "how much do i have",
        "available balance", "credit limit", "check my wallet", "show wallet", "wallet",
        "funds", "how much left",
    ],
    Intent.WALLET_TRANSACTIONS: [
        "wallet transaction", "wallet history", "recent transaction", "transactions",
        "ledger", "statement", "why was my wallet debited", "why was i debited",
        "last debit", "deducted", "last top up", "last topup", "recent top up",
    ],
    Intent.BOOKINGS_LIST: [
        "my bookings", "show bookings", "list bookings", "all bookings", "bookings",
        "my requests", "booking request", "upcoming booking", "today's booking",
        "todays booking", "completed booking", "confirmed booking",
    ],
    Intent.BOOKING_STATUS: [
        "booking status", "status of my booking", "where is my booking",
        "check my booking", "track booking", "is my booking confirmed",
    ],
    Intent.ENQUIRIES_LIST: [
        "my enquiries", "my enquiry", "show enquiries", "list enquiries", "enquiries",
        "enquiry", "inquiries", "inquiry", "rejected enquiry", "pending enquiry",
    ],
    Intent.QUOTATIONS_AVAILABLE: [
        "quotation", "quote", "quoted fare", "awaiting quotation", "available quotation",
        "fare received", "priced",
    ],
    Intent.PAYMENTS_PENDING: [
        "pending payment", "payment pending", "awaiting approval", "unpaid",
        "outstanding payment", "due payment", "what do i owe",
    ],
    Intent.PAYMENTS_LIST: [
        "my payments", "payment status", "payment request", "show payments",
        "payments", "payment history", "top up status", "topup status",
    ],
    Intent.SERVICE_REQUESTS_LIST: [
        "service request", "my requests to you", "cancellation request",
        "reschedule request", "refund request", "open requests", "service requests",
    ],
    Intent.SERVICE_REQUEST_STATUS: [
        "status of my service request", "status of srq", "where is my service request",
    ],
    Intent.PASSENGER_LOOKUP: [
        "find passenger", "search passenger", "passenger by passport",
        "look up passenger", "lookup passenger", "saved passenger",
    ],
    Intent.CONTACT_SUPPORT: [
        "talk to support", "contact support", "human", "speak to someone",
        "raise a ticket", "agent", "customer care", "call me", "complaint",
        "escalate", "live chat", "chat with support",
    ],
}

#: Words that pin a list intent to a subset. Checked independently of the intent
#: itself, so "show me rejected enquiries" and "rejected bookings" both work.
_STATUS_WORDS: list[tuple[str, StatusFilter]] = [
    ("pending", StatusFilter.PENDING),
    ("awaiting", StatusFilter.PENDING),
    ("in progress", StatusFilter.PENDING),
    ("approved", StatusFilter.APPROVED),
    ("confirmed", StatusFilter.CONFIRMED),
    ("rejected", StatusFilter.REJECTED),
    ("declined", StatusFilter.REJECTED),
    ("cancelled", StatusFilter.CANCELLED),
    ("canceled", StatusFilter.CANCELLED),
    ("completed", StatusFilter.COMPLETED),
    ("finished", StatusFilter.COMPLETED),
    ("upcoming", StatusFilter.UPCOMING),
    ("future", StatusFilter.UPCOMING),
    ("today", StatusFilter.TODAY),
]

#: A passport number as typed into chat: one letter then seven digits is the
#: Indian format, but travellers on this platform carry every format, so this
#: stays loose and the API is what actually decides whether it exists.
_PASSPORT = re.compile(r"\b([A-Z][0-9]{6,8}|[A-Z]{1,2}[0-9]{6,7})\b")

# ---------------------------------------------------------------------------
# Small talk
# ---------------------------------------------------------------------------
# ORDER IS THE WHOLE POINT OF THIS LIST. "hi how are you" contains both a
# greeting and a question about the assistant, and the question is the part
# that wants answering — so HOW_ARE_YOU is tested first and GREETING is left to
# the phrase table, which only ever sees a bare "hi". Matched with regexes
# rather than the scorer because these are short, fixed and unambiguous, and a
# three-character "hi" would otherwise lose to any longer word beside it.
_SMALL_TALK: list[tuple[re.Pattern, Intent]] = [
    (re.compile(r"how (?:are|r) (?:you|u)\b|how(?:'s| is) it going|how do you do"
                r"|what'?s up\b|you (?:doing )?(?:ok|okay|good|well)\b", re.I),
     Intent.HOW_ARE_YOU),
    (re.compile(r"\b(?:thanks|thank you|thankyou|thx|ty|cheers|appreciate it|"
                r"much appreciated|great help)\b", re.I),
     Intent.THANKS),
    (re.compile(r"who are you|what are you\b|your name|who am i (?:talking|speaking) to"
                r"|are you (?:a |an )?(?:bot|robot|human|person|real|ai|machine)", re.I),
     Intent.ABOUT),
    (re.compile(r"\b(?:bye|goodbye|good bye|see you|see ya|cya|catch you later|"
                r"that'?s all|nothing else|we'?re done)\b", re.I),
     Intent.GOODBYE),
    # Anchored to the WHOLE message: a bare "ok" is an acknowledgement, but
    # "ok show my bookings" is a request and must reach the scorer.
    (re.compile(r"^\s*(?:ok(?:ay)?|k|yes|yeah|yep|yup|sure|got it|fine|alright|"
                r"no|nope|cool|great|nice|perfect|hm+|hmm+)\s*[.!]*\s*$", re.I),
     Intent.AFFIRM),
]


#: A quotation is a NARROWER ask than the enquiry it sits on, and the enquiry
#: words nearly always appear beside it. Left to plain scoring, "which
#: enquiries have a quotation" resolves to the generic list — not because that
#: reading is better, but because "enquiries" happens to be one character
#: longer than "quotation". Checked ahead of scoring so the specific question
#: wins, and *after* the how-to test so "how do I get a quotation" is still help.
_QUOTATION = re.compile(r"\b(?:quotations?|quoted|quotes?)\b", re.IGNORECASE)

#: Questions that are asking *how*, not *what*. Their presence routes to help
#: even when the sentence also names a screen — see the module docstring.
_HOW_TO = re.compile(
    r"\b(?:how (?:do|can|to)|where (?:do|can|is the)|what is the process|"
    r"steps to|guide me|show me how|explain how)\b",
    re.IGNORECASE,
)


def _find_status(text: str) -> StatusFilter | None:
    for word, status in _STATUS_WORDS:
        if word in text:
            return status
    return None


def classify(message: str, page: str | None = None) -> IntentResult:
    """Best-effort intent for ``message``.

    ``page`` is the section the merchant is looking at. It is used only to break
    ties — a bare "show me the pending ones" means bookings on the bookings
    screen and enquiries on the enquiry screen — never to override an explicit
    question.
    """
    text = (message or "").strip()
    if not text:
        return IntentResult(Intent.UNKNOWN, confidence=0.0)

    lowered = f" {text.lower()} "

    # 1. Refusals, before anything is looked up.
    if _SYSTEM_PROBE.search(text):
        return IntentResult(
            Intent.OUT_OF_SCOPE,
            confidence=1.0,
            clarify="I can only help with your own account and how to use this portal.",
        )
    if _OTHER_TENANT.search(text):
        return IntentResult(
            Intent.OUT_OF_SCOPE,
            confidence=1.0,
            clarify="I can only provide information related to your account.",
        )

    status = _find_status(lowered)

    # 2. An explicit document reference is the strongest signal there is — it
    #    names one row, so it beats every keyword in the sentence.
    found = find_reference(text)
    if found:
        reference, intent = found
        return IntentResult(intent, reference=reference, confidence=1.0)

    # 2b. Small talk, after a reference (so "REQ-… thanks" is still a lookup)
    #     and before everything else.
    for pattern, intent in _SMALL_TALK:
        if pattern.search(text):
            return IntentResult(intent, confidence=0.95)

    # 3. "How do I …" is a help question even when it names a screen.
    if _HOW_TO.search(text):
        topic = find_help_topic(text)
        if topic:
            return IntentResult(Intent.PORTAL_HELP, topic=topic, confidence=0.9)

    # 3b. A quotation beats the enquiry it belongs to — see _QUOTATION.
    if _QUOTATION.search(text):
        return IntentResult(Intent.QUOTATIONS_AVAILABLE, status=status, confidence=0.9)

    # 4. A passport number with a passenger word around it.
    if "passenger" in lowered or "passport" in lowered:
        match = _PASSPORT.search(text.upper())
        if match and any(w in lowered for w in ("find", "search", "look", "lookup", "check")):
            return IntentResult(
                Intent.PASSENGER_LOOKUP, passport=match.group(1), confidence=0.95
            )

    # 5. Keyword scoring.
    scores: dict[Intent, int] = {}
    for intent, phrases in _PHRASES.items():
        total = sum(len(p) for p in phrases if p in lowered)
        if total:
            scores[intent] = total

    if scores:
        best = max(scores, key=lambda i: scores[i])
        # Confidence rises with how much of the sentence the winning phrases
        # actually accounted for, so a one-word hit inside a long question is
        # reported as the guess it is.
        share = min(1.0, scores[best] / max(len(lowered) - 2, 1))
        confidence = round(min(0.95, 0.55 + share * 0.4), 2)
        return IntentResult(best, status=status, confidence=confidence)

    # 6. A help topic on its own, with no "how do I" in front of it.
    topic = find_help_topic(text)
    if topic:
        return IntentResult(Intent.PORTAL_HELP, topic=topic, confidence=0.7)

    # 7. A bare status word, resolved against whatever screen they are on.
    if status and page:
        by_page = {
            "enquiry": Intent.ENQUIRIES_LIST,
            "wallet": Intent.WALLET_TRANSACTIONS,
            "payments": Intent.PAYMENTS_LIST,
            "service-request": Intent.SERVICE_REQUESTS_LIST,
            "approvals": Intent.BOOKINGS_LIST,
            "booking-history": Intent.BOOKINGS_LIST,
            "requests": Intent.BOOKINGS_LIST,
        }
        intent = by_page.get(page, Intent.BOOKINGS_LIST)
        return IntentResult(intent, status=status, confidence=0.6)

    return IntentResult(Intent.UNKNOWN, confidence=0.0)
