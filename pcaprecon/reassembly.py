"""TCP stream reassembly — hand-written sequence-space engine.

The engine works in *relative* sequence space: the SYN (or, for
connections already open when the capture starts, the first observed
data segment) defines offset 0.  It handles:

* out-of-order arrival (later segments parked until the gap fills)
* exact duplicates and full retransmissions
* partial overlap retransmissions, keeping the first observed bytes and
  recording conflicting bytes instead of overwriting them
* missing segments, represented as explicit gaps — never filled with
  guesses — so a reader can never mistake gapped data for a full message
* FIN/RST semantics, including a missing tail before a FIN
* mid-capture truncation marking

Every stored byte range keeps the frame number and capture file offset
of the packet that actually carried it, so provenance survives
out-of-order promotion.  All judgement calls (dup / retrans / conflict /
gap) are counters plus anomalies on the owning session.
"""

from __future__ import annotations

import dataclasses
from typing import Optional

from .models import Anomaly, Fragment, Gap, PacketRecord

SEQ_SPACE = 1 << 32
SEQ_MOD_MASK = SEQ_SPACE - 1


def seq_lt(a: int, b: int) -> bool:
    """RFC 793 modular sequence comparison: a < b."""
    return ((a - b) & SEQ_MOD_MASK) & 0x80000000 != 0


def seq_le(a: int, b: int) -> bool:
    return a == b or seq_lt(a, b)


def seq_sub(a: int, b: int) -> int:
    """Signed modular distance a - b (window assumed < 2**31)."""
    d = (a - b) & SEQ_MOD_MASK
    return d - SEQ_SPACE if d >= 0x80000000 else d


@dataclasses.dataclass
class _Pending:
    """A parked, out-of-order byte range plus its origin provenance."""

    data: bytes
    frame_number: int
    packet_file_offset: int
    seq: int


class DirectedStream:
    """One direction of one TCP connection."""

    def __init__(self, direction: str, session_id: str):
        self.direction = direction
        self.session_id = session_id
        self.isn: Optional[int] = None
        # Contiguous reassembled prefix, 1:1 with relative offsets.
        self.data = bytearray()
        # Provenance fragments covering [0, contiguous_len) in order.
        self.fragments: list[Fragment] = []
        # Out-of-order / future bytes: relative offset -> _Pending.
        # Stored intervals never overlap each other or the prefix.
        self.pending: dict[int, _Pending] = {}
        self.gaps: list[Gap] = []
        self.fin_abs_seq: Optional[int] = None
        self.reset = False
        # stats
        self.retransmissions = 0
        self.out_of_order = 0
        self.duplicates = 0
        self.conflicts = 0
        self.anomalies: list[Anomaly] = []

    # -- public API ------------------------------------------------------

    def note_syn(self, packet: PacketRecord) -> None:
        if self.isn is None:
            self.isn = packet.seq

    def handle_rst(self, packet: PacketRecord) -> None:
        self.reset = True

    def note_fin(self, packet: PacketRecord) -> None:
        if self.isn is None and packet.seq is not None:
            # FIN on a half-connection whose SYN was never captured.
            self.isn = seq_sub(packet.seq, 1)
        self.fin_abs_seq = packet.seq

    def add_segment(self, packet: PacketRecord) -> int:
        """Insert a data segment; return number of newly stored bytes."""
        payload = packet.payload
        if not payload:
            return 0
        if packet.seq is None:
            self.anomalies.append(Anomaly(
                "TCP_NO_SEQUENCE", "warning",
                "data segment without sequence number dropped",
                frame_number=packet.frame_number,
                file_offset=packet.file_offset,
                session_id=self.session_id,
                timestamp=packet.timestamp))
            return 0
        if self.isn is None:
            # Capture began mid-connection: treat the first segment's
            # start as offset 0, and flag the missing handshake.
            self.isn = seq_sub(packet.seq, 1)

        rel_start = seq_sub(packet.seq, self.isn + 1)
        if rel_start < 0:
            # Ancient data starting before offset 0: clip the prefix.
            payload = payload[-rel_start:]
            packet = dataclasses.replace(packet, payload=payload)
            rel_start = 0
            if not payload:
                self.duplicates += 1
                return 0

        total_new = self._insert(rel_start, payload, packet)
        # A prefix extension may unlock previously parked segments.
        self._drain_pending()
        return total_new

    def fin_relative_offset(self) -> Optional[int]:
        """Relative offset one past the last byte the FIN promises."""
        if self.fin_abs_seq is None or self.isn is None:
            return None
        return seq_sub(self.fin_abs_seq, self.isn + 1)

    def finalize(self, truncated: bool) -> list[Anomaly]:
        """Close the stream, materialise gaps and return final anomalies."""
        out = list(self.anomalies)

        # 1) Gaps between the contiguous prefix and parked segments, and
        #    between parked segments themselves.
        cursor = len(self.data)
        for start, pend in sorted(self.pending.items()):
            end = start + len(pend.data)
            if end <= cursor:
                continue
            if start > cursor:
                self.gaps.append(Gap(cursor, start))
                out.append(self._gap_anomaly(cursor, start))
            cursor = max(cursor, end)

        # 2) Missing tail: the FIN proves more bytes were sent than we
        #    ever captured, even when nothing was parked beyond them.
        fin_off = self.fin_relative_offset()
        highest = cursor
        if fin_off is not None and fin_off > highest:
            self.gaps.append(Gap(highest, fin_off))
            out.append(self._gap_anomaly(highest, fin_off))
            cursor = fin_off

        # 3) A still-open connection at capture end is partial too.
        if truncated and not self.reset:
            out.append(Anomaly(
                "CAPTURE_CUT_OPEN", "warning",
                f"{self.direction} stream ends with the connection still "
                "open; reassembled content is partial",
                session_id=self.session_id, stream_offset=len(self.data)))
        self.gaps.sort(key=lambda g: g.start)
        return out

    def _gap_anomaly(self, start: int, end: int) -> Anomaly:
        return Anomaly(
            "STREAM_GAP", "warning",
            f"{self.direction} stream missing bytes [{start},{end}) "
            f"({end - start} bytes)",
            session_id=self.session_id, stream_offset=start)

    # -- internals -------------------------------------------------------

    def _insert(self, rel_start: int, payload: bytes,
                packet: PacketRecord) -> int:
        rel_end = rel_start + len(payload)
        contiguous = len(self.data)

        # 1) portion already covered by the contiguous prefix ----------
        if rel_start < contiguous:
            cut = min(rel_end, contiguous) - rel_start
            self._verify_covered(rel_start, payload[:cut], packet)
            rel_start = contiguous
            payload = payload[cut:]
            if not payload:
                return 0

        # 2) remainder lands in / beyond pending space ----------------
        pieces, had_overlap = self._clip_against_pending(
            rel_start, payload, packet)
        if not pieces:
            if had_overlap:
                self.duplicates += 1
            return 0

        new_bytes = 0
        parked_any = False
        for start, buf in pieces:
            if start == len(self.data):
                self.data.extend(buf)
                self.fragments.append(Fragment(
                    stream_offset=start, length=len(buf),
                    frame_number=packet.frame_number,
                    packet_file_offset=packet.file_offset,
                    seq=packet.seq))
            else:
                self.pending[start] = _Pending(
                    data=buf, frame_number=packet.frame_number,
                    packet_file_offset=packet.file_offset,
                    seq=(self.isn + 1 + start) & SEQ_MOD_MASK)
                parked_any = True
            new_bytes += len(buf)
        if parked_any:
            # One out-of-order segment per insert, regardless of how
            # many disjoint pieces it was clipped into.
            self.out_of_order += 1
        if had_overlap:
            # The segment partly re-sent earlier bytes: a retransmit.
            self.retransmissions += 1
        return new_bytes

    def _verify_covered(self, offset: int, payload: bytes,
                        packet: PacketRecord) -> None:
        """First-bytes-wins check against the reassembled prefix."""
        if not payload:
            return
        current = bytes(self.data[offset:offset + len(payload)])
        if current == payload:
            self.duplicates += 1
            self.retransmissions += 1
            return
        self.conflicts += 1
        self.anomalies.append(Anomaly(
            "TCP_CONFLICT", "warning",
            f"{self.direction} retransmission at stream offset {offset} "
            f"(frame {packet.frame_number}) conflicts with previously "
            "reassembled bytes; original bytes retained",
            frame_number=packet.frame_number,
            file_offset=packet.file_offset,
            session_id=self.session_id, stream_offset=offset,
            timestamp=packet.timestamp))

    def _clip_against_pending(self, start: int, payload: bytes,
                              packet: PacketRecord
                              ) -> tuple[list[tuple[int, bytes]], bool]:
        """Subtract all already-pending ranges from a new segment.

        Returns (new pieces, overlapped_existing).  Overlapping bytes
        are compared; mismatches raise a conflict anomaly but never
        overwrite first-seen data.
        """
        end = start + len(payload)
        pieces: list[tuple[int, bytes]] = []
        cursor = start
        had_overlap = False
        for pstart, pend_obj in sorted(self.pending.items()):
            pend = pstart + len(pend_obj.data)
            if pend <= cursor:
                continue
            if pstart >= end:
                break
            if pstart > cursor:
                pieces.append((cursor, payload[cursor - start:pstart - start]))
            overlap_lo = max(cursor, pstart)
            overlap_hi = min(end, pend)
            new_bytes = payload[overlap_lo - start:overlap_hi - start]
            old_bytes = pend_obj.data[
                overlap_lo - pstart:overlap_hi - pstart]
            had_overlap = True
            if new_bytes != old_bytes:
                self.conflicts += 1
                self.anomalies.append(Anomaly(
                    "TCP_CONFLICT", "warning",
                    f"{self.direction} overlapping segment in frame "
                    f"{packet.frame_number} conflicts at stream offsets "
                    f"[{overlap_lo},{overlap_hi}); first-seen bytes kept",
                    frame_number=packet.frame_number,
                    file_offset=packet.file_offset,
                    session_id=self.session_id,
                    stream_offset=overlap_lo,
                    timestamp=packet.timestamp))
            else:
                self.duplicates += 1
                self.retransmissions += 1
            cursor = overlap_hi
        if cursor < end:
            pieces.append((cursor, payload[cursor - start:]))
        return pieces, had_overlap

    def _drain_pending(self) -> None:
        """Promote parked segments that now adjoin the prefix.

        The promoted fragment keeps the *original* packet's identity,
        not the packet that happened to fill the preceding gap.
        """
        progressed = True
        while progressed:
            progressed = False
            for off in sorted(self.pending):
                if off <= len(self.data):
                    pend = self.pending.pop(off)
                    if off < len(self.data):
                        cut = len(self.data) - off
                        if cut >= len(pend.data):
                            progressed = True
                            break
                        pend = _Pending(
                            data=pend.data[cut:],
                            frame_number=pend.frame_number,
                            packet_file_offset=pend.packet_file_offset,
                            seq=(pend.seq + cut) & SEQ_MOD_MASK)
                        off = len(self.data)
                    self.data.extend(pend.data)
                    self.fragments.append(Fragment(
                        stream_offset=off, length=len(pend.data),
                        frame_number=pend.frame_number,
                        packet_file_offset=pend.packet_file_offset,
                        seq=pend.seq, is_out_of_order=True))
                    progressed = True
                    break

    def provenance_at(self, stream_offset: int,
                      length: int = 1) -> list[Fragment]:
        """Return fragments backing a byte range (for trace queries)."""
        out = []
        end = stream_offset + length
        for frag in self.fragments:
            if frag.end <= stream_offset or frag.stream_offset >= end:
                continue
            out.append(frag)
        return out
