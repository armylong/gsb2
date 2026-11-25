"""PySide6 desktop interface for the stencil template checker."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from PySide6.QtCore import Qt, QPointF, QRectF, QTimer, Signal
from PySide6.QtGui import (
    QAction,
    QColor,
    QFont,
    QImage,
    QKeySequence,
    QPen,
    QPixmap,
    QWheelEvent,
)
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
    QGraphicsEllipseItem,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsTextItem,
    QGraphicsView,
)

from .core import (
    Analysis,
    Bridge,
    Proposal,
    analyze_paper,
    apply_manual_stroke,
    apply_proposal,
    export_binary,
    generate_proposals,
    load_binary,
    paint_protected_disk,
    paper_from_gray,
    raster_bridge,
    undo_bridge,
    verify_export,
)
from .samples import Sample, all_samples


MODE_SELECT = "选择/点选纸块"
MODE_BRIDGE = "手工拖桥"
MODE_PROTECT = "标记不可改细节"
MODE_ERASE_PROTECT = "擦除保护标记"


class ImageView(QGraphicsView):
    """Zoomable pixel-coordinate view.

    Scene units are image pixels.  Bridge width is therefore stored and drawn
    in image pixels; zoom changes only the transform, never the raster bridge.
    """

    pixelClicked = Signal(int, int)
    bridgePreview = Signal(int, int, int, int)
    bridgeCommitted = Signal(int, int, int, int)
    protectionPainted = Signal(int, int)
    interactionFinished = Signal()
    pointerInfo = Signal(str)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.scene = QGraphicsScene(self)
        self.setScene(self.scene)
        self.setRenderHints(self.renderHints())
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setBackgroundBrush(QColor("#20242c"))
        self.mode = MODE_SELECT
        self._middle_panning = False
        self._pan_start: QPointF | None = None
        self._bridging = False
        self._bridge_start: tuple[int, int] | None = None
        self._protecting = False
        self.setMouseTracking(True)

    def set_mode(self, mode: str) -> None:
        self.mode = mode
        if mode == MODE_BRIDGE:
            self.setCursor(Qt.CursorShape.CrossCursor)
        elif mode in (MODE_PROTECT, MODE_ERASE_PROTECT):
            self.setCursor(Qt.CursorShape.ForbiddenCursor if mode == MODE_ERASE_PROTECT else Qt.CursorShape.PointingHandCursor)
        else:
            self.setCursor(Qt.CursorShape.ArrowCursor)

    def wheelEvent(self, event: QWheelEvent) -> None:
        # Ctrl/Command-wheel zooms. Plain wheel remains free for trackpad and
        # scroll-bar navigation instead of hijacking every pan gesture.
        if event.modifiers() & (
            Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier
        ):
            delta = event.angleDelta().y()
            if delta == 0:
                return
            factor = 1.18 if delta > 0 else 1 / 1.18
            self.scale(factor, factor)
            event.accept()
            return
        super().wheelEvent(event)

    def _pixel_pos(self, event) -> tuple[int, int]:
        sp = self.mapToScene(event.position().toPoint())
        return int(math.floor(sp.x())), int(math.floor(sp.y()))

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.MiddleButton:
            self._middle_panning = True
            self._pan_start = event.position()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return

        x, y = self._pixel_pos(event)
        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return

        if self.mode == MODE_SELECT:
            self.pixelClicked.emit(x, y)
        elif self.mode == MODE_BRIDGE:
            self._bridging = True
            self._bridge_start = (x, y)
            self.bridgePreview.emit(x, y, x, y)
        elif self.mode in (MODE_PROTECT, MODE_ERASE_PROTECT):
            self._protecting = True
            self.protectionPainted.emit(x, y)
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        x, y = self._pixel_pos(event)
        self.pointerInfo.emit(f"像素坐标：{x}, {y}")

        if self._middle_panning and self._pan_start is not None:
            delta = event.position() - self._pan_start
            self._pan_start = event.position()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - int(delta.x())
            )
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - int(delta.y())
            )
            event.accept()
            return

        if self._bridging and self._bridge_start is not None:
            x0, y0 = self._bridge_start
            self.bridgePreview.emit(x0, y0, x, y)
        elif self._protecting:
            self.protectionPainted.emit(x, y)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.MiddleButton:
            self._middle_panning = False
            self._pan_start = None
            self.set_mode(self.mode)
            event.accept()
            return

        if event.button() == Qt.MouseButton.LeftButton:
            if self._bridging and self._bridge_start is not None:
                x0, y0 = self._bridge_start
                self._bridging = False
                self._bridge_start = None
                self.bridgeCommitted.emit(x0, y0, *self._pixel_pos(event))
                self.interactionFinished.emit()
            elif self._protecting:
                self._protecting = False
                self.interactionFinished.emit()
        super().mouseReleaseEvent(event)

    def zoom_fit(self) -> None:
        if self.scene.sceneRect().isNull():
            return
        self.fitInView(self.scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def zoom_actual(self) -> None:
        self.resetTransform()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("黑白刷色模板检查器")
        self.resize(1280, 860)

        self.base_gray: np.ndarray | None = None
        self.paper: np.ndarray | None = None
        self.protected: np.ndarray | None = None
        self.analysis: Analysis | None = None
        self.keep_color = "black"
        self.image_path: str | None = None
        self.last_export_path: str | None = None

        self.undo_bridges: list[Bridge] = []
        self.redo_bridges: list[Bridge] = []
        self.selected_xy: tuple[int, int] | None = None
        self.selected_label: int | None = None
        self.proposals: list[Proposal] = []
        self.preview_bridge: tuple[int, int, int, int] | None = None
        self._last_protect_xy: tuple[int, int] | None = None

        self._build_ui()
        self._build_actions()
        self.load_sample(all_samples()[0])

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal)
        root = QWidget()
        root_layout = QVBoxLayout(root)
        root_layout.setContentsMargins(8, 8, 8, 8)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        panel = QWidget()
        panel.setMinimumWidth(330)
        panel.setMaximumWidth(430)
        layout = QVBoxLayout(panel)
        layout.setSpacing(10)

        # File group
        file_box = QGroupBox("图片与颜色")
        file_form = QFormLayout(file_box)
        self.open_btn = QPushButton("打开单张二值图…")
        self.open_btn.clicked.connect(self.open_image_dialog)
        file_form.addRow(self.open_btn)

        self.keep_combo = QComboBox()
        self.keep_combo.addItem("保留黑色（黑为纸）", "black")
        self.keep_combo.addItem("保留白色（白为纸）", "white")
        self.keep_combo.currentIndexChanged.connect(self.on_keep_color_changed)
        file_form.addRow("保留侧", self.keep_combo)

        sample_row = QHBoxLayout()
        self.sample_chain_btn = QPushButton("样例：一次不够")
        self.sample_chain_btn.clicked.connect(lambda: self.load_sample(all_samples()[0]))
        self.sample_tight_btn = QPushButton("样例：窄缝")
        self.sample_tight_btn.clicked.connect(lambda: self.load_sample(all_samples()[1]))
        sample_row.addWidget(self.sample_chain_btn)
        sample_row.addWidget(self.sample_tight_btn)
        file_form.addRow(sample_row)

        self.image_info = QLabel("尚未载入图片")
        self.image_info.setWordWrap(True)
        file_form.addRow(self.image_info)
        layout.addWidget(file_box)

        # Analysis group
        check_box = QGroupBox("检查结果")
        check_layout = QVBoxLayout(check_box)
        form = QFormLayout()
        self.thin_spin = QSpinBox()
        self.thin_spin.setRange(1, 200)
        self.thin_spin.setValue(3)
        self.thin_spin.setSuffix(" px")
        self.thin_spin.valueChanged.connect(self.rerun_analysis)
        form.addRow("过细阈值", self.thin_spin)
        check_layout.addLayout(form)

        self.stats_label = QLabel("—")
        self.stats_label.setTextFormat(Qt.TextFormat.RichText)
        self.stats_label.setWordWrap(True)
        check_layout.addWidget(self.stats_label)

        self.component_list = QListWidget()
        self.component_list.setMaximumHeight(130)
        self.component_list.currentItemChanged.connect(self.on_component_list_selected)
        check_layout.addWidget(QLabel("悬空纸块（点击定位）"))
        check_layout.addWidget(self.component_list)

        self.thin_list = QListWidget()
        self.thin_list.setMaximumHeight(90)
        check_layout.addWidget(QLabel("过细连点"))
        check_layout.addWidget(self.thin_list)
        layout.addWidget(check_box)

        # Bridge group
        bridge_box = QGroupBox("连接方案与手工补桥")
        bridge_layout = QVBoxLayout(bridge_box)
        bridge_form = QFormLayout()

        self.selected_label_info = QLabel("未选中悬空块")
        self.selected_label_info.setWordWrap(True)
        bridge_form.addRow(self.selected_label_info)

        self.width_spin = QSpinBox()
        self.width_spin.setRange(1, 200)
        self.width_spin.setValue(6)
        self.width_spin.setSuffix(" px")
        self.width_spin.valueChanged.connect(self.regenerate_proposals)
        bridge_form.addRow("纸桥宽度", self.width_spin)

        self.direction_combo = QComboBox()
        self.direction_combo.addItem("自动（全部方向）", "自动")
        for name in ["右", "右下", "下", "左下", "左", "左上", "上", "右上"]:
            self.direction_combo.addItem(name, name)
        self.direction_combo.currentIndexChanged.connect(self.regenerate_proposals)
        bridge_form.addRow("方向", self.direction_combo)

        self.mode_combo = QComboBox()
        for mode in [MODE_SELECT, MODE_BRIDGE, MODE_PROTECT, MODE_ERASE_PROTECT]:
            self.mode_combo.addItem(mode, mode)
        self.mode_combo.currentIndexChanged.connect(self.on_mode_changed)
        bridge_form.addRow("鼠标模式", self.mode_combo)

        self.brush_spin = QSpinBox()
        self.brush_spin.setRange(1, 200)
        self.brush_spin.setValue(5)
        self.brush_spin.setSuffix(" px半径")
        bridge_form.addRow("保护笔", self.brush_spin)
        bridge_layout.addLayout(bridge_form)

        self.proposal_list = QListWidget()
        self.proposal_list.setMinimumHeight(130)
        self.proposal_list.currentRowChanged.connect(self.on_proposal_highlighted)
        self.proposal_list.itemDoubleClicked.connect(self.apply_selected_proposal)
        bridge_layout.addWidget(QLabel("可用/不可用方案（双击应用可用方案）"))
        bridge_layout.addWidget(self.proposal_list)

        self.apply_proposal_btn = QPushButton("应用选中方案")
        self.apply_proposal_btn.clicked.connect(self.apply_selected_proposal)
        bridge_layout.addWidget(self.apply_proposal_btn)

        edit_row = QHBoxLayout()
        self.undo_btn = QPushButton("撤销补桥")
        self.undo_btn.clicked.connect(self.undo)
        self.redo_btn = QPushButton("重做")
        self.redo_btn.clicked.connect(self.redo)
        edit_row.addWidget(self.undo_btn)
        edit_row.addWidget(self.redo_btn)
        bridge_layout.addLayout(edit_row)

        protect_row = QHBoxLayout()
        self.clear_protect_btn = QPushButton("清除保护标记")
        self.clear_protect_btn.clicked.connect(self.clear_protection)
        self.clear_bridges_btn = QPushButton("清空所有补桥")
        self.clear_bridges_btn.clicked.connect(self.clear_bridges)
        protect_row.addWidget(self.clear_protect_btn)
        protect_row.addWidget(self.clear_bridges_btn)
        bridge_layout.addLayout(protect_row)
        layout.addWidget(bridge_box)

        # Export box
        export_box = QGroupBox("导出与复核")
        export_layout = QVBoxLayout(export_box)
        export_row = QHBoxLayout()
        self.export_verify_btn = QPushButton("导出二值图并复核…")
        self.export_verify_btn.clicked.connect(self.export_and_verify_dialog)
        self.verify_btn = QPushButton("复核已有导出图…")
        self.verify_btn.clicked.connect(self.verify_dialog)
        export_row.addWidget(self.export_verify_btn)
        export_row.addWidget(self.verify_btn)
        export_layout.addLayout(export_row)
        self.report = QTextEdit()
        self.report.setReadOnly(True)
        self.report.setMinimumHeight(150)
        self.report.setPlaceholderText("导出后，这里会显示从磁盘重新读取图片得到的悬空块复核结果。")
        export_layout.addWidget(self.report)
        layout.addWidget(export_box)
        layout.addStretch(1)

        scroll.setWidget(panel)
        splitter.addWidget(scroll)

        self.view = ImageView()
        self.view.pixelClicked.connect(self.on_pixel_clicked)
        self.view.bridgePreview.connect(self.on_bridge_preview)
        self.view.bridgeCommitted.connect(self.on_bridge_committed)
        self.view.protectionPainted.connect(self.on_protection_painted)
        self.view.interactionFinished.connect(self.on_interaction_finished)
        self.view.pointerInfo.connect(lambda msg: self.statusBar().showMessage(msg, 1500))

        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        tool_row = QHBoxLayout()
        fit_btn = QPushButton("适应窗口")
        fit_btn.clicked.connect(self.view.zoom_fit)
        in_btn = QPushButton("放大")
        in_btn.clicked.connect(lambda: self.view.scale(1.2, 1.2))
        out_btn = QPushButton("缩小")
        out_btn.clicked.connect(lambda: self.view.scale(1 / 1.2, 1 / 1.2))
        actual_btn = QPushButton("100%")
        actual_btn.clicked.connect(self.view.zoom_actual)
        zoom_hint = QLabel("Ctrl/⌘+滚轮缩放；中键拖动平移。桥宽始终是图像实际像素。")
        tool_row.addWidget(fit_btn)
        tool_row.addWidget(in_btn)
        tool_row.addWidget(out_btn)
        tool_row.addWidget(actual_btn)
        tool_row.addWidget(zoom_hint)
        tool_row.addStretch(1)
        right_layout.addLayout(tool_row)
        right_layout.addWidget(self.view, 1)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([390, 890])

        root_layout.addWidget(splitter)
        self.setCentralWidget(root)
        self.statusBar().showMessage("就绪")

    def _build_actions(self) -> None:
        undo_action = QAction("撤销", self)
        undo_action.setShortcut(QKeySequence.StandardKey.Undo)
        undo_action.triggered.connect(self.undo)
        self.addAction(undo_action)

        redo_action = QAction("重做", self)
        redo_action.setShortcuts([QKeySequence.StandardKey.Redo, "Ctrl+Y"])
        redo_action.triggered.connect(self.redo)
        self.addAction(redo_action)

        open_action = QAction("打开", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self.open_image_dialog)
        self.addAction(open_action)

    # -------------------------------------------------------------- loading
    def open_image_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "打开黑白二值图",
            "",
            "图片 (*.png *.bmp *.tif *.tiff *.jpg *.jpeg *.webp);;所有文件 (*)",
        )
        if not path:
            return
        try:
            with Image.open(path) as im:
                gray = np.asarray(im.convert("L"), dtype=np.uint8).copy()
        except Exception as exc:
            QMessageBox.critical(self, "打开失败", f"无法读取图片：\n{exc}")
            return
        self.image_path = path
        self.load_gray(gray, keep_color=self.keep_combo.currentData())

    def load_sample(self, sample: Sample) -> None:
        self.image_path = None
        self.load_gray(
            sample.gray.copy(),
            keep_color=sample.keep_color,
            protected=sample.protected.copy(),
            select_xy=sample.select_xy,
            bridge_width=sample.bridge_width,
            direction=sample.direction,
            description=sample.description,
        )
        self.setWindowTitle(f"黑白刷色模板检查器 — {sample.title}")

    def load_gray(
        self,
        gray: np.ndarray,
        keep_color: str = "black",
        protected: np.ndarray | None = None,
        select_xy: tuple[int, int] | None = None,
        bridge_width: int | None = None,
        direction: str | None = None,
        description: str | None = None,
    ) -> None:
        self.base_gray = np.asarray(gray, dtype=np.uint8).copy()
        self.keep_color = keep_color
        self.keep_combo.blockSignals(True)
        self.keep_combo.setCurrentIndex(0 if keep_color == "black" else 1)
        self.keep_combo.blockSignals(False)

        h, w = self.base_gray.shape
        self.paper = paper_from_gray(self.base_gray, keep_color)
        self.protected = (
            protected.copy()
            if protected is not None and protected.shape == (h, w)
            else np.zeros((h, w), dtype=bool)
        )
        self.undo_bridges.clear()
        self.redo_bridges.clear()
        self.selected_xy = select_xy
        self.selected_label = None
        self.preview_bridge = None
        self.last_export_path = None

        if bridge_width is not None:
            self.width_spin.setValue(int(bridge_width))
        if direction is not None:
            idx = self.direction_combo.findData(direction)
            if idx >= 0:
                self.direction_combo.setCurrentIndex(idx)

        self.rerun_analysis()
        if select_xy is not None:
            self.on_pixel_clicked(*select_xy)
        self.rebuild_scene()
        self.view.zoom_fit()
        QTimer.singleShot(0, self.view.zoom_fit)

        self.image_info.setText(
            f"{Path(self.image_path).name if self.image_path else '内置样例'} · {w}×{h}px"
            + (f"\n{description}" if description else "")
        )
        self.report.clear()
        self.report.setPlaceholderText("导出后，这里会显示从磁盘重新读取图片得到的悬空块复核结果。")

    def on_keep_color_changed(self) -> None:
        if self.base_gray is None:
            return
        new_color = self.keep_combo.currentData()
        if new_color == self.keep_color:
            return
        self.keep_color = new_color
        # Bridges were defined in retained-paper space. Switching the retained
        # side reinterprets the source art, so old bridge patches are cleared.
        self.paper = paper_from_gray(self.base_gray, self.keep_color)
        self.undo_bridges.clear()
        self.redo_bridges.clear()
        self.rerun_analysis()
        self.rebuild_scene()

    # ------------------------------------------------------------- analysis
    def rerun_analysis(self, *_args) -> None:
        if self.paper is None:
            return
        thin_width = int(self.thin_spin.value())
        self.analysis = analyze_paper(self.paper, thin_width=thin_width)
        self.sync_selection()
        self.update_stats_and_lists()
        self.regenerate_proposals()
        self.rebuild_scene()
        self.update_actions()

    def sync_selection(self) -> None:
        if self.analysis is None or self.selected_xy is None:
            self.selected_label = None
            return
        x, y = self.selected_xy
        label = self.analysis.label_at(x, y)
        if self.analysis.is_floating(label):
            self.selected_label = label
        else:
            # The remembered pixel can be on an undone bridge/background after
            # undo; keep the numerical selection but mark it unavailable.
            self.selected_label = label if label != 0 else None

    def _labels_containing_active_bridges(self) -> set[int]:
        if self.analysis is None:
            return set()
        labels: set[int] = set()
        for bridge in self.undo_bridges:
            coords = bridge.changed_coords
            if coords.size:
                values = self.analysis.labels[coords[:, 0], coords[:, 1]]
                labels.update(int(v) for v in np.unique(values) if v != 0)
        return labels

    def update_stats_and_lists(self) -> None:
        assert self.analysis is not None
        a = self.analysis
        fixed_area = sum(
            c.area for c in a.components.values() if c.frame_connected
        )
        self.stats_label.setText(
            f"纸块总数：{a.component_count}\n"
            f"悬空纸块：<b style='color:#ff6b6b'>{a.floating_count}</b> 块\n"
            f"过细连点：<b style='color:#ffb020'>{len(a.thin_points)}</b> 处\n"
            f"固定部分面积：{fixed_area} px"
        )

        self.component_list.blockSignals(True)
        self.component_list.clear()
        bridged_labels = self._labels_containing_active_bridges()
        for label in a.floating_labels:
            c = a.components[label]
            combo_mark = " · 桥接组合块（仍悬空）" if label in bridged_labels else ""
            item = QListWidgetItem(
                f"#{label}  面积{c.area}px  框({c.x},{c.y},{c.width}×{c.height}){combo_mark}"
            )
            item.setData(Qt.ItemDataRole.UserRole, label)
            self.component_list.addItem(item)
            if label == self.selected_label:
                item.setSelected(True)
        self.component_list.blockSignals(False)

        self.thin_list.clear()
        if not a.thin_points:
            self.thin_list.addItem("未发现窄于阈值的连接颈")
        for p in a.thin_points:
            item = QListWidgetItem(
                f"({p.x},{p.y}) 约 {max(1, round(p.width_px))}px 宽，属于 #{p.label}"
            )
            self.thin_list.addItem(item)

        if self.selected_label is not None and a.is_floating(self.selected_label):
            c = a.components[self.selected_label]
            combo_note = (
                "\n注意：这是多块经桥接形成的组合块，但仍未接回画框。"
                if self.selected_label in bridged_labels
                else ""
            )
            self.selected_label_info.setText(
                f"已选悬空块 #{self.selected_label}\n面积 {c.area}px，"
                f"包围盒 {c.width}×{c.height}px{combo_note}"
            )
        elif self.selected_label and self.selected_label in a.frame_labels:
            self.selected_label_info.setText(f"像素属于固定外框部分 #{self.selected_label}")
        else:
            self.selected_label_info.setText("未选中悬空块；在选择模式下点击红色纸块")

    def on_component_list_selected(self, current: QListWidgetItem | None, _previous) -> None:
        if current is None or self.analysis is None:
            return
        label = int(current.data(Qt.ItemDataRole.UserRole))
        c = self.analysis.components[label]
        self.selected_label = label
        self.selected_xy = (int(c.centroid_x), int(c.centroid_y))
        self.regenerate_proposals()
        self.rebuild_scene()

    def on_pixel_clicked(self, x: int, y: int) -> None:
        if self.analysis is None or self.paper is None:
            return
        self.selected_xy = (x, y)
        label = self.analysis.label_at(x, y)
        if self.analysis.is_floating(label):
            self.selected_label = label
            self.statusBar().showMessage(f"选中悬空块 #{label}", 2500)
        elif label in self.analysis.frame_labels:
            self.selected_label = label
            self.statusBar().showMessage("这部分与画框边相连，属于固定部分。", 3000)
        else:
            self.selected_label = None
            self.statusBar().showMessage("点击位置是保留侧的对面（镂空/背景）。", 3000)
        self.update_stats_and_lists()
        self.regenerate_proposals()
        self.rebuild_scene()

    # ------------------------------------------------------------ proposals
    def regenerate_proposals(self, *_args) -> None:
        self.proposal_list.blockSignals(True)
        self.proposal_list.clear()
        self.proposals = []

        if (
            self.analysis is None
            or self.paper is None
            or self.protected is None
            or self.selected_label is None
            or not self.analysis.is_floating(self.selected_label)
        ):
            self.proposal_list.addItem("请先点选一块悬空纸")
            self.proposal_list.blockSignals(False)
            self.apply_proposal_btn.setEnabled(False)
            return

        direction = self.direction_combo.currentData() or "自动"
        width = int(self.width_spin.value())
        self.proposals = generate_proposals(
            self.paper,
            self.analysis.labels,
            self.analysis.frame_labels,
            self.selected_label,
            width=width,
            protected=self.protected,
            direction=direction,
        )

        if not self.proposals:
            self.proposal_list.addItem("当前方向没有找到可连接的纸或画框边")
            self.apply_proposal_btn.setEnabled(False)
        else:
            for p in self.proposals:
                item = QListWidgetItem(p.summary())
                item.setData(Qt.ItemDataRole.UserRole, p.id)
                if not p.feasible:
                    item.setForeground(QColor("#ff8080"))
                else:
                    item.setForeground(QColor("#8ef0b0"))
                self.proposal_list.addItem(item)
            self.proposal_list.setCurrentRow(0)
            selected = self.proposals[0]
            self.apply_proposal_btn.setEnabled(selected.feasible)

        self.proposal_list.blockSignals(False)
        self.rebuild_scene()

    def on_proposal_highlighted(self, row: int) -> None:
        if 0 <= row < len(self.proposals):
            p = self.proposals[row]
            self.apply_proposal_btn.setEnabled(p.feasible)
        self.rebuild_scene()

    def _highlighted_proposal(self) -> Proposal | None:
        row = self.proposal_list.currentRow()
        if 0 <= row < len(self.proposals):
            return self.proposals[row]
        return None

    def apply_selected_proposal(self, *_args) -> None:
        if self.paper is None or self.protected is None:
            return
        proposal = self._highlighted_proposal()
        if proposal is None:
            return
        if not proposal.feasible:
            QMessageBox.warning(
                self,
                "当前方案放不下",
                f"{proposal.reason}。\n\n可调小纸桥宽度、改变方向，或擦除相关保护标记。",
            )
            return

        before_label = proposal.source_label
        self.paper, bridge = apply_proposal(self.paper, proposal, self.protected)
        bridge.kind = "proposal"
        self.redo_bridges.clear()
        self.undo_bridges.append(bridge)
        self.preview_bridge = None
        self.rerun_analysis()

        after_label = (
            self.analysis.label_at(*self.selected_xy)
            if self.analysis and self.selected_xy
            else 0
        )
        assert self.analysis is not None
        if after_label in self.analysis.frame_labels:
            msg = f"已应用 {proposal.width}px 桥：#{before_label} 现在已接回外框。"
        elif after_label:
            msg = (
                f"已应用 {proposal.width}px 桥：多个小岛已合并为 #{after_label}，"
                "但仍未接回外框，已如实标为悬空组合块。"
            )
        else:
            msg = "已应用桥接。"
        self.statusBar().showMessage(msg, 6000)

    # ------------------------------------------------------- manual editing
    def on_mode_changed(self) -> None:
        mode = self.mode_combo.currentData()
        self.view.set_mode(mode)
        if mode != MODE_BRIDGE:
            self.preview_bridge = None
            self.rebuild_scene()

    def on_bridge_preview(self, x0: int, y0: int, x1: int, y1: int) -> None:
        self.preview_bridge = (x0, y0, x1, y1)
        self.rebuild_scene()

    def on_bridge_committed(self, x0: int, y0: int, x1: int, y1: int) -> None:
        if self.paper is None or self.protected is None:
            return
        if (x0, y0) == (x1, y1):
            self.preview_bridge = None
            self.rebuild_scene()
            return
        width = int(self.width_spin.value())
        new_paper, bridge, blocked = apply_manual_stroke(
            self.paper, [(x0, y0), (x1, y1)], width, self.protected
        )
        self.preview_bridge = None
        if bridge is not None and bridge.changed_coords.size:
            self.paper = new_paper
            self.redo_bridges.clear()
            self.undo_bridges.append(bridge)
            self.rerun_analysis()
        else:
            self.rebuild_scene()
        if blocked:
            self.statusBar().showMessage(
                f"手工桥已避开 {blocked} 个受保护像素；若桥路被截断，检查结果会继续显示悬空。",
                7000,
            )
        else:
            self.statusBar().showMessage("手工补桥已更新检查结果。", 3000)

    def on_protection_painted(self, x: int, y: int) -> None:
        if self.protected is None:
            return
        radius = int(self.brush_spin.value())
        value = self.mode_combo.currentData() == MODE_PROTECT

        # Interpolate fast mouse moves so a drag does not leave gaps.
        if self._last_protect_xy is not None:
            x0, y0 = self._last_protect_xy
            steps = max(abs(x - x0), abs(y - y0), 1)
            for i in range(1, steps + 1):
                ix = round(x0 + (x - x0) * i / steps)
                iy = round(y0 + (y - y0) * i / steps)
                self.protected = paint_protected_disk(
                    self.protected, ix, iy, radius, value
                )
        else:
            self.protected = paint_protected_disk(
                self.protected, x, y, radius, value
            )
        self._last_protect_xy = (x, y)
        self.rebuild_scene()

    def on_interaction_finished(self) -> None:
        self._last_protect_xy = None
        if self.mode_combo.currentData() in (MODE_PROTECT, MODE_ERASE_PROTECT):
            self.regenerate_proposals()

    def clear_protection(self) -> None:
        if self.protected is not None:
            self.protected.fill(False)
            self.regenerate_proposals()
            self.rebuild_scene()
            self.statusBar().showMessage("已清除全部保护标记。", 3000)

    def undo(self) -> None:
        if not self.undo_bridges or self.paper is None:
            self.statusBar().showMessage("没有可撤销的补桥。", 2500)
            return
        bridge = self.undo_bridges.pop()
        self.paper = undo_bridge(self.paper, bridge)
        self.redo_bridges.append(bridge)
        self.rerun_analysis()
        self.statusBar().showMessage("已撤销最后一座桥，检查结果已同步更新。", 3500)

    def redo(self) -> None:
        if not self.redo_bridges or self.paper is None:
            self.statusBar().showMessage("没有可重做的补桥。", 2500)
            return
        bridge = self.redo_bridges.pop()
        coords = bridge.changed_coords
        if coords.size:
            self.paper[coords[:, 0], coords[:, 1]] = True
        self.undo_bridges.append(bridge)
        self.rerun_analysis()
        self.statusBar().showMessage("已重做补桥。", 2500)

    def clear_bridges(self) -> None:
        if self.base_gray is None:
            return
        self.paper = paper_from_gray(self.base_gray, self.keep_color)
        self.undo_bridges.clear()
        self.redo_bridges.clear()
        self.rerun_analysis()
        self.statusBar().showMessage("已清空补桥并恢复原图。", 3000)

    def update_actions(self) -> None:
        self.undo_btn.setEnabled(bool(self.undo_bridges))
        self.redo_btn.setEnabled(bool(self.redo_bridges))

    # ------------------------------------------------------------ rendering
    def rebuild_scene(self) -> None:
        if self.paper is None or self.analysis is None:
            return
        h, w = self.paper.shape
        self.view.scene.clear()
        self.view.scene.setSceneRect(0, 0, w, h)

        if self.keep_color == "black":
            gray = np.where(self.paper, 0, 255).astype(np.uint8)
        else:
            gray = np.where(self.paper, 255, 0).astype(np.uint8)
        gray = np.ascontiguousarray(gray)
        base_qimg = QImage(gray.data, w, h, w, QImage.Format.Format_Grayscale8).copy()
        base_pix = QPixmap.fromImage(base_qimg)
        base_item = self.view.scene.addPixmap(base_pix)
        base_item.setTransformationMode(Qt.TransformationMode.FastTransformation)
        base_item.setZValue(0)

        overlay = self._build_overlay(w, h)
        overlay = np.ascontiguousarray(overlay)
        overlay_qimg = QImage(
            overlay.data, w, h, 4 * w, QImage.Format.Format_RGBA8888
        ).copy()
        overlay_item = self.view.scene.addPixmap(QPixmap.fromImage(overlay_qimg))
        overlay_item.setTransformationMode(Qt.TransformationMode.FastTransformation)
        overlay_item.setZValue(2)

        self._add_scene_annotations()
        self.update_actions()

    def _build_overlay(self, w: int, h: int) -> np.ndarray:
        assert self.analysis is not None and self.paper is not None
        a = self.analysis
        overlay = np.zeros((h, w, 4), dtype=np.uint8)
        yy, xx = np.mgrid[0:h, 0:w]

        # Every floating component gets a persistent red wash.
        floating_mask = np.isin(a.labels, np.asarray(a.floating_labels, dtype=int))
        overlay[floating_mask] = (255, 72, 72, 72)

        # Stronger selected-component wash; bridges are painted above it.
        if self.selected_label and a.is_floating(self.selected_label):
            smask = a.labels == self.selected_label
            overlay[smask] = (255, 214, 64, 92)

        # Thin neck mask.
        overlay[a.thin_mask] = (255, 166, 32, 150)

        # Protected details use a purple checker hatch.
        if self.protected is not None and self.protected.any():
            hatch = ((xx // 3 + yy // 3) % 2 == 0)
            pmask = self.protected & hatch
            overlay[pmask] = (190, 92, 255, 150)
            overlay[self.protected & ~hatch] = (120, 40, 190, 55)

        # Applied bridges: exact raster pixels, independent of zoom.
        for bridge in self.undo_bridges:
            bm = bridge.mask((h, w))
            overlay[bm] = (48, 144, 255, 105)
            if bridge.changed_coords.size:
                overlay[bridge.changed_coords[:, 0], bridge.changed_coords[:, 1]] = (
                    40,
                    170,
                    255,
                    175,
                )

        # Highlighted proposal.
        proposal = self._highlighted_proposal()
        if proposal is not None:
            pm = proposal.mask((h, w))
            color = (70, 230, 140, 150) if proposal.feasible else (255, 60, 60, 150)
            overlay[pm] = color

        # Drag preview.
        if self.preview_bridge is not None:
            x0, y0, x1, y1 = self.preview_bridge
            pm = raster_bridge((h, w), x0, y0, x1, y1, int(self.width_spin.value()))
            overlay[pm] = (80, 200, 255, 170)

        return overlay

    def _add_scene_annotations(self) -> None:
        assert self.analysis is not None
        a = self.analysis

        for label in a.floating_labels:
            c = a.components[label]
            is_selected = label == self.selected_label
            rect = QGraphicsRectItem(c.x, c.y, c.width, c.height)
            pen = QPen(QColor("#ffd400") if is_selected else QColor("#ff5a5a"))
            pen.setWidth(2)
            pen.setCosmetic(True)
            rect.setPen(pen)
            rect.setZValue(5)
            self.view.scene.addItem(rect)

            text = QGraphicsTextItem(f"#{label} 悬空")
            text.setDefaultTextColor(QColor("#ffd400") if is_selected else QColor("#ff9b9b"))
            font = QFont()
            font.setBold(True)
            font.setPointSize(10)
            text.setFont(font)
            text.setPos(c.x + 2, max(0, c.y - 18))
            text.setFlag(QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
            text.setZValue(8)
            self.view.scene.addItem(text)

        for p in a.thin_points:
            ellipse = QGraphicsEllipseItem(p.x - 5, p.y - 5, 11, 11)
            pen = QPen(QColor("#ffb020"), 2)
            pen.setCosmetic(True)
            ellipse.setPen(pen)
            ellipse.setBrush(QColor(255, 176, 32, 90))
            ellipse.setZValue(7)
            self.view.scene.addItem(ellipse)

    # --------------------------------------------------------------- export
    def export_to_path(self, path: str) -> str:
        if self.paper is None:
            raise RuntimeError("没有可导出的图片")
        export_binary(path, self.paper, self.keep_color)
        self.last_export_path = path
        return path

    def build_verification_report(self, path: str) -> str:
        result = verify_export(path, self.keep_color, int(self.thin_spin.value()))
        lines = [
            f"复核文件：{path}",
            f"保留颜色：{'黑色' if self.keep_color == 'black' else '白色'}",
            f"图像尺寸：{result.paper.shape[1]}×{result.paper.shape[0]} px",
            f"连通纸块：{result.component_count}",
            f"剩余悬空块：{result.floating_count}",
        ]
        for label in result.floating_labels:
            c = result.components[label]
            lines.append(
                f"  - #{label}: 面积 {c.area}px, 位置 x={c.x},y={c.y}, "
                f"框 {c.width}×{c.height}"
            )
        lines.append(f"过细连点：{len(result.thin_points)} 处")
        if result.floating_count == 0:
            lines.append("结论：导出图中已无脱离画框的悬空纸块。")
        else:
            lines.append("结论：导出图仍有悬空块，需要继续补桥后重新导出。")
        return "\n".join(lines)

    def export_and_verify_dialog(self) -> None:
        if self.paper is None:
            return
        default_name = "stencil_checked.png"
        if self.image_path:
            p = Path(self.image_path)
            default_name = f"{p.stem}_checked.png"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出二值图", default_name, "PNG (*.png);;BMP (*.bmp)"
        )
        if not path:
            return
        if not Path(path).suffix:
            path += ".png"
        try:
            self.export_to_path(path)
            report = self.build_verification_report(path)
        except Exception as exc:
            QMessageBox.critical(self, "导出/复核失败", str(exc))
            return
        self.report.setPlainText(report)
        self.statusBar().showMessage("已导出并从磁盘重新读取复核。", 5000)
        if self.analysis and self.analysis.floating_count == 0:
            QMessageBox.information(self, "复核通过", "导出图中没有剩余悬空块。")
        else:
            QMessageBox.warning(self, "仍有悬空块", "复核完成：导出图中仍有悬空块，详见复核报告。")

    def verify_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "复核导出的二值图", "", "图片 (*.png *.bmp *.tif *.tiff);;所有文件 (*)"
        )
        if not path:
            return
        try:
            # Use the color side selected in the UI; the user must tell the
            # checker which side was retained.
            report = self.build_verification_report(path)
        except Exception as exc:
            QMessageBox.critical(self, "复核失败", str(exc))
            return
        self.last_export_path = path
        self.report.setPlainText(report)


def run_gui(argv: list[str] | None = None) -> int:
    app = QApplication.instance() or QApplication(argv or sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()
