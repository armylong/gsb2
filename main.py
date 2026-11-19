import sys

from PySide6.QtWidgets import QApplication

from rectifier.app import MainWindow


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.resize(1500, 950)
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
