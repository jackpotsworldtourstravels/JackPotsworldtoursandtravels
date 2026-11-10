"""A deliberately tiny reverse proxy for HDFC UAT testing through a public tunnel.

    public tunnel -> THIS (127.0.0.1:8098) -> the app (127.0.0.1:8099)

ONLY the two HDFC callback routes get through:

    POST      /api/webhooks/payments/hdfc
    GET, POST /api/payments/hdfc/return

Everything else -- admin, docs, openapi, static pages, every other API, any other
method, provider or query string -- is answered 404 HERE and never reaches the app.
That is the point: a tunnel to the whole app would expose the admin routes to the
internet, and HDFC needs nothing but these two.

What it preserves: the method, the path, the query string (return route only), the
request headers (``Authorization`` is what authenticates a webhook) and the body.
What it never does: follow a redirect (the return route's 303 goes to the browser
untouched), log a header or a body (only ``METHOD /path -> status``), or accept a
body over 256 KB.

Usage (from backend/):

    python scripts/uat_callback_proxy.py [--listen 127.0.0.1:8098] [--upstream 127.0.0.1:8099]

Then point the tunnel at the listen address, e.g. ``cloudflared tunnel --url
http://127.0.0.1:8098``. Stop the tunnel and this proxy when the test is over.
"""
from __future__ import annotations

import argparse
import http.client
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BODY = 256 * 1024

#: (method, path) pairs that may pass. Nothing else does.
ALLOWED = frozenset({
    ("POST", "/api/webhooks/payments/hdfc"),
    ("GET", "/api/payments/hdfc/return"),
    ("POST", "/api/payments/hdfc/return"),
})
#: Only the return route legitimately carries a query string (HDFC's order_id,
#: status, signature). The webhook route never does.
QUERY_ALLOWED = frozenset({"/api/payments/hdfc/return"})

_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
        "trailers", "transfer-encoding", "upgrade", "host", "content-length"}


def make_handler(upstream: tuple[str, int], log=sys.stderr):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "uat-callback-proxy"

        def log_message(self, fmt, *args):          # method + path only; never headers or bodies
            if log:
                log.write("%s %s -> %s\n" % (self.command, urlsplit(self.path).path,
                                             args[1] if len(args) > 1 else ""))

        def _plain(self, status: int, body: bytes = b""):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)

        def _deny(self):
            self._plain(404, b'{"detail":"Not Found"}')

        def _handle(self):
            parts = urlsplit(self.path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._plain(400)
            if length > MAX_BODY:
                return self._plain(413)
            # READ THE BODY BEFORE ANSWERING, even to refuse. Answering and closing with
            # the request body unread makes the client's connection reset (seen on
            # Windows) instead of delivering the 404. It is capped above, so this
            # cannot be used to make the proxy buffer anything large.
            body = self.rfile.read(length) if length else None
            if (self.command, parts.path) not in ALLOWED:
                return self._deny()
            if parts.query and parts.path not in QUERY_ALLOWED:
                return self._deny()
            headers = {k: v for k, v in self.headers.items() if k.lower() not in _HOP}
            try:
                conn = http.client.HTTPConnection(*upstream, timeout=30)
                conn.request(self.command, self.path, body=body, headers=headers)
                resp = conn.getresponse()
                data = resp.read()
            except Exception:                         # noqa: BLE001
                return self._plain(502)
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in _HOP:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _handle

    return Handler


def make_server(listen: tuple[str, int], upstream: tuple[str, int], log=sys.stderr) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(listen, make_handler(upstream, log))


def _addr(value: str) -> tuple[str, int]:
    host, _, port = value.rpartition(":")
    return host or "127.0.0.1", int(port)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--listen", default="127.0.0.1:8098")
    ap.add_argument("--upstream", default="127.0.0.1:8099")
    args = ap.parse_args()
    listen, upstream = _addr(args.listen), _addr(args.upstream)
    if listen[0] not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Refusing to listen on a non-loopback address: only the tunnel should reach this.")
    make_server(listen, upstream).serve_forever()


if __name__ == "__main__":
    main()
