"""导入与容错测试: 损坏文件、整包失败、重复证据、zip 攻击面。"""
import io
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

import _bootstrap  # noqa: F401

from vuln_workbench.importer import ImportFatalError, import_package
from vuln_workbench.models import PARSE_BINARY, PARSE_FALLBACK, PARSE_TRUNCATED
from vuln_workbench.project import new_project, save_project
from vuln_workbench.safety import MAX_FILE_BYTES

REQUEST = (
    "POST /login HTTP/1.1\r\nHost: 192.0.2.1\r\n"
    "Authorization: Bearer abc.def.ghi\r\n\r\n"
    '{"password":"pw-123456"}'
)


class ImportDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)
        pkg = self.root / "pkg"
        (pkg / "req").mkdir(parents=True)
        (pkg / "req" / "login.http").write_text(REQUEST, encoding="utf-8")
        (pkg / "broken").mkdir()
        (pkg / "broken" / "bad.log").write_bytes(b"INFO ok\n\xff\xfe garbage\n")
        (pkg / "broken" / "blob.bin").write_bytes(bytes(range(256)))
        (pkg / "broken" / "truncated.json").write_text(
            '{"a":1', encoding="utf-8")
        self.pkg = pkg

    def tearDown(self):
        self.tmp.cleanup()

    def test_broken_files_do_not_block_others(self):
        project = new_project()
        report = import_package(project, self.pkg)
        self.assertTrue(report.ok)
        self.assertEqual(len(project.files), 4)
        by_name = {f.rel_path: f for f in project.files}

        good = next(f for f in project.files if f.kind == "request")
        self.assertEqual(good.parse.status, "ok")
        self.assertEqual(good.parse.fields["method"], "POST")
        self.assertTrue(good.sha256 and len(good.sha256) == 64)
        self.assertIn(self.pkg.name, good.source_path)

        bad = by_name["broken/bad.log"]
        self.assertEqual(bad.parse.status, PARSE_FALLBACK)
        self.assertIsNotNone(bad.text)  # 退化文本仍可查看

        blob = by_name["broken/blob.bin"]
        self.assertEqual(blob.parse.status, PARSE_BINARY)
        self.assertIsNone(blob.text)
        self.assertTrue(blob.sha256)  # 校验值仍保留

        truncated = by_name["broken/truncated.json"]
        self.assertEqual(truncated.parse.status, PARSE_FALLBACK)
        self.assertIn("JSON", truncated.parse.error)

    def test_duplicate_evidence_is_flagged_not_overwritten(self):
        project = new_project()
        import_package(project, self.pkg)
        first_count = len(project.files)

        # 再导一次同一个目录: 内容全部重复
        report2 = import_package(project, self.pkg)
        self.assertEqual(len(project.files), first_count * 2)  # 没有覆盖
        self.assertEqual(len(report2.duplicates), first_count)
        dup_files = [f for f in project.files if f.duplicate_of]
        self.assertEqual(len(dup_files), first_count)
        for f in dup_files:
            self.assertIn("sha256", f.duplicate_reason)
            original = project.get_file(f.duplicate_of)
            self.assertEqual(original.sha256, f.sha256)

    def test_missing_path_raises_fatal_without_touching_project(self):
        project = new_project()
        before = len(project.files)
        with self.assertRaises(ImportFatalError):
            import_package(project, self.root / "nope")
        self.assertEqual(len(project.files), before)
        self.assertEqual(len(project.packages), 0)


class ZipImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _make_zip(self, name, members):
        path = self.root / name
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            for member, content in members:
                zf.writestr(member, content)
        return path

    def test_zip_slip_and_absolute_members_rejected_but_others_kept(self):
        path = self._make_zip("evil.zip", [
            ("ok/login.http", REQUEST),
            ("../escape.txt", "x"),
            ("/absolute/path.txt", "y"),
            ("a/../../b.txt", "z"),
        ])
        project = new_project()
        report = import_package(project, path)
        rels = {f.rel_path for f in project.files}
        self.assertIn("ok/login.http", rels)
        # 危险路径没有作为文件进入工程
        self.assertFalse(any(".." in r or r.startswith("/") for r in rels))
        # 没有任何文件写到 zip 之外
        self.assertFalse((self.root / "escape.txt").exists())

    def test_truncated_zip_is_fatal_and_project_untouched(self):
        good = self._make_zip("good.zip", [("a.http", REQUEST)])
        raw = good.read_bytes()
        bad = self.root / "truncated.zip"
        bad.write_bytes(raw[: len(raw) // 2])

        project = new_project()
        with self.assertRaises(ImportFatalError):
            import_package(project, bad)
        self.assertEqual(project.files, [])
        self.assertEqual(project.packages, [])

    def test_corrupt_member_keeps_other_members(self):
        path = self.root / "member_crc.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("ok/login.http", REQUEST)
            zf.writestr("broken/truncated.json", '{"a":1')
        project = new_project()
        report = import_package(project, path)
        self.assertTrue(report.ok)
        self.assertEqual(len(project.files), 2)
        kinds = {f.rel_path: f.parse.status for f in project.files}
        self.assertEqual(kinds["ok/login.http"], "ok")

    def test_oversize_file_is_truncated_not_fatal(self):
        big = "x" * (MAX_FILE_BYTES + 100)
        path = self._make_zip("big.zip", [("big.log", big)])
        project = new_project()
        report = import_package(project, path)
        self.assertEqual(len(project.files), 1)
        f = project.files[0]
        self.assertTrue(f.text_truncated)
        self.assertEqual(f.parse.status, PARSE_TRUNCATED)


class ProjectPersistenceTests(unittest.TestCase):
    def test_bad_project_does_not_clear_current(self):
        from vuln_workbench.project import ProjectLoadError, load_project
        with TemporaryDirectory() as tmp:
            good_path = Path(tmp) / "good.json"
            p = new_project("保留我")
            import_package(p, _make_simple_pkg(Path(tmp) / "pkg"))
            save_project(p, good_path)

            bad_path = Path(tmp) / "bad.json"
            bad_path.write_text("{ this is not json", encoding="utf-8")

            current = load_project(good_path)
            self.assertEqual(current.name, "保留我")
            self.assertGreaterEqual(len(current.files), 1)

            with self.assertRaises(ProjectLoadError):
                load_project(bad_path)

            # 坏工程加载失败后, 当前工程对象仍完整
            self.assertEqual(current.name, "保留我")
            self.assertGreaterEqual(len(current.files), 1)

            # 格式魔数错误也拒绝
            wrong = Path(tmp) / "wrong.json"
            wrong.write_text('{"format":"something-else","version":1}',
                             encoding="utf-8")
            with self.assertRaises(ProjectLoadError):
                load_project(wrong)

    def test_save_is_atomic_no_tmp_left(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "p.json"
            p = new_project()
            save_project(p, path)
            leftovers = [x.name for x in Path(tmp).iterdir()
                         if x.name.startswith(".")]
            self.assertEqual(leftovers, [])


def _make_simple_pkg(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "login.http").write_text(REQUEST, encoding="utf-8")
    return root


if __name__ == "__main__":
    unittest.main()
