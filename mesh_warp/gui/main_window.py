"""Main window: menus, side panel, status and test-scenario entry points."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..editor import Editor, loaded_from_array
from ..mesh import MAX_GRID, MIN_GRID
from ..test_image import generate_test_image
from .canvas import CanvasWidget

NONE = "—"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("网格形变工具 — Mesh Warp")
        self.resize(1280, 880)
        self.editor = Editor()
        self._suspend_updates = False

        self.canvas = CanvasWidget(self.editor)
        self.setCentralWidget(self._build_layout())
        self._build_menus()
        self._connect()
        self._refresh_all()

    # -- layout ---------------------------------------------------------------
    def _build_layout(self) -> QWidget:
        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(self.canvas)

        panel = QWidget()
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(10, 10, 10, 10)
        panel_layout.setSpacing(10)

        panel_layout.addWidget(self._build_selected_group())
        panel_layout.addWidget(self._build_mesh_group())
        panel_layout.addWidget(self._build_sample_group())
        panel_layout.addWidget(self._build_scenario_group())
        panel_layout.addStretch(1)
        hint = QLabel(
            "操作：拖动白点（锁定点为橙色）\n"
            "滚轮缩放 · 中键或空格+拖动平移 · F 适应窗口\n"
            "点击空白位置（或 Alt+点击）取样源坐标 · 双击控制点切换锁定\n"
            "Esc 取消当前拖动 · ⌘Z 撤销 · ⇧⌘Z 重做"
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#888;")
        panel_layout.addWidget(hint)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(panel)
        scroll.setMinimumWidth(330)
        scroll.setMaximumWidth(420)
        splitter.addWidget(scroll)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 0)
        return splitter

    def _build_selected_group(self) -> QGroupBox:
        box = QGroupBox("控制点")
        layout = QVBoxLayout(box)
        self.point_label = QLabel("未选中")
        self.point_label.setStyleSheet("font-weight:600;")
        layout.addWidget(self.point_label)
        form = QFormLayout()
        self.x_spin = QDoubleSpinBox()
        self.y_spin = QDoubleSpinBox()
        for spin in (self.x_spin, self.y_spin):
            spin.setDecimals(2)
            spin.setRange(-100000, 100000)
            spin.setSingleStep(1.0)
            spin.setKeyboardTracking(False)
        self.src_label = QLabel(NONE)
        form.addRow("目标 X", self.x_spin)
        form.addRow("目标 Y", self.y_spin)
        form.addRow("原始坐标", self.src_label)
        layout.addLayout(form)

        row = QHBoxLayout()
        self.apply_btn = QPushButton("应用坐标")
        self.reset_point_btn = QPushButton("单点复位")
        row.addWidget(self.apply_btn)
        row.addWidget(self.reset_point_btn)
        layout.addLayout(row)

        row2 = QHBoxLayout()
        self.lock_check = QCheckBox("锁定该点")
        self.reset_all_btn = QPushButton("全部复位")
        row2.addWidget(self.lock_check)
        row2.addWidget(self.reset_all_btn)
        layout.addLayout(row2)
        self.lock_border_check = QCheckBox("固定全部外边界")
        layout.addWidget(self.lock_border_check)
        return box

    def _build_mesh_group(self) -> QGroupBox:
        box = QGroupBox("网格")
        layout = QVBoxLayout(box)
        form = QFormLayout()
        self.cols_combo = QComboBox()
        self.rows_combo = QComboBox()
        for n in range(MIN_GRID, MAX_GRID + 1):
            self.cols_combo.addItem(f"{n}", n)
            self.rows_combo.addItem(f"{n}", n)
        self.cols_combo.setCurrentText(str(self.editor.grid_cols))
        self.rows_combo.setCurrentText(str(self.editor.grid_rows))
        form.addRow("列数", self.cols_combo)
        form.addRow("行数", self.rows_combo)
        layout.addLayout(form)
        self.rebuild_btn = QPushButton("重建网格")
        layout.addWidget(self.rebuild_btn)
        self.show_mesh_check = QCheckBox("显示三角形")
        self.show_points_check = QCheckBox("显示控制点编号")
        self.show_rest_check = QCheckBox("显示原点/原位置")
        self.show_reject_check = QCheckBox("保留最近拒绝标记")
        for c in (
            self.show_mesh_check,
            self.show_points_check,
            self.show_rest_check,
            self.show_reject_check,
        ):
            c.setChecked(True)
            layout.addWidget(c)
        return box

    def _build_sample_group(self) -> QGroupBox:
        box = QGroupBox("取样 / 状态")
        layout = QVBoxLayout(box)
        self.sample_label = QLabel("点击结果中的位置以查看来源")
        self.sample_label.setWordWrap(True)
        self.sample_label.setMinimumHeight(72)
        self.sample_label.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        layout.addWidget(self.sample_label)
        self.rejection_label = QLabel("")
        self.rejection_label.setWordWrap(True)
        self.rejection_label.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        self.rejection_label.setMinimumHeight(44)
        self.rejection_label.setStyleSheet("color:#d86060;")
        layout.addWidget(self.rejection_label)
        self.history_label = QLabel("")
        self.history_label.setWordWrap(True)
        layout.addWidget(self.history_label)
        self.zoom_label = QLabel("缩放 100%")
        layout.addWidget(self.zoom_label)
        return box

    def _build_scenario_group(self) -> QGroupBox:
        box = QGroupBox("测试场景")
        layout = QVBoxLayout(box)
        self.test_image_btn = QPushButton("生成测试图并载入")
        self.push_btn = QPushButton("局部推拉示例")
        self.border_btn = QPushButton("边界固定示例")
        self.invalid_btn = QPushButton("无效折叠尝试")
        layout.addWidget(self.test_image_btn)
        layout.addWidget(self.push_btn)
        layout.addWidget(self.border_btn)
        layout.addWidget(self.invalid_btn)
        note = QLabel("三个场景会自动载入内置测试图并重置网格。")
        note.setStyleSheet("color:#888;")
        note.setWordWrap(True)
        layout.addWidget(note)
        return box

    def _build_menus(self) -> None:
        bar = self.menuBar()

        file_menu = bar.addMenu("文件")
        self.open_action = QAction("打开 PNG…", self)
        self.open_action.setShortcut(QKeySequence.Open)
        self.export_png_action = QAction("导出 PNG…", self)
        self.export_json_action = QAction("导出网格 JSON…", self)
        self.load_json_action = QAction("载入网格 JSON…", self)
        self.quit_action = QAction("退出", self)
        self.quit_action.setShortcut(QKeySequence.Quit)
        for a in (
            self.open_action,
            self.export_png_action,
            self.export_json_action,
            self.load_json_action,
        ):
            file_menu.addAction(a)
        file_menu.addSeparator()
        file_menu.addAction(self.quit_action)

        edit_menu = bar.addMenu("编辑")
        self.undo_action = QAction("撤销", self)
        self.undo_action.setShortcut(QKeySequence.Undo)
        self.redo_action = QAction("重做", self)
        self.redo_action.setShortcut(QKeySequence.Redo)
        edit_menu.addAction(self.undo_action)
        edit_menu.addAction(self.redo_action)

        view_menu = bar.addMenu("视图")
        self.fit_action = QAction("适应窗口", self)
        self.fit_action.setShortcut(QKeySequence("F"))
        self.zoom_in_action = QAction("放大", self)
        self.zoom_in_action.setShortcut(QKeySequence.ZoomIn)
        self.zoom_out_action = QAction("缩小", self)
        self.zoom_out_action.setShortcut(QKeySequence.ZoomOut)
        view_menu.addAction(self.fit_action)
        view_menu.addAction(self.zoom_in_action)
        view_menu.addAction(self.zoom_out_action)

        help_menu = bar.addMenu("帮助")
        self.help_action = QAction("操作说明", self)
        help_menu.addAction(self.help_action)

        self.statusBar().showMessage("就绪")

    def _connect(self) -> None:
        self.canvas.pointSelected.connect(self._on_point_selected)
        self.canvas.pointDragged.connect(self._on_drag)
        self.canvas.pointDragFinished.connect(self._on_drag_finished)
        self.canvas.dragRejected.connect(self._on_drag_rejected)
        self.canvas.sampled.connect(self._on_sampled)
        self.canvas.zoomChanged.connect(self._on_zoom)
        self.canvas.statusMessage.connect(self.statusBar().showMessage)

        # Editing the target pixel coordinates applies immediately (like a drag)
        # and uses the same validation / rejection path.
        self.x_spin.valueChanged.connect(self._on_spin_changed)
        self.y_spin.valueChanged.connect(self._on_spin_changed)
        self.apply_btn.clicked.connect(self._apply_coords)
        self.reset_point_btn.clicked.connect(self._reset_point)
        self.reset_all_btn.clicked.connect(self._reset_all)
        self.lock_check.toggled.connect(self._on_lock_toggled)
        self.lock_border_check.toggled.connect(self._on_lock_border_toggled)
        self.rebuild_btn.clicked.connect(self._rebuild_grid)
        self.show_mesh_check.toggled.connect(self._on_visibility)
        self.show_points_check.toggled.connect(self._on_visibility)
        self.show_rest_check.toggled.connect(self._on_visibility)
        self.show_reject_check.toggled.connect(self._on_visibility)

        self.open_action.triggered.connect(self._open_png)
        self.export_png_action.triggered.connect(self._export_png)
        self.export_json_action.triggered.connect(self._export_json)
        self.load_json_action.triggered.connect(self._load_json)
        self.quit_action.triggered.connect(self.close)
        self.undo_action.triggered.connect(self._undo)
        self.redo_action.triggered.connect(self._redo)
        self.fit_action.triggered.connect(self.canvas.fit_to_view)
        self.zoom_in_action.triggered.connect(lambda: self.canvas.set_zoom(self.canvas.zoom * 1.25))
        self.zoom_out_action.triggered.connect(lambda: self.canvas.set_zoom(self.canvas.zoom / 1.25))
        self.help_action.triggered.connect(self._show_help)

        self.test_image_btn.clicked.connect(lambda: self._load_test_scene(None))
        self.push_btn.clicked.connect(lambda: self._load_test_scene("push"))
        self.border_btn.clicked.connect(lambda: self._load_test_scene("border"))
        self.invalid_btn.clicked.connect(self._invalid_scenario)

    # -- state sync -----------------------------------------------------------
    def _refresh_all(self) -> None:
        self._suspend_updates = True
        try:
            self._refresh_selected()
            self._refresh_history()
            self._refresh_rejection()
            self._refresh_zoom()
            self.cols_combo.setCurrentIndex(self.editor.grid_cols - MIN_GRID)
            self.rows_combo.setCurrentIndex(self.editor.grid_rows - MIN_GRID)
            has_doc = self.editor.has_document
            for widget in (
                self.export_png_action,
                self.export_json_action,
                self.reset_all_btn,
                self.rebuild_btn,
                self.lock_border_check,
                self.show_mesh_check,
                self.show_points_check,
                self.show_rest_check,
                self.show_reject_check,
            ):
                widget.setEnabled(has_doc)
            self.undo_action.setEnabled(bool(self.editor.history and self.editor.history.can_undo))
            self.redo_action.setEnabled(bool(self.editor.history and self.editor.history.can_redo))
        finally:
            self._suspend_updates = False

    def _refresh_selected(self) -> None:
        idx = self.canvas.selected
        mesh = self.editor.mesh
        if idx is not None and mesh is not None and idx >= mesh.n_points:
            idx = None
            self.canvas.selected = None
        enabled = idx is not None and mesh is not None
        for w in (
            self.x_spin,
            self.y_spin,
            self.apply_btn,
            self.reset_point_btn,
            self.lock_check,
        ):
            w.setEnabled(enabled)
        if not enabled:
            self.point_label.setText("未选中")
            self.src_label.setText(NONE)
            self.lock_check.setChecked(False)
            return
        assert mesh is not None
        x, y = mesh.dst[idx]
        sx, sy = mesh.src[idx]
        self.point_label.setText(
            f"点 {idx + 1}  ·  ({mesh.ij(idx)[0] + 1}, {mesh.ij(idx)[1] + 1})  ·  "
            f"三角形邻接 {self._incident_count(idx)}"
        )
        self.src_label.setText(f"({sx:.2f}, {sy:.2f})")
        self._suspend_updates = True
        self.x_spin.setValue(float(x))
        self.y_spin.setValue(float(y))
        self.lock_check.setChecked(bool(mesh.locked[idx]))
        self._suspend_updates = False
        self.apply_btn.setEnabled(not bool(mesh.locked[idx]))
        self.reset_point_btn.setEnabled(not bool(mesh.locked[idx]))

    def _incident_count(self, idx: int) -> int:
        mesh = self.editor.mesh
        if mesh is None:
            return 0
        return int(np.count_nonzero((mesh.tris == idx).any(axis=1)))

    def _refresh_rejection(self) -> None:
        message = self.editor.last_rejection
        if message:
            # Keep the panel compact; the full diagnostic is in the tooltip
            # and the status bar.
            short = message if len(message) <= 120 else message[:117].rstrip() + "…"
            self.rejection_label.setText("最近拒绝原因：\n" + short)
            self.rejection_label.setToolTip(message)
        else:
            self.rejection_label.setText("最近没有无效形变")
            self.rejection_label.setToolTip("")
        self.rejection_label.setStyleSheet(
            "color:#d86060;" if message else "color:#888;"
        )

    def _refresh_history(self) -> None:
        h = self.editor.history
        if h is None:
            self.history_label.setText("")
            return
        undo = h.undo_label if h.can_undo else "—"
        redo = h.redo_label if h.can_redo else "—"
        self.history_label.setText(f"可撤销：{undo}\n可重做：{redo}")
        self.undo_action.setEnabled(h.can_undo)
        self.redo_action.setEnabled(h.can_redo)
        self.lock_border_check.blockSignals(True)
        self.lock_border_check.setChecked(self.editor.border_is_locked())
        self.lock_border_check.blockSignals(False)

    def _refresh_zoom(self) -> None:
        self.zoom_label.setText(f"缩放 {self.canvas.zoom * 100:.0f}%")

    # -- slots ----------------------------------------------------------------
    def _on_point_selected(self, index: int) -> None:
        self._refresh_selected()
        mesh = self.editor.mesh
        if mesh is not None:
            x, y = mesh.dst[index]
            self.statusBar().showMessage(
                f"已选点 {index + 1}: 目标 ({x:.2f}, {y:.2f})，原始 ({mesh.src[index][0]:.2f}, {mesh.src[index][1]:.2f})"
            )
        self._update_sample_labels()

    def _on_drag(self, x: float, y: float) -> None:
        self._refresh_selected()
        self.statusBar().showMessage(f"拖动至 ({x:.0f}, {y:.0f})")

    def _on_drag_finished(self, committed: bool) -> None:
        self._refresh_all()
        if self.editor.last_rejection:
            self.statusBar().showMessage(
                "拖动结束：该位置无效，已保留最近有效形变", 8000
            )
        self.canvas.invalidate_image()
        if committed:
            self.statusBar().showMessage("拖动已记录，可撤销")
        else:
            self.statusBar().showMessage("没有产生变形")

    def _on_drag_rejected(self, message: str) -> None:
        self._refresh_rejection()
        self.statusBar().showMessage("无效位置已拒绝：" + message, 6000)

    def _on_sampled(self, x: float, y: float) -> None:
        sample = self.editor.sample((x, y))
        self.canvas.sample_point = (x, y)
        self.canvas.sample_covered = sample.covered
        if sample.covered:
            sx, sy = sample.source
            self.sample_label.setText(
                f"结果坐标 ({x:.1f}, {y:.1f})\n"
                f"来源坐标 ({sx:.2f}, {sy:.2f})\n"
                f"所属三角形 #{sample.triangle}\n"
                f"重心坐标 ({sample.barycentric[0]:.3f}, {sample.barycentric[1]:.3f}, {sample.barycentric[2]:.3f})"
            )
            self.statusBar().showMessage(
                f"取样：源坐标 ({sx:.2f}, {sy:.2f})，三角形 #{sample.triangle}"
            )
        else:
            self.sample_label.setText(
                f"结果坐标 ({x:.1f}, {y:.1f})\n该位置无来源：网格未覆盖或三角形已变形移开"
            )
            self.statusBar().showMessage("该位置无来源（无来源）")

    def _on_zoom(self, zoom: float) -> None:
        self._refresh_zoom()

    def _update_sample_labels(self) -> None:
        if not self.editor.has_document:
            self.sample_label.setText("点击结果中的位置以查看来源")
        self._refresh_history()

    def _on_spin_changed(self) -> None:
        if self._suspend_updates:
            return
        # 输入即应用：更新选中点的目标坐标并使用与拖动相同的校验。
        idx = self.canvas.selected
        if idx is None or self.editor.mesh is None:
            return
        mesh = self.editor.mesh
        if mesh.locked[idx]:
            return
        x, y = self.x_spin.value(), self.y_spin.value()
        if abs(x - mesh.dst[idx][0]) < 1e-9 and abs(y - mesh.dst[idx][1]) < 1e-9:
            return
        ok, msg = self.editor.set_point_target(idx, x, y)
        if not ok:
            self.statusBar().showMessage("坐标无效，已保持最近有效形变：" + msg, 8000)
            self._refresh_selected()
        self.canvas.invalidate_image()
        self._refresh_all()

    def _apply_coords(self) -> None:
        idx = self.canvas.selected
        if idx is None:
            return
        self._on_spin_changed()
        self._refresh_all()

    def _reset_point(self) -> None:
        idx = self.canvas.selected
        if idx is None:
            return
        ok, msg = self.editor.reset_point(idx)
        self.statusBar().showMessage(msg)
        self.canvas.invalidate_image()
        self._refresh_all()

    def _reset_all(self) -> None:
        self.editor.reset_all()
        self.canvas.invalidate_image()
        self._refresh_all()
        self.statusBar().showMessage("已全部复位（可撤销）")

    def _on_lock_toggled(self, checked: bool) -> None:
        if self._suspend_updates:
            return
        idx = self.canvas.selected
        if idx is None:
            return
        self.editor.set_point_locked(idx, checked)
        self.canvas.invalidate_image()
        self._refresh_all()
        self.statusBar().showMessage(f"点 {idx + 1} {'已锁定' if checked else '已解锁'}")

    def _on_lock_border_toggled(self, checked: bool) -> None:
        if self._suspend_updates:
            return
        self.editor.set_border_locked(checked)
        self.canvas.invalidate_image()
        self._refresh_all()
        self.statusBar().showMessage("外边界已固定" if checked else "外边界已解锁")

    def _on_visibility(self) -> None:
        self.canvas.show_mesh = self.show_mesh_check.isChecked()
        self.canvas.show_labels = self.show_points_check.isChecked()
        self.canvas.show_points = self.show_points_check.isChecked()
        self.canvas.show_rest = self.show_rest_check.isChecked()
        self.canvas.show_last_rejection = self.show_reject_check.isChecked()
        self.canvas.update()

    # -- commands -------------------------------------------------------------
    def _open_png(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开 PNG", "", "PNG 图片 (*.png)")
        if not path:
            return
        try:
            self.editor.open_image(path)
        except Exception as exc:  # noqa: BLE001 - user-facing message
            QMessageBox.warning(self, "无法载入", str(exc))
            return
        self.canvas.selected = None
        self.canvas.sample_point = None
        self.canvas.invalidate_image()
        self.canvas.fit_to_view()
        self._refresh_all()
        self._update_sample_labels()
        self.statusBar().showMessage(f"已载入 {Path(path).name} ({self.editor.image.width}×{self.editor.image.height})")

    def _rebuild_grid(self) -> None:
        if not self.editor.has_document:
            return
        cols = int(self.cols_combo.currentData())
        rows = int(self.rows_combo.currentData())
        mesh = self.editor.mesh
        dirty = bool(
            mesh
            and (
                not mesh.is_identity
                or mesh.locked.any()
                or (cols, rows) != (mesh.cols, mesh.rows)
            )
        )
        if dirty:
            answer = QMessageBox.question(
                self,
                "重建网格会清除形变",
                "重建网格会清除当前所有形变与锁定状态。继续吗？",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.No,
            )
            if answer != QMessageBox.Yes:
                self._refresh_all()
                return
        self.editor.rebuild_mesh(cols, rows)
        self.canvas.selected = None
        self.canvas.sample_point = None
        self.canvas.invalidate_image()
        self.canvas.fit_to_view()
        self._refresh_all()
        self.statusBar().showMessage(f"已重建 {cols}×{rows} 网格")

    def _export_png(self) -> None:
        if not self.editor.has_document:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出透明 PNG", "warped.png", "PNG 图片 (*.png)"
        )
        if not path:
            return
        try:
            self.editor.export_png(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        self.statusBar().showMessage(f"已导出 PNG：{path}（不含辅助线）")

    def _export_json(self) -> None:
        if not self.editor.has_document:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出控制网格 JSON", "mesh.json", "JSON (*.json)"
        )
        if not path:
            return
        try:
            self.editor.export_json(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        self.statusBar().showMessage(f"已导出网格 JSON：{path}")

    def _load_json(self) -> None:
        if not self.editor.has_document:
            QMessageBox.information(self, "请先载入图片", "请先载入网格对应的 PNG 图片，再载入 JSON。")
            return
        path, _ = QFileDialog.getOpenFileName(self, "载入控制网格 JSON", "", "JSON (*.json)")
        if not path:
            return
        try:
            self.editor.load_mesh_json(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "无法载入网格", str(exc))
            return
        self.canvas.selected = None
        self.canvas.sample_point = None
        self.canvas.invalidate_image()
        self.canvas.fit_to_view()
        self._refresh_all()
        self.statusBar().showMessage("网格已载入")

    def _undo(self) -> None:
        ok, msg = self.editor.undo()
        self.canvas.invalidate_image()
        self.canvas.dragging = False
        self._refresh_all()
        self.statusBar().showMessage(msg if ok else "没有可撤销的操作")

    def _redo(self) -> None:
        ok, msg = self.editor.redo()
        self.canvas.invalidate_image()
        self.canvas.dragging = False
        self._refresh_all()
        self.statusBar().showMessage(msg if ok else "没有可重做的操作")

    def _show_help(self) -> None:
        QMessageBox.information(
            self,
            "操作说明",
            "拖动控制点建立局部形变；拖动过程中无效位置会以红色标记并拒绝，"
            "网格保持最近一次有效形变。\n\n"
            "锁定点不能拖动；勾选“固定全部外边界”可锁定全部边界点。\n"
            "单项拖动产生一步撤销；锁定与复位同样可撤销。\n"
            "滚动滚轮缩放，中键或空格+拖动平移；缩放平移不改变控制点像素坐标。\n"
            "选中控制点后可输入目标像素坐标；点击（或 Alt+点击）结果中的位置可查看来源坐标、"
            "所属三角形与重心坐标，网格未覆盖处显示“无来源”。\n"
            "导出 PNG 为原画布尺寸透明图，不含控制网格辅助线；导出网格 JSON 可在"
            "重新载入同一图片后恢复完全一致的形变与锁定状态。",
        )

    def _invalid_scenario(self) -> None:
        """Load the test image and immediately show a rejected fold attempt."""
        self._load_test_scene("invalid")
        self._show_invalid_in_editor()
        self.statusBar().showMessage(
            "已预览一次无效折叠：红色三角形/边是被拒绝的候选位置，网格本身未改变"
        )

    # -- test scenarios -------------------------------------------------------
    def _load_test_scene(self, scenario: str | None) -> None:
        image = generate_test_image(720, 540)
        loaded = loaded_from_array(image, "内置测试图.png")
        self.editor.set_document(loaded, 5, 4)
        self.canvas.selected = None
        self.canvas.sample_point = None
        self.canvas.clear_demo()
        self.canvas.invalidate_image()
        mesh = self.editor.mesh
        assert mesh is not None
        message = "已载入内置测试图，5×4 网格"

        if scenario in ("push", "border", "invalid"):
            # All three scenarios fix the outer boundary, which is the safe
            # starting point for manual experiments.
            self.editor.set_border_locked(True)
            self.canvas.show_mesh = True
            self.show_mesh_check.setChecked(True)

        if scenario == "push":
            p = mesh.index(2, 1)
            self.editor.set_point_target(p, *mesh.src[p] + np.array([58.0, -42.0]))
            self.canvas.selected = p
            message = "局部推拉示例：内部点被推动，外边界保持固定（可撤销）"
        elif scenario == "border":
            n = mesh.index(2, 1)
            self.editor.set_point_target(n, *mesh.src[n] + np.array([42.0, 30.0]))
            self.editor.set_point_locked(n, True)
            self.canvas.selected = n
            message = (
                f"边界固定示例：4 条外边全部固定，内部点 {n + 1} 也已锁定；"
                "其他内部点可拖动，边界不会移动"
            )
        elif scenario == "invalid":
            p = mesh.index(2, 1)
            self.canvas.selected = p
            message = (
                f"无效折叠尝试：已选中点 {p + 1}。把它横向拖到相邻点之外，"
                "红色标记会出现且松开后不生效，网格保留最近有效形变"
            )
        self.canvas.fit_to_view()
        self.canvas.invalidate_image()
        self._refresh_all()
        self.statusBar().showMessage(message)

    def _show_invalid_in_editor(self) -> None:
        """Select a point and preview a rejected fold without altering the mesh."""
        if not self.editor.has_document:
            return
        mesh = self.editor.mesh
        assert mesh is not None
        p = mesh.index(2, 1)
        self.canvas.selected = p
        bad_pose = mesh.dst.copy()
        bad_pose[p] = mesh.dst[p] + np.array([mesh.width * 0.32, -6.0])
        report = mesh.check_pose(bad_pose)
        if report.ok:
            return
        self.canvas.show_demo_rejection(p, tuple(bad_pose[p]), report)


def run(argv: list[str] | None = None) -> int:
    import sys

    existing = QApplication.instance()
    owns_app = existing is None
    app = existing if existing is not None else QApplication(
        argv if argv is not None else sys.argv
    )
    app.setApplicationName("Mesh Warp")
    window = MainWindow()
    window.show()
    window.canvas.fit_to_view()
    code = app.exec()
    if owns_app:
        window.close()
    return code
