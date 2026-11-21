"""``python -m cutlab`` 入口。"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "verify":
        from . import verify
        return verify.main(argv[1:])
    if argv and argv[0] in {"-h", "--help"}:
        print(
            "CutLab\n"
            "  python -m cutlab                启动图形界面\n"
            "  python -m cutlab <视频>         启动并直接加载视频\n"
            "  python -m cutlab verify [选项]  运行自动验证\n"
        )
        return 0
    from .gui import main as gui_main
    return gui_main()


if __name__ == "__main__":
    raise SystemExit(main())
