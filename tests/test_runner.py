"""运行器测试：坏数据、断点续跑、重跑一致性、变化记录。"""
import unittest

from helpers import DqTestCase, BASE_RULES
from dqtool.runner import (run_check, run_summary, status_map_for_run, diff_runs,
                           RunInterrupted)


class TestBadData(DqTestCase):
    def setUp(self):
        super().setUp()
        self.import_rules(BASE_RULES)

    def test_corrupt_csv_row(self):
        path = self.write_file("bad.csv",
                               "id,amount,start,end\n"
                               "a,10,2026-01-01,2026-01-02\n"
                               "b,notanumber,2026-01-01,2026-01-02,EXTRA\n"  # 列数过多 → corrupt
                               "c,20,2026-01-01\n")                            # 列数不足 → corrupt
        run_id = run_check(self.conn, path, dataset="ds")
        s = run_summary(self.conn, run_id)
        self.assertTrue(s["complete"])
        smap = status_map_for_run(self.conn, run_id)
        # 坏行：所有规则都是 corrupt，不是 fail 也不是 pass
        self.assertEqual(smap[("row:3", "id_required")], "corrupt")
        self.assertEqual(smap[("row:4", "amount_type")], "corrupt")
        self.assertEqual(smap[("row:2", "id_required")], "pass")
        self.assertEqual(s["result_counts"]["corrupt"], 2 * len(BASE_RULES))

    def test_bad_json_lines(self):
        path = self.write_file("bad.ndjson",
                               '{"id": "a", "amount": 5, "start": "2026-01-01", "end": "2026-01-02"}\n'
                               '{broken json\n'
                               '[1,2,3]\n')
        run_id = run_check(self.conn, path, dataset="ds")
        smap = status_map_for_run(self.conn, run_id)
        self.assertEqual(smap[("row:2", "id_required")], "corrupt")
        self.assertEqual(smap[("row:3", "id_required")], "corrupt")
        self.assertEqual(smap[("row:1", "amount_range")], "pass")

    def test_data_error_vs_not_applicable(self):
        path = self.write_file("mix.csv",
                               "id,amount,start,end\n"
                               "a,oops,2026-01-01,2026-01-02\n"   # amount 非数值 → fail
                               "b,,2026-01-01,2026-01-02\n"       # amount 空 → not_applicable
                               "a,50,2026-01-03,2026-01-02\n")    # id 重复 + 日期倒置 → fail
        run_id = run_check(self.conn, path, dataset="ds")
        smap = status_map_for_run(self.conn, run_id)
        self.assertEqual(smap[("row:2", "amount_type")], "fail")
        self.assertEqual(smap[("row:2", "amount_range")], "fail")
        self.assertEqual(smap[("row:3", "amount_type")], "not_applicable")
        self.assertEqual(smap[("row:3", "amount_range")], "not_applicable")
        self.assertEqual(smap[("row:4", "id_unique")], "fail")
        self.assertEqual(smap[("row:4", "date_order")], "fail")


class TestResume(DqTestCase):
    def setUp(self):
        super().setUp()
        self.import_rules(BASE_RULES)
        lines = []
        for i in range(10):
            amt = -1 if i == 7 else i  # 第 8 条越界
            lines.append('{"id": "r%02d", "amount": %d, "start": "2026-01-01", "end": "2026-01-02"}'
                         % (i, amt))
        self.path = self.write_file("data.ndjson", "\n".join(lines) + "\n")

    def test_interrupt_and_resume(self):
        with self.assertRaises(RunInterrupted):
            run_check(self.conn, self.path, dataset="ds", batch_size=2, max_batches=2, key_field="id")
        run = self.conn.execute("SELECT * FROM runs").fetchone()
        self.assertEqual(run["status"], "interrupted")
        self.assertEqual(run["processed_records"], 4)
        # 中断的运行绝不报告完成；未检查记录不在结果中（不会当作通过）
        s = run_summary(self.conn, run["run_id"])
        self.assertFalse(s["complete"])
        self.assertEqual(len(status_map_for_run(self.conn, run["run_id"])),
                         4 * len(BASE_RULES))
        # 续跑：同一 run，处理剩余记录
        run_id = run_check(self.conn, self.path, dataset="ds", batch_size=2, key_field="id")
        self.assertEqual(run_id, run["run_id"])
        s = run_summary(self.conn, run_id)
        self.assertTrue(s["complete"])
        self.assertEqual(s["total_records"], 10)
        smap = status_map_for_run(self.conn, run_id)
        self.assertEqual(len(smap), 10 * len(BASE_RULES))
        self.assertEqual(smap[("r07", "amount_range")], "fail")

    def test_resume_matches_uninterrupted_run(self):
        # 断点续跑的结果必须与一次性跑完完全一致（可重复性）
        with self.assertRaises(RunInterrupted):
            run_check(self.conn, self.path, dataset="ds", batch_size=3, max_batches=1, key_field="id")
        run_id = run_check(self.conn, self.path, dataset="ds", batch_size=3, key_field="id")
        resumed = status_map_for_run(self.conn, run_id)
        run_id2 = run_check(self.conn, self.path, dataset="ds2", batch_size=1000, key_field="id")
        oneshot = status_map_for_run(self.conn, run_id2)
        self.assertEqual(resumed, oneshot)


class TestRerunAndChanges(DqTestCase):
    def setUp(self):
        super().setUp()
        self.import_rules(BASE_RULES)

    def _run(self, rows, name="d.csv"):
        header = "id,amount,start,end\n"
        body = "".join(",".join(str(c) for c in r) + "\n" for r in rows)
        path = self.write_file(name, header + body)
        return run_check(self.conn, path, dataset="ds", fresh=True, key_field="id"), path

    def test_identical_rerun_produces_no_changes(self):
        rows = [("a", 10, "2026-01-01", "2026-01-02"), ("b", -5, "2026-01-01", "2026-01-02")]
        run1, path = self._run(rows)
        n_changes = self.conn.execute("SELECT COUNT(*) AS c FROM changes").fetchone()["c"]
        self.assertGreater(n_changes, 0)  # 基线运行记录全部初始问题
        # 同文件重跑：无任何新变化
        run2 = run_check(self.conn, path, dataset="ds", fresh=True, key_field="id")
        self.assertEqual(diff_runs(self.conn, run1, run2), [])
        n2 = self.conn.execute("SELECT COUNT(*) AS c FROM changes").fetchone()["c"]
        self.assertEqual(n_changes, n2)

    def test_real_change_recorded_once(self):
        rows = [("a", 10, "2026-01-01", "2026-01-02"), ("b", -5, "2026-01-01", "2026-01-02")]
        run1, _ = self._run(rows)
        # 修复 b 的 amount，但 a 的日期变坏
        rows2 = [("a", 10, "2026-01-05", "2026-01-02"), ("b", 5, "2026-01-01", "2026-01-02")]
        run2, _ = self._run(rows2)
        diffs = diff_runs(self.conn, run1, run2)
        kinds = {(d["record_key"], d["rule_id"], d["change_type"]) for d in diffs}
        self.assertIn(("b", "amount_range", "resolved"), kinds)
        self.assertIn(("a", "date_order", "new"), kinds)
        # 再跑一次同样数据：不重复生成变化记录
        n = self.conn.execute("SELECT COUNT(*) AS c FROM changes").fetchone()["c"]
        run3, _ = self._run(rows2)
        self.assertEqual(diff_runs(self.conn, run2, run3), [])
        n2 = self.conn.execute("SELECT COUNT(*) AS c FROM changes").fetchone()["c"]
        self.assertEqual(n, n2)


if __name__ == "__main__":
    unittest.main()
