"""Entry point: ``python -m pathcheck`` opens the checker GUI.

``--cli`` forwards the remaining arguments to the headless CLI so a single
module works for both, e.g.::

    python -m pathcheck --cli selftest --out out
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "--cli":
        from .cli import main as cli_main

        return cli_main(argv[1:])
    try:
        from .gui import run
    except ImportError as exc:  # pragma: no cover - depends on environment
        print(
            "无法启动图形界面 (PySide6 未安装?)。\n"
            f"原始错误: {exc}\n"
            "无界面模式: python -m pathcheck --cli selftest --out out",
            file=sys.stderr,
        )
        return 1
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
