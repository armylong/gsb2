"""Report export — machine-readable JSON and human-readable text.

Both formats go through :class:`~pcaprecon.redact.Redactor`, so exports
follow exactly the same masking rules as the interactive CLI.  Writing
a report never touches the source capture.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from .analyzer import AnalysisResult
from .filters import Filter
from .redact import Redactor


def build_report(result: AnalysisResult, redactor: Redactor,
                 filt: Filter | None = None) -> dict:
    sessions = filt.filter_sessions(result.sessions) if filt \
        else list(result.sessions)
    start_iso, end_iso = result.time_range_iso()
    anomaly_counter: Counter = Counter(a.code for a in result.anomalies)
    return {
        "tool": "pcaprecon",
        "capture_file": result.path,
        "generated_utc": _utc_now_iso(),
        "redaction_enabled": redactor.enabled,
        "aborted": result.aborted,
        "abort_reason": result.abort_reason,
        "time_range": {"start": start_iso, "end": end_iso},
        "totals": {
            "frames": result.total_frames,
            "sessions": len(result.sessions),
            "sessions_after_filter": len(sessions),
            "anomalies": len(result.anomalies),
            "http_messages": sum(len(s.messages) for s in result.sessions),
            "encrypted_sessions": sum(1 for s in result.sessions
                                      if s.encrypted),
            "truncated_sessions": sum(1 for s in result.sessions
                                      if s.truncated),
        },
        "protocol_distribution": dict(result.protocol_counts),
        "transport_distribution": dict(result.transport_counts),
        "top_talkers": [
            {"endpoint": str(ep), "bytes_seen": count}
            for ep, count in result.endpoint_bytes.most_common(20)
        ],
        "anomaly_summary": dict(anomaly_counter),
        "sessions": [redactor.view_session(s) for s in sessions],
        "filter": _filter_view(filt),
    }


def export_json(result: AnalysisResult, out_path: str,
                redactor: Redactor, filt: Filter | None = None) -> str:
    report = build_report(result, redactor, filt)
    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False),
                    encoding="utf-8")
    return str(path)


def export_text(result: AnalysisResult, out_path: str,
                redactor: Redactor, filt: Filter | None = None) -> str:
    report = build_report(result, redactor, filt)
    lines = _render_text(report)
    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


def render_text(result: AnalysisResult, redactor: Redactor,
                filt: Filter | None = None) -> str:
    return "\n".join(_render_text(build_report(result, redactor, filt)))


# ---------------------------------------------------------------------------


def _render_text(report: dict) -> list[str]:
    lines: list[str] = []
    add = lines.append
    add("=" * 78)
    add(f"pcaprecon report — {report['capture_file']}")
    add(f"generated (UTC): {report['generated_utc']}  "
        f"redaction: {'on' if report['redaction_enabled'] else 'OFF'}")
    if report["aborted"]:
        add(f"!! ANALYSIS ABORTED: {report['abort_reason']}")
    add("=" * 78)
    tr = report["time_range"]
    add(f"time range : {tr['start']} -> {tr['end']}")
    totals = report["totals"]
    add(f"frames     : {totals['frames']}   sessions: "
        f"{totals['sessions']} (shown {totals['sessions_after_filter']})"
        f"   HTTP messages: {totals['http_messages']}")
    add(f"encrypted  : {totals['encrypted_sessions']}   truncated: "
        f"{totals['truncated_sessions']}   anomalies: "
        f"{totals['anomalies']}")
    add(f"protocols  : {_fmt_counts(report['protocol_distribution'])}")
    add(f"transports : {_fmt_counts(report['transport_distribution'])}")
    add("top talkers:")
    for row in report["top_talkers"][:10]:
        add(f"  {row['endpoint']:<40} {row['bytes_seen']:>12} bytes")
    if report["anomaly_summary"]:
        add("anomalies  :")
        for code, count in sorted(report["anomaly_summary"].items()):
            add(f"  {code:<28} {count}")

    add("")
    for session in report["sessions"]:
        add("-" * 78)
        flags = []
        if session["encrypted"]:
            flags.append(f"ENCRYPTED/{session['encryption_kind']}")
        if session["truncated"]:
            flags.append("TRUNCATED")
        if session["reset"]:
            flags.append("RESET")
        flag_text = f"  [{' '.join(flags)}]" if flags else ""
        add(f"{session['session_id']}  {session['client']} -> "
            f"{session['server']}  "
            f"({session['c2s_bytes']}/{session['s2c_bytes']} bytes, "
            f"frames {session['first_frame']}..{session['last_frame']}, "
            f"{session['duration_s']}s){flag_text}")
        if session["c2s_gaps"] or session["s2c_gaps"]:
            add(f"  gaps: c2s={session['c2s_gaps']} s2c={session['s2c_gaps']}")
        for code, count in (
            ("retrans", session["retransmissions"]),
            ("ooo", session["out_of_order"]),
            ("dup", session["duplicate_segments"]),
            ("conflict", session["conflict_segments"]),
        ):
            if count:
                add(f"  {code}: {count}")
        for anomaly in session["anomalies"]:
            add(f"  ! {anomaly['severity']:<7} {anomaly['code']}: "
                f"{anomaly['message']}")
        for msg in session["messages"]:
            add(_format_message(msg))
    if not report["sessions"]:
        add("(no sessions match the current filter)")
    return lines


def _format_message(msg: dict) -> str:
    head = "    "
    if msg["direction"] == "request":
        line = (f"{head}REQ {msg['message_id']} {msg['method']} "
                f"{msg['target']}  [{msg['start_offset']}..]")
    else:
        line = (f"{head}RES {msg['message_id']} {msg['status_code']} "
                f"{msg.get('reason') or ''} "
                f"paired={msg['paired_request_id']} "
                f"[{msg['start_offset']}..{msg['end_offset']}]")
    if not msg["complete"]:
        line += f"  INCOMPLETE: {msg['incomplete_reason']}"
    lines = [line]
    for key, value in msg["headers"]:
        lines.append(f"{head}  {key}: {value}")
    if msg["body"]:
        preview = msg["body"]
        if len(preview) > 500:
            preview = preview[:500] + f"...<{len(msg['body']) - 500} more>"
        lines.append(f"{head}  body({len(msg['body'])}): {preview}")
    provenance = ", ".join(
        f"frame {p['frame_number']}@off{p['stream_offset']}"
        for p in msg["provenance"][:6])
    if provenance:
        lines.append(f"{head}  provenance: {provenance}")
    return "\n".join(lines)


def _fmt_counts(counts: dict) -> str:
    return ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "-"


def _filter_view(filt: Filter | None) -> dict | None:
    if filt is None:
        return None
    return {k: v for k, v in vars(filt).items() if v not in (None, False)}


def _utc_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(tz=timezone.utc).isoformat()
