"""Run a native Windows executable while monitoring its output."""

import msvcrt
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

from . import _windows


def run(command, env_updates, stdin, stdout, on_start, saw_output, check_timers):
    executable = shutil.which(command[0])
    if executable is None:
        raise FileNotFoundError(f"cannot find {command[0]}")
    if Path(executable).suffix.lower() in (".cmd", ".bat"):
        raise OSError("run batch scripts through cmd.exe explicitly")

    # A frozen Snitch adds its own DLL directory. External commands need
    # their normal search path so they can find compatible DLLs.
    frozen = getattr(sys, "frozen", False)
    if frozen:
        _windows.kernel32.SetDllDirectoryW(None)
    try:
        child = subprocess.Popen(
            command, executable=executable, env=os.environ | env_updates,
            stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    finally:
        if frozen:
            _windows.kernel32.SetDllDirectoryW(sys._MEIPASS)

    with child:
        def terminate():
            taskkill = Path(os.environ["SystemRoot"]) / "System32" / "taskkill.exe"
            # shortcut: taskkill follows the current process tree. Use a Job
            # Object if detached descendants also need guaranteed cleanup.
            try:
                subprocess.run(
                    [str(taskkill), "/PID", str(child.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                    timeout=5,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
            if child.poll() is None:
                child.kill()

        pipe = child.stdout.fileno()
        output = stdout.fileno()
        previous_mode = None
        try:
            on_start(child.pid)
            previous_mode = msvcrt.setmode(output, os.O_BINARY)
            while True:
                code = child.poll()
                available = _windows.pipe_available(pipe)
                while available:
                    data = os.read(pipe, min(available, 65536))
                    if not data:
                        break
                    available -= len(data)
                    remaining = memoryview(data)
                    while remaining:
                        remaining = remaining[os.write(output, remaining):]
                    saw_output()
                if code is not None:
                    # Windows reports Ctrl+C as STATUS_CONTROL_C_EXIT.
                    if code == 0xC000013A:
                        return 130, signal.SIGINT
                    return code, None
                if child.poll() is None:
                    check_timers(terminate)
                    time.sleep(0.05)
        except KeyboardInterrupt:
            terminate()
            return 130, signal.SIGINT
        except BaseException:
            terminate()
            raise
        finally:
            if previous_mode is not None:
                msvcrt.setmode(output, previous_mode)
