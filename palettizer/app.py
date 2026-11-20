"""Desktop entry point for the palette / dither comparison tool."""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    from PySide6.QtWidgets import QApplication

    from .ui.icon import make_icon
    from .ui.main_window import MainWindow
    from .ui.theme import apply_theme

    argv = list(sys.argv if argv is None else argv)
    app = QApplication(argv)
    app.setApplicationName("Palettizer")
    app.setApplicationDisplayName("Palettizer · 像素画调色工具")
    app.setWindowIcon(make_icon())
    apply_theme(app)
    window = MainWindow()
    window.show()
    if len(argv) > 1:
        # Optional CLI convenience: open a file passed on the command line.
        from pathlib import Path

        from .imageio import ImageLoadError, load_image

        try:
            window.load_rgba(load_image(argv[1]), Path(argv[1]).name)
        except ImageLoadError as exc:
            window.log(f"命令行打开失败：{exc}")
    return app.exec()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
