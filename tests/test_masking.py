"""脱敏与导出测试: 默认隐藏、待脱敏清单、导出零泄露。"""
import json
import re
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import _bootstrap  # noqa: F401

from vuln_workbench.export import export_project, render_markdown
from vuln_workbench.importer import import_package
from vuln_workbench.masking import (
    add_custom_rule, audit_reveal, default_settings, redact_text, scan_text,
)
from vuln_workbench.project import new_project
from vuln_workbench.safety import MASK_PLACEHOLDER

SENSITIVE_TEXT = """\
POST /login HTTP/1.1
Host: 192.0.2.10
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig
Authorization: Basic dXNlcjpwYXNzd29yZA==
X-Api-Key: ak-1234567890abcdef

{"password":"Sup3rS3cret!","email":"alice@example.com",
 "phone":"13800138000","id":"110101199003077777",
 "aws":"AKIAIOSFODNN7EXAMPLE",
 "jwt":"eyJaaa.bbb.ccc",
 "key":"-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAAJ...
-----END RSA PRIVATE KEY-----"}
"""


class MaskingRuleTests(unittest.TestCase):
    def setUp(self):
        self.settings = default_settings()

    def test_builtin_rules_hit_credential_and_pii(self):
        hits = scan_text(SENSITIVE_TEXT, self.settings)
        rule_ids = {h.rule_id for h in hits}
        self.assertIn("mask_bearer", rule_ids)
        self.assertIn("mask_basic_auth", rule_ids)
        self.assertIn("mask_password", rule_ids)
        self.assertIn("mask_email", rule_ids)
        self.assertIn("mask_phone_cn", rule_ids)
        self.assertIn("mask_id_card", rule_ids)
        self.assertIn("mask_aws_key", rule_ids)
        self.assertIn("mask_jwt", rule_ids)
        self.assertIn("mask_private_key", rule_ids)

    def test_redaction_replaces_with_placeholder(self):
        redacted = redact_text(SENSITIVE_TEXT, self.settings)
        self.assertNotIn("Sup3rS3cret!", redacted)
        self.assertNotIn("dXNlcjpwYXNzd29yZA==", redacted)
        self.assertNotIn("13800138000", redacted)
        self.assertNotIn("alice@example.com", redacted)
        self.assertNotIn("AKIAIOSFODNN7EXAMPLE", redacted)
        self.assertIn(MASK_PLACEHOLDER, redacted)
        # 非敏感结构保留
        self.assertIn("POST /login HTTP/1.1", redacted)

    def test_disabled_rule_does_not_mask(self):
        for rule in self.settings.rules:
            if rule.id == "mask_email":
                rule.enabled = False
        redacted = redact_text(SENSITIVE_TEXT, self.settings)
        self.assertIn("alice@example.com", redacted)

    def test_custom_rule_and_invalid_regex(self):
        add_custom_rule(self.settings, "内部工号", r"EMP-\d{4}")
        redacted = redact_text("工号 EMP-4242 已登录", self.settings)
        self.assertNotIn("EMP-4242", redacted)
        with self.assertRaises(ValueError):
            add_custom_rule(self.settings, "坏正则", "([")
        # 坏正则即便混进规则列表也不会让扫描崩溃
        self.settings.rules[-1].pattern = "([unterminated"
        self.assertEqual(scan_text("anything", self.settings), [])

    def test_reveal_is_audited(self):
        audit_reveal(self.settings, "f_1", "复现核对")
        self.assertEqual(len(self.settings.reveal_audit), 1)
        self.assertEqual(self.settings.reveal_audit[0]["file_id"], "f_1")


class ExportLeakTests(unittest.TestCase):
    def _build_project(self):
        project = new_project("脱敏测试工程")
        with TemporaryDirectory() as tmp:
            pkg = Path(tmp) / "pkg"
            pkg.mkdir()
            (pkg / "login.http").write_text(SENSITIVE_TEXT, encoding="utf-8")
            (pkg / "readme.md").write_text(
                "# 说明\n联系人 alice@example.com 手机 13800138000",
                encoding="utf-8")
            import_package(project, pkg)
        return project

    def test_pending_list_before_export(self):
        project = self._build_project()
        exported, pending = export_project(project)
        self.assertTrue(pending)
        joined = json.dumps(pending, ensure_ascii=False)
        self.assertIn("mask_email", joined)
        rules_seen = {p["rule_id"] for p in pending}
        self.assertIn("mask_phone_cn", rules_seen)

    def test_export_contains_no_raw_secrets_anywhere(self):
        project = self._build_project()
        exported, _ = export_project(project)
        raw = json.dumps(exported, ensure_ascii=False)
        for secret in ("Sup3rS3cret!", "dXNlcjpwYXNzd29yZA==",
                       "13800138000", "alice@example.com",
                       "AKIAIOSFODNN7EXAMPLE",
                       "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig"):
            self.assertNotIn(secret, raw, f"敏感值泄露: {secret}")
        # 每条文本都已被占位
        for f in exported["files"]:
            if f["text"]:
                self.assertNotRegex(f["text"], r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

    def test_markdown_export_is_also_redacted(self):
        project = self._build_project()
        exported, _ = export_project(project)
        md = render_markdown(exported)
        self.assertNotIn("Sup3rS3cret!", md)
        self.assertNotIn("13800138000", md)
        self.assertIn(MASK_PLACEHOLDER, md)

    def test_export_keeps_checksums_and_relative_paths_only(self):
        project = self._build_project()
        exported, _ = export_project(project)
        for f in exported["files"]:
            self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", f["sha256"]))
            self.assertNotIn("source_path", f)  # 本机绝对路径不导出
        for pkg in exported["packages"]:
            self.assertNotIn("source_path", pkg)

    def test_annotation_text_is_redacted_too(self):
        project = self._build_project()
        from vuln_workbench.project import add_annotation, update_annotation
        ann = add_annotation(project, "记录")
        update_annotation(project, ann.id,
                          conclusion="口令 Sup3rS3cret! 已确认泄露")
        exported, _ = export_project(project)
        raw = json.dumps(exported, ensure_ascii=False)
        self.assertNotIn("Sup3rS3cret!", raw)


if __name__ == "__main__":
    unittest.main()
