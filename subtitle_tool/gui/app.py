"""Entry point for the PySide6 desktop app."""

from __future__ import annotations

import argparse
import sys


def main(argv=None) -> int:
    argv = list(sys.argv if argv is None else argv)
    parser = argparse.ArgumentParser(description="双语字幕重排台")
    parser.add_argument("--example", action="store_true", help="启动时加载内置示例")
    parser.add_argument("--project", help="启动时打开工程 JSON")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="无窗口运行一次核心自检后退出（用于 CI/无显示环境）",
    )
    args, qt_args = parser.parse_known_args(argv[1:])

    if args.self_test:
        from ..selftest import run_self_test

        return run_self_test()

    from PySide6.QtWidgets import QApplication

    from .main_window import MainWindow
    from ..session import Session

    app = QApplication([argv[0]] + qt_args)
    app.setApplicationName("双语字幕重排台")
    session = None
    if args.project:
        try:
            with open(args.project, "r", encoding="utf-8") as fh:
                session = Session()
                session.load_project(fh.read())
        except OSError as exc:
            print(f"无法打开工程: {exc}", file=sys.stderr)
            return 2
    window = MainWindow(session)
    if args.example:
        window.on_load_example()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
