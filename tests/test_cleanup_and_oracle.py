"""清理失败必须停止相关测试；以及判定器/配置校验的单元测试。"""
from __future__ import annotations

import time
import unittest

from apifuzz.client import Budget, ScopedClient
from apifuzz.config import Check, Config, ConfigError, Endpoint, load_config
from apifuzz.errors import CleanupFailure, SetupFailure
from apifuzz.models import Case, Evidence
from apifuzz.oracle import classify, evaluate_checks
from apifuzz.runner import Runner

from .helpers import make_config, start_test_server


def _client(port, max_requests=500):
    return ScopedClient(
        base_url=f"http://127.0.0.1:{port}",
        allowed_hosts=["127.0.0.1"], allowed_ports=[port],
        budget=Budget(max_requests, time.monotonic() + 30),
        timeout=3.0, max_redirects=2, max_body_evidence=4096,
    )


class TestCleanupStopsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = 8803
        cls.server = start_test_server(cls.port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_cleanup_failure_raises_and_aborts_endpoint(self):
        ep = Endpoint.from_dict({
            "name": "bad_cleanup",
            "method": "POST", "path": "/api/users",
            "sample": {"name": "a", "email": "a@b.test", "age": 1},
            "stateful": True,
            "setup": [
                {"name": "create", "method": "POST", "path": "/api/users",
                 "body": {"name": "s", "email": "s@b.test", "age": 1,
                          "profile": {"geo": "geo:cn"}},
                 "save": {"user_id": "$.user.id"}}
            ],
            # 清理打到不存在的路由 -> 404，且检查要求 204 -> 清理失败
            "cleanup": [
                {"name": "bad_delete", "method": "DELETE",
                 "path": "/api/users/{user_id}",
                 "checks": [{"type": "status", "expect": 299}]}
            ],
        })
        runner = Runner(_client(self.port))
        cases = [Case(f"c{i}", ep.name, "baseline", "$",
                      body=dict(ep.sample)) for i in range(5)]
        results, err = runner.run_endpoint(ep, cases, lambda r: None)
        self.assertIsInstance(err, CleanupFailure)
        # 第一条用例后的清理即失败，剩余用例不得执行
        self.assertLess(len(results), len(cases))

    def test_successful_cleanup_runs_all_cases(self):
        ep = Endpoint.from_dict({
            "name": "good_cleanup",
            "method": "POST", "path": "/api/accounts",
            "sample": {"owner": "alice"},
            "stateful": True,
            "setup": [
                {"name": "create", "method": "POST", "path": "/api/accounts",
                 "body": {"owner": "alice"},
                 "save": {"account_id": "$.account.id"}}
            ],
            "cleanup": [
                {"name": "delete", "method": "DELETE",
                 "path": "/api/accounts/{account_id}"}
            ],
        })
        runner = Runner(_client(self.port))
        cases = [Case(f"c{i}", ep.name, "baseline", "$",
                      body=dict(ep.sample)) for i in range(3)]
        results, err = runner.run_endpoint(ep, cases, lambda r: None)
        self.assertIsNone(err)
        self.assertEqual(len(results), 3)

    def test_setup_failure_raises_and_engine_aborts_endpoint(self):
        ep = Endpoint.from_dict({
            "name": "broken_setup",
            "method": "POST", "path": "/api/accounts",
            "sample": {"owner": "alice"},
            "stateful": True,
            "setup": [
                # 缺少必填 owner -> 服务返回 400，检查要求 201 -> 准备失败
                {"name": "bad_create", "method": "POST",
                 "path": "/api/accounts", "body": {},
                 "checks": [{"type": "status", "expect": 201}]}
            ],
        })
        runner = Runner(_client(self.port))
        cases = [Case("c0", ep.name, "baseline", "$", body=dict(ep.sample))]
        with self.assertRaises(SetupFailure):
            runner.run_endpoint(ep, cases, lambda r: None)


class TestOracle(unittest.TestCase):
    def _ev(self, status, body=None):
        return Evidence("POST", "/x", {}, None, status, {},
                        body if body is not None else {"message": "x"},
                        None, 1)

    def test_rejected_vs_server_error(self):
        contract = [Check("status", expect=[201, 400])]
        self.assertEqual(classify(self._ev(400), contract), "REJECTED")
        self.assertEqual(classify(self._ev(500), contract), "SERVER_ERROR")

    def test_contract_violation_on_wrong_body_shape(self):
        contract = [Check("status", expect=[201]),
                    Check("json_path", path="$.user.id")]
        good = self._ev(201, {"user": {"id": "u1"}})
        bad = self._ev(201, {"unexpected": True})
        self.assertEqual(classify(good, contract), "OK")
        self.assertEqual(classify(bad, contract), "CONTRACT_VIOLATION")

    def test_absent_check(self):
        from apifuzz.jsonpath import ABSENT
        check = Check("json_path", path="$.user.is_admin", expect=ABSENT)
        clean = evaluate_checks([check], self._ev(200, {"user": {}}))
        dirty = evaluate_checks(
            [check], self._ev(200, {"user": {"is_admin": True}}))
        self.assertEqual(clean, [])
        self.assertEqual(1, len(dirty))

    def test_transport_error(self):
        ev = Evidence("POST", "/x", {}, None, None, {}, None,
                      "TimeoutError: x", 1)
        self.assertEqual(classify(ev, []), "TRANSPORT_ERROR")

    def test_header_check(self):
        ev = Evidence("POST", "/x", {}, None, 200,
                      {"Content-Type": "application/json"}, {}, None, 1)
        ok = evaluate_checks([Check("header", name="Content-Type")], ev)
        bad = evaluate_checks([Check("header", name="X-Missing")], ev)
        self.assertEqual(ok, [])
        self.assertEqual(1, len(bad))


class TestConfigValidation(unittest.TestCase):
    def test_missing_allowed_hosts_rejected(self):
        with self.assertRaises(ConfigError):
            Config.from_dict({
                "base_url": "http://127.0.0.1:1/x",
                "allowed_ports": [1], "endpoints": [],
            })

    def test_bad_endpoint_constraint_rejected(self):
        with self.assertRaises(ConfigError):
            Endpoint.from_dict({
                "name": "x", "path": "/x",
                "sample": {},
                "constraints": [{"type": "unknown_type"}],
            })

    def test_duplicate_endpoint_names_rejected(self):
        raw = {
            "base_url": "http://127.0.0.1:1",
            "allowed_hosts": ["127.0.0.1"], "allowed_ports": [1],
            "endpoints": [
                {"name": "x", "path": "/a", "sample": {}},
                {"name": "x", "path": "/b", "sample": {}},
            ],
        }
        with self.assertRaises(ConfigError):
            Config.from_dict(raw)

    def test_demo_config_loads(self):
        import os
        path = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "configs", "demo.json")
        cfg = load_config(path)
        self.assertEqual(len(cfg.endpoints), 5)
        self.assertIn("password", cfg.secret_fields)


if __name__ == "__main__":
    unittest.main()
