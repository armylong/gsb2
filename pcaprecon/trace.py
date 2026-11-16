"""Bidirectional provenance lookups.

Two directions are supported, as required by the spec:

* session content (a byte range of a stream, or an HTTP message) ->
  the original frames and their file offsets that supplied the bytes
* capture frame number -> the owning session and its role in it
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .analyzer import AnalysisResult
from .models import HttpMessage, Session


@dataclass
class FrameEvidence:
    frame_number: int
    file_offset: int
    stream_offset: int
    length: int


def trace_message(result: AnalysisResult,
                  message: HttpMessage) -> list[FrameEvidence]:
    """Every frame that contributed bytes to an HTTP message."""
    session = _find_session(result, message)
    if session is None:
        return []
    stream = session.c2s if message.stream == "c2s" else session.s2c
    length = max(1, (message.end_offset or message.start_offset + 1)
                 - message.start_offset)
    return [FrameEvidence(
        frame_number=f.frame_number,
        file_offset=f.packet_file_offset,
        stream_offset=f.stream_offset,
        length=f.length)
        for f in stream.provenance_at(message.start_offset, length)]


def trace_bytes(result: AnalysisResult, session_id: str, direction: str,
                stream_offset: int, length: int = 1
                ) -> list[FrameEvidence]:
    session = next((s for s in result.sessions
                    if s.session_id == session_id), None)
    if session is None:
        return []
    stream = session.c2s if direction == "c2s" else session.s2c
    return [FrameEvidence(
        frame_number=f.frame_number,
        file_offset=f.packet_file_offset,
        stream_offset=f.stream_offset,
        length=f.length)
        for f in stream.provenance_at(stream_offset, length)]


def trace_frame(result: AnalysisResult, frame_number: int) -> dict:
    """Map a raw capture frame back to its session and role."""
    record = next((p for p in result.packets
                   if p.frame_number == frame_number), None)
    if record is None:
        return {"frame_number": frame_number, "found": False}
    session_id = result.session_of_frame(frame_number)
    session = next((s for s in result.sessions
                    if s.session_id == session_id), None)
    role = None
    direction = None
    if session is not None and record.src is not None:
        direction = "c2s" if record.src == session.client else "s2c"
        flags = record.tcp_flags or ""
        roles = []
        if "SYN" in flags:
            roles.append("syn")
        if "FIN" in flags:
            roles.append("fin")
        if "RST" in flags:
            roles.append("reset")
        if record.had_payload:
            roles.append("data")
        role = "+".join(roles) if roles else "ack/control"
    return {
        "found": True,
        "frame_number": frame_number,
        "file_offset": record.file_offset,
        "timestamp": record.timestamp,
        "src": str(record.src) if record.src else None,
        "dst": str(record.dst) if record.dst else None,
        "transport": record.transport,
        "tcp_flags": record.tcp_flags,
        "payload_len": record.payload_len,
        "session_id": session_id,
        "direction": direction,
        "role": role,
        "anomaly_codes": [a.code for a in record.anomalies],
    }


def _find_session(result: AnalysisResult,
                  message: HttpMessage) -> Optional[Session]:
    return next((s for s in result.sessions
                 if any(m.message_id == message.message_id
                        for m in s.messages)), None)
