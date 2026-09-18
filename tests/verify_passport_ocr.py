"""Passport OCR (migration 0042) — extraction, confidence, duplicates, audit.

WHAT THIS PROTECTS

1. **Scanning can never gate a booking.** The rule the whole feature is built
   around, and the one most likely to be broken by a later change. A booking
   raised with no scan at all still submits; a scan that FAILED still leaves the
   booking submittable; and an extraction needs no ``request_id``, because
   requiring one would recreate the exact defect CR-1 removed — attaching a
   passport forcing the merchant to save a draft first.
2. **The six-month passport rule is ENFORCED** (changed 2026-08-07). It shipped
   with CR-8 as an advisory warning, because enforcing it changed approved
   submit behaviour for every international booking on the platform — a change
   request rather than something a scanning feature decides. That change request
   has since been made, so the panel and the submit path now agree: the
   assessment comes back at ``severity: "error"`` and the submission is refused.
   Asserted in both directions, and the figure lives in ``passport_rules``.
3. **Confidence is per field, not per document.** A single document score hides
   the one field a merchant needs to check. Every field carries its own score
   and band, and the bands come from the server so two screens cannot drift.
4. **Nothing here writes passenger data.** The duplicate lookup returns no row
   id and creates no record, which is how "never create a duplicate passenger
   without confirmation" holds by construction.
5. **Scope.** A merchant sees only its own scans; another merchant gets 404, not
   403. Platform staff see a scan only once it is attached to a booking — an
   abandoned draft's passport is not the desk's to read.
6. **The scan is never public.** No presigned URL, no static mount; it is served
   only by the authenticated proxy, marked private/no-store.
7. **The edit audit records changes and only changes.** Re-saving replaces
   rather than appends, so the audit answers "what did they change" and not "how
   many times did they press Save".

RUNNING WITHOUT AN OCR PROVIDER
A deployment with ``OCR_PROVIDER=none`` is valid, and this script asserts THAT
contract instead of pretending to test extraction: availability reports
unavailable, the endpoint answers 503, and a booking still submits. It says so
loudly rather than skipping silently. Set ``OCR_PROVIDER=local`` on the
server under test to exercise the full path.
"""
import datetime
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

import minihttp as requests  # noqa: E402

import flows  # noqa: E402
from config import (  # noqa: E402
    ADMIN, ADMIN2, BASE, MANAGER, MERCHANT, PDF, PNG, SUPER, Checker, H, login,
)

check = Checker()
mtok = login(*MERCHANT)
atok = login(*ADMIN)

EXTRACT = f"{BASE}/api/bookings/passport/extract"

# ---------------------------------------------------------------------------
# The fixtures are PASSPORTS NOW, not arbitrary bytes.
# ---------------------------------------------------------------------------
# They used to be two 200-byte PNGs of nothing, which worked because the
# provider under test never looked at them: it hashed the file and invented a
# traveller. A reader that actually reads needs something to read, so the suite
# builds a passport page — printed fields and a TD3 zone whose ICAO check digits
# are COMPUTED rather than typed — and then asserts that the values coming back
# are the ones that were drawn on it.
#
# That is the assertion the old fixtures could not make. "The engine returned
# ERIKSSON" means nothing unless ERIKSSON is on the page and nowhere in the
# code; here the expected values and the image come from the same constants, so
# a provider that fabricated its answer would fail on the first field.
import io  # noqa: E402


def _mrz_lines(surname, given, country, number, dob, expiry, sex):
    from app.services.passport_ocr.base import mrz_check_digit
    line1 = f"P<{country}{surname}<<{given.replace(' ', '<')}".ljust(44, "<")[:44]
    num = number.ljust(9, "<")
    personal = "".ljust(14, "<")
    composite = (f"{num}{mrz_check_digit(num)}{dob}{mrz_check_digit(dob)}"
                 f"{expiry}{mrz_check_digit(expiry)}{personal}{mrz_check_digit(personal)}")
    line2 = (f"{num}{mrz_check_digit(num)}{country}{dob}{mrz_check_digit(dob)}{sex}"
             f"{expiry}{mrz_check_digit(expiry)}{personal}{mrz_check_digit(personal)}"
             f"{mrz_check_digit(composite)}")
    return line1, line2


def passport_png(surname, given, country, number, dob, expiry, sex,
                 birthplace, issued_text):
    """A passport data page as PNG bytes, carrying exactly these values."""
    from PIL import Image, ImageDraw, ImageFont
    line1, line2 = _mrz_lines(surname, given, country, number, dob, expiry, sex)
    font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 30)
    img = Image.new("RGB", (1240, 850), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "PASSPORT / PASSEPORT", fill="black", font=font)
    y = 110
    for label, value in (
        ("Surname / Nom", surname),
        ("Given names / Prenoms", given),
        ("Place of birth / Lieu de naissance", birthplace),
        ("Date of issue", issued_text),
    ):
        d.text((45, y), label, fill=(70, 70, 70), font=font)
        d.text((45, y + 34), value, fill="black", font=font)
        y += 100
    d.text((22, 700), line1, fill="black", font=font)
    d.text((22, 750), line2, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


#: Two DIFFERENT travellers, so "these are two passports" is a fact about the
#: documents and not about their checksums.
PAX_A = dict(surname="ERIKSSON", given="ANNA MARIA", country="GBR",
             number="L898902C3", dob="740812", expiry="310415", sex="F",
             birthplace="MANCHESTER", issued_text="15 APR 2021")
PAX_B = dict(surname="OKONKWO", given="DANIEL", country="IND",
             number="Z4471985", dob="880203", expiry="330920", sex="M",
             birthplace="KOCHI", issued_text="20 SEP 2023")

PNG_A = passport_png(**PAX_A)
PNG_B = passport_png(**PAX_B)

def _blank_png():
    """A valid PNG that is not a passport.

    Extraction must FAIL on this rather than return anything at all, which is
    the single most important assertion in this file: it is precisely what the
    removed provider did not do. Fed a blank page it produced a complete,
    confident traveller.
    """
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (1240, 850), "white").save(buf, format="PNG")
    return buf.getvalue()


PNG_BLANK = _blank_png()


# ---------------------------------------------------------------------------
print("\n== no configuration can fabricate a passenger ==")
# ---------------------------------------------------------------------------
# SERVERLESS, and first, because it is the guarantee the rest of this script
# depends on. Every provider this platform can now be pointed at reads the
# uploaded document; the one that invented people from a file checksum has been
# deleted, and asking for it by name is a hard configuration error rather than a
# silent fall back to no scanning.
import app.config as _cfg  # noqa: E402
from app.services import passport_ocr as _ocr  # noqa: E402

_saved = (_cfg.settings.ocr_provider,
          _cfg.settings.ocr_azure_endpoint, _cfg.settings.ocr_azure_key)


def _provider_for(**overrides):
    """Build a provider under a temporary configuration; report what happened."""
    for key, value in overrides.items():
        setattr(_cfg.settings, key, value)
    _ocr.reset_provider_cache()
    try:
        return getattr(_ocr.get_provider(), "name", "?"), None
    except Exception as exc:
        return None, type(exc).__name__


# THE PROVIDER THAT INVENTED PASSENGERS IS GONE, and its name is still refused
# by name. Every extraction this platform had ever recorded came from it — it
# derived a passenger from the SHA-256 of the uploaded file and never opened the
# image — so the guarantee under test is no longer "it cannot be switched on by
# accident" but "it cannot be switched on at all". An old .env or an old
# deployment script must fail loudly and say why, rather than be reported as a
# typo and fall through to no scanning.
_name, _err = _provider_for(ocr_provider="simulated")
check("the fabricating provider no longer exists", _err == "OCRMisconfigured",
      (_name, _err))
check("...and the refusal says what to use instead",
      "local" in (_ocr.configuration_error() or ""), _ocr.configuration_error())

_name, _err = _provider_for(ocr_provider="local")
check("OCR_PROVIDER=local builds the on-server reader", _name == "local", (_name, _err))

_name, _err = _provider_for(ocr_provider="azure",
                            ocr_azure_endpoint=None, ocr_azure_key=None)
check("azure selected with no credentials is a CONFIGURATION error, not a bad scan",
      _err == "OCRMisconfigured", (_name, _err))
check("...and it is reported rather than looking like 'scanning is off here'",
      "OCR_AZURE_ENDPOINT" in (_ocr.configuration_error() or ""),
      _ocr.configuration_error())

_name, _err = _provider_for(ocr_provider="azure",
                            ocr_azure_endpoint="https://x.cognitiveservices.azure.com",
                            ocr_azure_key="k")
check("azure with both settings builds the real adapter",
      _name == "azure_document_intelligence", (_name, _err))

_name, _err = _provider_for(ocr_provider="none")
check("OCR_PROVIDER=none is off, and NOT a fault",
      _err == "OCRNotConfigured" and _ocr.configuration_error() is None,
      (_err, _ocr.configuration_error()))

_name, _err = _provider_for(ocr_provider="azrue")
check("a typo'd provider name is a fault, not silence", _err == "OCRMisconfigured",
      (_name, _err))

# Put the process back exactly as it was — later sections talk to a real server,
# but this one mutated the settings object shared with anything else in-process.
(_cfg.settings.ocr_provider,
 _cfg.settings.ocr_azure_endpoint, _cfg.settings.ocr_azure_key) = _saved
_ocr.reset_provider_cache()

check("no module in the package can still fabricate a passenger",
      not (BACKEND / "app/services/passport_ocr/simulated_provider.py").exists(),
      "simulated_provider.py is still on disk")


def scan(token, content=PNG_A, name="passport.png", ctype="image/png", request_id=None):
    """Upload a passport and wait for a terminal status, however it answers."""
    data = {"request_id": request_id} if request_id is not None else None
    r = requests.post(
        EXTRACT, headers=H(token),
        files={"file": (name, content, ctype)}, data=data,
    )
    if r.status_code not in (200, 202):
        return r, None
    row = r.json()
    # The 202 path: poll exactly as the merchant portal does.
    deadline = time.time() + 60
    while row["status"] in ("queued", "processing") and time.time() < deadline:
        time.sleep(2)
        row = requests.get(f"{EXTRACT}/{row['id']}", headers=H(token)).json()
    return r, row


# ---------------------------------------------------------------------------
print("\n== availability ==")
# ---------------------------------------------------------------------------
r = requests.get(f"{BASE}/api/bookings/passport/availability", headers=H(mtok))
check("availability endpoint answers", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
avail = r.json()
for field in ("available", "max_upload_mb", "accepted_types", "confidence_bands",
              "passport_validity_months"):
    check(f"availability carries {field}", field in avail, avail)
check("the bands are served, not hard-coded per client",
      avail["confidence_bands"].get("high") == 0.95
      and avail["confidence_bands"].get("medium") == 0.80,
      avail.get("confidence_bands"))
# Scanning is a merchant act OR a Manual Booking act, so the probe is gated on
# `document.upload` (the merchant) or `ticket.manual` (the desk raising a
# booking for a named merchant). CHANGED: the Admin portal must be able to read
# `available` or it cannot decide whether to render a scan control at all, and
# a desk that is allowed to scan is a desk that is allowed to ask.
# The rest of the platform is unchanged and still refused outright: a Manager
# and a Super Admin hold NEITHER code, so they never reach a row.
_staff_probe = {
    role: requests.get(f"{BASE}/api/bookings/passport/availability", headers=H(tok)).status_code
    for role, tok in (("manager", login(*MANAGER)), ("super", login(*SUPER)))
}
check("platform roles WITHOUT ticket.manual cannot be offered a scan control",
      set(_staff_probe.values()) == {403}, _staff_probe)
check("the desk (ticket.manual) MAY ask whether scanning is available",
      requests.get(f"{BASE}/api/bookings/passport/availability",
                   headers=H(atok)).status_code == 200)

OCR_ON = bool(avail.get("available"))
print(f"     provider: {avail.get('provider')}   available: {OCR_ON}"
      f"{'   SIMULATED' if avail.get('simulated') else ''}")

# ---------------------------------------------------------------------------
print("\n== a booking never depends on scanning ==")
# ---------------------------------------------------------------------------
# The headline rule, asserted FIRST and asserted whether or not OCR is
# configured: an international booking with no scan of any kind submits.
b = flows.make_booking(mtok, atok, upto="pending_approval", international=True, pax=1,
                       label="ocr: no scan at all")
check("an international booking with NO scan submits", b["status"] != "draft", b["status"])

if not OCR_ON:
    print("\n" + "=" * 66)
    print("  OCR IS NOT CONFIGURED ON THE SERVER UNDER TEST.")
    print("  Asserting the unavailable contract only. To exercise extraction,")
    print("  start the backend with OCR_PROVIDER=local.")
    print("=" * 66)
    r, _ = scan(mtok)
    check("extract answers 503 when no provider is configured", r.status_code == 503,
          f"{r.status_code} {r.text[:200]}")
    check("...and says so in a way a merchant can act on",
          "hand" in r.json().get("detail", "").lower(), r.text[:200])
    sys.exit(check.report())

# ---------------------------------------------------------------------------
print("\n== extraction ==")
# ---------------------------------------------------------------------------
r, row = scan(mtok)
check("scan accepted", r.status_code in (200, 202), f"{r.status_code} {r.text[:300]}")
check("reaches a terminal status", row["status"] in ("succeeded", "failed"), row["status"])
check("succeeded", row["status"] == "succeeded", row.get("error_detail"))
check("NO request_id was needed", True)  # the call above sent none — CR-1's lesson
check("an id is returned for polling", isinstance(row.get("id"), int))
check("provider is named", bool(row.get("provider")), row.get("provider"))
check("processing time recorded", row.get("processing_ms") is not None)

fields = row["fields"]
check("passport_number was read", "passport_number" in fields, sorted(fields))
check("expiry was read", "passport_expiry" in fields, sorted(fields))
check("every field carries its own value", all("value" in f for f in fields.values()))
check("every field carries its own confidence", all("confidence" in f for f in fields.values()))
check("every field carries a server-computed band", all("band" in f for f in fields.values()))

bands = {f["band"] for f in fields.values()}
check("confidence is per field, not one document score",
      len({f["confidence"] for f in fields.values()}) > 1,
      sorted({f["confidence"] for f in fields.values()}))
check("the bands actually discriminate", len(bands) > 1, bands)
for name, f in sorted(fields.items()):
    expected = ("high" if f["confidence"] >= 0.95
                else "medium" if f["confidence"] >= 0.80 else "low")
    if f["band"] != expected:
        check(f"{name} banded correctly", False, f"{f['confidence']} -> {f['band']}")
check("every band matches the published thresholds",
      all(f["band"] == ("high" if f["confidence"] >= 0.95
                        else "medium" if f["confidence"] >= 0.80 else "low")
          for f in fields.values()))
check("overall confidence is reported", row.get("overall_confidence") is not None)
check("...and is the mean of the fields, not the minimum",
      abs(row["overall_confidence"]
          - sum(f["confidence"] for f in fields.values()) / len(fields)) < 0.001,
      row["overall_confidence"])

r2, row2 = scan(mtok)
check("the same file reads the same way (deterministic)",
      {k: v["value"] for k, v in row2["fields"].items()}
      == {k: v["value"] for k, v in fields.items()})

# ---------------------------------------------------------------------------
print("\n== the values came off THIS passport ==")
# ---------------------------------------------------------------------------
# THE ASSERTION THE OLD SUITE COULD NOT MAKE. Every check above would have
# passed against a provider that invented a traveller from the file's checksum:
# it returned eleven fields, with per-field confidences spread across the three
# bands and a check-digit-valid MRZ it had built itself. What it could not do is
# return the person who is actually drawn on the page.
_ON_THE_PAGE = {
    "last_name": "ERIKSSON",
    "first_name": "ANNA MARIA",
    "passport_number": "L898902C3",
    "nationality": "GBR",
    "gender": "female",
    "dob": "1974-08-12",
    "passport_expiry": "2031-04-15",
    "place_of_birth": "MANCHESTER",
    "passport_issue_date": "2021-04-15",
}
for _name, _want in _ON_THE_PAGE.items():
    check(f"{_name} is what the document says", fields.get(_name, {}).get("value") == _want,
          f"read {fields.get(_name, {}).get('value')!r}, page says {_want!r}")

check("the second passport reads as the OTHER traveller, not a second copy",
      (scan(mtok, content=PNG_B)[1]["fields"].get("last_name", {}).get("value")
       == "OKONKWO"))

# A PAGE WITH NO PASSPORT ON IT MUST PRODUCE NOTHING.
_r, _blank = scan(mtok, content=PNG_BLANK, name="blank.png")
check("a blank page FAILS rather than inventing a traveller",
      _blank["status"] == "failed", _blank.get("fields"))
check("...and returns no fields at all", not _blank.get("fields"), _blank.get("fields"))
# Asserted on the CODE, not on the sentence. The wording is merchant-facing
# copy and will be edited again; what must hold is that a blank page is
# diagnosed as an unreadable PICTURE rather than as the wrong document, because
# those two send someone to do opposite things — re-photograph this page, or go
# and find a different one. The sentence is checked only for the word that
# distinguishes it, so this fails if the two diagnoses are ever swapped.
check("...and says which failure this is, not just that one happened",
      _blank.get("error_code") == "ocr_not_legible",
      (_blank.get("error_code"), _blank.get("error_detail")))
check("...and tells the merchant what to do about it",
      "blurred" in (_blank.get("error_detail") or ""),
      _blank.get("error_detail"))
check("no extraction on this server was fabricated",
      row.get("provider") == "local" and row.get("simulated") is False,
      (row.get("provider"), row.get("simulated")))

# ---------------------------------------------------------------------------
print("\n== the twelve fields, and the machine-readable zone ==")
# ---------------------------------------------------------------------------
for name in ("first_name", "last_name", "gender", "dob", "place_of_birth",
             "nationality", "passport_number", "passport_type",
             "passport_issue_country", "passport_issue_date", "passport_expiry",
             "mrz"):
    check(f"{name} is read", name in fields, sorted(fields))

# THE POINT OF THE MRZ. Its check digits are arithmetic over the characters, so
# a block that verifies was read correctly — which is stronger evidence than any
# confidence the vendor attaches to its own reading of the printed page. The
# three blocks that carry a digit must therefore come back at 1.0, and the
# platform must have PREFERRED them.
mrz_text = fields["mrz"]["value"]
check("the MRZ is two 44-character lines",
      [len(x) for x in mrz_text.split("\n")] == [44, 44], mrz_text)
for name in ("passport_number", "dob", "passport_expiry"):
    check(f"{name} is check-digit verified, not merely confident",
          fields[name]["confidence"] == 1.0 and fields[name]["band"] == "high",
          fields[name])
# ...and the MRZ agrees with the fields beside it. A zone that parsed but
# contradicted them would be worse than none: the merchant would be checking a
# doubtful field against lines that say something else again.
sys.path.insert(0, str(BACKEND / "app" / "services"))
from app.services.passport_ocr.base import parse_mrz  # noqa: E402

parsed = parse_mrz(mrz_text)
check("the MRZ parses on our side too", parsed is not None)
check("every check digit in it verifies", parsed.all_verified, parsed.verified)
# `nationality` is excluded, and not as a fudge: the two sources speak different
# vocabularies for it. The MRZ carries the ISO-3166 alpha-3 code (`JPN`) because
# that is all three characters can hold; the printed page carries the demonym
# ("Japanese"). Neither is wrong and neither can be derived from the other
# without a lookup table this platform does not have, so `merge_mrz` leaves a
# printed nationality alone — it only ever FILLS one the page did not give.
# Every other field is a straight comparison and must agree exactly.
_compared = {k: v for k, v in parsed.fields.items()
             if k in fields and k != "nationality"}
check("the MRZ agrees with the fields beside it",
      all(fields[k]["value"] == v for k, v in _compared.items()),
      {k: (v, fields[k]["value"]) for k, v in _compared.items()
       if fields[k]["value"] != v})
# This fixture's printed side carries no nationality line, so the only reading
# of it is the zone's alpha-3 code and the two must agree exactly. The rule the
# paragraph above describes — a printed demonym is never overwritten by the code
# — is a property of ``merge_mrz`` and is asserted against it directly, because
# arranging for a real reader to produce both vocabularies at once would be
# asserting the fixture rather than the merge.
check("nationality is the zone's alpha-3 code when the page gives none",
      fields["nationality"]["value"] == parsed.fields.get("nationality")
      and len(fields["nationality"]["value"]) == 3,
      (fields["nationality"]["value"], parsed.fields.get("nationality")))

from app.services.passport_ocr.base import ExtractedField, merge_mrz  # noqa: E402
_demonym = merge_mrz({"nationality": ExtractedField("Japanese", 0.9)}, parsed)
check("...and a printed demonym is never replaced by the code beneath it",
      _demonym["nationality"].value == "Japanese", _demonym["nationality"])

# ---------------------------------------------------------------------------
print("\n== two travellers cannot share one passport ==")
# ---------------------------------------------------------------------------
# Physically impossible, and it reaches the airline as two tickets against one
# document — caught at check-in, after the money has moved. Unstated until CR-8
# because typing the same number twice is a rare slip; scanning made it easy,
# because one file dropped on three cards fills all three identically.
_dup = flows.make_booking(mtok, atok, upto="draft", international=True, pax=2,
                          label="ocr: two travellers, one passport")
_exp = str(datetime.date.today() + datetime.timedelta(days=900))
requests.put(f"{BASE}/api/requests/{_dup['id']}/passengers", headers=H(mtok), json={
    "passengers": [
        {"id": _dup["passenger_ids"][0], "first_name": "ROHIT", "last_name": "SHARMA",
         "passenger_type": "adult", "passport_number": "Z1234567", "passport_expiry": _exp},
        # Same document, differently punctuated. Normalisation is the whole test:
        # comparing raw strings would let this through.
        {"id": _dup["passenger_ids"][1], "first_name": "MEERA", "last_name": "SHARMA",
         "passenger_type": "adult", "passport_number": "z123 4567", "passport_expiry": _exp},
    ],
})
_r = requests.post(f"{BASE}/api/requests/{_dup['id']}/submit", headers=H(mtok))
check("a booking with one passport on two travellers is refused",
      _r.status_code == 400, f"{_r.status_code} {_r.text[:160]}")
check("...and the refusal names both travellers and the document",
      all(x in _r.text for x in ("ROHIT", "MEERA", "Z1234567")), _r.text[:200])

# The same booking submits once they are genuinely different people.
requests.put(f"{BASE}/api/requests/{_dup['id']}/passengers", headers=H(mtok), json={
    "passengers": [
        {"id": _dup["passenger_ids"][0], "first_name": "ROHIT", "last_name": "SHARMA",
         "passenger_type": "adult", "passport_number": "Z1234567", "passport_expiry": _exp},
        {"id": _dup["passenger_ids"][1], "first_name": "MEERA", "last_name": "SHARMA",
         "passenger_type": "adult", "passport_number": "Z7654321", "passport_expiry": _exp},
    ],
})
check("...and submits once each has their own",
      requests.post(f"{BASE}/api/requests/{_dup['id']}/submit",
                    headers=H(mtok)).status_code == 200)

# ---------------------------------------------------------------------------
print("\n== what may be uploaded ==")
# ---------------------------------------------------------------------------
r, _ = scan(mtok, content=b"just some text", name="notes.txt", ctype="text/plain")
check("text/plain refused -> 415", r.status_code == 415, r.status_code)
r, _ = scan(mtok, content=b"<html>hi</html>", name="page.png", ctype="image/png")
check("HTML renamed .png refused -> 400", r.status_code == 400, r.status_code)
r, _ = scan(mtok, content=b"", name="empty.png", ctype="image/png")
check("an empty file refused -> 400", r.status_code == 400, r.status_code)
r, _ = scan(mtok, content=PDF, name="passport.pdf", ctype="application/pdf")
check("a PDF passport is accepted", r.status_code in (200, 202), r.status_code)

# ---------------------------------------------------------------------------
print("\n== the scan is never public ==")
# ---------------------------------------------------------------------------
_, keep = scan(mtok, content=PNG_A)
r = requests.get(f"{EXTRACT}/{keep['id']}/scan", headers=H(mtok))
check("the merchant can read its own scan", r.status_code == 200, r.status_code)
check("the bytes round-trip", r.content == PNG_A, f"{len(r.content)} bytes")
# ``minihttp`` lower-cases every header name on the way in, so these must be
# looked up in lower case. Asking for "Content-Disposition" returns None however
# correct the server is, which reads as a missing security header and is not one.
check("served inline, not as a public link",
      "inline" in r.headers.get("content-disposition", ""),
      r.headers.get("content-disposition"))
check("not cached anywhere shared",
      "no-store" in r.headers.get("cache-control", ""), r.headers.get("cache-control"))
check("no sniffing",
      r.headers.get("x-content-type-options") == "nosniff",
      r.headers.get("x-content-type-options"))
check("no token -> refused",
      requests.get(f"{EXTRACT}/{keep['id']}/scan").status_code in (401, 403))

# ---------------------------------------------------------------------------
print("\n== scope ==")
# ---------------------------------------------------------------------------
rival = flows.rival_merchant(atok)
print(f"     rival: {rival['company']} (merchant {rival['merchant_id']})")
check("another company's scan -> 404, not 403",
      requests.get(f"{EXTRACT}/{keep['id']}", headers=H(rival["token"])).status_code == 404)
check("...and cannot download its bytes",
      requests.get(f"{EXTRACT}/{keep['id']}/scan", headers=H(rival["token"])).status_code == 404)
# 404 for both, and for the same reason: the row's existence must stay hidden
# from anyone not entitled to it. The rival merchant IS entitled to the endpoint
# and merely names a row that is not its own. The desk now also passes the
# permission gate — it holds `ticket.manual` so that Manual Booking can scan —
# and is turned away one step later by `_scoped`, which shows staff an
# extraction only once it is ATTACHED to a booking or if they raised it
# themselves. This one is a merchant's own unattached draft, so it is neither.
# WAS 403 before Manual Booking could scan, when the desk was stopped at the
# gate. The refusal is unchanged; only which layer says no has moved, and 404
# hides more than the 403 did. The desk still reads merchant scans through the
# Admin route below, which is keyed by booking.
check("staff cannot read a merchant's UNATTACHED scan",
      requests.get(f"{EXTRACT}/{keep['id']}", headers=H(atok)).status_code == 404)
check("another company cannot write to it",
      requests.post(f"{EXTRACT}/{keep['id']}/edits", headers=H(rival["token"]),
                    json={"values": {"first_name": "X"}}).status_code in (403, 404))

# ---------------------------------------------------------------------------
print("\n== the extraction attaches to a booking, and the desk can then see it ==")
# ---------------------------------------------------------------------------
booking = flows.make_booking(mtok, atok, upto="draft", international=True, pax=1,
                             label="ocr: attached scan")
_, attached = scan(mtok, content=PNG_B, request_id=booking["id"])
check("a scan may be labelled with a booking", attached["status"] == "succeeded")

pax_id = booking["passenger_ids"][0]
scanned = {k: v["value"] for k, v in attached["fields"].items()}
r = requests.post(f"{EXTRACT}/{attached['id']}/edits", headers=H(mtok), json={
    "values": scanned, "request_id": booking["id"], "passenger_id": pax_id,
})
check("recording an unedited save -> 200", r.status_code == 200, r.text[:200])

r = requests.get(f"{BASE}/api/admin/requests/{booking['id']}/passport-ocr", headers=H(atok))
check("staff CAN read a scan attached to a booking", r.status_code == 200, r.status_code)
admin_rows = r.json()
check("the attached scan is listed", any(x["id"] == attached["id"] for x in admin_rows),
      [x["id"] for x in admin_rows])
# The converse, and the one that carries the privacy rule: `keep` was scanned
# and never labelled with a booking, so no desk view can reach it. An abandoned
# draft's passport is not the platform's to read.
check("...and the UNATTACHED scan is not",
      all(x["id"] != keep["id"] for x in admin_rows), [x["id"] for x in admin_rows])
# REGRESSION — the Admin panel lists a scan and offers "View passport", and the
# download endpoint was gated on `document.upload` alone, which no platform role
# holds. The desk could see that a passport existed and never open it. Listing a
# thing the reader cannot open is worse than not listing it, so both halves are
# asserted together: the desk opens an ATTACHED scan, and is still refused an
# unattached one.
r = requests.get(f"{EXTRACT}/{attached['id']}/scan", headers=H(atok))
check("the desk can OPEN an attached scan, not merely see it listed",
      r.status_code == 200 and r.content == PNG_B,
      f"{r.status_code} {len(r.content)} bytes")
check("...and is still refused an UNATTACHED one",
      requests.get(f"{EXTRACT}/{keep['id']}/scan", headers=H(atok)).status_code == 404)

arow = next(x for x in admin_rows if x["id"] == attached["id"])
check("the desk sees the provider's raw answer", arow.get("raw_response") is not None)
check("the desk sees who uploaded it", bool(arow.get("uploaded_by_name")))
check("no edits recorded when nothing was changed", arow["edits"] == [], arow["edits"])
check("raw_response is NOT in the merchant's own response",
      "raw_response" not in requests.get(f"{EXTRACT}/{attached['id']}",
                                         headers=H(mtok)).json())
check("a merchant cannot read the admin view",
      requests.get(f"{BASE}/api/admin/requests/{booking['id']}/passport-ocr",
                   headers=H(mtok)).status_code in (403, 404))

# ---------------------------------------------------------------------------
print("\n== the manual-edit audit ==")
# ---------------------------------------------------------------------------
edited = dict(scanned)
edited["first_name"] = scanned["first_name"] + "N"
edited["nationality"] = "Martian"
r = requests.post(f"{EXTRACT}/{attached['id']}/edits", headers=H(mtok), json={
    "values": edited, "request_id": booking["id"], "passenger_id": pax_id,
})
check("recording edits -> 200", r.status_code == 200, r.text[:200])
arow = next(x for x in requests.get(
    f"{BASE}/api/admin/requests/{booking['id']}/passport-ocr", headers=H(atok)
).json() if x["id"] == attached["id"])
edits = {e["field_name"]: e for e in arow["edits"]}
check("exactly the two changed fields are recorded", set(edits) == {"first_name", "nationality"},
      sorted(edits))
check("the ORIGINAL OCR value is kept",
      edits["first_name"]["ocr_value"] == scanned["first_name"], edits["first_name"])
check("the edited value is kept",
      edits["first_name"]["edited_value"] == edited["first_name"], edits["first_name"])
check("the confidence at the time is kept",
      edits["first_name"]["ocr_confidence"] is not None)
check("who edited it is recorded", bool(edits["first_name"]["edited_by_name"]))
check("when is recorded", bool(edits["first_name"]["edited_at"]))

requests.post(f"{EXTRACT}/{attached['id']}/edits", headers=H(mtok), json={
    "values": edited, "request_id": booking["id"], "passenger_id": pax_id,
})
arow = next(x for x in requests.get(
    f"{BASE}/api/admin/requests/{booking['id']}/passport-ocr", headers=H(atok)
).json() if x["id"] == attached["id"])
check("re-saving replaces rather than appends", len(arow["edits"]) == 2, len(arow["edits"]))

r = requests.post(f"{EXTRACT}/{attached['id']}/edits", headers=H(mtok),
                  json={"values": {"first_name": scanned["first_name"]}})
arow = next(x for x in requests.get(
    f"{BASE}/api/admin/requests/{booking['id']}/passport-ocr", headers=H(atok)
).json() if x["id"] == attached["id"])
check("a field sent back unchanged records nothing",
      "first_name" not in {e["field_name"] for e in arow["edits"]},
      [e["field_name"] for e in arow["edits"]])

# ---------------------------------------------------------------------------
print("\n== duplicate traveller ==")
# ---------------------------------------------------------------------------
# Save the scanned passport onto a real passenger, then scan the SAME file
# again: the second read must recognise it.
requests.put(f"{BASE}/api/requests/{booking['id']}/passengers", headers=H(mtok), json={
    "passengers": [{
        "id": pax_id,
        "first_name": scanned["first_name"], "last_name": scanned["last_name"],
        "passenger_type": "adult",
        "passport_number": scanned["passport_number"],
        "passport_expiry": scanned["passport_expiry"],
        "nationality": scanned["nationality"],
    }],
})
_, again = scan(mtok, content=PNG_B)
dup = again.get("duplicate") or {}
check("a passport this merchant has sent before is recognised", dup.get("found") is True, dup)
check("the match names the traveller", bool(dup.get("full_name")), dup)
check("the match offers fields to fill", bool(dup.get("fields")), dup)
check("the match carries NO passenger id — nothing to link to", "id" not in dup, dup)
check("...and no passport_number, which is the key we already have",
      "passport_number" not in dup.get("fields", {}), dup.get("fields"))

# A REAL PASSPORT CARRYING A NUMBER NOBODY HAS SENT. It used to be enough to
# upload random bytes, because the provider derived a passport number from the
# file's checksum and never looked at the image; a reader that actually reads
# gets nothing from noise and fails, which would assert nothing here. So the
# fixture is a genuine page whose number is randomised per run — otherwise the
# first time anything saves this traveller (an earlier run, or a human clicking
# through the portal against the same database) a correct duplicate match starts
# being reported as a false one.
import random  # noqa: E402

_unseen = dict(PAX_A, number=f"X{random.randint(0, 9_999_999):07d}")
_, fresh = scan(mtok, content=passport_png(**_unseen))
check("an unknown passport is not a false match",
      (fresh.get("duplicate") or {}).get("found") is False, fresh.get("duplicate"))
check("another company does not see our traveller",
      (scan(rival["token"], content=PNG_B)[1].get("duplicate") or {}).get("found") is False)

# ---------------------------------------------------------------------------
print("\n== passport validity ==")
# ---------------------------------------------------------------------------
v = again.get("validity") or {}
check("validity is assessed", v.get("checked") is True, v)
check("a ten-year passport is valid", v.get("valid") is True, v)

# The six-month rule, and the fact that it DOES block a submission (2026-08-07).
soon = flows.make_booking(mtok, atok, upto="draft", international=True, pax=1,
                          label="ocr: expiry inside six months")
travel = datetime.date.today() + datetime.timedelta(days=60)
near = (travel + datetime.timedelta(days=60)).isoformat()   # ~2 months after travel
requests.put(f"{BASE}/api/requests/{soon['id']}/passengers", headers=H(mtok), json={
    "passengers": [{
        "id": soon["passenger_ids"][0],
        "first_name": "Near", "last_name": "Expiry", "passenger_type": "adult",
        "passport_number": "N9998887", "passport_expiry": near,
    }],
})
_, sv = scan(mtok, content=PNG_A, request_id=soon["id"])
r = requests.post(f"{EXTRACT}/{sv['id']}/edits", headers=H(mtok), json={
    "values": {"passport_expiry": near},
    "request_id": soon["id"], "passenger_id": soon["passenger_ids"][0],
})
arow = next(x for x in requests.get(
    f"{BASE}/api/admin/requests/{soon['id']}/passport-ocr", headers=H(atok)
).json() if x["id"] == sv["id"])

# NOT asserted on `sv`'s own assessment. `_respond` measures the PROVIDER's
# reading (`row.normalized`), and `record_edits` deliberately does not rewrite
# it — an edit is recorded beside the reading, never over it — so the scan row
# still reports the long expiry the provider actually returned. What changed is
# what the submit path does with the PASSENGER's expiry, which is set above and
# is what the check below exercises.
r = requests.post(f"{BASE}/api/requests/{soon['id']}/submit", headers=H(mtok))
check("A PASSPORT EXPIRING INSIDE SIX MONTHS IS REFUSED (was advisory until 2026-08-07)",
      r.status_code == 400 and "6 months" in r.text, f"{r.status_code} {r.text[:250]}")

# ...and an expiry before the travel date is refused too — the pre-existing
# rule, now the strict end of the same one.
past = flows.make_booking(mtok, atok, upto="draft", international=True, pax=1,
                          label="ocr: expiry before travel")
requests.put(f"{BASE}/api/requests/{past['id']}/passengers", headers=H(mtok), json={
    "passengers": [{
        "id": past["passenger_ids"][0],
        "first_name": "Past", "last_name": "Expiry", "passenger_type": "adult",
        "passport_number": "P1112223",
        "passport_expiry": (travel - datetime.timedelta(days=1)).isoformat(),
    }],
})
r = requests.post(f"{BASE}/api/requests/{past['id']}/submit", headers=H(mtok))
check("an expiry ON OR BEFORE travel is still refused (pre-existing rule intact)",
      r.status_code == 400, f"{r.status_code} {r.text[:200]}")

# ---------------------------------------------------------------------------
print("\n== a failed scan blocks nothing ==")
# ---------------------------------------------------------------------------
free = flows.make_booking(mtok, atok, upto="draft", international=True, pax=1,
                          label="ocr: failed scan")
r, _ = scan(mtok, content=b"<html>not a passport</html>", name="x.png", ctype="image/png")
check("a rejected upload is an error, not a booking state", r.status_code == 400)
requests.put(f"{BASE}/api/requests/{free['id']}/passengers", headers=H(mtok), json={
    "passengers": [{
        "id": free["passenger_ids"][0],
        "first_name": "Typed", "last_name": "Byhand", "passenger_type": "adult",
        "passport_number": "H7776665",
        "passport_expiry": (travel + datetime.timedelta(days=900)).isoformat(),
    }],
})
r = requests.post(f"{BASE}/api/requests/{free['id']}/submit", headers=H(mtok))
check("a booking whose scan failed still submits, typed by hand",
      r.status_code in (200, 201), f"{r.status_code} {r.text[:200]}")

# ---------------------------------------------------------------------------
print("\n== not found ==")
# ---------------------------------------------------------------------------
check("an unknown extraction -> 404",
      requests.get(f"{EXTRACT}/999999999", headers=H(mtok)).status_code == 404)
check("an unknown extraction's scan -> 404",
      requests.get(f"{EXTRACT}/999999999/scan", headers=H(mtok)).status_code == 404)
check("labelling with another company's booking -> 404",
      requests.post(EXTRACT, headers=H(rival["token"]),
                    files={"file": ("p.png", PNG_A, "image/png")},
                    data={"request_id": booking["id"]}).status_code == 404)

# ---------------------------------------------------------------------------
print("\n== Admin Manual Booking: the desk scanning FOR a merchant ==")
# ---------------------------------------------------------------------------
# The desk raises a booking on a named merchant's behalf, so it scans on that
# merchant's behalf too. THE OWNER IS NEVER INVENTED: an admin has no
# merchant_id of its own, so the merchant must be named, and naming one requires
# `ticket.manual` -- the same pairing enquiry_service._resolve_owner already
# enforces for the enquiry this scan belongs to. Neither half works alone.
mine = requests.get(f"{BASE}/api/profile", headers=H(mtok)).json().get("merchant_id")
check("the demo merchant has a merchant_id to scan against", mine is not None)


def admin_scan(token, merchant_id=None, content=PNG_A):
    """Upload as staff, naming the merchant the booking is being raised for."""
    data = {} if merchant_id is None else {"on_behalf_of_merchant_id": merchant_id}
    return requests.post(
        EXTRACT, headers=H(token),
        files={"file": ("passport.png", content, "image/png")}, data=data or None,
    )


# --- the permission half -----------------------------------------------------
r = admin_scan(atok, mine)
check("admin holding ticket.manual may scan for a named merchant",
      r.status_code in (200, 202), f"{r.status_code} {r.text[:200]}")
admin_row = r.json() if r.status_code in (200, 202) else None

check("admin naming NO merchant -> 403 (a scan cannot be filed against nobody)",
      admin_scan(atok).status_code == 403)
check("admin naming a merchant that does not exist -> 404",
      admin_scan(atok, 999999999).status_code == 404)
check("manager (platform staff, no ticket.manual) -> 403",
      admin_scan(login(*MANAGER), mine).status_code == 403)
check("super admin (no ticket.manual) -> 403",
      admin_scan(login(*SUPER), mine).status_code == 403)
check("a merchant may not scan 'for' another merchant -> 403",
      admin_scan(mtok, rival["merchant_id"]).status_code == 403)

# --- ownership and isolation -------------------------------------------------
# The row belongs to the merchant it was raised FOR, exactly as the booking
# does. That is the whole ownership model: `source` records that the desk typed
# it, never `merchant_id`.
if admin_row:
    check("the desk may read back the scan it just raised, still UNATTACHED",
          requests.get(f"{EXTRACT}/{admin_row['id']}",
                       headers=H(atok)).status_code == 200)
    check("the merchant it was raised FOR can read it -- it is their row",
          requests.get(f"{EXTRACT}/{admin_row['id']}",
                       headers=H(mtok)).status_code == 200)
    check("ANOTHER merchant cannot read an admin-raised scan -> 404",
          requests.get(f"{EXTRACT}/{admin_row['id']}",
                       headers=H(rival["token"])).status_code == 404)
    check("another merchant cannot fetch its image either -> 404",
          requests.get(f"{EXTRACT}/{admin_row['id']}/scan",
                       headers=H(rival["token"])).status_code == 404)
    # Other platform staff must not reach the desk's unattached draft. A
    # Manager holds neither `document.upload` nor `ticket.manual`, so it is
    # refused at the permission gate (403) and never reaches `_scoped` at all.
    # The scope widening is keyed on `created_by` rather than on staff-ness, so
    # a second holder of ticket.manual would be refused there too, as a 404.
    check("platform staff who did NOT raise an unattached scan are refused",
          requests.get(f"{EXTRACT}/{admin_row['id']}",
                       headers=H(login(*MANAGER))).status_code in (403, 404))

    # --- the edit audit, on the desk's own row -------------------------------
    r = requests.post(f"{EXTRACT}/{admin_row['id']}/edits", headers=H(atok),
                      json={"values": {"first_name": "CORRECTED"}})
    check("the desk may record its own corrections over a scan it raised",
          r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("a rival merchant cannot write to the desk's extraction",
          requests.post(f"{EXTRACT}/{admin_row['id']}/edits",
                        headers=H(rival["token"]),
                        json={"values": {"first_name": "X"}}).status_code
          in (403, 404))

    # ONE DESK IS NOT THE WHOLE DESK. ADMIN2 holds `ticket.manual` exactly as
    # ADMIN does, so it passes the permission gate and is stopped one layer
    # later by `_scoped` — which shows staff an extraction only once it is
    # ATTACHED to a booking, or if they raised it themselves. This row is
    # neither, so the second admin gets 404 and never learns it exists.
    # Asserted with a SECOND HOLDER OF THE SAME PERMISSION on purpose: a
    # Manager would be refused at the gate and would prove nothing about scope.
    a2 = login(*ADMIN2)
    check("a second admin holding ticket.manual cannot read an unattached scan "
          "it did not raise -> 404",
          requests.get(f"{EXTRACT}/{admin_row['id']}", headers=H(a2)).status_code == 404)
    check("...and cannot fetch its image either -> 404",
          requests.get(f"{EXTRACT}/{admin_row['id']}/scan",
                       headers=H(a2)).status_code == 404)
    check("...nor write to it",
          requests.post(f"{EXTRACT}/{admin_row['id']}/edits", headers=H(a2),
                        json={"values": {"first_name": "X"}}).status_code in (403, 404))
    # The gate is genuinely open to ADMIN2 — so the 404s above are the SCOPE
    # rule doing the work, not a permission refusal wearing its clothes.
    check("...while ADMIN2 may still raise a scan of its own (gate is open to it)",
          requests.post(EXTRACT, headers=H(a2),
                        files={"file": ("p.png", PNG_A, "image/png")},
                        data={"on_behalf_of_merchant_id": mine}).status_code in (200, 202))

check("availability answers for the desk as well as for the merchant",
      requests.get(f"{BASE}/api/bookings/passport/availability",
                   headers=H(atok)).status_code == 200)

# NOT COVERED HERE, deliberately: "Fill down after OCR" and "OCR then a
# successful manual booking" are browser behaviours of classic-booking.js rather
# than HTTP contracts. This suite would assert nothing real about either; they
# belong to the browser pass.

# ---------------------------------------------------------------------------
print("\n== Admin Manual Booking: the scan reaches the booking it filled ==")
# ---------------------------------------------------------------------------
# A scan that fills the desk's form and is then never told which booking it
# became is an orphan: `request_id` and `passenger_id` stay NULL, the desk's own
# "Passport scans" panel on the booking finds nothing, and the record of what
# the operator overrode is never written. The Merchant Portal has always made
# this call after its own save; Admin Manual Booking is a separate save path and
# did not, so every desk-raised scan was orphaned. THIS IS THAT LINK.
_travel = (datetime.date.today() + datetime.timedelta(days=120)).isoformat()
_expiry = (datetime.date.today() + datetime.timedelta(days=900)).isoformat()


def desk_enquiry():
    """The desk files an enquiry FOR the merchant, as Manual Enquiry does."""
    r = requests.post(f"{BASE}/api/enquiries", headers=H(atok), json={
        "trip_type": "one_way",
        "origin": "HYD", "origin_city": "Hyderabad",
        "destination": "CMB", "destination_city": "Colombo",
        "airline": "Air India", "flight_number": "AI283",
        "travel_date": _travel, "preferred_time": "09:30",
        "travel_class": "Economy",
        "passenger_count": 1, "adults": 1, "children": 0, "infants": 0,
        "notes": "Raised by the desk for the passport-linkage check.",
        "on_behalf_of_merchant_id": mine,
    })
    assert r.status_code == 201, f"desk enquiry: {r.status_code} {r.text[:200]}"
    return r.json()


def desk_booking(enquiry_id, passengers):
    return requests.post(
        f"{BASE}/api/enquiries/{enquiry_id}/booking-request", headers=H(atok),
        json={"passengers": passengers,
              "remarks": "Entered by the desk.",
              "contact": {"name": "Desk", "email": "desk@example.com",
                          "phone": "919000000001"},
              "international": True},
    )


r = admin_scan(atok, mine)
check("the desk raises a scan before the booking exists",
      r.status_code in (200, 202), f"{r.status_code} {r.text[:200]}")
desk_row = r.json()
check("...and it starts UNATTACHED, as the merchant's does",
      desk_row.get("request_id") is None)

scan_read = {k: (v or {}).get("value") for k, v in (desk_row.get("fields") or {}).items()}

_enq = desk_enquiry()
_bk = desk_booking(_enq["id"], [{
    "title": "Ms", "first_name": scan_read.get("first_name") or "Asha",
    "last_name": scan_read.get("last_name") or "Menon",
    "gender": "female", "dob": "1989-03-11", "passenger_type": "adult",
    "nationality": "Indian",
    "passport_number": scan_read.get("passport_number") or "MB0099771",
    "passport_expiry": _expiry,
}])
check("the desk's booking saves", _bk.status_code == 201, f"{_bk.status_code} {_bk.text[:200]}")
desk_bk = _bk.json()
desk_pax = (desk_bk.get("passengers") or [])
check("the save returns the traveller with an id -- what the link is keyed on",
      len(desk_pax) == 1 and desk_pax[0].get("id") is not None, desk_pax[:1])
desk_pax_id = desk_pax[0]["id"] if desk_pax else None

# THE LINK ITSELF -- the call the Admin save now makes once the save succeeds.
linked_values = dict(scan_read)
linked_values["last_name"] = (scan_read.get("last_name") or "MENON") + "-CORRECTED"
r = requests.post(f"{EXTRACT}/{desk_row['id']}/edits", headers=H(atok), json={
    "values": linked_values, "request_id": desk_bk["id"], "passenger_id": desk_pax_id,
})
check("the desk may link its scan to the booking it just saved -> 200",
      r.status_code == 200, f"{r.status_code} {r.text[:250]}")

# WHERE THE LINK IS READ BACK. `GET /extract/{id}` answers ExtractionResponse,
# which carries neither id -- they are the desk's business, not the scanner's.
# The admin route is where they surface, and it is the right place to assert
# from because it is also the only consumer: `for_request` selects on
# `PassportOcrExtraction.request_id == request_id`, so a scan appearing there
# AT ALL is the request link, and the row's own `passenger_id` is the other.
check("the scan is still readable by the desk that raised it",
      requests.get(f"{EXTRACT}/{desk_row['id']}", headers=H(atok)).status_code == 200)

panel = requests.get(f"{BASE}/api/admin/requests/{desk_bk['id']}/passport-ocr",
                     headers=H(atok))
check("the Admin Passport scans panel answers for a desk-raised booking",
      panel.status_code == 200, panel.status_code)
prows = panel.json() if panel.status_code == 200 else []
_mine_rows = [x for x in prows if x["id"] == desk_row["id"]]
check("...and the desk's scan is IN it -- it never was before this",
      len(_mine_rows) == 1, [x["id"] for x in prows])

if _mine_rows:
    prow = _mine_rows[0]
    pedits = {e["field_name"]: e for e in prow["edits"]}
    check("the override the operator typed is audited",
          "last_name" in pedits, sorted(pedits))
    if "last_name" in pedits:
        check("...against the value the SCAN read",
              pedits["last_name"]["ocr_value"] == scan_read.get("last_name"),
              pedits["last_name"])
        check("...and names the member of staff who typed it",
              bool(pedits["last_name"]["edited_by_name"]))
    check("fields and provider survive the link",
          bool(prow.get("fields")) and bool(prow.get("provider")))
    # The two halves of the link, read where they are actually exposed.
    check("the scan now carries the REQUEST it filled",
          prow["id"] == desk_row["id"])   # only a request-scoped query returned it
    check("the scan now carries the TRAVELLER it became",
          prow.get("passenger_id") == desk_pax_id, prow.get("passenger_id"))

# Saving twice must not produce two links or two audit rows.
requests.post(f"{EXTRACT}/{desk_row['id']}/edits", headers=H(atok), json={
    "values": linked_values, "request_id": desk_bk["id"], "passenger_id": desk_pax_id,
})
again = requests.get(f"{BASE}/api/admin/requests/{desk_bk['id']}/passport-ocr",
                     headers=H(atok)).json()
_again_rows = [x for x in again if x["id"] == desk_row["id"]]
check("re-saving does not attach a SECOND scan to the booking", len(_again_rows) == 1)
if _again_rows:
    check("re-saving replaces the audit rather than appending",
          len(_again_rows[0]["edits"]) == 1, len(_again_rows[0]["edits"]))

# THE RULE THE WHOLE FEATURE IS BUILT AROUND, on the desk's path too. The link
# is written after the save and outside its error handling, so a refused link
# cannot unmake a booking. Asserted by refusing one.
bad = requests.post(f"{EXTRACT}/{desk_row['id']}/edits", headers=H(atok), json={
    "values": linked_values, "request_id": desk_bk["id"], "passenger_id": 999999999,
})
check("a link naming a traveller that is not on this booking is refused",
      bad.status_code in (400, 404), bad.status_code)
check("...and the booking it belongs to is still there, still saved",
      requests.get(f"{BASE}/api/requests/{desk_bk['id']}",
                   headers=H(atok)).status_code == 200)

# A desk booking with no scan at all behaves exactly as it always did.
_enq2 = desk_enquiry()
_bk2 = desk_booking(_enq2["id"], [{
    "title": "Mr", "first_name": "Typed", "last_name": "Byhand",
    "gender": "male", "dob": "1990-01-01", "passenger_type": "adult",
    "nationality": "Indian", "passport_number": "NOSCAN0001",
    "passport_expiry": _expiry,
}])
check("a desk booking typed with no scan at all still saves",
      _bk2.status_code == 201, f"{_bk2.status_code} {_bk2.text[:200]}")
check("...and its Passport scans panel is simply empty, not broken",
      requests.get(f"{BASE}/api/admin/requests/{_bk2.json()['id']}/passport-ocr",
                   headers=H(atok)).json() == [])

# Merchant isolation is unchanged by the link existing.
check("a rival merchant still cannot read the desk's now-ATTACHED scan",
      requests.get(f"{EXTRACT}/{desk_row['id']}",
                   headers=H(rival["token"])).status_code == 404)
check("...nor fetch its image",
      requests.get(f"{EXTRACT}/{desk_row['id']}/scan",
                   headers=H(rival["token"])).status_code == 404)

# ---------------------------------------------------------------------------
print("\n== the audit records overrides, not this module's own normalisation ==")
# ---------------------------------------------------------------------------
# `normalized` holds the provider's own answer, which for the two country boxes
# is a zone code -- `GBR`, `IND`, `JPN`. The form holds what countryFromIso3
# made of it -- `British`, `Indian`, `Japanese`. Those differ, so a country box
# nobody touched used to produce `nationality: GBR -> British` against a named
# operator who had done nothing. CR-8 defines passport_ocr_field_edits as one
# row per field the merchant OVERRODE; a conversion this module performed is
# not an override.
#
# THE SERVER CONTRACT THAT MAKES THE FIX POSSIBLE, asserted here because the
# fix depends on it: a field the payload omits is skipped entirely, and a field
# it carries is judged against the provider's value exactly as before. The
# browser decides which is which from `clOcrFilled`; these assert the two
# halves of the contract it relies on.
_n = admin_scan(atok, mine, content=PNG_A)
check("a scan to audit against", _n.status_code in (200, 202), _n.status_code)
_nrow = _n.json()
_nread = {k: (v or {}).get("value") for k, v in (_nrow.get("fields") or {}).items()}
check("the provider really did answer the country boxes as zone codes",
      (_nread.get("nationality") or "").isupper()
      and len(_nread.get("nationality") or "") <= 3, _nread.get("nationality"))

_ne = desk_enquiry()
_nb = desk_booking(_ne["id"], [{
    "title": "Ms", "first_name": _nread.get("first_name") or "Anna",
    "last_name": _nread.get("last_name") or "Eriksson",
    "gender": "female", "dob": "1974-08-12", "passenger_type": "adult",
    "nationality": "British",
    "passport_number": _nread.get("passport_number") or "L898902C3",
    "passport_expiry": _expiry,
}])
check("its booking saves", _nb.status_code == 201, f"{_nb.status_code} {_nb.text[:200]}")
_nbk = _nb.json()
_npax = (_nbk.get("passengers") or [{}])[0].get("id")


def _audit_for(extraction_id, request_id):
    rows = requests.get(f"{BASE}/api/admin/requests/{request_id}/passport-ocr",
                        headers=H(atok)).json()
    hit = [x for x in rows if x["id"] == extraction_id]
    return {e["field_name"]: e for e in (hit[0]["edits"] if hit else [])}


# --- UNTOUCHED: the browser omits the box, so nothing is recorded for it.
# Every other scanned field is omitted the same way; the countries are simply
# the only ones this module rewrites.
r = requests.post(f"{EXTRACT}/{_nrow['id']}/edits", headers=H(atok), json={
    "values": {}, "request_id": _nbk["id"], "passenger_id": _npax,
})
check("an omitted-everything save is accepted", r.status_code == 200, r.text[:200])
_a = _audit_for(_nrow["id"], _nbk["id"])
check("NO nationality row for a box the operator never touched",
      "nationality" not in _a, sorted(_a))
check("NO issuing-country row either", "passport_issue_country" not in _a, sorted(_a))
check("...and nothing else was invented", _a == {}, sorted(_a))

# --- AND THE LINK SURVIVES AN EMPTY PAYLOAD. This is what keeps the previous
# commit working: request_id and passenger_id are set before the edit loop, so
# a save where the operator changed nothing still attaches the scan.
_rows = requests.get(f"{BASE}/api/admin/requests/{_nbk['id']}/passport-ocr",
                     headers=H(atok)).json()
check("the scan is still LINKED to the booking after an empty audit payload",
      any(x["id"] == _nrow["id"] for x in _rows), [x["id"] for x in _rows])
check("...and to the right traveller",
      next((x for x in _rows if x["id"] == _nrow["id"]), {}).get("passenger_id") == _npax)

# --- TOUCHED: the browser sends the box, and a real override IS recorded,
# against the provider's own value rather than the converted one.
r = requests.post(f"{EXTRACT}/{_nrow['id']}/edits", headers=H(atok), json={
    "values": {"nationality": "Martian"},
    "request_id": _nbk["id"], "passenger_id": _npax,
})
check("a genuinely changed country IS accepted", r.status_code == 200, r.text[:200])
_a = _audit_for(_nrow["id"], _nbk["id"])
check("a real nationality override is recorded", "nationality" in _a, sorted(_a))
if "nationality" in _a:
    check("...against what the PROVIDER read, not what the form displayed",
          _a["nationality"]["ocr_value"] == _nread.get("nationality"),
          _a["nationality"])
    check("...carrying the operator's value",
          _a["nationality"]["edited_value"] == "Martian", _a["nationality"])
    check("...named to a person", bool(_a["nationality"]["edited_by_name"]))
check("and exactly one row, not one per save", len(_a) == 1, sorted(_a))

# --- ORDINARY FIELDS ARE UNAFFECTED IN BOTH DIRECTIONS.
r = requests.post(f"{EXTRACT}/{_nrow['id']}/edits", headers=H(atok), json={
    "values": {"last_name": (_nread.get("last_name") or "ERIKSSON") + "-JONES",
               "first_name": _nread.get("first_name")},
    "request_id": _nbk["id"], "passenger_id": _npax,
})
_a = _audit_for(_nrow["id"], _nbk["id"])
check("a changed surname is still audited", "last_name" in _a, sorted(_a))
check("a first name sent back UNCHANGED is still not audited",
      "first_name" not in _a, sorted(_a))

# --- RE-SAVING THE SAME THING DOES NOT ACCUMULATE.
requests.post(f"{EXTRACT}/{_nrow['id']}/edits", headers=H(atok), json={
    "values": {"last_name": (_nread.get("last_name") or "ERIKSSON") + "-JONES"},
    "request_id": _nbk["id"], "passenger_id": _npax,
})
_a = _audit_for(_nrow["id"], _nbk["id"])
check("re-saving an unchanged override leaves exactly one row", len(_a) == 1, sorted(_a))

# --- TWO PASSENGERS, TWO SCANS: one traveller's silence must not silence the
# other's real edit, and neither scan may borrow the other's audit.
_p2 = admin_scan(atok, mine, content=PNG_B)
check("a second, DIFFERENT passport scans", _p2.status_code in (200, 202), _p2.status_code)
_p2row = _p2.json()
_p2read = {k: (v or {}).get("value") for k, v in (_p2row.get("fields") or {}).items()}
_me = desk_enquiry()
_mb = desk_booking(_me["id"], [
    {"title": "Ms", "first_name": "One", "last_name": "Traveller",
     "gender": "female", "dob": "1974-08-12", "passenger_type": "adult",
     "nationality": "British", "passport_number": "L898902C3",
     "passport_expiry": _expiry},
    {"title": "Mr", "first_name": "Two", "last_name": "Traveller",
     "gender": "male", "dob": "1988-02-03", "passenger_type": "adult",
     "nationality": "Indian", "passport_number": "Z4471985",
     "passport_expiry": _expiry},
])
check("a two-traveller desk booking saves", _mb.status_code == 201,
      f"{_mb.status_code} {_mb.text[:200]}")
_mbk = _mb.json()
_mp = [p["id"] for p in (_mbk.get("passengers") or [])]
check("both travellers come back with ids", len(_mp) == 2, _mp)

if len(_mp) == 2:
    # traveller one: untouched -> nothing.  traveller two: a real edit.
    requests.post(f"{EXTRACT}/{_nrow['id']}/edits", headers=H(atok), json={
        "values": {}, "request_id": _mbk["id"], "passenger_id": _mp[0]})
    requests.post(f"{EXTRACT}/{_p2row['id']}/edits", headers=H(atok), json={
        "values": {"last_name": "DELIBERATELY-CHANGED"},
        "request_id": _mbk["id"], "passenger_id": _mp[1]})
    _rows = requests.get(f"{BASE}/api/admin/requests/{_mbk['id']}/passport-ocr",
                         headers=H(atok)).json()
    _by = {x["id"]: x for x in _rows}
    check("both scans are on the booking", len(_by) == 2, sorted(_by))
    check("the untouched traveller's scan carries NO edits",
          _by.get(_nrow["id"], {}).get("edits") == [],
          _by.get(_nrow["id"], {}).get("edits"))
    check("the other traveller's real edit survives",
          any(e["field_name"] == "last_name"
              for e in _by.get(_p2row["id"], {}).get("edits", [])),
          _by.get(_p2row["id"], {}).get("edits"))
    check("each scan is attached to its OWN traveller",
          _by.get(_nrow["id"], {}).get("passenger_id") == _mp[0]
          and _by.get(_p2row["id"], {}).get("passenger_id") == _mp[1],
          [(k, v.get("passenger_id")) for k, v in _by.items()])

# --- THE MERCHANT'S OWN PATH IS JUDGED BY THE SAME SERVER RULE.
_mscan = scan(mtok, content=PNG_A)[1]
if _mscan:
    r = requests.post(f"{EXTRACT}/{_mscan['id']}/edits", headers=H(mtok),
                      json={"values": {}})
    check("a merchant omitting every field records nothing either",
          r.status_code == 200 and not r.json().get("edits"), r.text[:160])

sys.exit(check.report())
