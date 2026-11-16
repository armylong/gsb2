"""Capture file readers for classic pcap and pcapng.

Implemented from scratch with the standard library so that corrupt
records can be counted with their exact file offset instead of aborting
the whole analysis.  The readers never modify the input file.

Yielded tuples:
    (frame_number, timestamp, file_offset, captured_len, original_len,
     linktype, frame_bytes)

Structural problems are appended to the supplied ``anomalies`` list;
the iteration then stops at the unsafe point rather than reading
garbage as packet metadata.
"""

from __future__ import annotations

import os
import struct
from typing import Iterator, Optional

from .errors import CaptureFormatError, LimitExceeded, MalformedCapture
from .models import Anomaly

PCAP_MAGIC = 0xA1B2C3D4
PCAP_NS_MAGIC = 0xA1B23C4D
PCAPNG_MAGIC = 0x0A0D0D0A
BYTE_ORDER_MAGIC = 0x1A2B3C4D

# pcapng block types
BLK_SHB = 0x0A0D0D0A
BLK_IDB = 0x00000001
BLK_SPB = 0x00000003
BLK_EPB = 0x00000006


class _Interface:
    __slots__ = ("linktype", "snaplen", "ts_resolution")

    def __init__(self, linktype: int = 1, snaplen: int = 65535,
                 ts_resolution: float = 1e-6):
        self.linktype = linktype
        self.snaplen = snaplen
        self.ts_resolution = ts_resolution


def _make_anomaly(code: str, message: str, offset: Optional[int] = None,
                  severity: str = "error") -> Anomaly:
    return Anomaly(code=code, severity=severity, message=message,
                   file_offset=offset)


def read_capture(path: str, config, anomalies: list[Anomaly]):
    """Dispatch to the pcap or pcapng reader based on the magic bytes."""
    size = os.path.getsize(path)
    if size > config.max_file_size_bytes:
        raise LimitExceeded(
            "FILE_SIZE_LIMIT",
            f"capture file is {size} bytes, configured limit is "
            f"{config.max_file_size_bytes} bytes; refusing to start",
            used=size, limit=config.max_file_size_bytes)
    if size < 4:
        raise CaptureFormatError(
            f"{path}: file too small to contain a capture header")

    with open(path, "rb") as fh:
        magic_bytes = fh.read(4)
        magic_le = struct.unpack("<I", magic_bytes)[0]
        magic_be = struct.unpack(">I", magic_bytes)[0]
        if magic_le in (PCAP_MAGIC, PCAP_NS_MAGIC) or \
                magic_be in (PCAP_MAGIC, PCAP_NS_MAGIC):
            fh.seek(0)
            yield from _read_pcap_classic(fh, config, anomalies)
        elif magic_le == PCAPNG_MAGIC or magic_be == PCAPNG_MAGIC:
            fh.seek(0)
            yield from _read_pcapng(fh, config, anomalies)
        else:
            raise CaptureFormatError(
                f"{path}: unrecognised capture magic {magic_bytes.hex()} "
                "(expected pcap or pcapng)")


# ---------------------------------------------------------------------------
# Classic pcap
# ---------------------------------------------------------------------------


def _read_pcap_classic(fh, config, anomalies: list[Anomaly]
                       ) -> Iterator[tuple]:
    header = fh.read(24)
    if len(header) < 24:
        raise MalformedCapture("pcap global header truncated")
    magic_le = struct.unpack("<I", header[:4])[0]
    if magic_le in (PCAP_MAGIC, PCAP_NS_MAGIC):
        endian = "<"
        magic = magic_le
    else:
        magic_be = struct.unpack(">I", header[:4])[0]
        if magic_be not in (PCAP_MAGIC, PCAP_NS_MAGIC):  # pragma: no cover
            raise CaptureFormatError("bad pcap magic")
        endian = ">"
        magic = magic_be
    nano = magic == PCAP_NS_MAGIC
    ts_scale = 1e-9 if nano else 1e-6
    linktype = struct.unpack(endian + "I", header[20:24])[0] & 0xFFFF

    frame_no = 0
    hdr_struct = struct.Struct(endian + "IIII")
    while True:
        rec_offset = fh.tell()
        prefix = fh.read(16)
        if not prefix:
            return
        if len(prefix) < 16:
            anomalies.append(_make_anomaly(
                "CAPTURE_TRUNCATED",
                f"file ends in the middle of a packet record header at "
                f"offset {rec_offset} ({len(prefix)}/16 bytes)",
                rec_offset))
            return
        ts_sec, ts_frac, incl_len, orig_len = hdr_struct.unpack(prefix)
        if incl_len > config.max_memory_bytes:
            raise LimitExceeded(
                "PACKET_SIZE_LIMIT",
                f"frame at offset {rec_offset} claims {incl_len} bytes, "
                f"exceeding memory limit {config.max_memory_bytes}",
                used=incl_len, limit=config.max_memory_bytes)
        data = fh.read(incl_len)
        if len(data) < incl_len:
            anomalies.append(_make_anomaly(
                "CAPTURE_TRUNCATED",
                f"frame #{frame_no + 1} header at offset {rec_offset} "
                f"promises {incl_len} bytes but only {len(data)} remain; "
                "packet and all later packets are unavailable",
                rec_offset))
            return
        frame_no += 1
        if frame_no > config.max_packets:
            raise LimitExceeded(
                "PACKET_COUNT_LIMIT",
                f"packet count limit {config.max_packets} reached at "
                f"offset {rec_offset}; stopping explicitly (no packets "
                "silently dropped)",
                used=frame_no, limit=config.max_packets)
        yield (frame_no, ts_sec + ts_frac * ts_scale, rec_offset,
               incl_len, orig_len, linktype, data)


# ---------------------------------------------------------------------------
# pcapng
# ---------------------------------------------------------------------------


def _parse_options(blob: bytes, endian: str) -> dict[int, list[bytes]]:
    opts: dict[int, list[bytes]] = {}
    i = 0
    while i + 4 <= len(blob):
        code, length = struct.unpack(endian + "HH", blob[i:i + 4])
        if code == 0:
            break
        padded = (length + 3) & ~3
        if i + 4 + padded > len(blob):
            break
        opts.setdefault(code, []).append(blob[i + 4:i + 4 + length])
        i += 4 + padded
    return opts


def _read_pcapng(fh, config, anomalies: list[Anomaly]) -> Iterator[tuple]:
    interfaces: list[_Interface] = []
    default_iface = _Interface()
    frame_no = 0
    endian = "<"  # corrected by the first Section Header Block

    while True:
        block_offset = fh.tell()
        header = fh.read(8)
        if not header:
            return
        if len(header) < 8:
            anomalies.append(_make_anomaly(
                "CAPTURE_TRUNCATED",
                f"pcapng block header truncated at offset {block_offset}",
                block_offset))
            return
        # The SHB type is a byte-palindrome (0x0A0D0D0A) so it reads
        # identically in either endianness; that is how we locate the
        # first SHB before the byte order is known.
        shb_type = struct.unpack("<I", header[:4])[0]

        if shb_type == BLK_SHB:
            bom = fh.read(4)
            if len(bom) < 4:
                anomalies.append(_make_anomaly(
                    "CAPTURE_TRUNCATED",
                    f"SHB byte-order magic missing at offset "
                    f"{block_offset}", block_offset))
                return
            if struct.unpack("<I", bom)[0] == BYTE_ORDER_MAGIC:
                endian = "<"
            elif struct.unpack(">I", bom)[0] == BYTE_ORDER_MAGIC:
                endian = ">"
            else:
                anomalies.append(_make_anomaly(
                    "PCAPNG_BAD_BYTE_ORDER",
                    f"invalid byte-order magic in SHB at offset "
                    f"{block_offset}", block_offset))
                return
            block_total = struct.unpack(endian + "I", header[4:8])[0]
            if block_total < 16 or block_total > config.max_file_size_bytes:
                anomalies.append(_make_anomaly(
                    "PCAPNG_BAD_BLOCK",
                    f"implausible SHB length {block_total} at offset "
                    f"{block_offset}", block_offset))
                return
            rest = fh.read(block_total - 12)  # 8 header + 4 BOM consumed
            if len(rest) < block_total - 12:
                anomalies.append(_make_anomaly(
                    "CAPTURE_TRUNCATED",
                    f"SHB at offset {block_offset} truncated",
                    block_offset))
                return
            tail = struct.unpack(endian + "I", rest[-4:])[0]
            if tail != block_total:
                anomalies.append(_make_anomaly(
                    "PCAPNG_BAD_BLOCK",
                    f"SHB trailing length mismatch at offset "
                    f"{block_offset}", block_offset))
                return
            interfaces = []
            continue

        # Re-read the block type with the section's resolved endianness;
        # IDB/EPB/SPB constants are not byte-palindromic.
        block_type = struct.unpack(endian + "I", header[:4])[0]
        block_total = struct.unpack(endian + "I", header[4:8])[0]
        if block_total < 12 or block_total % 4 != 0:
            anomalies.append(_make_anomaly(
                "PCAPNG_BAD_BLOCK",
                f"invalid block length {block_total} for block type "
                f"0x{block_type:08x} at offset {block_offset}; cannot "
                "safely continue", block_offset))
            return
        body_and_tail = fh.read(block_total - 8)
        if len(body_and_tail) < block_total - 8:
            anomalies.append(_make_anomaly(
                "CAPTURE_TRUNCATED",
                f"block type 0x{block_type:08x} at offset {block_offset} "
                "is truncated", block_offset))
            return
        body = body_and_tail[:-4]
        tail_len = struct.unpack(endian + "I", body_and_tail[-4:])[0]
        if tail_len != block_total:
            anomalies.append(_make_anomaly(
                "PCAPNG_BAD_BLOCK",
                f"trailing block length mismatch at offset {block_offset}",
                block_offset))
            return

        if block_type == BLK_IDB:
            if len(body) < 8:
                anomalies.append(_make_anomaly(
                    "PCAPNG_BAD_BLOCK",
                    f"IDB at offset {block_offset} too short",
                    block_offset))
                continue
            linktype, _reserved, snaplen = struct.unpack(
                endian + "HHI", body[:8])
            iface = _Interface(linktype=linktype, snaplen=snaplen)
            for value in _parse_options(body[8:], endian).get(9, []):
                if value:
                    b = value[0]
                    base = 10.0 if b & 0x80 else 2.0
                    iface.ts_resolution = base ** -(b & 0x7F)
            interfaces.append(iface)

        elif block_type == BLK_EPB:
            if len(body) < 20:
                anomalies.append(_make_anomaly(
                    "PCAPNG_BAD_BLOCK",
                    f"EPB at offset {block_offset} too short",
                    block_offset))
                continue
            iface_id, ts_hi, ts_lo, cap_len, orig_len = struct.unpack(
                endian + "IIIII", body[:20])
            iface = (interfaces[iface_id] if iface_id < len(interfaces)
                     else default_iface)
            pkt = body[20:20 + cap_len]
            if len(pkt) < cap_len:
                anomalies.append(_make_anomaly(
                    "CAPTURE_TRUNCATED",
                    f"EPB at offset {block_offset} packet data truncated",
                    block_offset))
                continue
            frame_no += 1
            if frame_no > config.max_packets:
                raise LimitExceeded(
                    "PACKET_COUNT_LIMIT",
                    f"packet count limit {config.max_packets} reached at "
                    f"offset {block_offset}; stopping explicitly",
                    used=frame_no, limit=config.max_packets)
            ts = ((ts_hi << 32) | ts_lo) * iface.ts_resolution
            yield (frame_no, ts, block_offset, cap_len, orig_len,
                   iface.linktype, pkt)

        elif block_type == BLK_SPB:
            if len(body) < 4:
                anomalies.append(_make_anomaly(
                    "PCAPNG_BAD_BLOCK",
                    f"SPB at offset {block_offset} too short",
                    block_offset))
                continue
            orig_len = struct.unpack(endian + "I", body[:4])[0]
            iface = interfaces[0] if interfaces else default_iface
            # SPB has no captured-length field.  The packet occupies the
            # first min(orig_len, stored) bytes; any remainder is 4-byte
            # block padding and must never be decoded as frame bytes.
            stored = len(body) - 4
            cap_len = min(orig_len, stored - (stored % 4))
            pkt = body[4:4 + cap_len]
            frame_no += 1
            if frame_no > config.max_packets:
                raise LimitExceeded(
                    "PACKET_COUNT_LIMIT",
                    f"packet count limit {config.max_packets} reached at "
                    f"offset {block_offset}; stopping explicitly",
                    used=frame_no, limit=config.max_packets)
            yield (frame_no, 0.0, block_offset, cap_len, orig_len,
                   iface.linktype, pkt)
        # Other block types (NRB, ISB, custom, ...) are skipped by
        # design; their framing is still validated above.
