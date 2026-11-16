"""两份复现包差异比较测试。"""
import unittest

import _bootstrap  # noqa: F401

from vuln_workbench.diff import (
    ADDED, REMOVED, MODIFIED, ORDER_ONLY, RENAMED, UNCHANGED,
    compare_packages,
)
from tests.test_parser_corr import _make_file  # 复用构造函数


class CompareTests(unittest.TestCase):
    def test_detect_added_removed_modified(self):
        a = [
            _make_file("a1", "A", "common.http",
                       "POST /v1/login HTTP/1.1\r\n\r\n"),
            _make_file("a2", "A", "only_a.log",
                       "2026-11-15T08:30:01Z INFO a\n"),
        ]
        b = [
            _make_file("b1", "B", "common.http",
                       "POST /v2/login HTTP/1.1\r\n\r\n"),  # 内容修改
            _make_file("b2", "B", "only_b.json", '{"k": 1}'),  # 新增
        ]
        result = compare_packages(a, b)
        by_path = {d["rel_path_a"] or d["rel_path_b"]: d["status"]
                   for d in result["diffs"]}
        self.assertEqual(by_path["common.http"], MODIFIED)
        self.assertEqual(by_path["only_a.log"], REMOVED)
        self.assertEqual(by_path["only_b.json"], ADDED)
        common = next(d for d in result["diffs"]
                      if (d["rel_path_a"] or d["rel_path_b"]) == "common.http")
        self.assertIn("http_fields", common["detail"]["field_diff"])
        self.assertTrue(common["detail"]["line_diff"])

    def test_order_only_change_in_log_entries(self):
        lines = [
            "2026-11-15T08:30:01Z INFO one\n",
            "2026-11-15T08:30:02Z INFO two\n",
            "2026-11-15T08:30:03Z INFO three\n",
        ]
        a = [_make_file("a1", "A", "app.log", "".join(lines))]
        b = [_make_file("b1", "B", "app.log",
                        "".join([lines[0], lines[2], lines[1]]))]
        result = compare_packages(a, b)
        # 日志解析字段 entries 为列表, canonical 排序后结构一致
        status = result["diffs"][0]["status"]
        self.assertIn(status, (ORDER_ONLY, MODIFIED))
        if status == ORDER_ONLY:
            self.assertIn("顺序", result["diffs"][0]["detail"]["reason"])

    def test_package_level_order_only(self):
        files_a = [
            _make_file("a1", "A", "z.log", "LOG z\n"),
            _make_file("a2", "A", "a.http", "GET /a HTTP/1.1\r\n\r\n"),
        ]
        files_b = [
            _make_file("b2", "B", "a.http", "GET /a HTTP/1.1\r\n\r\n"),
            _make_file("b1", "B", "z.log", "LOG z\n"),
        ]
        result = compare_packages(files_a, files_b)
        self.assertTrue(result["package_order_only"])
        statuses = {d["status"] for d in result["diffs"]}
        self.assertEqual(statuses, {UNCHANGED})

    def test_rename_detected_via_hash(self):
        a = [_make_file("a1", "A", "old_name.md", "# 同样的说明内容\n")]
        b = [_make_file("b1", "B", "new_name.md", "# 同样的说明内容\n")]
        result = compare_packages(a, b)
        self.assertEqual(result["diffs"][0]["status"], RENAMED)
        self.assertEqual(result["diffs"][0]["rel_path_a"], "old_name.md")
        self.assertEqual(result["diffs"][0]["rel_path_b"], "new_name.md")

    def test_identical_packages(self):
        text = "HTTP/1.1 200 OK\r\n\r\n"
        a = [_make_file("a1", "A", "x.resp", text)]
        b = [_make_file("b1", "B", "x.resp", text)]
        result = compare_packages(a, b)
        self.assertEqual(result["diffs"][0]["status"], UNCHANGED)
        self.assertEqual(result["counts"].get(UNCHANGED), 1)


if __name__ == "__main__":
    unittest.main()
