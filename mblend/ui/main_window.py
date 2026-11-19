"""Main application window."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSpinBox,
    QSplitter,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ..color import ImageError, linear_to_rgb8, load_rgb_image
from ..engine import MODE_NAIVE, MODE_PYRAMID
from ..samples import DEFAULT_SAMPLE, make_sample
from ..session import Session
from .canvas import (
    TOOL_ERASE,
    TOOL_PAINT_A,
    TOOL_PAINT_B,
    TOOL_PICK,
    ImageCanvas,
    ViewTransform,
)
from .widgets import LevelInspector


class MainWindow(QMainWindow):
    MAX_SIZE = 1200

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("多分辨率混合工具")
        self.resize(1440, 940)
        self.session: Session | None = None
        self._suspend_signals = False
        self._custom: dict[str, np.ndarray] = {}
        self._custom_paths: dict[str, str] = {}

        self.canvas = ImageCanvas()
        self.canvas.paint_requested.connect(self._on_paint)
        self.canvas.stroke_started.connect(self._on_stroke_started)
        self.canvas.stroke_finished.connect(self._on_stroke_finished)
        self.canvas.picked.connect(self._on_picked)
        self.canvas.zoom_changed.connect(self._on_zoom_changed)

        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        self.tabs.addTab(self.canvas, "结果")

        self.comparison_canvas = ImageCanvas()
        self.comparison_canvas.set_overlay_mask(None)
        self.comparison_canvas.picked.connect(self._on_picked)
        self.comparison_canvas.paint_requested.connect(self._on_paint)
        self.comparison_canvas.stroke_started.connect(self._on_stroke_started)
        self.comparison_canvas.stroke_finished.connect(self._on_stroke_finished)
        self.comparison_page = self._build_comparison_page()
        self.tabs.addTab(self.comparison_page, "对照 · 普通混合")

        self.a_canvas = ImageCanvas()
        self.a_canvas.read_only = True
        self.a_canvas.picked.connect(self._on_picked)
        self.tabs.addTab(self.a_canvas, "图 A")

        self.b_canvas = ImageCanvas()
        self.b_canvas.read_only = True
        self.b_canvas.picked.connect(self._on_picked)
        self.tabs.addTab(self.b_canvas, "图 B")

        self.mask_canvas = ImageCanvas()
        self.mask_canvas.set_overlay_mask(None)
        self.mask_canvas.read_only = True
        self.mask_canvas.picked.connect(self._on_picked)
        self.tabs.addTab(self.mask_canvas, "掩码")

        self.level_inspector = LevelInspector()
        self.level_inspector.level_selected.connect(self._on_level_selected)
        self.tabs.addTab(self.level_inspector, "分层查看")

        self.tabs.currentChanged.connect(self._on_tab_changed)

        # Keep all full-resolution views at the same zoom/pan so the mask can
        # be painted in either the result or the comparison tab.
        for linked in (self.comparison_canvas, self.a_canvas, self.b_canvas, self.mask_canvas):
            self.canvas.link_view(linked)
        self.comparison_canvas.link_view(self.diff_canvas)

        self.probe_label = QLabel("点选「探针」后单击画面取样")
        self.probe_label.setWordWrap(True)
        self.probe_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )
        self.probe_label.setMinimumHeight(150)
        self.probe_label.setAlignment(
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft
        )

        side = QWidget()
        side_layout = QVBoxLayout(side)
        side_layout.setContentsMargins(6, 6, 6, 6)
        side_layout.setSpacing(6)
        side_layout.addWidget(self._build_io_group())
        side_layout.addWidget(self._build_tool_group())
        side_layout.addWidget(self._build_blend_group())
        side_layout.addWidget(self._build_mask_group())
        side_layout.addWidget(self._build_probe_group(), 1)
        side_layout.addWidget(self._build_export_group())
        side_layout.addStretch(0)
        side.setMinimumWidth(330)
        side.setMaximumWidth(400)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self.tabs)
        splitter.addWidget(side)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 0)
        splitter.setSizes([1050, 360])
        self.setCentralWidget(splitter)

        self._status = self.statusBar()
        self._status.showMessage("就绪")

        self._canvas_debounce = QTimer(self)
        self._canvas_debounce.setSingleShot(True)
        self._canvas_debounce.setInterval(30)
        self._canvas_debounce.timeout.connect(self._refresh_paint_view)

        self._build_shortcuts()
        self._load_sample(DEFAULT_SAMPLE)

    def _build_shortcuts(self) -> None:
        from PySide6.QtGui import QKeySequence, QShortcut

        def add(sequence: str, slot) -> None:
            shortcut = QShortcut(QKeySequence(sequence), self)
            # Single-key shortcuts would otherwise steal typing from the
            # file-name field and the spin boxes.
            shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
            shortcut.activated.connect(slot)

        for sequence, button in (
            ("A", self.tool_a),
            ("B", self.tool_b),
            ("E", self.tool_erase),
            ("I", self.tool_pick),
        ):
            add(sequence, lambda b=button: b.setChecked(True))
        add("Ctrl+Z", self._on_undo)
        add("Ctrl+Shift+Z", self._on_redo)
        add("Ctrl+Y", self._on_redo)
        add("Ctrl+=", lambda: self.canvas.zoom_by(1.25))
        add("Ctrl+-", lambda: self.canvas.zoom_by(1 / 1.25))
        add("Ctrl+0", lambda: self._for_all_canvases("fit"))
        add("Ctrl+1", lambda: self._for_all_canvases("actual"))
        add(
            "[",
            lambda: self.size_spin.setValue(max(1.0, self.size_spin.value() / 1.25)),
        )
        add(
            "]",
            lambda: self.size_spin.setValue(min(400.0, self.size_spin.value() * 1.25)),
        )

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------
    def _build_comparison_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)

        bar = QHBoxLayout()
        bar.setContentsMargins(8, 6, 8, 0)
        self.comparison_caption = QLabel("对照结果")
        self.comparison_caption.setStyleSheet("font-weight:600;")
        bar.addWidget(self.comparison_caption)
        bar.addStretch(1)
        self.diff_check = QCheckBox("显示差异（线性光，×10，中灰=无差异）")
        self.diff_check.setChecked(False)
        self.diff_check.toggled.connect(self._on_toggle_diff)
        bar.addWidget(self.diff_check)
        layout.addLayout(bar)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.addWidget(self.comparison_canvas)
        self.diff_canvas = ImageCanvas()
        self.diff_canvas.read_only = True
        self.diff_canvas.picked.connect(self._on_picked)
        self.diff_canvas.setVisible(False)
        split.addWidget(self.diff_canvas)
        split.setSizes([700, 700])
        layout.addWidget(split, 1)
        self.comparison_split = split
        return page

    def _on_toggle_diff(self, checked: bool) -> None:
        self.diff_canvas.setVisible(checked)
        if checked and self.session is not None:
            self.diff_canvas.set_image(
                self.session.comparison_diff_rgb8(), keep_view=True
            )
            self.diff_canvas.transform = ViewTransform(
                self.comparison_canvas.transform.zoom,
                self.comparison_canvas.transform.offset_x,
                self.comparison_canvas.transform.offset_y,
            )
            self.diff_canvas.update()

    def _build_io_group(self) -> QGroupBox:
        group = QGroupBox("图像对")
        layout = QVBoxLayout(group)
        layout.setSpacing(4)

        self.load_a_button = QPushButton("载入图 A…")
        self.load_a_button.clicked.connect(lambda: self._choose_file("A"))
        self.load_b_button = QPushButton("载入图 B…")
        self.load_b_button.clicked.connect(lambda: self._choose_file("B"))
        row = QHBoxLayout()
        row.addWidget(self.load_a_button)
        row.addWidget(self.load_b_button)
        layout.addLayout(row)

        self.pair_label = QLabel("—")
        self.pair_label.setWordWrap(True)
        layout.addWidget(self.pair_label)

        self.sample_combo = QComboBox()
        for name, label in (
            ("brightness", "亮度差"),
            ("stripes", "细条纹"),
            ("blocks", "大色块"),
            ("odd_size", "奇数尺寸"),
        ):
            self.sample_combo.addItem(label, name)
        sample_row = QHBoxLayout()
        sample_row.addWidget(self.sample_combo, 1)
        self.sample_button = QPushButton("载入示例")
        self.sample_button.clicked.connect(self._on_load_sample)
        sample_row.addWidget(self.sample_button)
        layout.addLayout(sample_row)
        return group

    def _build_tool_group(self) -> QGroupBox:
        group = QGroupBox("画笔")
        layout = QVBoxLayout(group)
        layout.setSpacing(4)

        self.tool_a = QRadioButton("涂向 A")
        self.tool_b = QRadioButton("涂向 B")
        self.tool_erase = QRadioButton("擦除")
        self.tool_pick = QRadioButton("探针取样")
        self.tool_a.setChecked(True)
        for button, tool in (
            (self.tool_a, TOOL_PAINT_A),
            (self.tool_b, TOOL_PAINT_B),
            (self.tool_erase, TOOL_ERASE),
            (self.tool_pick, TOOL_PICK),
        ):
            button.toggled.connect(
                lambda checked, t=tool: checked and self._set_tool(t)
            )
        tool_row = QHBoxLayout()
        tool_row.addWidget(self.tool_a)
        tool_row.addWidget(self.tool_b)
        tool_row.addWidget(self.tool_erase)
        tool_row.addWidget(self.tool_pick)
        layout.addLayout(tool_row)

        form = QFormLayout()
        form.setContentsMargins(0, 0, 0, 0)
        self.size_spin = QDoubleSpinBox()
        self.size_spin.setRange(1, 400)
        self.size_spin.setValue(24)
        self.size_spin.setSuffix(" px")
        self.size_spin.valueChanged.connect(self._on_brush_size)
        form.addRow("粗细", self.size_spin)

        self.soft_spin = QSpinBox()
        self.soft_spin.setRange(0, 100)
        self.soft_spin.setValue(50)
        self.soft_spin.setSuffix(" %")
        self.soft_spin.valueChanged.connect(self._on_softness)
        form.addRow("软边", self.soft_spin)
        layout.addLayout(form)

        history_row = QHBoxLayout()
        self.undo_button = QPushButton("撤销")
        self.undo_button.clicked.connect(self._on_undo)
        self.redo_button = QPushButton("重做")
        self.redo_button.clicked.connect(self._on_redo)
        history_row.addWidget(self.undo_button)
        history_row.addWidget(self.redo_button)
        layout.addLayout(history_row)

        mask_row = QHBoxLayout()
        self.fill_a_button = QPushButton("全涂 A")
        self.fill_a_button.clicked.connect(lambda: self._mask_op("fill_a"))
        self.fill_b_button = QPushButton("全涂 B")
        self.fill_b_button.clicked.connect(lambda: self._mask_op("fill_b"))
        self.invert_button = QPushButton("反转")
        self.invert_button.clicked.connect(lambda: self._mask_op("invert"))
        self.reset_button = QPushButton("重置")
        self.reset_button.setToolTip("把掩码恢复到载入时的状态并清空历史")
        self.reset_button.clicked.connect(self._on_reset_mask)
        mask_row.addWidget(self.fill_a_button)
        mask_row.addWidget(self.fill_b_button)
        mask_row.addWidget(self.invert_button)
        mask_row.addWidget(self.reset_button)
        layout.addLayout(mask_row)
        return group

    def _build_blend_group(self) -> QGroupBox:
        group = QGroupBox("混合")
        layout = QVBoxLayout(group)
        layout.setSpacing(4)

        self.mode_combo = QComboBox()
        self.mode_combo.addItem("多分辨率混合", MODE_PYRAMID)
        self.mode_combo.addItem("普通逐像素混合", MODE_NAIVE)
        self.mode_combo.currentIndexChanged.connect(self._on_mode_changed)
        form = QFormLayout()
        form.setContentsMargins(0, 0, 0, 0)
        form.addRow("模式", self.mode_combo)

        self.level_spin = QSpinBox()
        self.level_spin.setRange(2, 6)
        self.level_spin.setValue(4)
        self.level_spin.valueChanged.connect(self._on_levels_changed)
        form.addRow("层数", self.level_spin)
        layout.addLayout(form)

        self.zoom_label = QLabel("缩放 100%")
        self.zoom_label.setStyleSheet("color:#888;")
        layout.addWidget(self.zoom_label)

        zoom_row = QHBoxLayout()
        fit_button = QPushButton("适应窗口")
        fit_button.clicked.connect(lambda: self._for_all_canvases("fit"))
        actual_button = QPushButton("1:1")
        actual_button.clicked.connect(lambda: self._for_all_canvases("actual"))
        zoom_row.addWidget(fit_button)
        zoom_row.addWidget(actual_button)
        layout.addLayout(zoom_row)
        return group

    def _build_mask_group(self) -> QGroupBox:
        group = QGroupBox("显示")
        layout = QVBoxLayout(group)
        self.show_overlay_check = QCheckBox("显示掩码覆盖层（橙=A，蓝=B）")
        self.show_overlay_check.setChecked(True)
        self.show_overlay_check.toggled.connect(self._on_toggle_overlay)
        layout.addWidget(self.show_overlay_check)

        self.mask_stats_label = QLabel("—")
        self.mask_stats_label.setWordWrap(True)
        self.mask_stats_label.setStyleSheet("color:#888;")
        layout.addWidget(self.mask_stats_label)
        return group

    def _build_probe_group(self) -> QGroupBox:
        group = QGroupBox("探针")
        layout = QVBoxLayout(group)
        layout.addWidget(self.probe_label)
        return group

    def _build_export_group(self) -> QGroupBox:
        group = QGroupBox("导出")
        layout = QVBoxLayout(group)
        row = QHBoxLayout()
        self.stem_edit = QLineEdit("blend")
        row.addWidget(QLabel("文件名"))
        row.addWidget(self.stem_edit, 1)
        layout.addLayout(row)
        self.export_button = QPushButton("导出 PNG + 掩码 + 参数记录…")
        self.export_button.clicked.connect(self._on_export)
        layout.addWidget(self.export_button)
        self.export_status = QLabel("")
        self.export_status.setWordWrap(True)
        self.export_status.setStyleSheet("color:#888;")
        layout.addWidget(self.export_status)
        return group

    # ------------------------------------------------------------------
    # Session handling
    # ------------------------------------------------------------------
    def _on_load_sample(self) -> None:
        name = self.sample_combo.currentData()
        try:
            self._load_sample(name)
        except Exception as exc:  # pragma: no cover - defensive
            QMessageBox.critical(self, "示例载入失败", str(exc))

    def _load_sample(self, name: str) -> None:
        a, b = make_sample(name)
        width = a.shape[1]
        # Give every sample pair an obvious, uneven starting mask so the
        # multi-resolution effect is visible immediately.
        yy, xx = np.mgrid[0 : a.shape[0], 0 : a.shape[1]]
        mask = (xx / max(width - 1, 1)).astype(np.float32)
        mask = np.clip(mask * 1.15 - 0.05, 0.0, 1.0)
        mask += 0.18 * np.sin(yy / 23.0) * np.sin(xx / 37.0)
        mask = np.clip(mask, 0.0, 1.0).astype(np.float32)
        self._custom = {}
        self._custom_paths = {}
        self._install_session(Session(a, b, name=f"示例 · {name}", mask=mask))

    def _choose_file(self, which: str) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            f"选择图 {which}",
            "",
            "图像 (*.png *.jpg *.jpeg *.PNG *.JPG *.JPEG)",
        )
        if not path:
            return
        self._load_pair_file(which, path)

    def _ask_keep_pair(self, message: str) -> None:
        self._status.showMessage(message, 8000)

    def _load_pair_file(self, which: str, path: str) -> None:
        try:
            loaded = load_rgb_image(path, max_size=self.MAX_SIZE)
        except ImageError as exc:
            self._ask_keep_pair(f"图 {which} 载入失败：{exc}（保留当前图对）")
            QMessageBox.warning(self, "载入失败", f"{exc}\n\n已保留当前图对。")
            return

        other_key = "B" if which == "A" else "A"
        other = self._custom.get(other_key)
        if other is not None and other.shape != loaded.shape:
            message = (
                f"图 {which} 尺寸为 {loaded.shape[1]}×{loaded.shape[0]}，"
                f"与图 {other_key} 的 {other.shape[1]}×{other.shape[0]} 不一致，已拒绝。"
                "当前图对保持不变。"
            )
            self._ask_keep_pair(message)
            QMessageBox.warning(self, "尺寸不一致", message)
            return

        self._custom[which] = loaded
        self._custom_paths[which] = path
        if "A" not in self._custom or "B" not in self._custom:
            missing = "B" if "A" in self._custom else "A"
            hint = (
                f"已载入图 {which}（{loaded.shape[1]}×{loaded.shape[0]}）。"
                f"请载入同尺寸的图 {missing} 以组成图对；当前图对保持显示。"
            )
            self._status.showMessage(hint, 10000)
            self.pair_label.setText(
                f"待配对：已载入图 {which} {loaded.shape[1]}×{loaded.shape[0]}\n"
                f"当前显示 {self.session.name}"
                if self.session is not None
                else hint
            )
            return

        a = self._custom["A"]
        b = self._custom["B"]
        if a.shape != b.shape:
            message = (
                f"两张图尺寸不一致（A {a.shape[1]}×{a.shape[0]}，"
                f"B {b.shape[1]}×{b.shape[0]}），已拒绝。"
            )
            self._status.showMessage(message, 8000)
            QMessageBox.warning(self, "尺寸不一致", message)
            return
        names = " + ".join(
            Path(value).name
            for value in (
                self._custom_paths.get("A", ""),
                self._custom_paths.get("B", ""),
            )
            if value
        )
        self._install_session(Session(a, b, name=names))

    def _install_session(self, session: Session) -> None:
        self.session = session
        self.canvas.set_overlay_mask(None)
        for other in (
            self.comparison_canvas,
            self.a_canvas,
            self.b_canvas,
            self.mask_canvas,
        ):
            other.set_image(None)
        self.canvas.set_image(session.result_rgb8(), keep_view=False)
        self.canvas.set_overlay_mask(session.mask)
        self.a_canvas.set_image(session.engine.a_rgb8)
        self.b_canvas.set_image(session.engine.b_rgb8)
        self.mask_canvas.set_image(self._mask_preview())
        self.comparison_canvas.set_image(session.comparison_rgb8())
        self.comparison_canvas.set_overlay_mask(session.mask)
        if self.diff_canvas.isVisible():
            self.diff_canvas.set_image(session.comparison_diff_rgb8())
        self.level_inspector.set_session(session)

        for canvas in (self.comparison_canvas, self.a_canvas, self.b_canvas, self.mask_canvas):
            self.canvas.link_view(canvas)
        self.canvas.fit_to_view()
        for canvas in (self.comparison_canvas, self.a_canvas, self.b_canvas, self.mask_canvas):
            canvas.fit_to_view()

        self._suspend_signals = True
        self.level_spin.setMaximum(max(2, min(6, session.max_levels)))
        self.level_spin.setValue(session.config.levels)
        index = self.mode_combo.findData(session.config.mode)
        if index >= 0:
            self.mode_combo.setCurrentIndex(index)
        self.mode_combo.setEnabled(session.pyramid_available)
        self.level_spin.setEnabled(session.pyramid_available)
        self._suspend_signals = False

        self._update_comparison_tab_title()
        self.pair_label.setText(
            f"{session.engine.width}×{session.engine.height} · "
            f"{session.engine.a_rgb8.shape[0]} 行 × {session.engine.a_rgb8.shape[1]} 列\n"
            f"多分辨率最多 {session.max_levels} 层"
        )
        self.export_status.setText("")
        self.probe_label.setText("选择「探针取样」工具后单击画面")
        self._update_mask_stats()
        self._update_history_buttons()
        self._update_probe()
        self._status.showMessage(
            f"已载入 {session.engine.width}×{session.engine.height} 图像对"
        )

    def _update_comparison_tab_title(self) -> None:
        if self.session is None:
            return
        if self.session.config.mode == MODE_PYRAMID:
            title = "对照 · 普通混合"
            self.comparison_caption.setText(
                f"普通逐像素混合（对照当前多分辨率 · {self.session.config.levels} 层）"
            )
            self.diff_check.setText("显示差异（线性光，×10，中灰=无差异）")
        else:
            title = "对照 · 多分辨率混合"
            self.comparison_caption.setText(
                f"多分辨率混合（对照当前普通混合 · {self.session.config.levels} 层）"
            )
            self.diff_check.setText("显示差异（线性光，×10，中灰=无差异）")
        self.tabs.setTabText(1, title)

    # ------------------------------------------------------------------
    # Painting
    # ------------------------------------------------------------------
    def _on_stroke_started(self) -> None:
        if self.session is None:
            return
        self.session.mask_doc.begin_stroke()

    def _on_paint(
        self, x0: float, y0: float, x1: float, y1: float, target: float
    ) -> None:
        if self.session is None:
            return
        self.session.mask_doc.paint(
            (x0, y0),
            (x1, y1),
            self.canvas.brush_radius,
            self.canvas.softness,
            target,
        )
        self.session.touch()
        self.canvas.set_overlay_mask(self.session.mask)
        self.comparison_canvas.set_overlay_mask(self.session.mask)
        self.comparison_canvas.set_image(
            self.session.comparison_rgb8(), keep_view=True
        )
        self._canvas_debounce.start()

    def _on_stroke_finished(self) -> None:
        if self.session is None:
            return
        changed = self.session.mask_doc.end_stroke()
        self.session.touch()
        if changed:
            self._update_history_buttons()
        self._refresh_all()

    def _refresh_paint_view(self) -> None:
        if self.session is None:
            return
        self.canvas.set_image(self.session.result_rgb8(), keep_view=True)
        self.canvas.set_overlay_mask(self.session.mask)
        self.comparison_canvas.set_image(
            self.session.comparison_rgb8(), keep_view=True
        )
        self.comparison_canvas.set_overlay_mask(self.session.mask)
        self._update_mask_stats()

    def _refresh_all(self) -> None:
        if self.session is None:
            return
        session = self.session
        self.canvas.set_image(session.result_rgb8(), keep_view=True)
        self.canvas.set_overlay_mask(session.mask)
        self.comparison_canvas.set_image(session.comparison_rgb8(), keep_view=True)
        self.comparison_canvas.set_overlay_mask(session.mask)
        if self.diff_canvas.isVisible():
            self.diff_canvas.set_image(
                session.comparison_diff_rgb8(), keep_view=True
            )
        self.a_canvas.set_image(session.engine.a_rgb8, keep_view=True)
        self.b_canvas.set_image(session.engine.b_rgb8, keep_view=True)
        self.mask_canvas.set_image(self._mask_preview(), keep_view=True)
        self.level_inspector.refresh()
        self._update_comparison_tab_title()
        self._update_mask_stats()
        self._update_probe()
        self._update_history_buttons()

    def _mask_preview(self) -> np.ndarray:
        assert self.session is not None
        gray = np.clip(np.rint(self.session.mask * 255.0), 0, 255).astype(np.uint8)
        return np.repeat(gray[..., None], 3, axis=2)

    def _on_picked(self, x: int, y: int) -> None:
        if self.session is None:
            return
        if not (0 <= x < self.session.width and 0 <= y < self.session.height):
            return
        self.session.set_pick((x, y))
        self._update_probe()

    def _set_tool(self, tool: str) -> None:
        for canvas in (self.canvas, self.comparison_canvas):
            canvas.tool = tool
            canvas.update()

    def _on_brush_size(self, value: float) -> None:
        for canvas in (self.canvas, self.comparison_canvas):
            canvas.brush_radius = float(value)
            canvas.update()

    def _on_softness(self, value: int) -> None:
        for canvas in (self.canvas, self.comparison_canvas):
            canvas.softness = value / 100.0
            canvas.update()

    def _on_toggle_overlay(self, checked: bool) -> None:
        self.canvas.show_overlay = checked
        self.canvas.update()

    # ------------------------------------------------------------------
    # Mask operations
    # ------------------------------------------------------------------
    def _mask_op(self, name: str) -> None:
        if self.session is None:
            return
        doc = self.session.mask_doc
        changed = getattr(doc, name)()
        if changed:
            self.session.touch()
            self._refresh_all()

    def _on_reset_mask(self) -> None:
        if self.session is None:
            return
        self.session.mask_doc.mask[:] = self.session.initial_mask
        self.session.mask_doc.clear_history()
        self.session.touch()
        self._refresh_all()

    def _on_undo(self) -> None:
        if self.session is None:
            return
        if self.session.mask_doc.undo():
            self.session.touch()
            self._refresh_all()

    def _on_redo(self) -> None:
        if self.session is None:
            return
        if self.session.mask_doc.redo():
            self.session.touch()
            self._refresh_all()

    def _update_history_buttons(self) -> None:
        if self.session is None:
            self.undo_button.setEnabled(False)
            self.redo_button.setEnabled(False)
            return
        self.undo_button.setEnabled(self.session.mask_doc.can_undo)
        self.redo_button.setEnabled(self.session.mask_doc.can_redo)

    def _update_mask_stats(self) -> None:
        if self.session is None:
            self.mask_stats_label.setText("—")
            return
        stats = self.session.mask_doc.stats()
        self.mask_stats_label.setText(
            f"掩码均值 {stats['mean']:.3f} · "
            f"A 区 {stats['a_fraction'] * 100:.1f}% · "
            f"B 区 {stats['b_fraction'] * 100:.1f}%\n"
            f"范围 {stats['min']:.3f} – {stats['max']:.3f}"
        )

    # ------------------------------------------------------------------
    # Blend parameters
    # ------------------------------------------------------------------
    def _on_mode_changed(self, index: int) -> None:
        if self._suspend_signals or self.session is None:
            return
        mode = self.mode_combo.itemData(index)
        try:
            self.session.set_mode(mode)
        except ValueError as exc:
            QMessageBox.information(self, "无法切换", str(exc))
            self._suspend_signals = True
            self.mode_combo.setCurrentIndex(
                self.mode_combo.findData(self.session.config.mode)
            )
            self._suspend_signals = False
            return
        self._refresh_all()

    def _on_levels_changed(self, value: int) -> None:
        if self._suspend_signals or self.session is None:
            return
        try:
            self.session.set_levels(value)
        except ValueError as exc:
            QMessageBox.information(self, "层数无效", str(exc))
            self._suspend_signals = True
            self.level_spin.setValue(self.session.config.levels)
            self._suspend_signals = False
            return
        self._refresh_all()

    def _on_level_selected(self, index: int) -> None:
        if self.session is None:
            return
        self.session.set_inspected_level(index)

    # ------------------------------------------------------------------
    # Camera/view helpers
    # ------------------------------------------------------------------
    def _for_all_canvases(self, action: str) -> None:
        canvases = [
            self.canvas,
            self.comparison_canvas,
            self.a_canvas,
            self.b_canvas,
            self.mask_canvas,
        ]
        primary = next((c for c in canvases if c.image is not None), None)
        if primary is None:
            return
        if action == "fit":
            primary.fit_to_view()
        else:
            primary.set_zoom(1.0)

    def _on_zoom_changed(self, zoom: float) -> None:
        self.zoom_label.setText(
            f"缩放 {zoom * 100:.0f}% · {self.canvas.brush_radius:.0f} px 画笔"
        )

    def _on_tab_changed(self, index: int) -> None:
        if self.session is None:
            return
        if index == 1:
            self.comparison_canvas.set_image(
                self.session.comparison_rgb8(), keep_view=True
            )
            self.comparison_canvas.set_overlay_mask(self.session.mask)
        elif index == 2:
            self.a_canvas.set_image(self.session.engine.a_rgb8, keep_view=True)
        elif index == 3:
            self.b_canvas.set_image(self.session.engine.b_rgb8, keep_view=True)
        elif index == 4:
            self.mask_canvas.set_image(self._mask_preview(), keep_view=True)
        elif index == 5:
            self.level_inspector.refresh()

    # ------------------------------------------------------------------
    # Probe
    # ------------------------------------------------------------------
    def _update_probe(self) -> None:
        if self.session is None:
            return
        probe = self.session.probe()
        if probe is None:
            self.probe_label.setText("选择「探针取样」工具后单击画面")
            return
        a = probe["a_rgb8"]
        b = probe["b_rgb8"]
        naive = probe["naive_linear"]
        pyramid = probe["pyramid_linear"]
        result = probe["result_linear"]
        naive8 = linear_to_rgb8(np.asarray([naive]))[0]
        pyramid8 = linear_to_rgb8(np.asarray([pyramid]))[0]
        result8 = linear_to_rgb8(np.asarray([result]))[0]
        active = "多分辨率" if probe["mode"] == MODE_PYRAMID else "普通"
        self.probe_label.setText(
            f"坐标 ({probe['x']}, {probe['y']})\n"
            f"A  sRGB {a[0]:3d},{a[1]:3d},{a[2]:3d}   "
            f"线性 {probe['a_linear'][0]:.4f},{probe['a_linear'][1]:.4f},{probe['a_linear'][2]:.4f}\n"
            f"B  sRGB {b[0]:3d},{b[1]:3d},{b[2]:3d}   "
            f"线性 {probe['b_linear'][0]:.4f},{probe['b_linear'][1]:.4f},{probe['b_linear'][2]:.4f}\n"
            f"掩码 {probe['mask']:.4f}（1=A，0=B）\n"
            f"普通混合 sRGB {naive8[0]},{naive8[1]},{naive8[2]}\n"
            f"多分辨率 sRGB {pyramid8[0]},{pyramid8[1]},{pyramid8[2]}\n"
            f"当前显示（{active}）sRGB {result8[0]},{result8[1]},{result8[2]}"
        )

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------
    def _on_export(self) -> None:
        if self.session is None:
            return
        directory = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not directory:
            return
        stem = self.stem_edit.text().strip() or "blend"
        try:
            info = self.session.export(directory, stem)
        except Exception as exc:  # surface any export failure to the user
            QMessageBox.critical(self, "导出失败", str(exc))
            self.export_status.setText(f"导出失败：{exc}")
            return
        self.export_status.setText(
            f"已写出 {Path(info.output_png).name}、"
            f"{Path(info.mask_png).name}、{Path(info.record_json).name}"
        )
        self._status.showMessage("导出完成", 5000)

    # ------------------------------------------------------------------
    def closeEvent(self, event) -> None:  # noqa: N802
        super().closeEvent(event)
