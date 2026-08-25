"""Azure AI Document Intelligence — the ``prebuilt-idDocument`` model.

WHY THE REST API AND NOT ``azure-ai-documentintelligence``
The SDK would be one more dependency in the image for two HTTP calls, and its
shape would leak into this package: an adapter written around
``DocumentIntelligenceClient`` is markedly harder to sit beside a Google Vision
or Textract adapter than one written around "POST bytes, poll a URL". The REST
contract is also the stable thing — it is versioned by ``api-version`` in the
query string, which is exactly what :attr:`api_version` pins and what every row
records. ``requests`` is already in the image.

HOW THE CALL WORKS
Analysis is asynchronous by design at the vendor, which is convenient rather
than awkward here:

    POST {endpoint}/documentintelligence/documentModels/
         prebuilt-idDocument:analyze?api-version=...   -> 202 + Operation-Location
    GET  {Operation-Location}                          -> running | succeeded | failed

The 202 pattern is why the endpoint above this can answer the merchant in three
seconds and hand back a job id if the provider is slower than that: the work is
already a poll loop, and the only question is who waits on it.

WHAT IT READS
``prebuilt-idDocument`` covers passports, national IDs and driving licences and
returns a ``documentType`` saying which it decided it was. This adapter refuses
anything that is not a passport rather than filling a form from a driving
licence that happens to have a name on it — the merchant uploaded the wrong
page, and saying so is more useful than half a passenger.

CREDENTIALS NEVER LEAVE THE SERVER. The key is read from the environment, used
in a request header, and never returned in any response, log line or error
message — ``_safe_error`` exists to make sure a vendor error body carrying a
signed URL cannot be echoed to a merchant either.
"""
from __future__ import annotations

import time
from typing import Any

from app.services.passport_ocr.base import (
    ExtractedField,
    MRZResult,
    OCRFailed,
    OCRMisconfigured,
    OCRTimeout,
    PassportExtraction,
    clean_text,
    merge_mrz,
    parse_mrz,
    to_gender,
    to_iso_date,
)

#: The vendor's field names -> ours. The left-hand side is the only place in
#: this application where Azure's vocabulary appears.
_FIELD_MAP: dict[str, str] = {
    "FirstName": "first_name",
    "LastName": "last_name",
    "Sex": "gender",
    "DateOfBirth": "dob",
    "PlaceOfBirth": "place_of_birth",
    "Nationality": "nationality",
    "DocumentNumber": "passport_number",
    # `passport_type` is deliberately NOT mapped from Azure's `DocumentType`.
    # That field answers "passport or driving licence", which the docType check
    # above has already settled; the distinction worth recording — ordinary `P`
    # against diplomatic `PD`, service `PS`, official `PO` — exists only in the
    # first two characters of the MRZ, so the MRZ is where it is read from. A
    # passport whose MRZ could not be read simply has no type, which is the
    # honest answer rather than "passport".
    "CountryRegion": "passport_issue_country",
    "DateOfIssue": "passport_issue_date",
    "DateOfExpiration": "passport_expiry",
}

#: Keys ``prebuilt-idDocument`` has used for the machine-readable zone across
#: API versions. Tried in order and the first that yields two 44-character lines
#: wins. A list rather than one name because this adapter has not yet been run
#: against a live resource: if the shape differs, the raw response is stored on
#: every row and the fix is one entry here, not a re-upload.
_MRZ_KEYS: tuple[str, ...] = (
    "MachineReadableZone",
    "MRZ",
    "MachineReadableZoneLine1",
)


class AzureDocumentIntelligenceProvider:
    """Passport OCR against an Azure Document Intelligence resource."""

    name = "azure_document_intelligence"

    def __init__(
        self,
        endpoint: str | None,
        api_key: str | None,
        *,
        model: str = "prebuilt-idDocument",
        api_version: str = "2024-11-30",
        timeout_seconds: float = 30.0,
        poll_interval_seconds: float = 1.0,
    ):
        # Refused at construction rather than on the first scan: a half-configured
        # deployment should be visible when the provider is selected, not when a
        # merchant is standing in front of a spinner.
        if not (endpoint or "").strip() or not (api_key or "").strip():
            # Misconfigured, not "not configured": someone SELECTED azure and
            # the deployment cannot honour it. The distinction is what turns a
            # silently missing Scan button into a startup error naming the two
            # variables that are missing.
            raise OCRMisconfigured(
                "OCR_PROVIDER=azure needs OCR_AZURE_ENDPOINT and OCR_AZURE_KEY "
                "to be set."
            )
        self._endpoint = endpoint.strip().rstrip("/")
        self._key = api_key.strip()
        self.model = model
        self.api_version = api_version
        self._timeout = timeout_seconds
        self._poll = poll_interval_seconds

    # -- plumbing ----------------------------------------------------------
    @staticmethod
    def _safe_error(response: Any) -> str:
        """A vendor error reduced to something safe to store and show.

        Never the raw body: an Azure error can carry the request URL, and for
        the analyse call that URL is the resource endpoint. Status code and the
        vendor's own short code are enough to diagnose from, and neither is a
        secret.
        """
        code = ""
        try:
            payload = response.json()
            code = (
                payload.get("error", {}).get("code")
                or payload.get("code")
                or ""
            )
        except Exception:
            pass
        return f"HTTP {response.status_code}{f' ({code})' if code else ''}"

    def _analyze(self, content: bytes, content_type: str) -> str:
        # Imported here rather than at module scope so a deployment that has not
        # configured OCR never pays to import it, matching how storage.py treats
        # boto3.
        import requests

        url = (
            f"{self._endpoint}/documentintelligence/documentModels/"
            f"{self.model}:analyze?api-version={self.api_version}"
        )
        try:
            response = requests.post(
                url,
                data=content,
                headers={
                    "Ocp-Apim-Subscription-Key": self._key,
                    "Content-Type": content_type,
                },
                timeout=self._timeout,
            )
        except Exception as exc:  # network, DNS, TLS
            raise OCRFailed(f"Could not reach the OCR service: {type(exc).__name__}") from exc

        if response.status_code == 401 or response.status_code == 403:
            # A rejected key is a deployment fault, not a bad scan, and the
            # merchant's message should say so.
            raise OCRMisconfigured(
                f"The OCR service rejected our credentials ({self._safe_error(response)})."
            )
        if response.status_code != 202:
            raise OCRFailed(f"The OCR service refused the document ({self._safe_error(response)}).")

        location = response.headers.get("Operation-Location")
        if not location:
            raise OCRFailed("The OCR service accepted the document but returned no result location.")
        return location

    def _await_result(self, location: str) -> dict[str, Any]:
        import requests

        deadline = time.monotonic() + self._timeout
        while True:
            try:
                response = requests.get(
                    location,
                    headers={"Ocp-Apim-Subscription-Key": self._key},
                    timeout=self._timeout,
                )
            except Exception as exc:
                raise OCRFailed(f"Lost contact with the OCR service: {type(exc).__name__}") from exc

            if response.status_code != 200:
                raise OCRFailed(f"The OCR service returned an error ({self._safe_error(response)}).")

            body = response.json()
            status = str(body.get("status", "")).lower()
            if status == "succeeded":
                return body
            if status == "failed":
                raise OCRFailed("The OCR service could not read this document.")

            if time.monotonic() + self._poll >= deadline:
                raise OCRTimeout("The OCR service did not answer in time.")
            time.sleep(self._poll)

    # -- interpretation ----------------------------------------------------
    @staticmethod
    def _fields_from(body: dict[str, Any]) -> dict[str, ExtractedField]:
        """Turn one analysed document into our field vocabulary.

        Only the FIRST document is read. A passport photo page is one document;
        a file with several is a merchant scanning a whole booklet, and picking
        one traveller's details out of it is a guess this refuses to make.
        """
        documents = (body.get("analyzeResult") or {}).get("documents") or []
        if not documents:
            raise OCRFailed("No document was found in that image.")

        doc = documents[0]
        doc_type = str(doc.get("docType") or "")
        if "passport" not in doc_type.lower():
            # idDocument also matches driving licences and national IDs. Filling
            # a passport form from one produces a plausible-looking passenger
            # with no passport number, which is worse than a clear refusal.
            raise OCRFailed(
                "That does not look like a passport page. Upload the photo page "
                "showing the machine-readable lines at the bottom."
            )

        raw_fields = doc.get("fields") or {}
        out: dict[str, ExtractedField] = {}
        for vendor_name, our_name in _FIELD_MAP.items():
            entry = raw_fields.get(vendor_name)
            if not isinstance(entry, dict):
                continue
            value = AzureDocumentIntelligenceProvider._value_of(entry, our_name)
            if value is None:
                continue
            confidence = entry.get("confidence")
            out[our_name] = ExtractedField(
                value=value,
                confidence=float(confidence) if isinstance(confidence, (int, float)) else None,
            )
        out = merge_mrz(out, AzureDocumentIntelligenceProvider._mrz_of(raw_fields))
        if not out:
            raise OCRFailed("Nothing could be read from that image. Try a sharper scan.")
        return out

    @staticmethod
    def _mrz_of(raw_fields: dict[str, Any]) -> MRZResult | None:
        """The machine-readable zone, wherever this API version put it.

        The zone may arrive as a plain string, or as an object whose ``content``
        is the two lines and whose sub-fields repeat what is in them. Only the
        text is taken: the sub-fields are the vendor's own parse, and parsing it
        here is what gets the check digits verified rather than trusted.
        """
        for key in _MRZ_KEYS:
            entry = raw_fields.get(key)
            if entry is None:
                continue
            if isinstance(entry, dict):
                text = entry.get("content") or entry.get("valueString")
                # Some shapes nest the two lines as separate sub-fields.
                if not text and isinstance(entry.get("valueObject"), dict):
                    parts = [
                        sub.get("content") or sub.get("valueString") or ""
                        for sub in entry["valueObject"].values()
                        if isinstance(sub, dict)
                    ]
                    text = "\n".join(p for p in parts if p)
            else:
                text = entry
            parsed = parse_mrz(text)
            if parsed is not None:
                return parsed
        return None

    @staticmethod
    def _value_of(entry: dict[str, Any], our_name: str) -> str | None:
        """One vendor field to one of our values, in our format.

        ``valueString``/``valueDate``/``valueCountryRegion`` are preferred over
        ``content`` because ``content`` is the literal ink on the page —
        ``"25 DEC 1990"`` where ``valueDate`` is already ``1990-12-25``. Falling
        back to ``content`` only when the typed value is absent is what keeps a
        field the model recognised but did not type from being lost.
        """
        typed = (
            entry.get("valueDate")
            or entry.get("valueCountryRegion")
            or entry.get("valueString")
        )
        raw = typed if typed not in (None, "") else entry.get("content")
        if our_name in ("dob", "passport_issue_date", "passport_expiry"):
            return to_iso_date(raw)
        if our_name == "gender":
            return to_gender(raw)
        text = clean_text(raw)
        if text is None:
            return None
        if our_name == "passport_number":
            # Uppercased and stripped of the spaces some passports print, so it
            # matches what lookup_passenger() compares against.
            return text.replace(" ", "").upper()
        return text

    # -- the contract ------------------------------------------------------
    def extract(self, content: bytes, content_type: str) -> PassportExtraction:
        started = time.monotonic()
        body = self._await_result(self._analyze(content, content_type))
        fields = self._fields_from(body)
        return PassportExtraction(
            fields=fields,
            provider=self.name,
            model=self.model,
            api_version=self.api_version,
            raw=body,
            processing_ms=int((time.monotonic() - started) * 1000),
        )
