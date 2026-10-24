"""Machine enrollment: ``agentwatch login`` / ``agentwatch logout``."""

from __future__ import annotations

import sys
import time
import webbrowser

from . import machinekey, paths, service
from .config import sanitize_hostname
from .delivery import UPGRADE_MESSAGE, Sender
from .httpclient import ApiError, NetworkError, api_request

POLL_SLOW_DOWN_SECONDS = 5.0


def _print_code_banner(user_code: str, out) -> None:
    spaced = " ".join(user_code.replace("-", " - "))
    width = len(spaced) + 6
    border = "+" + "-" * width + "+"
    out(border)
    out("|" + spaced.center(width) + "|")
    out(border)


def login(
    config,
    store,
    *,
    name: str | None = None,
    no_browser: bool = False,
    no_service: bool = False,
    yes: bool = False,
    out=print,
    err=lambda s: print(s, file=sys.stderr),
    input_fn=input,
    sleep=time.sleep,
    open_browser=webbrowser.open,
    request=api_request,
) -> int:
    if machinekey.logged_in():
        err("Already logged in. Run agentwatch logout first.")
        return 1

    client_name = name or sanitize_hostname()
    try:
        _, start, _ = request(
            config.backend_url,
            "POST",
            "/api/device/start",
            body={"client_name": client_name, "client_os": paths.client_os()},
        )
    except ApiError as exc:
        if exc.status == 426:
            err(UPGRADE_MESSAGE)
        else:
            err(f"Could not start login: {exc}")
        return 1
    except NetworkError as exc:
        err(f"Could not reach {config.backend_url}: {exc}")
        return 1

    start = start or {}
    device_code = start.get("device_code")
    user_code = start.get("user_code", "????-????")
    complete = start.get("verification_uri_complete") or start.get(
        "verification_uri", ""
    )
    interval = float(start.get("interval", 5))

    _print_code_banner(user_code, out)
    if complete:
        out(complete)
    out("Approve this code in your browser. It expires in 10 minutes.")
    if not no_browser and complete:
        try:
            open_browser(complete)
        except Exception:
            pass

    machine_id = None
    key = None
    while True:
        try:
            sleep(interval)
            _, data, _ = request(
                config.backend_url,
                "POST",
                "/api/device/token",
                body={"device_code": device_code},
            )
            data = data or {}
            machine_id = data.get("machine_id")
            key = data.get("key")
            break
        except ApiError as exc:
            if exc.code == "authorization_pending":
                continue
            if exc.code == "slow_down":
                interval += POLL_SLOW_DOWN_SECONDS
                continue
            if exc.code == "expired_token":
                err("The code expired. Run agentwatch login again.")
                return 1
            if exc.code == "access_denied":
                err("The request was denied in the browser.")
                return 1
            if exc.status == 426:
                err(UPGRADE_MESSAGE)
            else:
                err(f"Login failed: {exc}")
            return 1
        except NetworkError as exc:
            err(f"Network error while polling: {exc}")
            return 1
        except KeyboardInterrupt:
            out("Login cancelled.")
            return 130

    if not machine_id or not key:
        err("Login failed: the server returned an incomplete response.")
        return 1

    machinekey.write_key(key)
    config.set("general", "machine_id", machine_id)
    config.save()
    Sender.clear_blocked(store)
    out(f"Logged in. Machine ID: {machine_id}")

    try:
        request(
            config.backend_url,
            "POST",
            "/api/machines/current/test",
            body={},
            key=key,
        )
        out("Test email sent.")
    except (ApiError, NetworkError) as exc:
        err(f"Test email could not be sent ({exc}); continuing anyway.")

    if not no_service:
        install = yes
        if not yes:
            try:
                answer = input_fn(
                    "Install the background service (agentwatch daemon)? [Y/n] "
                )
            except EOFError:
                answer = "n"
            install = answer.strip().lower() in ("", "y", "yes")
        if install:
            for line in service.install():
                out(line)

    return 0


def logout(
    config,
    store,
    *,
    out=print,
    err=lambda s: print(s, file=sys.stderr),
    request=api_request,
) -> int:
    key = machinekey.read_key()
    revoked = False
    if key:
        try:
            request(
                config.backend_url,
                "DELETE",
                "/api/machines/current",
                key=key,
            )
            revoked = True
        except (ApiError, NetworkError):
            revoked = False
    else:
        out("Not logged in.")
        return 0

    machinekey.delete_key()
    config.unset("general", "machine_id")
    config.save()
    Sender.clear_blocked(store)

    if revoked:
        out("Logged out. The server revoked this machine.")
    else:
        out("Logged out locally; the server did not confirm revocation.")
    return 0
