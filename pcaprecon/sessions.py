"""TCP connection / session lifecycle management.

Packets arrive in capture order.  A *session* is one TCP connection:
a fresh SYN between the same endpoint pair always opens a new session,
so reconnects are never merged with the previous connection.
"""

from __future__ import annotations

from typing import Optional

from .errors import LimitExceeded
from .models import Anomaly, Endpoint, PacketRecord, Session
from .reassembly import DirectedStream, seq_sub

_TLS_HANDSHAKE = {0x16: "tls-handshake"}
_TLS_OTHER = {0x14, 0x15, 0x17}  # change-cipher-spec, alert, app data
_SSH_PREFIX = b"SSH-"


class SessionManager:
    def __init__(self, config, global_anomalies: list[Anomaly]):
        self.config = config
        self.global_anomalies = global_anomalies
        self.sessions: list[Session] = []
        # endpoint pair -> most recent session (open or closed)
        self._by_pair: dict[tuple[Endpoint, Endpoint], Session] = {}
        self._mem_used = 0
        self._next_id = 1

    # ------------------------------------------------------------------

    def process_packet(self, packet: PacketRecord) -> Optional[Session]:
        if packet.transport != "tcp" or not packet.src or not packet.dst:
            return None
        flags = packet.tcp_flags or ""
        is_syn = "SYN" in flags
        is_rst = "RST" in flags
        is_fin = "FIN" in flags

        if is_syn and "ACK" not in flags and \
                not self._is_retransmitted_syn(packet):
            session = self._open_session(packet)
        else:
            session = self._find_session(packet)
            if session is None:
                # No SYN captured: connection was already open.
                session = self._open_session(packet, inferred=True)

        packet.session_id = session.session_id
        session.frame_numbers.append(packet.frame_number)
        session.last_frame = packet.frame_number
        if session.first_frame is None:
            session.first_frame = packet.frame_number
        session.end_time = packet.timestamp

        c2s = packet.src == session.client
        stream = session.c2s if c2s else session.s2c

        if is_syn:
            stream.note_syn(packet)
        if is_rst:
            stream.handle_rst(packet)
            session.reset = True
        if is_fin:
            stream.note_fin(packet)

        if packet.payload and not session.encrypted:
            kind = self._detect_encryption(packet.payload, session)
            if kind:
                session.encrypted = True
                session.encryption_kind = kind
                session.anomalies.append(Anomaly(
                    "ENCRYPTED_TRAFFIC", "info",
                    f"{kind.upper()} traffic detected on session "
                    f"{session.session_id}; only connection metadata is "
                    "reported, payload is not decoded",
                    frame_number=packet.frame_number,
                    file_offset=packet.file_offset,
                    session_id=session.session_id,
                    timestamp=packet.timestamp))
        if session.encrypted:
            # Do not buffer ciphertext; metadata is still tracked.
            pass
        elif packet.payload:
            before = len(stream.data) + sum(
                len(p.data) for p in stream.pending.values())
            stream.add_segment(packet)
            after = len(stream.data) + sum(
                len(p.data) for p in stream.pending.values())
            self._mem_used += max(0, after - before)
            self._check_memory(packet)

        if is_rst or self._both_dirs_closed(session):
            self._close(session, packet.timestamp)

        return session

    def finalize(self) -> None:
        """End-of-capture: open connections are marked truncated."""
        for session in self.sessions:
            if session.end_time is None:
                continue
            still_open = not session.reset and not (
                session.c2s.fin_abs_seq is not None
                and session.s2c.fin_abs_seq is not None)
            truncated = still_open
            for direction, stream in (("c2s", session.c2s),
                                      ("s2c", session.s2c)):
                for anomaly in stream.finalize(truncated):
                    anomaly.session_id = session.session_id
                    session.anomalies.append(anomaly)
                if direction == "c2s":
                    session.c2s_data = bytes(stream.data)
                    session.c2s_gaps = list(stream.gaps)
                    session.c2s_complete = (
                        not truncated and not stream.reset
                        and not stream.gaps)
                    session.c2s_fin_offset = self._fin_offset(stream)
                    session.retransmissions += stream.retransmissions
                    session.out_of_order += stream.out_of_order
                    session.duplicate_segments += stream.duplicates
                    session.conflict_segments += stream.conflicts
                else:
                    session.s2c_data = bytes(stream.data)
                    session.s2c_gaps = list(stream.gaps)
                    session.s2c_complete = (
                        not truncated and not stream.reset
                        and not stream.gaps)
                    session.s2c_fin_offset = self._fin_offset(stream)
                    session.retransmissions += stream.retransmissions
                    session.out_of_order += stream.out_of_order
                    session.duplicate_segments += stream.duplicates
                    session.conflict_segments += stream.conflicts
            if truncated:
                session.truncated = True
                session.anomalies.append(Anomaly(
                    "SESSION_TRUNCATED", "warning",
                    f"session {session.session_id} was still open when the "
                    "capture ended; reassembled content is partial",
                    session_id=session.session_id,
                    frame_number=session.last_frame))

    # -- internals ------------------------------------------------------

    def _open_session(self, packet: PacketRecord,
                      inferred: bool = False) -> Session:
        if len(self.sessions) >= self.config.max_sessions:
            raise LimitExceeded(
                "SESSION_COUNT_LIMIT",
                f"session count limit {self.config.max_sessions} reached; "
                "stopping explicitly",
                used=len(self.sessions),
                limit=self.config.max_sessions)
        pair = tuple(sorted((packet.src, packet.dst)))
        sid = f"s{self._next_id:06d}"
        self._next_id += 1
        # SYN source is the client; for inferred sessions decide later.
        if "SYN" in (packet.tcp_flags or ""):
            client, server = packet.src, packet.dst
        else:
            client, server = self._guess_roles(packet, pair)
        session = Session(
            session_id=sid, key=pair, client=client, server=server,
            start_time=packet.timestamp)
        session.c2s = DirectedStream("c2s", sid)
        session.s2c = DirectedStream("s2c", sid)
        if inferred:
            session.anomalies.append(Anomaly(
                "SESSION_NO_SYN", "info",
                f"session {sid} first observed without a SYN (capture "
                "started mid-connection); stream offsets begin at the "
                "first captured byte",
                frame_number=packet.frame_number,
                file_offset=packet.file_offset, session_id=sid,
                timestamp=packet.timestamp))
        self.sessions.append(session)
        self._by_pair[pair] = session
        return session

    def _guess_roles(self, packet: PacketRecord,
                     pair: tuple[Endpoint, Endpoint]) -> tuple[Endpoint, Endpoint]:
        # Ephemeral client ports are conventionally > server ports; the
        # common well-known ports make this reliable enough for offline
        # display, and role only affects stream naming, not reassembly.
        well_known = {80, 8080, 8000, 443, 22, 21, 25, 110, 143, 993, 995}
        if packet.dst.port in well_known:
            return packet.src, packet.dst
        if packet.src.port in well_known:
            return packet.dst, packet.src
        if packet.src.port > packet.dst.port:
            return packet.src, packet.dst
        return packet.dst, packet.src

    def _find_session(self, packet: PacketRecord) -> Optional[Session]:
        pair = tuple(sorted((packet.src, packet.dst)))
        session = self._by_pair.get(pair)
        if session is None:
            return None
        # A fully closed session still absorbs trailing ACKs; only a
        # *new SYN* creates a fresh session (handled by the caller).
        return session

    def _is_retransmitted_syn(self, packet: PacketRecord) -> bool:
        """A pure SYN is a retransmit only while the handshake is open.

        Once the prior connection carried data, FIN, or RST it is no
        longer in the handshake phase; a fresh SYN on the same endpoint
        tuple (even reusing the port and ISN) must open a new session.
        This covers half-open / idle-timeout reconnects whose teardown
        was never captured.
        """
        pair = tuple(sorted((packet.src, packet.dst)))
        session = self._by_pair.get(pair)
        if session is None:
            return False
        stream = session.c2s if packet.src == session.client \
            else session.s2c
        if stream.isn is None or packet.seq != stream.isn:
            return False
        # Any data, FIN or RST means the old connection progressed past
        # the handshake, so this SYN starts a new connection.
        if session.reset:
            return False
        if stream.fin_abs_seq is not None:
            return False
        if len(stream.data) > 0 or stream.pending:
            return False
        return True

    def _both_dirs_closed(self, session: Session) -> bool:
        return (session.c2s.fin_abs_seq is not None
                and session.s2c.fin_abs_seq is not None)

    def _close(self, session: Session, timestamp: float) -> None:
        session.end_time = timestamp

    def _fin_offset(self, stream: DirectedStream) -> Optional[int]:
        if stream.fin_abs_seq is None or stream.isn is None:
            return None
        return seq_sub(stream.fin_abs_seq, stream.isn + 1)

    def _detect_encryption(self, payload: bytes,
                           session: Session) -> Optional[str]:
        if not payload:
            return None
        if payload[:4] == _SSH_PREFIX:
            return "ssh"
        content_type = payload[0]
        if content_type in _TLS_HANDSHAKE or content_type in _TLS_OTHER:
            if len(payload) >= 3 and payload[1] == 0x03 and \
                    payload[2] in (0x00, 0x01, 0x02, 0x03, 0x04):
                return "tls"
        return None

    def _check_memory(self, packet: PacketRecord) -> None:
        total = self._mem_used
        if self.config.keep_frames:
            total += packet.captured_len
        if total > self.config.max_memory_bytes:
            raise LimitExceeded(
                "MEMORY_LIMIT",
                f"reassembly buffer reached {total} bytes, configured "
                f"limit {self.config.max_memory_bytes}; stopping "
                "explicitly instead of dropping segments",
                used=total, limit=self.config.max_memory_bytes)
