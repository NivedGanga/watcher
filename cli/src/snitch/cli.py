"""``snitch`` command-line entry point."""

from __future__ import annotations

import argparse
import logging
import sys

from . import __version__, machinekey, service
from .config import ConfigError, load, parse_duration
from . import init as init_mod


def _err(text: str) -> None:
    print(text, file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="snitch",
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

    p = sub.add_parser("run", help="run a command under Snitch")
    p.add_argument("--name", required=True, help="agent name (1-64 chars)")
    p.add_argument("--timeout", help="run deadline, e.g. 2h (default: per-agent config or 2h)")
    p.add_argument("--stall", help="no-output stall window, e.g. 15m (default: per-agent config or 15m)")
    p.add_argument("cmd", nargs=argparse.REMAINDER, metavar="-- COMMAND...")

    p = sub.add_parser("ask", help="enqueue a blocking question")
    p.add_argument("question")
    p.add_argument("--wait", action="store_true", help="wait for a mobile answer and return JSON")
    p.add_argument("--option", action="append", default=[], help="choice label (repeat up to 8 times; requires --wait)")
    p.add_argument("--allow-text", action="store_true", help="also allow a custom text reply")
    p.add_argument("--timeout", help="mobile answer deadline, e.g. 30m (default: 30m; maximum: 24h)")

    p = sub.add_parser("wait", help="resume waiting for an existing mobile question")
    p.add_argument("question_id")

    p = sub.add_parser("done", help="enqueue a done event")
    p.add_argument("summary")

    sub.add_parser("daemon", help="run the delivery/heartbeat daemon")

    p = sub.add_parser("privacy", help="show or set the privacy mode")
    p.add_argument("mode", nargs="?", choices=("full", "metadata"))

    sub.add_parser("status", help="show local state")
    sub.add_parser("test", help="enqueue and send one event of each type")

    p = sub.add_parser("init", help="write the Snitch block into agent instruction files")
    p.add_argument(
        "--agents",
        default="",
        help="extra per-repo files, comma-separated: copilot, claude, gemini "
        "(AGENTS.md is always written)",
    )
    p.add_argument(
        "--global",
        dest="global_scope",
        action="store_true",
        help="also merge into user-level files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md)",
    )
    return parser


def _require_key() -> int | None:
    problem = machinekey.permission_error()
    if problem:
        _err(problem)
        return 1
    return None


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        config = load()
    except ConfigError as exc:
        _err(f"config error: {exc}")
        return 2

    from . import commands, daemon, enroll, redact, runner
    from .store import Store

    logging.basicConfig(
        level=logging.INFO, format="snitch: %(message)s", stream=sys.stderr
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
        if args.command in ("install-service", "uninstall-service") and not service.supported():
            _err("Background service setup is unavailable on Windows. Run: snitch daemon")
            return 2
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
                _err("run requires a command: snitch run --name N -- CMD...")
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
            if args.wait:
                from . import questions
                return questions.ask(args.question, args.option, args.allow_text,
                                     args.timeout or "30m", store, config, redactor)
            if args.option or args.allow_text or args.timeout:
                _err("--option, --allow-text, and --timeout require --wait")
                return 2
            return commands.cmd_ask(args.question, store, config, redactor)
        if args.command == "wait":
            from . import questions
            return questions.wait(args.question_id, store, config)
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
        if args.command == "init":
            names = [a.strip() for a in args.agents.split(",") if a.strip()]
            bad = [a for a in names if a not in init_mod.AGENT_FILES]
            if bad:
                _err(f"unknown agent(s): {', '.join(bad)} (choose from: {', '.join(init_mod.AGENT_FILES)})")
                return 2
            return init_mod.cmd_init(names, args.global_scope)
        return 2
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
