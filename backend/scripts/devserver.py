"""Start the API on whatever port the dev harness assigned.

WHY THIS EXISTS RATHER THAN ``--port`` IN launch.json
-----------------------------------------------------
The ``backend`` entry used to hardcode ``--port 8000``. Two chats open on this
repo at once then fought over that one port, and the second one simply failed
to start.

The harness solves that with ``autoPort``: it picks a free port and publishes it
to the child process as the ``PORT`` environment variable. Removing ``--port``
alone is NOT enough, though — uvicorn's CLI reads its options from ``UVICORN_*``
(``@click.command(context_settings={"auto_envvar_prefix": "UVICORN"})`` in
``uvicorn/main.py``), so with no flag and no ``UVICORN_PORT`` it falls back to
its own default of 8000 and collides all over again. Nothing bridges ``PORT`` to
``UVICORN_PORT``, so this script is that bridge.

ANY PORT IS SAFE HERE, and that is not an assumption — it is what the
``backend-alt`` entry in launch.json has documented since commit 3bcd3f6: the
frontend calls ``/api`` on whatever origin served it, and ``app.main`` mounts
``frontend/`` at ``/``, so the pages and the API are same-origin on any port.
There are no OAuth callbacks, webhooks or CORS rules pinned to 8000.

Run it by hand and it behaves like the old entry — ``PORT`` unset means 8000.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

#: The repo root: backend/scripts/devserver.py -> scripts -> backend -> root.
ROOT = Path(__file__).resolve().parents[2]

#: ``--app-dir backend`` is what the launch entry used to pass. Doing it here
#: keeps ``app.main`` importable however the script is invoked, rather than
#: depending on the working directory the harness happens to start us in.
sys.path.insert(0, str(ROOT / "backend"))

import uvicorn  # noqa: E402  (after the path insert, on purpose)


def port() -> int:
    """The assigned port, or 8000 when nothing assigned one.

    ``UVICORN_PORT`` is honoured too so that setting the variable uvicorn's own
    CLI documents still works, but ``PORT`` wins: it is the one the harness
    actually sets, and the whole point of this file is to respect it.
    """
    for name in ("PORT", "UVICORN_PORT"):
        raw = os.environ.get(name)
        if raw and raw.strip().isdigit():
            return int(raw)
    return 8000


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=port())
