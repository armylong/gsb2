import unittest

from ._helpers import analyze_fixture, messages, anomaly_codes, session


class HttpParsingTests(unittest.TestCase):
    def test_keepalive_pipelining_one_session_two_exchanges(self):
        result, _ = analyze_fixture("keepalive")
        self.assertEqual(len(result.sessions), 1)
        reqs = messages(result, "request")
        resps = messages(result, "response")
        self.assertEqual([m.path for m in reqs], ["/first", "/second"])
        self.assertEqual(len(resps), 2)
        for req, resp in zip(reqs, resps):
            self.assertTrue(req.complete)
            self.assertTrue(resp.complete)
            self.assertEqual(resp.paired_request_id, req.message_id)

    def test_chunked_response_decoded_and_complete(self):
        result, _ = analyze_fixture("chunked")
        resp = messages(result, "response")[0]
        self.assertTrue(resp.complete, resp.incomplete_reason)
        self.assertEqual(resp.body_transfer, "chunked")
        self.assertEqual(resp.body, b"hello-chunked-world" * 8)

    def test_content_length_boundary(self):
        result, _ = analyze_fixture("keepalive")
        for resp in messages(result, "response"):
            self.assertEqual(resp.body_transfer, "content-length")
            self.assertEqual(resp.body[:8], b"body of ")

    def test_gap_prevents_complete_request(self):
        result, _ = analyze_fixture("missing_segment")
        req = messages(result, "request")[0]
        self.assertFalse(req.complete)
        self.assertIn("gap", (req.incomplete_reason or "").lower())
        # Known bytes are retained but the body is visibly partial.
        self.assertLess(len(req.body), 300)
        self.assertEqual(req.method, "POST")
        self.assertEqual(req.path, "/upload")

    def test_truncated_response_marked_incomplete(self):
        result, _ = analyze_fixture("truncated_capture")
        resp = messages(result, "response")[0]
        self.assertFalse(resp.complete)
        self.assertTrue(resp.incomplete_reason)
        self.assertTrue(session(result).truncated)

    def test_reorder_retransmit_byte_exact(self):
        result, _ = analyze_fixture("reorder_retransmit")
        s = session(result)
        self.assertEqual(s.c2s_gaps, [])
        self.assertEqual(s.s2c_gaps, [])
        self.assertEqual(s.duplicate_segments, 1)
        self.assertGreaterEqual(s.out_of_order, 1)
        for msg in s.messages:
            self.assertTrue(msg.complete, msg.incomplete_reason)


class EncryptedTests(unittest.TestCase):
    def test_tls_metadata_only(self):
        result, _ = analyze_fixture("encrypted")
        s = session(result)
        self.assertTrue(s.encrypted)
        self.assertEqual(s.encryption_kind, "tls")
        self.assertEqual(s.messages, [])
        self.assertEqual(s.c2s_data, b"")
        self.assertEqual(s.s2c_data, b"")
        self.assertIn("ENCRYPTED_TRAFFIC", anomaly_codes(result))


if __name__ == "__main__":
    unittest.main()
