"""Run the whole verification suite, in order, against a live backend.

    python tests/run_all.py

Order matters: the broad API sweep runs first because a failure there explains
most milestone failures downstream, and a milestone script is only meaningful
once the surface it builds on is known good.

Each script is a separate process. One failing script does **not** stop the run —
a partial picture of what broke is more useful than the first error, and the
exit code is non-zero if any script failed.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

#: (filename, what it covers). Add a milestone's script here when it lands.
#: ASCII only — the Windows console this is run on renders an em dash as a
#: replacement character, which makes the section headers unreadable.
SUITE = [
    # First because it needs no server: if the storage layer under the document
    # endpoints is broken, every document failure downstream is a symptom.
    ("verify_storage.py", "Storage: local and S3 backends, key validation"),
    ("verify_storage_s3.py", "Storage: the S3 backend against real boto3 (needs moto)"),
    ("verify_api.py", "Phases 1-3: enquiry, booking, documents, admin verification"),
    ("verify_m1.py", "M1: queue, assignment, references, internal notes"),
    ("verify_m1_concurrency.py", "M1: simultaneous assignment and note writes"),
    ("verify_m2.py", "M2: ticket upload, invoice/confirmation PDFs, delivery"),
    ("verify_m3.py", "M3: cancellation & reschedule, money bounds, cross-tenant, concurrency"),
]


def main() -> int:
    results = []
    for script, description in SUITE:
        path = os.path.join(HERE, script)
        if not os.path.exists(path):
            print(f"\n!! {script} is listed in SUITE but does not exist — skipping")
            results.append((script, None))
            continue

        print(f"\n{'=' * 72}\n{script}  -  {description}\n{'=' * 72}")
        # Flushed, or this header is still sitting in the parent's buffer while
        # the child writes straight to the terminal — every banner then lands
        # at the end of the run, attached to the wrong script.
        sys.stdout.flush()
        code = subprocess.call([sys.executable, path], cwd=HERE)
        results.append((script, code))

    print(f"\n{'=' * 72}\nSUITE SUMMARY\n{'=' * 72}")
    failed = 0
    for script, code in results:
        if code is None:
            label = "MISSING"
        elif code == 0:
            label = "PASS"
        else:
            label = f"FAIL (exit {code})"
            failed += 1
        print(f"  {label:<16} {script}")

    print(f"\n{len(results) - failed}/{len(results)} scripts passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
