"""Mobile questions: durable creation, polling, and JSON results for the model."""

from __future__ import annotations

import json
import os
import signal
import sys
import time
import uuid
from datetime import datetime

from . import machinekey
from .commands import _run_identity
from .config import parse_duration
from .httpclient import ApiError, NetworkError, api_request

POLL_SECONDS = 3.0
EXIT_CODES = {"answered": 0, "failed": 1, "expired": 3, "cancelled": 4}


def _result(question_id, status, *, answer=None, error=None):
    result = {"question_id": question_id, "status": status, "answer": answer}
    if error:
        result["error"] = error
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return EXIT_CODES[status]


def ask(prompt, options, allow_text, timeout, store, config, redactor):
    question_id = str(uuid.uuid4())
    if config.privacy_mode == "metadata":
        print("Mobile questions need prompt and option text. Switch to full privacy mode explicitly to use them.", file=sys.stderr)
        return _result(question_id, "failed", error="metadata_privacy")
    try:
        timeout_s = parse_duration(timeout)
        if not timeout_s.is_integer() or not 1 <= timeout_s <= 86400:
            raise ValueError("timeout must be an integer from 1s to 24h")
        prompt = redactor.redact(prompt)
        options = [redactor.redact(o) for o in options]
        if not prompt.strip() or len(prompt) > 4000:
            raise ValueError("prompt must be 1-4000 characters")
        if len(options) > 8 or any(not o.strip() or len(o) > 200 for o in options):
            raise ValueError("use at most 8 options, each 1-200 characters")
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return _result(question_id, "failed", error="validation_failed")
    problem = machinekey.permission_error()
    if problem:
        print(problem, file=sys.stderr)
        return _result(question_id, "failed", error="unauthorized")
    agent, run_id = _run_identity(config)
    request = {
        "id": question_id, "agent": redactor.redact(agent)[:64] or "agent",
        "run_id": run_id[:64], "host": redactor.redact(config.host_name)[:128] or "host",
        "prompt": prompt, "options": [{"id": str(i + 1), "label": o} for i, o in enumerate(options)],
        "allow_text": allow_text or not options, "timeout_s": int(timeout_s),
    }
    store.save_question(request, config.machine_id or "", time.time())
    print(f"Question {question_id}; recover with: snitch wait {question_id}", file=sys.stderr, flush=True)
    return wait(question_id, store, config)


def wait(question_id, store, config, *, now=time.time, sleep=time.sleep, request=api_request):
    if config.privacy_mode == "metadata":
        print("Mobile answering requires full privacy mode. The question remains unresolved.", file=sys.stderr)
        return _result(question_id, "failed", error="metadata_privacy")
    try:
        if str(uuid.UUID(question_id, version=4)) != question_id.lower():
            raise ValueError()
    except ValueError:
        return _result(question_id, "failed", error="invalid_question_id")
    problem = machinekey.permission_error()
    if problem:
        print(problem, file=sys.stderr)
        return _result(question_id, "failed", error="unauthorized")
    row = store.get_question(question_id)
    if not row or row["machine_id"] != (config.machine_id or ""):
        return _result(question_id, "failed", error="unknown_local_question")
    if not store.set_question_waiter(question_id, os.getpid()):
        return _result(question_id, "failed", error="already_waiting")
    payload = json.loads(row["request"])
    path = f"/api/questions/{question_id}"
    deadline = row["expires_at"]
    accepted = bool(row["accepted"])
    interrupted = False
    old_handlers = {}

    def stop(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    # A shell-tool timeout may terminate the waiter. Preserve the question so
    # the harness can resume with `wait`; termination is not user cancellation.
    for sig in (signal.SIGINT, signal.SIGTERM):
        old_handlers[sig] = signal.signal(sig, stop)

    def call(method, endpoint, body=None):
        return request(config.backend_url, method, endpoint, body,
                       key=machinekey.read_key(), timeout=10)[1]

    try:
        backoff = POLL_SECONDS
        while not interrupted:
            try:
                if not accepted and now() < deadline:
                    data = call("POST", "/api/questions", payload)
                else:
                    data = call("GET", path)
                if not isinstance(data, dict) or data.get("question_id") != question_id or data.get("status") not in (
                    "pending", "answered", "expired", "cancelled"
                ):
                    raise NetworkError("invalid question response")
                deadline = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00")).timestamp()
                accepted = True
                store.update_question(question_id, data["status"], deadline)
                backoff = POLL_SECONDS
                if data["status"] == "answered":
                    answer = data.get("answer")
                    if not isinstance(answer, dict) or not (
                        (set(answer) == {"text"} and isinstance(answer["text"], str)) or
                        (set(answer) == {"option_id", "label"} and all(isinstance(v, str) for v in answer.values()))
                    ):
                        raise NetworkError("invalid answer response")
                    try:
                        call("POST", path + "/received", {})
                    except (ApiError, NetworkError):
                        print("Answer retrieved; acknowledgement failed. The answer remains available.", file=sys.stderr)
                    return _result(question_id, "answered", answer=answer)
                if data["status"] in ("expired", "cancelled"):
                    return _result(question_id, data["status"])
            except (NetworkError, ApiError) as exc:
                if isinstance(exc, ApiError) and exc.status < 500 and exc.status not in (408, 429):
                    print(f"Question request failed ({exc.code}).", file=sys.stderr)
                    return _result(question_id, "failed", error=exc.code)
                if now() >= deadline:
                    # An answer may already be saved remotely; do not invent expiry.
                    return _result(question_id, "failed", error="network_result_unknown")
                print("Question connection interrupted; retrying.", file=sys.stderr)
                backoff = min(backoff * 2, 30)
                if isinstance(exc, ApiError) and exc.retry_after:
                    backoff = max(backoff, exc.retry_after)
            except (ValueError, KeyError, TypeError):
                return _result(question_id, "failed", error="invalid_server_response")
            sleep(min(backoff, max(0.1, deadline - now())))
        return _result(question_id, "failed", error="wait_interrupted")
    finally:
        store.set_question_waiter(question_id, None)
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
