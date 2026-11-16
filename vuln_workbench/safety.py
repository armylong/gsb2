"""安全边界与通用约束。

本模块集中声明工作台的安全红线, 其他模块只允许使用这里的常量与辅助函数。
tests/test_safety.py 会以 AST 方式扫描整个包, 确认没有引入被禁止的能力。
"""

from __future__ import annotations

import re
from pathlib import Path

# ---- 导入体量限制, 防止恶意复现包耗尽内存 ----
MAX_FILE_BYTES = 10 * 1024 * 1024        # 单文件 10MB
MAX_PACKAGE_BYTES = 100 * 1024 * 1024    # 整个复现包 100MB
MAX_TEXT_STORE_CHARS = 2_000_000         # 工程内单文件文本最多保存字符数

# 工程文件魔数与版本
FORMAT_NAME = "vuln-workbench-project"
FORMAT_VERSION = 1

# 脱敏占位符
MASK_PLACEHOLDER = "******"

# zip 内合法路径: 相对路径, 不允许盘符/绝对路径/父目录跳转
_ZIP_SAFE_NAME = re.compile(r"^[^/\\][^\r\n]*$")


def validate_zip_member_name(name: str) -> bool:
    """校验 zip 成员路径是否安全 (不允许绝对路径与 ``..`` 跳转)。"""
    if not name or name in (".", "/"):
        return False
    if name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", name):
        return False
    if not _ZIP_SAFE_NAME.match(name):
        return False
    parts = re.split(r"[\\/]+", name)
    if any(part in ("..", "") for part in parts):
        return False
    return True


def is_probably_binary(data: bytes) -> bool:
    """通过前 8KB 中的 NUL 字节粗略判断是否为二进制文件。"""
    return b"\x00" in data[:8192]


def ensure_exists(path: str | Path) -> Path:
    """把用户传入的路径转成绝对路径并确认存在, 不存在则抛 FileNotFoundError。"""
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"路径不存在: {p}")
    return p
