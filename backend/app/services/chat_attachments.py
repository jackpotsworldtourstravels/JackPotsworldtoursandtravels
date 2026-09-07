"""Files on a chat message (CR-9, slice 5).

WHAT THIS MODULE IS FOR
``document_service.store_upload`` already owns the security-critical half — the
declared-type allowlist, the magic-byte sniff that stops an HTML payload
arriving as ``image/png``, the size cap enforced *while streaming* rather than
from a client-supplied ``Content-Length``, and the rule that a rejected upload
never reaches storage. That function is reused verbatim; nothing here
re-implements any of it, for the reason its own docstring gives about the copy
that gets forgotten during the next change being the one with the hole in it.

What is left is the part specific to chat: which conversation a file belongs to,
whether the caller may read it back, and how the bytes are served. The two
callers — the customer's widget and the agent console — differ only in how the
caller is identified, so the write path lives here once and each router supplies
its own scoping.

WHY DOC AND DOCX ARE NOT ACCEPTED, THOUGH THE BRIEF LISTS THEM
The brief asks for "images, PDF, DOC" and names the real uses: passport copies,
tickets, screenshots. Every one of those is a photo or a PDF, and both are
covered. ``.doc`` is an OLE compound file and ``.docx`` a zip; neither can be
validated by a leading signature the way the four accepted types can, both can
carry macros, and a support inbox is exactly where a hostile one would be sent.
Widening ``document_service``'s allowlist to admit them would also widen it for
passport uploads, which is not a trade this feature gets to make on that
feature's behalf. If Word files are genuinely needed, that is its own change
with its own scanning story — not a line added to a tuple.

RETENTION IS AN OPEN QUESTION, NOT AN ANSWERED ONE
The Privacy Policy promises travel documents are deleted after the trip. A
passport scan pasted into a chat is a travel document, and nothing here expires
it. CR-9 §12 records this; it is deliberately not solved by a guess.
"""
from __future__ import annotations

import io
import logging
from typing import Optional

from fastapi import HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.models_customer import CustomerChatAttachment, CustomerConversation
from app.services import customer_chat_service as chat
from app.services import document_service, storage

logger = logging.getLogger("app.chat")

#: Declared types that become an ``image`` message rather than a ``file`` one.
#: The difference is only how the client renders it — a thumbnail versus a row
#: with a paperclip — but it is decided here so both clients agree.
_INLINE_IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")

#: The database's own ceiling: ``ck_customer_chat_attachments_size`` refuses
#: anything larger. Checked here as well so an oversized file is a 413 with a
#: sentence a person can act on, rather than an IntegrityError surfacing as a
#: 500 after the bytes have already been written to storage.
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024


def _kind(content_type: str) -> str:
    return "image" if content_type in _INLINE_IMAGE_TYPES else "file"


def _strip_exif(upload: UploadFile) -> UploadFile:
    """Re-encode an uploaded photo without its metadata.

    WHY THIS IS NOT OPTIONAL POLISH
    A customer photographs their passport with a phone to send it to support.
    That JPEG carries an EXIF block, and on every phone shipped in the last
    decade that block contains the GPS coordinates where the photo was taken —
    which, for a passport photographed at home, is the customer's home address.
    Storing it means we hold a home address nobody asked for, attached to a
    passport scan, downloadable by any agent. Re-encoding is the whole fix.

    `exif_transpose` FIRST, AND THE ORDER MATTERS. Orientation is itself an EXIF
    tag: a portrait photo from a phone is usually stored landscape with a tag
    saying "rotate me". Dropping the metadata without applying that tag first
    saves a sideways passport — the strip would visibly corrupt exactly the
    images it exists to protect.

    Any failure returns the original upload untouched. A photo that Pillow
    cannot parse has already survived `document_service`'s signature sniff, and
    losing the customer's file to a re-encoding error would be a worse outcome
    than storing its metadata. The declared type is still enforced downstream.
    """
    declared = (upload.content_type or "").split(";")[0].strip().lower()
    if declared not in _INLINE_IMAGE_TYPES:
        return upload
    try:
        from PIL import Image, ImageOps   # noqa: PLC0415 - only images pay for it

        upload.file.seek(0)
        raw = upload.file.read()
        upload.file.seek(0)

        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            oriented = ImageOps.exif_transpose(image) or image
            out = io.BytesIO()
            if declared == "image/jpeg":
                # RGB because a JPEG cannot hold an alpha channel, and a PNG
                # renamed by a client would otherwise raise here rather than in
                # the sniff that is meant to catch it.
                oriented.convert("RGB").save(out, format="JPEG", quality=90, optimize=True)
            elif declared == "image/png":
                oriented.save(out, format="PNG", optimize=True)
            else:
                oriented.save(out, format="WEBP", quality=90)
        out.seek(0)
        return UploadFile(file=out, filename=upload.filename, headers=upload.headers)
    except Exception:  # noqa: BLE001 - see the docstring; never lose the file
        logger.warning("chat: could not re-encode an upload; storing it as sent")
        try:
            upload.file.seek(0)
        except Exception:  # noqa: BLE001
            pass
        return upload


def store(upload: UploadFile, *, conversation_id: int) -> document_service.StoredUpload:
    """Validate and stream one upload into storage. Raises HTTPException.

    The storage prefix scopes files by conversation — ``chat/{id}/`` — which is
    what makes a whole conversation's files removable in one operation when the
    retention question above is finally answered.
    """
    if settings.max_upload_bytes > MAX_ATTACHMENT_BYTES:
        # The global cap is larger than this table allows. Rather than let a
        # 20 MB upload succeed through document_service and then be rejected by
        # the CHECK constraint after the bytes are on disk, refuse early when
        # the client was honest about the size.
        declared = getattr(upload, "size", None)
        if declared is not None and declared > MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Attachments must be 10 MB or smaller.",
            )

    stored = document_service.store_upload(
        _strip_exif(upload), prefix=f"chat/{conversation_id}",
    )
    if stored.size_bytes > MAX_ATTACHMENT_BYTES:
        # And again once the real size is known, because the declaration above
        # is the client's word for it.
        document_service.discard_file(stored.relative_path)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Attachments must be 10 MB or smaller.",
        )
    return stored


def record(
    db: Session, message, stored: document_service.StoredUpload,
) -> CustomerChatAttachment:
    """Attach a stored file to a message, discarding the bytes if the row fails.

    Without the rollback arm, a failed insert leaves an orphan in storage that
    nothing will ever reference or delete — invisible, and made of passport
    scans.
    """
    try:
        return chat.attach(
            db, message,
            storage_key=stored.relative_path,
            file_name=stored.display_filename,
            mime_type=stored.content_type,
            file_size=stored.size_bytes,
        )
    except Exception:
        db.rollback()
        document_service.discard_file(stored.relative_path)
        raise


def message_type_for(stored: document_service.StoredUpload) -> str:
    return _kind(stored.content_type)


def download(attachment: CustomerChatAttachment) -> StreamingResponse:
    """Stream an attachment back, as a download and never as a page.

    FOUR HEADERS, EACH LOAD-BEARING:
      * ``Content-Disposition: attachment`` — the file is saved, not rendered.
        A PDF opened inline runs in this origin, and the sniff at upload time
        stops an HTML file wearing a PNG's name but does not make it safe to
        render one that genuinely is a PDF.
      * ``X-Content-Type-Options: nosniff`` — stops a browser second-guessing
        the declared type and rendering it anyway.
      * ``Content-Security-Policy: default-src 'none'`` — nothing served by this
        response may fetch anything, whatever it turns out to be.
      * ``Cache-Control: private`` — a support attachment must not be held by a
        shared proxy.

    The stored type is echoed rather than re-derived: it was sniffed against the
    bytes at upload time, which is a stronger claim than anything guessable here.
    """
    try:
        handle = storage.backend.open(attachment.storage_key)
    except storage.DocumentBytesMissing:
        logger.error(
            "chat: attachment %s has a row but no bytes (%s)",
            attachment.attachment_id, attachment.storage_key,
        )
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="This file is no longer available.",
        )
    except storage.InvalidDocumentKey:
        # A key that fails validation did not come from store_upload. That is a
        # tampered row, not a missing file, and it is worth saying so loudly.
        logger.error(
            "chat: attachment %s has an unsafe storage key", attachment.attachment_id,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    safe_name = attachment.file_name.replace('"', "")
    return StreamingResponse(
        storage.iter_chunks(handle),
        media_type=attachment.mime_type,
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}"',
            "Content-Length": str(attachment.file_size),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
            "Cache-Control": "private, max-age=300",
        },
    )


def caption(raw: Optional[str]) -> Optional[str]:
    """A caption is optional, and is an ordinary message body when present."""
    cleaned = (raw or "").strip()
    return cleaned[: chat.MAX_BODY_CHARS] or None


def guard_open(conversation: CustomerConversation) -> None:
    """Refuse an upload into a closed conversation.

    ``post_customer_message`` reopens a ``resolved`` conversation as a side
    effect of writing, which is correct and applies here too. ``closed`` is
    terminal, and accepting a file into it would store bytes nobody will ever
    be shown.
    """
    if conversation.status == "closed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This conversation is closed. Send a message to start a new one.",
        )
