"""Read the passport that was actually uploaded, on this server, with no vendor.

WHAT THIS REPLACED, AND WHY IT MATTERS
The provider that used to stand here invented a passenger from the SHA-256 of
the uploaded bytes: it never opened the image. Every extraction this platform
had ever recorded came from it. A merchant uploading a real passport got a real
*looking* name that belonged to nobody, at 99% confidence, and the only way to
notice was to know that ``ARJUN`` and ``SHARMA`` were the first entries in two
hard-coded tuples. Nothing in this module can do that. Every value it returns
was read off the document; a field it cannot read is absent, and absent renders
as an empty box the merchant fills in.

THE MACHINE-READABLE ZONE IS THE ANSWER, NOT A TWELFTH FIELD
The printed face of a passport is a design exercise — ornate fonts, a security
pattern under the text, a different layout per issuing country. The two lines at
the bottom are the opposite: fixed-width OCR-B in a layout ICAO 9303 specifies
character by character, carrying CHECK DIGITS over the passport number, the date
of birth and the expiry. So this reads the whole page but *trusts* the zone, and
``base.merge_mrz`` already encodes the rule — a block whose check digit verifies
is arithmetic and outranks any reading of the printed line above it.

That layout is also what makes correction possible without guessing. Position 13
of the second line is a digit because the standard says so, so an ``O`` there is
a misread ``0`` and not a decision about what the passport says. Where that is
not enough, :func:`_repair_block` searches one-character alternatives and keeps
a candidate ONLY IF THE DOCUMENT'S OWN CHECK DIGIT THEN VERIFIES — the passport
confirms the correction, or the correction is discarded and the field is
reported unverified for the merchant to check.

WHAT IT CANNOT READ, IT SAYS SO
Place of birth and date of issue are not in the zone; they exist only on the
printed page, found by their label, and are returned at a confidence that puts
them in the review band because "the value under the label I recognised" is a
weaker claim than arithmetic. If the zone cannot be found at all, this raises
:class:`OCRFailed` — a passport read with no verified identifier is not a poor
result to be dressed up, it is no result.
"""
from __future__ import annotations

import datetime as dt
import io
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from app.services.passport_ocr.base import (
    ExtractedField,
    OCRFailed,
    PassportExtraction,
    merge_mrz,
    mrz_check_digit,
    parse_mrz,
    to_iso_date,
)

logger = logging.getLogger(__name__)

#: Shown to the merchant, verbatim, whenever the document cannot be read. One
#: string so the endpoint, the poll response and the form all say the same
#: thing, and so it cannot drift into a message that hints data was produced.
UNREADABLE = (
    "Unable to extract passport information. Please upload a clearer passport "
    "image or enter the details manually."
)

#: A DIFFERENT FAILURE, AND THE USER CAN FIX THIS ONE. The message above is
#: right when the page could not be read; it is useless advice when the page
#: was readable and the strip simply was not photographed. Cropping the two
#: code lines off the bottom edge is the single commonest way to take an
#: unusable passport picture, and "upload a clearer image" sends someone off
#: to re-shoot at higher quality with the same framing and the same result.
#: Line 2 carries the passport number, date of birth, sex and expiry with a
#: check digit on each -- out of frame, those characters do not exist in the
#: file, and no provider can recover them.
ZONE_INCOMPLETE = (
    "We can see the passport page, but not the two lines of code across the "
    "very bottom — and that strip is where the passport number, date of birth "
    "and expiry are read from. Photograph the page flat with the whole of it "
    "in frame, including the bottom edge, and in focus."
)

#: Nothing legible came back at all. Distinguished from the message below
#: because the advice is opposite: this one is about the PICTURE, and telling
#: someone to upload a different page when their passport was simply out of
#: focus sends them looking for a problem that is not there.
NOTHING_LEGIBLE = (
    "We could not read any text on this image. It may be blurred, too small, "
    "too dark, or a blank page. Photograph the passport in good light, hold "
    "the camera steady, and let the page fill the frame."
)

#: Legible, and not a passport. Saying "upload a clearer image" here is the
#: least useful thing possible: the image was perfectly clear, it was of the
#: wrong thing — a visa page, a boarding pass, the back cover, an ID card.
NOT_A_PASSPORT = (
    "This does not look like the photo page of a passport. Upload the page "
    "that has the photograph, the name and date of birth, and the two lines "
    "of code across the bottom."
)

_MRZ_LINE_LENGTH = 44
_MRZ_ALPHABET = re.compile(r"[^A-Z0-9<]")

#: ISO 3166-1 alpha-3, plus the codes ICAO 9303 adds for documents no country
#: issues on its own behalf. Used ONLY to break a tie between the two places
#: the zone names the country, never to reject a code: a genuine code missing
#: from this list simply leaves the tie unbroken and the previous behaviour
#: standing, which is why being out of date here cannot produce a wrong answer.
_COUNTRY_CODES = frozenset("""
ABW AFG AGO AIA ALA ALB AND ARE ARG ARM ASM ATA ATF ATG AUS AUT AZE
BDI BEL BEN BES BFA BGD BGR BHR BHS BIH BLM BLR BLZ BMU BOL BRA BRB BRN BTN BVT BWA
CAF CAN CCK CHE CHL CHN CIV CMR COD COG COK COL COM CPV CRI CUB CUW CXR CYM CYP CZE
DEU DJI DMA DNK DOM DZA ECU EGY ERI ESH ESP EST ETH FIN FJI FLK FRA FRO FSM
GAB GBR GEO GGY GHA GIB GIN GLP GMB GNB GNQ GRC GRD GRL GTM GUF GUM GUY
HKG HMD HND HRV HTI HUN IDN IMN IND IOT IRL IRN IRQ ISL ISR ITA JAM JEY JOR JPN
KAZ KEN KGZ KHM KIR KNA KOR KWT LAO LBN LBR LBY LCA LIE LKA LSO LTU LUX LVA
MAC MAF MAR MCO MDA MDG MDV MEX MHL MKD MLI MLT MMR MNE MNG MNP MOZ MRT MSR MTQ MUS MWI MYS MYT
NAM NCL NER NFK NGA NIC NIU NLD NOR NPL NRU NZL OMN
PAK PAN PCN PER PHL PLW PNG POL PRI PRK PRT PRY PSE PYF QAT REU ROU RUS RWA
SAU SDN SEN SGP SGS SHN SJM SLB SLE SLV SMR SOM SPM SRB SSD STP SUR SVK SVN SWE SWZ SXM SYC SYR
TCA TCD TGO THA TJK TKL TKM TLS TON TTO TUN TUR TUV TWN TZA UGA UKR UMI URY USA UZB
VAT VCT VEN VGB VIR VNM VUT WLF WSM YEM ZAF ZMB ZWE
GBD GBN GBO GBP GBS RKS EUE UNO UNA UNK XXA XXB XXC XXX
""".split())


# ---------------------------------------------------------------------------
# The OCR engine
# ---------------------------------------------------------------------------
# Built once and shared. Loading the detection and recognition models costs
# about a second and a good deal of memory, and an extraction is a foreground
# request a merchant is waiting on — paying that per upload would make the fast
# path the slow one. Guarded because extractions run on a worker pool and two
# uploads can land together.
_engine_lock = threading.Lock()
_engine: Any = None
_engine_version: str | None = None


def _engine_or_raise() -> Any:
    global _engine, _engine_version
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is None:
            # Imported here, not at module scope: a deployment running
            # OCR_PROVIDER=none must not pay onnxruntime's import cost, and one
            # running "azure" must not need these wheels installed at all.
            from rapidocr_onnxruntime import RapidOCR

            try:
                from importlib.metadata import version

                _engine_version = version("rapidocr-onnxruntime")
            except Exception:  # a missing dist is not a reason to fail a scan
                _engine_version = None
            _engine = RapidOCR()
    return _engine


@dataclass(frozen=True, slots=True)
class _Line:
    """One line of text the engine found, with where it sits on the page."""

    text: str
    confidence: float
    #: Pixel bounds, used to find the value written under a label.
    left: float
    top: float
    right: float
    bottom: float

    @property
    def mid_y(self) -> float:
        return (self.top + self.bottom) / 2


# ---------------------------------------------------------------------------
# Getting pixels out of whatever was uploaded
# ---------------------------------------------------------------------------
def _render(content: bytes, content_type: str, *, dpi: int, max_pages: int) -> list[Any]:
    """The uploaded file as a list of RGB images, one per page worth reading."""
    from PIL import Image, ImageOps

    if (content_type or "").lower() == "application/pdf":
        import fitz  # pymupdf

        pages: list[Any] = []
        with fitz.open(stream=content, filetype="pdf") as doc:
            for page in list(doc)[:max_pages]:
                pix = page.get_pixmap(dpi=dpi)
                pages.append(
                    Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                )
        if not pages:
            raise OCRFailed(UNREADABLE)
        return pages

    try:
        image = Image.open(io.BytesIO(content))
        # A passport photographed on a phone is usually stored upright only in
        # its EXIF orientation tag. Without this the page arrives on its side
        # and the zone is unreadable for a reason that has nothing to do with
        # the photograph's quality.
        image = ImageOps.exif_transpose(image).convert("RGB")
    except OCRFailed:
        raise
    except Exception as exc:
        raise OCRFailed(UNREADABLE) from exc
    return [image]


def _scaled(image: Any) -> Any:
    """Bring the page into the size band the recogniser was trained for.

    The zone is small print: 44 characters across the width of the page. Below
    roughly a thousand pixels the `<` fillers that delimit its fields stop being
    distinguishable and the line comes back short; above about three thousand
    the extra detail buys nothing and costs seconds per pass.
    """
    from PIL import Image

    width, height = image.size
    if width < 1400:
        factor = 1400 / width
    elif width > 3000:
        factor = 3000 / width
    else:
        return image
    return image.resize(
        (max(1, round(width * factor)), max(1, round(height * factor))),
        Image.LANCZOS,
    )


def _read_lines(image: Any) -> list[_Line]:
    """Every line of text on one page, with its confidence and its box."""
    import numpy as np

    result, _ = _engine_or_raise()(np.array(_scaled(image)))
    lines: list[_Line] = []
    for entry in result or []:
        try:
            box, text, score = entry[0], entry[1], entry[2]
            xs = [float(point[0]) for point in box]
            ys = [float(point[1]) for point in box]
        except Exception:  # a shape we do not recognise is not worth a 500
            continue
        if not text:
            continue
        lines.append(
            _Line(
                text=str(text),
                confidence=float(score),
                left=min(xs), top=min(ys), right=max(xs), bottom=max(ys),
            )
        )
    return lines


# ---------------------------------------------------------------------------
# Finding and repairing the machine-readable zone
# ---------------------------------------------------------------------------
#: Characters a recogniser confuses with each other. Applied ONLY where ICAO
#: 9303 fixes the class of the position, so this converts a character into the
#: one the format requires rather than choosing between readings of the content.
_TO_DIGIT = str.maketrans({"O": "0", "Q": "0", "D": "0", "U": "0",
                           "I": "1", "L": "1", "Z": "2", "A": "4",
                           "S": "5", "G": "6", "T": "7", "B": "8"})
_TO_ALPHA = str.maketrans({"0": "O", "1": "I", "2": "Z", "4": "A",
                           "5": "S", "6": "G", "7": "T", "8": "B"})

#: Alternatives tried when a check digit does not add up, per character. Only
#: pairs a recogniser actually confuses — a wider net would eventually find some
#: string that satisfies the digit by coincidence.
_ALTERNATIVES = {
    "0": "OD", "O": "0D", "D": "0O", "Q": "0O", "U": "0",
    "1": "IL", "I": "1L", "L": "1I",
    "2": "Z", "Z": "2",
    "4": "A", "A": "4",
    "5": "S", "S": "5",
    "6": "G", "G": "6",
    "7": "T", "T": "7",
    "8": "B", "B": "8",
}


def _normalise(text: str) -> str:
    """One read line as MRZ characters only, uppercased, spaces removed."""
    upper = text.upper()
    # Recognisers render runs of the filler as guillemets or as a long dash.
    for junk in ("«", "»", "‹", "›", "≪", "≫", "—", "–", "_", "*"):
        upper = upper.replace(junk, "<")
    return _MRZ_ALPHABET.sub("", upper)


def _looks_like_mrz(candidate: str) -> bool:
    """Long, and made of the zone's alphabet rather than of prose."""
    return len(candidate) >= 30 and (candidate.count("<") >= 2 or len(candidate) >= 40)


def _zone_fragment_seen(lines: Sequence[_Line]) -> bool:
    """Was a zone line in frame, even if too little of it survived to pair?

    _looks_like_mrz screens on length, so a strip clipped by the edge of the
    photograph never reaches it. The opening P< is the giveaway: no ordinary
    line on a passport begins that way, so seeing it means the zone WAS in the
    picture and the framing, not the focus, is what needs fixing.
    """
    return any(
        _normalise(line.text).startswith("P<") and len(_normalise(line.text)) >= 8
        for line in lines
    )


#: Below this many recognised lines the page is not "hard to read", it is
#: unread. A good page gives ~29 and even a receipt gives 6; a blurred passport
#: and a blank sheet both give 0, because the detector finds no text boxes at
#: all rather than finding boxes it reads badly.
_LEGIBLE_MIN_LINES = 3
#: And a page that yielded boxes the recogniser had no confidence in is the
#: same situation by a different route.
_LEGIBLE_MIN_CONFIDENCE = 0.45


#: Diagnosis -> the code the form branches on for its one-line heading. The
#: sentence still does the explaining; this only says which sentence it is.
FAILURE_CODES = {
    "ocr_not_legible": "nothing legible",
    "ocr_not_a_passport": "not a passport page",
    "ocr_zone_incomplete": "zone missing from the frame",
}


def _diagnose(lines: Sequence[_Line]) -> tuple[str, str]:
    """Why this document produced no zone, in terms the uploader can act on.

    "Could not be read" is true of every failure here and useful for none of
    them: the three things that actually go wrong need three different actions,
    and telling someone to re-shoot a perfectly sharp photograph of the wrong
    page wastes their time twice.

    The passport's own CAPTIONS are what separate the two interesting cases.
    Measured on real uploads: a passport page with the code strip cropped away
    still yields 27 lines and five recognised captions, while a receipt yields
    six lines and none. So caption count says "this is a passport page" without
    depending on the strip that is missing, which is exactly the question.
    """
    if len(lines) < _LEGIBLE_MIN_LINES:
        return NOTHING_LEGIBLE, "ocr_not_legible"
    confidences = [line.confidence for line in lines]
    if sum(confidences) / len(confidences) < _LEGIBLE_MIN_CONFIDENCE:
        return NOTHING_LEGIBLE, "ocr_not_legible"

    looks_like_a_passport = (
        _zone_fragment_seen(lines)
        or any(_looks_like_mrz(_normalise(line.text)) for line in lines)
        or any(_label_for(_flatten(line.text)) for line in lines)
    )
    if looks_like_a_passport:
        return ZONE_INCOMPLETE, "ocr_zone_incomplete"
    return NOT_A_PASSPORT, "ocr_not_a_passport"


def _mrz_pair(lines: Sequence[_Line]) -> tuple[str, str] | None:
    """The two zone lines, in order, or ``None`` if they are not both there.

    Taken from the bottom of the page upward: the zone is the last thing on a
    passport's data page, and a name printed above it can otherwise look like a
    first line to a length test.
    """
    candidates = [
        (line, _normalise(line.text))
        for line in sorted(lines, key=lambda item: item.mid_y)
    ]
    candidates = [(line, text) for line, text in candidates if _looks_like_mrz(text)]

    # The engine sometimes returns the zone as one run with the break lost.
    for line, text in candidates:
        if len(text) >= 86:
            return text[:_MRZ_LINE_LENGTH], text[_MRZ_LINE_LENGTH:_MRZ_LINE_LENGTH * 2]

    for index, (line, text) in enumerate(candidates):
        if not text.startswith("P"):
            continue
        line_height = max(line.bottom - line.top, 1.0)
        for follower, follow_text in candidates[index + 1:]:
            # The partner line sits directly beneath, not in another block.
            #
            # COMPARED BY CENTRE, NOT BY EDGE. The obvious test -- the follower
            # starts below where this one ends -- holds only for a flat scan.
            # Photograph a passport in the hand and the page is very slightly
            # rotated, so the far end of the name line dips below the near end
            # of the line under it and the two boxes OVERLAP: a real read of
            # BHEEMISETTY/Z6965258 gave top=567..bottom=617 against a partner
            # at top=609, eight pixels of overlap, and the zone was discarded
            # whole even though both lines had come back perfect and every
            # check digit verified. Centres cannot overlap that way, so half a
            # line height of separation says "the row beneath" while still
            # rejecting a fragment sitting on the SAME row, which is what this
            # guard is actually for.
            if follower.mid_y - line.mid_y < line_height * 0.5:
                continue
            return text, follow_text
    return None


def _fit(block: str, length: int) -> str:
    """Pad with the filler or trim to exactly ``length``."""
    return block.ljust(length, "<")[:length]


def _coerce(block: str, *, digits: bool) -> str:
    """Force one field into the character class its position requires."""
    table = _TO_DIGIT if digits else _TO_ALPHA
    return block.translate(table)


def _repair_block(block: str, expected: str) -> str | None:
    """Try single-character alternatives until the check digit verifies.

    Returns the corrected block, or ``None`` if no single substitution makes the
    arithmetic work — in which case the field is reported as read and marked
    unverified, never quietly replaced with something that merely looks better.
    """
    if not expected.isdigit():
        return None
    target = int(expected)
    if mrz_check_digit(block) == target:
        return block
    for position, character in enumerate(block):
        for replacement in _ALTERNATIVES.get(character, ""):
            candidate = block[:position] + replacement + block[position + 1:]
            if mrz_check_digit(candidate) == target:
                return candidate
    return None


def _realign_line1(line1: str, nationality: str) -> str:
    """Undo a dropped filler that has shifted the whole of the first line.

    THE FIRST LINE HAS NO CHECK DIGIT, which makes this the one part of the zone
    that can be wrong without the arithmetic noticing. Its second character is
    ``<`` on every ordinary passport — a lone filler between the ``P`` and the
    issuing state — and a recogniser that misses one narrow glyph returns
    ``PGBRERIKSSON…`` for ``P<GBRERIKSSON…``. Every field then sits one place to
    the left: the type reads ``PG``, the state reads ``BRE``, and the surname
    comes back as ``RIKSSON`` — a name close enough to a real one to be typed
    onto a ticket without a second look.

    The second line is the fix, because it carries the NATIONALITY at a position
    the standard fixes, and for essentially every passport the issuing state and
    the nationality are the same three letters. So the alignment that puts them
    equal is the alignment the document actually has. This does not invent the
    state — it locates a filler the page already had and the reader lost, and
    where the two genuinely differ no shift matches and the line is left alone.
    """
    if len(nationality) != 3 or line1[2:5] == nationality:
        return line1
    for gap in (1, 2):
        if line1[2 - gap:5 - gap] == nationality:
            return _fit(line1[:1] + "<" * gap + line1[1:], _MRZ_LINE_LENGTH)
    # The opposite slip: a speck read as a character, pushing the line right.
    if line1[3:6] == nationality:
        return _fit(line1[:1] + line1[2:], _MRZ_LINE_LENGTH)
    return line1


def _repair_td3(line1: str, line2: str) -> tuple[str, str, bool]:
    """Both zone lines, coerced to the ICAO layout and check-digit corrected.

    The third value is whether the first line's fixed-width head could be
    located. When it could not, the issuing state is erased rather than
    reported: the characters at those positions are then not known to be the
    issuing state at all, and ``RER`` — which is not a country — read off a
    passport is worse than an empty box the merchant fills, because it is a
    plausible-looking value nobody entered. That is the same failure as the
    provider this replaced, in miniature.
    """
    line1 = _fit(line1, _MRZ_LINE_LENGTH)
    line2 = _fit(line2, _MRZ_LINE_LENGTH)

    # Line 2, by the standard's own field boundaries. The passport number is the
    # one field the standard leaves ALPHANUMERIC, so it is the one block that
    # cannot be coerced by character class at all — it is left exactly as read
    # and corrected, if at all, by its check digit below.
    number = line2[0:9]
    number_digit = _coerce(line2[9:10], digits=True)
    nationality = _coerce(line2[10:13], digits=False)
    dob = _coerce(line2[13:19], digits=True)
    dob_digit = _coerce(line2[19:20], digits=True)
    sex = _coerce(line2[20:21], digits=False)
    expiry = _coerce(line2[21:27], digits=True)
    expiry_digit = _coerce(line2[27:28], digits=True)
    personal = line2[28:43]
    final_digit = _coerce(line2[43:44], digits=True)

    number = _repair_block(number, number_digit) or number
    dob = _repair_block(dob, dob_digit) or dob
    expiry = _repair_block(expiry, expiry_digit) or expiry

    line2 = (
        number + number_digit + nationality + dob + dob_digit
        + sex + expiry + expiry_digit + personal + final_digit
    )

    # Line 1 last: it is realigned against the nationality the line above has
    # just settled, and only then coerced into P / type / issuing state.
    line1 = _realign_line1(line1, nationality)

    # THE ZONE NAMES THE COUNTRY TWICE, SO A DISAGREEMENT IDENTIFIES A MISREAD.
    # Nationality sits outside every check digit — the composite covers
    # positions 1-10, 14-20 and 22-43, and skips 11-13 — so it is the one field
    # here that arithmetic cannot settle. But the issuing state on the line
    # above is the same three letters on essentially every passport, which
    # makes the pair its own cross-check.
    #
    # Observed: line 2's nationality came off the page as ``12D`` and coerced
    # to ``IZD`` (1->I is right, 2->Z is not), while line 1 read ``IND``
    # correctly. Disagreement previously meant "line 1 is not where the
    # standard puts it", so line 1's head was erased — the CORRECT reading
    # thrown away in favour of the wrong one, which put IZD on the form as a
    # nationality and left Issuing Country blank. One misread character, two
    # broken fields, with the answer sitting in plain view on the other line.
    #
    # So when they differ, a real country code beats one that is not a country.
    # Only ever applied when exactly one side is a known code: two plausible
    # codes that disagree is a genuine ambiguity, and that still falls through
    # to the alignment rule below rather than being guessed at.
    state = _coerce(line1[2:5], digits=False)
    if state != nationality:
        state_known = state in _COUNTRY_CODES
        nationality_known = nationality in _COUNTRY_CODES
        if state_known and not nationality_known:
            nationality = state
            line2 = line2[:10] + state + line2[13:]

    aligned = state == nationality
    # THE NAME FIELD IS LETTERS AND FILLERS, SO A DIGIT IN IT IS A MISREAD.
    # Positions 6-44 carry no digit under the standard, which makes this the
    # same unambiguous correction already applied to the nationality and sex
    # blocks -- not a guess about what the passport says. Left uncoerced, a
    # zone reading BENU<G0PAL reached the form as "BENU 6PAL", and because the
    # name lines carry no check digit nothing downstream could notice: the
    # digit is invisible to the arithmetic and looks deliberate to a merchant.
    names = _coerce(line1[5:], digits=False)
    if aligned:
        line1 = (
            "P" + _coerce(line1[1:2], digits=False)
            + _coerce(line1[2:5], digits=False) + names
        )
    else:
        # The head is not where the standard puts it and no shift explains that,
        # so nothing between the P and the names is known. The NAMES are kept —
        # they are reconciled against the printed page, which does not depend on
        # this alignment — and the issuing state is dropped.
        line1 = "P<<<<" + names
    return _fit(line1, _MRZ_LINE_LENGTH), _fit(line2, _MRZ_LINE_LENGTH), aligned


# ---------------------------------------------------------------------------
# The printed page: the two fields the zone does not carry
# ---------------------------------------------------------------------------
_LABELS = {
    # Checked in order, and "givennames" contains "surname" nowhere but does
    # contain "name" — so the given-names label is tested FIRST and no entry
    # here may be a bare substring of another label on the same page.
    "first_name": (
        "givennames", "givenname", "prenoms", "forenames", "nombres", "vornamen",
    ),
    "last_name": (
        "surname", "apellidos", "familyname", "nomdefamille", "nachname",
    ),
    "place_of_birth": (
        "placeofbirth", "lieudenaissance", "birthplace", "placeofbirthlieudenaissance",
        "lugardenacimiento", "geburtsort",
    ),
    "passport_issue_date": (
        "dateofissue", "datedelivrance", "datededelivrance", "issuedate",
        "dateofissuedatededelivrance", "fechadeexpedicion", "ausstellungsdatum",
    ),
}

#: A label read correctly and the value beneath it associated correctly are two
#: claims, and the product of two near-certainties is not a near-certainty. This
#: keeps page-derived fields inside the band the form colours for review, which
#: is the honest place for them next to a check-digit-verified number.
_PRINTED_DISCOUNT = 0.75


def _flatten(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


#: How close a line has to sit to a label before it counts as that label, and
#: how far clear of the RUNNER-UP it must be. Both are needed, and the second is
#: the one that matters.
#:
#: Exact matching fails on a photographed page for a dull reason: the caption is
#: printed small and bilingually, and the recogniser drops single letters out of
#: it. Real readings off one Indian passport were ``paceofbirth`` for Place of
#: Birth and ``aeoflssue`` for Date of Issue — both unmistakable to a person,
#: neither containing the string being searched for, so both fields came back
#: empty however good the photograph was.
#:
#: A threshold alone would be dangerous here, because the labels this page
#: carries are near-anagrams of each other. Measured on that same page:
#:
#:     paceofbirth   -> place_of_birth 0.957   runner-up 0.526
#:     aeoflssue     -> issue_date     0.800   runner-up 0.545
#:     tsuname       -> last_name      0.923   runner-up 0.615
#:     fdateofbirth  -> place_of_birth 0.818   runner-up 0.737   <-- DATE of birth
#:     plaeflssue    -> issue_date     0.737                     <-- PLACE of issue
#:
#: ``fdateofbirth`` is Date of Birth and scores 0.818 against *place* of birth —
#: above any threshold that still admits ``aeoflssue`` at 0.800. What separates
#: it is that it fits two labels almost equally well: 0.081 clear of the runner
#: up, where every true match is 0.231 or better. So a line that suits two
#: labels is refused rather than assigned to the closer one, which is the same
#: rule the rest of this module follows — an ambiguous read is not a read.
#: 0.70 rather than 0.78, measured against a SECOND page — a 739px photograph,
#: where the same captions arrive far worse: ``tsumame`` (0.769) for Surname and
#: ``facefbih`` (0.700) for Place of Birth, both correct and both refused at
#: 0.78. Nothing dangerous moves at 0.70: Date of Expiry reads ``hraadaeofexpry``
#: and scores 0.632 against the issue date, Place of Issue ``tfacesue`` 0.545,
#: and Date of Birth is still held out by the margin rule, not the threshold.
#: A date field is self-guarding anyway — ``Place of Issue`` matching the issue
#: date costs nothing because the value beneath it must parse as a date, and
#: ``HYDERABAD`` does not, so the field simply stays unset.
_LABEL_MIN = 0.70
_LABEL_MARGIN = 0.15


def _label_score(flat: str, target: str) -> float:
    """How well ``target`` fits anywhere in ``flat``, 0..1."""
    if target in flat:
        return 1.0
    if len(flat) < 4:
        return 0.0
    from difflib import SequenceMatcher

    best = SequenceMatcher(None, target, flat).ratio()
    # Windows as well as the whole line: the caption arrives with the tail of
    # the Devanagari beside it ("Ig/GivenName(s)"), and the label is a fragment
    # of the line rather than the whole of it.
    span = len(target)
    for width in range(max(4, span - 3), min(len(flat), span + 3) + 1):
        for start in range(0, len(flat) - width + 1):
            score = SequenceMatcher(None, target, flat[start:start + width]).ratio()
            if score > best:
                best = score
    return best


def _label_for(flat: str) -> str | None:
    """Which field this line is the caption for, or ``None`` if unclear."""
    scored = sorted(
        (
            (max(_label_score(flat, label) for label in labels), field)
            for field, labels in _LABELS.items()
        ),
        reverse=True,
    )
    if not scored or scored[0][0] < _LABEL_MIN:
        return None
    if len(scored) > 1 and scored[0][0] - scored[1][0] < _LABEL_MARGIN:
        return None
    return scored[0][1]


def _date_candidates(text: str) -> list[str]:
    """The readings of a printed date worth trying, commonest first.

    A recogniser drops the thin space between a month name and the digits
    beside it far more often than it misreads a character: ``15 APR 2021``
    comes back as ``15 APR2021`` and ``12 AUG 1974`` as ``12 AUG1974``. That
    parses as nothing at all, so the date of issue silently vanished from
    otherwise perfect reads — which looks exactly like a field the passport
    does not carry.

    Restoring the separator is safe in a way that guessing a digit is not: it
    changes no character, only where one word ends. Both readings are offered
    and the first that parses wins; if neither does the field stays absent,
    because a date this platform cannot read is a date the merchant types.
    """
    collapsed = " ".join(text.split())
    spaced = re.sub(r"(?<=[0-9])(?=[A-Za-z])|(?<=[A-Za-z])(?=[0-9])", " ", collapsed)
    separated = collapsed.replace(".", "-").replace("/", "-")
    return [c for c in dict.fromkeys((collapsed, spaced, separated)) if c]


def _value_under(label: _Line, lines: Iterable[_Line]) -> _Line | None:
    """The nearest line below a label that overlaps it horizontally.

    BELOW IS DECIDED BY CENTRES, NOT BY EDGES -- the same correction the zone
    pairing needed, and for the same reason. "Starts below where the label
    ends" describes a flat scan; photograph the page in the hand and a degree
    of rotation makes the value's box start a few pixels ABOVE the bottom of
    its own label. Measured on a real read, ``Given Name(s)`` ended at 300 and
    ``VENKAT RAMU NAIDU`` began at 297: three pixels, and the true value was
    skipped in favour of the next line that cleared the label -- the ``Sex``
    caption further down, which is how ``E/SEX`` came to be a given name.
    Centres cannot overlap that way, and half a label height still rejects a
    line sitting on the SAME row, which is what this guard is for.
    """
    best: _Line | None = None
    label_height = max(label.bottom - label.top, 1.0)
    for line in lines:
        if line is label or line.mid_y - label.mid_y < label_height * 0.5:
            continue
        if line.right < label.left or line.left > label.right + (label.right - label.left):
            continue
        # AND IT MUST START IN THE SAME COLUMN. A data page sets the value
        # directly beneath its caption on a shared left edge, so the left edge
        # is what identifies the column — and these pages have two of them.
        # Allowing anything up to a label's width to the right reaches into the
        # neighbouring column: "Date of Issue" spanned 661..839, which admitted
        # everything out to 1017, and the Date of EXPIRY value at 981 sat inside
        # that window one line higher than the real answer at 662. The issue
        # date on the form was then the expiry, off by ten years, on a field
        # whose whole purpose is to be compared against the expiry.
        if abs(line.left - label.left) > max((label.right - label.left) * 0.5, 24.0):
            continue
        if best is None or line.top < best.top:
            best = line
    return best


def _printed_fields(lines: Sequence[_Line]) -> dict[str, ExtractedField]:
    """Place of birth and date of issue, found by their label on the page."""
    found: dict[str, ExtractedField] = {}
    for line in lines:
        # One winner per line, decided by score rather than by the order the
        # fields happen to be declared in. The old substring test needed
        # first_name checked before last_name because "givennames" contains
        # "name"; scoring makes that ordering irrelevant, because the better
        # fit wins outright and a line that fits two is refused.
        field = _label_for(_flatten(line.text))
        if field is None or field in found:
            continue
        value_line = _value_under(line, lines)
        if value_line is None:
            continue
        confidence = round(
            min(line.confidence, value_line.confidence) * _PRINTED_DISCOUNT, 4
        )
        if field == "passport_issue_date":
            iso = next(
                (d for d in map(to_iso_date, _date_candidates(value_line.text)) if d),
                None,
            )
            if iso:
                found[field] = ExtractedField(iso, confidence)
        else:
            text = " ".join(value_line.text.split()).upper()
            # A label with nothing under it finds the next label instead. Tested
            # with the same scorer, so a MANGLED caption underneath is caught
            # too — the exact test let "Paceof Birth" through as a value.
            if text and _label_for(_flatten(text)) is None:
                found[field] = ExtractedField(text, confidence)
    return found


def _fold(value: str) -> str:
    """A name reduced to the letters it has in common with the zone's spelling."""
    return re.sub(r"[^A-Z]", "", value.upper())


_NAME_SHAPE = re.compile(r"[A-Z][A-Z '.-]*")


def _plausible_name(value: str | None) -> bool:
    """Is this a name, or something caught off a caption?

    The page-wins rule in :func:`_reconcile_names` assumes the printed reading
    is a NAME read badly. It is sometimes not a name at all: an Indian passport
    labels its fields bilingually, and a photographed one put the tail of
    "लिंग / Sex" into the given names as E/SEX, which then beat a zone
    spelling VENKAT<RAMU<NAIDU. A caption fragment is cheap to recognise and
    nothing is lost by refusing it -- no name contains a slash or a digit.
    """
    if not value:
        return False
    folded = value.strip().upper()
    if not _NAME_SHAPE.fullmatch(folded):
        return False
    return sum(character.isalpha() for character in folded) >= 2


def _reconcile_names(
    fields: dict[str, ExtractedField], printed: dict[str, ExtractedField]
) -> None:
    """Weigh the printed name against the zone's, and say which this is.

    THE NAME LINES CARRY NO CHECK DIGIT — the one identifying field on this form
    that arithmetic cannot settle. But the name is written twice on a passport,
    once in the zone and once on the page above it in a different typeface, and
    two independent readings that agree are far better evidence than either
    alone. Agreement therefore lifts the field out of the review band.

    ON DISAGREEMENT THE PAGE WINS, WHICH IS THE OPPOSITE OF EVERY OTHER FIELD
    HERE. Elsewhere the zone is the better evidence because a check digit proves
    it; on the name lines there is no digit to prove anything, and the zone is
    the hardest text on the document for a general-purpose recogniser — one long
    run of fixed-width glyphs padded with fillers, where a dropped character is
    invisible. The printed name above it is ordinary text in an ordinary
    typeface. Observed on this very page: the zone read ``PRIKSDN`` where the
    printed line read ``ERIKSSON``, and a surname that close to right is exactly
    the kind that gets typed onto a ticket unexamined.

    So the page's reading is taken and its confidence is dropped BELOW what
    either source claimed, because two readings that contradict each other are
    worse evidence than one that stands alone. The zone is on the form anyway,
    read-only, for the merchant to arbitrate against.
    """
    for field in ("last_name", "first_name"):
        page_read = printed.get(field)
        if page_read is None:
            continue
        zone_read = fields.get(field)
        page_is_a_name = _plausible_name(page_read.value)
        if zone_read is None:
            # Nothing to weigh it against. A caption fragment is still not a
            # name, and absent beats wrong on a field that becomes a ticket.
            if page_is_a_name:
                fields[field] = page_read
        elif not page_is_a_name:
            # The page did not read this field, it read the label next to it.
            # There is nothing to reconcile, so the zone stands on its own.
            fields[field] = zone_read
        elif _fold(page_read.value) == _fold(zone_read.value):
            fields[field] = ExtractedField(zone_read.value, 0.95)
        else:
            fields[field] = ExtractedField(
                page_read.value, min(page_read.confidence or 0.6, 0.6)
            )


#: How far from a whole-year term a date may sit and still be that term. Three
#: days covers the usual "expires the day before the anniversary" and a leap
#: year, without reaching any other date printed on the page.
_TERM_SLACK_DAYS = 3


def _issue_date_by_elimination(
    fields: dict[str, ExtractedField],
    lines: Sequence[_Line],
    *,
    dob: str | None,
    expiry: str | None,
) -> None:
    """The issue date when its caption was unreadable, by what it cannot be.

    A LAST RESORT, AND A DEDUCTION RATHER THAN A GUESS. The data page carries
    three dates -- birth, issue, expiry -- and the zone has already named two of
    them with a check digit each. A page date that is neither, and that sits a
    whole passport term before the verified expiry, has only one thing left to
    be.

    Needed because the caption is the weakest thing on a small photograph and
    cannot always be rescued by matching it harder: a 739px scan read Date of
    Issue as ``rftdaeofs``, which scores 0.632 -- and Date of EXPIRY on the same
    page reads ``hraadaeofexpry`` and scores 0.632 too. Any threshold low enough
    to admit the first admits the second, and the second's value is a date, so
    it would be accepted and the issue date would silently become the expiry.
    That is the exact off-by-ten-years fault the column rule fixed; it must not
    come back through the other door.

    THE TWO GUARDS ARE WHAT MAKE IT SAFE. The term test does the identifying --
    a stamp in a visa page is not five or ten years before this passport's
    expiry -- and the requirement that EXACTLY ONE candidate survives does the
    refusing: photograph a passport open at a stamped page, or catch a second
    document in frame, and there is more than one answer, so it declines to
    pick. It also never runs when the caption was read.
    """
    if fields.get("passport_issue_date") is not None or not dob or not expiry:
        return
    try:
        expiry_date = dt.date.fromisoformat(expiry)
    except ValueError:
        return

    candidates: set[str] = set()
    for line in lines:
        for raw in _date_candidates(line.text):
            iso = to_iso_date(raw)
            if not iso or iso in (dob, expiry) or not dob < iso < expiry:
                continue
            try:
                issued = dt.date.fromisoformat(iso)
            except ValueError:
                continue
            for years in (10, 5):
                try:
                    anniversary = issued.replace(year=issued.year + years)
                except ValueError:
                    continue
                if abs((anniversary - expiry_date).days) <= _TERM_SLACK_DAYS:
                    candidates.add(iso)
                    break

    if len(candidates) == 1:
        # Deliberately in the review band. The arithmetic is sound, but this
        # value was never read under its own label, and the form should say so.
        fields["passport_issue_date"] = ExtractedField(candidates.pop(), 0.6)


def _adopt_page_spelling(
    fields: dict[str, ExtractedField],
    lines: Sequence[_Line],
    already_reconciled: Iterable[str],
) -> None:
    """Correct a zone-only name against its printed twin, found without a label.

    THE NAME IS ON THE PAGE TWICE AND WE ONLY NEEDED ONE OF THEM TO BE FOUND.
    ``_reconcile_names`` already prefers the printed spelling, but it can only
    weigh a value that :func:`_printed_fields` associated with a caption — and
    on a small photograph the caption is the first thing to dissolve. A real
    739px scan read the Given Names caption as ``ghennamelu``: 0.824 against
    "givennames" but only 0.054 clear of "surname", so the margin rule refused
    it, correctly, because those two captions genuinely are that similar. The
    VALUE on the line below was ``BENU GOPAL`` at 0.98 -- read perfectly, and
    thrown away for want of a caption, leaving the zone's ``BENU GPAL`` (an O
    dropped, no check digit to notice) on the form.

    So this asks a different question. It does not ask "which field is this
    line?", which needs the caption; it asks "is this line the same words the
    zone already gave me, spelled better?", which does not. A candidate has to
    look like a name, be read confidently, and be a close variant of a value
    already in hand -- so the worst it can do is respell a name we hold, never
    introduce one we do not, and never move it to a different field.

    Only names the page has NOT already spoken for are eligible: where a
    caption was matched, ``_reconcile_names`` has weighed both readings on
    better evidence than similarity and its answer stands.
    """
    from difflib import SequenceMatcher

    skip = set(already_reconciled)
    for key in ("first_name", "last_name"):
        current = fields.get(key)
        if key in skip or current is None or not current.value:
            continue
        target = _fold(current.value)
        if len(target) < 4:
            continue
        best_text: str | None = None
        best_score = 0.0
        for line in lines:
            if line.confidence < 0.80:
                continue
            text = " ".join(line.text.split()).upper()
            candidate = _fold(text)
            # An identical reading needs no correction, and the zone lines
            # themselves are not a second opinion about the zone.
            if len(candidate) < 4 or candidate == target:
                continue
            if not _plausible_name(text) or _looks_like_mrz(_normalise(line.text)):
                continue
            score = SequenceMatcher(None, target, candidate).ratio()
            if score > best_score:
                best_score, best_text = score, text
        if best_text is not None and best_score >= 0.80:
            fields[key] = ExtractedField(best_text, min(current.confidence, 0.8))


def _corroborate_issue_date(
    fields: dict[str, ExtractedField], expiry: str | None
) -> None:
    """Raise the issue date's confidence if the expiry agrees with it.

    Passports are issued for a whole number of years — five or ten almost
    everywhere — so an issue date read off the page that lands exactly that far
    before a check-digit-verified expiry has been confirmed by a second,
    independent part of the document.

    STRICTLY A CONFIRMATION. It never writes an issue date derived from the
    expiry: a value that was not read stays absent, because "ten years before
    the expiry" is a good guess and this form does not carry guesses.
    """
    issued = fields.get("passport_issue_date")
    if issued is None or not expiry:
        return
    try:
        issued_date = dt.date.fromisoformat(issued.value)
        expiry_date = dt.date.fromisoformat(expiry)
    except ValueError:
        return
    # A FEW DAYS EITHER SIDE, NOT THE EXACT ANNIVERSARY. Passports are issued
    # for a whole number of years but usually expire the day BEFORE the
    # anniversary, so an exact test almost never fires on a real document:
    # 13/09/2022 -> 12/09/2032 and 03/02/2022 -> 02/02/2032 are both ten years
    # minus a day, and both were being read correctly and then left uncorroborated.
    for years in (10, 5):
        try:
            anniversary = issued_date.replace(year=issued_date.year + years)
        except ValueError:  # 29 February
            continue
        if abs((anniversary - expiry_date).days) <= _TERM_SLACK_DAYS:
            fields["passport_issue_date"] = ExtractedField(issued.value, 0.95)
            return


# ---------------------------------------------------------------------------
# The provider
# ---------------------------------------------------------------------------
class LocalPassportProvider:
    """Reads an uploaded passport on this server. Returns only what it read."""

    name = "local"

    def __init__(self, *, dpi: int = 300, max_pages: int = 2) -> None:
        self._dpi = dpi
        self._max_pages = max_pages

    def extract(self, content: bytes, content_type: str) -> PassportExtraction:
        started = time.perf_counter()
        pages = _render(
            content, content_type, dpi=self._dpi, max_pages=self._max_pages
        )

        lines: list[_Line] = []
        pair: tuple[str, str] | None = None
        for page in pages:
            # A photographed passport is as often sideways as upright, and the
            # zone is the thing that tells us which way round the page is: if it
            # reads, the orientation was right. Upright first, so the ordinary
            # case never pays for the other three.
            for rotation in (0, 270, 90, 180):
                candidate_page = page if rotation == 0 else page.rotate(rotation, expand=True)
                page_lines = _read_lines(candidate_page)
                pair = _mrz_pair(page_lines)
                if pair is not None:
                    lines = page_lines
                    break
                if rotation == 0:
                    lines = page_lines  # keep the upright read if nothing works
            if pair is not None:
                break

        if pair is None:
            reason, code = _diagnose(lines)
            logger.info(
                "passport extraction found no machine-readable zone "
                "(%d lines read, diagnosis: %s)",
                len(lines),
                FAILURE_CODES.get(code, code),
            )
            raise OCRFailed(reason, code=code)

        line1, line2, head_aligned = _repair_td3(*pair)
        mrz = parse_mrz(f"{line1}\n{line2}")
        if mrz is None:
            raise OCRFailed(UNREADABLE)

        printed = _printed_fields(lines)
        # Names are held back from the merge and reconciled afterwards.
        # ``merge_mrz`` lets a printed value stand where the zone's own reading
        # is unverified, which is right for a field only one source has and
        # wrong for the names: it would silently prefer a label-matched line
        # over the standard's own spelling without ever comparing the two.
        printed_names = {
            field: printed.pop(field)
            for field in ("last_name", "first_name")
            if field in printed
        }
        fields = merge_mrz(printed, mrz)
        _reconcile_names(fields, printed_names)
        _adopt_page_spelling(fields, lines, printed_names)
        _corroborate_issue_date(
            fields,
            mrz.fields.get("passport_expiry") if mrz.verified.get("passport_expiry") else None,
        )
        # Only reached when the caption above was unreadable, and only decides
        # anything when exactly one page date can be the issue date.
        _issue_date_by_elimination(
            fields,
            lines,
            dob=mrz.fields.get("dob") if mrz.verified.get("dob") else None,
            expiry=(
                mrz.fields.get("passport_expiry")
                if mrz.verified.get("passport_expiry")
                else None
            ),
        )

        # A zone that parsed but yielded no identifier is not a read passport.
        if not fields.get("passport_number") and not fields.get("last_name"):
            raise OCRFailed(UNREADABLE)

        return PassportExtraction(
            fields=fields,
            provider=self.name,
            model="rapidocr-onnxruntime",
            api_version=_engine_version,
            # What was actually on the page, so a normalisation bug can be
            # diagnosed without asking the merchant to upload again. The image
            # is NOT here — only text the document already showed.
            raw={
                "mrz_lines": [line1, line2],
                "mrz_verified": dict(mrz.verified),
                #: False means the first line's head could not be located, so
                #: the issuing state was dropped rather than guessed.
                "mrz_head_aligned": head_aligned,
                "pages_read": len(pages),
                "lines": [
                    {"text": line.text, "confidence": round(line.confidence, 4)}
                    for line in lines
                ],
            },
            processing_ms=int((time.perf_counter() - started) * 1000),
        )
