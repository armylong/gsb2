import json
import os
import tempfile
import unittest

from ._helpers import analyze_fixture
from pcaprecon.config import Config
from pcaprecon.errors import LimitExceeded
from pcaprecon.filters import Filter
from pcaprecon.redact import Redactor
from pcaprecon.report import build_report, export_json, export_text


class RedactionTests(unittest.TestCase):
    def test_redactor_masks_known_secrets(self):
        r = Redactor()
        self.assertEqual(r.header("Authorization", "Bearer abc.def"),
                         "Bearer " + r.token)
        self.assertEqual(r.header("Cookie", "sid=1"), r.token)
        self.assertNotIn("hunter2",
                         r.query("user=alice&password=hunter2"))
        body = r.body_bytes(
            b'{"email":"a@b.com","password":"hunter2"}',
            "application/json")
        self.assertNotIn(b"hunter2", body)
        self.assertIn(r.token.encode(), body)

    def test_disabled_redaction_preserves_text(self):
        r = Redactor(enabled=False)
        self.assertEqual(r.header("Cookie", "sid=1"), "sid=1")
        self.assertEqual(r.query("password=hunter2"), "password=hunter2")

    def test_pii_patterns(self):
        r = Redactor()
        text = r.text("contact 13812345678 or 11010119900307123X")
        self.assertNotIn("13812345678", text)
        self.assertNotIn("11010119900307123X", text)


class ReportTests(unittest.TestCase):
    def test_json_and_text_export(self):
        result, path = analyze_fixture("keepalive")
        out = tempfile.mkdtemp()
        json_path = export_json(result, os.path.join(out, "r.json"),
                                Redactor())
        text_path = export_text(result, os.path.join(out, "r.txt"),
                                Redactor())
        report = json.load(open(json_path))
        self.assertEqual(report["totals"]["frames"], 15)
        self.assertTrue(open(text_path).read())

    def test_filtered_report(self):
        result, _ = analyze_fixture("keepalive")
        report = build_report(result, Redactor(),
                              Filter(method="GET", path_contains="/second"))
        self.assertEqual(report["totals"]["sessions_after_filter"], 1)
        msgs = report["sessions"][0]["messages"]
        self.assertTrue(any(m["path"] == "/second" for m in msgs))


class LimitTests(unittest.TestCase):
    def test_packet_count_limit_stops_explicitly(self):
        cfg = Config(max_packets=5)
        with self.assertRaises(LimitExceeded) as ctx:
            analyze_fixture("keepalive", cfg)
        self.assertEqual(ctx.exception.code, "PACKET_COUNT_LIMIT")

    def test_file_size_limit(self):
        _, path = analyze_fixture("keepalive")
        cfg = Config(max_file_size_bytes=10)
        with self.assertRaises(LimitExceeded) as ctx:
            from pcaprecon.analyzer import analyze
            analyze(path, cfg)
        self.assertEqual(ctx.exception.code, "FILE_SIZE_LIMIT")

    def test_partial_report_marked_aborted(self):
        cfg = Config(max_packets=5, allow_partial=True)
        result, _ = analyze_fixture("keepalive", cfg)
        self.assertTrue(result.aborted)
        self.assertTrue(any(a.code == "ANALYSIS_ABORTED"
                            for a in result.anomalies))


class CorruptCaptureTests(unittest.TestCase):
    def test_truncated_record_counted_and_stops_cleanly(self):
        result, _ = analyze_fixture("truncated_capture")
        codes = [a.code for a in result.anomalies]
        self.assertIn("CAPTURE_TRUNCATED", codes)
        # Frames before the corruption are still analysed.
        self.assertGreaterEqual(result.total_frames, 5)

    def test_unsupported_protocol_counted(self):
        result, _ = analyze_fixture("unsupported_and_bad")
        self.assertIn("arp", result.protocol_counts)
        codes = [a.code for a in result.anomalies]
        self.assertIn("UNSUPPORTED_PROTOCOL", codes)
        # The good HTTP session beside the bad frames still parses.
        self.assertEqual(len(result.sessions), 1)
        self.assertTrue(any(m.complete for m in
                            result.sessions[0].messages))


if __name__ == "__main__":
    unittest.main()
