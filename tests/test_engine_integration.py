"""端到端集成测试：对本机测试服务跑完整引擎，验证植入缺陷、分组、缩减、重放。"""
from __future__ import annotations

import json
import os
import tempfile
import unittest

from apifuzz.config import Config
from apifuzz.engine import run
from apifuzz.grouping import group_results
from apifuzz.masking import mask_value
from apifuzz.replay import (REPLAY_NOT_REPRODUCED, REPLAY_REPRODUCED,
                            REPLAY_UNKNOWN, replay_all, replay_group)
from apifuzz.report import build_report, render_markdown

from .helpers import load_demo_endpoints, make_config, start_test_server


class TestEngineIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = 8802
        cls.server = start_test_server(cls.port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        from testservice.server import reset_store
        reset_store()

    def _demo_config(self, **kw):
        return make_config(self.port, load_demo_endpoints(), **kw)

    def test_full_run_finds_all_planted_bugs(self):
        cfg = self._demo_config()
        result = run(cfg, reduce=True)
        report = build_report(result)
        verdicts = set(report["summary"]["by_verdict"])

        # 正常拒绝必须存在，且不能被当成失败
        self.assertIn("REJECTED", verdicts)
        # 植入缺陷 1（嵌套 500）与缺陷 3（状态依赖 500）
        self.assertIn("SERVER_ERROR", verdicts)
        # 植入缺陷 2（越权写入 -> 状态违反）
        self.assertIn("STATE_VIOLATION", verdicts)

        groups = report["groups"]
        self.assertGreaterEqual(len(groups), 3)
        endpoints_with_bugs = {g["endpoint"] for g in groups}
        self.assertIn("create_user", endpoints_with_bugs)          # 缺陷 1
        self.assertIn("update_user_state", endpoints_with_bugs)    # 缺陷 2
        self.assertIn("transaction_closed", endpoints_with_bugs)   # 缺陷 3

    def test_state_dependency_only_closed_account_fails(self):
        """同一输入在 active 账户上是正常 400，closed 账户上是 500。"""
        cfg = self._demo_config()
        result = run(cfg, reduce=False)
        closed = [r for r in result.results
                  if r.case.endpoint == "transaction_closed"
                  and r.verdict == "SERVER_ERROR"]
        active_500 = [r for r in result.results
                      if r.case.endpoint == "transaction_active"
                      and r.verdict == "SERVER_ERROR"]
        self.assertTrue(closed, "closed 账户应触发状态依赖 500")
        self.assertFalse(active_500, "active 账户不应出现 500")

    def test_groups_separate_distinct_failures(self):
        cfg = self._demo_config()
        result = run(cfg, reduce=False)
        groups = group_results(result.results)
        # 至少两个不同指纹的 SERVER_ERROR（嵌套缺陷 vs 状态依赖缺陷）
        server_fps = {fp for fp, members in groups.items()
                      if members[0].verdict == "SERVER_ERROR"}
        self.assertGreaterEqual(len(server_fps), 2)

    def test_reduction_runs_against_live_service_and_reproduces(self):
        cfg = self._demo_config()
        result = run(cfg, reduce=True)
        report = build_report(result)
        reduced = [g for g in report["groups"] if "reduction" in g]
        self.assertTrue(reduced)
        for group in reduced:
            red = group["reduction"]
            self.assertTrue(red["reproduced"],
                            f"{group['group_id']} 缩减后必须仍复现同类失败")
            self.assertEqual(red["final_fingerprint"], red["target_fingerprint"])
            self.assertGreaterEqual(red["trials_total"], 1)

    def test_replay_reproduced_vs_not_reproduced_vs_unknown(self):
        cfg = self._demo_config()
        result = run(cfg, reduce=True)
        report = build_report(result)
        outcomes = replay_all(cfg, report)
        self.assertTrue(outcomes)
        # 服务一直带着缺陷运行 -> 全部仍可复现
        self.assertTrue(all(o.verdict == REPLAY_REPRODUCED for o in outcomes))
        for outcome in outcomes:
            self.assertEqual(outcome.replay_fingerprint,
                             outcome.original_fingerprint)

        # 修复服务后重放 -> NOT_REPRODUCED：临时把缺陷路由改成正常拒绝
        from testservice import server as srv
        original_create = srv.create_user
        original_tx = srv.create_transaction

        def safe_create(body):
            profile = body.get("profile") if isinstance(body, dict) else None
            if isinstance(profile, dict) and "geo" in profile \
                    and not isinstance(profile["geo"], (str, type(None))):
                raise srv.ApiError(400, "字段 profile.geo 必须是字符串")
            return original_create(body)

        def safe_tx(account_id, body):
            if isinstance(body, dict) and "memo" in body \
                    and not isinstance(body["memo"], str):
                raise srv.ApiError(400, "字段 memo 必须是字符串")
            return original_tx(account_id, body)

        srv.create_user = safe_create
        srv.create_transaction = safe_tx
        try:
            outcomes2 = replay_all(cfg, report)
        finally:
            srv.create_user = original_create
            srv.create_transaction = original_tx
        labels = {o.group_id: o.verdict for o in outcomes2}
        self.assertIn(REPLAY_NOT_REPRODUCED, labels.values())

    def test_replay_unknown_on_scope_block(self):
        cfg = self._demo_config()
        result = run(cfg, reduce=False)
        report = build_report(result)
        # 用一个不包含目标端口的白名单重放 -> 环境准备即被拦截 -> 无法判断
        blocked_cfg = Config(
            base_url=f"http://127.0.0.1:{self.port + 999}",
            allowed_hosts=["127.0.0.1"],
            allowed_ports=[self.port + 999],
            endpoints=cfg.endpoints, seed=cfg.seed,
            max_requests=100, max_concurrency=2, timeout_seconds=2.0,
            max_runtime_seconds=30.0, max_redirects=2,
            secret_fields=cfg.secret_fields,
        )
        outcome = replay_group(blocked_cfg, report,
                               report["groups"][0]["group_id"])
        self.assertEqual(outcome.verdict, REPLAY_UNKNOWN)

    def test_request_budget_is_enforced(self):
        cfg = self._demo_config(max_requests=8)
        result = run(cfg, reduce=False)
        self.assertIsNotNone(result.stopped_reason)
        self.assertLessEqual(result.requests_used, 8 + 4)  # 含在途请求余量

    def test_cleanup_removes_state_between_cases(self):
        """stateful 接口每条用例独立 setup/cleanup，存储里不应残留。

        create_user 是无状态接口且服务本身没有清理路由，只对带 cleanup 的
        stateful 接口（账户）做残留断言。
        """
        cfg = self._demo_config()
        run(cfg, reduce=False)
        from testservice.server import STORE
        self.assertEqual(STORE.accounts, {})

    def test_report_masks_credentials(self):
        cfg = self._demo_config()
        result = run(cfg, reduce=False)
        report = build_report(result)
        raw = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("s3cret-pwd", raw)
        self.assertNotIn("Bearer demo-token-secret", raw)
        self.assertIn("***MASKED***", raw)

    def test_markdown_report_renders(self):
        cfg = self._demo_config()
        report = build_report(run(cfg, reduce=False))
        md = render_markdown(report)
        self.assertIn("接口模糊测试报告", md)
        self.assertIn("输入生成规则", md)
        self.assertIn("事件日志", md)

    def test_report_written_to_disk(self):
        cfg = self._demo_config()
        report = build_report(run(cfg, reduce=False))
        with tempfile.TemporaryDirectory() as tmp:
            from apifuzz.report import write_report
            paths = write_report(report, tmp)
            self.assertTrue(os.path.exists(paths["json"]))
            self.assertTrue(os.path.exists(paths["markdown"]))
            with open(paths["json"], encoding="utf-8") as fh:
                loaded = json.load(fh)
            self.assertEqual(loaded["seed"], cfg.seed)

    def test_masking_unit(self):
        data = {"password": "p", "nested": {"token": "t", "ok": 1},
                "items": [{"api_key": "k"}]}
        masked = mask_value(data)
        self.assertEqual(masked["password"], "***MASKED***")
        self.assertEqual(masked["nested"]["token"], "***MASKED***")
        self.assertEqual(masked["nested"]["ok"], 1)
        self.assertEqual(masked["items"][0]["api_key"], "***MASKED***")


if __name__ == "__main__":
    unittest.main()
