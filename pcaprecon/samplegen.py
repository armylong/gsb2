"""Generate small, fully local pcap samples for demos and tests.

No external tools are required: Ethernet/IP/TCP headers are built by
hand and written in classic pcap format (LINKTYPE_ETHERNET).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from .decode import _checksum, _transport_checksum

ETH_HDR = 14
IP_HDR = 20
TCP_HDR = 20
CLIENT_MAC = b"\x02\x00\x00\x00\x00\x01"
SERVER_MAC = b"\x02\x00\x00\x00\x00\x02"


# ---------------------------------------------------------------------------
# Classic pcap writer
# ---------------------------------------------------------------------------


class PcapWriter:
    def __init__(self, path: str, linktype: int = 1):
        self.path = path
        self.linktype = linktype
        self._fh = open(path, "wb")
        self._fh.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0,
                                   65535, linktype))
        self._ts = 1_700_000_000.0
        self.frame_no = 0

    def write_frame(self, frame: bytes, step: float = 0.001) -> int:
        self.frame_no += 1
        sec = int(self._ts)
        usec = int(round((self._ts - sec) * 1_000_000))
        self._fh.write(struct.pack("<IIII", sec, usec, len(frame),
                                   len(frame)))
        self._fh.write(frame)
        self._ts += step
        return self.frame_no

    def write_raw_record(self, incl_len: int, orig_len: int,
                         payload: bytes) -> None:
        """Write a deliberately broken record (truncation fixtures)."""
        sec = int(self._ts)
        self._fh.write(struct.pack("<IIII", sec, 0, incl_len, orig_len))
        self._fh.write(payload)

    def close(self) -> None:
        self._fh.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ---------------------------------------------------------------------------
# Packet builders
# ---------------------------------------------------------------------------


@dataclass
class TcpConn:
    client_ip: str = "10.0.0.10"
    server_ip: str = "10.0.0.1"
    client_port: int = 40000
    server_port: int = 80
    client_isn: int = 1000
    server_isn: int = 5000

    def key(self):
        return (self.client_ip, self.client_port,
                self.server_ip, self.server_port)


def _ethernet(ethertype: int, src: bytes, dst: bytes) -> bytes:
    return dst + src + struct.pack("!H", ethertype)


def _ipv4(src: str, dst: str, proto: int, payload: bytes,
          identification: int = 0) -> bytes:
    ver_ihl = 0x45
    tos = 0
    total = IP_HDR + len(payload)
    flags_frag = 0
    ttl = 64
    header = struct.pack("!BBHHHBBH4s4s",
                         ver_ihl, tos, total, identification, flags_frag,
                         ttl, proto, 0,
                         _ip_bytes(src), _ip_bytes(dst))
    csum = _checksum(header)
    header = struct.pack("!BBHHHBBH4s4s",
                         ver_ihl, tos, total, identification, flags_frag,
                         ttl, proto, csum,
                         _ip_bytes(src), _ip_bytes(dst))
    return header + payload


def _ip_bytes(text: str) -> bytes:
    import socket
    return socket.inet_aton(text)


def _tcp(src_ip: str, dst_ip: str, sport: int, dport: int, seq: int,
         ack: int, flags: int, payload: bytes = b"",
         window: int = 65535) -> bytes:
    off_res = (TCP_HDR // 4) << 4
    header = struct.pack("!HHIIBBHHH", sport, dport, seq, ack, off_res,
                         flags, window, 0, 0)
    csum = _transport_checksum(_ip_bytes(src_ip), _ip_bytes(dst_ip), 6,
                               header + payload)
    header = struct.pack("!HHIIBBHHH", sport, dport, seq, ack, off_res,
                         flags, window, csum, 0)
    return header + payload


FIN, SYN, RST, PSH, ACK = 0x01, 0x02, 0x04, 0x08, 0x10


class PacketFactory:
    """Emit Ethernet/IP/TCP frames while tracking connection SEQ numbers."""

    def __init__(self, writer: PcapWriter, conn: TcpConn):
        self.w = writer
        self.c = conn
        self.cseq = conn.client_isn
        self.sseq = conn.server_isn

    def _frame(self, src_ip, dst_ip, sport, dport, seq, ack, flags,
               payload, src_mac, dst_mac):
        tcp = _tcp(src_ip, dst_ip, sport, dport, seq, ack, flags, payload)
        ip = _ipv4(src_ip, dst_ip, 6, tcp)
        frame = _ethernet(0x0800, src_mac, dst_mac) + ip
        self.w.write_frame(frame)

    def client(self, flags: int = ACK, payload: bytes = b"",
               seq: int | None = None, ack: int | None = None):
        use_seq = self.cseq if seq is None else seq
        use_ack = self.sseq + 1 if ack is None else ack
        self._frame(self.c.client_ip, self.c.server_ip,
                    self.c.client_port, self.c.server_port,
                    use_seq, use_ack, flags, payload,
                    CLIENT_MAC, SERVER_MAC)
        # Explicit seq means the caller manages the sequence bookkeeping.
        if seq is None:
            self.cseq += len(payload) + (1 if flags & SYN else 0) \
                + (1 if flags & FIN else 0)

    def server(self, flags: int = ACK, payload: bytes = b"",
               seq: int | None = None, ack: int | None = None):
        use_seq = self.sseq if seq is None else seq
        use_ack = self.cseq + 1 if ack is None else ack
        self._frame(self.c.server_ip, self.c.client_ip,
                    self.c.server_port, self.c.client_port,
                    use_seq, use_ack, flags, payload,
                    SERVER_MAC, CLIENT_MAC)
        # Explicit seq means the caller manages the sequence bookkeeping.
        if seq is None:
            self.sseq += len(payload) + (1 if flags & SYN else 0) \
                + (1 if flags & FIN else 0)

    def handshake(self):
        self.client(SYN)
        self.server(SYN | ACK)
        self.client(ACK)

    def teardown(self):
        self.client(FIN | ACK)
        self.server(ACK)
        self.server(FIN | ACK)
        self.client(ACK)


def http_request(method: str = "GET", path: str = "/",
                 host: str = "example.com", headers: dict | None = None,
                 body: bytes = b"") -> bytes:
    headers = dict(headers or {})
    headers.setdefault("Host", host)
    headers.setdefault("User-Agent", "pcaprecon-sample/1.0")
    headers.setdefault("Accept", "*/*")
    if body and "Content-Length" not in headers:
        headers["Content-Length"] = str(len(body))
    head = f"{method} {path} HTTP/1.1\r\n"
    head += "".join(f"{k}: {v}\r\n" for k, v in headers.items())
    return (head + "\r\n").encode() + body


def http_response(status: int = 200, reason: str = "OK",
                  headers: dict | None = None, body: bytes = b"",
                  chunked: bool = False) -> bytes:
    headers = dict(headers or {})
    if chunked:
        headers["Transfer-Encoding"] = "chunked"
        head = f"HTTP/1.1 {status} {reason}\r\n"
        head += "".join(f"{k}: {v}\r\n" for k, v in headers.items())
        out = (head + "\r\n").encode()
        for i in range(0, len(body), 32):
            part = body[i:i + 32]
            out += f"{len(part):X}\r\n".encode() + part + b"\r\n"
        out += b"0\r\n\r\n"
        return out
    headers.setdefault("Content-Length", str(len(body)))
    head = f"HTTP/1.1 {status} {reason}\r\n"
    head += "".join(f"{k}: {v}\r\n" for k, v in headers.items())
    return (head + "\r\n").encode() + body


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


def scenario_reorder_retransmit(path: str) -> str:
    """Out-of-order delivery plus an exact duplicate retransmission."""
    with PcapWriter(path) as w:
        f = PacketFactory(w, TcpConn())
        f.handshake()
        req = http_request("GET", "/index.html")
        f.client(PSH | ACK, req)
        f.server(ACK)

        body = b"".join(bytes([65 + (i % 26)]) * 40 for i in range(20))
        resp = http_response(body=body)
        # Three non-overlapping segments covering the whole response;
        # deliver them out of order (middle last), then re-send the
        # first as an exact duplicate retransmission.
        p1, p2, p3 = resp[:200], resp[200:400], resp[400:]
        dup_seq = f.sseq
        f.server(ACK, p1)                                  # offsets 0..200
        f.server(ACK, p3, seq=dup_seq + 400)               # 400..end (ooo)
        f.server(ACK, p2, seq=dup_seq + 200)               # 200..400 fills
        f.server(ACK, p1, seq=dup_seq)                     # exact duplicate
        f.sseq = dup_seq + len(resp)
        f.client(ACK)
        f.teardown()
    return path


def scenario_keepalive(path: str) -> str:
    """Two pipelined/sequential HTTP requests on one connection."""
    with PcapWriter(path) as w:
        f = PacketFactory(w, TcpConn())
        f.handshake()
        for path_ in ("/first", "/second"):
            f.client(PSH | ACK, http_request("GET", path_))
            f.server(ACK)
            f.server(PSH | ACK, http_response(
                body=f"body of {path_}".encode()))
            f.client(ACK)
        f.teardown()
    return path


def scenario_missing_segment(path: str) -> str:
    """A middle segment is absent: explicit gap, message stays incomplete."""
    with PcapWriter(path) as w:
        f = PacketFactory(w, TcpConn())
        f.handshake()
        f.client(PSH | ACK, http_request("POST", "/upload",
                                         headers={"Content-Length": "300"}))
        body = b"X" * 300
        f.client(ACK, body[:100])
        # Skip bytes [100,200) by emitting the tail with a sequence
        # number 100 bytes ahead; the caller owns bookkeeping here.
        f.client(ACK, body[200:], seq=f.cseq + 100)
        f.cseq += 300
        f.server(ACK)
        f.server(PSH | ACK, http_response(status=202, body=b"accepted"))
        f.teardown()
    return path


def scenario_truncated_capture(path: str) -> str:
    """The pcap itself is cut mid-frame and the connection stays open."""
    with PcapWriter(path) as w:
        f = PacketFactory(w, TcpConn())
        f.handshake()
        f.client(PSH | ACK, http_request("GET", "/long"))
        f.server(ACK)
        resp = http_response(body=b"Z" * 500)
        f.server(ACK, resp[:250])
        # Append a record header promising more bytes than exist.
        w.write_raw_record(incl_len=1200, orig_len=1200,
                           payload=resp[250:300])
    return path


def scenario_chunked(path: str) -> str:
    """Chunked response delivered across several TCP segments."""
    with PcapWriter(path) as w:
        f = PacketFactory(w, TcpConn())
        f.handshake()
        f.client(PSH | ACK, http_request("GET", "/stream"))
        f.server(ACK)
        resp = http_response(chunked=True, body=b"hello-chunked-world" * 8)
        for i in range(0, len(resp), 97):
            f.server(ACK, resp[i:i + 97])
        f.client(ACK)
        f.teardown()
    return path


def scenario_encrypted(path: str) -> str:
    """TLS handshake + application data: metadata only, no decode."""
    with PcapWriter(path) as w:
        f = PacketFactory(w, TcpConn())
        f.handshake()
        tls_client_hello = bytes([0x16, 0x03, 0x01, 0x00, 0x10]) + \
            b"\x01" * 16
        tls_server_hello = bytes([0x16, 0x03, 0x03, 0x00, 0x10]) + \
            b"\x02" * 16
        tls_app = bytes([0x17, 0x03, 0x03, 0x00, 0x20]) + b"\xee" * 32
        f.client(PSH | ACK, tls_client_hello)
        f.server(ACK, tls_server_hello)
        f.client(ACK, tls_app)
        f.teardown()
    return path


def scenario_reconnect(path: str) -> str:
    """Same endpoint pair twice: must become two separate sessions.

    The second connection even reuses the client port, so the endpoint
    tuple is identical — only the fresh SYN distinguishes the sessions.
    """
    with PcapWriter(path) as w:
        conn = TcpConn(client_port=40001)
        for _ in range(2):
            f = PacketFactory(w, conn)
            f.handshake()
            f.client(PSH | ACK, http_request("GET", "/reconnect"))
            f.server(PSH | ACK, http_response(body=b"ok"))
            f.teardown()
    return path


def scenario_conflict(path: str) -> str:
    """Retransmission carrying different bytes at the same sequence."""
    with PcapWriter(path) as w:
        f = PacketFactory(w, TcpConn())
        f.handshake()
        f.client(PSH | ACK, http_request("GET", "/conflict"))
        original = http_response(body=b"original-bytes-here!!")
        base_seq = f.sseq
        # Original, full segment.
        f.server(ACK, original)
        # Same start sequence, different payload: a conflicting
        # retransmission.  First-seen bytes must be retained.
        corrupted = b"HTTP/1.1 200 OK\r\nXXXX-CORRUPTED-PAYLOAD-XXXX"
        f.server(ACK, corrupted, seq=base_seq)
        f.client(ACK)
        f.teardown()
    return path


def scenario_unsupported_and_bad(path: str) -> str:
    """An ARP frame and a truncated Ethernet frame, plus good HTTP."""
    with PcapWriter(path) as w:
        # ARP (ethertype 0x0806), full 60-byte minimum Ethernet frame.
        arp = (b"\xff" * 6 + CLIENT_MAC +
               struct.pack("!H", 0x0806) + b"\x00" * 46)
        w.write_frame(arp)
        # Unknown ethertype: recognised framing, unsupported protocol.
        unknown = (SERVER_MAC + CLIENT_MAC +
                   struct.pack("!H", 0x9999) + b"\x00" * 46)
        w.write_frame(unknown)
        f = PacketFactory(w, TcpConn())
        f.handshake()
        f.client(PSH | ACK, http_request("GET", "/"))
        f.server(PSH | ACK, http_response(body=b"hello"))
        f.teardown()
        # Truncated Ethernet frame (only 6 bytes)
        w.write_raw_record(incl_len=6, orig_len=60, payload=b"\x00" * 6)
    return path


SCENARIOS = {
    "reorder_retransmit": scenario_reorder_retransmit,
    "keepalive": scenario_keepalive,
    "missing_segment": scenario_missing_segment,
    "truncated_capture": scenario_truncated_capture,
    "chunked": scenario_chunked,
    "encrypted": scenario_encrypted,
    "reconnect": scenario_reconnect,
    "conflict": scenario_conflict,
    "unsupported_and_bad": scenario_unsupported_and_bad,
}


def generate_all(out_dir: str) -> dict[str, str]:
    import os
    os.makedirs(out_dir, exist_ok=True)
    written = {}
    for name, fn in SCENARIOS.items():
        target = os.path.join(out_dir, f"{name}.pcap")
        fn(target)
        written[name] = target
    return written
