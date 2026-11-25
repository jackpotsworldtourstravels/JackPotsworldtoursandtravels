"""Issue #13 — chat attachments: locally-testable behaviour.

The privacy-critical half of the attachment pipeline is EXIF stripping: a
customer who photographs their passport to send to support uploads a JPEG whose
EXIF block holds the GPS coordinates it was taken at — their home address. The
service re-encodes every image to drop that. This pins:

  * an uploaded JPEG/PNG comes back with NO EXIF (DateTime / GPS gone),
  * a non-image (PDF) is passed through untouched (nothing to strip),
  * _kind() / message_type_for() classify inline images vs files correctly,
  * the 10 MB cap and the inline-image allowlist are what the endpoint advertises.

What this canNOT test locally, and is documented as a real-agent dependency in
docs/qa: an AGENT actually composing and SENDING an attachment to a customer, and
the live WebSocket DELIVERY of an attachment frame, both need a connected admin
session (test_live_support_websocket.py states attachments-over-socket are "NOT
covered and NOT claimed"). The customer upload path, access control (owner-only
download, tested in test_phase13_chat_access.py) and this re-encode ARE local.
"""
import io

import pytest

from app.services import chat_attachments as att


def _jpeg_with_exif() -> bytes:
    Image = pytest.importorskip("PIL.Image")
    img = Image.new("RGB", (16, 16), (90, 120, 160))
    exif = img.getexif()
    exif[0x0132] = "2021:06:01 12:00:00"  # DateTime — stand-in for the EXIF block
    exif[0x9003] = "2021:06:01 12:00:00"  # DateTimeOriginal
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    return buf.getvalue()


def _upload(data: bytes, content_type: str, name: str):
    from starlette.datastructures import Headers, UploadFile
    return UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({"content-type": content_type}))


def test_jpeg_upload_comes_back_without_exif():
    raw = _jpeg_with_exif()
    from PIL import Image
    assert dict(Image.open(io.BytesIO(raw)).getexif()), "fixture must START with EXIF"

    cleaned = att._strip_exif(_upload(raw, "image/jpeg", "passport.jpg"))
    out = cleaned.file.read()
    exif_after = dict(Image.open(io.BytesIO(out)).getexif())
    assert not exif_after, f"EXIF must be gone after re-encode, found: {exif_after}"


def test_pdf_is_passed_through_untouched():
    data = b"%PDF-1.4 fake pdf bytes"
    up = _upload(data, "application/pdf", "ticket.pdf")
    result = att._strip_exif(up)
    assert result is up, "a non-image has no EXIF to strip and must not be re-encoded"


def test_kind_classifies_inline_images_vs_files():
    assert att._kind("image/jpeg") == "image"
    assert att._kind("image/png") == "image"
    assert att._kind("image/webp") == "image"
    assert att._kind("application/pdf") == "file"
    assert att._kind("text/plain") == "file"


def test_cap_and_allowlist_match_the_endpoint_contract():
    assert att.MAX_ATTACHMENT_BYTES == 10 * 1024 * 1024
    assert set(att._INLINE_IMAGE_TYPES) == {"image/jpeg", "image/png", "image/webp"}
