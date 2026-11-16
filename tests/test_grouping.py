"""失败分组测试：指纹不能只看状态码。"""
from __future__ import annotations

import unittest

from apifuzz.grouping import fingerprint, group_results, normalize_text, skeleton
from apifuzz.models import Case, Evidence
from apifuzz.models import CaseResult


def _ev(status=None, body=None, error=None, path="/x"):
    return Evidence(method="POST", url=path, request_headers={},
                    request_body=None, status=status,
                    response_headers={}, response_body=body,
                    error=error, elapsed_ms=1)


def _result(case_id, endpoint, verdict, evidence, rule="type", path="$.a"):
    case = Case(case_id, endpoint, rule, path, body={"a": 1})
    return CaseResult(case=case, verdict=verdict, evidence=evidence,
                      fingerprint=None, precondition_ok=True)


class TestGrouping(unittest.TestCase):
    def test_same_500_same_shape_grouped_together(self):
        body = {"error": "internal_server_error",
                "message": "AttributeError: 'list' object has no attribute 'startswith'"}
        r1 = _result("c1", "e", "SERVER_ERROR", _ev(500, body))
        r2 = _result("c2", "e", "SERVER_ERROR", _ev(500, dict(body)))
        self.assertEqual(fingerprint(r1), fingerprint(r2))

    def test_same_status_different_message_not_grouped(self):
        b1 = {"error": "internal_server_error", "message": "AttributeError: x"}
        b2 = {"error": "internal_server_error", "message": "TypeError: y"}
        r1 = _result("c1", "e", "SERVER_ERROR", _ev(500, b1))
        r2 = _result("c2", "e", "SERVER_ERROR", _ev(500, b2))
        self.assertNotEqual(fingerprint(r1), fingerprint(r2))

    def test_same_status_different_endpoint_not_grouped(self):
        body = {"error": "internal_server_error", "message": "boom"}
        r1 = _result("c1", "ep_a", "SERVER_ERROR", _ev(500, body))
        r2 = _result("c2", "ep_b", "SERVER_ERROR", _ev(500, body))
        self.assertNotEqual(fingerprint(r1), fingerprint(r2))

    def test_dynamic_numbers_normalized(self):
        b1 = {"error": "internal_server_error",
              "message": "index 12 out of range at line 42"}
        b2 = {"error": "internal_server_error",
              "message": "index 99 out of range at line 7777"}
        r1 = _result("c1", "e", "SERVER_ERROR", _ev(500, b1))
        r2 = _result("c2", "e", "SERVER_ERROR", _ev(500, b2))
        self.assertEqual(fingerprint(r1), fingerprint(r2))

    def test_different_field_paths_not_grouped(self):
        body = {"error": "internal_server_error", "message": "same"}
        r1 = _result("c1", "e", "SERVER_ERROR", _ev(500, body), path="$.a")
        r2 = _result("c2", "e", "SERVER_ERROR", _ev(500, body), path="$.b")
        self.assertNotEqual(fingerprint(r1), fingerprint(r2))

    def test_transport_errors_grouped_by_family(self):
        r1 = _result("c1", "e", "TRANSPORT_ERROR",
                     _ev(error="TimeoutError: timed out"))
        r2 = _result("c2", "e", "TRANSPORT_ERROR",
                     _ev(error="TimeoutError: other detail"))
        self.assertEqual(fingerprint(r1), fingerprint(r2))
        r3 = _result("c3", "e", "TRANSPORT_ERROR",
                     _ev(error="ConnectionRefusedError: nope"))
        self.assertNotEqual(fingerprint(r1), fingerprint(r3))

    def test_group_results_only_contains_anomalies(self):
        ok = _result("c1", "e", "OK", _ev(201, {"ok": True}))
        rejected = _result("c2", "e", "REJECTED", _ev(400, {"message": "bad"}))
        err = _result("c3", "e", "SERVER_ERROR",
                      _ev(500, {"message": "boom"}))
        groups = group_results([ok, rejected, err])
        self.assertEqual(1, len(groups))
        self.assertEqual(1, len(next(iter(groups.values()))))

    def test_skeleton_ignores_scalar_values(self):
        self.assertEqual(
            skeleton({"a": 1, "b": "x", "c": [1, 2, 3]}),
            skeleton({"a": 999, "b": "y", "c": [9]}),
        )

    def test_normalize_text(self):
        self.assertEqual(normalize_text("id 123 and 0xABF failed"),
                         normalize_text("id 456 and 0x12cc failed"))


if __name__ == "__main__":
    unittest.main()
