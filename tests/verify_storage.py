"""Storage-backend verification — the local disk and S3 paths, side by side.

THE ODD ONE OUT IN THIS SUITE
Every other script here drives a live server over HTTP. This one imports the
backend directly and needs no server, because the thing under test is the layer
*below* the API: whether a key can escape its root, and whether the S3 backend
stores and returns the same bytes the local one does. Running it through HTTP
would only exercise whichever backend that server happens to be configured for,
and the whole point is to check both from one run.

WHY S3 IS FAKED RATHER THAN MOCKED AGAINST AWS
A real bucket would make this test cost money, need credentials, and fail on an
aeroplane. The fake implements only the three calls :class:`S3Storage` makes and
asserts on what it was *asked* to do — that the object was sent with
server-side encryption, under the configured prefix, and that a missing key
raises the botocore error shape the backend claims to catch. That last one is
the assertion with real value: it is the only place the ``NoSuchKey`` handling
is proved to match botocore's actual error contract rather than a guess at it.
"""
import io
import os
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

from config import Checker  # noqa: E402  (after sys.path surgery)

_c = Checker()
check = _c


# ---------------------------------------------------------------------------
# A boto3 that never leaves the process
# ---------------------------------------------------------------------------
class _ClientError(Exception):
    """Same shape botocore raises: an Exception carrying a response dict."""

    def __init__(self, response, operation_name):
        super().__init__(f"{operation_name} failed")
        self.response = response
        self.operation_name = operation_name


class _FakeS3Client:
    def __init__(self):
        self.objects: dict[tuple[str, str], tuple[bytes, dict]] = {}
        self.calls: list[tuple] = []

    def upload_fileobj(self, fh, bucket, key, ExtraArgs=None):
        self.calls.append(("put", bucket, key))
        self.objects[(bucket, key)] = (fh.read(), dict(ExtraArgs or {}))

    def get_object(self, Bucket, Key):
        self.calls.append(("get", Bucket, Key))
        if (Bucket, Key) not in self.objects:
            raise _ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)][0])}

    def delete_object(self, Bucket, Key):
        self.calls.append(("delete", Bucket, Key))
        self.objects.pop((Bucket, Key), None)


def _install_fake_boto3() -> _FakeS3Client:
    """Put a fake boto3/botocore in ``sys.modules`` before S3Storage imports it.

    S3Storage imports boto3 inside ``__init__`` precisely so a local deployment
    need not install it — which also means this substitution has to be in place
    before the constructor runs, not before the module is imported.
    """
    client = _FakeS3Client()
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda service, **kw: client
    sys.modules["boto3"] = boto3

    botocore = types.ModuleType("botocore")
    exceptions = types.ModuleType("botocore.exceptions")
    exceptions.ClientError = _ClientError
    botocore.exceptions = exceptions
    sys.modules["botocore"] = botocore
    sys.modules["botocore.exceptions"] = exceptions
    return client


def main():
    fake = _install_fake_boto3()

    # Importing app.config requires a database_url/jwt_secret_key; backend/.env
    # supplies them locally. Nothing here touches the database.
    os.environ.setdefault("DATABASE_URL", "postgresql://unused/unused")
    os.environ.setdefault("JWT_SECRET_KEY", "test-only-not-a-secret")
    from app.services import storage as st

    # ------------------------------------------------------------------ keys
    print("== key validation ==")
    check("a normal key survives", st.validate_key("requests/12/abcd.pdf") == "requests/12/abcd.pdf")
    check("leading slash is stripped", st.validate_key("/requests/12/a.pdf") == "requests/12/a.pdf")
    check("backslashes normalise", st.validate_key("requests\\12\\a.pdf") == "requests/12/a.pdf")

    for bad in ["../etc/passwd", "requests/../../etc/passwd", "requests\\..\\..\\x",
                "", "   ", "./x", "requests/./x", "C:/Windows/x", "requests/12/../../x"]:
        try:
            st.validate_key(bad)
            check(f"rejects {bad!r}", False, "accepted it")
        except st.InvalidDocumentKey:
            check(f"rejects {bad!r}", True)
    try:
        st.validate_key(None)
        check("rejects a non-string key", False, "accepted None")
    except st.InvalidDocumentKey:
        check("rejects a non-string key", True)

    # ----------------------------------------------------------------- local
    print("\n== local backend ==")
    import tempfile

    root = Path(tempfile.mkdtemp(prefix="jpw-storage-"))
    local = st.LocalStorage(root)
    payload = b"%PDF-1.4 pretend passport\n"

    src = root / "scratch.bin"
    src.write_bytes(payload)
    local.put("requests/7/doc.pdf", src, content_type="application/pdf")
    check("put writes the object", (root / "requests" / "7" / "doc.pdf").is_file())
    check("put consumes the scratch file (move, not copy)", not src.exists())

    fh = local.open("requests/7/doc.pdf")
    check("open returns the exact bytes", fh.read() == payload)
    fh.close()

    check("iter_chunks yields the bytes and closes the handle",
          b"".join(st.iter_chunks(local.open("requests/7/doc.pdf"))) == payload)

    try:
        local.open("requests/7/missing.pdf")
        check("opening an absent key raises DocumentBytesMissing", False, "no error")
    except st.DocumentBytesMissing:
        check("opening an absent key raises DocumentBytesMissing", True)

    try:
        local.open("../../../etc/passwd")
        check("a traversal key cannot be opened", False, "no error")
    except st.InvalidDocumentKey:
        check("a traversal key cannot be opened", True)

    local.delete("requests/7/doc.pdf")
    check("delete removes the object", not (root / "requests" / "7" / "doc.pdf").exists())
    local.delete("requests/7/doc.pdf")
    check("deleting an absent key is silent", True)

    # -------------------------------------------------------------------- s3
    print("\n== s3 backend ==")
    s3 = st.S3Storage("test-bucket", prefix="documents", region="ap-south-1", sse="AES256")

    src = root / "scratch2.bin"
    src.write_bytes(payload)
    s3.put("requests/7/doc.pdf", src, content_type="application/pdf")

    stored_key = "documents/requests/7/doc.pdf"
    check("the prefix is applied to the object key",
          ("test-bucket", stored_key) in fake.objects,
          str(list(fake.objects)))
    body, extra = fake.objects[("test-bucket", stored_key)]
    check("the exact bytes are uploaded", body == payload)
    check("server-side encryption is requested",
          extra.get("ServerSideEncryption") == "AES256", str(extra))
    check("the content type is carried", extra.get("ContentType") == "application/pdf", str(extra))
    check("put does not consume the scratch file", src.exists())

    check("open returns the exact bytes",
          b"".join(st.iter_chunks(s3.open("requests/7/doc.pdf"))) == payload)

    try:
        s3.open("requests/7/missing.pdf")
        check("a missing object raises DocumentBytesMissing", False, "no error")
    except st.DocumentBytesMissing:
        check("a missing object raises DocumentBytesMissing", True)

    try:
        s3.open("../../secrets")
        check("a traversal key never reaches S3", False, "no error")
    except st.InvalidDocumentKey:
        check("a traversal key never reaches S3", True)

    s3.delete("requests/7/doc.pdf")
    check("delete removes the object", ("test-bucket", stored_key) not in fake.objects)

    # A bucket-less s3 config must fail loudly rather than at first upload.
    print("\n== configuration guards ==")
    st.settings.storage_backend, st.settings.s3_bucket = "s3", None
    try:
        st._build()
        check("STORAGE_BACKEND=s3 without a bucket is refused", False, "built anyway")
    except RuntimeError:
        check("STORAGE_BACKEND=s3 without a bucket is refused", True)

    st.settings.storage_backend = "nonsense"
    try:
        st._build()
        check("an unknown backend name is refused", False, "built anyway")
    except RuntimeError:
        check("an unknown backend name is refused", True)

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
