"""结构化解析、跨证据关联、结论变更历史测试。"""
import unittest

import _bootstrap  # noqa: F401

from vuln_workbench.classifier import classify
from vuln_workbench.correlation import build_correlations
from vuln_workbench.models import EvidenceFile, ParseResult, new_id
from vuln_workbench.parser import parse_file
from vuln_workbench.project import add_annotation, new_project, update_annotation


class ClassifierTests(unittest.TestCase):
    def test_extension_and_content_detection(self):
        req = "GET /a HTTP/1.1\r\nHost: x\r\n\r\n"
        resp = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
        self.assertEqual(classify("a/http.txt", req), "request")
        self.assertEqual(classify("x/login.req", req), "request")
        self.assertEqual(classify("x/login.resp", resp), "response")
        self.assertEqual(classify("logs/app.log", "INFO x"), "log")
        self.assertEqual(classify("conf/app.ini", "[s]\nk=v"), "config")
        self.assertEqual(classify("README.md", "# hi"), "note")
        self.assertEqual(classify("unknown.bin", None), "other")


class ParserTests(unittest.TestCase):
    def test_parse_request_structure(self):
        text = ("POST /api/login?x=1 HTTP/1.1\r\n"
                "Host: 192.0.2.10\r\nX-Request-ID: req-1\r\n\r\n"
                '{"user":"a"}')
        result = parse_file("request", text, "login.http", False)
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.fields["method"], "POST")
        self.assertEqual(result.fields["path"], "/api/login")
        self.assertEqual(result.fields["header_lookup"]["Host"], "192.0.2.10")
        self.assertEqual(result.fields["body_json"], {"user": "a"})

    def test_parse_response_structure(self):
        text = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nno"
        result = parse_file("response", text, "x.resp", False)
        self.assertEqual(result.fields["status_code"], 404)
        self.assertEqual(result.fields["reason"], "Not Found")

    def test_malformed_http_falls_back(self):
        result = parse_file("request", "NOT HTTP AT ALL", "x.http", False)
        self.assertEqual(result.status, "fallback")
        self.assertIsNotNone(result.error)

    def test_broken_json_falls_back(self):
        result = parse_file("config", "{broken", "x.json", False)
        self.assertEqual(result.status, "fallback")

    def test_log_entries(self):
        text = ("2026-11-15T08:30:01Z INFO 192.0.2.1 hello\n"
                "2026-11-15T08:30:02Z ERROR boom\n"
                "plain line without structure\n")
        result = parse_file("log", text, "app.log", False)
        self.assertEqual(result.fields["line_count"], 3)
        self.assertEqual(result.fields["entries"][1]["level"], "ERROR")
        self.assertEqual(result.fields["entries"][0]["ip"], "192.0.2.1")

    def test_ini_and_yaml_config(self):
        ini = parse_file("config", "[db]\npassword=x\nhost=h", "a.ini", False)
        self.assertEqual(ini.fields["sections"]["db"]["password"], "x")
        yaml_text = "server:\n  port: 8443\n  host: 192.0.2.1"
        yml = parse_file("config", yaml_text, "a.yaml", False)
        self.assertEqual(yml.fields["data"]["server"]["port"], "8443")

    def test_parser_never_raises_on_garbage(self):
        for kind in ("request", "response", "log", "config", "note", "other"):
            result = parse_file(kind, "\x00\x01 weird \xff text", "x", False)
            self.assertIn(result.status, ("ok", "fallback"))


def _make_file(file_id: str, package_id: str, rel_path: str,
               text: str) -> EvidenceFile:
    import hashlib
    from vuln_workbench.parser import parse_file
    data = text.encode("utf-8")
    kind = classify(rel_path, text)
    return EvidenceFile(
        id=file_id, package_id=package_id, rel_path=rel_path,
        source_path=f"/tmp/{rel_path}", kind=kind,
        size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
        md5=hashlib.md5(data).hexdigest(),
        parse=parse_file(kind, text, rel_path, False), text=text,
    )


class CorrelationTests(unittest.TestCase):
    def test_entities_link_across_request_log_response(self):
        common_id = "req-7f3a2c91e8b4"
        f1 = _make_file("f1", "pkg1", "login.http",
                        f"POST /login HTTP/1.1\nX-Request-ID: {common_id}\n"
                        "Host: 192.0.2.10\n\n")
        f2 = _make_file("f2", "pkg1", "app.log",
                        f"2026-11-15T08:30:01Z INFO request_id={common_id} "
                        "from 192.0.2.10\n")
        f3 = _make_file("f3", "pkg1", "login.resp",
                        f"HTTP/1.1 200 OK\nX-Request-ID: {common_id}\n\n")
        groups = build_correlations([f1, f2, f3])
        id_groups = [g for g in groups if g.entity_type == "id"
                     and common_id in g.value]
        self.assertEqual(len(id_groups), 1)
        self.assertEqual(set(id_groups[0].file_ids), {"f1", "f2", "f3"})

        ip_groups = [g for g in groups if g.entity_type == "ip"
                     and g.value == "192.0.2.10"]
        self.assertEqual(len(ip_groups), 1)
        self.assertEqual(set(ip_groups[0].file_ids), {"f1", "f2"})

    def test_single_file_entities_not_grouped(self):
        f1 = _make_file("f1", "pkg1", "a.log",
                        "2026-11-15T08:30:01Z INFO solo 192.0.2.5\n")
        groups = build_correlations([f1])
        self.assertEqual(groups, [])

    def test_cve_extraction(self):
        f1 = _make_file("f1", "p", "a.md", "see CVE-2026-1234 now")
        f2 = _make_file("f2", "p", "b.log",
                        "2026-11-15T08:30:01Z CVE-2026-1234 exploited")
        groups = build_correlations([f1, f2])
        self.assertTrue(any(g.value == "CVE-2026-1234" for g in groups))


class AnnotationHistoryTests(unittest.TestCase):
    def test_conclusion_change_keeps_full_history(self):
        project = new_project()
        ann = add_annotation(project, "SQL 注入复现")
        update_annotation(project, ann.id, conclusion="初步判断: 存在注入")
        update_annotation(project, ann.id, steps="1. 抓包\n2. 重放")
        update_annotation(project, ann.id, conclusion="确认: 高危, 可拖库")
        update_annotation(project, ann.id, conclusion="确认: 高危, 可拖库")  # 相同不记

        stored = project.get_annotation(ann.id)
        self.assertEqual(len(stored.conclusion_history), 2)
        self.assertEqual(stored.conclusion_history[0].old_value, "")
        self.assertEqual(stored.conclusion_history[0].new_value,
                         "初步判断: 存在注入")
        self.assertEqual(stored.conclusion_history[1].new_value,
                         "确认: 高危, 可拖库")
        self.assertEqual(stored.steps, "1. 抓包\n2. 重放")

        # 历史随工程序列化/反序列化保留
        from vuln_workbench.project import save_project, load_project
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "p.json"
            save_project(project, path)
            reopened = load_project(path)
            ann2 = reopened.get_annotation(ann.id)
            self.assertEqual(len(ann2.conclusion_history), 2)
            self.assertEqual(ann2.conclusion, "确认: 高危, 可拖库")

    def test_unknown_field_rejected(self):
        project = new_project()
        ann = add_annotation(project, "x")
        with self.assertRaises(ValueError):
            update_annotation(project, ann.id, id="hacked")


if __name__ == "__main__":
    unittest.main()
