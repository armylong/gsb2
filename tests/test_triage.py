"""人工结论测试：确认/备注/关闭不被重跑覆盖，数据变化有提示。"""
import unittest

from helpers import DqTestCase, BASE_RULES
from dqtool.runner import run_check
from dqtool.triage import triage, list_findings


class TestTriage(DqTestCase):
    def setUp(self):
        super().setUp()
        self.import_rules(BASE_RULES)
        self.rows_bad = [("a", -5, "2026-01-01", "2026-01-02")]

    def _write(self, rows):
        header = "id,amount,start,end\n"
        body = "".join(",".join(str(c) for c in r) + "\n" for r in rows)
        return self.write_file("d.csv", header + body)

    def _finding(self):
        fs = list_findings(self.conn, dataset="ds")
        self.assertEqual(len(fs), 1)
        return fs[0]

    def test_confirm_survives_rerun(self):
        path = self._write(self.rows_bad)
        run_check(self.conn, path, dataset="ds")
        f = self._finding()
        self.assertEqual(f["rule_id"], "amount_range")
        triage(self.conn, f["finding_id"], "confirm", note="已知问题，供应商数据", by="alice")
        # 重跑同样数据：人工结论与备注不被覆盖，数据未变化不提示
        run_check(self.conn, path, dataset="ds", fresh=True)
        f2 = self._finding()
        self.assertEqual(f2["manual_status"], "confirmed")
        self.assertEqual(f2["note"], "已知问题，供应商数据")
        self.assertEqual(f2["triaged_by"], "alice")
        self.assertEqual(f2["data_changed"], 0)

    def test_data_change_flagged_but_conclusion_kept(self):
        path = self._write(self.rows_bad)
        run_check(self.conn, path, dataset="ds")
        f = self._finding()
        triage(self.conn, f["finding_id"], "close", note="已线下处理")
        # 数据变化后重跑：结论保留，但提示数据已变
        path2 = self._write([("a", -99, "2026-01-01", "2026-01-02")])
        run_check(self.conn, path2, dataset="ds", fresh=True)
        f2 = self._finding()
        self.assertEqual(f2["manual_status"], "closed")
        self.assertEqual(f2["data_changed"], 1)
        # ack 后提示消除
        triage(self.conn, f["finding_id"], "ack")
        f3 = self._finding()
        self.assertEqual(f3["data_changed"], 0)
        self.assertEqual(f3["manual_status"], "closed")

    def test_resolved_and_reopen(self):
        path = self._write(self.rows_bad)
        run_check(self.conn, path, dataset="ds")
        f = self._finding()
        # 修复数据重跑：问题 resolved
        path2 = self._write([("a", 5, "2026-01-01", "2026-01-02")])
        run_check(self.conn, path2, dataset="ds", fresh=True)
        f2 = self._finding()
        self.assertEqual(f2["last_status"], "resolved")
        # 问题再次出现：重新打开，人工结论仍保留
        triage(self.conn, f["finding_id"], "confirm")
        path3 = self._write(self.rows_bad)
        run_check(self.conn, path3, dataset="ds", fresh=True)
        f3 = self._finding()
        self.assertEqual(f3["last_status"], "fail")
        self.assertEqual(f3["manual_status"], "confirmed")
        self.assertEqual(f3["first_seen_run"], f["first_seen_run"])

    def test_note_and_reopen_actions(self):
        path = self._write(self.rows_bad)
        run_check(self.conn, path, dataset="ds")
        f = self._finding()
        triage(self.conn, f["finding_id"], "note", note="待确认")
        triage(self.conn, f["finding_id"], "confirm")
        triage(self.conn, f["finding_id"], "reopen")
        f2 = self._finding()
        self.assertIsNone(f2["manual_status"])
        self.assertEqual(f2["note"], "待确认")


if __name__ == "__main__":
    unittest.main()
