"""Regression tests for issues found in the correctness review."""

import os
import tempfile
import unittest

from pcaprecon.analyzer import analyze
from pcaprecon.config import Config
from pcaprecon.reassembly import DirectedStream
from pcaprecon.models import Endpoint, PacketRecord
from pcaprecon.samplegen import (
    PcapWriter, PacketFactory, TcpConn, http_request, http_response,
    ACK, FIN, PSH)


def _pkt(seq, payload, n, off=None):
    return PacketRecord(
        frame_number=n, timestamp=float(n),
        file_offset=off or n * 100, captured_len=len(payload),
        original_len=len(payload), linktype=1, raw_frame=None,
        src=Endpoint("1.1.1.1", 1), dst=Endpoint("2.2.2.2", 2),
        transport="tcp", seq=seq, ack=1, tcp_flags="ACK",
        payload=payload)


def _syn(seq):
    return PacketRecord(
        frame_number=0, timestamp=0.0, file_offset=0, captured_len=0,
        original_len=0, linktype=1, raw_frame=None, seq=seq,
        tcp_flags="SYN", payload=b"")


class ReassemblyReviewTests(unittest.TestCase):
    def test_h2_missing_tail_before_fin_is_a_gap(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "h2.pcap")
        with PcapWriter(path) as w:
            f = PacketFactory(w, TcpConn(client_port=48001))
            f.handshake()
            full = b"GET /a HTTP/1.1\r\nHost: x\r\n\r\n"
            f.client(PSH | ACK, full[:8])
            # FIN promises all 28 bytes even though only 8 were seen.
            f.client(FIN | ACK, seq=f.cseq + (len(full) - 8))
            f.cseq += (len(full) - 8) + 1
            f.server(ACK)
            f.server(FIN | ACK)
            f.client(ACK)
        session = analyze(path).sessions[0]
        self.assertEqual([(g.start, g.end) for g in session.c2s_gaps],
                         [(8, 28)])
        self.assertFalse(session.c2s_complete)

    def test_m1_out_of_order_provenance_keeps_origin_frame(self):
        stream = DirectedStream("c2s", "s")
        stream.note_syn(_syn(1000))
        stream.add_segment(_pkt(1001, b"AAA", 1, 100))
        stream.add_segment(_pkt(1007, b"CCC", 2, 200))   # parked
        stream.add_segment(_pkt(1004, b"BBB", 3, 300))   # unlocks
        frags = stream.provenance_at(6, 3)
        self.assertTrue(frags)
        self.assertTrue(all(f.frame_number == 2 for f in frags))
        self.assertTrue(all(f.packet_file_offset == 200 for f in frags))
        # L1: one parked segment counts once regardless of clipping.
        self.assertEqual(stream.out_of_order, 1)

    def test_h3_negative_content_length_rejected(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "h3.pcap")
        with PcapWriter(path) as w:
            f = PacketFactory(w, TcpConn(client_port=48002))
            f.handshake()
            f.client(PSH | ACK,
                     b"POST /a HTTP/1.1\r\nContent-Length: -5\r\n\r\nBODY!")
            f.server(PSH | ACK, http_response(body=b"ok"))
            f.teardown()
        request = [m for m in analyze(path).sessions[0].messages
                   if m.direction == "request"][0]
        self.assertFalse(request.complete)
        self.assertIn("negative", request.incomplete_reason.lower())

    def test_m2_interim_response_not_paired_or_counted(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "m2.pcap")
        with PcapWriter(path) as w:
            f = PacketFactory(w, TcpConn(client_port=48003))
            f.handshake()
            f.client(PSH | ACK, http_request(
                "POST", "/x", headers={"Expect": "100-continue"}))
            f.server(ACK, b"HTTP/1.1 100 Continue\r\n\r\n")
            f.server(PSH | ACK, http_response(body=b"done"))
            f.teardown()
        messages = analyze(path).sessions[0].messages
        interim = [m for m in messages if m.is_interim]
        finals = [m for m in messages
                  if m.direction == "response" and not m.is_interim]
        self.assertEqual(len(interim), 1)
        self.assertEqual(len(finals), 1)
        self.assertTrue(finals[0].paired_request_id)

    def test_m3_unframed_post_body_not_fabricated_into_request(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "m3.pcap")
        with PcapWriter(path) as w:
            f = PacketFactory(w, TcpConn(client_port=48004))
            f.handshake()
            f.client(PSH | ACK,
                     b"POST /a HTTP/1.1\r\nHost: x\r\n\r\nrawbody")
            f.server(PSH | ACK, http_response(body=b"ok"))
            f.teardown()
        requests = [m for m in analyze(path).sessions[0].messages
                    if m.direction == "request"]
        self.assertEqual(len(requests), 1)
        self.assertFalse(requests[0].complete)

    def test_h1_half_open_reconnect_same_port_and_isn(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "h1.pcap")
        conn = TcpConn(client_port=48010)
        with PcapWriter(path) as w:
            f = PacketFactory(w, conn)
            f.handshake()
            f.client(PSH | ACK, b"old-data")
            f.server(ACK)
            # Peer vanishes; reconnect with same port and same ISN.
            f2 = PacketFactory(w, conn)
            f2.handshake()
            f2.client(PSH | ACK, b"new-data")
            f2.server(ACK)
            f2.teardown()
        result = analyze(path)
        self.assertEqual(len(result.sessions), 2)
        self.assertEqual(bytes(result.sessions[0].c2s_data), b"old-data")
        self.assertEqual(bytes(result.sessions[1].c2s_data), b"new-data")


if __name__ == "__main__":
    unittest.main()
