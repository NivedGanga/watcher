"""Minimal JSON-over-HTTPS client built on urllib (stdlib only).

Every request carries ``X-AgentWatch-Protocol: 1``.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from . import PROTOCOL_VERSION, __version__

USER_AGENT = f"agentwatch/{__version__}"
DEFAULT_TIMEOUT = 30


class NetworkError(Exception):
    """DNS/TCP/TLS/timeout failure — always retryable."""


class ApiError(Exception):
    """Non-2xx response. ``code`` is the server's error code when known."""

    def __init__(
        self,
        status: int,
        code: str | None = None,
        message: str = "",
        retry_after: float | None = None,
    ):
        super().__init__(f"HTTP {status} {code or ''} {message}".strip())
        self.status = status
        self.code = code or f"http_{status}"
        self.message = message
        self.retry_after = retry_after


def _error_payload(raw: bytes) -> tuple[str | None, str]:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None, ""
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        return err.get("code"), str(err.get("message", ""))
    if isinstance(err, str):  # RFC 8628 device-flow shape
        return err, ""
    return None, ""


def api_request(
    base_url: str,
    method: str,
    path: str,
    body: dict | None = None,
    key: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> tuple[int, dict | None, dict]:
    """Perform a request; returns (status, parsed_json_or_None, headers)."""
    url = base_url.rstrip("/") + path
    headers = {
        "X-AgentWatch-Protocol": PROTOCOL_VERSION,
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if key:
        headers["Authorization"] = f"Bearer {key}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
            resp_headers = dict(resp.headers.items())
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        code, message = _error_payload(raw)
        retry_after = None
        ra = exc.headers.get("Retry-After") if exc.headers else None
        if ra:
            try:
                retry_after = float(ra)
            except ValueError:
                retry_after = None
        raise ApiError(exc.code, code, message, retry_after) from None
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise NetworkError(str(exc)) from exc

    parsed = None
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            parsed = None
    return status, parsed, resp_headers
