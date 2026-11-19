"""PySide6 桌面界面。

布局
----
- 左侧：图像/演示、视图切换、阈值与明暗反转、邻接与去噪/填隙、区域筛选、导出。
- 右上：可缩放/平移图像视图（原图 / 二值图 / 带编号结果）。
- 右下：全部区域表格（含被筛掉的），人工忽略复选框与画面高亮双向同步。
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PySide6.QtCore import QAbstractTableModel, QModelIndex, QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFileDialog, QFormLayout, QGraphicsItem,
    QGraphicsPixmapItem, QGraphicsScene, QGraphicsView, QGroupBox, QHBoxLayout,
    QHeaderView, QLabel, QMainWindow, QMessageBox, QPushButton, QRadioButton,
    QScrollArea, QSlider, QSpinBox, QSplitter, QTableView, QVBoxLayout, QWidget,
)

from .demos import DEMOS, DEMO_ORDER, expected_for_params, get_demo
from .export import PALETTE, export_all
from .imageio import ImageLoadError, load_image
from .models import (
    Connectivity, FilterCriteria, Polarity, SegmentationResult,
    SegmentParams, ThresholdMode, ThresholdParams,
)
from .segment import disk_area, hit_region, reevaluate, segment


# ---------------------------------------------------------------- 图像转换
def numpy_to_qimage(img: np.ndarray) -> QImage:
    if img.ndim == 2:
        h, w = img.shape
        return QImage(img.data, w, h, img.strides[0], QImage.Format_Grayscale8).copy()
    if img.ndim == 3 and img.shape[2] == 3:
        h, w, _ = img.shape
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        return QImage(rgb.data, w, h, rgb.strides[0], QImage.Format_RGB888).copy()
    if img.ndim == 3 and img.shape[2] == 4:
        h, w, _ = img.shape
        rgba = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
        return QImage(rgba.data, w, h, rgba.strides[0], QImage.Format_RGBA8888).copy()
    raise ValueError("无法转换的图像维度")


def _selection_overlay(out: np.ndarray, labels: np.ndarray, selected: int,
                       color=(60, 235, 255)) -> np.ndarray:
    """在原图/二值图上叠加选中区域的高亮与轮廓。"""
    if selected <= 0:
        return out
    comp = labels == selected
    if not comp.any():
        return out
    c = np.array(color, np.float32)
    out[comp] = (out[comp].astype(np.float32) * 0.45 + c * 0.55).astype(np.uint8)
    border = cv2.morphologyEx(comp.astype(np.uint8), cv2.MORPH_GRADIENT,
                              np.ones((3, 3), np.uint8)).astype(bool)
    out[border] = (255, 255, 255)
    return out


def composite_view(original_bgr: np.ndarray, result: SegmentationResult | None,
                   mode: str, selected: int) -> np.ndarray:
    """生成当前视图的 BGR 图像。

    - original：原图（彩色保持彩色），选中区域带白色轮廓。
    - binary：最终前景掩码（0 黑 / 255 白）；筛掉区域仍在，选中区域高亮。
    - result：按区域着色；被筛掉的区域压暗并加红色横纹，孔洞标为青色，选中区域亮黄。
    """
    if result is None or mode == "original":
        base = original_bgr.copy()
        if result is not None:
            base = _selection_overlay(base, result.labels, selected)
        return base
    if mode == "binary":
        m = (result.mask * 255).astype(np.uint8)
        base = cv2.cvtColor(m, cv2.COLOR_GRAY2BGR)
        return _selection_overlay(base, result.labels, selected)

    labels = result.labels
    n = len(result.regions)
    h, w = labels.shape
    # 把原图压成浅底，让区域颜色更清楚
    base = cv2.addWeighted(original_bgr, 0.25,
                           np.full_like(original_bgr, 255, dtype=np.uint8), 0.75, 0)
    color_lut = np.zeros((n + 1, 3), np.float32)
    alpha_lut = np.zeros(n + 1, np.float32)
    incl_lut = np.zeros(n + 1, bool)
    for rec in result.regions:
        i = rec.stats.label_id
        color_lut[i] = PALETTE[(i - 1) % len(PALETTE)]
        alpha_lut[i] = 0.72 if rec.included else 0.22
        incl_lut[i] = rec.included
    fg = labels > 0
    out = base
    if fg.any():
        a = alpha_lut[labels][..., None] * fg[..., None]
        out = (base.astype(np.float32) * (1.0 - a) + color_lut[labels] * a).astype(np.uint8)
        # 被筛掉的区域：暗红横纹，提示“还在这里，但不计入”
        stripes = (~incl_lut[labels]) & fg & (np.arange(h)[:, None] % 3 == 0)
        out[stripes] = (out[stripes].astype(np.float32) * 0.45
                        + np.array([40, 40, 200], np.float32) * 0.55).astype(np.uint8)
    if result.hole_mask is not None and result.hole_mask.any():
        hm = result.hole_mask.astype(bool)
        out[hm] = (out[hm].astype(np.float32) * 0.25
                   + np.array([215, 190, 45], np.float32) * 0.75).astype(np.uint8)
    return _selection_overlay(out, labels, selected)


# ---------------------------------------------------------------- 编号叠层
class LabelOverlay(QGraphicsItem):
    """单个图元绘制全部区域编号。

    - 编号在屏幕上保持固定字号（不随缩放变小）。
    - 面积很小的区域（例如 4 邻接下的一像素点）在屏幕上排不下编号时，
      自动在附近寻找空位并用细引线连回区域，避免几十个编号叠成一团。
    """

    def __init__(self):
        super().__init__()
        self._w = 0
        self._h = 0
        self._items: list[tuple[float, float, float, float, str, bool]] = []
        self.setZValue(5)

    def set_items(self, w: int, h: int,
                  items: list[tuple[float, float, float, float, str, bool]]) -> None:
        """items: (x, y, bbox_w, bbox_h, text, included)。"""
        self.prepareGeometryChange()
        self._w, self._h, self._items = w, h, items
        self.update()

    def boundingRect(self) -> QRectF:
        return QRectF(0, 0, self._w, self._h)

    @staticmethod
    def _overlaps(rect: QRectF, placed: list[QRectF]) -> bool:
        return any(rect.intersects(p) for p in placed)

    def paint(self, painter: QPainter, option, widget=None) -> None:
        if not self._items:
            return
        scale = painter.transform().m11() or 1.0
        placed: list[QRectF] = []
        # 大致屏幕包围盒：字符宽约 6 px（小字号）/ 7 px（正常字号），高约 9/12 px
        offsets = [(0, 0)]
        for ring in range(1, 7):
            step = ring * 13.0
            offsets.extend([(step, 0), (-step, 0), (0, -step), (0, step),
                            (step, -step), (-step, -step), (step, step), (-step, step)])
        for x, y, bw, bh, text, included in self._items:
            small = max(bw, bh) * scale < 9.0
            font_px = 7 if small else 10
            tw = (5.5 if small else 7.0) * len(text) + 2.0
            th = 9.0 if small else 12.0
            desired = QPointF(x * scale, y * scale)
            best = None
            for dx, dy in offsets:
                cand = QPointF(desired.x() + dx, desired.y() + dy)
                rect = QRectF(cand.x() - 1, cand.y() - th + 3, tw + 2, th)
                if not self._overlaps(rect, placed):
                    best = (cand, rect)
                    break
            if best is None:
                best = (desired, QRectF(desired.x() - 1, desired.y() - th + 3, tw + 2, th))
            cand, rect = best
            placed.append(rect)
            moved = (abs(cand.x() - desired.x()) > 0.5 or abs(cand.y() - desired.y()) > 0.5)
            painter.save()
            if moved:
                pen = QPen(QColor(90, 90, 90, 200))
                pen.setWidthF(1.0 / scale)
                painter.setPen(pen)
                painter.drawLine(QPointF(x + bw / 2.0, y + bh / 2.0),
                                 QPointF(cand.x() / scale, cand.y() / scale))
            painter.translate(cand.x() / scale, cand.y() / scale)
            painter.scale(1.0 / scale, 1.0 / scale)
            painter.setFont(QFont("Helvetica", font_px, QFont.Bold))
            painter.setPen(QPen(QColor(255, 255, 255, 235)))
            for ddx, ddy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                painter.drawText(QPointF(ddx, ddy), text)
            painter.setPen(QPen(QColor(35, 35, 35) if included else QColor(190, 20, 20)))
            painter.drawText(QPointF(0, 0), text)
            painter.restore()


# ---------------------------------------------------------------- 图像视图
class ImageCanvas(QGraphicsView):
    clicked = Signal(int, int)          # 图片坐标
    hovered = Signal(int, int)          # 图片坐标

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.AnchorViewCenter)
        self.setBackgroundBrush(QColor(38, 40, 44))
        self.setMouseTracking(True)
        self._pix_item = QGraphicsPixmapItem()
        self._scene.addItem(self._pix_item)
        self._overlay = LabelOverlay()
        self._scene.addItem(self._overlay)
        self._img_w = 0
        self._img_h = 0
        self._press_pos: QPointF | None = None
        self._drag_last: QPointF | None = None
        self._drag_button = None
        self._min_scale = 0.02
        self._max_scale = 60.0

    def set_frame(self, bgr: np.ndarray,
                  labels: list[tuple[float, float, float, float, str, bool]] | None = None) -> None:
        self._img_h, self._img_w = bgr.shape[:2]
        self._pix_item.setPixmap(QPixmap.fromImage(numpy_to_qimage(bgr)))
        self._overlay.set_items(self._img_w, self._img_h, labels or [])
        self._scene.setSceneRect(QRectF(0, 0, self._img_w, self._img_h))

    def fit(self) -> None:
        if not self._img_w:
            return
        self.resetTransform()
        self.fitInView(QRectF(0, 0, self._img_w, self._img_h), Qt.KeepAspectRatio)

    def wheelEvent(self, event):
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        new = self.transform().m11() * factor
        if self._min_scale <= new <= self._max_scale:
            self.scale(factor, factor)
        event.accept()

    def mousePressEvent(self, event):
        if event.button() in (Qt.LeftButton, Qt.MiddleButton, Qt.RightButton):
            self._press_pos = event.position()
            self._drag_last = event.position()
            self._drag_button = event.button()
            if event.button() != Qt.LeftButton:
                self.setCursor(Qt.ClosedHandCursor)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._press_pos is not None and self._drag_last is not None:
            delta = event.position() - self._drag_last
            self._drag_last = event.position()
            h = self.horizontalScrollBar()
            v = self.verticalScrollBar()
            h.setValue(h.value() - int(delta.x()))
            v.setValue(v.value() - int(delta.y()))
            event.accept()
            return
        p = self.mapToScene(event.position().toPoint())
        x, y = int(np.floor(p.x())), int(np.floor(p.y()))
        if 0 <= x < self._img_w and 0 <= y < self._img_h:
            self.viewport().setCursor(Qt.CrossCursor)
            self.hovered.emit(x, y)
        else:
            self.viewport().setCursor(Qt.ArrowCursor)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._press_pos is not None and self._drag_button == event.button():
            moved = (event.position() - self._press_pos).manhattanLength()
            btn = self._drag_button
            self._press_pos = None
            self._drag_last = None
            self._drag_button = None
            self.setCursor(Qt.ArrowCursor)
            if btn == Qt.LeftButton and moved <= 3:
                p = self.mapToScene(event.position().toPoint())
                x, y = int(np.floor(p.x())), int(np.floor(p.y()))
                if 0 <= x < self._img_w and 0 <= y < self._img_h:
                    self.clicked.emit(x, y)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.fit()
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def zoom_in(self):
        if self.transform().m11() * 1.25 <= self._max_scale:
            self.scale(1.25, 1.25)

    def zoom_out(self):
        if self.transform().m11() * 0.8 >= self._min_scale:
            self.scale(0.8, 0.8)


# ---------------------------------------------------------------- 表格模型
COLS = ["忽略", "编号", "面积(px)", "质心X", "质心Y", "外接矩形(x,y,w,h)",
        "触边", "孔洞数", "孔洞面积", "计入", "排除原因"]


class RegionTableModel(QAbstractTableModel):
    manualToggled = Signal(int, bool)  # label, ignored

    def __init__(self, parent=None):
        super().__init__(parent)
        self._regions: list = []
        self._selected_label = 0
        self._manual: set[int] = set()

    def set_result(self, result: SegmentationResult | None, manual: set[int]) -> None:
        self.beginResetModel()
        self._regions = list(result.regions) if result else []
        self._manual = set(manual)
        self.endResetModel()

    def set_manual(self, manual: set[int]) -> None:
        self._manual = set(manual)
        if self._regions:
            self.dataChanged.emit(self.index(0, 0),
                                  self.index(len(self._regions) - 1, len(COLS) - 1))

    def row_of(self, label: int) -> int:
        for i, rec in enumerate(self._regions):
            if rec.stats.label_id == label:
                return i
        return -1

    def rowCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self._regions)

    def columnCount(self, parent=QModelIndex()) -> int:
        return 0 if parent.isValid() else len(COLS)

    def headerData(self, section, orientation, role=Qt.DisplayRole):
        if role == Qt.DisplayRole and orientation == Qt.Horizontal:
            return COLS[section]
        return None

    def flags(self, index):
        f = Qt.ItemIsEnabled | Qt.ItemIsSelectable
        if index.column() == 0:
            f |= Qt.ItemIsUserCheckable
        return f

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        rec = self._regions[index.row()]
        s = rec.stats
        col = index.column()
        if role == Qt.CheckStateRole and col == 0:
            return Qt.Checked if s.label_id in self._manual else Qt.Unchecked
        if role == Qt.DisplayRole:
            if col == 1:
                return s.label_id
            if col == 2:
                return s.area
            if col == 3:
                return f"{s.centroid_x:.2f}"
            if col == 4:
                return f"{s.centroid_y:.2f}"
            if col == 5:
                return f"({s.bbox[0]},{s.bbox[1]},{s.bbox[2]},{s.bbox[3]})"
            if col == 6:
                return "是" if s.touches_border else "否"
            if col == 7:
                return s.hole_count
            if col == 8:
                return s.hole_area
            if col == 9:
                return "是" if rec.included else "否"
            if col == 10:
                return rec.reason.text
        if role == Qt.ForegroundRole and not rec.included:
            return QColor(190, 60, 60)
        if role == Qt.BackgroundRole and s.label_id == self._selected_label:
            return QColor(255, 236, 150)
        if role == Qt.UserRole:
            return s.label_id
        return None

    def setData(self, index, value, role=Qt.EditRole):
        if role == Qt.CheckStateRole and index.column() == 0:
            label = self._regions[index.row()].stats.label_id
            ignored = (value == Qt.Checked)
            if ignored:
                self._manual.add(label)
            else:
                self._manual.discard(label)
            self.manualToggled.emit(label, ignored)
            return True
        return False

    def set_selected_label(self, label: int) -> None:
        self._selected_label = label
        if self._regions:
            self.dataChanged.emit(self.index(0, 0),
                                  self.index(len(self._regions) - 1, len(COLS) - 1))

    def region_at(self, row: int):
        return self._regions[row] if 0 <= row < len(self._regions) else None


# ---------------------------------------------------------------- 主窗口
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("连通域分割统计（二维静态图）")
        self.resize(1440, 940)
        self._result: SegmentationResult | None = None
        self._gray: np.ndarray | None = None
        self._original_bgr: np.ndarray | None = None
        self._info: dict = {}
        self._manual: set[int] = set()
        self._selected_label = 0
        self._last_signature = None
        self._criteria = FilterCriteria()
        self._demo_key: str | None = None
        self._suppress = True
        self._syncing = False

        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(160)
        self._debounce.timeout.connect(lambda: self._recompute(force=False))
        self._notice_timer = QTimer(self)
        self._notice_timer.setSingleShot(True)
        self._notice_timer.setInterval(12000)
        self._notice_timer.timeout.connect(self._clear_notice)

        self._build_ui()
        self._apply_default_params()
        self._suppress = False
        self.demo_combo.setCurrentIndex(0)
        self._load_demo(DEMO_ORDER[0])

    # --- UI ---------------------------------------------------------
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        splitter = QSplitter(Qt.Horizontal)
        root.addWidget(splitter)

        left_scroll = QScrollArea()
        left_scroll.setWidgetResizable(True)
        left_widget = QWidget()
        left = QVBoxLayout(left_widget)
        left.setSpacing(8)
        left_scroll.setWidget(left_widget)
        left_scroll.setMinimumWidth(340)
        left_scroll.setMaximumWidth(400)
        splitter.addWidget(left_scroll)

        # 图像与演示
        file_group = QGroupBox("图像与演示")
        fv = QVBoxLayout(file_group)
        row1 = QHBoxLayout()
        self.btn_open = QPushButton("打开图片…")
        self.btn_open.clicked.connect(self._open_image)
        self.btn_reset = QPushButton("恢复默认参数")
        self.btn_reset.clicked.connect(self._restore_defaults)
        row1.addWidget(self.btn_open)
        row1.addWidget(self.btn_reset)
        fv.addLayout(row1)
        fv.addWidget(QLabel("演示数据（自生成，无需外部附件）"))
        self.demo_combo = QComboBox()
        for key in DEMO_ORDER:
            self.demo_combo.addItem(DEMOS[key].name, key)
        self.demo_combo.currentIndexChanged.connect(self._on_demo_changed)
        fv.addWidget(self.demo_combo)
        self.demo_note = QLabel("—")
        self.demo_note.setWordWrap(True)
        self.demo_note.setStyleSheet("color:#555;")
        fv.addWidget(self.demo_note)
        self.btn_check_demo = QPushButton("按演示预期校验当前结果")
        self.btn_check_demo.clicked.connect(self._check_demo)
        fv.addWidget(self.btn_check_demo)
        self.lbl_image_info = QLabel("—")
        self.lbl_image_info.setWordWrap(True)
        self.lbl_image_info.setStyleSheet("color:#666; font-size:11px;")
        fv.addWidget(self.lbl_image_info)
        left.addWidget(file_group)

        # 视图
        view_group = QGroupBox("视图（三种可切换）")
        vv = QHBoxLayout(view_group)
        self.rb_original = QRadioButton("原图")
        self.rb_binary = QRadioButton("二值图")
        self.rb_result = QRadioButton("编号结果")
        self.rb_result.setChecked(True)
        for rb in (self.rb_original, self.rb_binary, self.rb_result):
            rb.toggled.connect(self._on_view_mode)
            vv.addWidget(rb)
        left.addWidget(view_group)

        # 阈值
        th_group = QGroupBox("阈值与二值处理范围")
        tf = QFormLayout(th_group)
        self.cb_mode = QComboBox()
        self.cb_mode.addItem("固定阈值", ThresholdMode.FIXED.value)
        self.cb_mode.addItem("局部阈值（自适应均值）", ThresholdMode.LOCAL.value)
        self.cb_mode.currentIndexChanged.connect(self._on_mode_changed)
        tf.addRow("阈值方式", self.cb_mode)
        self.cb_polarity = QComboBox()
        self.cb_polarity.addItem("暗目标（前景 < 阈值）", Polarity.DARK.value)
        self.cb_polarity.addItem("亮目标（前景 > 阈值）", Polarity.BRIGHT.value)
        self.cb_polarity.currentIndexChanged.connect(self._params_changed)
        tf.addRow("明暗反转", self.cb_polarity)
        self.slider_fixed = QSlider(Qt.Horizontal)
        self.slider_fixed.setRange(0, 255)
        self.slider_fixed.valueChanged.connect(self._on_fixed_slider)
        self.spin_fixed = QSpinBox()
        self.spin_fixed.setRange(0, 255)
        self.spin_fixed.valueChanged.connect(self._on_fixed_spin)
        fixed_row = QHBoxLayout()
        fixed_row.addWidget(self.slider_fixed)
        fixed_row.addWidget(self.spin_fixed)
        tf.addRow("固定阈值", self._wrap(fixed_row))
        self.spin_local_radius = QSpinBox()
        self.spin_local_radius.setRange(1, 200)
        self.spin_local_radius.valueChanged.connect(self._params_changed)
        self.spin_local_offset = QSpinBox()
        self.spin_local_offset.setRange(0, 128)
        self.spin_local_offset.valueChanged.connect(self._params_changed)
        tf.addRow("局部窗口半径", self.spin_local_radius)
        tf.addRow("局部偏移", self.spin_local_offset)
        self.lbl_threshold_desc = QLabel("—")
        self.lbl_threshold_desc.setWordWrap(True)
        self.lbl_threshold_desc.setStyleSheet("color:#333; font-size:11px;")
        tf.addRow(self.lbl_threshold_desc)
        self.lbl_range_desc = QLabel("—")
        self.lbl_range_desc.setWordWrap(True)
        self.lbl_range_desc.setStyleSheet("color:#333; font-size:11px;")
        tf.addRow(self.lbl_range_desc)
        left.addWidget(th_group)

        # 邻接与形态
        conn_group = QGroupBox("邻接与去噪/填隙")
        cf = QFormLayout(conn_group)
        self.rb4 = QRadioButton("4 邻接")
        self.rb8 = QRadioButton("8 邻接")
        self.rb8.setChecked(True)
        self.rb4.toggled.connect(self._params_changed)
        self.rb8.toggled.connect(self._params_changed)
        crow = QHBoxLayout()
        crow.addWidget(self.rb4)
        crow.addWidget(self.rb8)
        cf.addRow("连通性", self._wrap(crow))
        self.spin_despeckle = QSpinBox()
        self.spin_despeckle.setRange(0, 80)
        self.spin_despeckle.setSuffix(" px")
        self.spin_despeckle.valueChanged.connect(self._params_changed)
        self.spin_fill = QSpinBox()
        self.spin_fill.setRange(0, 80)
        self.spin_fill.setSuffix(" px")
        self.spin_fill.valueChanged.connect(self._params_changed)
        cf.addRow("去小噪点半径", self.spin_despeckle)
        self.lbl_despeckle = QLabel("—")
        self.lbl_despeckle.setStyleSheet("color:#666; font-size:11px;")
        cf.addRow("", self.lbl_despeckle)
        cf.addRow("填小间隙半径", self.spin_fill)
        self.lbl_fill = QLabel("—")
        self.lbl_fill.setStyleSheet("color:#666; font-size:11px;")
        cf.addRow("", self.lbl_fill)
        self.lbl_conn_note = QLabel(
            "去噪/填隙为有限半径：删除/填补面积不超过对应半径圆盘的区域。\n"
            "孔洞采用与前景互补的邻接：前景 8 邻接时孔洞按 4 邻接，前景 4 邻接时孔洞按 8 邻接。")
        self.lbl_conn_note.setWordWrap(True)
        self.lbl_conn_note.setStyleSheet("color:#666; font-size:11px;")
        cf.addRow(self.lbl_conn_note)
        left.addWidget(conn_group)

        # 筛选
        filt_group = QGroupBox("区域筛选（只影响计入，不删除区域）")
        ff = QFormLayout(filt_group)
        self.spin_min = QSpinBox()
        self.spin_min.setRange(0, 10_000_000)
        self.spin_min.setSpecialValueText("不限")
        self.spin_min.valueChanged.connect(self._criteria_changed)
        self.spin_max = QSpinBox()
        self.spin_max.setRange(0, 10_000_000)
        self.spin_max.setSpecialValueText("不限")
        self.spin_max.valueChanged.connect(self._criteria_changed)
        self.chk_border = QCheckBox("排除接触图片边界的区域")
        self.chk_border.toggled.connect(self._criteria_changed)
        ff.addRow("面积下限(px)", self.spin_min)
        ff.addRow("面积上限(px)", self.spin_max)
        ff.addRow(self.chk_border)
        note = QLabel("被筛掉的区域仍保留在二值图和标签图中；表格“忽略”列可逐区人工排除。")
        note.setWordWrap(True)
        note.setStyleSheet("color:#666; font-size:11px;")
        ff.addRow(note)
        left.addWidget(filt_group)

        # 导出
        exp_group = QGroupBox("导出")
        ev = QVBoxLayout(exp_group)
        self.btn_export = QPushButton("导出标签图 / CSV / 检查图…")
        self.btn_export.clicked.connect(self._export)
        ev.addWidget(self.btn_export)
        self.lbl_export = QLabel("导出为处理后原尺寸：16 位标签 PNG/TIFF（背景 0）、区域 CSV、带编号检查 PNG。")
        self.lbl_export.setWordWrap(True)
        self.lbl_export.setStyleSheet("color:#666; font-size:11px;")
        ev.addWidget(self.lbl_export)
        left.addWidget(exp_group)
        left.addStretch(1)

        # 右栏
        right = QSplitter(Qt.Vertical)
        view_wrap = QWidget()
        vlay = QVBoxLayout(view_wrap)
        vlay.setContentsMargins(0, 0, 0, 0)
        self.canvas = ImageCanvas()
        self.canvas.clicked.connect(self._on_canvas_click)
        self.canvas.hovered.connect(self._on_hover)
        vlay.addWidget(self.canvas, 1)
        self.lbl_view_info = QLabel("滚轮缩放 · 左键/右键拖动平移 · 双击适应窗口 · 左键单击选区")
        self.lbl_view_info.setStyleSheet("color:#666; padding:2px;")
        vlay.addWidget(self.lbl_view_info)
        right.addWidget(view_wrap)

        table_wrap = QWidget()
        tlay = QVBoxLayout(table_wrap)
        tlay.setContentsMargins(0, 0, 0, 0)
        self.lbl_counts = QLabel("全部区域 0 · 当前计入 0 · 计入总面积 0 px")
        f = QFont()
        f.setBold(True)
        self.lbl_counts.setFont(f)
        tlay.addWidget(self.lbl_counts)
        self.lbl_notice = QLabel("")
        self.lbl_notice.setWordWrap(True)
        self.lbl_notice.setStyleSheet(
            "background:#fff3cd; color:#7a4b00; border:1px solid #e0c070;"
            "padding:4px; border-radius:3px;")
        self.lbl_notice.setVisible(False)
        tlay.addWidget(self.lbl_notice)
        self.table = QTableView()
        self.model = RegionTableModel(self)
        self.model.manualToggled.connect(self._on_manual_toggle)
        self.table.setModel(self.model)
        self.table.setSelectionBehavior(QTableView.SelectRows)
        self.table.setSelectionMode(QTableView.SingleSelection)
        self.table.setAlternatingRowColors(True)
        self.table.verticalHeader().setVisible(False)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.selectionModel().selectionChanged.connect(self._on_table_selection)
        tlay.addWidget(self.table, 1)
        right.addWidget(table_wrap)
        right.setStretchFactor(0, 3)
        right.setStretchFactor(1, 2)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)

        self.statusBar().showMessage("就绪")

    @staticmethod
    def _wrap(layout) -> QWidget:
        w = QWidget()
        layout.setContentsMargins(0, 0, 0, 0)
        w.setLayout(layout)
        return w

    # --- 参数 -------------------------------------------------------
    def _params(self) -> SegmentParams:
        conn = Connectivity.FOUR if self.rb4.isChecked() else Connectivity.EIGHT
        return SegmentParams(
            threshold=ThresholdParams(
                mode=ThresholdMode(self.cb_mode.currentData()),
                polarity=Polarity(self.cb_polarity.currentData()),
                fixed_value=self.spin_fixed.value(),
                local_radius=self.spin_local_radius.value(),
                local_offset=self.spin_local_offset.value(),
            ),
            connectivity=conn,
            despeckle_radius=self.spin_despeckle.value(),
            fill_radius=self.spin_fill.value(),
        )

    def _criteria_from_controls(self) -> FilterCriteria:
        return FilterCriteria(min_area=self.spin_min.value(),
                              max_area=self.spin_max.value(),
                              exclude_border=self.chk_border.isChecked())

    def _apply_default_params(self) -> None:
        self._suppress = True
        try:
            self.cb_mode.setCurrentIndex(0)
            self.cb_polarity.setCurrentIndex(self.cb_polarity.findData(Polarity.DARK.value))
            self.spin_fixed.setValue(128)
            self.slider_fixed.setValue(128)
            self.spin_local_radius.setValue(15)
            self.spin_local_offset.setValue(10)
            self.rb8.setChecked(True)
            self.spin_despeckle.setValue(0)
            self.spin_fill.setValue(0)
            self.spin_min.setValue(0)
            self.spin_max.setValue(0)
            self.chk_border.setChecked(False)
            self.rb_result.setChecked(True)
        finally:
            self._suppress = False
        self._update_param_hints()

    def _restore_defaults(self) -> None:
        self._apply_default_params()
        self._manual.clear()
        self.model.set_manual(self._manual)
        self._clear_notice()
        self._recompute(force=True)
        self.statusBar().showMessage("已恢复默认参数，并清除人工忽略", 6000)

    def _update_param_hints(self) -> None:
        p = self._params()
        self.lbl_threshold_desc.setText(p.threshold.describe())
        self.lbl_despeckle.setText(f"删除面积 ≤ {disk_area(p.despeckle_radius)} px 的独立小块"
                                   if p.despeckle_radius else "0 = 不删除小块")
        self.lbl_fill.setText(f"填补面积 ≤ {disk_area(p.fill_radius)} px 的内部孔洞"
                              if p.fill_radius else "0 = 不填补孔洞")
        if self._gray is not None:
            h, w = self._gray.shape
            self.lbl_range_desc.setText(
                f"二值处理范围：整幅图像 {w}×{h} px（全部像素参与阈值判断）。")
        else:
            self.lbl_range_desc.setText("二值处理范围：整幅图像。")
        local = p.threshold.mode is ThresholdMode.LOCAL
        self.spin_local_radius.setEnabled(local)
        self.spin_local_offset.setEnabled(local)
        self.slider_fixed.setEnabled(not local)
        self.spin_fixed.setEnabled(not local)

    def _update_range_stats(self) -> None:
        """在“二值处理范围”下方补一行当前这轮的真实像素数，证明是重新分割。"""
        if self._gray is None:
            return
        h, w = self._gray.shape
        base = f"二值处理范围：整幅图像 {w}×{h} px（全部像素参与阈值判断）。"
        r = self._result
        if r is not None:
            c = r.calc
            base += (f"\n本轮：阈值后 {c['base_pixels']} px → 去噪删 {c['removed_small_pixels']} px"
                     f" → 填隙补 {c['filled_pixels']} px → 最终前景 {c['foreground_pixels']} px，"
                     f"孔洞 {c['hole_pixels']} px。")
        self.lbl_range_desc.setText(base)

    # --- 加载 -------------------------------------------------------
    def _load_demo(self, key: str) -> None:
        demo = get_demo(key)
        self._demo_key = key
        self._gray = demo.image.copy()
        self._original_bgr = cv2.cvtColor(self._gray, cv2.COLOR_GRAY2BGR)
        h, w = self._gray.shape
        self._info = {"path": f"demo:{key}", "size": (w, h), "original_size": (w, h),
                      "resized": False, "color": False, "scale": 1.0}
        self._manual.clear()
        self._selected_label = 0
        self._last_signature = None
        self.model.set_manual(self._manual)
        self._apply_default_params()
        self.demo_note.setText(demo.note)
        self.lbl_image_info.setText(f"演示图 {w}×{h} px，浅色背景 + 深色零件。")
        self._clear_notice()
        self._recompute(force=True)
        self.canvas.fit()
        self.statusBar().showMessage(f"已载入演示：{demo.name}", 6000)

    def _on_demo_changed(self) -> None:
        if self._suppress:
            return
        key = self.demo_combo.currentData()
        if key and key != self._demo_key:
            self._load_demo(key)

    def _open_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开图像", "",
            "图像文件 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff);;所有文件 (*)")
        if not path:
            return
        try:
            img, gray, info = load_image(path)
        except ImageLoadError as exc:
            QMessageBox.critical(self, "无法打开", str(exc))
            return
        self._gray = gray
        self._info = info
        self._original_bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR) if img.ndim == 2 else img.copy()
        self._demo_key = None
        self._manual.clear()
        self._selected_label = 0
        self._last_signature = None
        self.model.set_manual(self._manual)
        self.demo_note.setText("已打开外部图像；参数保持当前设置，可点“恢复默认参数”。")
        self._suppress = True
        self.demo_combo.setCurrentIndex(-1)
        self._suppress = False
        w, h = info["size"]
        extra = "，超出 1600 长边建议先缩小" if info.get("over_limit") else ""
        self.lbl_image_info.setText(
            f"{Path(path).name}：{w}×{h} px，{'彩色' if info.get('color') else '灰度'}"
            f"{extra}。导出为同一尺寸。")
        self._update_param_hints()
        self._clear_notice()
        self._recompute(force=True)
        self.canvas.fit()
        self.statusBar().showMessage(f"已打开 {Path(path).name}", 6000)

    # --- 参数事件 ---------------------------------------------------
    def _on_fixed_slider(self, v: int) -> None:
        if self.spin_fixed.value() != v:
            self.spin_fixed.blockSignals(True)
            self.spin_fixed.setValue(v)
            self.spin_fixed.blockSignals(False)
        self._params_changed()

    def _on_fixed_spin(self, v: int) -> None:
        if self.slider_fixed.value() != v:
            self.slider_fixed.blockSignals(True)
            self.slider_fixed.setValue(v)
            self.slider_fixed.blockSignals(False)
        self._params_changed()

    def _on_mode_changed(self) -> None:
        self._params_changed()

    def _params_changed(self) -> None:
        if self._suppress:
            return
        self._update_param_hints()
        self._debounce.start()

    def _criteria_changed(self) -> None:
        if self._suppress:
            return
        self._criteria = self._criteria_from_controls()
        if self._result is not None:
            self._apply_criteria_only()

    def _apply_criteria_only(self) -> None:
        """只改筛选：不重新分割，不清空人工忽略，编号保持不变。"""
        assert self._result is not None
        reevaluate(self._result, self._criteria, self._manual)
        self.model.set_result(self._result, self._manual)
        self.model.set_selected_label(self._selected_label)
        self._refresh_view()
        self._update_counts()

    def _recompute(self, force: bool = False) -> None:
        if self._gray is None:
            return
        params = self._params()
        sig = params.signature()
        cleared = 0
        seg_changed = self._last_signature is not None and sig != self._last_signature
        if seg_changed and self._manual:
            cleared = len(self._manual)
            self._manual.clear()
            self.model.set_manual(self._manual)
        if seg_changed:
            # 旧编号可能被拆合后的新物体占用，取消选中，避免误读
            self._selected_label = 0
        self._last_signature = sig
        self._criteria = self._criteria_from_controls()
        try:
            result = segment(self._gray, params, self._criteria, self._manual)
        except ValueError as exc:
            QMessageBox.warning(self, "参数错误", str(exc))
            return
        self._result = result
        if self._selected_label and not (1 <= self._selected_label <= len(result.regions)):
            self._selected_label = 0
        self.model.set_result(result, self._manual)
        self.model.set_selected_label(self._selected_label)
        self._refresh_view()
        self._update_counts()
        self._update_range_stats()
        if cleared:
            self._show_notice(
                f"分割参数已变化：已清除 {cleared} 个人工忽略标记；区域已重新编号，旧编号不再对应原物体。")
            self.statusBar().showMessage("分割参数变化：人工忽略已清除，区域已重新编号", 10000)
        elif force:
            self.statusBar().showMessage(
                f"已重新分割：{result.total_count} 个区域，计入 {result.included_count} 个。", 6000)

    def _refresh_view(self) -> None:
        if self._original_bgr is None or self._gray is None:
            return
        if self.rb_original.isChecked():
            mode = "original"
        elif self.rb_binary.isChecked():
            mode = "binary"
        else:
            mode = "result"
        base = composite_view(self._original_bgr, self._result, mode, self._selected_label)
        labels = None
        if mode == "result" and self._result is not None:
            labels = []
            for rec in self._result.regions:
                x, y, w, h = rec.stats.bbox
                labels.append((float(x), float(max(0, y - 2)), float(w), float(h),
                               str(rec.stats.label_id), rec.included))
        self.canvas.set_frame(base, labels)

    def _on_view_mode(self) -> None:
        if self._suppress:
            return
        self._refresh_view()

    def _update_counts(self) -> None:
        r = self._result
        if r is None:
            self.lbl_counts.setText("全部区域 0 · 当前计入 0 · 计入总面积 0 px")
            return
        total_area = sum(x.stats.area for x in r.regions)
        self.lbl_counts.setText(
            f"全部区域 {r.total_count} · 当前计入 {r.included_count} · "
            f"计入总面积 {r.included_area} px    ｜    筛除 {r.total_count - r.included_count} 个"
            f"（{total_area - r.included_area} px）")

    def _show_notice(self, msg: str) -> None:
        self.lbl_notice.setText(msg)
        self.lbl_notice.setVisible(True)
        self._notice_timer.start()

    def _clear_notice(self) -> None:
        self.lbl_notice.clear()
        self.lbl_notice.setVisible(False)

    # --- 选区同步 ---------------------------------------------------
    def _on_hover(self, x: int, y: int) -> None:
        if self._gray is None:
            return
        val = int(self._gray[y, x])
        lab = int(self._result.labels[y, x]) if self._result is not None else 0
        extra = f" · 区域 #{lab}" if lab else " · 背景/孔洞"
        self.lbl_view_info.setText(
            f"坐标 ({x}, {y}) · 灰度 {val}{extra}    ｜    滚轮缩放 · 拖动平移 · 双击适应 · 单击选区")

    def _on_canvas_click(self, x: int, y: int) -> None:
        if self._result is None:
            return
        lab = hit_region(self._result, x, y)
        if lab is None:
            self._set_selection(0)
            self.statusBar().showMessage(f"点击 ({x}, {y})：背景/孔洞，未选中任何区域", 4000)
            return
        self._set_selection(lab)
        rec = self._result.region_by_id(lab)
        if rec:
            s = rec.stats
            self.statusBar().showMessage(
                f"区域 {lab}：面积 {s.area} px，质心 ({s.centroid_x:.2f}, {s.centroid_y:.2f})，"
                f"孔洞 {s.hole_count}，"
                f"{'计入' if rec.included else '未计入（' + rec.reason.text + '）'}", 8000)

    def _set_selection(self, lab: int) -> None:
        self._selected_label = lab
        self.model.set_selected_label(lab)
        row = self.model.row_of(lab) if lab else -1
        self._syncing = True
        try:
            if row >= 0:
                self.table.selectRow(row)
                self.table.scrollTo(self.model.index(row, 0))
                self.table.setCurrentIndex(self.model.index(row, 1))
            else:
                self.table.clearSelection()
                self.table.setCurrentIndex(QModelIndex())
        finally:
            self._syncing = False
        self._refresh_view()

    def _on_table_selection(self, *_args) -> None:
        if self._syncing:
            return
        sel = self.table.selectionModel()
        idx = self.table.currentIndex()
        if sel is None or not sel.hasSelection() or not idx.isValid():
            return
        rec = self.model.region_at(idx.row())
        if rec is None:
            return
        lab = rec.stats.label_id
        if lab == self._selected_label:
            return
        self._selected_label = lab
        self.model.set_selected_label(lab)
        self._refresh_view()
        if self.rb_original.isChecked():
            self.rb_result.setChecked(True)

    def _on_manual_toggle(self, label: int, ignored: bool) -> None:
        if ignored:
            self._manual.add(label)
        else:
            self._manual.discard(label)
        self.model.set_manual(self._manual)
        if self._result is not None:
            reevaluate(self._result, self._criteria, self._manual)
            self.model.set_result(self._result, self._manual)
        self._set_selection(label)
        self._update_counts()

    # --- 演示校验 ---------------------------------------------------
    def _check_demo(self) -> None:
        if not self._demo_key or self._result is None:
            QMessageBox.information(self, "演示校验", "当前不是演示图像，无法按演示预期校验。")
            return
        demo = get_demo(self._demo_key)
        params = self._params()
        conn = params.connectivity.value
        exp = expected_for_params(demo, conn, params.despeckle_radius, params.fill_radius)
        if exp is None:
            QMessageBox.information(
                self, "演示校验",
                f"{demo.name} 没有覆盖当前去噪/填隙半径的预期值。\n"
                "默认参数以及噪点演示的半径 2/4 组合提供精确预期。")
            return
        got_areas = sorted(r.stats.area for r in self._result.regions)
        got_holes = sorted(r.stats.hole_count for r in self._result.regions)
        ok = (self._result.total_count == exp["total"]
              and got_areas == sorted(exp["areas"])
              and (not exp.get("holes") or got_holes == sorted(exp["holes"])))
        text = (
            f"{demo.name}（{conn} 邻接，去噪半径 {params.despeckle_radius}，"
            f"填隙半径 {params.fill_radius}）\n\n"
            f"预期区域数：{exp['total']}    实际：{self._result.total_count}\n"
            f"预期面积：{sorted(exp['areas'])}\n实际面积：{got_areas}\n"
            f"预期孔洞：{sorted(exp['holes'])}\n实际孔洞：{got_holes}\n\n"
            + ("✓ 完全一致" if ok else "✗ 不一致（请检查阈值方式/明暗/邻接/去噪/填隙/筛选）")
        )
        (QMessageBox.information if ok else QMessageBox.warning)(self, "演示校验", text)

    # --- 导出 -------------------------------------------------------
    def _export(self) -> None:
        if self._result is None or self._original_bgr is None:
            QMessageBox.information(self, "导出", "当前没有可导出的分割结果。")
            return
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        if self._demo_key:
            stem = f"demo_{self._demo_key}"
        elif self._info.get("path"):
            stem = Path(self._info["path"]).stem
        else:
            stem = "segmentation"
        try:
            paths = export_all(self._result, self._original_bgr, out_dir, stem, self._info)
        except OSError as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        self.lbl_export.setText("已导出：\n" + "\n".join(f"· {p.name}" for p in paths.values())
                                + f"\n目录：{out_dir}")
        self.statusBar().showMessage(f"已导出到 {out_dir}", 8000)
        QMessageBox.information(
            self, "导出完成",
            "已导出：\n" + "\n".join(str(p) for p in paths.values())
            + "\n\n标签图包含全部真实区域（含被筛掉的），背景为 0；"
              "CSV 注明每个区域是否计入及原因。")


def main(argv: list[str] | None = None) -> int:
    app = QApplication(argv if argv is not None else sys.argv)
    app.setApplicationName("连通域分割统计")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
