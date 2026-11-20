"""Headless end-to-end GUI walkthrough (offscreen Qt).

Drives the real widgets with real mouse events and real menu actions, then
writes screenshots.  Used by the docs as a reproducible acceptance demo.

    python -m gui_walkthrough --outdir /tmp/scribblematte-demo
"""

from __future__ import annotations

import argparse
import json
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6 import QtCore, QtGui, QtWidgets

from matting.constraints import BG as BG_LABEL, FG as FG_LABEL
from matting.imageio import read_png_bgra

# Never block on modals.
QtWidgets.QMessageBox.question = staticmethod(lambda *a, **k: QtWidgets.QMessageBox.Yes)
QtWidgets.QMessageBox.information = staticmethod(lambda *a, **k: QtWidgets.QMessageBox.Ok)
QtWidgets.QMessageBox.warning = staticmethod(lambda *a, **k: QtWidgets.QMessageBox.Ok)


def send(view, kind, pos, button=QtCore.Qt.LeftButton, buttons=None):
    if buttons is None:
        buttons = button if kind != QtCore.QEvent.MouseMove else QtCore.Qt.NoButton
    local = QtCore.QPointF(float(pos[0]), float(pos[1]))
    event = QtGui.QMouseEvent(kind, local, local, button, buttons, QtCore.Qt.NoModifier)
    QtWidgets.QApplication.sendEvent(view, event)


def stroke_on_canvas(view, image_points, tool):
    """Paint on the canvas using image coordinates, whatever the zoom is."""
    view.set_tool(tool)
    pts = [view.image_to_widget(QtCore.QPointF(x, y)) for x, y in image_points]
    send(view, QtCore.QEvent.MouseButtonPress, (pts[0].x(), pts[0].y()))
    for pt in pts[1:]:
        send(view, QtCore.QEvent.MouseMove, (pt.x(), pt.y()))
    send(view, QtCore.QEvent.MouseButtonRelease, (pts[-1].x(), pts[-1].y()))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--outdir", default="/tmp/scribblematte-demo")
    args = parser.parse_args(argv)
    os.makedirs(args.outdir, exist_ok=True)

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    from ui.main_window import MainWindow

    window = MainWindow()
    window.resize(1680, 980)
    window.show()
    app.processEvents()

    log = {}

    # 1) Load the jug sample with its preset constraints.
    window._load_sample("jug")
    app.processEvents()
    window.grab().save(os.path.join(args.outdir, "01_jug_loaded.png"))
    log["sample_status"] = window.doc.status().__dict__

    # 2) Undo one stroke, verify staleness, then repaint it by hand at 3x zoom.
    window.action_undo()
    app.processEvents()
    log["after_undo"] = {
        "steps": len(window.doc.history),
        "stale": window.doc.is_stale(),
        "badge": window.recompute_btn.text(),
    }
    window.grab().save(os.path.join(args.outdir, "02_after_undo.png"))

    window.action_redo()
    app.processEvents()
    log["after_redo"] = {
        "steps": len(window.doc.history),
        "stale": window.doc.is_stale(),
    }

    # 3) Zoom to 3x centred on the jug's handle and add a foreground stroke.
    window.canvas.zoom_at(3.0, QtCore.QPointF(window.canvas.width() / 2, window.canvas.height() / 2))
    app.processEvents()
    stroke_on_canvas(window.canvas, [(500, 250), (500, 300), (500, 350)], tool=window._tool.FG)
    app.processEvents()
    log["after_new_stroke"] = {
        "steps": len(window.doc.history),
        "stale": window.doc.is_stale(),
        "badge": window.recompute_btn.text(),
    }
    window.grab().save(os.path.join(args.outdir, "03_stale_after_stroke.png"))

    # 4) Recompute, then compare backdrops.
    window.action_recompute()
    app.processEvents()
    log["after_recompute"] = {
        "stale": window.doc.is_stale(),
        "message": window.doc.last_message,
    }
    for mode in ("checker", "light", "dark"):
        window._set_backdrop(mode)
        app.processEvents()
        window.grab().save(os.path.join(args.outdir, f"04_backdrop_{mode}.png"))
    window._set_backdrop("dark")

    # 5) Export through the real action handlers (patch the file dialog).
    fg_path = os.path.join(args.outdir, "foreground.png")
    alpha_path = os.path.join(args.outdir, "alpha.png")
    record_path = os.path.join(args.outdir, "constraints.json")
    queue = [fg_path, alpha_path, record_path]
    original_dialog = QtWidgets.QFileDialog.getSaveFileName

    def fake_dialog(parent, caption, directory, *rest, **kwargs):
        return queue.pop(0), ""

    QtWidgets.QFileDialog.getSaveFileName = staticmethod(fake_dialog)
    try:
        window.action_export_foreground()
        window.action_export_alpha()
        window.action_export_record()
    finally:
        QtWidgets.QFileDialog.getSaveFileName = original_dialog

    rgba = read_png_bgra(fg_path)
    log["export"] = {
        "foreground_rgba_shape": list(rgba.shape),
        "alpha_min": int(rgba[:, :, 3].min()),
        "alpha_max": int(rgba[:, :, 3].max()),
        "alpha_matches_result": bool(
            abs(int(rgba[:, :, 3].astype(int).max()) - round(float(window.doc.result.alpha.max()) * 255))
            <= 1
        ),
        "record_bytes": os.path.getsize(record_path),
    }
    with open(record_path, encoding="utf-8") as fh:
        record = json.load(fh)
    log["record"] = {
        "has_sha256": len(record["image"]["sha256"]) == 64,
        "box": record["box"],
        "strokes": len(record["strokes"]),
        "size": [record["image"]["width"], record["image"]["height"]],
    }

    # 6) Fresh image must not inherit the old constraints.
    window._load_sample("ring")
    app.processEvents()
    log["after_new_image"] = {
        "steps": len(window.doc.history),
        "has_result": window.doc.result is not None,
        "box": window.doc.settings.box,
        "stale": window.doc.is_stale(),
    }
    window.grab().save(os.path.join(args.outdir, "05_new_sample.png"))

    # 7) Reload the record onto the same image -> strokes restored, still stale.
    from matting.record import ConstraintRecord

    window._load_sample("jug")
    app.processEvents()
    with open(record_path, encoding="utf-8") as fh:
        rec = ConstraintRecord.from_json(fh.read(), window.doc.image)
    window.doc.load_record(rec)
    app.processEvents()
    log["record_reload"] = {
        "steps": len(window.doc.history),
        "has_result": window.doc.result is not None,
        "stale": window.doc.is_stale(),
    }
    window.action_recompute()
    app.processEvents()
    window.grab().save(os.path.join(args.outdir, "06_record_reloaded.png"))
    log["record_reload"]["recomputed"] = window.doc.result is not None

    # 8) Markers drawn while zoomed must land on the intended original pixels.
    zoom = window.canvas.zoom
    target = QtCore.QPointF(505.0, 410.0)
    widget_pt = window.canvas.image_to_widget(target)
    send(window.canvas, QtCore.QEvent.MouseButtonPress, (widget_pt.x(), widget_pt.y()))
    send(window.canvas, QtCore.QEvent.MouseButtonRelease, (widget_pt.x(), widget_pt.y()))
    app.processEvents()
    last = window.doc.history.strokes[-1]
    log["zoomed_mapping"] = {
        "zoom": round(zoom, 3),
        "target": [target.x(), target.y()],
        "recorded": [round(last.points[0][0], 2), round(last.points[0][1], 2)],
        "hit_label": int(window.doc.labels.data[int(target.y()), int(target.x())]),
        "fg_label_value": int(FG_LABEL),
        "bg_label_value": int(BG_LABEL),
    }

    print(json.dumps(log, ensure_ascii=False, indent=2, default=str))
    window.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
