"""Main application window tying canvas, magnifier and the engine together."""

from __future__ import annotations

import math

import cv2
import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDockWidget,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSlider,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .canvas import Document, EditorCanvas, ViewMode
from .geometry import SymLine
from .inpaint import RestorationParams, RestorationResult, overlay_gap_preview, restore
from .magnifier_widget import MagnifierDock
from .suggest import Suggestion, suggest_line

MODE_LABELS = {
    ViewMode.ORIGINAL: "原图",
    ViewMode.MIRROR: "镜像",
    ViewMode.OVERLAY: "叠图(原图+镜像)",
    ViewMode.RESTORED: "修复结果",
    ViewMode.GAP: "缺口标记",
}


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("对称镜像补图 — 扫描图徽修复")
        self.resize(1500, 950)

        self.doc: Document | None = None
        self.canvas: EditorCanvas | None = None
        self.result: RestorationResult | None = None
        self.suggestion: Suggestion | None = None
        self._syncing_spins = False

        # central area: the editor canvas is inserted once an image is opened
        self.central = QWidget()
        self.central_layout = QVBoxLayout(self.central)
        hint = QLabel("菜单「打开图片」或 Ctrl+O 载入扫描图\n然后: 画对称线 → 涂缺损 → 运行修复 → 导出")
        hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hint.setStyleSheet("color:#888; font-size:18px;")
        self.central_layout.addWidget(hint)
        self.setCentralWidget(self.central)

        self._build_actions()
        self._build_side_panel()
        self._build_magnifier_dock()
        self._build_statusbar()

        self.preview_timer = QTimer(self)
        self.preview_timer.setSingleShot(True)
        self.preview_timer.timeout.connect(self.run_preview)

    # ------------------------------------------------------------------ UI --
    def _build_actions(self) -> None:
        tb = self.addToolBar("文件")
        act_open = QAction("打开图片", self)
        act_open.setShortcut(QKeySequence.StandardKey.Open)
        act_open.triggered.connect(self.open_image)
        tb.addAction(act_open)

        act_export = QAction("导出结果+掩膜", self)
        act_export.setShortcut(QKeySequence.StandardKey.Save)
        act_export.triggered.connect(self.export_outputs)
        tb.addAction(act_export)

        act_zoom_in = QAction("放大", self)
        act_zoom_in.setShortcut(QKeySequence.StandardKey.ZoomIn)
        act_zoom_in.triggered.connect(lambda: self.canvas and self.canvas.scale(1.25, 1.25))
        tb.addAction(act_zoom_in)
        act_zoom_out = QAction("缩小", self)
        act_zoom_out.setShortcut(QKeySequence.StandardKey.ZoomOut)
        act_zoom_out.triggered.connect(lambda: self.canvas and self.canvas.scale(0.8, 0.8))
        tb.addAction(act_zoom_out)
        act_fit = QAction("适合窗口", self)
        act_fit.triggered.connect(self.fit_view)
        tb.addAction(act_fit)

    def _build_side_panel(self) -> None:
        dock = QDockWidget("工具", self)
        dock.setAllowedAreas(Qt.DockWidgetArea.LeftDockWidgetArea | Qt.DockWidgetArea.RightDockWidgetArea)
        panel = QWidget()
        v = QVBoxLayout(panel)

        # ---- tools --------------------------------------------------------
        g_tools = QGroupBox("1) 交互工具")
        f = QVBoxLayout(g_tools)
        self.tool_buttons: dict[str, QRadioButton] = {}
        tool_defs = [
            ("line", "画/改对称线 (两点或拖黄点)"),
            ("brush", "画笔 — 涂缺损"),
            ("eraser", "橡皮 — 修缺损边界"),
            ("rect_damage", "矩形缺损"),
            ("suggest_roi", "建议ROI (完整小区域)"),
            ("cc_region", "颜色采样区域(可选)"),
        ]
        for key, label in tool_defs:
            rb = QRadioButton(label)
            rb.toggled.connect(lambda checked, k=key: checked and self._set_tool(k))
            self.tool_buttons[key] = rb
            f.addWidget(rb)
        self.tool_buttons["line"].setChecked(True)

        row = QHBoxLayout()
        row.addWidget(QLabel("笔刷直径"))
        self.brush_spin = QSpinBox()
        self.brush_spin.setRange(2, 300)
        self.brush_spin.setValue(18)
        self.brush_spin.valueChanged.connect(self._on_brush_size)
        row.addWidget(self.brush_spin)
        f.addLayout(row)
        row2 = QHBoxLayout()
        b_clear = QPushButton("清空缺损")
        b_clear.clicked.connect(lambda: self.doc and self.canvas.clear_damage())
        b_clearcc = QPushButton("清空颜色区")
        b_clearcc.clicked.connect(lambda: self.doc and self.canvas.clear_cc_region())
        row2.addWidget(b_clear)
        row2.addWidget(b_clearcc)
        f.addLayout(row2)
        v.addWidget(g_tools)

        # ---- line precision ----------------------------------------------
        g_line = QGroupBox("2) 对称线 (浮点精度)")
        form = QFormLayout(g_line)
        self.spin_x1, self.spin_y1, self.spin_x2, self.spin_y2 = (
            QDoubleSpinBox() for _ in range(4)
        )
        for sp in (self.spin_x1, self.spin_y1, self.spin_x2, self.spin_y2):
            sp.setDecimals(3)
            sp.setRange(-100000, 100000)
            sp.setSingleStep(0.5)
            sp.valueChanged.connect(self._line_from_spins)
        form.addRow("x1", self.spin_x1)
        form.addRow("y1", self.spin_y1)
        form.addRow("x2", self.spin_x2)
        form.addRow("y2", self.spin_y2)

        nudge = QHBoxLayout()
        for text, slot in [
            ("角度+0.1°", lambda: self._nudge_line(0.1, 0.0)),
            ("角度-0.1°", lambda: self._nudge_line(-0.1, 0.0)),
            ("平移+0.5px", lambda: self._nudge_line(0.0, 0.5)),
            ("平移-0.5px", lambda: self._nudge_line(0.0, -0.5)),
        ]:
            b = QPushButton(text)
            b.clicked.connect(slot)
            nudge.addWidget(b)
        form.addRow(nudge)

        b_suggest = QPushButton("在ROI内建议微调")
        b_suggest.clicked.connect(self.run_suggestion)
        form.addRow(b_suggest)
        self.lbl_suggest = QLabel("建议: 尚未运行")
        self.lbl_suggest.setWordWrap(True)
        form.addRow(self.lbl_suggest)
        accept_row = QHBoxLayout()
        self.b_accept = QPushButton("采用建议")
        self.b_accept.setEnabled(False)
        self.b_accept.clicked.connect(self._accept_suggestion)
        b_reject = QPushButton("放弃(保留手动)")
        b_reject.clicked.connect(self._reject_suggestion)
        accept_row.addWidget(self.b_accept)
        accept_row.addWidget(b_reject)
        form.addRow(accept_row)
        v.addWidget(g_line)

        # ---- view ---------------------------------------------------------
        g_view = QGroupBox("3) 视图")
        vf = QVBoxLayout(g_view)
        self.mode_combo = QComboBox()
        for mode, label in MODE_LABELS.items():
            self.mode_combo.addItem(label, mode)
        self.mode_combo.currentIndexChanged.connect(self._on_mode)
        vf.addWidget(self.mode_combo)
        row = QHBoxLayout()
        row.addWidget(QLabel("叠图不透明度"))
        self.alpha_slider = QSlider(Qt.Orientation.Horizontal)
        self.alpha_slider.setRange(5, 100)
        self.alpha_slider.setValue(45)
        self.alpha_slider.valueChanged.connect(
            lambda val: self.canvas and self.canvas.set_overlay_alpha(val / 100.0)
        )
        row.addWidget(self.alpha_slider)
        vf.addLayout(row)
        v.addWidget(g_view)

        # ---- restoration params ------------------------------------------
        g_par = QGroupBox("4) 补图参数")
        pf = QFormLayout(g_par)
        self.feather_slider = QSlider(Qt.Orientation.Horizontal)
        self.feather_slider.setRange(0, 400)
        self.feather_slider.setValue(60)
        self.feather_slider.valueChanged.connect(self._schedule_preview)
        pf.addRow("边缘过渡(0.1px)", self.feather_slider)
        self.cc_check = QCheckBox("小幅颜色校正")
        self.cc_check.setChecked(True)
        self.cc_check.toggled.connect(self._schedule_preview)
        pf.addRow(self.cc_check)
        self.cc_strength = QSlider(Qt.Orientation.Horizontal)
        self.cc_strength.setRange(0, 100)
        self.cc_strength.setValue(50)
        self.cc_strength.valueChanged.connect(self._schedule_preview)
        pf.addRow("校正强度", self.cc_strength)
        self.live_check = QCheckBox("实时预览(改参数自动重算)")
        self.live_check.setChecked(True)
        pf.addRow(self.live_check)
        b_run = QPushButton("立即运行修复预览")
        b_run.clicked.connect(self.run_preview)
        pf.addRow(b_run)
        v.addWidget(g_par)
        v.addStretch(1)

        dock.setWidget(panel)
        self.addDockWidget(Qt.DockWidgetArea.LeftDockWidgetArea, dock)

    def _build_magnifier_dock(self) -> None:
        self.magnifier = MagnifierDock(lambda: self.doc)
        dock = QDockWidget("5) 配对放大", self)
        dock.setWidget(self.magnifier)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, dock)
        self.magnifier.btn_pick.toggled.connect(self._on_pick_toggle)

    def _build_statusbar(self) -> None:
        self.status = QLabel("打开一张扫描图开始")
        self.statusBar().addWidget(self.status)

    # ------------------------------------------------------------- document
    def open_image(self, path: str | None = None) -> None:
        if path is None:
            path, _ = QFileDialog.getOpenFileName(
                self, "打开图片", "",
                "图像 (*.png *.jpg *.jpeg *.tif *.tiff *.bmp *.webp)",
            )
        if not path:
            return
        img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            QMessageBox.warning(self, "打开失败", f"无法读取: {path}")
            return
        h, w = img.shape[:2]
        self.doc = Document(
            image=img,
            damage=np.zeros((h, w), np.uint8),
            cc_region=np.zeros((h, w), np.uint8),
        )
        if self.canvas is not None:
            self.central_layout.removeWidget(self.canvas)
            self.canvas.deleteLater()
        self.canvas = EditorCanvas(self.doc)
        self.central_layout.addWidget(self.canvas)
        self.canvas.lineEdited.connect(self._on_line_edited)
        self.canvas.maskEdited.connect(self._on_mask_edited)
        self.canvas.roiEdited.connect(lambda _r: self.run_suggestion())
        self.canvas.hoverMoved.connect(self._on_hover)
        self.canvas.set_overlay_alpha(self.alpha_slider.value() / 100.0)
        self.result = None
        self.suggestion = None
        self.b_accept.setEnabled(False)
        self.lbl_suggest.setText("建议: 尚未运行")
        self.setWindowTitle(f"对称镜像补图 — {path}")
        self.status.setText(f"{path}  {w}×{h}")
        self.magnifier.update_views()
        QTimer.singleShot(0, self.fit_view)

    def fit_view(self) -> None:
        if self.doc is None:
            return
        self.canvas.fitInView(
            0, 0, self.doc.w, self.doc.h, Qt.AspectRatioMode.KeepAspectRatio
        )

    # -------------------------------------------------------------- handlers
    def _set_tool(self, key: str) -> None:
        from .canvas import Tool
        if self.doc is None:
            return
        self.canvas.tool = Tool(key)
        if key != "line":
            self._set_pick_mode(False)

    def _on_brush_size(self, val: int) -> None:
        if self.doc:
            self.doc.brush_size = val

    def _on_hover(self, x: float, y: float) -> None:
        if self.doc is None:
            return
        extra = ""
        if self.result is not None:
            extra = (f" | 已补 {int((self.result.fill_mask > 0).sum())}px, "
                     f"缺口 {int((self.result.gap_mask > 0).sum())}px")
        self.status.setText(f"坐标 ({x:.1f}, {y:.1f}){extra}")

    def _on_pick_toggle(self, checked: bool) -> None:
        self._set_pick_mode(checked)

    def _set_pick_mode(self, on: bool) -> None:
        if self.doc is None:
            self.magnifier.btn_pick.setChecked(False)
            return
        if on:
            # picking points is independent of the active editing tool
            self.canvas.pick_callback = self._pick_and_release
        else:
            self.canvas.pick_callback = None
        self.magnifier.btn_pick.blockSignals(True)
        self.magnifier.btn_pick.setChecked(on)
        self.magnifier.btn_pick.blockSignals(False)

    def _pick_and_release(self, x: float, y: float) -> None:
        self.magnifier.set_point(x, y)
        # one-shot: return to normal editing after a point is chosen
        self._set_pick_mode(False)

    def _on_mask_edited(self) -> None:
        self._schedule_preview()

    def _on_line_edited(self, line: SymLine) -> None:
        # manual edit invalidates the pending suggestion; the damage mask stays
        self.suggestion = None
        self.b_accept.setEnabled(False)
        self._sync_spins(line)
        self.magnifier.update_views()
        self._schedule_preview()

    def _sync_spins(self, line: SymLine) -> None:
        self._syncing_spins = True
        self.spin_x1.setValue(line.x1)
        self.spin_y1.setValue(line.y1)
        self.spin_x2.setValue(line.x2)
        self.spin_y2.setValue(line.y2)
        self._syncing_spins = False

    def _line_from_spins(self) -> None:
        if self._syncing_spins or self.doc is None or self.doc.line is None:
            return
        line = SymLine(
            self.spin_x1.value(), self.spin_y1.value(),
            self.spin_x2.value(), self.spin_y2.value(),
        )
        if line.length < 1e-6:
            return
        self.canvas.set_line(line)

    def _nudge_line(self, d_angle_deg: float, d_offset: float) -> None:
        if self.doc is None or self.doc.line is None:
            return
        base = self.doc.line
        angle = base.angle + math.radians(d_angle_deg)
        anchor = base.p1 + base.normal * d_offset
        u = np.array([math.cos(angle), math.sin(angle)], np.float64)
        half = base.length / 2.0
        line = SymLine.from_points(
            (anchor[0] - u[0] * half, anchor[1] - u[1] * half),
            (anchor[0] + u[0] * half, anchor[1] + u[1] * half),
        )
        self.canvas.set_line(line)

    # ----------------------------------------------------------- suggestion
    def run_suggestion(self) -> None:
        if self.doc is None or self.doc.line is None or self.doc.suggest_roi is None:
            QMessageBox.information(self, "建议对称线", "请先画对称线，再用「建议ROI」框一个两侧都完整的小区域")
            return
        try:
            sug = suggest_line(self.doc.image, self.doc.suggest_roi, self.doc.line)
        except ValueError as exc:
            QMessageBox.warning(self, "建议对称线", str(exc))
            return
        self.suggestion = sug
        self.b_accept.setEnabled(True)
        self.lbl_suggest.setText(
            f"角度微调 {sug.angle_delta_deg:+.3f}°, 法向平移 {sug.offset_delta_px:+.2f}px\n"
            f"拟合差异 {sug.baseline_score:.2f} → {sug.score:.2f} (0-255, {sug.pixel_count} 对像素)\n"
            f"点「采用建议」生效，或继续手动拖动覆盖"
        )

    def _accept_suggestion(self) -> None:
        if self.suggestion is not None and self.doc is not None:
            self.canvas.set_line(self.suggestion.line)

    def _reject_suggestion(self) -> None:
        self.suggestion = None
        self.b_accept.setEnabled(False)
        self.lbl_suggest.setText("建议: 已放弃，沿用手动对称线")

    # --------------------------------------------------------------- preview
    def _on_mode(self, index: int) -> None:
        mode = self.mode_combo.itemData(index)
        if mode == ViewMode.GAP and self.result is None:
            self.run_preview()
        self.canvas.set_view_mode(mode)

    def _params(self) -> RestorationParams:
        return RestorationParams(
            feather_px=self.feather_slider.value() / 10.0,
            color_correct=self.cc_check.isChecked(),
            cc_strength=self.cc_strength.value() / 100.0,
        )

    def _schedule_preview(self) -> None:
        if self.doc is None or not self.live_check.isChecked():
            return
        if self.doc.line is None or not self.doc.damage.any():
            return
        self.preview_timer.start(300)

    def run_preview(self) -> None:
        if self.doc is None or self.doc.line is None:
            return
        if not self.doc.damage.any():
            self.status.setText("还没有缺损区域: 用画笔/矩形标出需要补的范围")
            return
        cc_region = self.doc.cc_region if self.doc.cc_region.any() else None
        self.result = restore(
            self.doc.image, self.doc.damage, self.doc.line,
            params=self._params(), cc_region=cc_region,
        )
        self.canvas.set_restored(self.result.result)
        self.canvas.set_gap_preview(overlay_gap_preview(self.doc.image, self.result))
        # keep whichever result view is currently active up to date
        self.canvas.set_view_mode(self.mode_combo.currentData())
        n_fill = int((self.result.fill_mask > 0).sum())
        n_gap = int((self.result.gap_mask > 0).sum())
        cm = self.result.color_model
        slope_txt = ", ".join(f"{s:.3f}" for s in cm.slope)
        off_txt = ", ".join(f"{o:+.2f}" for s, o in zip(cm.slope, cm.offset))
        self.status.setText(
            f"已补 {n_fill}px | 缺口 {n_gap}px (双侧破损或镜像出图) | "
            f"颜色模型 slope=[{slope_txt}] offset=[{off_txt}] | "
            f"校正样本 {self.result.cc_sample_count} 对"
        )

    # ---------------------------------------------------------------- export
    def export_outputs(self, directory: str | None = None) -> None:
        if self.doc is None:
            return
        # always compute at full resolution from current masks/line
        if self.result is None:
            self.run_preview()
        if self.result is None:
            return
        if directory is None:
            directory = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not directory:
            return
        base = "restored"
        paths = {
            f"{base}_result.png": self.result.result,
            f"{base}_fill_mask.png": self.result.fill_mask,
            f"{base}_gap_mask.png": self.result.gap_mask,
        }
        alpha_u8 = np.clip(self.result.alpha * 255, 0, 255).astype(np.uint8)
        paths[f"{base}_alpha.png"] = alpha_u8
        saved = []
        for name, arr in paths.items():
            ok = cv2.imwrite(f"{directory}/{name}", arr)
            if ok:
                saved.append(name)
        QMessageBox.information(
            self, "导出完成",
            "原尺寸导出:\n" + "\n".join(saved) +
            "\n\nfill_mask=实际取得镜像像素的区域; gap_mask=无法补的缺口",
        )


def run() -> int:
    import sys
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()
