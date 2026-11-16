import unittest

from pcaprecon.config import Config
from pcaprecon.reassembly import DirectedStream, seq_sub
from pcaprecon.models import PacketRecord, Anomaly, Endpoint


def _packet(seq: int, payload: bytes, frame_no: int) -> PacketRecord:
    return PacketRecord(
        frame_number=frame_no, timestamp=float(frame_no),
        file_offset=100 * frame_no, captured_len=len(payload) + 40,
        original_len=len(payload) + 40, linktype=1, raw_frame=None,
        src=Endpoint("10.0.0.1", 1234), dst=Endpoint("10.0.0.2", 80),
        transport="tcp", seq=seq, ack=1, tcp_flags="ACK",
        payload=payload)


class ReassemblyTests(unittest.TestCase):
    def setUp(self):
        self.stream = DirectedStream("c2s", "s1")
        # SYN fixes ISN at 1000; first data byte has seq 1001.
        syn = PacketRecord(
            frame_number=0, timestamp=0.0, file_offset=0,
            captured_len=40, original_len=40, linktype=1,
            raw_frame=None, seq=1000, tcp_flags="SYN", payload=b"")
        self.stream.note_syn(syn)

    def test_in_order(self):
        self.stream.add_segment(_packet(1001, b"hello", 1))
        self.stream.add_segment(_packet(1006, b"world", 2))
        self.assertEqual(bytes(self.stream.data), b"helloworld")
        self.assertEqual(self.stream.finalize(False), [])

    def test_out_of_order_promoted(self):
        self.stream.add_segment(_packet(1001, b"AAA", 1))
        self.stream.add_segment(_packet(1007, b"CCC", 3))   # parked
        self.assertEqual(len(self.stream.data), 3)
        self.stream.add_segment(_packet(1004, b"BBB", 2))   # unlocks
        self.assertEqual(bytes(self.stream.data), b"AAABBBCCC")
        self.assertGreaterEqual(self.stream.out_of_order, 1)

    def test_exact_duplicate_is_counted(self):
        self.stream.add_segment(_packet(1001, b"same", 1))
        self.stream.add_segment(_packet(1001, b"same", 2))
        self.assertEqual(bytes(self.stream.data), b"same")
        self.assertEqual(self.stream.duplicates, 1)
        self.assertEqual(self.stream.retransmissions, 1)

    def test_partial_overlap_retransmit(self):
        self.stream.add_segment(_packet(1001, b"ABCDEF", 1))
        self.stream.add_segment(_packet(1004, b"DEFXY", 2))  # overlap+new
        self.assertEqual(bytes(self.stream.data), b"ABCDEFXY")
        self.assertGreaterEqual(self.stream.retransmissions, 1)

    def test_conflicting_bytes_keep_first(self):
        self.stream.add_segment(_packet(1001, b"ABCDEF", 1))
        self.stream.add_segment(_packet(1001, b"AXCDEF", 2))
        self.assertEqual(bytes(self.stream.data), b"ABCDEF")
        self.assertGreaterEqual(self.stream.conflicts, 1)
        self.assertTrue(any(a.code == "TCP_CONFLICT"
                            for a in self.stream.anomalies))

    def test_missing_segment_becomes_gap(self):
        self.stream.add_segment(_packet(1001, b"1234", 1))
        self.stream.add_segment(_packet(1009, b"9012", 3))  # hole [4,8)
        anomalies = self.stream.finalize(False)
        self.assertTrue(any(a.code == "STREAM_GAP" for a in anomalies))
        self.assertEqual([(g.start, g.end) for g in self.stream.gaps],
                         [(4, 8)])
        # Prefix remains trustworthy; parked bytes are not promoted.
        self.assertEqual(bytes(self.stream.data), b"1234")

    def test_sequence_wrap(self):
        # ISN near the 32-bit boundary.
        syn = PacketRecord(frame_number=0, timestamp=0.0, file_offset=0,
                           captured_len=40, original_len=40, linktype=1,
                           raw_frame=None,
                           seq=0xFFFFFFFE, tcp_flags="SYN", payload=b"")
        stream = DirectedStream("s2c", "s1")
        stream.note_syn(syn)
        stream.add_segment(_packet(0xFFFFFFFF, b"wrap", 1))
        stream.add_segment(_packet(0x00000003, b"end", 2))
        self.assertEqual(bytes(stream.data), b"wrapend")
        self.assertEqual(seq_sub(3, 0xFFFFFFFF), 4)


class TruncationTests(unittest.TestCase):
    def test_open_stream_marked_truncated(self):
        stream = DirectedStream("c2s", "s1")
        stream.add_segment(_packet(1001, b"partial", 1))
        anomalies = stream.finalize(truncated=True)
        self.assertTrue(any(a.code == "CAPTURE_CUT_OPEN"
                            for a in anomalies))


if __name__ == "__main__":
    unittest.main()
