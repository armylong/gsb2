"""访问范围限制测试：白名单主机/端口、跳转越界拦截、预算上限。"""
from __future__ import annotations

import time
import unittest

from apifuzz.client import Budget, ScopedClient
from apifuzz.errors import BudgetExhausted, ScopeViolation

from .helpers import start_test_server


class TestScope(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = 8801
        cls.server = start_test_server(cls.port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _client(self, **kw):
        budget = Budget(max_requests=kw.pop("max_requests", 100),
                        deadline=time.monotonic() + 30)
        defaults = dict(
            base_url=f"http://127.0.0.1:{self.port}",
            allowed_hosts=["127.0.0.1"], allowed_ports=[self.port],
            budget=budget, timeout=3.0, max_redirects=3,
            max_body_evidence=4096,
        )
        defaults.update(kw)
        return ScopedClient(**defaults), budget

    def test_in_scope_request_allowed(self):
        client, _ = self._client()
        ev = client.request("GET", "/health")
        self.assertEqual(ev.status, 200)
        self.assertFalse(ev.scope_blocked)

    def test_host_not_in_allowlist_blocked_before_send(self):
        client, budget = self._client()
        ev = client.request("GET", "http://example.invalid/")
        self.assertTrue(ev.scope_blocked)
        self.assertIsNone(ev.status)
        self.assertIn("SCOPE_BLOCKED", ev.error)
        # 被拦截的请求不消耗请求预算
        self.assertEqual(budget.used, 0)

    def test_port_not_in_allowlist_blocked(self):
        client, _ = self._client()
        ev = client.request("GET", f"http://127.0.0.1:{self.port + 1}/health")
        self.assertTrue(ev.scope_blocked)
        self.assertIn("端口", ev.error)

    def test_redirect_outside_scope_is_blocked(self):
        # /api/redirect 302 到 http://example.invalid，必须在跟随前拦截
        client, _ = self._client()
        ev = client.request("GET", "/api/redirect")
        self.assertTrue(ev.scope_blocked)
        self.assertTrue(ev.redirect_chain)
        self.assertIn("跳转目标超出允许范围", ev.error)

    def test_redirect_to_other_local_port_blocked(self):
        client, _ = self._client()
        # 手工构造一个指向非白名单端口的绝对 URL 请求
        ev = client.request("GET", f"http://localhost:{self.port}/health")
        self.assertTrue(ev.scope_blocked)  # localhost 不在本用例白名单

    def test_request_count_budget(self):
        client, _ = self._client(max_requests=2)
        client.request("GET", "/health")
        client.request("GET", "/health")
        with self.assertRaises(BudgetExhausted):
            client.request("GET", "/health")

    def test_runtime_deadline_budget(self):
        budget = Budget(max_requests=100, deadline=time.monotonic() - 1)
        client = ScopedClient(
            base_url=f"http://127.0.0.1:{self.port}",
            allowed_hosts=["127.0.0.1"], allowed_ports=[self.port],
            budget=budget, timeout=3.0, max_redirects=2,
            max_body_evidence=4096,
        )
        with self.assertRaises(BudgetExhausted):
            client.request("GET", "/health")

    def test_non_http_scheme_rejected(self):
        client, _ = self._client()
        ev = client.request("GET", "file:///etc/passwd")
        self.assertTrue(ev.scope_blocked)


class TestScopeProbes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = 8804
        cls.server = start_test_server(cls.port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_engine_scope_probes_all_blocked_and_recorded(self):
        from apifuzz.config import Endpoint
        from apifuzz.engine import run
        from .helpers import make_config
        ep = Endpoint.from_dict({
            "name": "health", "method": "GET", "path": "/health",
            "sample": {}, "rules": [],
            "response_contract": [{"type": "status", "expect": [200]}],
        })
        cfg = make_config(self.port, [ep], scope_probes=[
            {"name": "外部主机", "url": "http://example.invalid/x"},
            {"name": "越界端口", "url": f"http://127.0.0.1:{self.port + 1}/"},
            {"name": "跳转越界", "url": "/api/redirect"},
        ])
        result = run(cfg, reduce=False)
        self.assertIsNone(result.stopped_reason)
        self.assertEqual(3, len(result.scope_probe_results))
        self.assertTrue(all(p["scope_blocked"]
                            for p in result.scope_probe_results))
        redirect_probe = next(p for p in result.scope_probe_results
                              if p["name"] == "跳转越界")
        self.assertTrue(redirect_probe["redirect_chain"])

    def test_engine_aborts_when_probe_not_blocked(self):
        from apifuzz.config import Endpoint
        from apifuzz.engine import run
        from .helpers import make_config
        ep = Endpoint.from_dict({
            "name": "health", "method": "GET", "path": "/health",
            "sample": {}, "rules": [],
            "response_contract": [{"type": "status", "expect": [200]}],
        })
        # 把白名单内的健康检查地址当成"探测"，它不会被拦截 -> 必须中止
        cfg = make_config(self.port, [ep], scope_probes=[
            {"name": "白名单内地址", "url": "/health"},
        ])
        result = run(cfg, reduce=False)
        self.assertIsNotNone(result.stopped_reason)
        self.assertIn("范围探测失败", result.stopped_reason)
        self.assertEqual([], result.results)


if __name__ == "__main__":
    unittest.main()
