"""回放测试：规则变更后回放历史文件，旧结果保留，影响可见。"""
import copy
import unittest

from helpers import DqTestCase, BASE_RULES
from dqtool.runner import run_check, replay_run, status_map_for_run, diff_runs, run_summary


class TestReplay(DqTestCase):
    def setUp(self):
        super().setUp()
        self.v1, _ = self.import_rules(BASE_RULES, note="v1")
        self.path = self.write_file(
            "data.csv",
            "id,amount,start,end\n"
            "a,10,2026-01-01,2026-01-02\n"
            "b,150,2026-01-01,2026-01-02\n"   # amount > 100
            "c,250,2026-01-01,2026-01-02\n")  # amount > 100 且 > 200

    def test_replay_with_new_rule_version(self):
        run1 = run_check(self.conn, self.path, dataset="ds", key_field="id")
        smap1 = status_map_for_run(self.conn, run1)
        self.assertEqual(smap1[("b", "amount_range")], "fail")
        self.assertEqual(smap1[("c", "amount_range")], "fail")

        # 规则变更：上限 100 → 200，生成 v2
        modified = copy.deepcopy(BASE_RULES)
        modified[3]["params"]["max"] = 200
        v2, changed = self.import_rules(modified, note="放宽上限")
        self.assertTrue(changed)

        # 回放历史文件：旧运行保留，新运行用 v2
        run2 = replay_run(self.conn, run1, v2)
        self.assertNotEqual(run1, run2)
        s1 = run_summary(self.conn, run1)
        s2 = run_summary(self.conn, run2)
        self.assertEqual(s1["rule_version"], self.v1)
        self.assertEqual(s2["rule_version"], v2)
        self.assertEqual(s1["file_sha256"], s2["file_sha256"])

        # 旧结果未被覆盖
        smap1_after = status_map_for_run(self.conn, run1)
        self.assertEqual(smap1_after, smap1)
        # 新结果反映规则影响：b 通过，c 仍失败
        smap2 = status_map_for_run(self.conn, run2)
        self.assertEqual(smap2[("b", "amount_range")], "pass")
        self.assertEqual(smap2[("c", "amount_range")], "fail")
        # 规则变化的影响可对比查看
        diffs = diff_runs(self.conn, run1, run2)
        self.assertEqual(len(diffs), 1)
        self.assertEqual(diffs[0]["record_key"], "b")
        self.assertEqual(diffs[0]["rule_id"], "amount_range")
        self.assertEqual(diffs[0]["change_type"], "resolved")

    def test_replay_with_disabled_rule(self):
        from dqtool.rules import set_enabled
        run1 = run_check(self.conn, self.path, dataset="ds", key_field="id")
        v2, _ = set_enabled(self.conn, "amount_range", False)
        run2 = replay_run(self.conn, run1, v2)
        smap2 = status_map_for_run(self.conn, run2)
        # 停用的规则不再出现在结果中
        self.assertNotIn(("b", "amount_range"), smap2)
        diffs = diff_runs(self.conn, run1, run2)
        resolved = [d for d in diffs if d["rule_id"] == "amount_range"]
        self.assertEqual(len(resolved), 2)  # b 和 c 的 fail 消失

    def test_replay_rejects_changed_file(self):
        run1 = run_check(self.conn, self.path, dataset="ds", key_field="id")
        self.write_file("data.csv", "id,amount,start,end\nx,1,2026-01-01,2026-01-02\n")
        with self.assertRaises(ValueError):
            replay_run(self.conn, run1, self.v1)

    def test_replay_old_version_after_rule_change(self):
        """规则改错后可以回到旧版本回放验证。"""
        run_check(self.conn, self.path, dataset="ds", key_field="id")
        modified = copy.deepcopy(BASE_RULES)
        modified[3]["params"]["max"] = 10000
        v2, _ = self.import_rules(modified)
        run2 = replay_run(self.conn, 1, v2)
        self.assertEqual(run_summary(self.conn, run2)["result_counts"].get("fail", 0), 0)
        # 用 v1 再回放：问题重新出现
        run3 = replay_run(self.conn, 1, self.v1)
        smap3 = status_map_for_run(self.conn, run3)
        self.assertEqual(smap3[("b", "amount_range")], "fail")


if __name__ == "__main__":
    unittest.main()
