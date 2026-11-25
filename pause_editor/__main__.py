"""命令行入口。

用法::

    .venv/bin/python -m pause_editor                       # 打开空窗口
    .venv/bin/python -m pause_editor a.wav [a.annotations.json]
    .venv/bin/python -m pause_editor --make-examples DIR   # 只生成内置示例
"""

from __future__ import annotations

import argparse
import sys

from .examples import generate_examples


def main() -> int:
    parser = argparse.ArgumentParser(description="本地口述音频停顿整理工具")
    parser.add_argument("wav", nargs="?", help="输入 WAV 路径")
    parser.add_argument("annotations", nargs="?", help="标注 JSON 路径 (可选)")
    parser.add_argument("--make-examples", metavar="DIR",
                        help="生成内置示例到 DIR 后退出")
    args = parser.parse_args()

    if args.make_examples:
        examples = generate_examples(args.make_examples)
        for ex in examples:
            print(f"{ex.name:14s} {ex.title}\n  {ex.wav_path}\n  {ex.ann_path}")
        return 0

    from PySide6.QtWidgets import QApplication

    from .main_window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName("pause-editor")
    win = MainWindow()
    win.show()
    if args.wav:
        win.load_files(args.wav, args.annotations)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
