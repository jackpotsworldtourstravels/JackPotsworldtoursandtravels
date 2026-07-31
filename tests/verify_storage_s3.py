"""S3 backend against the real AWS SDK.

``verify_storage.py`` fakes boto3, which proves this project's own logic but
cannot prove the project calls boto3 *correctly* — a wrong keyword, a
misremembered ``ExtraArgs`` key or an error code that botocore never actually
raises would all pass a fake and fail on the first real upload. This script
runs the same backend against ``moto``, which implements S3's wire protocol, so
every call here goes through real botocore serialisation, signing and error
handling.

    pip install "moto[s3]"

Skipped with exit 0 when moto is absent, so the suite still runs on a machine
that only has the production dependencies installed.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "backend"
sys.path.insert(0, str(BACKEND))

from config import Checker  # noqa: E402

_c = Checker()
check = _c

BUCKET = "jpw-verify-bucket"
REGION = "ap-south-1"


def main():
    try:
        import boto3
        from moto import mock_aws
    except ImportError as exc:
        print(f"SKIP: {exc}. Install with:  pip install \"moto[s3]\"")
        return 0

    import os

    # moto refuses to start if real credentials could be picked up; these are
    # the documented dummies and never leave the process.
    os.environ.update(
        AWS_ACCESS_KEY_ID="testing",
        AWS_SECRET_ACCESS_KEY="testing",
        AWS_SECURITY_TOKEN="testing",
        AWS_SESSION_TOKEN="testing",
        AWS_DEFAULT_REGION=REGION,
    )
    os.environ.setdefault("DATABASE_URL", "postgresql://unused/unused")
    os.environ.setdefault("JWT_SECRET_KEY", "test-only-not-a-secret")

    with mock_aws():
        boto3.client("s3", region_name=REGION).create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": REGION},
        )

        from app.services import storage as st

        s3 = st.S3Storage(BUCKET, prefix="documents", region=REGION, sse="AES256")
        payload = b"%PDF-1.4 pretend passport\n" + b"x" * 5000

        print("== round trip through real botocore ==")
        scratch = Path(HERE / "_s3_scratch.bin")
        scratch.write_bytes(payload)
        s3.put("requests/42/passport.pdf", scratch, content_type="application/pdf")
        scratch.unlink(missing_ok=True)

        got = b"".join(st.iter_chunks(s3.open("requests/42/passport.pdf")))
        check("the bytes survive a real upload and download", got == payload,
              f"{len(got)} vs {len(payload)}")

        # Read back with a plain client at the fully-prefixed key: if the
        # backend put it anywhere else this raises, and the check fails rather
        # than the script crashing.
        try:
            raw = boto3.client("s3", region_name=REGION).head_object(
                Bucket=BUCKET, Key="documents/requests/42/passport.pdf"
            )
            check("stored under the configured prefix", True)
        except Exception as exc:
            check("stored under the configured prefix", False, f"{type(exc).__name__}: {exc}")
            raw = {}
        check("S3 recorded the content type",
              raw.get("ContentType") == "application/pdf", str(raw.get("ContentType")))
        check("S3 recorded server-side encryption",
              raw.get("ServerSideEncryption") == "AES256",
              str(raw.get("ServerSideEncryption")))
        check("S3 recorded the full length", raw.get("ContentLength") == len(payload),
              str(raw.get("ContentLength")))

        # The assertion this whole file exists for: that the code catches the
        # error botocore really raises, not the one it was assumed to raise.
        print("\n== a missing object ==")
        try:
            s3.open("requests/42/never-uploaded.pdf")
            check("raises DocumentBytesMissing, not a raw ClientError", False, "no error")
        except st.DocumentBytesMissing:
            check("raises DocumentBytesMissing, not a raw ClientError", True)
        except Exception as exc:
            check("raises DocumentBytesMissing, not a raw ClientError", False,
                  f"got {type(exc).__name__}: {exc}")

        print("\n== delete ==")
        s3.delete("requests/42/passport.pdf")
        try:
            s3.open("requests/42/passport.pdf")
            check("the object is really gone", False, "still readable")
        except st.DocumentBytesMissing:
            check("the object is really gone", True)
        s3.delete("requests/42/passport.pdf")
        check("deleting an absent object is silent", True)

    return _c.report()


if __name__ == "__main__":
    sys.exit(main())
