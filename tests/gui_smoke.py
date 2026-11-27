"""Manual-ish GUI smoke driver (offscreen). Run with a timeout."""
import json
import os
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PySide6.QtWidgets import QApplication, QMessageBox

from mirror_restorer.canvas import Tool, ViewMode
from mirror_restorer.geometry import SymLine
from mirror_restorer.main_window import MainWindow


def log(msg):
    print(msg, flush=True)


def main():
    app = QApplication(sys.argv)

    # modal dialogs block the offscreen event loop; make every message box a
    # no-op that returns the standard accept role
    QMessageBox.information = staticmethod(lambda *a, **k: QMessageBox.StandardButton.Ok)
    QMessageBox.warning = staticmethod(lambda *a, **k: QMessageBox.StandardButton.Ok)
    QMessageBox.question = staticmethod(lambda *a, **k: QMessageBox.StandardButton.Yes)

    win = MainWindow()
    win.show()
    app.processEvents()

    fd = Path("tests/fixtures")
    meta = json.loads((fd / "meta.json").read_text())
    g = meta["line_gt"]
    log("opening image")
    win.open_image(str(fd / "tilted.png"))
    app.processEvents()

    line = SymLine(g["x1"], g["y1"], g["x2"], g["y2"])
    win.canvas.set_line(line)
    win.doc.damage[:] = cv2.imread(str(fd / "tilted_damage_mask.png"), 0)
    win.canvas.refresh_overlays()
    log("line + damage set")

    for t in Tool:
        win.canvas.tool = t
    for m in ViewMode:
        win.mode_combo.setCurrentIndex(list(ViewMode).index(m))
        app.processEvents()
    log("all view modes rendered")

    win.run_preview()
    log(f"fill px {int((win.result.fill_mask > 0).sum())} "
        f"gap px {int((win.result.gap_mask > 0).sum())}")

    win.magnifier.set_point(360.37, 300.19)
    app.processEvents()
    log("magnifier updated")

    win.doc.suggest_roi = tuple(meta["suggest_roi"])
    win.run_suggestion()
    app.processEvents()
    log(f"suggestion enabled={win.b_accept.isEnabled()} :: "
        f"{win.lbl_suggest.text().splitlines()[0]}")
    win._accept_suggestion()

    tmp = tempfile.mkdtemp()
    win.export_outputs(tmp)
    app.processEvents()
    log(f"exports: {sorted(os.listdir(tmp))}")

    shot = Path(tmp) / "window.png"
    win.grab().save(str(shot))
    log(f"screenshot {shot}")

    before = win.doc.damage.copy()
    win.canvas.set_line(line.nudged(2, 1, 2, 1))
    assert np.array_equal(before, win.doc.damage)
    log("damage persists across line edits: OK")
    win.close()
    log("DONE")


if __name__ == "__main__":
    main()
