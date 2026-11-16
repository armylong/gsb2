"""Link-layer / IP / transport decoding.

Every frame is decoded in isolation.  Any failure is recorded as an
:class:`~pcaprecon.models.Anomaly` on the packet and decoding stops for
that frame only — one bad packet never takes down the capture.
"""

from __future__ import annotations

import socket
import struct

from .models import Anomaly, Endpoint, PacketRecord

# pcap LINKTYPE_ values
LT_ETHERNET = 1
LT_NULL = 0
LT_RAW = 12
LT_RAW_OLD = 14
LT_LINUX_SLL = 113
LT_LINUX_SLL2 = 276

ETHERTYPE_IPV4 = 0x0800
ETHERTYPE_IPV6 = 0x86DD
ETHERTYPE_ARP = 0x0806
ETHERTYPE_VLAN = 0x8100
ETHERTYPE_QINQ = 0x88A8

IP_PROTO_ICMP = 1
IP_PROTO_TCP = 6
IP_PROTO_UDP = 17
IP_PROTO_IPV6 = 41
IP_PROTO_ICMPV6 = 58
_IPV6_EXT = {0: 8, 43: 4, 44: 8, 60: 8, 51: None}  # header length (None=AH)

_TCP_FLAG_BITS = [
    (0x01, "FIN"), (0x02, "SYN"), (0x04, "RST"), (0x08, "PSH"),
    (0x10, "ACK"), (0x20, "URG"),
]


def _anomaly(record: PacketRecord, code: str, message: str,
             severity: str = "warning") -> None:
    record.anomalies.append(Anomaly(
        code=code, severity=severity, message=message,
        frame_number=record.frame_number, file_offset=record.file_offset,
        timestamp=record.timestamp))


def _checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\x00"
    total = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def _transport_checksum(src_ip: bytes, dst_ip: bytes, proto: int,
                        segment: bytes) -> int:
    pseudo = src_ip + dst_ip + struct.pack("!BBH", 0, proto, len(segment))
    return _checksum(pseudo + segment)


def decode_packet(record: PacketRecord, config) -> None:
    """Populate L3/L4 fields on ``record``; never raises on bad input."""
    frame = record.raw_frame or b""
    try:
        ethertype, l3 = _parse_link_layer(record, frame)
    except _Unsupported as exc:
        _anomaly(record, "UNSUPPORTED_PROTOCOL", str(exc), "info")
        record.protocol_guess = "unsupported"
        return
    except _Truncated as exc:
        _anomaly(record, "MALFORMED_PACKET", str(exc))
        return

    if ethertype == ETHERTYPE_ARP:
        record.ip_proto = "arp"
        record.protocol_guess = "arp"
        return
    if ethertype == ETHERTYPE_IPV4:
        _parse_ipv4(record, l3, config)
    elif ethertype == ETHERTYPE_IPV6:
        _parse_ipv6(record, l3, config)
    else:
        _anomaly(record, "UNSUPPORTED_PROTOCOL",
                 f"ethertype 0x{ethertype:04x} is not supported", "info")
        record.protocol_guess = "unsupported"


class _Unsupported(Exception):
    pass


class _Truncated(Exception):
    pass


# ---------------------------------------------------------------------------
# Link layers
# ---------------------------------------------------------------------------


def _parse_link_layer(record: PacketRecord, frame: bytes) -> tuple[int, bytes]:
    lt = record.linktype
    if lt == LT_ETHERNET:
        offset = 0
        if len(frame) < 14:
            raise _Truncated("Ethernet frame shorter than 14 bytes")
        ethertype = struct.unpack("!H", frame[12:14])[0]
        offset = 14
        # 802.1Q / QinQ VLAN stacking
        while ethertype in (ETHERTYPE_VLAN, ETHERTYPE_QINQ):
            if len(frame) < offset + 4:
                raise _Truncated("VLAN tag truncated")
            ethertype = struct.unpack("!H", frame[offset + 2:offset + 4])[0]
            offset += 4
        return ethertype, frame[offset:]

    if lt in (LT_RAW, LT_RAW_OLD):
        if not frame:
            raise _Truncated("raw frame empty")
        return (ETHERTYPE_IPV4 if (frame[0] >> 4) == 4
                else ETHERTYPE_IPV6), frame

    if lt == LT_NULL:
        if len(frame) < 4:
            raise _Truncated("loopback header truncated")
        family = struct.unpack("=I", frame[:4])[0]
        if family == 2:
            return ETHERTYPE_IPV4, frame[4:]
        if family in (30, 10):  # AF_INET6 on Darwin / Linux
            return ETHERTYPE_IPV6, frame[4:]
        raise _Unsupported(f"loopback address family {family} unsupported")

    if lt == LT_LINUX_SLL:
        if len(frame) < 16:
            raise _Truncated("Linux cooked capture header truncated")
        ethertype = struct.unpack("!H", frame[14:16])[0]
        return ethertype, frame[16:]

    if lt == LT_LINUX_SLL2:
        if len(frame) < 20:
            raise _Truncated("Linux cooked v2 header truncated")
        ethertype = struct.unpack("!H", frame[0:2])[0]
        return ethertype, frame[20:]

    raise _Unsupported(
        f"linktype {lt} ({_linktype_name(lt)}) is not supported")


def _linktype_name(lt: int) -> str:
    return {1: "Ethernet", 0: "NULL/loopback", 12: "RAW",
            113: "Linux cooked", 276: "Linux cooked v2"}.get(lt, "unknown")


# ---------------------------------------------------------------------------
# IP layers
# ---------------------------------------------------------------------------


def _parse_ipv4(record: PacketRecord, data: bytes, config) -> None:
    if len(data) < 20:
        _anomaly(record, "MALFORMED_PACKET",
                 "IPv4 header shorter than 20 bytes")
        return
    version_ihl = data[0]
    if version_ihl >> 4 != 4:
        _anomaly(record, "MALFORMED_PACKET",
                 f"expected IPv4, got version {version_ihl >> 4}")
        return
    ihl = (version_ihl & 0x0F) * 4
    if ihl < 20 or ihl > len(data):
        _anomaly(record, "MALFORMED_PACKET",
                 f"invalid IPv4 IHL {ihl}")
        return
    total_len = struct.unpack("!H", data[2:4])[0]
    proto = data[9]
    flags_frag = struct.unpack("!H", data[6:8])[0]
    src = socket.inet_ntop(socket.AF_INET, data[12:16])
    dst = socket.inet_ntop(socket.AF_INET, data[16:20])

    if config.verify_checksums and _checksum(data[:ihl]) != 0:
        _anomaly(record, "CHECKSUM_BAD",
                 "IPv4 header checksum mismatch (offload?)", "info")

    if total_len and total_len <= len(data):
        data = data[:total_len]
    elif total_len > len(data):
        _anomaly(record, "PACKET_TRUNCATED",
                 f"IPv4 total length {total_len} exceeds captured "
                 f"{len(data)} bytes")
    if flags_frag & 0x3FFF:  # MF flag or non-zero fragment offset
        record.ip_proto = "ipv4-fragment"
        record.protocol_guess = "ip-fragment"
        _anomaly(record, "IP_FRAGMENTED",
                 "IP fragmentation is not reassembled; transport headers "
                 "of non-first fragments are unavailable", "info")
        return
    _dispatch_transport(record, proto, data[ihl:], data[12:16], data[16:20],
                        src, dst, config)


def _parse_ipv6(record: PacketRecord, data: bytes, config) -> None:
    if len(data) < 40:
        _anomaly(record, "MALFORMED_PACKET",
                 "IPv6 header shorter than 40 bytes")
        return
    if data[0] >> 4 != 6:
        _anomaly(record, "MALFORMED_PACKET",
                 f"expected IPv6, got version {data[0] >> 4}")
        return
    payload_len = struct.unpack("!H", data[4:6])[0]
    proto = data[6]
    src = socket.inet_ntop(socket.AF_INET6, data[8:24])
    dst = socket.inet_ntop(socket.AF_INET6, data[24:40])
    body = data[40:40 + payload_len] if payload_len else data[40:]

    # Extension header chain
    while proto in _IPV6_EXT:
        if proto == 44:  # fragment header
            record.ip_proto = "ipv6-fragment"
            record.protocol_guess = "ip-fragment"
            _anomaly(record, "IP_FRAGMENTED",
                     "IPv6 fragmentation is not reassembled", "info")
            return
        hdr_len = _IPV6_EXT[proto]
        if proto == 51:  # AH: payload length field + 2, in 32-bit units
            if not body:
                _anomaly(record, "MALFORMED_PACKET",
                         "truncated IPv6 AH header")
                return
            hdr_len = (body[1] + 2) * 4
        if len(body) < hdr_len:
            _anomaly(record, "MALFORMED_PACKET",
                     "truncated IPv6 extension header")
            return
        proto = body[0]
        body = body[hdr_len:]
    _dispatch_transport(record, proto, body, data[8:24], data[24:40],
                        src, dst, config)


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------


def _dispatch_transport(record, proto, segment, src_ip, dst_ip,
                        src_text, dst_text, config) -> None:
    if proto == IP_PROTO_TCP:
        record.ip_proto = "tcp"
        _parse_tcp(record, segment, src_ip, dst_ip, src_text, dst_text,
                   config)
    elif proto == IP_PROTO_UDP:
        record.ip_proto = "udp"
        _parse_udp(record, segment, src_ip, dst_ip, src_text, dst_text,
                   config)
    elif proto in (IP_PROTO_ICMP, IP_PROTO_ICMPV6):
        record.ip_proto = "icmp" if proto == IP_PROTO_ICMP else "icmpv6"
        record.protocol_guess = "icmp"
        if len(segment) < 4:
            _anomaly(record, "MALFORMED_PACKET", "ICMP header truncated")
    else:
        record.ip_proto = f"ip-proto-{proto}"
        _anomaly(record, "UNSUPPORTED_PROTOCOL",
                 f"IP protocol number {proto} is not supported", "info")
        record.protocol_guess = "unsupported"


def _parse_tcp(record, segment, src_ip, dst_ip, src_text, dst_text,
               config) -> None:
    if len(segment) < 20:
        _anomaly(record, "MALFORMED_PACKET",
                 "TCP header shorter than 20 bytes")
        return
    sport, dport, seq, ack = struct.unpack("!HHII", segment[:12])
    data_offset = (segment[12] >> 4) * 4
    flags_byte = segment[13]
    if data_offset < 20 or data_offset > len(segment):
        _anomaly(record, "MALFORMED_PACKET",
                 f"invalid TCP data offset {data_offset}")
        return
    flags = "".join(name for bit, name in _TCP_FLAG_BITS if flags_byte & bit)
    payload = segment[data_offset:]

    record.src = Endpoint(src_text, sport)
    record.dst = Endpoint(dst_text, dport)
    record.transport = "tcp"
    record.seq = seq
    record.ack = ack
    record.tcp_flags = flags
    record.payload = payload

    if config.verify_checksums and payload is not None and \
            _transport_checksum(src_ip, dst_ip, IP_PROTO_TCP,
                                segment) != 0:
        _anomaly(record, "CHECKSUM_BAD",
                 "TCP checksum mismatch (offload?)", "info")


def _parse_udp(record, segment, src_ip, dst_ip, src_text, dst_text,
               config) -> None:
    if len(segment) < 8:
        _anomaly(record, "MALFORMED_PACKET", "UDP header truncated")
        return
    sport, dport, length, _csum = struct.unpack("!HHHH", segment[:8])
    if length and length <= len(segment):
        segment = segment[:length]
    record.src = Endpoint(src_text, sport)
    record.dst = Endpoint(dst_text, dport)
    record.transport = "udp"
    record.payload = segment[8:]
    if config.verify_checksums and _csum and \
            _transport_checksum(src_ip, dst_ip, IP_PROTO_UDP,
                                segment) != 0:
        _anomaly(record, "CHECKSUM_BAD",
                 "UDP checksum mismatch (offload?)", "info")
