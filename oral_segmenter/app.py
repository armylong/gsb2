"""应用入口, 支持 ``--demo`` 与无界面冒烟模式。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="oral_segmenter",
        description="口述录音离线切分标记工具 (PySide6)",
    )
    parser.add_argument("wav", nargs="?", help="启动时载入的 WAV 文件")
    parser.add_argument(
        "--demo", action="store_true", help="启动时载入程序内生成的合成样例"
    )
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="无界面启动并退出, 用于验证依赖与界面可构建",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.wav and not Path(args.wav).is_file():
        print(f"文件不存在: {args.wav}", file=sys.stderr)
        return 2

    from PySide6.QtWidgets import QApplication

    from .ui.main_window import MainWindow

    app = QApplication(sys.argv[:1])
    app.setApplicationName("口述录音切分标记")
    window = MainWindow()

    if args.demo:
        try:
            from PySide6.QtCore import QStandardPaths

            from .demo import make_demo_wav

            base = (
                QStandardPaths.writableLocation(QStandardPaths.TempLocation)
                or str(Path.home())
            )
            demo_path = Path(base) / "oral_segmenter_demo" / "oral_demo.wav"
            make_demo_wav(demo_path)
            window.load_audio(demo_path)
        except Exception as exc:  # noqa: BLE001 - 仅在演示启动时提示
            print(f"生成样例失败: {exc}", file=sys.stderr)
            return 1
    elif args.wav:
        if not window.load_audio(args.wav):
            return 1

    if args.smoke_test:
        window.show()
        app.processEvents()
        window.close()
        app.processEvents()
        print("smoke-test ok: 界面可构建")
        return 0

    window.show()
    return app.exec()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
