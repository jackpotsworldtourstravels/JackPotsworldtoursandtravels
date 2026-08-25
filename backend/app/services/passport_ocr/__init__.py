"""Passport OCR: one contract, one adapter per vendor, chosen by configuration.

    booking form -> POST /api/bookings/passport/extract
                 -> passport_ocr_service          (storage, rows, audit, scope)
                 -> get_provider()                (this module)
                 -> AzureDocumentIntelligence     (or another adapter)
                 -> normalized fields + confidence
                 -> the merchant's form

Nothing above ``get_provider`` knows which vendor is configured, and nothing
below it knows about bookings. Adding Google Vision, AWS Textract or OCR.Space
is a new module implementing :class:`~base.PassportOCRProvider` plus a branch in
:func:`_build`; no caller changes.

THE PROVIDER IS BUILT ONCE AND CACHED, BUT A CONFIGURATION FAULT IS NOT.
:class:`~base.OCRNotConfigured` is re-raised on every call rather than cached as
a permanent dead provider, so setting the environment variables and restarting
is the whole fix — and so a deployment that has never configured OCR answers
"unavailable" rather than crashing at import, exactly as SMTP does.
"""
from __future__ import annotations

import logging
import threading

# The MODULE, not `from app.config import settings`. Every other service binds
# the object directly, which is right for them — none of them is reconfigured
# after import. This one is: `reset_provider_cache()` exists so a test can point
# the platform at the simulated provider and back, and a bound reference would
# still be reading the settings object that existed at import time.
import app.config
from app.services.passport_ocr.base import (  # re-exported: this is the public surface
    DATE_FIELDS,
    PASSPORT_FIELDS,
    ExtractedField,
    OCRError,
    OCRFailed,
    OCRMisconfigured,
    OCRNotConfigured,
    OCRTimeout,
    PassportExtraction,
    PassportOCRProvider,
)

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_cached: PassportOCRProvider | None = None


def _build() -> PassportOCRProvider:
    settings = app.config.settings
    name = (settings.ocr_provider or "").strip().lower()

    if name in ("", "none", "off", "disabled"):
        raise OCRNotConfigured(
            "Passport scanning is not enabled on this deployment."
        )

    if name == "azure":
        from app.services.passport_ocr.azure_provider import (
            AzureDocumentIntelligenceProvider,
        )

        return AzureDocumentIntelligenceProvider(
            settings.ocr_azure_endpoint,
            settings.ocr_azure_key,
            model=settings.ocr_azure_model,
            api_version=settings.ocr_azure_api_version,
            timeout_seconds=settings.ocr_timeout_seconds,
        )

    if name == "local":
        # Reads the document on this server. No credentials to check, so the
        # only way it can be misconfigured is a missing wheel — reported as a
        # configuration fault rather than as a failed scan, because the merchant
        # who uploaded a perfectly good passport did nothing wrong.
        try:
            from app.services.passport_ocr.local_provider import LocalPassportProvider
        except ImportError as exc:
            raise OCRMisconfigured(
                "OCR_PROVIDER=local needs its extraction dependencies: "
                f"pip install -r requirements.txt ({exc})."
            ) from exc

        return LocalPassportProvider(
            dpi=settings.ocr_local_dpi,
            max_pages=settings.ocr_local_max_pages,
        )

    # "simulated" IS NAMED HERE ON PURPOSE, AND REFUSED.
    # A provider of that name used to exist and fabricated a passenger from the
    # checksum of the uploaded file. It was removed because every extraction
    # this platform had ever recorded came from it, and an invented name at 99%
    # confidence is indistinguishable, on the merchant's screen, from a read
    # one. Left as an explicit refusal rather than falling into the "unknown"
    # branch below so that an old .env, an old deployment script or an old
    # runbook fails loudly and says why, instead of reporting a typo.
    if name == "simulated":
        raise OCRMisconfigured(
            "OCR_PROVIDER=simulated no longer exists. It invented passenger "
            "details instead of reading the uploaded document. Use 'local' to "
            "extract on this server, 'azure' for Azure Document Intelligence, "
            "or 'none' to offer no scanning."
        )

    raise OCRMisconfigured(
        f"Unknown OCR_PROVIDER {name!r}. Use 'local', 'azure' or 'none'."
    )


def get_provider() -> PassportOCRProvider:
    """The configured provider, or raise :class:`OCRNotConfigured`."""
    global _cached
    if _cached is not None:
        return _cached
    with _lock:
        if _cached is None:
            _cached = _build()
        return _cached


def reset_provider_cache() -> None:
    """Drop the cached provider. For tests that change the configuration."""
    global _cached
    with _lock:
        _cached = None


def is_available() -> bool:
    """Can a merchant be offered the Scan button at all?

    Asked by the endpoint that the merchant portal calls on load, so a
    deployment without OCR renders no control rather than a button that fails.
    """
    try:
        get_provider()
        return True
    except OCRError:
        return False


def configuration_error() -> str | None:
    """The operator-facing fault, if a provider was selected and cannot run.

    ``None`` covers both healthy states — a working provider, and ``none``,
    which is a deliberate choice rather than a fault. Anything else is a
    deployment someone needs to fix, and this is what the availability endpoint
    reports so it shows up somewhere other than a merchant's missing button.
    """
    try:
        get_provider()
        return None
    except OCRMisconfigured as exc:
        return str(exc)
    except OCRError:
        return None


def check_configuration_at_startup() -> None:
    """Log loudly if OCR is selected but broken. Called from the app's lifespan.

    Deliberately a log and not a raise. Passport scanning is a shortcut over a
    booking form that is complete without it, so a bad OCR key must not stop the
    platform from taking bookings — but it must also never be discovered only
    because a merchant mentioned the button was missing.
    """
    fault = configuration_error()
    if fault:
        logger.error(
            "PASSPORT OCR IS MISCONFIGURED and no merchant will see the Scan "
            "control: %s", fault,
        )
    elif is_available():
        provider = getattr(get_provider(), "name", "?")
        logger.info("Passport OCR is enabled, provider=%s", provider)


__all__ = [
    "get_provider",
    "reset_provider_cache",
    "is_available",
    "configuration_error",
    "check_configuration_at_startup",
    "PassportOCRProvider",
    "PassportExtraction",
    "ExtractedField",
    "OCRError",
    "OCRFailed",
    "OCRMisconfigured",
    "OCRNotConfigured",
    "OCRTimeout",
    "PASSPORT_FIELDS",
    "DATE_FIELDS",
]
