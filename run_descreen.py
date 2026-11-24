#!/usr/bin/env python3
"""入口：python run_descreen.py [可选图片路径]"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from descreen.gui.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("本地去斜网纹工具")
    win = MainWindow()
    win.show()
    if len(sys.argv) > 1:
        from descreen.gui.image_utils import load_image
        try:
            img = load_image(sys.argv[1])
        except IOError as e:
            print(e, file=sys.stderr)
        else:
            win._set_image(img, sys.argv[1])
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
