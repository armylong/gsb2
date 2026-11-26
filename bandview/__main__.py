"""命令行入口: python -m bandview [可选: 波段文件 ...]"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from .app import MainWindow
from .io_utils import load_band


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()

    # 位置参数: 直接加载波段 (全部按 nodata=0 处理, 可在界面移除重加)
    paths = [a for a in argv if not a.startswith("-")]
    if paths:
        loaded = []
        for path in paths:
            try:
                band = load_band(path, nodata=0)
                if loaded and band.shape != loaded[0].shape:
                    continue
                win._register_band(band)
                loaded.append(band)
            except Exception as exc:  # noqa: BLE001
                print(f"跳过 {path}: {exc}", file=sys.stderr)
        if loaded:
            win._after_bands_changed()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
