#!/usr/bin/env python3
"""无缝纹理调整工具入口:python main.py"""
import sys

from PySide6.QtWidgets import QApplication

from seamless_tool.app import MainWindow


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
