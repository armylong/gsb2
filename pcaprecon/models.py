"""Core data models shared by every pipeline stage."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Network endpoints and packet ledger
# ---------------------------------------------------------------------------


@dataclass(frozen=True, order=True)
class Endpoint:
    """An IP address + transport port pair."""

    ip: str
    port: int

    def __str__(self) -> str:
        return f"{self.ip}:{self.port}"


@dataclass
class Anomaly:
    """Any parse/reassembly/HTTP problem worth reporting.

    Every anomaly carries provenance: capture frame number and the file
    offset of the packet when one is responsible.
    """

    code: str
    severity: str  # info | warning | error
    message: str
    frame_number: Optional[int] = None
    file_offset: Optional[int] = None
    session_id: Optional[str] = None
    stream_offset: Optional[int] = None
    timestamp: Optional[float] = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


@dataclass
class PacketRecord:
    """One captured frame plus the provenance needed to re-find it."""

    frame_number: int
    timestamp: float  # seconds since epoch, based on capture timestamps
    file_offset: int  # byte offset of the per-packet record header
    captured_len: int  # bytes stored in the file
    original_len: int  # bytes that were on the wire
    linktype: int
    raw_frame: Optional[bytes]  # None unless Config.keep_frames
    # Decoded layer results (filled by the decode stage)
    src: Optional[Endpoint] = None
    dst: Optional[Endpoint] = None
    transport: Optional[str] = None  # "tcp" | "udp" | "icmp" ...
    ip_proto: Optional[str] = None
    seq: Optional[int] = None
    ack: Optional[int] = None
    tcp_flags: Optional[str] = None
    payload: bytes = b""
    anomalies: list[Anomaly] = field(default_factory=list)
    # Back-reference filled by the session manager
    session_id: Optional[str] = None
    protocol_guess: Optional[str] = None  # tls / ssh / http / unknown
    had_payload: bool = False  # set before payload is released
    payload_len: int = 0       # original payload length, retained

    def to_summary(self) -> dict:
        return {
            "frame_number": self.frame_number,
            "timestamp": self.timestamp,
            "file_offset": self.file_offset,
            "captured_len": self.captured_len,
            "original_len": self.original_len,
            "src": str(self.src) if self.src else None,
            "dst": str(self.dst) if self.dst else None,
            "transport": self.transport,
            "session_id": self.session_id,
            "anomaly_codes": [a.code for a in self.anomalies],
        }


# ---------------------------------------------------------------------------
# Reassembly fragments / gaps
# ---------------------------------------------------------------------------


@dataclass
class Fragment:
    """A contiguous byte range of a reassembled stream.

    Byte content itself lives in the stream buffer; a fragment only
    records the span and where the bytes came from so any reconstructed
    byte can be traced back to a capture frame and file offset.
    """

    stream_offset: int
    length: int
    frame_number: int
    packet_file_offset: int
    seq: int
    is_retransmission: bool = False
    is_out_of_order: bool = False
    is_duplicate: bool = False
    is_conflict: bool = False

    @property
    def end(self) -> int:
        return self.stream_offset + self.length


@dataclass
class Gap:
    """A missing byte range inside a directed stream."""

    start: int
    end: int  # exclusive

    @property
    def length(self) -> int:
        return self.end - self.start


# ---------------------------------------------------------------------------
# HTTP messages
# ---------------------------------------------------------------------------


@dataclass
class HttpMessage:
    """A reconstructed HTTP/1.x request or response.

    A message is only considered complete when its framing proves it.
    Anything cut short by a gap or a truncated capture keeps
    ``complete=False`` and gets an explicit ``incomplete_reason``.
    """

    message_id: str
    direction: str  # "request" | "response"
    stream: str  # "c2s" | "s2c"
    start_offset: int  # offset in the directed byte stream
    end_offset: Optional[int]  # None when incomplete
    frame_numbers: list[int] = field(default_factory=list)
    # Request fields
    method: Optional[str] = None
    target: Optional[str] = None
    path: Optional[str] = None
    query: Optional[str] = None
    # Response fields
    status_code: Optional[int] = None
    reason: Optional[str] = None
    version: str = "HTTP/1.1"
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: bytes = b""
    body_transfer: str = "none"  # none | content-length | chunked | until-close
    complete: bool = False
    incomplete_reason: Optional[str] = None
    paired_request_id: Optional[str] = None
    # 1xx interim responses do not count as the final request reply.
    is_interim: bool = False
    # HTTP framing anomalies detected while parsing this message
    anomaly_codes: list[str] = field(default_factory=list)
    # Byte ranges in the stream where each header/body piece came from
    provenance: list[dict] = field(default_factory=list)

    def header(self, name: str) -> Optional[str]:
        name = name.lower()
        for k, v in self.headers:
            if k.lower() == name:
                return v
        return None


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


@dataclass
class Session:
    """One TCP connection lifecycle.

    A new connection (fresh SYN) between the same endpoint pair gets a
    new session id; reuse of an existing connection via pipelined HTTP
    stays inside the same session.
    """

    session_id: str
    key: tuple[Endpoint, Endpoint]  # unordered endpoint pair
    client: Endpoint
    server: Endpoint
    start_time: float
    end_time: Optional[float] = None
    # live reassembly engines (not serialised into reports)
    c2s: object = None
    s2c: object = None
    # reassembled results (filled at finalize)
    c2s_data: bytes = b""
    s2c_data: bytes = b""
    c2s_fragments: list[Fragment] = field(default_factory=list)
    s2c_fragments: list[Fragment] = field(default_factory=list)
    c2s_gaps: list[Gap] = field(default_factory=list)
    s2c_gaps: list[Gap] = field(default_factory=list)
    c2s_complete: bool = False
    s2c_complete: bool = False
    c2s_fin_offset: Optional[int] = None
    s2c_fin_offset: Optional[int] = None
    reset: bool = False
    truncated: bool = False  # capture ended with the connection open
    frame_numbers: list[int] = field(default_factory=list)
    messages: list[HttpMessage] = field(default_factory=list)
    anomalies: list[Anomaly] = field(default_factory=list)
    encrypted: bool = False
    encryption_kind: Optional[str] = None
    retransmissions: int = 0
    out_of_order: int = 0
    duplicate_segments: int = 0
    conflict_segments: int = 0
    # convenience flags
    has_http: bool = False
    first_frame: Optional[int] = None
    last_frame: Optional[int] = None

    @property
    def is_complete(self) -> bool:
        return not self.truncated and not self.reset

    def stream_fragments(self, direction: str) -> list[Fragment]:
        return self.c2s_fragments if direction == "c2s" else self.s2c_fragments

    def stream_gaps(self, direction: str) -> list[Gap]:
        return self.c2s_gaps if direction == "c2s" else self.s2c_gaps
