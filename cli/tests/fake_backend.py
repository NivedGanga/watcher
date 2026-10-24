"""In-process fake AgentWatch backend for tests (http.server, no real net).

Implements: POST /api/device/start, /api/device/token, /api/events,
/api/signals, /api/heartbeat, /api/machines/current/test,
DELETE /api/machines/current. Behavior is scripted via attributes on
FakeBackend.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeBackend:
    def __init__(self):
        # device-flow scripting
        self.token_responses: list = []  # queue of ("error"|"success", code)
        self.device_start_error: tuple | None = None
        self.started_clients: list = []
        # request capture
        self.events_received: list = []
        self.signals_received: list = []
        self.heartbeats_received: list = []
        self.test_emails: int = 0
        self.token_polls: int = 0
        self.deleted_machines: int = 0
        self.delete_status: int = 204
        # per-endpoint forced status: path -> (status, payload)
        self.forced: dict = {}
        # result overrides for events/signals: id -> status
        self.event_results: dict = {}
        self.protocol_header_seen: list = []
        self.auth_headers_seen: list = []

        self._server = ThreadingHTTPServer(
            ("127.0.0.1", 0), self._make_handler()
        )
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True
        )
        self._thread.start()
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"

    def close(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def _make_handler(self):
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self) -> dict:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    return json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    return {}

            def _send(self, status: int, payload: dict | None = None):
                data = (
                    json.dumps(payload).encode("utf-8")
                    if payload is not None
                    else b""
                )
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if data:
                    self.wfile.write(data)

            def _send_error(self, status: int, code: str, message: str = ""):
                self._send(status, {"error": {"code": code, "message": message}})

            def _check_protocol(self) -> bool:
                backend.protocol_header_seen.append(
                    self.headers.get("X-AgentWatch-Protocol")
                )
                if self.headers.get("X-AgentWatch-Protocol") != "1":
                    self._send_error(426, "upgrade_required", "Unsupported")
                    return False
                return True

            def _forced(self, path: str) -> bool:
                forced = backend.forced.get(path)
                if forced is None:
                    return False
                status, payload = forced
                if status == 429:
                    self.send_response(429)
                    self.send_header("Retry-After", str(payload or 30))
                    self.send_header("Content-Type", "application/json")
                    body = json.dumps(
                        {"error": {"code": "rate_limited", "message": "slow"}}
                    ).encode()
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return True
                if status >= 400:
                    code = {401: "unauthorized", 426: "upgrade_required"}.get(
                        status, "server_error"
                    )
                    self._send_error(status, code)
                    return True
                self._send(status, payload)
                return True

            def _check_auth(self) -> bool:
                auth = self.headers.get("Authorization") or ""
                backend.auth_headers_seen.append(auth)
                if not auth.startswith("Bearer aw_"):
                    self._send_error(401, "unauthorized", "bad key")
                    return False
                return True

            def do_POST(self):
                if not self._check_protocol():
                    return
                path = self.path
                if self._forced(path):
                    return
                body = self._body()

                if path == "/api/device/start":
                    if backend.device_start_error:
                        status, code = backend.device_start_error
                        self._send_error(status, code)
                        return
                    backend.started_clients.append(body)
                    self._send(
                        200,
                        {
                            "device_code": "dev-code-123",
                            "user_code": "XKCD-9W2P",
                            "verification_uri": "https://example.com/connect",
                            "verification_uri_complete": "https://example.com/connect?user_code=XKCD-9W2P",
                            "expires_in": 600,
                            "interval": 5,
                        },
                    )
                    return

                if path == "/api/device/token":
                    backend.token_polls += 1
                    if backend.token_responses:
                        kind, code = backend.token_responses.pop(0)
                        if kind == "error":
                            # RFC 8628 shape: {"error": "<code>"}
                            self._send(400, {"error": code})
                            return
                    self._send(
                        200,
                        {
                            "machine_id": "m_test123",
                            "key": "aw_m_test123_secretkey",
                        },
                    )
                    return

                if not self._check_auth():
                    return

                if path == "/api/events":
                    events = body.get("events", [])
                    backend.events_received.extend(events)
                    results = [
                        {
                            "id": e["id"],
                            "status": backend.event_results.get(
                                e["id"], "accepted"
                            ),
                        }
                        for e in events
                    ]
                    for res in results:
                        if res["status"] == "rejected":
                            res["reason"] = "summary exceeds 200 chars"
                    self._send(202, {"results": results})
                    return

                if path == "/api/signals":
                    signals = body.get("signals", [])
                    backend.signals_received.extend(signals)
                    self._send(
                        202,
                        {
                            "results": [
                                {"id": s["id"], "status": "accepted"}
                                for s in signals
                            ]
                        },
                    )
                    return

                if path == "/api/heartbeat":
                    backend.heartbeats_received.append(body)
                    self._send(204)
                    return

                if path == "/api/machines/current/test":
                    backend.test_emails += 1
                    self._send(202, {"sent": True})
                    return

                self._send_error(404, "not_found", path)

            def do_DELETE(self):
                if not self._check_protocol():
                    return
                if not self._check_auth():
                    return
                if self.path == "/api/machines/current":
                    backend.deleted_machines += 1
                    self._send(backend.delete_status)
                    return
                self._send_error(404, "not_found", self.path)

        return Handler
