"""样本缩减测试：严格接受标准、超时不算成功、最终回退保护。"""
from __future__ import annotations

import copy
import unittest

from apifuzz.config import Endpoint
from apifuzz.grouping import fingerprint
from apifuzz.models import Case, CaseResult, Evidence
from apifuzz.reducer import Reducer


def _evidence(status=500, body=None, error=None):
    return Evidence(method="POST", url="/x", request_headers={},
                    request_body=None, status=status,
                    response_headers={},
                    response_body=body if body is not None else
                    {"error": "internal_server_error",
                     "message": "AttributeError: boom"},
                    error=error, elapsed_ms=1)


def _case(body, rule="type", path="$.a", raw=False):
    return Case("orig-1", "ep", rule, path, body=body, raw_body=raw)


def _result(case, verdict="SERVER_ERROR", evidence=None):
    result = CaseResult(case=case, verdict=verdict,
                        evidence=evidence or _evidence(),
                        fingerprint=None, precondition_ok=True)
    result.fingerprint = fingerprint(result)
    return result


class ScriptedTrial:
    """按脚本返回结果的 trial：模拟服务恢复/超时等情形。"""

    def __init__(self, mode="always_fail", required_key=None):
        self.mode = mode
        self.required_key = required_key
        self.calls = 0

    def __call__(self, case: Case) -> CaseResult:
        self.calls += 1
        if self.mode == "timeout_on_reduction":
            # 原始样本失败；任何缩减后的样本都超时
            if case.case_id == "orig-1":
                return _result(case)
            return CaseResult(
                case=case, verdict="TRANSPORT_ERROR",
                evidence=_evidence(status=None, body=None,
                                   error="TimeoutError: timed out"),
                fingerprint=None, precondition_ok=True)
        if self.mode == "recovers_when_key_removed" and self.required_key:
            if self.required_key not in json_keys(case.body):
                return CaseResult(
                    case=case, verdict="OK",
                    evidence=_evidence(status=201, body={"ok": True}),
                    fingerprint=None, precondition_ok=True)
        if self.mode == "indeterminate_on_reduction" and case.case_id != "orig-1":
            return CaseResult(
                case=case, verdict="INDETERMINATE",
                evidence=_evidence(status=None, body=None,
                                   error="precondition failed"),
                fingerprint=None, precondition_ok=False)
        return _result(case)


def json_keys(obj, prefix="$"):
    keys = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.add(f"{prefix}.{k}")
            keys |= json_keys(v, f"{prefix}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            keys |= json_keys(v, f"{prefix}[{i}]")
    return keys


class TestReducer(unittest.TestCase):
    EP = Endpoint.from_dict({
        "name": "ep", "method": "POST", "path": "/x",
        "sample": {"trigger": 1, "noise": "abcdefghij" * 100,
                   "keep": {"deep": {"x": 1}}},
    })

    def test_irrelevant_fields_removed_and_failure_reproduced(self):
        original_body = {"trigger": [1, 2],
                         "noise": "Z" * 500,
                         "extra": {"a": 1, "b": 2}}
        original = _result(_case(original_body))
        trial = ScriptedTrial("recovers_when_key_removed",
                              required_key="$.trigger")
        report = Reducer(trial).reduce(self.EP, original)
        self.assertTrue(report["reproduced"])
        self.assertNotIn("noise", report["after"]["body"])
        self.assertNotIn("extra", report["after"]["body"])
        self.assertIn("trigger", report["after"]["body"])
        self.assertGreater(report["trials_accepted"], 0)
        # 被拒绝的候选（删掉 trigger 后服务恢复）必须有记录
        self.assertGreater(report["trials_rejected"], 0)

    def test_timeout_during_reduction_is_not_success(self):
        original = _result(_case({"trigger": 1, "noise": "A" * 400}))
        trial = ScriptedTrial("timeout_on_reduction")
        report = Reducer(trial).reduce(self.EP, original)
        # 所有候选都超时 -> 没有任何接受，最终验证也超时 -> 回退原始样本
        self.assertEqual(report["trials_accepted"], 0)
        self.assertGreater(report["trials_inconclusive"], 0)
        self.assertFalse(report["reproduced"])
        self.assertEqual(report["after"]["body"], original.case.body)
        stage_notes = " ".join(s.get("reason", "") for s in report["stages"])
        self.assertIn("无法判断", stage_notes)

    def test_indeterminate_verdict_rejects_candidate(self):
        original = _result(_case({"trigger": 1, "noise": "A" * 400}))
        trial = ScriptedTrial("indeterminate_on_reduction")
        report = Reducer(trial).reduce(self.EP, original)
        self.assertEqual(report["trials_accepted"], 0)
        self.assertGreater(report["trials_inconclusive"], 0)
        self.assertEqual(report["after"]["body"], original.case.body)

    def test_long_string_shortened_while_reproducing(self):
        original = _result(_case({"trigger": "A" * 8193, "other": 1}))
        # 只有删掉 trigger 才恢复正常；缩短字符串仍复现失败，因此可被接受
        trial = ScriptedTrial("recovers_when_key_removed",
                              required_key="$.trigger")
        report = Reducer(trial).reduce(self.EP, original)
        self.assertTrue(report["reproduced"])
        shortened = report["after"]["body"]["trigger"]
        self.assertLess(len(shortened), 8193)

    def test_nested_structure_flattened(self):
        body = {"trigger": 1,
                "wrap": {"l1": {"l2": {"l3": {"l4": "value"}}}}}
        original = _result(_case(body))
        trial = ScriptedTrial("recovers_when_key_removed",
                              required_key="$.trigger")
        report = Reducer(trial).reduce(self.EP, original)
        self.assertTrue(report["reproduced"])
        # 缩减后整体 JSON 体积应明显变小
        import json
        self.assertLess(len(json.dumps(report["after"]["body"])),
                        len(json.dumps(body)))

    def test_raw_body_truncation(self):
        raw_case = _case('{"a": 1, "b": "' + "X" * 200 + '"}', raw=True)
        original = _result(raw_case)
        trial = ScriptedTrial("always_fail")
        report = Reducer(trial).reduce(self.EP, original)
        self.assertTrue(report["reproduced"])
        self.assertTrue(report["after"]["raw_body"])
        self.assertLessEqual(len(report["after"]["body"]), len(raw_case.body))

    def test_final_sample_still_has_same_fingerprint(self):
        original = _result(_case({"trigger": 1, "noise": "A" * 300}))
        trial = ScriptedTrial("always_fail")
        report = Reducer(trial).reduce(self.EP, original)
        self.assertEqual(report["final_fingerprint"],
                         report["target_fingerprint"])

    def test_before_after_snapshots_preserved(self):
        body = {"trigger": 1, "noise": "A" * 300}
        original = _result(_case(copy.deepcopy(body)))
        report = Reducer(ScriptedTrial("always_fail")).reduce(
            self.EP, original)
        self.assertEqual(report["before"]["body"], body)
        self.assertIn("body", report["after"])


if __name__ == "__main__":
    unittest.main()
