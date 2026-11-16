"""pcaprecon command line interface."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__, samplegen
from .analyzer import analyze
from .config import Config
from .errors import LimitExceeded
from .filters import Filter
from .redact import Redactor
from .report import export_json, export_text, render_text
from .trace import trace_bytes, trace_frame, trace_message


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pcaprecon",
        description="Offline pcap/pcapng session reassembly and HTTP "
                    "reconstruction (unencrypted traffic).")
    p.add_argument("--version", action="version",
                   version=f"pcaprecon {__version__}")
    p.add_argument("--max-file-mb", type=float, default=512.0,
                   help="refuse captures larger than this (default 512)")
    p.add_argument("--max-memory-mb", type=float, default=256.0,
                   help="reassembly memory budget in MB (default 256)")
    p.add_argument("--max-packets", type=int, default=2_000_000)
    p.add_argument("--max-sessions", type=int, default=100_000)
    p.add_argument("--keep-frames", action="store_true",
                   help="retain raw frame bytes in memory (off by default)")
    p.add_argument("--verify-checksums", action="store_true")
    p.add_argument("--show-secrets", action="store_true",
                   help="disable credential/PII redaction (default: masked)")
    p.add_argument("--allow-partial", action="store_true",
                   help="if a limit is hit, still emit the partial report "
                        "marked as aborted")

    # Shared filters ----------------------------------------------------
    def add_filters(sp):
        sp.add_argument("--endpoint", dest="filter_endpoint",
                        help="substring of client or server endpoint")
        sp.add_argument("--start-after", dest="filter_start_after",
                        type=float, help="epoch seconds, inclusive")
        sp.add_argument("--start-before", dest="filter_start_before",
                        type=float, help="epoch seconds, inclusive")
        sp.add_argument("--method", dest="filter_method",
                        help="HTTP method filter")
        sp.add_argument("--path", dest="filter_path",
                        help="substring of request path/target")
        sp.add_argument("--anomaly", dest="filter_anomaly",
                        help="anomaly code substring")
        sp.add_argument("--encrypted", dest="filter_encrypted",
                        action="store_true")

    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("overview", help="capture-wide summary")
    sp.add_argument("capture")
    add_filters(sp)
    sp.set_defaults(func=cmd_overview)

    sp = sub.add_parser("sessions", help="list reconstructed sessions")
    sp.add_argument("capture")
    add_filters(sp)
    sp.set_defaults(func=cmd_sessions)

    sp = sub.add_parser("messages", help="list HTTP messages")
    sp.add_argument("capture")
    sp.add_argument("--session", dest="session_id")
    add_filters(sp)
    sp.set_defaults(func=cmd_messages)

    sp = sub.add_parser("anomalies", help="list anomalies with evidence")
    sp.add_argument("capture")
    add_filters(sp)
    sp.set_defaults(func=cmd_anomalies)

    sp = sub.add_parser("trace", help="provenance lookup")
    sp.add_argument("capture")
    grp = sp.add_mutually_exclusive_group(required=True)
    grp.add_argument("--frame", type=int, help="frame number -> session")
    grp.add_argument("--message", help="HTTP message id -> frames")
    grp.add_argument("--bytes", nargs=3, metavar=("SESSION", "DIR", "OFF"),
                     help="session id, c2s|s2c, stream offset")
    sp.add_argument("--length", type=int, default=1)
    sp.set_defaults(func=cmd_trace)

    sp = sub.add_parser("export", help="write JSON or text report")
    sp.add_argument("capture")
    sp.add_argument("output", help="output path (.json or .txt)")
    add_filters(sp)
    sp.set_defaults(func=cmd_export)

    sp = sub.add_parser("generate-samples",
                        help="create local pcap fixtures in a directory")
    sp.add_argument("outdir")
    sp.set_defaults(func=cmd_generate)

    return p


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run(args):
    config = Config.from_cli_args(args)
    return analyze(args.capture, config), config


def _redactor(config: Config) -> Redactor:
    return Redactor(enabled=config.mask_secrets,
                    token=config.redaction_token)


def _filter(args) -> Filter:
    return Filter.from_cli(args)


def _print_overview(result, redactor, filt) -> None:
    print(render_text(result, redactor, filt).split("-" * 78)[0].rstrip())


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_overview(args) -> int:
    result, config = _run(args)
    _print_overview(result, _redactor(config), _filter(args))
    if result.aborted:
        print(f"\nNOTE: analysis aborted: {result.abort_reason}",
              file=sys.stderr)
    return 0


def cmd_sessions(args) -> int:
    result, config = _run(args)
    redactor = _redactor(config)
    filt = _filter(args)
    for session in filt.filter_sessions(result.sessions):
        view = redactor.view_session(session)
        flags = []
        if view["encrypted"]:
            flags.append(view["encryption_kind"].upper())
        if view["truncated"]:
            flags.append("TRUNCATED")
        if view["reset"]:
            flags.append("RESET")
        print(f"{view['session_id']}  {view['client']} -> {view['server']}"
              f"  msgs={len(view['messages'])} "
              f"frames={view['first_frame']}..{view['last_frame']} "
              f"gaps={len(view['c2s_gaps']) + len(view['s2c_gaps'])} "
              f"{'[' + ','.join(flags) + ']' if flags else ''}")
    return 0


def cmd_messages(args) -> int:
    result, config = _run(args)
    redactor = _redactor(config)
    filt = _filter(args)
    for session in filt.filter_sessions(result.sessions):
        if args.session_id and session.session_id != args.session_id:
            continue
        for msg in filt.filter_messages(session.messages):
            view = redactor.view_message(msg)
            if view["direction"] == "request":
                line = (f"{view['message_id']} {session.session_id} REQ "
                        f"{view['method']} {view['target']}")
            else:
                line = (f"{view['message_id']} {session.session_id} RES "
                        f"{view['status_code']} "
                        f"paired={view['paired_request_id']}")
            if not view["complete"]:
                line += f"  INCOMPLETE({view['incomplete_reason']})"
            print(line)
    return 0


def cmd_anomalies(args) -> int:
    result, config = _run(args)
    filt = _filter(args)
    wanted = {s.session_id for s in filt.filter_sessions(result.sessions)}
    for anomaly in result.anomalies:
        if anomaly.session_id and anomaly.session_id not in wanted:
            continue
        if filt.anomaly and filt.anomaly.lower() not in anomaly.code.lower():
            continue
        loc = []
        if anomaly.frame_number is not None:
            loc.append(f"frame={anomaly.frame_number}")
        if anomaly.file_offset is not None:
            loc.append(f"file_offset={anomaly.file_offset}")
        if anomaly.stream_offset is not None:
            loc.append(f"stream_offset={anomaly.stream_offset}")
        print(f"{anomaly.severity.upper():<7} {anomaly.code:<26} "
              f"{anomaly.session_id or '-':<8} "
              f"{' '.join(loc):<28} {anomaly.message}")
    return 0


def cmd_trace(args) -> int:
    result, config = _run(args)
    if args.frame:
        print(json.dumps(trace_frame(result, args.frame),
                         indent=2, ensure_ascii=False))
        return 0
    if args.message:
        message = next((m for s in result.sessions for m in s.messages
                        if m.message_id == args.message), None)
        if message is None:
            print(f"message id not found: {args.message}", file=sys.stderr)
            return 1
        evidence = [vars(e) for e in trace_message(result, message)]
        print(json.dumps({"message_id": args.message,
                          "evidence": evidence}, indent=2))
        return 0
    session_id, direction, offset = args.bytes
    evidence = [vars(e) for e in trace_bytes(
        result, session_id, direction, int(offset), args.length)]
    print(json.dumps({"session_id": session_id, "direction": direction,
                      "stream_offset": int(offset),
                      "length": args.length, "evidence": evidence},
                     indent=2))
    return 0


def cmd_export(args) -> int:
    result, config = _run(args)
    redactor = _redactor(config)
    out = Path(args.output)
    if out.suffix.lower() == ".json":
        path = export_json(result, str(out), redactor, _filter(args))
    else:
        path = export_text(result, str(out), redactor, _filter(args))
    print(f"report written to {path} (redaction "
          f"{'on' if redactor.enabled else 'OFF'})")
    if result.aborted:
        print(f"WARNING: report is partial — {result.abort_reason}",
              file=sys.stderr)
    return 0


def cmd_generate(args) -> int:
    written = samplegen.generate_all(args.outdir)
    for name, path in sorted(written.items()):
        print(f"{name:<24} {path}")
    print(f"\n{len(written)} fixtures generated in "
          f"{Path(args.outdir).resolve()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except LimitExceeded as exc:
        print(f"STOPPED: [{exc.code}] {exc.message}", file=sys.stderr)
        print("adjust the relevant --max-* limit or re-run with "
              "--allow-partial for an explicitly marked partial report",
              file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # pragma: no cover - defensive top level
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
