"""End-to-end analysis pipeline and capture-wide statistics."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .capture import read_capture
from .config import Config
from .decode import decode_packet
from .errors import LimitExceeded
from .http_parser import parse_session_http
from .models import Anomaly, Endpoint, PacketRecord, Session
from .sessions import SessionManager


@dataclass
class AnalysisResult:
    path: str
    config: Config
    packets: list[PacketRecord] = field(default_factory=list)
    sessions: list[Session] = field(default_factory=list)
    anomalies: list[Anomaly] = field(default_factory=list)
    aborted: bool = False
    abort_reason: Optional[str] = None
    # statistics
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    protocol_counts: Counter = field(default_factory=Counter)
    transport_counts: Counter = field(default_factory=Counter)
    endpoint_bytes: Counter = field(default_factory=Counter)
    frame_to_session: dict[int, str] = field(default_factory=dict)

    @property
    def total_frames(self) -> int:
        return len(self.packets)

    def time_range_iso(self) -> tuple[Optional[str], Optional[str]]:
        def iso(ts: Optional[float]) -> Optional[str]:
            if ts is None:
                return None
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        return iso(self.start_time), iso(self.end_time)

    def session_of_frame(self, frame_number: int) -> Optional[str]:
        return self.frame_to_session.get(frame_number)


def analyze(path: str, config: Optional[Config] = None) -> AnalysisResult:
    """Run the full pipeline.  Never mutates ``path``."""
    config = config or Config()
    result = AnalysisResult(path=path, config=config)
    manager = SessionManager(config, result.anomalies)

    try:
        for frame_no, ts, offset, cap_len, orig_len, linktype, frame in \
                read_capture(path, config, result.anomalies):
            record = PacketRecord(
                frame_number=frame_no, timestamp=ts, file_offset=offset,
                captured_len=cap_len, original_len=orig_len,
                linktype=linktype,
                # Frames are needed for decoding; dropped afterwards
                # unless keep_frames asks for permanent retention.
                raw_frame=frame)
            decode_packet(record, config)
            if not config.keep_frames:
                record.raw_frame = None
            result.packets.append(record)
            _update_stats(result, record)

            session = manager.process_packet(record)
            if session is not None:
                result.frame_to_session[frame_no] = session.session_id
            # Payload now lives (or was deliberately discarded) in the
            # reassembly engine; the ledger keeps offsets only.
            if record.payload:
                record.had_payload = True
                record.payload_len = len(record.payload)
            if not config.keep_frames:
                record.payload = b""
    except LimitExceeded as exc:
        # Configured limit: an explicit, expected stop.  Record it and
        # either surface it or emit a marked partial report.
        result.aborted = True
        result.abort_reason = str(exc)
        result.anomalies.append(Anomaly(
            "ANALYSIS_ABORTED", "error", f"analysis stopped: {exc}"))
        if not config.allow_partial:
            raise
    except Exception as exc:
        # Unexpected structural/programming failure.  Still record the
        # exact point for a partial report, but never swallow silently:
        # without allow_partial the original exception propagates.
        result.aborted = True
        result.abort_reason = f"{type(exc).__name__}: {exc}"
        result.anomalies.append(Anomaly(
            "ANALYSIS_ABORTED", "error",
            f"analysis stopped unexpectedly: {result.abort_reason}"))
        if not config.allow_partial:
            raise

    manager.finalize()
    result.sessions = list(manager.sessions)
    for session in result.sessions:
        if not session.encrypted:
            for anomaly in parse_session_http(session):
                session.anomalies.append(anomaly)
        for anomaly in session.anomalies:
            result.anomalies.append(anomaly)
    if result.packets:
        result.start_time = result.packets[0].timestamp
        result.end_time = result.packets[-1].timestamp
    return result


def _update_stats(result: AnalysisResult, record: PacketRecord) -> None:
    for anomaly in record.anomalies:
        result.anomalies.append(anomaly)
        result.protocol_counts[f"anomaly:{anomaly.code}"] += 1

    if record.protocol_guess == "unsupported":
        result.protocol_counts["unsupported"] += 1
        return
    if record.ip_proto:
        result.protocol_counts[record.ip_proto] += 1
    if record.transport:
        result.transport_counts[record.transport] += 1
    if record.src:
        result.endpoint_bytes[record.src] += record.captured_len
    if record.dst:
        result.endpoint_bytes[record.dst] += record.captured_len
