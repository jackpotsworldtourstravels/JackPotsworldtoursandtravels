"""Make qa/scripts importable for the sanitizer unit tests.

These are plain, offline unit tests (no browser, no server, no DB). Run them with
the project's normal test runner:

    python -m pytest qa/tests
"""
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
