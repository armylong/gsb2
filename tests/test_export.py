"""导出与 CLI 测试。"""
import csv
import json
import os
import unittest

from helpers import DqTestCase, BASE_RULES
from dqtool.runner import run_check
from dqtool.export import (export_results, export_issues, export_changes,
                           export_compare, export_rules)
from dqtool.cli import main as cli_main


class TestExport(DqTestCase):
    def setUp(self):
        super().setUp()
        self.v1, _ = self.import_rules(BASE_RULES, note="v1")
        self.path = self.write_file(
            "d.csv",
            "id,amount,start,end\n"
            "a,10,2026-01-01,2026-01-02\n"
            "b,-5,2026-01-01,2026-01-02\n")
        self.run1 = run_check(self.conn, self.path, dataset="ds", key_field="id")

    def test_export_results_csv(self):
        out = os.path.join(self.tmp.name, "results.csv")
        n = export_results(self.conn, self.run1, out)
        with open(out, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        self.assertEqual(n, len(rows))
        self.assertTrue(all(r["status"] != "pass" for r in rows))
        self.assertEqual(rows[0]["run_status"], "completed")
        b = [r for r in rows if r["record_key"] == "b" and r["rule_id"] == "amount_range"]
        self.assertEqual(len(b), 1)
        self.assertIn("min", b[0]["detail"])

    def test_export_results_all_includes_pass(self):
        out = os.path.join(self.tmp.name, "all.json")
        export_results(self.conn, self.run1, out, include_all=True)
        rows = json.load(open(out, encoding="utf-8"))
        self.assertEqual(len(rows), 2 * len(BASE_RULES))
        statuses = {r["status"] for r in rows}
        self.assertIn("pass", statuses)
        self.assertIn("fail", statuses)

    def test_export_issues_changes_rules(self):
        out_i = os.path.join(self.tmp.name, "issues.json")
        export_issues(self.conn, "ds", out_i)
        issues = json.load(open(out_i, encoding="utf-8"))
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["rule_id"], "amount_range")

        out_c = os.path.join(self.tmp.name, "changes.csv")
        export_changes(self.conn, "ds", out_c)
        with open(out_c, encoding="utf-8") as f:
            changes = list(csv.DictReader(f))
        self.assertTrue(any(c["change_type"] == "new" and c["new_status"] == "fail"
                            for c in changes))

        out_r = os.path.join(self.tmp.name, "rules.json")
        export_rules(self.conn, self.v1, out_r)
        rules = json.load(open(out_r, encoding="utf-8"))
        self.assertEqual(len(rules), len(BASE_RULES))
        self.assertTrue(all(r["version"] == self.v1 for r in rules))

    def test_export_compare(self):
        # 修复数据后再跑，导出对比
        path2 = self.write_file("d2.csv",
                                "id,amount,start,end\n"
                                "a,10,2026-01-01,2026-01-02\n"
                                "b,5,2026-01-01,2026-01-02\n")
        run2 = run_check(self.conn, path2, dataset="ds", fresh=True, key_field="id")
        out = os.path.join(self.tmp.name, "cmp.json")
        export_compare(self.conn, self.run1, run2, out)
        rows = json.load(open(out, encoding="utf-8"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["change_type"], "resolved")


class TestCli(DqTestCase):
    def test_end_to_end(self):
        rules_path = self.write_json_file("rules.json", {
            "note": "v1", "rules": [
                {"id": "id_required", "type": "required", "field": "id"},
                {"id": "amount_range", "type": "range", "field": "amount",
                 "params": {"min": 0, "max": 100}},
            ]})
        data = self.write_file("d.csv", "id,amount\na,10\nb,-1\n")
        out = os.path.join(self.tmp.name, "res.json")
        db = ["--db", self.db_path]
        self.assertEqual(cli_main(db + ["init"]), 0)
        self.assertEqual(cli_main(db + ["rules", "import", rules_path]), 0)
        self.assertEqual(cli_main(db + ["run", data, "--dataset", "ds", "--key-field", "id"]), 0)
        self.assertEqual(cli_main(db + ["runs"]), 0)
        self.assertEqual(cli_main(db + ["results", "1"]), 0)
        self.assertEqual(cli_main(db + ["issues", "--dataset", "ds"]), 0)
        self.assertEqual(cli_main(db + ["triage", "confirm", "1",
                                        "--note", "已知", "--by", "bob"]), 0)
        self.assertEqual(cli_main(db + ["export", "results", "--run", "1", "--out", out]), 0)
        rows = json.load(open(out, encoding="utf-8"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["record_key"], "b")
        self.assertEqual(cli_main(db + ["export", "rules", "--out",
                                        os.path.join(self.tmp.name, "r.json")]), 0)


if __name__ == "__main__":
    unittest.main()
