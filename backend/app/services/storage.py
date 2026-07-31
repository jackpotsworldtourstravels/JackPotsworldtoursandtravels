"""Where document bytes physically live.

``document_service`` owns *who may touch a file and whether the bytes are
acceptable*; this module owns *where those bytes are put*. The split exists so
that moving from a server disk to S3 is a deployment setting rather than a
rewrite of the security-critical code — none of the sniffing, size-capping,
checksumming or merchant-scoping logic appears here.

TWO BACKENDS, ONE CONTRACT
``local``  — a directory on the machine (the default, and what development
             and the Docker image use).
``s3``     — an S3 bucket, for deployments where the server is disposable.
             On EC2 the instance is rebuilt or replaced routinely; anything
             written to its disk goes with it, and these files are passport and
             visa scans that must outlive any one server.

KEYS ARE NOT PATHS
A key looks like ``requests/<request_id>/<uuid4><ext>`` and is always generated
by :mod:`document_service`, never by a client. The database still stores it as
``stored_path``, so a tampered row is the one way a hostile key could arrive
here — :func:`validate_key` is the chokepoint that refuses it, and it runs on
every read, write and delete in both backends. The local backend additionally
re-checks containment after resolution, because symlinks can defeat a
string-level check that S3, having no filesystem, is immune to.
"""
from __future__ import annotations

import shutil
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterator, Protocol

from app.config import settings

#: Read size for streaming a stored file back out.
_CHUNK = 64 * 1024


class InvalidDocumentKey(ValueError):
    """A stored path that does not look like something this module wrote."""


class DocumentBytesMissing(FileNotFoundError):
    """The row exists but its bytes do not — a restore gap, or a failed write."""


def validate_key(key: str) -> str:
    """Reduce a stored path to a safe relative key, or refuse it.

    Refusing rather than sanitising: a key that needed cleaning did not come
    from :func:`document_service.upload`, and the only interesting question
    about it is why it is in the database at all.
    """
    if not key or not isinstance(key, str):
        raise InvalidDocumentKey("empty document key")
    # Windows separators first — the local backend runs on both, and "a\\..\\b"
    # must not slip past a check that only understands "/".
    normalised = key.replace("\\", "/").strip("/")
    if not normalised.strip():
        raise InvalidDocumentKey(f"blank document key: {key!r}")

    parts = PurePosixPath(normalised).parts
    if not parts or any(p == ".." for p in parts):
        raise InvalidDocumentKey(f"unsafe document key: {key!r}")
    # A drive letter or UNC prefix survives PurePosixPath on Windows only as a
    # literal segment; ":" cannot appear in anything we generate.
    if any(":" in p for p in parts):
        raise InvalidDocumentKey(f"unsafe document key: {key!r}")
    # A segment of pure whitespace is a real filename on Linux and an
    # unwriteable one on Windows. Nothing we generate contains one.
    if any(not p.strip() for p in parts):
        raise InvalidDocumentKey(f"unsafe document key: {key!r}")

    rebuilt = "/".join(parts)
    if rebuilt != normalised:
        # The key changed under normalisation — "./x", "a//b" and friends.
        # PurePosixPath drops a "." segment silently, so checking for one
        # directly never fires; comparing before and after is what catches it.
        # Refused rather than accepted-as-cleaned, because a key that needed
        # cleaning did not come from upload() and the interesting question is
        # how it got into the database.
        raise InvalidDocumentKey(f"non-canonical document key: {key!r}")
    return rebuilt


def iter_chunks(fh: BinaryIO) -> Iterator[bytes]:
    """Stream a handle out and close it, whatever happens.

    The generator owns the handle: a client that disconnects mid-download
    causes the consuming loop to be closed, and the ``finally`` still runs. Left
    to the caller this leaks a file descriptor per abandoned download, or an
    open HTTPS connection per abandoned S3 read.
    """
    try:
        while chunk := fh.read(_CHUNK):
            yield chunk
    finally:
        fh.close()


class Storage(Protocol):
    """The whole surface a storage backend has to provide."""

    def put(self, key: str, source: Path, *, content_type: str) -> None:
        """Store the complete file at ``source`` under ``key``."""

    def open(self, key: str) -> BinaryIO:
        """Open the stored bytes, raising :class:`DocumentBytesMissing`."""

    def delete(self, key: str) -> None:
        """Remove the stored bytes; succeed silently if already gone."""


class LocalStorage:
    """Files on the machine's own disk, under ``settings.upload_root``."""

    def __init__(self, root: Path):
        self._root = root

    def _absolute(self, key: str) -> Path:
        candidate = (self._root / validate_key(key)).resolve()
        # Belt and braces: the key was already checked, but ``resolve`` follows
        # symlinks, and a link planted inside the upload root is the one way a
        # clean-looking key can still land outside it.
        if not candidate.is_relative_to(self._root.resolve()):
            raise InvalidDocumentKey(f"document key escapes the upload root: {key!r}")
        return candidate

    def put(self, key: str, source: Path, *, content_type: str) -> None:
        target = self._absolute(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        # move, not copy: the caller's temp file is on the same filesystem in
        # the normal case, making this a rename — no second pass over the bytes
        # and no window where a half-copied file is visible under its final key.
        shutil.move(str(source), str(target))

    def open(self, key: str) -> BinaryIO:
        path = self._absolute(key)
        try:
            return path.open("rb")
        except (FileNotFoundError, IsADirectoryError, PermissionError) as exc:
            raise DocumentBytesMissing(str(path)) from exc

    def delete(self, key: str) -> None:
        self._absolute(key).unlink(missing_ok=True)


class S3Storage:
    """Objects in a private S3 bucket.

    The bucket must not be public: nothing here generates a presigned URL, and
    downloads are proxied through the authenticated endpoint exactly as they are
    for the local backend. That is deliberate — a presigned URL is a bearer
    token for a passport scan that keeps working after the merchant's session
    ends, and this product has no requirement that justifies one.
    """

    def __init__(
        self,
        bucket: str,
        *,
        prefix: str = "",
        region: str | None = None,
        endpoint_url: str | None = None,
        sse: str | None = "AES256",
    ):
        # Imported here rather than at module scope so that a local-backend
        # deployment neither needs boto3 installed nor pays for importing it.
        import boto3

        self._bucket = bucket
        self._prefix = prefix.strip("/")
        self._sse = sse
        self._client = boto3.client(
            "s3", region_name=region, endpoint_url=endpoint_url
        )
        # Cached so that ``except`` clauses below name real classes; botocore
        # builds its error hierarchy per-client.
        self._ClientError = __import__("botocore.exceptions", fromlist=["ClientError"]).ClientError

    def _object_key(self, key: str) -> str:
        safe = validate_key(key)
        return f"{self._prefix}/{safe}" if self._prefix else safe

    def put(self, key: str, source: Path, *, content_type: str) -> None:
        extra = {"ContentType": content_type}
        if self._sse:
            extra["ServerSideEncryption"] = self._sse
        with source.open("rb") as fh:
            # upload_fileobj is multipart above ~8MB, so a 10MB scan does not
            # have to be held in memory or sent as one request.
            self._client.upload_fileobj(
                fh, self._bucket, self._object_key(key), ExtraArgs=extra
            )

    def open(self, key: str) -> BinaryIO:
        try:
            response = self._client.get_object(
                Bucket=self._bucket, Key=self._object_key(key)
            )
        except self._ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("NoSuchKey", "404", "NotFound"):
                raise DocumentBytesMissing(key) from exc
            raise
        return response["Body"]

    def delete(self, key: str) -> None:
        # S3 delete is idempotent: removing an absent key is a success, which is
        # the behaviour the caller wants after a row has already gone.
        self._client.delete_object(Bucket=self._bucket, Key=self._object_key(key))


def _build() -> Storage:
    backend = (settings.storage_backend or "local").strip().lower()
    if backend == "local":
        return LocalStorage(settings.upload_root_path)
    if backend == "s3":
        if not settings.s3_bucket:
            # Fail at import, not on the first upload: a misconfigured bucket
            # should stop a deploy, not surface as a 500 the first time a
            # merchant tries to attach a passport.
            raise RuntimeError(
                "STORAGE_BACKEND=s3 requires S3_BUCKET to be set."
            )
        return S3Storage(
            settings.s3_bucket,
            prefix=settings.s3_prefix,
            region=settings.s3_region,
            endpoint_url=settings.s3_endpoint_url,
            sse=settings.s3_sse or None,
        )
    raise RuntimeError(
        f"Unknown STORAGE_BACKEND {backend!r}. Use 'local' or 's3'."
    )


#: The backend this process uses. Chosen once at import.
backend: Storage = _build()
