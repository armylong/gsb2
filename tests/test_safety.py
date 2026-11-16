"""安全红线测试: 静态扫描代码, 确认没有危险能力。"""
import ast
import unittest
from pathlib import Path

import _bootstrap  # noqa: F401

PKG_DIR = Path(__file__).resolve().parent.parent / "vuln_workbench"

# 禁止 import 的模块 (网络出站/命令执行/动态代码/反序列化)
FORBIDDEN_IMPORTS = {
    "subprocess", "socket", "urllib.request", "http.client",
    "requests", "telnetlib", "ftplib", "smtplib", "paramiko",
    "pickle", "marshal", "ctypes", "multiprocessing",
}
# 禁止调用的内建函数 (ast.Name 直接调用, 排除 re.compile 等同名属性方法)
FORBIDDEN_BUILTIN_CALLS = {"eval", "exec", "compile", "__import__"}
# 禁止调用的模块方法 (ast.Attribute)
FORBIDDEN_ATTR_CALLS = {"system", "popen", "check_output", "run",
                        "call", "Popen"}


class SafetyTests(unittest.TestCase):
    def _all_py_files(self):
        return [p for p in PKG_DIR.rglob("*.py") if p.name != "__init__.py"
                or p.stat().st_size > 0]

    def test_no_forbidden_imports(self):
        violations = []
        for path in self._all_py_files():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name in FORBIDDEN_IMPORTS:
                            violations.append(f"{path.name}: import {alias.name}")
                elif isinstance(node, ast.ImportFrom):
                    if node.module in FORBIDDEN_IMPORTS:
                        violations.append(
                            f"{path.name}: from {node.module} import ...")
        self.assertEqual(violations, [], "发现禁止的导入: " + "; ".join(violations))

    def test_no_forbidden_calls(self):
        violations = []
        for path in self._all_py_files():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                if isinstance(node.func, ast.Name) \
                        and node.func.id in FORBIDDEN_BUILTIN_CALLS:
                    violations.append(f"{path.name}: 调用内建 {node.func.id}()")
                elif isinstance(node.func, ast.Attribute) \
                        and node.func.attr in FORBIDDEN_ATTR_CALLS:
                    # 只拦截 os/subprocess 等模块上的进程方法
                    owner = node.func.value
                    owner_name = owner.id if isinstance(owner, ast.Name) else ""
                    if owner_name in ("os", "subprocess", "sp", "sb"):
                        violations.append(
                            f"{path.name}: 调用 {owner_name}.{node.func.attr}()")
        self.assertEqual(violations, [], "发现禁止的调用: " + "; ".join(violations))

    def test_server_only_binds_loopback(self):
        server_py = (PKG_DIR / "server.py").read_text(encoding="utf-8")
        self.assertIn('host: str = "127.0.0.1"', server_py)
        # 必须有非本机对端拒绝逻辑
        self.assertIn("_reject_non_local", server_py)

    def test_zip_member_path_validation(self):
        from vuln_workbench.safety import validate_zip_member_name
        self.assertTrue(validate_zip_member_name("dir/file.txt"))
        self.assertFalse(validate_zip_member_name("../escape.txt"))
        self.assertFalse(validate_zip_member_name("/etc/passwd"))
        self.assertFalse(validate_zip_member_name("C:\\Windows\\x"))
        self.assertFalse(validate_zip_member_name("a/../../b"))


if __name__ == "__main__":
    unittest.main()
