"""In-process fake of the AgentWatch API for the conformance harness.

Implements the machine endpoints of spec/api.md that a client can hit:
``POST /api/events``, ``POST /api/signals``, ``POST /api/heartbeat`` —
with the protocol-header check, machine-key auth, and per-item result
objects. Everything is recorded in memory for comparison.

Two transports, both staying off the real network:

- ``urllib_opener()`` — an ``urllib.request`` opener whose handler routes
  requests straight to :meth:`handle`. The request goes through real
  urllib machinery (headers, JSON body, status handling) but never opens
  a socket. Used by path C.
- ``serve()`` — an ``http.server`` bound to 127.0.0.1. Only needed when a
  real CLI process must reach the backend over loopback; not used by the
  harness's in-process paths.

Standard library only.
"""

from __future__ import annotations

import http.client
import io
import json
import re
import threading
import urllib.request
import urllib.response
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EVENT_FIELDS = {
    "id",
    "agent",
    "run_id",
    "host",
    "type",
    "blocking",
    "summary",
    "exit_code",
    "duration_s",
    "email_allowed",
    "timestamp",
}
EVENT_TYPES = {"question", "done", "failed", "timed_out", "stalled"}
SIGNAL_KINDS = {"output_seen", "input_resumed"}

_UUID4 = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
_RFC3339Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def _err(status: int, code: str, message: str):
    return status, {"Content-Type": "application/json"}, json.dumps(
        {"error": {"code": code, "message": message}}
    ).encode()


def validate_event(ev) -> str | None:
    """Minimal spec/schemas/event.schema.json check. Returns a reason or None."""
    if not isinstance(ev, dict):
        return "event must be an object"
    missing = EVENT_FIELDS - ev.keys()
    if missing:
        return f"missing fields: {sorted(missing)}"
    unknown = ev.keys() - EVENT_FIELDS
    if unknown:
        return f"unknown fields: {sorted(unknown)}"
    if not isinstance(ev["id"], str) or not _UUID4.match(ev["id"]):
        return "id must be a UUID v4"
    for field, limit in (("agent", 64), ("run_id", 64), ("host", 128)):
        if not isinstance(ev[field], str) or not (1 <= len(ev[field]) <= limit):
            return f"{field} must be a string of 1-{limit} chars"
    if ev["type"] not in EVENT_TYPES:
        return "unknown event type"
    if not isinstance(ev["blocking"], bool):
        return "blocking must be a boolean"
    summary = ev["summary"]
    if (
        not isinstance(summary, str)
        or len(summary) > 200
        or "\n" in summary
        or "\r" in summary
    ):
        return "summary must be one line of at most 200 chars"
    if ev["exit_code"] is not None and not isinstance(ev["exit_code"], int):
        return "exit_code must be an integer or null"
    if ev["duration_s"] is not None and (
        not isinstance(ev["duration_s"], (int, float)) or ev["duration_s"] < 0
    ):
        return "duration_s must be a non-negative number or null"
    if not isinstance(ev["email_allowed"], bool):
        return "email_allowed must be a boolean"
    if not isinstance(ev["timestamp"], str) or not _RFC3339Z.match(ev["timestamp"]):
        return "timestamp must be RFC 3339 UTC ending in Z"
    return None


def validate_signal(sig) -> str | None:
    if not isinstance(sig, dict):
        return "signal must be an object"
    allowed = {"id", "kind", "run_id", "at", "idle_seconds"}
    if allowed - sig.keys():
        return f"missing fields: {sorted(allowed - sig.keys())}"
    if sig.keys() - allowed:
        return f"unknown fields: {sorted(sig.keys() - allowed)}"
    if sig["kind"] not in SIGNAL_KINDS:
        return "unknown signal kind"
    if not _UUID4.match(str(sig["id"])):
        return "id must be a UUID v4"
    if not _RFC3339Z.match(str(sig["at"])):
        return "at must be RFC 3339 UTC ending in Z"
    return None


class FakeBackend:
    """Records accepted events/signals/heartbeats; answers like the API."""

    def __init__(self, machine_key: str = "aw_m_conformance_test"):
        self.machine_key = machine_key
        self.events: list[dict] = []
        self.signals: list[dict] = []
        self.heartbeats: list[dict] = []
        self.rejects: list[dict] = []
        self._seen_ids: set[str] = set()
        self._seen_triples: set[tuple] = set()

    # -- routing -------------------------------------------------------
    def handle(self, method: str, path: str, headers: dict, body: bytes):
        """(status, response_headers, response_body) for one request."""
        headers = {k.lower(): v for k, v in headers.items()}
        if headers.get("x-agentwatch-protocol") != "1":
            return _err(426, "upgrade_required", "Unsupported protocol version")
        auth = headers.get("authorization", "")
        if auth != f"Bearer {self.machine_key}":
            return _err(401, "unauthorized", "Missing or invalid machine key")
        if method != "POST":
            return _err(404, "not_found", "not found")
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return _err(400, "validation_failed", "body is not JSON")

        if path == "/api/events":
            return self._items(payload, "events", validate_event, self.events)
        if path == "/api/signals":
            return self._items(payload, "signals", validate_signal, self.signals)
        if path == "/api/heartbeat":
            return self._heartbeat(payload)
        return _err(404, "not_found", "not found")

    def _items(self, payload, key, validator, sink):
        items = payload.get(key)
        if (
            not isinstance(payload, dict)
            or not isinstance(items, list)
            or not (1 <= len(items) <= 50)
        ):
            return _err(400, "validation_failed", f"{key} must be a list of 1-50")
        results = []
        for item in items:
            reason = validator(item)
            if reason:
                results.append({"id": item.get("id"), "status": "rejected", "reason": reason})
                self.rejects.append(item)
                continue
            if item["id"] in self._seen_ids or (
                item.get("run_id"), item.get("type") or item.get("kind"),
                item.get("summary"),
            ) in self._seen_triples:
                results.append({"id": item["id"], "status": "duplicate"})
                continue
            self._seen_ids.add(item["id"])
            self._seen_triples.add(
                (item.get("run_id"), item.get("type") or item.get("kind"),
                 item.get("summary"))
            )
            sink.append(item)
            results.append({"id": item["id"], "status": "accepted"})
        return (
            202,
            {"Content-Type": "application/json"},
            json.dumps({"results": results}).encode(),
        )

    def _heartbeat(self, payload):
        if (
            not isinstance(payload, dict)
            or set(payload) != {"sent_at", "active_runs"}
            or not _RFC3339Z.match(str(payload.get("sent_at", "")))
            or not isinstance(payload.get("active_runs"), int)
            or payload["active_runs"] < 0
        ):
            return _err(400, "validation_failed", "bad heartbeat")
        self.heartbeats.append(payload)
        return 204, {}, b""

    # -- urllib transport (no sockets) -----------------------------------
    def handle_urllib(self, req: urllib.request.Request):
        headers = {k: v for k, v in req.header_items()}
        headers.setdefault("Host", req.host)
        status, resp_headers, resp_body = self.handle(
            req.get_method(), urllib.request.urlparse(req.full_url).path,
            headers, req.data or b"",
        )
        msg = http.client.HTTPMessage()
        for k, v in resp_headers.items():
            msg.add_header(k, v)
        resp = urllib.response.addinfourl(
            io.BytesIO(resp_body), msg, req.full_url, code=status
        )
        resp.msg = http.client.responses.get(status, "")
        return resp

    def urllib_opener(self):
        """An opener that answers urllib requests in-process."""
        backend = self

        class LocalTransport(urllib.request.HTTPHandler):
            def http_open(self, req):
                return backend.handle_urllib(req)

        return urllib.request.build_opener(LocalTransport())

    # -- optional loopback server (for a real CLI process) ---------------
    def serve(self, port: int = 0):
        """Start an http.server on 127.0.0.1. Returns (httpd, port)."""
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                status, headers, resp = backend.handle(
                    "POST", self.path, dict(self.headers.items()), body
                )
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)

            def log_message(self, *_args):
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return httpd, httpd.server_address[1]
