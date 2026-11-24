from __future__ import annotations

"""PySide6 window for local negative conversion and linked diagnostics."""

import sys
from pathlib import Path

import numpy as np
from PySide6.QtCore import QObject, QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import (
    QAction,
    QBrush,
    QColor,
    QFont,
    QImage,
    QKeySequence,
    QPainter,
    QPen,
    QPixmap,
    QShortcut,
)
from PySide6.QtWidgets import (
    QApplication,
    QButtonGroup,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGraphicsItem,
    QGraphicsLineItem,
    QGraphicsPixmapItem,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsTextItem,
    QGraphicsView,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QRadioButton,
    QScrollArea,
    QSizePolicy,
    QSlider,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .core import (
    ConvertParams,
    ImageDoc,
    NormRect,
    SamplePatch,
    auto_endpoints,
    convert_positive,
    diagnostic_masks,
    estimate_base,
    export_positive,
    load_image,
    mask_counts,
    measure_neutral,
    overlay_masks,
    readback_output,
    suggest_neutral_gray,
    to_display_u8,
    autostretch_original_u8,
)
from .samples import ProgramSample, color_negative_sample, range_verification_sample


# ---------------------------------------------------------------------------
# Qt helpers
# ---------------------------------------------------------------------------


def u8_to_qimage(array_u8: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(array_u8, dtype=np.uint8)
    h, w = arr.shape[:2]
    image = QImage(arr.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    return image.copy()  # detach from the NumPy buffer


class FloatSlider(QWidget):
    valueChanged = Signal(float)

    def __init__(
        self,
        title: str,
        minimum: float,
        maximum: float,
        value: float,
        step: float = 0.01,
        decimals: int = 2,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self.minimum = minimum
        self.maximum = maximum
        self._sync = False

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        self.title_label = QLabel(title)
        self.title_label.setMinimumWidth(58)
        self.title_label.setMaximumWidth(72)
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 10000)
        self.spin = QDoubleSpinBox()
        self.spin.setRange(minimum, maximum)
        self.spin.setDecimals(decimals)
        self.spin.setSingleStep(step)
        self.spin.setMinimumWidth(78)

        layout.addWidget(self.title_label)
        layout.addWidget(self.slider, 1)
        layout.addWidget(self.spin)

        self.slider.valueChanged.connect(self._slider_changed)
        self.spin.valueChanged.connect(self._spin_changed)
        self.setValue(value)

    def _to_int(self, value: float) -> int:
        fraction = (float(value) - self.minimum) / max(self.maximum - self.minimum, 1e-9)
        return int(round(np.clip(fraction, 0.0, 1.0) * 10000))

    def _from_int(self, index: int) -> float:
        return self.minimum + index / 10000 * (self.maximum - self.minimum)

    def _slider_changed(self, index: int) -> None:
        if self._sync:
            return
        value = self._from_int(index)
        self._sync = True
        self.spin.setValue(value)
        self._sync = False
        self.valueChanged.emit(value)

    def _spin_changed(self, value: float) -> None:
        if self._sync:
            return
        self._sync = True
        self.slider.setValue(self._to_int(value))
        self._sync = False
        self.valueChanged.emit(float(value))

    def value(self) -> float:
        return float(self.spin.value())

    def setValue(self, value: float) -> None:
        self._sync = True
        value = float(np.clip(value, self.minimum, self.maximum))
        self.spin.setValue(value)
        self.slider.setValue(self._to_int(value))
        self._sync = False


# ---------------------------------------------------------------------------
# Linked image view
# ---------------------------------------------------------------------------


class ImagePanel(QGraphicsView):
    creationRequested = Signal(str, object)  # mode, QRectF in scene coordinates
    clickRequested = Signal(str, object)     # mode, QPointF
    patchSelected = Signal(int)
    linkRequested = Signal(object)
    cursorMoved = Signal(object)
    cursorLeft = Signal()

    def __init__(self, title: str, parent: QWidget | None = None):
        super().__init__(parent)
        self.title = title
        self.scene = QGraphicsScene(self)
        self.setScene(self.scene)
        self.setRenderHints(
            QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform
        )
        self.setMouseTracking(True)
        self.viewport().setMouseTracking(True)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.NoAnchor)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.NoAnchor)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMinimumSize(260, 220)
        self.setStyleSheet("QGraphicsView { background: #111418; border: 1px solid #30363d; border-radius: 6px; }")

        self.interaction_mode = "base"
        self.hit_test_callback = None

        self._pixmap_item: QGraphicsPixmapItem | None = None
        self._overlay_items: list[QGraphicsItem] = []
        self._cross_items: list[QGraphicsLineItem] = []
        self._rubber_item: QGraphicsRectItem | None = None
        self._creating = False
        self._origin: QPointF | None = None
        self._press_position: QPointF | None = None
        self._auto_fit = True

        self.horizontalScrollBar().valueChanged.connect(lambda: self.linkRequested.emit(self))
        self.verticalScrollBar().valueChanged.connect(lambda: self.linkRequested.emit(self))
        self.horizontalScrollBar().sliderPressed.connect(lambda: setattr(self, "_auto_fit", False))
        self.verticalScrollBar().sliderPressed.connect(lambda: setattr(self, "_auto_fit", False))

    def set_mode(self, mode: str) -> None:
        self.interaction_mode = mode
        if mode == "pan":
            self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
            self.viewport().setCursor(Qt.CursorShape.OpenHandCursor)
        else:
            self.setDragMode(QGraphicsView.DragMode.NoDrag)
            self.viewport().setCursor(Qt.CursorShape.CrossCursor)

    def clear_image(self) -> None:
        self.scene.clear()
        self._pixmap_item = None
        self._overlay_items = []
        self._cross_items = []
        self._rubber_item = None

    def set_image(self, image: QImage, reset: bool = False) -> bool:
        """Swap the displayed pixmap. Returns True when a new item was made."""

        if reset:
            self.clear_image()

        pixmap = QPixmap.fromImage(image)
        created = self._pixmap_item is None
        if created:
            self._pixmap_item = self.scene.addPixmap(pixmap)
            self.scene.setSceneRect(QRectF(0, 0, pixmap.width(), pixmap.height()))
            self._auto_fit = True
            self.fit()
        else:
            self._pixmap_item.setPixmap(pixmap)
        return created

    def fit(self) -> None:
        if self._pixmap_item is not None:
            self.fitInView(self.scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)
            self._auto_fit = True

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().resizeEvent(event)
        if self._auto_fit and self._pixmap_item is not None:
            self.fitInView(self.scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def wheelEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self._pixmap_item is None:
            event.ignore()
            return

        modifiers = event.modifiers()
        zoom_modifier = bool(modifiers & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier))
        # A physical mouse wheel normally has no pixel delta; a trackpad pan
        # does, so let the ordinary scroll bar handle two-finger movement.
        physical_wheel = event.pixelDelta().isNull()
        if not (zoom_modifier or physical_wheel):
            super().wheelEvent(event)
            return

        delta = event.angleDelta().y()
        if delta == 0:
            super().wheelEvent(event)
            return
        factor = 1.18 ** (delta / 120.0)
        position = event.position()
        before = self.mapToScene(position.toPoint())
        self.scale(factor, factor)
        after = self.mapToScene(position.toPoint())
        offset = after - before
        self.translate(offset.x(), offset.y())
        self._auto_fit = False
        self.linkRequested.emit(self)
        event.accept()

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt API
        if event.button() == Qt.MouseButton.LeftButton and self.interaction_mode in {"base", "neutral"}:
            scene_pos = self.mapToScene(event.position().toPoint())
            if self.hit_test_callback is not None:
                patch_id = self.hit_test_callback(scene_pos)
                if patch_id is not None and patch_id >= 0:
                    self.patchSelected.emit(int(patch_id))
                    event.accept()
                    return

            if self._pixmap_item is not None:
                self._creating = True
                self._origin = QPointF(scene_pos)
                self._press_position = QPointF(event.position())
                pen = QPen(QColor(255, 255, 255, 230), 2)
                pen.setCosmetic(True)
                pen.setStyle(Qt.PenStyle.DashLine)
                self._rubber_item = self.scene.addRect(
                    QRectF(self._origin, self._origin), pen, QBrush(QColor(255, 255, 255, 28))
                )
                event.accept()
                return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 - Qt API
        scene_pos = self.mapToScene(event.position().toPoint())
        self.cursorMoved.emit(QPointF(scene_pos))
        if self._creating and self._rubber_item is not None and self._origin is not None:
            rect = QRectF(self._origin, QPointF(scene_pos)).normalized()
            self._rubber_item.setRect(rect)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt API
        if event.button() == Qt.MouseButton.LeftButton and self._creating:
            self._creating = False
            if self._rubber_item is not None:
                rect = self._rubber_item.rect().normalized()
                self.scene.removeItem(self._rubber_item)
                self._rubber_item = None
            else:
                rect = QRectF()

            moved = 0.0
            if self._press_position is not None:
                moved = (event.position() - self._press_position).manhattanLength()

            if moved < 5.0:
                self.clickRequested.emit(self.interaction_mode, self.mapToScene(event.position().toPoint()))
            elif rect.width() >= 3.0 and rect.height() >= 3.0:
                self.creationRequested.emit(self.interaction_mode, QRectF(rect))
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802 - Qt API
        self.cursorLeft.emit()
        super().leaveEvent(event)

    def _ensure_crosshair(self) -> None:
        if self._cross_items:
            return
        pen = QPen(QColor(255, 255, 255, 190), 1, Qt.PenStyle.DashLine)
        pen.setCosmetic(True)
        for _ in range(2):
            line = QGraphicsLineItem()
            line.setPen(pen)
            line.setZValue(30)
            line.hide()
            self.scene.addItem(line)
            self._cross_items.append(line)

    def show_crosshair(self, point: QPointF) -> None:
        if self._pixmap_item is None:
            return
        self._ensure_crosshair()
        rect = self.sceneRect()
        h, v = self._cross_items
        h.setLine(rect.left(), point.y(), rect.right(), point.y())
        v.setLine(point.x(), rect.top(), point.x(), rect.bottom())
        h.show()
        v.show()

    def hide_crosshair(self) -> None:
        for line in self._cross_items:
            line.hide()

    def set_overlays(self, specs: list[tuple], selected_id: int | None) -> None:
        for item in self._overlay_items:
            try:
                self.scene.removeItem(item)
            except RuntimeError:
                pass
        self._overlay_items.clear()

        for patch_id, norm_rect, label, tone, is_selected in specs:
            x = norm_rect.x * self.sceneRect().width()
            y = norm_rect.y * self.sceneRect().height()
            w = norm_rect.w * self.sceneRect().width()
            h = norm_rect.h * self.sceneRect().height()
            rect = QRectF(x, y, w, h)

            if is_selected or patch_id == selected_id:
                color = QColor("#ffd60a")
            elif tone == "neutral":
                color = QColor("#e879f9")
            elif tone == "bad":
                color = QColor("#ff453a")
            else:
                color = QColor("#22d3ee")

            pen = QPen(color, 3 if is_selected or patch_id == selected_id else 2)
            pen.setCosmetic(True)
            brush_color = QColor(color)
            brush_color.setAlpha(58 if tone == "bad" or is_selected else 24)
            item = QGraphicsRectItem(rect)
            item.setPen(pen)
            item.setBrush(QBrush(brush_color))
            item.setZValue(10)
            self.scene.addItem(item)
            self._overlay_items.append(item)

            text = QGraphicsTextItem()
            text.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
            safe_label = (
                label.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            )
            text.setHtml(
                f'<div style="background: rgba(0,0,0,170); color: {color.name()}; '
                f'font-size: 11px; font-weight: 700; padding: 1px 4px; border-radius: 3px;">'
                f"{safe_label}</div>"
            )
            text.setPos(rect.left() + 3, rect.top() + 2)
            text.setZValue(11)
            self.scene.addItem(text)
            self._overlay_items.append(text)


class ViewLinker(QObject):
    def __init__(self, panels: list[ImagePanel]):
        super().__init__()
        self.panels = panels
        self.syncing = False
        for panel in panels:
            panel.linkRequested.connect(self.sync_from)

    def sync_from(self, sender: ImagePanel) -> None:
        if self.syncing:
            return
        self.syncing = True
        center = sender.mapToScene(sender.viewport().rect().center())
        transform = sender.transform()
        for panel in self.panels:
            if panel is sender:
                continue
            panel._auto_fit = False
            panel.setTransform(transform)
            panel.centerOn(center)
        self.syncing = False

    def fit_all(self) -> None:
        for panel in self.panels:
            panel.fit()


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("本地彩色负片转换工作台")
        self.resize(1580, 940)

        self.doc: ImageDoc | None = None
        self.patches: list[SamplePatch] = []
        self.next_patch_id = 1
        self.selected_patch_id: int | None = None
        self.preview_rgb: np.ndarray | None = None
        self.params = ConvertParams()
        self.last_final: np.ndarray | None = None
        self.last_masks: dict[str, np.ndarray] | None = None
        self.last_export_path: str | None = None
        self.last_export_bit_depth = 8
        self.last_export_range = "full"

        self.process_timer = QTimer(self)
        self.process_timer.setSingleShot(True)
        self.process_timer.setInterval(110)
        self.process_timer.timeout.connect(self.process_current)

        self._build_ui()
        self.linker = ViewLinker([self.original_panel, self.positive_panel, self.mask_panel])
        self._connect_panels()
        self._build_menus()

        # Scoped to the patch list/image views so Delete/BACKSPACE remain
        # normal editing keys while a numeric text field has focus.
        delete_widgets = [self.patch_list, self.original_panel, self.positive_panel, self.mask_panel]
        for widget in delete_widgets:
            for sequence in (QKeySequence.StandardKey.Delete, QKeySequence("Backspace")):
                shortcut = QShortcut(sequence, widget)
                shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
                shortcut.activated.connect(self.delete_selected_patch)

        self.statusBar().showMessage("就绪：可从“样片”开始，或打开自己的 PNG / 16-bit TIFF。")

    # ---------------- UI construction ----------------

    def _build_ui(self) -> None:
        root = QSplitter(Qt.Orientation.Horizontal)

        controls_scroll = QScrollArea()
        controls_scroll.setWidgetResizable(True)
        controls_scroll.setMinimumWidth(350)
        controls_scroll.setMaximumWidth(430)
        controls_host = QWidget()
        controls_layout = QVBoxLayout(controls_host)
        controls_layout.setContentsMargins(10, 10, 10, 10)
        controls_layout.setSpacing(10)

        controls_layout.addWidget(self._build_file_group())
        controls_layout.addWidget(self._build_tools_group())
        controls_layout.addWidget(self._build_tone_group())
        controls_layout.addWidget(self._build_neutral_group())
        controls_layout.addWidget(self._build_diagnostic_group())
        controls_layout.addWidget(self._build_export_group())
        controls_layout.addStretch(1)

        controls_scroll.setWidget(controls_host)
        root.addWidget(controls_scroll)

        self.original_panel = ImagePanel("原片")
        self.positive_panel = ImagePanel("正像")
        self.mask_panel = ImagePanel("诊断标记")
        self.original_card = self._view_card("原片位置（框选片边 / 中性细节）", self.original_panel)
        self.positive_card = self._view_card("正像结果（缩放/平移联动）", self.positive_panel)
        self.mask_card = self._view_card("层次诊断（蓝=底噪，红=原片溢出，黄=亮端截断，青=暗端压死）", self.mask_panel)

        views = QSplitter(Qt.Orientation.Horizontal)
        views.addWidget(self.original_card)
        views.addWidget(self.positive_card)
        views.addWidget(self.mask_card)
        views.setSizes([520, 520, 520])
        root.addWidget(views)
        root.setSizes([390, 1190])
        self.setCentralWidget(root)

    def _view_card(self, title: str, panel: ImagePanel) -> QGroupBox:
        box = QGroupBox(title)
        layout = QVBoxLayout(box)
        layout.setContentsMargins(6, 14, 6, 6)
        layout.addWidget(panel)
        return box

    def _build_file_group(self) -> QGroupBox:
        box = QGroupBox("1. 图像与样片")
        layout = QVBoxLayout(box)
        row1 = QHBoxLayout()
        open_btn = QPushButton("打开 PNG / TIFF")
        open_btn.clicked.connect(self.choose_open_file)
        sample_color_btn = QPushButton("彩色片基样片")
        sample_color_btn.clicked.connect(self.load_color_sample)
        row1.addWidget(open_btn)
        row1.addWidget(sample_color_btn)
        row2 = QHBoxLayout()
        sample_range_btn = QPushButton("范围核对样片")
        sample_range_btn.clicked.connect(self.load_range_sample)
        fit_btn = QPushButton("全部适应窗口")
        fit_btn.clicked.connect(lambda: self.linker.fit_all() if hasattr(self, "linker") else None)
        row2.addWidget(sample_range_btn)
        row2.addWidget(fit_btn)
        layout.addLayout(row1)
        layout.addLayout(row2)
        self.file_label = QLabel("尚未载入图像")
        self.file_label.setWordWrap(True)
        self.file_label.setStyleSheet("color: #9aa4b2;")
        layout.addWidget(self.file_label)
        return box

    def _build_tools_group(self) -> QGroupBox:
        box = QGroupBox("2. 多块片底 / 样本管理")
        layout = QVBoxLayout(box)

        mode_row = QHBoxLayout()
        self.mode_group = QButtonGroup(self)
        self.mode_base = QRadioButton("框选片底色")
        self.mode_neutral = QRadioButton("框选中性细节")
        self.mode_pan = QRadioButton("平移")
        self.mode_base.setChecked(True)
        for button in (self.mode_base, self.mode_neutral, self.mode_pan):
            self.mode_group.addButton(button)
            mode_row.addWidget(button)
        self.mode_group.buttonToggled.connect(self._mode_toggled)
        layout.addLayout(mode_row)

        hint = QLabel("在原片上拖框可多选；单击生成固定小块。红框表示灰尘或溢出，默认不参与底色估计，可在列表中删除。")
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #9aa4b2;")
        layout.addWidget(hint)

        self.patch_list = QListWidget()
        self.patch_list.setMinimumHeight(132)
        self.patch_list.currentItemChanged.connect(self._patch_list_selected)
        layout.addWidget(self.patch_list)

        btn_row = QHBoxLayout()
        delete_btn = QPushButton("删除选中样本")
        delete_btn.clicked.connect(self.delete_selected_patch)
        clear_btn = QPushButton("清空样本")
        clear_btn.clicked.connect(self.clear_patches)
        btn_row.addWidget(delete_btn)
        btn_row.addWidget(clear_btn)
        layout.addLayout(btn_row)

        self.base_info_label = QLabel("片底估计：未选择，使用内置橙色默认值")
        self.base_info_label.setWordWrap(True)
        self.base_info_label.setStyleSheet("font-family: Menlo, Consolas, 'DejaVu Sans Mono', 'Courier New';")
        layout.addWidget(self.base_info_label)
        return box

    def _build_tone_group(self) -> QGroupBox:
        box = QGroupBox("3. 亮暗端、Gamma 与灰平衡")
        layout = QVBoxLayout(box)

        auto_row = QHBoxLayout()
        auto_btn = QPushButton("自动估计亮暗端")
        auto_btn.clicked.connect(self.auto_endpoints_from_image)
        reset_tone_btn = QPushButton("重置影调")
        reset_tone_btn.clicked.connect(self.reset_tone)
        auto_row.addWidget(auto_btn)
        auto_row.addWidget(reset_tone_btn)
        layout.addLayout(auto_row)

        self.black_slider = FloatSlider("暗端", -0.50, 3.80, self.params.black, 0.01, 2)
        self.white_slider = FloatSlider("亮端", 0.05, 4.60, self.params.white, 0.01, 2)
        self.gamma_slider = FloatSlider("Gamma", 0.35, 2.50, self.params.gamma, 0.01, 2)
        for slider in (self.black_slider, self.white_slider, self.gamma_slider):
            slider.valueChanged.connect(self.controls_changed)
            layout.addWidget(slider)

        line = QFrame()
        line.setFrameShape(QFrame.Shape.HLine)
        layout.addWidget(line)

        self.red_slider = FloatSlider("R 倍率", 0.20, 4.00, 1.0, 0.01, 3)
        self.green_slider = FloatSlider("G 倍率", 0.20, 4.00, 1.0, 0.01, 3)
        self.blue_slider = FloatSlider("B 倍率", 0.20, 4.00, 1.0, 0.01, 3)
        for slider in (self.red_slider, self.green_slider, self.blue_slider):
            slider.valueChanged.connect(self.controls_changed)
            layout.addWidget(slider)

        gray_row = QHBoxLayout()
        neutral_btn = QPushButton("用中性样本校正")
        neutral_btn.clicked.connect(self.correct_from_neutral)
        reset_gray_btn = QPushButton("灰平衡归零")
        reset_gray_btn.clicked.connect(self.reset_gray)
        gray_row.addWidget(neutral_btn)
        gray_row.addWidget(reset_gray_btn)
        layout.addLayout(gray_row)
        return box

    def _build_neutral_group(self) -> QGroupBox:
        box = QGroupBox("4. 中性细节处理前后核对")
        layout = QVBoxLayout(box)
        self.neutral_summary = QLabel("尚未选择中性样本。")
        self.neutral_summary.setWordWrap(True)
        self.neutral_summary.setStyleSheet("color: #c9d1d9;")
        layout.addWidget(self.neutral_summary)

        self.neutral_table = QTableWidget(0, 6)
        self.neutral_table.setHorizontalHeaderLabels(["#", "原片相对", "去橙底相对", "成片相对", "成片绝对", "中性/截断"])
        self.neutral_table.verticalHeader().setVisible(False)
        self.neutral_table.setMinimumHeight(118)
        header = self.neutral_table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.neutral_table)
        return box

    def _build_diagnostic_group(self) -> QGroupBox:
        box = QGroupBox("5. 底噪 / 失真标记")
        layout = QVBoxLayout(box)
        legend = QLabel(
            "<span style='color:#4084ff'>■</span> 输入低码/近底噪（正像亮部风险）　"
            "<span style='color:#ff3030'>■</span> 原片高码溢出/失真<br>"
            "<span style='color:#ffd60a'>■</span> 正像亮端/灰增益截断（可拉回）　"
            "<span style='color:#00dce6'>■</span> 正像暗端压死（可拉回）"
        )
        legend.setTextFormat(Qt.TextFormat.RichText)
        legend.setWordWrap(True)
        layout.addWidget(legend)
        self.mask_counts_label = QLabel("载入图像后显示标记比例。")
        self.mask_counts_label.setWordWrap(True)
        self.mask_counts_label.setStyleSheet("font-family: Menlo, Consolas, 'DejaVu Sans Mono', 'Courier New'; color: #c9d1d9;")
        layout.addWidget(self.mask_counts_label)
        return box

    def _build_export_group(self) -> QGroupBox:
        box = QGroupBox("6. 导出正片与回读范围")
        layout = QVBoxLayout(box)
        form = QFormLayout()
        self.export_format = QComboBox()
        self.export_format.addItem("PNG 8-bit RGB", "png8")
        self.export_format.addItem("TIFF 8-bit RGB", "tiff8")
        self.export_format.addItem("TIFF 16-bit RGB", "tiff16")
        self.range_preset = QComboBox()
        self.range_preset.addItem("完整灰度范围 0–255 / 0–65535", "full")
        self.range_preset.addItem("缩限灰度范围 16–235（8-bit 当量）", "legal")
        form.addRow("格式", self.export_format)
        form.addRow("灰度范围", self.range_preset)
        layout.addLayout(form)

        export_btn = QPushButton("导出正片并自动回读核对")
        export_btn.setStyleSheet("font-weight: 700; padding: 7px;")
        export_btn.clicked.connect(self.export_and_verify)
        layout.addWidget(export_btn)

        readback_btn = QPushButton("选择已导出文件回读核对")
        readback_btn.clicked.connect(self.choose_readback_file)
        layout.addWidget(readback_btn)

        self.readback_view = QPlainTextEdit()
        self.readback_view.setReadOnly(True)
        self.readback_view.setMinimumHeight(145)
        self.readback_view.setPlaceholderText("导出后这里会显示磁盘回读的真实位深、各通道极值和码值范围。")
        layout.addWidget(self.readback_view)
        return box

    def _build_menus(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        open_action = QAction("打开 PNG / TIFF", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self.choose_open_file)
        file_menu.addAction(open_action)

        export_action = QAction("导出正片…", self)
        export_action.setShortcut(QKeySequence.StandardKey.Save)
        export_action.triggered.connect(self.export_and_verify)
        file_menu.addAction(export_action)
        file_menu.addSeparator()
        quit_action = QAction("退出", self)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        sample_menu = self.menuBar().addMenu("样片")
        color_action = QAction("彩色片基 + 双灰阶样片", self)
        color_action.triggered.connect(self.load_color_sample)
        sample_menu.addAction(color_action)
        range_action = QAction("输出范围核对样片", self)
        range_action.triggered.connect(self.load_range_sample)
        sample_menu.addAction(range_action)

        help_menu = self.menuBar().addMenu("帮助")
        workflow_action = QAction("操作说明 / 需求对照", self)
        workflow_action.triggered.connect(self.show_help)
        help_menu.addAction(workflow_action)

    def _connect_panels(self) -> None:
        for panel in (self.original_panel, self.positive_panel, self.mask_panel):
            panel.creationRequested.connect(self.on_creation_requested)
            panel.clickRequested.connect(self.on_click_requested)
            panel.patchSelected.connect(self.select_patch)
            panel.hit_test_callback = self.hit_test_scene_point
            panel.cursorMoved.connect(self.show_crosshair)
            panel.cursorLeft.connect(self.hide_crosshair)

    # ---------------- Loading ----------------

    def choose_open_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择普通 PNG 或 16-bit TIFF",
            "",
            "Images (*.png *.tif *.tiff);;PNG (*.png);;TIFF (*.tif *.tiff);;All files (*)",
        )
        if path:
            self.load_path(path)

    def load_path(self, path: str) -> None:
        try:
            doc = load_image(path)
        except Exception as exc:  # visible failure in the GUI
            QMessageBox.critical(self, "无法读取图像", f"{path}\n\n{type(exc).__name__}: {exc}")
            return
        self.set_document(doc)
        self.file_label.setText(f"{Path(path).name}\n{doc.width}×{doc.height} · {doc.bit_depth}-bit · {doc.codes.dtype}")
        self.statusBar().showMessage(f"已载入 {path}")

    def set_document(self, doc: ImageDoc) -> None:
        self.doc = doc
        self.patches = []
        self.next_patch_id = 1
        self.selected_patch_id = None
        self.preview_rgb = doc.preview_float(max_dimension=1500)
        self.params = ConvertParams()
        self.last_final = None
        self.last_masks = None

        for panel in (self.original_panel, self.positive_panel, self.mask_panel):
            panel.clear_image()

        original_u8 = autostretch_original_u8(self.preview_rgb)
        self.original_panel.set_image(u8_to_qimage(original_u8), reset=True)
        self.patch_list.clear()
        self.neutral_table.setRowCount(0)
        self.readback_view.clear()
        self.mask_counts_label.setText("正在处理…")

        self.params.base = tuple(estimate_base([])[0])
        lo, hi = auto_endpoints(self.preview_rgb, self.params.base)
        self.params.black = lo
        self.params.white = hi
        self._params_to_controls()
        self.process_current()
        QTimer.singleShot(0, self.linker.fit_all)

    def load_color_sample(self) -> None:
        self.load_program_sample(color_negative_sample())

    def load_range_sample(self) -> None:
        self.load_program_sample(range_verification_sample())

    def load_program_sample(self, sample: ProgramSample) -> None:
        self.set_document(sample.doc)
        self.file_label.setText(
            f"程序样片：{sample.title}\n{sample.doc.width}×{sample.doc.height} · 16-bit 内存数据"
        )
        for rect in sample.base_rects:
            self.add_patch(rect, "base", select=False)
        for rect in sample.neutral_rects:
            self.add_patch(rect, "neutral", select=False)

        if sample.suggested_params:
            if "black" in sample.suggested_params:
                self.black_slider.setValue(float(sample.suggested_params["black"]))
            if "white" in sample.suggested_params:
                self.white_slider.setValue(float(sample.suggested_params["white"]))
            if "gamma" in sample.suggested_params:
                self.gamma_slider.setValue(float(sample.suggested_params["gamma"]))
        self.reset_gray()
        self.selected_patch_id = None
        self.refresh_patch_list()
        self.refresh_overlays()
        self.process_current()
        QTimer.singleShot(0, self.linker.fit_all)
        self.statusBar().showMessage(sample.description, 8000)

    # ---------------- Modes and patches ----------------

    def _mode_toggled(self) -> None:
        if self.mode_base.isChecked():
            mode = "base"
        elif self.mode_neutral.isChecked():
            mode = "neutral"
        else:
            mode = "pan"
        for panel in (self.original_panel, self.positive_panel, self.mask_panel):
            panel.set_mode(mode)

    def on_creation_requested(self, mode: str, rectf: QRectF) -> None:
        if self.preview_rgb is None:
            return
        h, w = self.preview_rgb.shape[:2]
        rect = NormRect.from_points(
            rectf.left() / w,
            rectf.top() / h,
            rectf.right() / w,
            rectf.bottom() / h,
        )
        if rect.w <= 0 or rect.h <= 0:
            return
        kind = "neutral" if mode == "neutral" else "base"
        self.add_patch(rect, kind, select=True)

    def on_click_requested(self, mode: str, point: QPointF) -> None:
        if self.preview_rgb is None:
            return
        h, w = self.preview_rgb.shape[:2]
        nx, ny = point.x() / w, point.y() / h
        # Fixed roughly 96×72 source pixels, rather than a fixed fraction:
        # this keeps click samples useful on high-resolution scans.
        half_w = min(0.12, 48.0 / max(self.doc.width, 1))
        half_h = min(0.12, 36.0 / max(self.doc.height, 1))
        rect = NormRect.from_points(nx - half_w, ny - half_h, nx + half_w, ny + half_h)
        kind = "neutral" if mode == "neutral" else "base"
        self.add_patch(rect, kind, select=True)

    def add_patch(self, rect: NormRect, kind: str, select: bool = True) -> SamplePatch | None:
        if self.doc is None:
            return None
        patch = self._analyze_with_id(rect, kind)
        self.patches.append(patch)
        if select:
            self.selected_patch_id = patch.id
        self.refresh_patch_list()
        self.refresh_overlays()
        self.schedule_process()

        if patch.bad:
            self.statusBar().showMessage(
                f"样本 #{patch.id} 被标记为{patch.status_label}：{patch.reason}。红框可见，可直接删除。",
                7000,
            )
        return patch

    def _analyze_with_id(self, rect: NormRect, kind: str) -> SamplePatch:
        from .core import analyze_patch

        patch = analyze_patch(self.doc, rect)  # type: ignore[arg-type]
        patch.id = self.next_patch_id
        self.next_patch_id += 1
        patch.kind = kind
        return patch

    def hit_test_scene_point(self, point: QPointF) -> int:
        if self.preview_rgb is None:
            return -1
        h, w = self.preview_rgb.shape[:2]
        nx, ny = point.x() / w, point.y() / h
        for patch in reversed(self.patches):
            if patch.rect.contains(nx, ny, pad=0.006):
                return patch.id
        return -1

    def select_patch(self, patch_id: int) -> None:
        self.selected_patch_id = patch_id
        self.refresh_patch_list()
        self.refresh_overlays()

    def _patch_list_selected(self, current: QListWidgetItem | None, _previous) -> None:
        if current is None:
            self.selected_patch_id = None
        else:
            self.selected_patch_id = int(current.data(Qt.ItemDataRole.UserRole))
        self.refresh_overlays()

    def refresh_patch_list(self) -> None:
        self.patch_list.blockSignals(True)
        self.patch_list.clear()
        for patch in self.patches:
            kind = "中性" if patch.kind == "neutral" else "片底"
            title = f"#{patch.id} [{kind}] {patch.status_label}"
            item = QListWidgetItem(f"{title} — {patch.reason}")
            item.setData(Qt.ItemDataRole.UserRole, patch.id)
            if patch.kind == "neutral":
                item.setForeground(QColor("#e879f9"))
            elif patch.bad:
                item.setForeground(QColor("#ff6b60"))
            else:
                item.setForeground(QColor("#4dd7f5"))
            self.patch_list.addItem(item)
            if patch.id == self.selected_patch_id:
                item.setSelected(True)
                self.patch_list.setCurrentItem(item)
        self.patch_list.blockSignals(False)

        base, good = estimate_base(self.patches)
        if good:
            self.base_info_label.setText(
                f"采用 {good} 块正常片底，中位 RGB≈"
                f"({base[0] * 255:.0f}, {base[1] * 255:.0f}, {base[2] * 255:.0f})"
            )
        else:
            self.base_info_label.setText("没有正常片底；使用内置橙色默认值。请点选未曝光、无灰尘的片边。")

    def delete_selected_patch(self) -> None:
        if self.selected_patch_id is None:
            items = self.patch_list.selectedItems()
            if items:
                self.selected_patch_id = int(items[0].data(Qt.ItemDataRole.UserRole))
        if self.selected_patch_id is None:
            return
        self.patches = [p for p in self.patches if p.id != self.selected_patch_id]
        self.selected_patch_id = self.patches[-1].id if self.patches else None
        self.refresh_patch_list()
        self.refresh_overlays()
        self.schedule_process()
        self.statusBar().showMessage("已删除选中样本；底色和正像已重新计算。", 3000)

    def clear_patches(self) -> None:
        if not self.patches:
            return
        answer = QMessageBox.question(self, "清空样本", "确定删除全部片底/中性样本吗？")
        if answer != QMessageBox.StandardButton.Yes:
            return
        self.patches.clear()
        self.selected_patch_id = None
        self.refresh_patch_list()
        self.refresh_overlays()
        self.schedule_process()

    def refresh_overlays(self) -> None:
        if self.preview_rgb is None:
            return
        specs = []
        for patch in self.patches:
            kind = "neutral" if patch.kind == "neutral" else "base"
            tone = kind if kind == "neutral" else ("bad" if patch.bad else "ok")
            if patch.kind == "neutral":
                label = f"#{patch.id} 中性"
            else:
                label = f"#{patch.id} {patch.status_label}"
            specs.append((patch.id, patch.rect, label, tone, patch.id == self.selected_patch_id))
        for panel in (self.original_panel, self.positive_panel, self.mask_panel):
            panel.set_overlays(specs, self.selected_patch_id)

    # ---------------- Crosshair ----------------

    def show_crosshair(self, point: QPointF) -> None:
        for panel in (self.original_panel, self.positive_panel, self.mask_panel):
            if panel is not self.sender():
                panel.show_crosshair(point)
            else:
                panel.show_crosshair(point)

    def hide_crosshair(self) -> None:
        for panel in (self.original_panel, self.positive_panel, self.mask_panel):
            panel.hide_crosshair()

    # ---------------- Parameter handling and processing ----------------

    def _params_to_controls(self) -> None:
        self.black_slider.setValue(self.params.black)
        self.white_slider.setValue(self.params.white)
        self.gamma_slider.setValue(self.params.gamma)
        r, g, b = self.params.gray
        self.red_slider.setValue(r)
        self.green_slider.setValue(g)
        self.blue_slider.setValue(b)

    def controls_changed(self, *_args) -> None:
        if self.doc is None:
            return
        self.schedule_process()

    def schedule_process(self) -> None:
        if self.doc is not None:
            self.process_timer.start()

    def _read_controls_into_params(self) -> ConvertParams:
        base, _good = estimate_base(self.patches)
        return ConvertParams(
            base=(float(base[0]), float(base[1]), float(base[2])),
            black=self.black_slider.value(),
            white=self.white_slider.value(),
            gamma=self.gamma_slider.value(),
            gray=(self.red_slider.value(), self.green_slider.value(), self.blue_slider.value()),
        ).clamped()

    def _sync_controls_from_params(self, params: ConvertParams) -> None:
        # ConvertParams.clamped() enforces white >= black + span. Reflect that
        # effective value in the widget instead of leaving a dead slider range.
        for slider, value in (
            (self.black_slider, params.black),
            (self.white_slider, params.white),
            (self.gamma_slider, params.gamma),
            (self.red_slider, params.gray[0]),
            (self.green_slider, params.gray[1]),
            (self.blue_slider, params.gray[2]),
        ):
            if abs(slider.value() - float(value)) > 0.0005:
                slider.setValue(float(value))

    def process_current(self) -> None:
        if self.doc is None or self.preview_rgb is None:
            return
        self.params = self._read_controls_into_params()
        self._sync_controls_from_params(self.params)
        final, fields = convert_positive(self.preview_rgb, self.params)
        masks = diagnostic_masks(self.preview_rgb, self.params, self.doc.code_max, fields)
        self.last_final = final
        self.last_masks = masks

        positive_u8 = to_display_u8(final)
        mask_u8 = overlay_masks(positive_u8, masks)
        self.positive_panel.set_image(u8_to_qimage(positive_u8))
        self.mask_panel.set_image(u8_to_qimage(mask_u8))
        self.refresh_overlays()
        self._update_diagnostic_labels(masks)
        self._update_neutral_report()

    def _update_diagnostic_labels(self, masks: dict[str, np.ndarray]) -> None:
        fractions = mask_counts(masks)
        self.mask_counts_label.setText(
            f"输入近底噪/低码：{fractions['noise_floor']:6.2%}  ← 正像亮部易失真\n"
            f"原片高码饱和：{fractions['input_clip']:6.2%}  ← 多为不可恢复\n"
            f"正像亮端/增益截断：{fractions['output_high_clip']:6.2%}  ← 拉回亮端/RGB倍率可恢复\n"
            f"正像暗端压死：{fractions['output_low_crush']:6.2%}  ← 拉低暗端密度可恢复"
        )

    def _update_neutral_report(self) -> None:
        if self.doc is None:
            return
        report = measure_neutral(self.doc, self.patches, self.params)
        self.neutral_summary.setText(report.summary_text())
        table = self.neutral_table
        table.setRowCount(len(report.items))
        for row, stat in enumerate(report.items):
            values = [
                str(stat.patch_id),
                f"{stat.source_relative_median:.0%}",
                f"{stat.pregray_relative_median:.1%}",
                f"{stat.final_relative_median:.1%}",
                f"{stat.final_chroma_median:.3f}",
                f"{stat.final_neutral_fraction:.0%} / 截{stat.final_clipped_fraction:.0%}",
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                if col == 0:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                table.setItem(row, col, item)

    def auto_endpoints_from_image(self) -> None:
        if self.doc is None or self.preview_rgb is None:
            return
        base, _ = estimate_base(self.patches)
        lo, hi = auto_endpoints(self.preview_rgb, base)
        self.black_slider.setValue(lo)
        self.white_slider.setValue(hi)
        self.schedule_process()
        self.statusBar().showMessage(f"自动亮暗端：暗端密度 {lo:.3f}，亮端密度 {hi:.3f}", 5000)

    def correct_from_neutral(self) -> None:
        if self.doc is None:
            return
        gains, message = suggest_neutral_gray(self.doc, self.patches, self.params)
        self.red_slider.setValue(gains[0])
        self.green_slider.setValue(gains[1])
        self.blue_slider.setValue(gains[2])
        self.schedule_process()
        self.statusBar().showMessage(message, 6000)
        if not any(p.kind == "neutral" for p in self.patches):
            QMessageBox.information(self, "中性辅助校正", message)

    def reset_gray(self) -> None:
        self.red_slider.setValue(1.0)
        self.green_slider.setValue(1.0)
        self.blue_slider.setValue(1.0)
        self.controls_changed()

    def reset_tone(self) -> None:
        if self.doc is not None and self.preview_rgb is not None:
            base, _ = estimate_base(self.patches)
            lo, hi = auto_endpoints(self.preview_rgb, base)
            self.black_slider.setValue(lo)
            self.white_slider.setValue(hi)
        else:
            self.black_slider.setValue(0.02)
            self.white_slider.setValue(2.10)
        self.gamma_slider.setValue(1.0)
        self.reset_gray()

    # ---------------- Export / readback ----------------

    def _export_choice(self) -> tuple[str, int, str] | None:
        fmt = self.export_format.currentData()
        if fmt == "png8":
            path, selected_filter = QFileDialog.getSaveFileName(
                self, "导出 8-bit PNG 正片", "positive.png", "PNG image (*.png)"
            )
            if not path:
                return None
            if not path.lower().endswith(".png"):
                path += ".png"
            return path, 8, "png"
        default_ext = ".tiff" if fmt == "tiff16" else ".tif"
        title = "导出 16-bit TIFF 正片" if fmt == "tiff16" else "导出 8-bit TIFF 正片"
        path, _ = QFileDialog.getSaveFileName(self, title, f"positive{default_ext}", "TIFF image (*.tif *.tiff)")
        if not path:
            return None
        if not path.lower().endswith((".tif", ".tiff")):
            path += default_ext
        return path, 16 if fmt == "tiff16" else 8, "tiff"

    def export_and_verify(self) -> None:
        if self.doc is None:
            QMessageBox.information(self, "导出", "请先打开图像或载入程序样片。")
            return
        choice = self._export_choice()
        if choice is None:
            return
        path, bit_depth, _kind = choice
        range_preset = self.range_preset.currentData()

        # A slider's debounced preview may not have fired yet when the save
        # dialog returns; make export read the exact current control values.
        self.process_timer.stop()
        self.params = self._read_controls_into_params()
        self._sync_controls_from_params(self.params)

        try:
            # Recompute from the retained full-resolution source. Slider moves
            # never bake clipping into the source, so pulling parameters back
            # restores the original gradation.
            full_rgb = self.doc.full_float()
            final_full, _ = convert_positive(full_rgb, self.params, details=False)
            export_positive(path, final_full, bit_depth=bit_depth, range_preset=range_preset)
            report = readback_output(path, range_preset=range_preset, bit_depth=bit_depth)
        except Exception as exc:
            QMessageBox.critical(self, "导出/回读失败", f"{path}\n\n{type(exc).__name__}: {exc}")
            return

        self.last_export_path = path
        self.last_export_bit_depth = bit_depth
        self.last_export_range = range_preset
        self.readback_view.setPlainText(report.as_text())
        self.statusBar().showMessage("导出完成并已从磁盘回读核对。", 5000)
        QMessageBox.information(self, "导出完成 · 回读核对", report.as_text())

    def choose_readback_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "回读已导出的正片", "", "Images (*.png *.tif *.tiff);;All files (*)"
        )
        if not path:
            return
        try:
            report = readback_output(path, range_preset=self.range_preset.currentData(), bit_depth=None)  # type: ignore[arg-type]
        except Exception as exc:
            QMessageBox.critical(self, "回读失败", f"{path}\n\n{type(exc).__name__}: {exc}")
            return
        self.readback_view.setPlainText(report.as_text())
        self.statusBar().showMessage("已回读并核对实际输出范围。", 4000)

    # ---------------- Help ----------------

    def show_help(self) -> None:
        QMessageBox.information(
            self,
            "操作说明 / 需求对照",
            "1. 选择“框选片底色”，在多块未曝光片边上拖框或单击；红框=灰尘/溢出，可用 Delete 或按钮删除。\n\n"
            "2. 左侧调整暗端、亮端、Gamma 和 R/G/B 灰平衡；原片、正像、诊断三视图缩放/平移/十字线联动。\n\n"
            "3. 选择“框选中性细节”，再点“用中性样本校正”；表格显示原片、去橙底后和成片的中性色差。\n\n"
            "4. 蓝色=接近输入底噪，红色=原片已经溢出/失真，黄色/青色=参数造成的亮暗截断；拉回滑块即从原始数据重算。\n\n"
            "5. “样片”内置彩色片基、两个灰度范围（暗部段/亮部段）和范围核对图；可导出 PNG/8-bit TIFF/16-bit TIFF，并自动回读真实码值范围。",
        )


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Negative Converter")
    app.setStyle("Fusion")
    font = QFont()
    font.setPointSize(11)
    app.setFont(font)
    window = MainWindow()
    window.show()
    QTimer.singleShot(80, window.load_color_sample)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
