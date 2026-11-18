"""命令行入口: python -m syncplayer [a.mp4] [b.mp4] [--settings s.json]"""
from __future__ import annotations

import argparse
import sys

from PySide6.QtWidgets import QApplication

from .main_window import MainWindow


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="本地双视频同步对比播放器(无自动对齐)"
    )
    parser.add_argument("video_a", nargs="?", help="A 主视频 mp4 路径")
    parser.add_argument("video_b", nargs="?", help="B 对照视频 mp4 路径")
    parser.add_argument(
        "--settings", help="偏移设置 json(默认按文件对自动存到 ~/.syncplayer)"
    )
    return parser.parse_args(argv[1:])


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv if argv is None else argv)
    app = QApplication(sys.argv)
    app.setApplicationName("syncplayer")
    win = MainWindow(args.video_a, args.video_b, args.settings)
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
