"""Tiny stdlib HTTP helper so the verification scripts need no third-party deps."""
import json as _json
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlencode as _urlencode


class Resp:
    def __init__(self, status, headers, body):
        self.status_code = status
        self.headers = {k.lower(): v for k, v in headers}
        self.content = body

    @property
    def text(self):
        return self.content.decode("utf-8", "replace")

    def json(self):
        return _json.loads(self.content)


def _send(req):
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return Resp(r.status, r.getheaders(), r.read())
    except urllib.error.HTTPError as e:
        return Resp(e.code, list(e.headers.items()), e.read())


def request(method, url, headers=None, json=None, files=None, data=None):
    h = dict(headers or {})
    body = None
    if files is not None:
        boundary = uuid.uuid4().hex
        parts = []
        for k, v in (data or {}).items():
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n'.encode()
                + str(v).encode()
                + b"\r\n"
            )
        for field, (fname, content, ctype) in files.items():
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; '
                f'filename="{fname}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
                + content
                + b"\r\n"
            )
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        h["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif data is not None:
        # `data` with no `files` is a plain form post. Before CR-4c this branch
        # did not exist, so such a call sent **no body at all** and every field
        # came back "Field required" — a harness bug that looks exactly like an
        # endpoint bug, and cost a debugging round trip on the first form-only
        # endpoint in the suite (a top-up submitted without a screenshot).
        # Nothing relied on the old behaviour: every existing `data=` caller
        # passes `files=` alongside it.
        body = _urlencode({k: str(v) for k, v in data.items()}).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    elif json is not None:
        body = _json.dumps(json).encode()
        h["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=h, method=method)
    return _send(req)


def get(url, **kw):
    return request("GET", url, **kw)


def post(url, **kw):
    return request("POST", url, **kw)


def put(url, **kw):
    return request("PUT", url, **kw)


def patch(url, **kw):
    """PATCH — used by the notification read-marker and the admin status change.

    Missing until CR-2 needed it, which is why those endpoints had never been
    driven from the suite.
    """
    return request("PATCH", url, **kw)


def delete(url, **kw):
    return request("DELETE", url, **kw)
