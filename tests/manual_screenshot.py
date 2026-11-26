"""离屏渲染截图, 人工核对视觉效果。"""
import os
import sys
import tempfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from bandview.app import MainWindow
from bandview.generate import generate_sample_dataset
from bandview.io_utils import load_band


def main():
    app = QApplication(sys.argv)
    tmp = tempfile.mkdtemp(prefix="bandview_shot_")
    meta = generate_sample_dataset(tmp)
    win = MainWindow()
    win.resize(1800, 1100)
    for name in meta["band_names"]:
        band = load_band(os.path.join(tmp, f"{name}.npy"), nodata=0)
        win._register_band(band)
    win._after_bands_changed()

    # b1/b3/b4 -> R/G/B
    combos = win.channel_panel.combos()
    for combo, name in zip(combos, ("b1", "b3", "b4")):
        combo.setCurrentIndex(combo.findData(name))
    win.refresh_views()

    # NDVI b4/b3
    win.ndvi_panel.combo_a.setCurrentIndex(win.ndvi_panel.combo_a.findData("b4"))
    win.ndvi_panel.combo_b.setCurrentIndex(win.ndvi_panel.combo_b.findData("b3"))
    win.refresh_views()

    # 参考区
    win.on_canvas_roi("composite", (40, 40, 160, 160))

    QApplication.processEvents()
    QTimer.singleShot(150, app.quit)
    app.exec()

    out = os.path.join(tmp, "window.png")
    win.grab().save(out, "PNG")
    print("screenshot:", out)

    # 单独导出合成图和 NDVI 图
    from bandview.io_utils import save_rgba_png
    from bandview.rendering import render_composite, render_ndvi
    comp_rgba = render_composite(
        (win.bands["b1"], win.bands["b3"], win.bands["b4"]),
        win._current_ranges(), True,
    )
    save_rgba_png(os.path.join(tmp, "export_composite.png"), comp_rgba)
    ndvi_rgba, *_ = render_ndvi(win.bands["b4"], win.bands["b3"], 1e-6, True)
    save_rgba_png(os.path.join(tmp, "export_ndvi.png"), ndvi_rgba)
    print("dir:", tmp)
    for f in sorted(os.listdir(tmp)):
        print(" ", f, os.path.getsize(os.path.join(tmp, f)))


if __name__ == "__main__":
    main()
