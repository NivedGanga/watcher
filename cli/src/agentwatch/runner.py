"""``agentwatch run`` — wrap a command in a pty and report its lifecycle."""

from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import signal
import sys
import termios
import time
import tty

from . import events
from .store import Store

OUTPUT_SIGNAL_INTERVAL = float(
    os.environ.get("AGENTWATCH_OUTPUT_SIGNAL_INTERVAL", "30")
)
KILL_GRACE_SECONDS = 10.0
# Output clears an open question only once the question has been open this
# long — the question prompt itself may still be in the pty buffer when
# `agentwatch ask` registers the question.
QUESTION_CLOSE_GRACE_SECONDS = 1.0
SELECT_TICK_SECONDS = 0.1


def _fmt_duration(raw: str) -> str:
    """Display string for a configured duration ("120" -> "120s")."""
    return raw if raw[-1].isalpha() else f"{raw}s"


class RunResult:
    def __init__(self, exit_code: int):
        self.exit_code = exit_code


def _forward_winsize(master_fd: int, stdin_fd: int) -> None:
    try:
        size = fcntl.ioctl(stdin_fd, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, size)
    except (OSError, ValueError):
        pass


def _exec_child(command: list[str], env_updates: dict[str, str]) -> None:
    env = dict(os.environ)
    env.update(env_updates)
    try:
        os.execvpe(command[0], command, env)
    except OSError as exc:
        print(f"agentwatch: cannot run {command[0]}: {exc}", file=sys.stderr)
        os._exit(127)


def run_command(
    command: list[str],
    *,
    name: str,
    timeout_s: float,
    stall_s: float,
    timeout_label: str,
    stall_label: str,
    notify_done: bool,
    store: Store,
    redactor,
    config,
    stdin=None,
    stdout=None,
    now=time.time,
) -> int:
    """Run ``command`` under a pty. Returns the child's exit code."""
    run_id = events.new_run_id()
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    stdin_fd = stdin.fileno()
    stdout_fd = stdout.fileno()

    pid, master_fd = pty.fork()
    if pid == 0:  # child: new session, own process group, controlling tty
        _exec_child(
            command,
            {"AGENTWATCH_RUN_ID": run_id, "AGENTWATCH_AGENT": name},
        )

    # ---- parent -------------------------------------------------------
    store.start_run(run_id, name, pid, now())

    stdin_is_tty = os.isatty(stdin_fd)
    saved_attrs = None
    if stdin_is_tty:
        try:
            saved_attrs = termios.tcgetattr(stdin_fd)
            tty.setraw(stdin_fd)
        except termios.error:
            saved_attrs = None
    _forward_winsize(master_fd, stdin_fd)

    forwarded: dict[str, int] = {}

    def _forward(signum, _frame):
        forwarded["sig"] = signum
        try:
            os.killpg(pid, signum)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def _winsize(_signum, _frame):
        _forward_winsize(master_fd, stdin_fd)

    old_handlers = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        old_handlers[sig] = signal.signal(sig, _forward)
    old_winch = signal.signal(signal.SIGWINCH, _winsize)

    started = now()
    deadline = started + timeout_s
    last_output = started
    last_output_signal = 0.0
    stalled_sent = False
    term_sent_at: float | None = None
    status: int | None = None
    master_open = True
    stdin_open = True

    def flush(data: bytes) -> None:
        os.write(stdout_fd, data)

    def saw_output() -> None:
        nonlocal last_output, last_output_signal, stalled_sent
        t = now()
        last_output = t
        stalled_sent = False
        row = store.get_run(run_id)
        if (
            row
            and row["question_open_at"]
            and t > row["question_open_at"] + QUESTION_CLOSE_GRACE_SECONDS
        ):
            store.close_question(run_id)
        if t - last_output_signal >= OUTPUT_SIGNAL_INTERVAL:
            events.enqueue_signal(
                store, now=t, kind="output_seen", run_id=run_id
            )
            last_output_signal = t

    def check_timers() -> None:
        nonlocal stalled_sent, term_sent_at
        t = now()
        if term_sent_at is None:
            if not stalled_sent and (t - last_output) >= stall_s:
                if not store.question_open(run_id):
                    events.enqueue_event(
                        store,
                        now=t,
                        event_type="stalled",
                        agent=name,
                        run_id=run_id,
                        host=config.host_name,
                        summary=f"{name} has produced no output for {_fmt_duration(stall_label)}.",
                        exit_code=None,
                        duration_s=None,
                        email_allowed=True,
                        redactor=redactor,
                        privacy_mode=config.privacy_mode,
                    )
                    stalled_sent = True
            if t >= deadline:
                try:
                    os.killpg(pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
                term_sent_at = t

    def reap(block: bool) -> int | None:
        try:
            wpid, st = os.waitpid(pid, 0 if block else os.WNOHANG)
        except ChildProcessError:
            return -1
        if wpid == 0:
            return None
        return st

    try:
        while status is None:
            if term_sent_at is not None and now() - term_sent_at >= (
                KILL_GRACE_SECONDS
            ):
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
            st = reap(block=False)
            if st is not None:
                status = st
                break

            fds = []
            if master_open:
                fds.append(master_fd)
            if stdin_open:
                fds.append(stdin_fd)
            if not fds:
                status = reap(block=True)
                break
            try:
                readable, _, _ = select.select(
                    fds, [], [], SELECT_TICK_SECONDS
                )
            except InterruptedError:
                readable = []
            for fd in readable:
                if fd == master_fd:
                    try:
                        data = os.read(master_fd, 65536)
                    except OSError as exc:
                        if exc.errno in (errno.EIO, errno.EBADF):
                            data = b""
                        else:
                            raise
                    if data:
                        flush(data)
                        saw_output()
                    else:
                        master_open = False
                elif fd == stdin_fd:
                    try:
                        data = os.read(stdin_fd, 65536)
                    except OSError:
                        data = b""
                    if data:
                        try:
                            os.write(master_fd, data)
                        except OSError:
                            stdin_open = False
                    else:
                        stdin_open = False
            check_timers()

        # Drain any remaining pty output.
        if master_open:
            while True:
                try:
                    ready, _, _ = select.select([master_fd], [], [], 0.2)
                    if not ready:
                        break
                    data = os.read(master_fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                flush(data)
        if status == -1:
            status = 0  # already reaped (shouldn't happen)
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        signal.signal(signal.SIGWINCH, old_winch)
        if saved_attrs is not None:
            try:
                termios.tcsetattr(stdin_fd, termios.TCSADRAIN, saved_attrs)
            except termios.error:
                pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    ended = now()
    store.end_run(run_id, ended)
    duration = round(ended - started, 3)

    if os.WIFEXITED(status):
        code = os.WEXITSTATUS(status)
        if code == 0:
            events.enqueue_event(
                store,
                now=ended,
                event_type="done",
                agent=name,
                run_id=run_id,
                host=config.host_name,
                summary=f"{name} finished.",
                exit_code=0,
                duration_s=duration,
                email_allowed=notify_done,
                redactor=redactor,
                privacy_mode=config.privacy_mode,
            )
        else:
            events.enqueue_event(
                store,
                now=ended,
                event_type="failed",
                agent=name,
                run_id=run_id,
                host=config.host_name,
                summary=f"{name} exited with code {code}.",
                exit_code=code,
                duration_s=duration,
                email_allowed=True,
                redactor=redactor,
                privacy_mode=config.privacy_mode,
            )
        return code

    sig = os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0
    if term_sent_at is not None:
        events.enqueue_event(
            store,
            now=ended,
            event_type="timed_out",
            agent=name,
            run_id=run_id,
            host=config.host_name,
            summary=f"{name} exceeded its timeout of {_fmt_duration(timeout_label)}.",
            exit_code=None,
            duration_s=duration,
            email_allowed=True,
            redactor=redactor,
            privacy_mode=config.privacy_mode,
        )
    else:
        events.enqueue_event(
            store,
            now=ended,
            event_type="failed",
            agent=name,
            run_id=run_id,
            host=config.host_name,
            summary=f"{name} was killed by signal {sig}.",
            exit_code=None,
            duration_s=duration,
            email_allowed=True,
            redactor=redactor,
            privacy_mode=config.privacy_mode,
        )
    return 128 + sig
