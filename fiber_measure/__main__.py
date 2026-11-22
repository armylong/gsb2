"""入口:python -m fiber_measure"""
import sys


def main():
    from PySide6.QtWidgets import QApplication
    from fiber_measure.ui.main_window import MainWindow

    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
