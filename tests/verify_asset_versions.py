"""Asset cache tags: every ?v= in the customer HTML must match its file.

The server caches any asset URL with a query string for a year, so a tag that
does not change when its file does leaves browsers on the old script for as long
as they keep it (a Flights tab left open since 1 Oct ran an old booking-flow.js
after it had been fixed). Needs no server.

    python tests/verify_asset_versions.py

Fix a failure with:  python scripts/stamp_asset_versions.py
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "scripts", "stamp_asset_versions.py")

r = subprocess.run([sys.executable, TOOL, "--check"], capture_output=True, text=True)
sys.stdout.write(r.stdout)
sys.stderr.write(r.stderr)
print("PASS: every asset tag matches its file" if r.returncode == 0
      else "FAIL: stale asset tags (run scripts/stamp_asset_versions.py)")
sys.exit(r.returncode)
