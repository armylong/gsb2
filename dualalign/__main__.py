"""命令行入口.

用法:
    python -m dualalign                 # 打开图形界面
    python -m dualalign --demo          # 打开界面并自动生成/载入内置样例

界面需要 PySide6; 自动验证入口见 ``python verify.py`` 或 ``pytest``。
"""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="双录音对齐工具")
    parser.add_argument("--demo", action="store_true", help="启动后自动生成并载入内置样例")
    args, rest = parser.parse_known_args(argv)
    try:
        from .gui.main_window import run_app
    except ImportError as exc:  # pragma: no cover - 仅在缺少 GUI 依赖时触发
        print(f"无法启动图形界面: {exc}\n请先安装依赖: pip install -r requirements.txt", file=sys.stderr)
        return 2
    return run_app([sys.argv[0], *rest], auto_demo=args.demo)


if __name__ == "__main__":
    raise SystemExit(main())
