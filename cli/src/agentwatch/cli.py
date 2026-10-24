"""``agentwatch`` command-line entry point."""

from __future__ import annotations

import argparse
import logging
import sys

from . import __version__, machinekey, paths, service
from .config import ConfigError, load, parse_duration


def _err(text: str) -> None:
    print(text, file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentwatch",
        description="Wrap agent processes and report their lifecycle.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("login", help="enroll this machine")
    p.add_argument("--name", help="machine display name (default: hostname)")
    p.add_argument("--no-browser", action="store_true", help="don't open the browser")
    p.add_argument("--no-service", action="store_true", help="don't offer service install")
    p.add_argument("--yes", "-y", action="store_true", help="accept defaults without asking")

    sub.add_parser("logout", help="revoke this machine and remove the key")
    sub.add_parser("install-service", help="install the daemon service")
    sub.add_parser("uninstall-service", help="remove the daemon service")

    p = sub.add_parser("run", help="run a command under AgentWatch")
    p.add_argument("--name", required=True, help="agent name (1-64 chars)")
    p.add_argument("--timeout", help="run deadline, e.g. 2h (default: per-agent config or 2h)")
    p.add_argument("--stall", help="no-output stall window, e.g. 15m (default: per-agent config or 15m)")
    p.add_argument("cmd", nargs=argparse.REMAINDER, metavar="-- COMMAND...")

    p = sub.add_parser("ask", help="enqueue a blocking question")
    p.add_argument("question")

    p = sub.add_parser("done", help="enqueue a done event")
    p.add_argument("summary")

    sub.add_parser("daemon", help="run the delivery/heartbeat daemon")

    p = sub.add_parser("privacy", help="show or set the privacy mode")
    p.add_argument("mode", nargs="?", choices=("full", "metadata"))

    sub.add_parser("status", help="show local state")
    sub.add_parser("test", help="enqueue and send one event of each type")
    return parser


def _require_key() -> int | None:
    problem = machinekey.permission_error()
    if problem:
        _err(problem)
        return 1
    return None


def main(argv: list[str] | None = None) -> int:
    if not paths.platform_supported():
        _err(paths.UNSUPPORTED_PLATFORM_MESSAGE)
        return 2

    args = build_parser().parse_args(argv)

    try:
        config = load()
    except ConfigError as exc:
        _err(f"config error: {exc}")
        return 2

    from . import commands, daemon, enroll, redact, runner
    from .store import Store

    logging.basicConfig(
        level=logging.INFO, format="agentwatch: %(message)s", stream=sys.stderr
    )

    store = Store()
    try:
        redactor = redact.Redactor.from_config(config)

        if args.command == "login":
            return enroll.login(
                config,
                store,
                name=args.name,
                no_browser=args.no_browser,
                no_service=args.no_service,
                yes=args.yes,
            )
        if args.command == "logout":
            return enroll.logout(config, store)
        if args.command == "install-service":
            for line in service.install():
                print(line)
            return 0
        if args.command == "uninstall-service":
            for line in service.uninstall():
                print(line)
            return 0
        if args.command == "run":
            cmd = list(args.cmd)
            if cmd and cmd[0] == "--":
                cmd = cmd[1:]
            if not cmd:
                _err("run requires a command: agentwatch run --name N -- CMD...")
                return 2
            if not (1 <= len(args.name) <= 64):
                _err("--name must be 1-64 characters")
                return 2
            agent_cfg = config.agent(args.name)
            timeout_label = args.timeout or agent_cfg.timeout
            stall_label = args.stall or agent_cfg.stall
            try:
                timeout_s = parse_duration(timeout_label)
                stall_s = parse_duration(stall_label)
            except ValueError as exc:
                _err(str(exc))
                return 2
            return runner.run_command(
                cmd,
                name=args.name,
                timeout_s=timeout_s,
                stall_s=stall_s,
                timeout_label=timeout_label,
                stall_label=stall_label,
                notify_done=agent_cfg.notify_done,
                store=store,
                redactor=redactor,
                config=config,
            )
        if args.command == "ask":
            return commands.cmd_ask(args.question, store, config, redactor)
        if args.command == "done":
            return commands.cmd_done(args.summary, store, config, redactor)
        if args.command == "daemon":
            problem = _require_key()
            if problem is not None:
                return problem
            return daemon.Daemon(store, config).run()
        if args.command == "privacy":
            return commands.cmd_privacy(args.mode, config)
        if args.command == "status":
            return commands.cmd_status(config, store)
        if args.command == "test":
            return commands.cmd_test(config, store, redactor)
        return 2
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
