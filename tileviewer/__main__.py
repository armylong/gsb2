"""Application entry point: ``python -m tileviewer``."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

__all__ = ["main"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tileviewer",
        description="本地单帧 RGB 影像的分块预览器（PySide6 + Pillow/tifffile）",
    )
    parser.add_argument("image", nargs="?", help="要打开的本地 RGB 图像")
    parser.add_argument(
        "--cache",
        default=None,
        help="覆盖预览块缓存目录（默认使用系统缓存目录）",
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        default=None,
        help="每块边长（默认 512）",
    )
    parser.add_argument(
        "--margin",
        type=int,
        default=None,
        help="每块额外保留的邻边像素（默认 16）",
    )
    parser.add_argument(
        "--offscreen",
        action="store_true",
        help="使用 Qt offscreen 平台（用于无显示器环境/截图测试）",
    )
    args = parser.parse_args(argv)

    if args.offscreen:
        import os

        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

    from PySide6.QtWidgets import QApplication

    from .main_window import MainWindow

    app = QApplication(sys.argv[:1])
    app.setApplicationName("tileviewer")
    app.setOrganizationName("tileviewer")
    app.setApplicationDisplayName("影像分块预览器")

    window = MainWindow(cache_root=Path(args.cache) if args.cache else None)
    if args.tile_size is not None:
        index = window.tile_size_combo.findData(args.tile_size)
        if index < 0:
            window.tile_size_combo.addItem(str(args.tile_size), args.tile_size)
            index = window.tile_size_combo.count() - 1
        window.tile_size_combo.setCurrentIndex(index)
    if args.margin is not None:
        window.margin_spin.setValue(args.margin)
    window.show()

    if args.image:
        window.open_image(args.image)

    return app.exec()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
