from __future__ import annotations

import sys


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] in {"sample", "make-sample"}:
        from .sample import main as sample_main

        return sample_main(args[1:])
    if args and args[0] in {"-h", "--help", "help"}:
        print(
            """\
MKV 声轨字幕检查器

用法：
  python -m mkv_tool [文件.mkv]              启动 PySide6 窗口
  python -m mkv_tool sample [样片参数]        生成多轨样片
  python -m mkv_tool selfcheck               生成样片并验证移除/映射
  python -m mkv_tool inspect 文件.mkv         命令行列出流信息

常用样片命令：
  python -m mkv_tool sample --all --out samples
"""
        )
        return 0
    if args and args[0] == "inspect":
        from .cli import inspect_main

        return inspect_main(args[1:])
    if args and args[0] in {"selfcheck", "self-check", "verify-sample"}:
        from .selftest import main as selfcheck_main

        return selfcheck_main(args[1:])

    from .gui import run_gui

    file_arg = args[0] if args and not args[0].startswith("-") else None
    return run_gui([file_arg] if file_arg else [])


if __name__ == "__main__":
    raise SystemExit(main())
