#!/usr/bin/env python3
"""SyncMark 启动脚本: 不带参数时打开图形界面, 带子命令时走命令行."""
import sys

from syncmark.cli import main

if __name__ == "__main__":
    if len(sys.argv) > 1:
        raise SystemExit(main(sys.argv[1:]))
    # 延迟导入, 保证命令行模式在无图形环境下也能跑
    try:
        from syncmark.cli import run_gui
    except ImportError as exc:
        raise SystemExit(f"图形界面依赖 PySide6: {exc}")
    raise SystemExit(run_gui())
