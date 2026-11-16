import unittest

from ._helpers import analyze_fixture, anomaly_codes, session
from pcaprecon.trace import trace_frame, trace_message, trace_bytes


class SessionTests(unittest.TestCase):
    def test_reconnect_splits_sessions(self):
        result, _ = analyze_fixture("reconnect")
        self.assertEqual(len(result.sessions), 2)
        ids = {s.session_id for s in result.sessions}
        self.assertEqual(len(ids), 2)
        # The endpoint pair is identical (port reused); only the fresh
        # SYN distinguishes the two connections.
        self.assertEqual(result.sessions[0].key,
                         result.sessions[1].key)
        self.assertNotEqual(result.sessions[0].start_time,
                            result.sessions[1].start_time)

    def test_conflict_recorded_first_bytes_kept(self):
        result, _ = analyze_fixture("conflict")
        s = session(result)
        self.assertGreaterEqual(s.conflict_segments, 1)
        self.assertIn("TCP_CONFLICT", anomaly_codes(result))
        # Original prefix bytes survive.
        self.assertTrue(bytes(s.s2c_data).startswith(b"HTTP/1.1 200"))


class TraceTests(unittest.TestCase):
    def test_frame_to_session_and_back(self):
        result, _ = analyze_fixture("keepalive")
        info = trace_frame(result, 8)
        self.assertTrue(info["found"])
        self.assertEqual(info["session_id"], result.sessions[0].session_id)
        self.assertIn(info["role"], ("psh+data", "data"))

        # Reverse direction: message -> frames -> file offsets.
        req = result.sessions[0].messages[0]
        evidence = trace_message(result, req)
        self.assertTrue(evidence)
        frame_numbers = {e.frame_number for e in evidence}
        self.assertIn(4, frame_numbers)
        for ev in evidence:
            self.assertGreaterEqual(ev.file_offset, 0)

    def test_byte_range_lookup(self):
        result, _ = analyze_fixture("keepalive")
        sid = result.sessions[0].session_id
        evidence = trace_bytes(result, sid, "c2s", 0, 10)
        self.assertTrue(evidence)
        self.assertTrue(all(e.length > 0 for e in evidence))

    def test_missing_frame(self):
        result, _ = analyze_fixture("keepalive")
        self.assertFalse(trace_frame(result, 9999)["found"])


if __name__ == "__main__":
    unittest.main()
