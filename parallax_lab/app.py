"""PySide6 app: small-scope parallax preview tool.

Run with:  python -m parallax_lab
"""

from __future__ import annotations

import sys

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QColor, QPalette
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDoubleSpinBox,
                               QFormLayout, QGroupBox, QHBoxLayout, QLabel,
                               QMainWindow, QPushButton, QRadioButton, QScrollArea,
                               QSlider, QSpinBox, QSplitter, QStatusBar,
                               QVBoxLayout, QWidget)

from .core import (FILL_BACKGROUND, FILL_RAW, Camera, LayerEdit, ProbeInfo,
                   RenderResult, layout_diff, render)
from .scene import PRESETS, Scene
from .widgets import DepthView, ImageView, diff_overlay, layer_overlay


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Parallax Lab — two-layer depth preview")
        self.resize(1360, 860)

        self.scene: Scene | None = None
        self.result: RenderResult | None = None
        self.reference: RenderResult | None = None
        self.edits: list[LayerEdit] = []
        self.edits_a: list[LayerEdit] | None = None   # pinned left camera
        self.camera = Camera()
        self._probe_xy: tuple[int, int] | None = None

        self._build_ui()
        self.load_preset("still_life")
        self.recompute()

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        # ---- left: controls ------------------------------------------
        side = QWidget()
        side_l = QVBoxLayout(side)
        side_l.setContentsMargins(0, 0, 0, 0)
        side_l.setSpacing(8)
        side.setMinimumWidth(320)

        grp_scene = QGroupBox("Scene")
        f = QFormLayout(grp_scene)
        self.preset_box = QComboBox()
        for key, label in (("still_life", "Still life (bowl / book / vase)"),
                           ("slab", "Occluding square (analytic)"),
                           ("ramp", "Sloped depth strip (analytic)")):
            self.preset_box.addItem(label, key)
        self.preset_box.currentIndexChanged.connect(
            lambda _: self.load_preset(self.preset_box.currentData()))
        f.addRow("Preset", self.preset_box)
        self.info_label = QLabel()
        self.info_label.setWordWrap(True)
        self.info_label.setMinimumHeight(64)
        self.info_label.setStyleSheet("color:#9aa0aa; font-size:11px;")
        f.addRow(self.info_label)
        side_l.addWidget(grp_scene)

        grp_cam = QGroupBox("Camera offset")
        f = QFormLayout(grp_cam)
        self.baseline_slider = QSlider(Qt.Orientation.Horizontal)
        self.baseline_slider.setRange(-80, 80)
        self.baseline_spin = QDoubleSpinBox()
        self.baseline_spin.setRange(-80, 80)
        self.baseline_spin.setSingleStep(1)
        self.baseline_spin.setSuffix(" px")
        self.baseline_spin.setDecimals(1)
        self._link(self.baseline_slider, self.baseline_spin, scale=1.0)
        f.addRow("Baseline (px @1 m)", self.baseline_spin)
        f.addRow(self.baseline_slider)

        self.vertical_slider = QSlider(Qt.Orientation.Horizontal)
        self.vertical_slider.setRange(-40, 40)
        self.vertical_spin = QDoubleSpinBox()
        self.vertical_spin.setRange(-40, 40)
        self.vertical_spin.setSuffix(" px")
        self.vertical_spin.setDecimals(1)
        self._link(self.vertical_slider, self.vertical_spin, scale=1.0)
        f.addRow("Vertical (px @1 m)", self.vertical_spin)
        f.addRow(self.vertical_slider)
        side_l.addWidget(grp_cam)

        # ---- per-layer depth edits ----------------------------------
        self.layer_boxes: list[dict] = []
        for idx in (0, 1):
            box = QGroupBox()
            fl = QFormLayout(box)
            gain = QDoubleSpinBox()
            gain.setRange(0.1, 10.0)
            gain.setSingleStep(0.05)
            gain.setDecimals(2)
            gain.setValue(1.0)
            bias = QDoubleSpinBox()
            bias.setRange(-2.0, 2.0)
            bias.setSingleStep(0.01)
            bias.setDecimals(3)
            bias.setSuffix(" m")
            brush_l = QSpinBox()
            brush_l.setRange(1, 60)
            brush_l.setValue(10)
            brush_v = QDoubleSpinBox()
            brush_v.setRange(-0.5, 0.5)
            brush_v.setSingleStep(0.01)
            brush_v.setDecimals(3)
            brush_v.setValue(0.05)
            brush_v.setSuffix(" m")
            reset = QPushButton("Reset layer")
            fl.addRow("Depth gain", gain)
            fl.addRow("Depth bias", bias)
            fl.addRow("Brush radius", brush_l)
            fl.addRow("Brush delta", brush_v)
            fl.addRow(reset)
            for w in (gain, bias):
                w.valueChanged.connect(self._on_edits_changed)
            box.setCheckable(False)
            side_l.addWidget(box)
            entry = {"box": box, "gain": gain, "bias": bias,
                     "brush_radius": brush_l, "brush_delta": brush_v,
                     "reset": reset}
            self.layer_boxes.append(entry)
            reset.clicked.connect(lambda _=False, i=idx: self.reset_layer(i))
            # radius/delta are pushed onto the depth view (read at stroke time);
            # they do not require a re-render.
            brush_l.valueChanged.connect(
                lambda _v, i=idx: self._apply_brush_settings(i))
            brush_v.valueChanged.connect(
                lambda _v, i=idx: self._apply_brush_settings(i))

        grp_fill = QGroupBox("Holes")
        v = QVBoxLayout(grp_fill)
        self.raw_radio = QRadioButton("Raw: mark holes with magenta")
        self.bg_radio = QRadioButton("Background fill (nearest background donor)")
        self.raw_radio.setChecked(True)   # show the disocclusions first
        self.raw_radio.toggled.connect(self._on_fill_changed)
        v.addWidget(self.raw_radio)
        v.addWidget(self.bg_radio)
        self.show_overlay = QCheckBox("Show layer / hole overlay")
        self.show_overlay.setChecked(False)
        self.show_overlay.toggled.connect(self._refresh_views)
        v.addWidget(self.show_overlay)
        self.show_diff = QCheckBox("Show layout diff vs pinned camera")
        self.show_diff.setChecked(True)
        self.show_diff.toggled.connect(self._refresh_views)
        v.addWidget(self.show_diff)
        side_l.addWidget(grp_fill)

        grp_pin = QGroupBox("Compare")
        v = QVBoxLayout(grp_pin)
        self.pin_btn = QPushButton("Pin current camera as left reference")
        self.pin_btn.clicked.connect(self.pin_reference)
        v.addWidget(self.pin_btn)
        self.pin_label = QLabel("not pinned")
        self.pin_label.setStyleSheet("color:#9aa0aa; font-size:11px;")
        v.addWidget(self.pin_label)
        self.diff_label = QLabel("")
        self.diff_label.setWordWrap(True)
        self.diff_label.setStyleSheet("font-size:11px;")
        v.addWidget(self.diff_label)
        side_l.addWidget(grp_pin)

        side_l.addStretch(1)

        # ---- right: views -------------------------------------------
        views = QWidget()
        vl = QVBoxLayout(views)
        top = QHBoxLayout()
        self.view_out = ImageView()
        self.view_out.setMinimumWidth(420)
        self.view_out.pixel_hovered.connect(self._on_hover)
        self.view_out.pixel_clicked.connect(self._on_click)
        top.addWidget(self.view_out, 2)
        self.view_diff = ImageView()
        self.view_diff.pixel_hovered.connect(self._on_hover)
        self.view_diff.pixel_clicked.connect(self._on_click)
        top.addWidget(self.view_diff, 1)
        vl.addLayout(top, 3)

        bottom = QHBoxLayout()
        self.depth_views: list[DepthView] = []
        for i in range(2):
            dv = DepthView()
            dv.stroke.connect(lambda x, y, r, val, i=i: self._paint_depth(i, x, y, r, val))
            bottom.addWidget(dv, 1)
            self.depth_views.append(dv)
        vl.addLayout(bottom, 2)

        self.probe_label = QLabel("Move over the preview to inspect a pixel.")
        self.probe_label.setStyleSheet("font-family:Menlo,monospace; font-size:11px;")
        self.probe_label.setWordWrap(True)
        vl.addWidget(self.probe_label)

        side_scroll = QScrollArea()
        side_scroll.setWidget(side)
        side_scroll.setWidgetResizable(True)
        side_scroll.setFixedWidth(352)
        side_scroll.setFrameShape(QScrollArea.Shape.NoFrame)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.addWidget(side_scroll)
        split.addWidget(views)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        root.addWidget(split)

        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("Ready")

        # keyboard: step the camera
        for key, delta in ((Qt.Key.Key_Left, -2), (Qt.Key.Key_Right, 2)):
            a = QAction(self)
            a.setShortcut(key)
            a.triggered.connect(lambda _=False, d=delta: self.nudge_camera(d))
            self.addAction(a)

    def _link(self, slider: QSlider, spin: QDoubleSpinBox, scale: float):
        def from_slider(v):
            spin.blockSignals(True)
            spin.setValue(v * scale)
            spin.blockSignals(False)

        def from_spin(v):
            slider.blockSignals(True)
            slider.setValue(int(round(v / scale)))
            slider.blockSignals(False)

        slider.valueChanged.connect(from_slider)
        spin.valueChanged.connect(from_spin)
        spin.valueChanged.connect(lambda _: self._on_camera_changed())

    # ------------------------------------------------------------------
    # scene / edits
    # ------------------------------------------------------------------
    def load_preset(self, key: str):
        if key not in PRESETS:
            return
        self.scene = PRESETS[key]()
        H, W = self.scene.shape
        self.edits = [LayerEdit(brush=np.zeros((H, W), np.float32))
                      for _ in self.scene.layers]
        for i, (box, layer) in enumerate(zip(self.layer_boxes, self.scene.layers)):
            box["box"].setTitle(f"Layer {i}: {layer.name}")
            box["gain"].blockSignals(True)
            box["bias"].blockSignals(True)
            box["gain"].setValue(1.0)
            box["bias"].setValue(0.0)
            box["gain"].blockSignals(False)
            box["bias"].blockSignals(False)
            box["gain"].setEnabled(layer.editable)
            box["bias"].setEnabled(layer.editable)
            box["reset"].setEnabled(layer.editable)
            box["brush_radius"].setEnabled(layer.editable)
            box["brush_delta"].setEnabled(layer.editable)
        # Start with a visible parallax so the disocclusion story reads at once.
        self.camera = Camera(baseline_px=-24.0, vertical_px=0.0)
        self._set_camera_widgets()
        self._probe_xy = None
        self.result = None
        self.reference = None
        self.edits_a = None
        self.camera_a = self.camera
        if hasattr(self, "pin_label"):
            self.pin_label.setText("not pinned")
        self.recompute()

    def _set_camera_widgets(self):
        for w, v in ((self.baseline_slider, self.camera.baseline_px),
                     (self.baseline_spin, self.camera.baseline_px),
                     (self.vertical_slider, self.camera.vertical_px),
                     (self.vertical_spin, self.camera.vertical_px)):
            w.blockSignals(True)
            if isinstance(w, QSlider):
                w.setValue(int(round(v)))
            else:
                w.setValue(v)
            w.blockSignals(False)

    def reset_layer(self, i: int):
        if not self.scene or i >= len(self.edits):
            return
        self.edits[i] = LayerEdit(brush=np.zeros(self.scene.shape, np.float32))
        box = self.layer_boxes[i]
        for w in (box["gain"], box["bias"]):
            w.blockSignals(True)
            w.setValue(1.0 if w is box["gain"] else 0.0)
            w.blockSignals(False)
        self._on_edits_changed()

    def _apply_brush_settings(self, i: int):
        """Push radius / delta onto the depth view (values are read at stroke time)."""
        self.depth_views[i].set_brush(
            self.layer_boxes[i]["brush_radius"].value(),
            self.layer_boxes[i]["brush_delta"].value())

    def _on_edit_widgets(self):
        if not self.scene:
            return
        for i, box in enumerate(self.layer_boxes):
            self.edits[i].gain = box["gain"].value()
            self.edits[i].bias = box["bias"].value()

    def _on_edits_changed(self):
        self._on_edit_widgets()
        self.recompute()

    def _on_camera_changed(self):
        self.camera = Camera(baseline_px=self.baseline_spin.value(),
                             vertical_px=self.vertical_spin.value())
        self.recompute()

    def nudge_camera(self, delta: int):
        self.baseline_spin.setValue(self.baseline_spin.value() + delta)

    def _on_fill_changed(self):
        self.recompute()

    def _paint_depth(self, layer_idx: int, x: int, y: int, radius: int, value: float):
        if not self.scene or not self.scene.layers[layer_idx].editable:
            return
        brush = self.edits[layer_idx].brush
        H, W = self.scene.shape
        y0, y1 = max(0, y - radius), min(H, y + radius + 1)
        x0, x1 = max(0, x - radius), min(W, x + radius + 1)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        falloff = np.clip(1.0 - np.sqrt(((yy - y) ** 2 + (xx - x) ** 2) / max(radius * radius, 1)), 0, 1)
        brush[y0:y1, x0:x1] += (value * falloff).astype(np.float32)
        self.recompute()

    # ------------------------------------------------------------------
    # render
    # ------------------------------------------------------------------
    def fill_mode(self) -> str:
        return FILL_RAW if self.raw_radio.isChecked() else FILL_BACKGROUND

    def recompute(self):
        if not self.scene:
            return
        self.result = render(self.scene, self.camera, self.edits, self.fill_mode())
        # The pinned reference uses the pinned camera and depth edits, but the
        # current fill mode so the comparison reflects the same settings.
        if self.reference is not None and self.edits_a is not None:
            self.reference = render(self.scene, self.camera_a, self.edits_a,
                                    self.fill_mode())
        self._refresh_views()

    def pin_reference(self):
        if not self.scene:
            return
        self.camera_a = Camera(self.camera.baseline_px, self.camera.vertical_px)
        self.edits_a = [LayerEdit(gain=e.gain, bias=e.bias,
                                  brush=None if e.brush is None else e.brush.copy())
                        for e in self.edits]
        self.reference = render(self.scene, self.camera_a, self.edits_a, self.fill_mode())
        self.pin_label.setText(
            f"pinned @ baseline {self.camera_a.baseline_px:+.1f} px")
        self._refresh_views()

    def _refresh_views(self):
        if not self.scene or self.result is None:
            return
        s = self.result.stats
        fill_txt = "raw" if self.fill_mode() == FILL_RAW else "background"
        self.view_out.set_result(
            self.result,
            f"output  baseline {self.camera.baseline_px:+.0f} px  "
            f"|  holes {s['holes']} ({fill_txt})")
        if self.show_overlay.isChecked():
            self.view_out.set_overlay(layer_overlay(self.result))
        else:
            self.view_out.set_overlay(None)

        diff = None
        if self.reference is not None:
            diff = layout_diff(self.reference, self.result)
            if self.show_diff.isChecked():
                self.view_diff.set_result(self.result, "layout diff vs pinned")
                self.view_diff.set_overlay(diff_overlay(diff))
            else:
                self.view_diff.set_result(self.result, "current layout")
                self.view_diff.set_overlay(None)
            self.diff_label.setText(diff.describe())
        else:
            self.view_diff.set_result(self.result, "current layout (nothing pinned)")
            self.view_diff.set_overlay(None)
            self.diff_label.setText("")

        for i, dv in enumerate(self.depth_views):
            layer = self.scene.layers[i]
            edited = self.edits[i].apply(layer.depth)
            dv.set_depth(edited, f"layer {i}: {layer.name}  (drag to paint depth)")
            dv.set_brush(self.layer_boxes[i]["brush_radius"].value(),
                         self.layer_boxes[i]["brush_delta"].value())

        self.info_label.setText(self._scene_info())
        self._update_marker()
        self._update_status()

    def _scene_info(self) -> str:
        if not self.scene:
            return ""
        lines = [f"{self.scene.width}×{self.scene.height} · pixel shift dx = −baseline / depth"]
        for i, layer in enumerate(self.scene.layers):
            d = layer.depth
            if np.isfinite(d).any():
                lines.append(f"L{i} {layer.name}: {np.nanmin(d):.2f}–{np.nanmax(d):.2f} m")
        if "rect" in self.scene.meta:
            y0, y1, x0, x1 = self.scene.meta["rect"]
            lines.append(f"slab rect x[{x0},{x1}) y[{y0},{y1})")
        return "\n".join(lines)

    def _update_status(self):
        if self.result is None:
            return
        s = self.result.stats
        self.statusBar().showMessage(
            f"front shift {s['front_shift']:+.1f} px · back shift {s['back_shift']:+.1f} px · "
            f"holes {s['holes']} · filled {s['filled']} · cracks {s['cracks']}")

    # ------------------------------------------------------------------
    # probe
    # ------------------------------------------------------------------
    def _on_hover(self, x: int, y: int):
        self._probe_xy = (x, y)
        self._update_marker()
        self._update_probe_label()

    def _on_click(self, x: int, y: int):
        if self.result is None:
            return
        self._probe_xy = (x, y)
        info = self.result.probe(x, y)
        self.view_out.set_marker((x, y), self._probe_text(info))
        self._update_probe_label()

    def _update_marker(self):
        if self.result is None or self._probe_xy is None:
            self.view_out.set_marker(None)
            return
        x, y = self._probe_xy
        H, W = self.result.shape
        if not (0 <= x < W and 0 <= y < H):
            self.view_out.set_marker(None)
            return
        info = self.result.probe(x, y)
        self.view_out.set_marker((x, y), self._probe_text(info))

    def _probe_text(self, info: ProbeInfo) -> str:
        if self.scene is None:
            return ""
        head = f"({info.x}, {info.y})  {info.status}"
        if info.status == "visible":
            lay = self.scene.layers[info.layer].name
            return (f"{head}\nlayer: {lay}\nsource: {info.source}"
                    f"\ndepth: {info.depth:.3f} m\nshift: {info.shift[0]:+.2f} px")
        if info.status == "filled":
            lay = self.scene.layers[info.donor_layer].name
            return (f"{head}\ndonor layer: {lay}\ndonor: {info.donor_source}"
                    f"\ndepth: {info.donor_depth:.3f} m")
        return f"{head}\nno source pixel (hole marker)"

    def _update_probe_label(self):
        if self.result is None or self._probe_xy is None:
            return
        x, y = self._probe_xy
        H, W = self.result.shape
        if not (0 <= x < W and 0 <= y < H):
            return
        info = self.result.probe(x, y)
        text = info.describe(self.scene)
        self.probe_label.setText(f"output ({x}, {y}) — {text}")


def main(argv=None) -> int:
    app = QApplication(argv if argv is not None else sys.argv)
    app.setStyle("Fusion")
    pal = app.palette()
    pal.setColor(QPalette.ColorRole.Window, QColor(38, 40, 45))
    pal.setColor(QPalette.ColorRole.WindowText, QColor(232, 234, 238))
    pal.setColor(QPalette.ColorRole.Base, QColor(30, 32, 36))
    pal.setColor(QPalette.ColorRole.Text, QColor(232, 234, 238))
    pal.setColor(QPalette.ColorRole.Button, QColor(52, 55, 62))
    pal.setColor(QPalette.ColorRole.ButtonText, QColor(232, 234, 238))
    app.setPalette(pal)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
