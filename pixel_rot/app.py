"""PySide6 像素旋转对照窗。

三块视图并排: 原图 / 方案 A / 方案 B, 每块可切换引擎。
视图支持格线、整数坐标、原画框、关注区、越界/贴边标记, 滚轮缩放、拖拽平移。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from PySide6.QtCore import (
    QPoint,
    QPointF,
    QRectF,
    Qt,
    Signal,
)
from PySide6.QtGui import (
    QBrush,
    QColor,
    QImage,
    QPainter,
    QPen,
    QPolygonF,
)
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .core import (
    EXPAND,
    FIXED,
    METHODS,
    METHOD_LABELS,
    PaletteImage,
    RotationResult,
    load_png,
    preset_center,
    rotate,
    roundtrip_check,
    save_png,
    to_rgba_array,
)
from .exporting import (
    compare_transparent_and_border,
    export_batch,
    load_entry,
    load_manifest,
    transparent_mask_png,
)
from .sample import build_sample

# ---------------------------------------------------------------------------
# 视图
# ---------------------------------------------------------------------------


def qimage_from_palette(img: PaletteImage) -> QImage:
    rgba = to_rgba_array(img)
    h, w = rgba.shape[:2]
    # QImage 需要连续内存; copy() 防止 numpy 缓冲区被回收
    qim = QImage(rgba.data, w, h, 4 * w, QImage.Format.Format_RGBA8888).copy()
    return qim


class PixelView(QWidget):
    """单个像素图的可缩放视图。"""

    centerPicked = Signal(float, float)

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.title = title
        self.image: PaletteImage | None = None
        self.result: RotationResult | None = None
        self.zoom = 18
        self.pan = QPointF(0, 0)  # 像素 (0,0) 左上角在 widget 内的位置
        self.show_grid = True
        self.show_coords = True
        self.show_frame = True
        self.show_rois = True
        self.show_outside = True
        self.show_border = True
        self.show_center = True
        self._drag: QPoint | None = None
        self.hover_cell: tuple[int, int] | None = None
        self._background: QImage | None = None
        self._needs_fit = True
        self.setMouseTracking(True)
        self.setMinimumSize(220, 220)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    # --- 坐标变换 ---
    def cell_to_widget(self, x: float, y: float) -> QPointF:
        return QPointF(self.pan.x() + x * self.zoom, self.pan.y() + y * self.zoom)

    def widget_to_cell(self, pos: QPointF) -> tuple[float, float]:
        return ((pos.x() - self.pan.x()) / self.zoom,
                (pos.y() - self.pan.y()) / self.zoom)

    def set_background_image(self, qim: QImage | None) -> None:
        self._background = qim
        self.update()

    def fit_to_image(self) -> None:
        if not self.image:
            return
        w, h = self.image.size
        m = 24
        zx = max(1, (self.width() - 2 * m) / max(1, w))
        zy = max(1, (self.height() - 2 * m) / max(1, h))
        self.zoom = max(1, min(40, int(min(zx, zy))))
        self.pan = QPointF(
            (self.width() - w * self.zoom) / 2,
            (self.height() - h * self.zoom) / 2,
        )
        self._needs_fit = False
        self.update()

    # --- 绘制 ---
    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 31, 34))
        if not self.image:
            p.setPen(QColor(180, 180, 180))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "无图像")
            return
        w, h = self.image.size

        # 棋盘透明底(或外部给定的红斜纹背景)
        light, dark = QColor(220, 220, 220), QColor(176, 176, 176)
        step = max(1, self.zoom)
        x0 = self.pan.x()
        y0 = self.pan.y()
        if self._background is not None:
            p.drawImage(
                QRectF(x0, y0, w * step, h * step),
                self._background,
                QRectF(0, 0, w, h),
            )
        else:
            for r in range(h):
                for c in range(w):
                    rect = QRectF(x0 + c * step, y0 + r * step, step, step)
                    p.fillRect(rect, light if (r + c) % 2 == 0 else dark)

        # 像素
        qim = qimage_from_palette(self.image)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        p.drawImage(
            QRectF(x0, y0, w * step, h * step),
            qim,
            QRectF(0, 0, w, h),
        )

        # 越出原画框的像素(扩画布)
        if self.show_outside and self.result is not None:
            mask = self.result.outside_frame_mask
            pen = QPen(QColor(255, 170, 0, 220))
            pen.setWidth(2)
            p.setPen(pen)
            for r, c in np.argwhere(mask):
                p.drawRect(QRectF(x0 + c * step, y0 + r * step, step, step))

        # 贴输出画布边的像素(固定画布边缘)
        if self.show_border and self.result is not None:
            mask = self.result.border_mask
            p.fillRect(QRectF(x0, y0, w * step, h * step), QColor(0, 0, 0, 0))
            pen = QPen(QColor(255, 60, 60, 200))
            pen.setWidth(2)
            p.setPen(pen)
            for r, c in np.argwhere(mask):
                p.drawRect(QRectF(x0 + c * step + 1, y0 + r * step + 1,
                                  step - 2, step - 2))

        # 格线
        if self.show_grid and step >= 6:
            pen = QPen(QColor(0, 0, 0, 90))
            pen.setWidth(1)
            p.setPen(pen)
            for c in range(w + 1):
                x = x0 + c * step
                p.drawLine(QPointF(x, y0), QPointF(x, y0 + h * step))
            for r in range(h + 1):
                y = y0 + r * step
                p.drawLine(QPointF(x0, y), QPointF(x0 + w * step, y))

        # 整数坐标
        if self.show_coords and step >= 14:
            p.setPen(QColor(70, 70, 70))
            font = p.font()
            font.setPointSize(7)
            p.setFont(font)
            for c in range(w):
                p.drawText(QRectF(x0 + c * step, y0 - 13, step, 12),
                           Qt.AlignmentFlag.AlignCenter, str(c))
            for r in range(h):
                p.drawText(QRectF(x0 - 22, y0 + r * step, 20, step),
                           Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                           str(r))

        # 原画框
        if self.show_frame and self.result is not None:
            poly = QPolygonF(
                [self.cell_to_widget(px, py) for px, py in self.result.frame_quad]
            )
            pen = QPen(QColor(255, 200, 0), 2)
            pen.setStyle(Qt.PenStyle.DashLine)
            p.setPen(pen)
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawPolygon(poly)

        # 关注区
        if self.show_rois and self.result is not None:
            colors = [QColor(80, 200, 255), QColor(255, 120, 220), QColor(160, 255, 120)]
            for i, roi in enumerate(self.result.roi_results):
                col = colors[i % len(colors)]
                poly = QPolygonF(
                    [self.cell_to_widget(px, py) for px, py in roi.polygon]
                )
                pen = QPen(col, 2)
                p.setPen(pen)
                p.setBrush(QBrush(QColor(col.red(), col.green(), col.blue(), 40)))
                p.drawPolygon(poly)
                if roi.changed:
                    ax = sum(pt[0] for pt in roi.polygon) / len(roi.polygon)
                    ay = sum(pt[1] for pt in roi.polygon) / len(roi.polygon)
                    p.setPen(QPen(QColor(255, 80, 80), 1))
                    p.setBrush(QColor(255, 80, 80, 200))
                    p.drawEllipse(self.cell_to_widget(ax, ay), 7, 7)

        # 旋转中心
        if self.show_center and self.result is not None:
            cx, cy = self.result.center_out
            pt = self.cell_to_widget(cx, cy)
            pen = QPen(QColor(0, 255, 255), 2)
            p.setPen(pen)
            p.drawLine(pt - QPointF(9, 0), pt + QPointF(9, 0))
            p.drawLine(pt - QPointF(0, 9), pt + QPointF(0, 9))
            p.setBrush(QColor(0, 255, 255))
            p.drawEllipse(pt, 2.5, 2.5)

        # 悬停格
        if self.hover_cell is not None:
            r, c = self.hover_cell
            pen = QPen(QColor(0, 120, 255), 2)
            p.setPen(pen)
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRect(QRectF(x0 + c * step, y0 + r * step, step, step))

        self._draw_title(p)

    def _draw_title(self, p: QPainter):
        p.setPen(QColor(235, 235, 235))
        font = p.font()
        font.setPointSize(10)
        p.setFont(font)
        label = self.title
        if self.result is not None:
            label += f"  [{self.result.image.width}x{self.result.image.height}]"
        p.drawText(QRectF(6, 4, self.width() - 12, 18),
                   Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, label)

    # --- 交互 ---
    def wheelEvent(self, event):
        before = self.widget_to_cell(event.position())
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.zoom = max(1, min(60, int(self.zoom * factor)))
        after = self.widget_to_cell(event.position())
        self.pan += QPointF(
            (after[0] - before[0]) * self.zoom,
            (after[1] - before[1]) * self.zoom,
        )
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton
            and event.modifiers() & Qt.KeyboardModifier.AltModifier
        ):
            self._drag = event.position().toPoint()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
        elif event.button() == Qt.MouseButton.LeftButton:
            cx, cy = self.widget_to_cell(event.position())
            self.centerPicked.emit(cx, cy)

    def mouseMoveEvent(self, event):
        if self._drag is not None:
            delta = event.position().toPoint() - self._drag
            self._drag = event.position().toPoint()
            self.pan += QPointF(delta)
            self.update()
        if self.image:
            cx, cy = self.widget_to_cell(event.position())
            r, c = int(math.floor(cy)), int(math.floor(cx))
            if 0 <= r < self.image.height and 0 <= c < self.image.width:
                self.hover_cell = (r, c)
            else:
                self.hover_cell = None
            self.update()

    def mouseReleaseEvent(self, event):
        self._drag = None
        self.unsetCursor()

    def resizeEvent(self, event):
        if self.image and self._needs_fit:
            self.fit_to_image()


class ViewPanel(QWidget):
    """标题 + 引擎选择 + PixelView。"""

    methodChanged = Signal()

    def __init__(self, title: str, with_method: bool, parent=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)
        top = QHBoxLayout()
        self.title_label = QLabel(title)
        self.title_label.setStyleSheet("color:#eee; font-weight:bold;")
        top.addWidget(self.title_label)
        top.addStretch(1)
        self.method_box: QComboBox | None = None
        if with_method:
            self.method_box = QComboBox()
            for m in METHODS:
                self.method_box.addItem(METHOD_LABELS[m], m)
            self.method_box.currentIndexChanged.connect(self.methodChanged)
            top.addWidget(self.method_box)
        lay.addLayout(top)
        self.view = PixelView(title)
        lay.addWidget(self.view, 1)


# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------


@dataclass
class TrialRow:
    angle: float
    method: str
    center: tuple[float, float]
    canvas_mode: str
    pixels: int
    components: int
    holes: int
    outside: int
    collisions: int
    roi_notes: str


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("像素旋转对照窗")
        self.resize(1480, 920)

        self.src_img, self.rois = build_sample()
        self.results: dict[str, RotationResult | None] = {
            "A": None,
            "B": None,
        }
        self.trials: list[TrialRow] = []

        self._build_ui()
        self._load_sample_into_views()
        self.refresh_all()

    # --- UI 搭建 ---
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        # 左控制栏
        dock = QWidget()
        dock.setFixedWidth(310)
        dlay = QVBoxLayout(dock)
        dlay.setContentsMargins(6, 6, 6, 6)

        # 文件
        grp_file = QGroupBox("图像")
        f = QVBoxLayout(grp_file)
        btn_open = QPushButton("导入透明 PNG…")
        btn_open.clicked.connect(self.action_open)
        btn_sample = QPushButton("载入内置样例")
        btn_sample.clicked.connect(self._load_sample_into_views)
        btn_export_batch = QPushButton("批量导出一组角度…")
        btn_export_batch.clicked.connect(self.action_export_batch)
        btn_review = QPushButton("重开导出目录对照…")
        btn_review.clicked.connect(self.action_review)
        for b in (btn_open, btn_sample, btn_export_batch, btn_review):
            f.addWidget(b)
        self.lbl_info = QLabel()
        self.lbl_info.setWordWrap(True)
        self.lbl_info.setStyleSheet("color:#bbb;")
        f.addWidget(self.lbl_info)
        dlay.addWidget(grp_file)

        # 中心与角度
        grp_rot = QGroupBox("旋转中心与角度")
        form = QFormLayout(grp_rot)
        self.cmb_center = QComboBox()
        self.cmb_center.addItem("像素之间的角点 (图框正中)", ("corner",))
        self.cmb_center.addItem("像素中心", ("pixel_center",))
        self.cmb_center.addItem("左上角点 (0,0)", ("top_left",))
        self.cmb_center.addItem("自定义 / 在任意视图上点选", ("custom",))
        self.cmb_center.currentIndexChanged.connect(self._on_center_preset)
        form.addRow("中心", self.cmb_center)
        self.spn_cx = QDoubleSpinBox()
        self.spn_cy = QDoubleSpinBox()
        for sp in (self.spn_cx, self.spn_cy):
            sp.setRange(-999, 999)
            sp.setDecimals(2)
            sp.setSingleStep(0.5)
            sp.valueChanged.connect(self._on_custom_center)
        form.addRow("cx", self.spn_cx)
        form.addRow("cy", self.spn_cy)
        self.spn_angle = QDoubleSpinBox()
        self.spn_angle.setRange(-3600, 3600)
        self.spn_angle.setDecimals(2)
        self.spn_angle.setValue(45)
        self.spn_angle.valueChanged.connect(self.refresh_all)
        form.addRow("角度°(顺)", self.spn_angle)
        quick = QHBoxLayout()
        for ang in (-90, -45, 0, 45, 90, 180):
            b = QPushButton(str(ang))
            b.clicked.connect(lambda _=False, a=ang: self._set_angle(a))
            quick.addWidget(b)
        qw = QWidget()
        qw.setLayout(quick)
        form.addRow("快选", qw)
        dlay.addWidget(grp_rot)

        # 画布与引擎参数
        grp_canvas = QGroupBox("画布 / 保轮廓参数")
        cf = QFormLayout(grp_canvas)
        self.cmb_canvas = QComboBox()
        self.cmb_canvas.addItem("居中扩画布", EXPAND)
        self.cmb_canvas.addItem("固定画布(裁切)", FIXED)
        self.cmb_canvas.currentIndexChanged.connect(self.refresh_all)
        cf.addRow("模式", self.cmb_canvas)
        self.spn_fw = QSpinBox()
        self.spn_fh = QSpinBox()
        for sp in (self.spn_fw, self.spn_fh):
            sp.setRange(1, 4096)
            sp.valueChanged.connect(self.refresh_all)
        cf.addRow("固定宽", self.spn_fw)
        cf.addRow("固定高", self.spn_fh)
        self.spn_ss = QSpinBox()
        self.spn_ss.setRange(1, 16)
        self.spn_ss.setValue(4)
        self.spn_ss.valueChanged.connect(self.refresh_all)
        cf.addRow("超采样 ss", self.spn_ss)
        self.spn_cov = QDoubleSpinBox()
        self.spn_cov.setRange(0.05, 1.0)
        self.spn_cov.setSingleStep(0.05)
        self.spn_cov.setValue(0.5)
        self.spn_cov.valueChanged.connect(self.refresh_all)
        cf.addRow("落色阈值", self.spn_cov)
        dlay.addWidget(grp_canvas)

        # 显示开关
        grp_view = QGroupBox("显示")
        vl = QVBoxLayout(grp_view)
        self.chk_grid = QCheckBox("格线")
        self.chk_coords = QCheckBox("整数坐标")
        self.chk_frame = QCheckBox("原画框")
        self.chk_rois = QCheckBox("关注区")
        self.chk_outside = QCheckBox("越出原画框(橙)")
        self.chk_border = QCheckBox("贴画布边(红)")
        self.chk_center = QCheckBox("旋转中心(青)")
        for chk, default in (
            (self.chk_grid, True),
            (self.chk_coords, True),
            (self.chk_frame, True),
            (self.chk_rois, True),
            (self.chk_outside, True),
            (self.chk_border, True),
            (self.chk_center, True),
        ):
            chk.setChecked(default)
            chk.toggled.connect(self._apply_view_flags)
            vl.addWidget(chk)
        btn_fit = QPushButton("全部视图适应窗口")
        btn_fit.clicked.connect(self._fit_all)
        vl.addWidget(btn_fit)
        dlay.addWidget(grp_view)

        # 关注区
        grp_roi = QGroupBox("特别关注区")
        rl = QVBoxLayout(grp_roi)
        self.lst_rois = QListWidget()
        rl.addWidget(self.lst_rois)
        br = QHBoxLayout()
        btn_add_roi = QPushButton("加矩形关注区…")
        btn_add_roi.clicked.connect(self.action_add_roi)
        btn_del_roi = QPushButton("删除")
        btn_del_roi.clicked.connect(self.action_del_roi)
        br.addWidget(btn_add_roi)
        br.addWidget(btn_del_roi)
        rl.addLayout(br)
        dlay.addWidget(grp_roi)

        # 记录与自检
        grp_run = QGroupBox("方案记录与自检")
        rl2 = QVBoxLayout(grp_run)
        btn_record = QPushButton("记录当前两个方案")
        btn_record.clicked.connect(self.action_record)
        btn_round = QPushButton("90°×4 往返自检…")
        btn_round.clicked.connect(self.action_roundtrip)
        btn_export_png = QPushButton("导出当前视图 PNG…")
        btn_export_png.clicked.connect(self.action_export_current)
        for b in (btn_record, btn_round, btn_export_png):
            rl2.addWidget(b)
        dlay.addWidget(grp_run)
        dlay.addStretch(1)

        root.addWidget(dock)

        # 右侧: 三视图 + 统计/历史
        right = QSplitter(Qt.Orientation.Vertical)
        top_split = QSplitter(Qt.Orientation.Horizontal)
        self.panel_src = ViewPanel("原图", False)
        self.panel_a = ViewPanel("方案 A", True)
        self.panel_b = ViewPanel("方案 B", True)
        self.panel_a.method_box.setCurrentIndex(0)  # forward
        self.panel_b.method_box.setCurrentIndex(2)  # ssaa
        for panel in (self.panel_src, self.panel_a, self.panel_b):
            top_split.addWidget(panel)
            if panel.method_box is not None:
                panel.methodChanged.connect(self.refresh_all)
            panel.view.centerPicked.connect(self.action_pick_center)
        top_split.setSizes([440, 440, 440])
        right.addWidget(top_split)

        self.tabs = QTabWidget()
        self.txt_stats = QTextEdit()
        self.txt_stats.setReadOnly(True)
        self.txt_history = QTextEdit()
        self.txt_history.setReadOnly(True)
        self.tabs.addTab(self.txt_stats, "统计对照")
        self.tabs.addTab(self.txt_history, "方案记录")
        right.addWidget(self.tabs)
        right.setSizes([620, 260])
        root.addWidget(right, 1)

        self._refresh_roi_list()
        self._sync_center_spins()

    # --- 状态 ---
    def current_center(self) -> tuple[float, float]:
        return self.spn_cx.value(), self.spn_cy.value()

    def current_rois(self) -> list[tuple[str, np.ndarray]]:
        return [(name, np.array(poly, dtype=np.float64)) for name, poly in self.rois]

    # --- 动作 ---
    def action_open(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "导入透明低色数 PNG", "", "PNG (*.png)"
        )
        if not path:
            return
        try:
            self.src_img = load_png(path)
            self.rois = []
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导入失败", str(exc))
            return
        self.spn_fw.setValue(self.src_img.width)
        self.spn_fh.setValue(self.src_img.height)
        self._refresh_roi_list()
        self._sync_center_spins()
        self.refresh_all()
        self._fit_all()

    def _load_sample_into_views(self):
        self.src_img, self.rois = build_sample()
        self.spn_fw.setValue(self.src_img.width)
        self.spn_fh.setValue(self.src_img.height)
        self.cmb_center.setCurrentIndex(0)
        self._refresh_roi_list()
        self._sync_center_spins()
        self.refresh_all()
        self._fit_all()

    def _set_angle(self, ang: float):
        self.spn_angle.setValue(ang)

    def _on_center_preset(self):
        kind = self.cmb_center.currentData()[0]
        if kind == "custom":
            return
        cx, cy = preset_center(self.src_img, kind)
        self.spn_cx.blockSignals(True)
        self.spn_cy.blockSignals(True)
        self.spn_cx.setValue(cx)
        self.spn_cy.setValue(cy)
        self.spn_cx.blockSignals(False)
        self.spn_cy.blockSignals(False)
        self.refresh_all()

    def _on_custom_center(self):
        self.cmb_center.blockSignals(True)
        self.cmb_center.setCurrentIndex(3)
        self.cmb_center.blockSignals(False)
        self.refresh_all()

    def action_pick_center(self, cx: float, cy: float):
        # 点选: 普通点击=格点(像素之间), Shift=像素中心
        if QApplication.keyboardModifiers() & Qt.KeyboardModifier.ShiftModifier:
            cx = math.floor(cx) + 0.5
            cy = math.floor(cy) + 0.5
        else:
            cx = float(round(cx))
            cy = float(round(cy))
        self.cmb_center.blockSignals(True)
        self.cmb_center.setCurrentIndex(3)
        self.cmb_center.blockSignals(False)
        self.spn_cx.blockSignals(True)
        self.spn_cy.blockSignals(True)
        self.spn_cx.setValue(cx)
        self.spn_cy.setValue(cy)
        self.spn_cx.blockSignals(False)
        self.spn_cy.blockSignals(False)
        self.refresh_all()

    def action_add_roi(self):
        name, ok = QInputDialog.getText(
            self, "关注区名称", "名称(如 一格线):", text=f"ROI{len(self.rois)+1}"
        )
        if not ok or not name:
            return
        x0, ok0 = QInputDialog.getDouble(self, name, "x0 (连续坐标)", 0, -999, 999, 2)
        if not ok0:
            return
        y0, ok1 = QInputDialog.getDouble(self, name, "y0", 0, -999, 999, 2)
        if not ok1:
            return
        x1, ok2 = QInputDialog.getDouble(self, name, "x1", 4, -999, 999, 2)
        if not ok2:
            return
        y1, ok3 = QInputDialog.getDouble(self, name, "y1", 4, -999, 999, 2)
        if not ok3:
            return
        poly = np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], dtype=np.float64)
        self.rois.append((name, poly))
        self._refresh_roi_list()
        self.refresh_all()

    def action_del_roi(self):
        if not self.rois:
            return
        row = self.lst_rois.currentRow()
        if row < 0:
            row = len(self.rois) - 1
        del self.rois[row]
        self._refresh_roi_list()
        self.refresh_all()

    def action_record(self):
        for key, panel in (("A", self.panel_a), ("B", self.panel_b)):
            res = self.results[key]
            if res is None:
                continue
            notes = "; ".join(
                f"{r.name}:{r.note}" for r in res.roi_results if r.changed
            ) or "关注区无变化"
            self.trials.append(
                TrialRow(
                    angle=res.angle,
                    method=res.method,
                    center=res.center,
                    canvas_mode=res.canvas_mode,
                    pixels=res.stats.pixel_count,
                    components=res.stats.components,
                    holes=len(res.stats.holes),
                    outside=res.outside_pixels,
                    collisions=res.collisions,
                    roi_notes=notes,
                )
            )
        self._render_history()

    def action_roundtrip(self):
        lines = []
        for m in METHODS:
            rep = roundtrip_check(
                self.src_img, m, self.current_center(),
                supersample=self.spn_ss.value(),
            )
            lines.append(
                f"{METHOD_LABELS[m]:<22} {'通过' if rep.ok else '失败'}  "
                f"中心=({rep.center[0]:.2f},{rep.center[1]:.2f})  {rep.detail}"
            )
        QMessageBox.information(self, "90°×4 往返自检", "\n".join(lines))

    def action_export_current(self):
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        out_dir = Path(out_dir)
        angle = self.spn_angle.value()
        save_png(out_dir / "original.png", self.src_img)
        for key, panel in (("A", self.panel_a), ("B", self.panel_b)):
            res = self.results[key]
            if res is None:
                continue
            save_png(out_dir / f"angle_{int(angle):03d}_{key}_{res.method}.png",
                     res.image)
        QMessageBox.information(self, "导出完成", str(out_dir))

    def action_export_batch(self):
        out_dir = QFileDialog.getExistingDirectory(self, "选择批量导出目录")
        if not out_dir:
            return
        text, ok = QInputDialog.getText(
            self, "角度列表", "逗号分隔的角度:", "0,15,30,45,60,75,90,135,180,270"
        )
        if not ok:
            return
        try:
            angles = [float(t.strip()) for t in text.split(",") if t.strip()]
        except ValueError:
            QMessageBox.warning(self, "角度无效", text)
            return
        methods = [
            self.panel_a.method_box.currentData(),
            self.panel_b.method_box.currentData(),
        ]
        fixed_size = None
        if self.cmb_canvas.currentData() == FIXED:
            fixed_size = (self.spn_fw.value(), self.spn_fh.value())
        manifest = export_batch(
            self.src_img,
            out_dir,
            angles,
            methods=list(dict.fromkeys(methods)),
            center=self.current_center(),
            canvas_mode=self.cmb_canvas.currentData(),
            fixed_size=fixed_size,
            rois=self.current_rois(),
            supersample=self.spn_ss.value(),
            coverage_threshold=self.spn_cov.value(),
        )
        QMessageBox.information(
            self, "导出完成",
            f"{len(manifest['entries'])} 张 PNG + manifest.json\n{out_dir}",
        )

    def action_review(self):
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录(含 manifest.json)")
        if not out_dir:
            return
        try:
            bundle = load_manifest(out_dir)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "读取失败", str(exc))
            return
        ReviewDialog(bundle, self).exec()

    # --- 刷新 ---
    def refresh_all(self):
        if not hasattr(self, "panel_a"):
            return
        angle = self.spn_angle.value()
        center = self.current_center()
        mode = self.cmb_canvas.currentData()
        fixed = (
            (self.spn_fw.value(), self.spn_fh.value())
            if mode == FIXED
            else None
        )
        rois = self.current_rois()
        kw = dict(
            img=self.src_img, center=center, theta_deg=angle,
            canvas_mode=mode, fixed_size=fixed, rois=rois,
            supersample=self.spn_ss.value(),
            coverage_threshold=self.spn_cov.value(),
        )
        self.panel_src.view.image = self.src_img
        self.panel_src.view.result = None
        self.panel_src.view._needs_fit = True
        for key, panel in (("A", self.panel_a), ("B", self.panel_b)):
            method = panel.method_box.currentData()
            try:
                res = rotate(method, **kw)
            except Exception as exc:  # noqa: BLE001
                QMessageBox.critical(self, "旋转失败", f"{method}: {exc}")
                return
            self.results[key] = res
            panel.view.image = res.image
            panel.view.result = res
            panel.view._needs_fit = True
            panel.title_label.setText(
                f"方案 {key} · {METHOD_LABELS[method]} · {angle:g}°"
            )
        self.lbl_info.setText(
            f"{self.src_img.width}x{self.src_img.height}  "
            f"{len(self.src_img.palette)} 色  "
            f"不透明 {int(self.src_img.opaque_mask().sum())} 格"
        )
        self._apply_view_flags()
        self._render_stats()
        for panel in (self.panel_src, self.panel_a, self.panel_b):
            panel.view.update()

    def _apply_view_flags(self):
        for panel in (self.panel_src, self.panel_a, self.panel_b):
            v = panel.view
            v.show_grid = self.chk_grid.isChecked()
            v.show_coords = self.chk_coords.isChecked()
            v.show_frame = self.chk_frame.isChecked()
            v.show_rois = self.chk_rois.isChecked()
            v.show_outside = self.chk_outside.isChecked()
            v.show_border = self.chk_border.isChecked()
            v.show_center = self.chk_center.isChecked()
            v.update()

    def _fit_all(self):
        for panel in (self.panel_src, self.panel_a, self.panel_b):
            panel.view.fit_to_image()

    def _refresh_roi_list(self):
        self.lst_rois.clear()
        for name, poly in self.rois:
            xs = poly[:, 0]
            ys = poly[:, 1]
            self.lst_rois.addItem(
                QListWidgetItem(
                    f"{name}  x[{xs.min():g},{xs.max():g}] y[{ys.min():g},{ys.max():g}]"
                )
            )

    def _sync_center_spins(self):
        cx, cy = preset_center(self.src_img, "corner")
        for sp, val in ((self.spn_cx, cx), (self.spn_cy, cy)):
            sp.blockSignals(True)
            sp.setValue(val)
            sp.blockSignals(False)

    def _render_stats(self):
        def block(title: str, res: RotationResult | None) -> str:
            if res is None:
                return f"<h3>{title}</h3>无"
            st = res.stats
            rows = [
                f"<h3>{title} · {METHOD_LABELS[res.method]} · {res.angle:g}°</h3>",
                f"画布 {res.image.width}x{res.image.height}，模式 {res.canvas_mode}，"
                f"中心输出坐标 ({res.center_out[0]:.2f}, {res.center_out[1]:.2f})",
                f"<b>像素数</b> {st.pixel_count}；"
                f"<b>连通块</b> {st.components}（尺寸 {st.component_sizes}）",
                f"<b>孔洞</b> {len(st.holes)} 个"
                + ("（大小 " + ", ".join(str(h.size) for h in st.holes) + "）" if st.holes else ""),
                f"<b>越界丢失</b> {res.outside_pixels} 格；"
                f"<b>同格碰撞</b> {res.collisions} 次；"
                f"<b>贴边</b> {', '.join(st.border_contacts) or '无'}",
                f"色号 {st.colors_used}（均为原色号，无新增颜色）",
            ]
            if res.roi_results:
                rows.append("<b>关注区:</b><ul>")
                for r in res.roi_results:
                    mark = (
                        '<span style="color:#ff7a7a">变化</span>'
                        if r.changed
                        else '<span style="color:#8fdc8f">一致</span>'
                    )
                    rows.append(
                        f"<li>{r.name}: {mark} 像素 {r.pixels}，连通 {r.components}，"
                        f"洞 {r.holes} {r.hole_sizes} {r.note}</li>"
                    )
                rows.append("</ul>")
            return "".join(rows)

        html = block("方案 A", self.results["A"]) + block("方案 B", self.results["B"])
        self.txt_stats.setHtml(html)

    def _render_history(self):
        if not self.trials:
            self.txt_history.setHtml("")
            return
        rows = ["<table border=1 cellspacing=0 cellpadding=4>",
                "<tr><th>角度</th><th>方法</th><th>中心</th><th>画布</th>"
                "<th>像素</th><th>连通块</th><th>洞</th><th>越界</th><th>碰撞</th><th>关注区</th></tr>"]
        for t in self.trials:
            rows.append(
                "<tr>"
                f"<td>{t.angle:g}</td>"
                f"<td>{METHOD_LABELS[t.method]}</td>"
                f"<td>({t.center[0]:g},{t.center[1]:g})</td>"
                f"<td>{t.canvas_mode}</td>"
                f"<td>{t.pixels}</td><td>{t.components}</td><td>{t.holes}</td>"
                f"<td>{t.outside}</td><td>{t.collisions}</td>"
                f"<td>{t.roi_notes}</td></tr>"
            )
        rows.append("</table>")
        self.txt_history.setHtml("".join(rows))


# ---------------------------------------------------------------------------
# 重开对照对话框
# ---------------------------------------------------------------------------


class ReviewDialog(QWidget):
    def __init__(self, bundle: dict, parent=None):
        super().__init__(parent, Qt.WindowType.Window)
        self.bundle = bundle
        self.setWindowTitle("导出目录对照")
        self.resize(1200, 760)
        lay = QVBoxLayout(self)

        top = QHBoxLayout()
        self.cmb_entry = QComboBox()
        for e in bundle["manifest"]["entries"]:
            self.cmb_entry.addItem(
                f"{e['angle']:g}° {METHOD_LABELS[e['method']]} · {Path(e['file']).name}",
                e,
            )
        self.cmb_entry.currentIndexChanged.connect(self._show)
        top.addWidget(QLabel("导出图:"))
        top.addWidget(self.cmb_entry, 1)
        self.chk_mask = QCheckBox("透明区显示红斜纹")
        self.chk_mask.toggled.connect(self._show)
        top.addWidget(self.chk_mask)
        lay.addLayout(top)

        split = QSplitter(Qt.Orientation.Horizontal)
        self.view_orig = PixelView("原图")
        self.view_exp = PixelView("导出图")
        split.addWidget(self.view_orig)
        split.addWidget(self.view_exp)
        lay.addWidget(split, 1)

        self.txt = QTextEdit()
        self.txt.setReadOnly(True)
        self.txt.setFixedHeight(190)
        lay.addWidget(self.txt)
        self.view_orig.image = bundle["original"]
        self._mask_img: Image.Image | None = None
        self._show()

    def _show(self):
        entry = self.cmb_entry.currentData()
        if entry is None:
            return
        exported = load_entry(self.bundle, entry)
        self.view_exp.image = exported
        self._mask_img = transparent_mask_png(exported)
        cmp_ = compare_transparent_and_border(
            self.bundle["original"], exported, entry
        )
        info = [
            f"<h3>{Path(entry['file']).name}</h3>",
            f"尺寸 {cmp_['exported_size']}（原图 {cmp_['original_size']}，"
            f"同尺寸: {cmp_['same_size']}）",
            f"不透明 {cmp_['exported_opaque']} 格，透明 {cmp_['exported_transparent']} 格",
            f"中心输出坐标 {tuple(round(v, 3) for v in cmp_['center_out'])}；"
            f"落在像素中心: {cmp_['center_on_pixel_center']}；"
            f"落在格点(像素之间): {cmp_['center_on_grid_corner']}",
            f"贴边方向: {', '.join(cmp_['border_contacts']) or '无'}",
            f"越界丢失: {entry['outside_pixels']} 格",
        ]
        if "pixel_diffs_vs_original" in cmp_:
            info.append(f"与原图逐格 RGBA 差异: {cmp_['pixel_diffs_vs_original']} 格")
        self.txt.setHtml("".join(info))
        self._apply_mask()
        self.view_orig.fit_to_image()
        self.view_exp.fit_to_image()

    def _apply_mask(self):
        """把红斜纹透明区直接铺到导出视图的棋盘底上。"""
        if self._mask_img is None:
            return
        if self.chk_mask.isChecked():
            arr = np.asarray(self._mask_img)
            h, w = arr.shape[:2]
            qim = QImage(arr.data, w, h, 4 * w, QImage.Format.Format_RGBA8888).copy()
            self.view_exp.set_background_image(qim)
        else:
            self.view_exp.set_background_image(None)


def main() -> int:
    app = QApplication([])
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
