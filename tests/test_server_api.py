"""本地 HTTP API 端到端测试 (仅访问 127.0.0.1 临时端口)。"""
import http.client
import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import _bootstrap  # noqa: F401

from vuln_workbench import server
from vuln_workbench.project import new_project

REQUEST = (
    "POST /login HTTP/1.1\r\nHost: 192.0.2.10\r\n"
    "Authorization: Bearer eyJaaa.bbb.ccc\r\n\r\n"
    '{"password":"Sup3rS3cret!"}'
)


class ApiClient:
    def __init__(self, port: int):
        self.port = port

    def call(self, method: str, path: str, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        conn.request(method, path, body=payload,
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        data = json.loads(resp.read().decode("utf-8"))
        conn.close()
        return resp.status, data


class ServerWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.create_server("127.0.0.1", 0)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever,
                                      daemon=True)
        cls.thread.start()
        cls.api = ApiClient(cls.port)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        # 每个用例重置为干净工程
        server.STATE.project = new_project("接口测试工程")
        server.STATE.current_path = None
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)
        pkg = self.root / "pkg"
        pkg.mkdir()
        (pkg / "login.http").write_text(REQUEST, encoding="utf-8")
        (pkg / "notes.md").write_text("# 说明\n", encoding="utf-8")
        self.pkg = pkg

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_workflow_import_mask_annotate_diff_export_save(self):
        # 1. 导入
        status, data = self.api.call("POST", "/api/import",
                                     {"path": str(self.pkg)})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["file_count"], 2)

        # 2. 状态: 文件默认脱敏
        status, state = self.api.call("GET", "/api/state")
        self.assertEqual(status, 200)
        http_file = next(f for f in state["files"]
                         if f["rel_path"] == "login.http")
        self.assertGreater(http_file["masked_hit_count"], 0)
        self.assertNotIn("Sup3rS3cret!", http_file["text"])
        self.assertIn("******", http_file["text"])

        # 3. 显式取原文需要审计理由
        status, data = self.api.call(
            "POST", f"/api/files/{http_file['id']}/reveal",
            {"reason": "测试核对"})
        self.assertEqual(status, 200)
        self.assertIn("Sup3rS3cret!", data["text"])
        status, state = self.api.call("GET", "/api/state")
        self.assertTrue(any(o["action"] == "reveal_text"
                            for o in state["operations"]))
        self.assertEqual(state["mask_settings"]["reveal_audit"][0]["reason"],
                         "测试核对")

        # 4. 标注 + 结论历史
        status, ann = self.api.call("POST", "/api/annotations",
                                    {"title": "复现-1"})
        self.assertEqual(status, 200)
        self.api.call("PUT", f"/api/annotations/{ann['id']}",
                      {"conclusion": "初判: 凭据明文传输"})
        self.api.call("PUT", f"/api/annotations/{ann['id']}",
                      {"conclusion": "终判: 高危, 需立即整改"})
        status, state = self.api.call("GET", "/api/state")
        stored = state["annotations"][0]
        self.assertEqual(len(stored["conclusion_history"]), 2)

        # 5. 保存/重开工程
        project_path = self.root / "work.json"
        status, data = self.api.call("POST", "/api/project/save",
                                     {"path": str(project_path)})
        self.assertEqual(status, 200)
        self.assertTrue(project_path.exists())

        # 6. 坏工程不能清空当前工程
        bad = self.root / "bad.json"
        bad.write_text("{broken", encoding="utf-8")
        status, data = self.api.call("POST", "/api/project/open",
                                     {"path": str(bad)})
        self.assertEqual(status, 400)
        self.assertIn("当前工程保持不变", data["error"])
        status, state = self.api.call("GET", "/api/state")
        self.assertEqual(len(state["files"]), 2)

        # 7. 正常重开
        status, data = self.api.call("POST", "/api/project/open",
                                     {"path": str(project_path)})
        self.assertEqual(status, 200)
        self.assertEqual(len(data["files"]), 2)
        self.assertEqual(len(data["annotations"][0]["conclusion_history"]), 2)

        # 8. 导出 JSON 无泄露
        status, data = self.api.call("GET", "/api/export?format=json")
        self.assertEqual(status, 200)
        raw = json.dumps(data["content"], ensure_ascii=False)
        self.assertNotIn("Sup3rS3cret!", raw)
        self.assertTrue(data["pending"])

        # 9. 导出 Markdown 无泄露
        status, data = self.api.call("GET", "/api/export?format=markdown")
        self.assertEqual(status, 200)
        self.assertNotIn("Sup3rS3cret!", data["content"])

    def test_import_nonexistent_package_keeps_project(self):
        status, data = self.api.call("POST", "/api/import",
                                     {"path": str(self.root / "nope")})
        self.assertEqual(status, 400)
        self.assertIn("当前工程保持不变", data["error"])
        status, state = self.api.call("GET", "/api/state")
        self.assertEqual(state["files"], [])

    def test_duplicate_import_is_flagged(self):
        self.api.call("POST", "/api/import", {"path": str(self.pkg)})
        status, data = self.api.call("POST", "/api/import",
                                     {"path": str(self.pkg)})
        self.assertEqual(status, 200)
        self.assertEqual(len(data["duplicates"]), 2)
        status, state = self.api.call("GET", "/api/state")
        self.assertEqual(len(state["files"]), 4)  # 两份都保留

    def test_diff_api_between_two_packages(self):
        pkg2 = self.root / "pkg2"
        pkg2.mkdir()
        (pkg2 / "login.http").write_text(
            REQUEST.replace("Sup3rS3cret!", "OtherPass99"),
            encoding="utf-8")
        self.api.call("POST", "/api/import", {"path": str(self.pkg)})
        self.api.call("POST", "/api/import", {"path": str(pkg2)})
        status, state = self.api.call("GET", "/api/state")
        ids = [p["id"] for p in state["packages"]]
        status, data = self.api.call("POST", "/api/diff", {
            "package_a_id": ids[0], "package_b_id": ids[1]})
        self.assertEqual(status, 200)
        self.assertEqual(data["counts"].get("modified"), 1)
        self.assertEqual(data["counts"].get("removed"), 1)

    def test_mask_rule_toggle_and_custom_rule(self):
        self.api.call("POST", "/api/import", {"path": str(self.pkg)})
        # 关闭密码规则后原文应可见
        status, rules = self.api.call("GET", "/api/mask/rules")
        pw_rule = next(r for r in rules["rules"] if r["id"] == "mask_password")
        self.api.call("PUT", f"/api/mask/rules/{pw_rule['id']}",
                      {"enabled": False})
        status, state = self.api.call("GET", "/api/state")
        http_file = next(f for f in state["files"]
                         if f["rel_path"] == "login.http")
        self.assertIn("Sup3rS3cret!", http_file["text"])

        # 非法正则被拒绝
        status, data = self.api.call("POST", "/api/mask/rules", {
            "name": "坏", "pattern": "([unterminated"})
        self.assertEqual(status, 400)

    def test_unknown_api_returns_404_not_crash(self):
        status, data = self.api.call("GET", "/api/nope")
        self.assertEqual(status, 404)
        self.assertIn("error", data)

    def test_static_index_served(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/index.html")
        resp = conn.getresponse()
        body = resp.read().decode("utf-8")
        conn.close()
        self.assertEqual(resp.status, 200)
        self.assertIn("漏洞复现证据工作台", body)


if __name__ == "__main__":
    unittest.main()
