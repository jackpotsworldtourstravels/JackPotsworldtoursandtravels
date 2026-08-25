# CR-8 — Passport OCR on the booking form

**Status: BUILT, AWAITING APPROVAL.** An out-of-band change request, not a numbered
milestone. Migration `0042_passport_ocr`. Additive throughout: no approved behaviour is
altered, no existing endpoint changed, no permission code added, and no submit rule moved.

---

## 1. What it does

A merchant filling in an international booking types eleven fields per traveller off a
passport. This lets them upload the passport instead:

```
Merchant Portal (booking form, per passenger)
        │  Scan passport
        ▼
POST /api/bookings/passport/extract        multipart, no draft required
        ▼
passport_ocr_service                        storage · row · scope · audit
        ▼
app.services.passport_ocr.get_provider()    chosen by OCR_PROVIDER
        ▼
Azure AI Document Intelligence              prebuilt-idDocument, REST
        ▼
normalise → passenger fields + a confidence EACH
        ▼
form filled · fields colour-banded · duplicate offered · expiry checked
```

## 2. The rule the whole thing is built around

**Scanning is a shortcut over a form that is complete without it.** It cannot be required,
it cannot gate a submission, and it cannot fail in a way that stops a merchant booking.

CR-1 removed uploads from this workflow because attaching a passport forced the merchant to
save a draft first, which made drafting mandatory on international routes. Anything with
that shape would be the same defect wearing a new name. Concretely:

- an extraction needs **no `request_id` and no `passenger_id`** — it works on a blank form,
  which is the only moment it is actually useful;
- it **writes no passenger data** — the merchant's own Save creates the passenger row
  exactly as it always has;
- every failure path returns a form the merchant can still type into;
- `ticket_service` is not touched, so the submit rules are what they were.

`tests/verify_passport_ocr.py` asserts this first, and asserts it whether or not OCR is
configured.

## 3. Configuration

| Setting | Default | Notes |
|---|---|---|
| `OCR_PROVIDER` | `local` | `local` · `azure` · `none` |
| `OCR_TIMEOUT_SECONDS` | `60` | Whole-call budget |
| `OCR_INLINE_WAIT_SECONDS` | `8` | Past this the endpoint answers `202` and the client polls |
| `OCR_LOCAL_DPI` | `300` | PDF render resolution; below ~250 the zone's fillers are lost |
| `OCR_LOCAL_MAX_PAGES` | `2` | Pages read from a multi-page PDF |
| `OCR_AZURE_ENDPOINT` | — | `https://<resource>.cognitiveservices.azure.com` |
| `OCR_AZURE_KEY` | — | **Never leaves the server.** Not in any response, log or stored error. |
| `OCR_AZURE_MODEL` | `prebuilt-idDocument` | Pinned, not "latest" |
| `OCR_AZURE_API_VERSION` | `2024-11-30` | Recorded on every row |
| `PASSPORT_VALIDITY_MONTHS` | `6` | **Advisory** — see §6 |

**With `OCR_PROVIDER=none` the merchant portal renders no Scan control at all** and the
booking form is byte-for-byte what it was.

### The `local` provider — the default, and the only one needing no account

`app/services/passport_ocr/local_provider.py` reads the uploaded document on this server.
No vendor, no credentials, no outbound request. It renders the page (PyMuPDF for PDFs),
OCRs it (`rapidocr-onnxruntime`, CPU, models bundled in the wheel), locates the TD3
machine-readable zone, and takes its answer from there.

**The zone is the point.** Its layout is fixed character by character by ICAO 9303 and it
carries check digits over the passport number, the date of birth and the expiry — so those
three fields are *proved* rather than estimated and come back at confidence 1.0. That same
fixed layout is what lets the reader correct itself without guessing: a position the
standard says is a digit cannot hold an `O`, and where that is not enough, single-character
alternatives are tried and one is accepted **only if the document's own check digit then
verifies**.

Two fields are not in the zone at all — place of birth and date of issue — and are found on
the printed page by their label, at a deliberately lower confidence that puts them in the
review band. The name lines carry no check digit, so they are read twice (zone and printed
page) and reconciled: agreement raises the confidence, disagreement lowers it below either
reading and keeps the field flagged.

### There is no provider that invents data

A `simulated` provider used to exist. It derived a passenger from the uploaded file's
SHA-256 and **never opened the image** — so a merchant who uploaded a real passport got a
real-looking name belonging to nobody, at 99% confidence. It has been deleted.

`OCR_PROVIDER=simulated` is now **refused by name** with `OCRMisconfigured`, rather than
falling through to "unknown provider", so an old `.env` or deployment script fails loudly
and says what to use instead.

`provider = "simulated"` rows written before the removal are still in the database, and the
API still returns `simulated: true` for them — that flag is now a marker of *historical*
fabricated data, and any screen showing such a row must still say so.

### Setting up the Azure resource

1. **Azure portal → Create a resource → "Document Intelligence"** (listed under AI + Machine
   Learning; it was called *Form Recognizer* before 2023 and older docs still say so).
2. **Region — pick `Central India` or `South India`.** This is the one choice that is
   awkward to change later: every uploaded passport is sent to the region the resource lives
   in, and Indian passport data leaving India is a question worth not having to answer.
3. **Pricing tier:**
   - **F0 (Free)** — 500 pages/month, rate-limited, one resource per subscription. Correct
     for wiring this up and testing against real passports.
   - **S0 (Standard)** — pay per page, no monthly cap. Correct for production. Check the
     current per-page rate for the *prebuilt ID model* on Azure's pricing page; it is billed
     separately from the read/layout models and the figure changes.

   Start on F0, move to S0 before real merchant traffic. The tier is a resource property —
   nothing in this application changes with it.
4. **Keys and Endpoint** blade → copy **KEY 1** and the **Endpoint**.
5. Set three variables and restart:

   ```
   OCR_PROVIDER=azure
   OCR_AZURE_ENDPOINT=https://<your-resource>.cognitiveservices.azure.com
   OCR_AZURE_KEY=<KEY 1>
   ```

   The endpoint is the bare origin — no path, no trailing slash. The adapter appends
   `/documentintelligence/documentModels/prebuilt-idDocument:analyze`.

**Check it took.** The application logs one line at startup: `Passport OCR is enabled,
provider=azure_document_intelligence`, or `PASSPORT OCR IS MISCONFIGURED ...` naming what is
missing. `GET /api/bookings/passport/availability` reports the same thing as
`configuration_error`. A misconfigured provider is deliberately **not** fatal — scanning is a
shortcut over a form that works without it, so a bad key must not stop the platform taking
bookings — but it must never be discovered only because a merchant said the button vanished.

## 4. Provider independence

`app/services/passport_ocr/base.py` defines the whole contract: `PassportOCRProvider` with
one method, `PassportExtraction`, and `ExtractedField(value, confidence)`. Adding Google
Vision, AWS Textract or OCR.Space is a new module in that package plus one branch in
`_build()`. No caller changes, no vendor name appears in `passport_ocr_service`, and no
vendor field name reaches the `normalized` column — the adapter maps into
`passenger_data`'s own vocabulary before anything is stored.

**REST, not the Azure SDK.** Two HTTP calls do not justify a dependency whose shape would
leak into the package; an adapter written around "POST bytes, poll a URL" is markedly easier
to sit beside another vendor's than one written around `DocumentIntelligenceClient`.

## 5. Confidence is per field

A passport read is not "89% correct". The number comes off the machine-readable zone and is
near-certain; the expiry is ornate print and is where the mistakes are. One document score
hides exactly the field the merchant needs to check.

| Band | Score | Merchant form | Admin |
|---|---|---|---|
| `high` | ≥ 95% | green border | green badge |
| `medium` | 80–94% | amber border | amber badge |
| `low` | < 80% | red border | red badge |

The thresholds live in **one place** (`passport_ocr_service.CONFIDENCE_BANDS`), are computed
server-side into each field's `band`, and are also returned as `confidence_bands` so a client
can label them without writing the numbers down a second time.

Colour is never the only signal — every scanned field also carries a `NN%` text badge,
because "check this field" must not depend on separating green from amber.

## 6. Passport validity — advisory at CR-8, **enforced since 2026-08-07**

Two rules are assessed and returned with every successful extraction:

1. **Expired** → `severity: "error"`.
2. **Valid for fewer than `PASSPORT_VALIDITY_MONTHS` beyond the travel date** →
   `severity: "error"` (**`"warning"` when CR-8 shipped**).

Both are now enforced server-side at submission by
`ticket_service._validate_classic_submission`, and the figure and arithmetic live in
`app/services/passport_rules.py` so the assessment and the refusal cannot quote different
numbers. The group-booking manifest importer applies the same rule row by row.

**What this paragraph used to say, and why it changed.** Rule 2 was deliberately *not*
enforced when this feature shipped: turning it into a refusal changed approved submit
behaviour for every international booking on the platform, including ones already in flight —
a change request in its own right, not something a scanning feature got to decide
(`BOOKING_OPS_MILESTONES.md` §0.3). It said "if the business wants rule 2 to block, that is a
one-line change in `_validate_classic_submission` plus an approval — ask before making it."
**That approval was given on 2026-08-07** as item 3 of the UI/validation change request, and
the change was made. `tests/verify_passport_ocr.py` asserts the refusal where it used to
assert the submission succeeding.

Note that the assessment on a *scan row* still measures the provider's own reading
(`row.normalized`) — `record_edits` records an edit beside a reading, never over it — so a
corrected expiry is judged where it matters, on the passenger row, at submit.

## 7. Duplicate travellers

After a successful read, the passport number goes through the **existing**
`ticket_service.lookup_passenger`, which was built for the type-a-passport-number shortcut
and is already merchant-scoped, already refuses short numbers that would leak by
enumeration, and is already covered by `tests/verify_passenger_lookup.py`. A second query
would be a second set of those decisions to keep in step.

The merchant is offered **Use existing / keep the scan** on the fields that differ. All
outcomes end with the same form being saved the same way — the lookup writes nothing and
returns **no passenger id**, so "never create a duplicate passenger record without
confirmation" holds by construction rather than by a rule somebody has to remember.

## 8. What is stored

`passport_ocr_extractions`

- the scan's storage key, filename, type, size, checksum
- `status`, `provider`, `provider_model`, `provider_api_version`
- `raw_response` — the provider's untouched reply
- `normalized` — `{"passport_number": {"value": …, "confidence": …}, …}`
- `overall_confidence`, `processing_ms`, `error_code`, `error_detail`
- `request_id` and `passenger_id`, **both nullable**, set later if the booking is saved

`passport_ocr_field_edits` — one append-only row per field the merchant overrode: the OCR
value, the saved value, the confidence at the time, who and when. A database check refuses a
row where the two values match, so a client that posts its whole form cannot bury the one row
an investigation is looking for.

## 9. Security

- **The scan is never public.** No static mount, no public bucket, and **no presigned URL** —
  it is streamed by `GET /api/bookings/passport/extract/{id}/scan` after the service
  re-checks who is asking, marked `private, no-store` and `nosniff`.

  > The original specification asked for temporary signed URLs. This deliberately does not
  > use them, matching the decision `document_service` already documents for booking
  > documents: a signed URL is a bearer token for a passport scan that keeps working after
  > the session that minted it has ended, cannot be revoked, and travels in browser history
  > and referrer headers. Proxying re-checks authorisation on **every** read, which is
  > strictly stronger than a URL checked once. The requirement behind the request — never
  > publicly accessible, reachable only by the uploading merchant and authorised staff — is
  > met, and met better.

- **Encryption at rest** is the storage layer's, unchanged: the S3 backend requests
  `ServerSideEncryption` on every put (`S3_SSE`, default `AES256`). The local backend is a
  directory — encryption there is the volume's job, and `UPLOAD_ROOT` should point at an
  encrypted volume with restricted permissions in production. This is the same posture
  passport scans uploaded as booking documents have had since migration 0031.
- **Upload validation is not duplicated.** The endpoint calls
  `document_service.store_upload`, so the type allowlist, the magic-byte sniff that stops an
  HTML payload arriving as `image/png`, and the streaming size cap are the same code that
  guards booking documents. A second copy is how one of them ends up missing a check.
- **Scope.** A merchant sees only its own extractions (404, never 403, for anyone else's).
  Platform staff see one **only once it is attached to a booking** — a passport read into a
  form the merchant never submitted is not the desk's to read.
- **Permissions reuse `document.upload` and `document.verify`.** Both have existed since
  0023. Adding a code would be a change to an approved role matrix. The merchant endpoints
  take `document.upload`; the Admin panel takes `document.verify`. **`GET .../scan` takes
  either** — no platform role holds `document.upload`, so gating the file itself on that code
  alone let the desk see that a scan existed and never open it. Widening the gate does not
  widen what staff reach: the scoping rule above still hands them attached rows only.
- **Credentials never reach a browser**, and a vendor error body is reduced to a status code
  and the vendor's short code before being stored or shown, so an error carrying the resource
  endpoint cannot be echoed to a merchant.

## 10. Background processing

The endpoint waits `OCR_INLINE_WAIT_SECONDS` (3) and then answers `202` with a job id; the
client polls every 2s. The work runs on a bounded thread pool and writes its result to **the
row, not to memory** — this application runs under gunicorn with several worker processes and
the poll will frequently land on a different process from the one doing the work. A worker
that dies mid-scan leaves a row at `processing`, which is turned into
`failed / ocr_abandoned` at read time once past its budget, so a client never polls forever.

## 11. Verification

`tests/verify_passport_ocr.py`, registered in `run_all.py`. Covers extraction, the poll path,
per-field banding against the published thresholds, determinism, upload rejection (415/400),
the authenticated scan proxy and its headers, cross-merchant and staff scoping, the duplicate
match (including that it carries no id), the six-month expiry rule **and that a booking is now
refused under it** (this asserted the opposite until 2026-08-07 — see §6), the
expired-passport refusal still refusing, the edit audit (records changes, only changes,
replaces on re-save), and that a booking whose scan failed still submits.

With `OCR_PROVIDER` unset the script asserts the unavailable contract — availability reports
false, extract answers 503, bookings unaffected — and says so loudly rather than skipping
quietly.

## 12. Open items

- **THE AZURE ADAPTER HAS NEVER RUN AGAINST A LIVE RESOURCE.** It is written, compiles, and
  its normalisation is unit-tested against a synthetic response — but no real Azure call has
  ever been made, so the field names, the MRZ key, the confidence scale and the error bodies
  are all *expected* rather than *observed*. Budget time for tuning `_FIELD_MAP` and
  `_MRZ_KEYS` on the first real scan. Every row stores the untouched vendor response, so that
  tuning needs no re-upload. This is the single largest piece of unverified work in CR-8.
- **`nationality` has two vocabularies.** The MRZ carries the ISO-3166 alpha-3 code (`JPN`),
  the printed page carries the demonym (`Japanese`), and `merge_mrz` never overrides a
  printed value with an MRZ one for this field because neither derives from the other without
  a lookup table this platform does not have. A passenger whose page-read failed therefore
  stores `JPN` where one whose page-read succeeded stores `Japanese`. Harmless today —
  nothing keys off nationality — but it is an inconsistency, and the fix is a country table
  rather than a code change.
- The Azure adapter refuses a document whose `docType` is not a passport (the
  `prebuilt-idDocument` model also matches driving licences and national IDs). If the
  business wants those accepted for domestic bookings, that is a small change to
  `_fields_from` — and a decision, not a bug.
