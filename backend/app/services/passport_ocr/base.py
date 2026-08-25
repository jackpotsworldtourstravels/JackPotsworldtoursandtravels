"""The contract every passport OCR provider implements.

WHY THIS FILE EXISTS AT ALL
The booking flow must not know which OCR vendor is configured. Everything above
this line — the endpoint, the merchant's form, the Admin panel, the audit — is
written against :class:`PassportExtraction`, and swapping Azure for Google
Vision, AWS Textract or OCR.Space is a new module in this package plus one
environment variable. Nothing in ``passport_ocr_service`` imports a vendor SDK,
and no vendor field name reaches the database's ``normalized`` column.

THE UNIT OF THE ANSWER IS A FIELD, NOT A DOCUMENT
A passport read is not "89% correct". The passport *number* is usually read off
the machine-readable zone and is near-certain; the *expiry* is a date printed in
a font chosen by an issuing authority and is where the mistakes are. One
document-level score hides exactly the field the merchant needs to check, so the
contract is one :class:`ExtractedField` per field, each with its own confidence,
and the document-level number is only ever their mean.

CONFIDENCE IS 0..1 HERE
Providers disagree — some return percentages, some return 0..1, some return
nothing at all for a field they are sure of. Adapters normalise to 0..1 or to
``None``; the *UI* is what turns that into a percentage and a colour, and it
lives in one place so the bands cannot drift between screens.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
from typing import Any, Protocol

#: Every field this platform can fill from a passport, in the order a merchant
#: reads them off the page. These are ``passenger_data`` column names on
#: purpose: the normaliser's whole job is to end up speaking OUR vocabulary, so
#: nothing downstream ever has to translate a vendor's field name.
PASSPORT_FIELDS: tuple[str, ...] = (
    "title",
    "first_name",
    "last_name",
    "gender",
    "dob",
    "place_of_birth",
    "nationality",
    "passport_number",
    "passport_type",
    "passport_issue_country",
    "passport_issue_date",
    "passport_expiry",
    "mrz",
)

#: Read off the document but NOT written to ``passenger_data``. The MRZ is the
#: evidence the other fields were derived from, not an attribute of a traveller:
#: storing it on the passenger would duplicate nine columns into one string that
#: then has to be kept in step with them. It is shown read-only on the form so a
#: merchant can check a doubtful field against the machine-readable lines, and
#: kept on the extraction row so the desk can see what was actually read.
NON_PASSENGER_FIELDS: frozenset[str] = frozenset({"mrz"})

#: Fields whose value is an ISO date string. Kept here rather than inferred from
#: the name so a future ``visa_expiry`` cannot be missed by a naive suffix test.
DATE_FIELDS: frozenset[str] = frozenset(
    {"dob", "passport_issue_date", "passport_expiry"}
)


class OCRError(Exception):
    """Base for anything that stops an extraction producing fields."""

    #: Short, stable, safe to show a merchant and to branch on in a test.
    code = "ocr_failed"

    def __init__(self, *args: Any, code: str | None = None) -> None:
        """``code`` narrows the class default without adding a subclass.

        "Could not be read" covers three situations a person would act on
        differently — an unreadable picture, the wrong document, a passport
        photographed with its code strip out of frame — and the sentence
        explaining which is already in the message. This carries the same
        distinction in a form a client can branch on, so the form can label the
        failure as well as describe it. Subclassing instead would put a
        provider's diagnosis into the shared error taxonomy, where the
        endpoint, the service and every other adapter would have to know about
        it; a per-instance code stays where it was raised.
        """
        super().__init__(*args)
        if code:
            self.code = code


class OCRNotConfigured(OCRError):
    """No provider is selected. Scanning is deliberately off on this deployment.

    Deliberately distinct from :class:`OCRFailed`: this is a deployment state,
    not a bad scan, and the merchant should be told the shortcut is unavailable
    rather than that their passport could not be read.
    """

    code = "ocr_not_configured"


class OCRMisconfigured(OCRNotConfigured):
    """A provider WAS selected and the deployment cannot honour it.

    Split from its parent because the two look identical to a merchant and could
    not be more different to whoever runs the platform: "scanning is off here" is
    a decision, and "azure is selected but has no key" is a fault that will
    otherwise present as a silently missing button with nothing in the log. It
    subclasses ``OCRNotConfigured`` so every existing handler keeps working —
    the merchant is still told the shortcut is unavailable — while
    :func:`is_available` and the startup check can tell them apart and shout.
    """

    code = "ocr_misconfigured"


class OCRFailed(OCRError):
    """The provider was reached and could not read the document."""

    code = "ocr_failed"


class OCRTimeout(OCRError):
    """The provider did not answer inside the configured budget."""

    code = "ocr_timeout"


@dataclasses.dataclass(frozen=True, slots=True)
class ExtractedField:
    """One field read off the document.

    ``value`` is already in this platform's shape: an ISO ``YYYY-MM-DD`` string
    for a date, a lowercase ``male``/``female``/``other`` for gender, an
    uppercased passport number. Adapters do that conversion so that every
    consumer — the API response, the form fill, the audit — sees one format.
    """

    value: str
    #: 0..1, or ``None`` when the provider does not score this field.
    confidence: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"value": self.value, "confidence": self.confidence}


@dataclasses.dataclass(frozen=True, slots=True)
class PassextRaw:
    """Internal carrier for a provider's untouched response plus its metadata."""

    body: dict[str, Any]
    model: str | None = None
    api_version: str | None = None


@dataclasses.dataclass(slots=True)
class PassportExtraction:
    """The whole answer: our fields, the provider's own words, and the timing."""

    #: ``{"passport_number": ExtractedField("P1234567", 0.99), ...}``. Only
    #: fields the provider actually read appear — a missing key means "not
    #: found", which is different from an empty string and is rendered
    #: differently.
    fields: dict[str, ExtractedField]
    provider: str
    model: str | None = None
    api_version: str | None = None
    #: Exactly what came back, kept for debugging a normalisation bug without
    #: asking the merchant to re-upload.
    raw: dict[str, Any] | None = None
    processing_ms: int | None = None

    @property
    def overall_confidence(self) -> float | None:
        """The mean of the scored fields, or ``None`` if nothing was scored.

        A mean rather than a minimum: the minimum is almost always the same
        field (the expiry date) and would report every scan as its worst line,
        which stops distinguishing a good read from a bad one. The per-field
        numbers are what the merchant actually acts on; this is for sorting.
        """
        scored = [f.confidence for f in self.fields.values() if f.confidence is not None]
        if not scored:
            return None
        return round(sum(scored) / len(scored), 4)

    def normalized_dict(self) -> dict[str, Any]:
        """The JSONB shape stored in ``passport_ocr_extractions.normalized``."""
        return {name: f.as_dict() for name, f in self.fields.items()}


class PassportOCRProvider(Protocol):
    """What a vendor adapter has to provide. Two members, no lifecycle.

    Deliberately synchronous. The one caller runs it on a worker thread and
    polls, because that is what lets a slow provider return a 202 without the
    rest of the application becoming async.
    """

    #: Stable identifier stored on every row this provider produces.
    name: str

    def extract(self, content: bytes, content_type: str) -> PassportExtraction:
        """Read a passport, or raise an :class:`OCRError`."""
        ...


# ---------------------------------------------------------------------------
# Shared conversion helpers, used by every adapter
# ---------------------------------------------------------------------------
_GENDER_MAP = {
    "m": "male", "male": "male",
    "f": "female", "female": "female",
    "x": "other", "other": "other", "u": "other",
}


def to_gender(raw: str | None) -> str | None:
    """Vendor gender to this platform's ``gender_enum`` value."""
    if not raw:
        return None
    return _GENDER_MAP.get(str(raw).strip().lower())


def to_iso_date(raw: Any) -> str | None:
    """Anything date-shaped to ``YYYY-MM-DD``, or ``None``.

    Providers return dates in several shapes even within one response — a real
    date object from a typed SDK, an ISO string, or a raw ``DD MMM YYYY`` lifted
    off the page. Refusing anything unrecognised rather than guessing: a
    misparsed expiry is worse than an empty field, because an empty field is
    obviously the merchant's to fill and a wrong one looks answered.
    """
    if raw is None or raw == "":
        return None
    if isinstance(raw, dt.date):
        return raw.isoformat()
    text = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d %b %Y", "%d %B %Y", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def clean_text(raw: Any) -> str | None:
    """Trim and collapse whitespace; empty becomes ``None``."""
    if raw is None:
        return None
    collapsed = " ".join(str(raw).split())
    return collapsed or None


# ---------------------------------------------------------------------------
# The machine-readable zone
# ---------------------------------------------------------------------------
# WHY THIS IS PARSED HERE AND NOT LEFT TO THE VENDOR
# The MRZ is the only part of a passport designed to be read by a machine, and
# it carries its own CHECK DIGITS. That makes it the one field whose correctness
# can be established without trusting the OCR engine at all: if the digits
# verify, the passport number and the two dates are right, whatever confidence
# the vendor attached to its own reading of the printed page above. Every
# provider returns the MRZ; none of them will do this for us; and doing it here
# means a future Google Vision or Textract adapter inherits it for free.
_MRZ_WEIGHTS = (7, 3, 1)


def _mrz_char_value(ch: str) -> int:
    if ch == "<":
        return 0
    if ch.isdigit():
        return int(ch)
    if "A" <= ch <= "Z":
        return ord(ch) - ord("A") + 10
    return -1  # anything else cannot appear in an MRZ and must fail the digit


def mrz_check_digit(block: str) -> int | None:
    """ICAO 9303 check digit for one MRZ block, or ``None`` if unreadable."""
    total = 0
    for i, ch in enumerate(block):
        value = _mrz_char_value(ch)
        if value < 0:
            return None
        total += value * _MRZ_WEIGHTS[i % 3]
    return total % 10


def _mrz_date(yymmdd: str, *, birth: bool) -> str | None:
    """``YYMMDD`` to ISO, choosing the century the document makes plausible.

    The MRZ stores two digits, so "12" is 1912, 2012 or 2112 and only context
    decides. A fixed pivot gets this wrong in the direction that matters: an
    EXPIRY of "12" read in 2026 is a passport that expired in 2012, not one
    valid until 2112 — and "valid for another 86 years" would sail through every
    expiry rule this platform has.

    So the century is chosen by plausibility rather than by a rule of thumb: the
    candidate nearest today wins, and a DATE OF BIRTH additionally may not be in
    the future. Passports are issued for at most ten years, so for any real
    document the nearest candidate is the right one by a margin of a century.
    """
    if len(yymmdd) != 6 or not yymmdd.isdigit():
        return None
    yy, mm, dd = int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:6])
    today = dt.date.today()

    best: dt.date | None = None
    for century in (1900, 2000, 2100):
        try:
            candidate = dt.date(century + yy, mm, dd)
        except ValueError:
            continue  # 31 February, and 29 February of a non-leap century
        if birth and candidate > today:
            continue
        if best is None or abs((candidate - today).days) < abs((best - today).days):
            best = candidate
    return best.isoformat() if best else None


@dataclasses.dataclass(frozen=True, slots=True)
class MRZResult:
    """What the machine-readable zone says, and whether it verifies."""

    text: str
    fields: dict[str, str]
    #: Which blocks passed their own check digit. A field whose digit failed is
    #: still reported — it is evidence, not truth — but never used to override a
    #: printed-page reading.
    verified: dict[str, bool]

    @property
    def all_verified(self) -> bool:
        return bool(self.verified) and all(self.verified.values())


def parse_mrz(raw: Any) -> MRZResult | None:
    """Parse a TD3 (passport) machine-readable zone.

    Returns ``None`` for anything that is not two 44-character lines — a TD1 ID
    card, a partial read, or a vendor that handed back prose. Refusing is the
    right answer: half an MRZ verifies nothing, and a wrong passport number
    presented as machine-verified is worse than no MRZ at all.
    """
    if raw is None:
        return None
    lines = [
        "".join(line.split()).upper()
        for line in str(raw).replace("\\n", "\n").splitlines()
        if line.strip()
    ]
    # Some providers hand back one 88-character run with the newline lost.
    if len(lines) == 1 and len(lines[0]) == 88:
        lines = [lines[0][:44], lines[0][44:]]

    if len(lines) != 2 or any(len(line) != 44 for line in lines):
        return None

    l1, l2 = lines
    if not l1.startswith("P"):
        return None  # TD3 documents that are not passports are not ours to read

    fields: dict[str, str] = {}
    verified: dict[str, bool] = {}

    names = l1[5:44].split("<<", 1)
    surname = names[0].replace("<", " ").strip()
    given = (names[1].replace("<", " ").strip() if len(names) > 1 else "")
    if surname:
        fields["last_name"] = surname
    if given:
        fields["first_name"] = given

    issuing = l1[2:5].replace("<", "").strip()
    if issuing:
        fields["passport_issue_country"] = issuing
    # `P` alone is an ordinary passport; `PD`, `PS`, `PO` etc. are diplomatic,
    # service and official. The second character is the distinction and is `<`
    # when there is none.
    fields["passport_type"] = l1[:2].replace("<", "").strip() or "P"

    number = l2[0:9].replace("<", "").strip()
    if number:
        fields["passport_number"] = number
        verified["passport_number"] = (
            mrz_check_digit(l2[0:9]) == (int(l2[9]) if l2[9].isdigit() else -1)
        )

    nationality = l2[10:13].replace("<", "").strip()
    if nationality:
        fields["nationality"] = nationality

    dob = _mrz_date(l2[13:19], birth=True)
    if dob:
        fields["dob"] = dob
        verified["dob"] = mrz_check_digit(l2[13:19]) == (
            int(l2[19]) if l2[19].isdigit() else -1
        )

    gender = to_gender(l2[20])
    if gender:
        fields["gender"] = gender

    expiry = _mrz_date(l2[21:27], birth=False)
    if expiry:
        fields["passport_expiry"] = expiry
        verified["passport_expiry"] = mrz_check_digit(l2[21:27]) == (
            int(l2[27]) if l2[27].isdigit() else -1
        )

    return MRZResult(text=f"{l1}\n{l2}", fields=fields, verified=verified)


#: Confidence attached to a value whose ICAO check digit verifies. Not 1.0 by
#: convention but by argument: the check digit is arithmetic over the characters
#: themselves, so a value that passes it was read correctly or the digit would
#: not add up. It is the only field on this form that is *proved* rather than
#: estimated, and it must outrank the vendor's own score for the same field.
MRZ_VERIFIED_CONFIDENCE = 1.0

#: Confidence for an MRZ-derived value whose check digit did NOT verify, or that
#: has no digit of its own (the name lines carry none). Deliberately inside the
#: "check this" band so it is coloured for review rather than trusted.
MRZ_UNVERIFIED_CONFIDENCE = 0.80


def merge_mrz(
    printed: dict[str, ExtractedField], mrz: MRZResult | None
) -> dict[str, ExtractedField]:
    """Combine the printed-page reading with the machine-readable zone.

    THE MRZ WINS WHERE IT PROVES ITSELF. A passport number whose check digit
    verifies is not a confident guess, it is arithmetic; preferring the vendor's
    reading of the ornate printed number over it would be choosing the weaker
    evidence. Where the digit does not verify — or the block has no digit, as the
    name lines do not — the MRZ only FILLS what the page did not give, and never
    overrides it, because an unverified MRZ read is just a second OCR pass over a
    different part of the same image.

    Nothing here invents: every value returned came off the document one way or
    the other, and a field neither source produced stays absent.
    """
    if mrz is None:
        return printed

    out = dict(printed)
    for name, value in mrz.fields.items():
        verified = mrz.verified.get(name, False)
        if verified:
            out[name] = ExtractedField(value=value, confidence=MRZ_VERIFIED_CONFIDENCE)
        elif name not in out:
            out[name] = ExtractedField(value=value, confidence=MRZ_UNVERIFIED_CONFIDENCE)

    # The zone itself, so the merchant can read the two lines under a doubtful
    # field and the desk can see what the arithmetic was done on.
    out["mrz"] = ExtractedField(
        value=mrz.text,
        confidence=MRZ_VERIFIED_CONFIDENCE if mrz.all_verified else MRZ_UNVERIFIED_CONFIDENCE,
    )
    return out
