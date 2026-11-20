"""Sharpen Debugger - 本地锐化调试页.

用于给"小物件照片"调锐化: 核心是可视化多尺度细节层、控制边缘抑制阈值、
用像素剖面看真实数值(不自动拉伸)、统计截断像素与色相漂移，并用合成
阶跃边/密集纹理验证锐化曲线。

所有算法都在本文件内用 numpy 实现, 合成样例由程序生成, 不依赖外部图片。
"""
from __future__ import annotations

import sys


def _check_deps() -> None:
    """在导入 GUI 前给出可读的缺失依赖提示."""
    missing = []
    try:
        import numpy  # noqa: F401  (probe only)
    except Exception:
        missing.append("numpy")
    try:
        import PySide6  # noqa: F401  (probe only)
    except Exception:
        missing.append("PySide6")
    if missing:
        sys.stderr.write(
            "缺少依赖: " + ", ".join(missing) + "\n"
            "请先安装:\n"
            "  python3 -m venv .venv\n"
            "  .venv/bin/pip install -r requirements.txt\n"
        )
        raise SystemExit(2)


_check_deps()

from sharpdebug.app import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
