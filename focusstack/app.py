"""PySide6 桌面界面: 四视图同步缩放对照 + 对齐/融合参数 + 人工笔迹修正。"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PySide6.QtCore import QPointF, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QImage, QKeySequence, QPainter, QPainterPath, QPen, QShortcut
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSlider,
    QSpinBox,
    QStatusBar,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from .alignment import MAX_SHIFT, MIN_SCALE, MAX_SCALE, AlignParams
from .export import colorize_label, export_all
from .fusion import FusionParams
from .pipeline import Stroke, compute_all

MAX_EDGE = 1200
MIN_IMGS, MAX_IMGS = 3, 6
LOWCONF_TH = 0.2


def bgr_to_qimage(arr: np.ndarray) -> QImage:
    rgb = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
    rgb = np.ascontiguousarray(rgb)
    h, w, _ = rgb.shape
    return QImage(rgb.data, w, h, w * 3, QImage.Format_RGB888).copy()


class ImageView(QWidget):
    """可缩放/平移/绘笔的图像视图。坐标一律以图像(参考图)坐标对外。"""

    transformChanged = Signal(float, float, float)
    strokeBegin = Signal(float, float)
    strokePoint = Signal(float, float)
    strokeEnd = Signal()
    picked = Signal(float, float)

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self._title = title
        self._qimg: QImage | None = None
        self._scale = 1.0
        self._ox = 0.0
        self._oy = 0.0
        self._panning = False
        self._painting = False
        self._last = QPointF()
        self._cursor: QPointF | None = None
        self.pan_enabled = True
        self.paint_enabled = False
        self.pick_enabled = False
        self.brush_radius = 20.0
        self._valid_rect: tuple[int, int, int, int] | None = None
        self.show_valid = True
        self._live: tuple[list, float, QColor] | None = None
        self._empty_text = ""
        self._syncing = False
        self.setMouseTracking(True)
        self.setMinimumSize(300, 220)

    # ---- 数据 ----
    def set_image(self, arr: np.ndarray | None, empty_text: str = ""):
        self._qimg = bgr_to_qimage(arr) if arr is not None else None
        self._empty_text = empty_text
        self.update()

    def set_valid_rect(self, rect):
        self._valid_rect = rect
        self.update()

    def set_live_stroke(self, points, radius, color: QColor):
        self._live = (points, radius, color) if points else None
        self.update()

    # ---- 坐标 ----
    def _to_img(self, p: QPointF) -> QPointF:
        return QPointF((p.x() - self._ox) / self._scale, (p.y() - self._oy) / self._scale)

    def set_transform(self, s: float, ox: float, oy: float, emit: bool = False):
        self._scale, self._ox, self._oy = s, ox, oy
        self.update()
        if emit:
            self.transformChanged.emit(s, ox, oy)

    def fit(self):
        if self._qimg is None:
            return
        iw, ih = self._qimg.width(), self._qimg.height()
        s = min(self.width() / iw, self.height() / ih) * 0.98
        ox = (self.width() - iw * s) / 2
        oy = (self.height() - ih * s) / 2
        self.set_transform(s, ox, oy, emit=True)

    # ---- 绘制 ----
    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(36, 36, 36))
        if self._qimg is not None:
            p.translate(self._ox, self._oy)
            p.scale(self._scale, self._scale)
            p.setRenderHint(QPainter.SmoothPixmapTransform, self._scale < 1.0)
            p.drawImage(0, 0, self._qimg)
            p.setRenderHint(QPainter.SmoothPixmapTransform, False)
            if self.show_valid and self._valid_rect is not None:
                x, y, w, h = self._valid_rect
                pen = QPen(QColor(80, 255, 120))
                pen.setStyle(Qt.DashLine)
                pen.setWidthF(1.5 / self._scale)
                p.setPen(pen)
                p.drawRect(x, y, w, h)
            if self._live is not None:
                pts, radius, color = self._live
                pen = QPen(color)
                pen.setWidthF(max(1.0, radius * 2))
                pen.setCapStyle(Qt.RoundCap)
                p.setPen(pen)
                if len(pts) == 1:
                    p.drawPoint(QPointF(*pts[0]))
                else:
                    path = QPainterPath(QPointF(*pts[0]))
                    for q in pts[1:]:
                        path.lineTo(QPointF(*q))
                    p.drawPath(path)
            p.resetTransform()
        elif self._empty_text:
            p.setPen(QColor(160, 160, 160))
            p.drawText(self.rect(), Qt.AlignCenter, self._empty_text)
        # 标题
        p.fillRect(0, 0, self.width(), 20, QColor(0, 0, 0, 150))
        p.setPen(QColor(230, 230, 230))
        p.drawText(6, 14, self._title)
        # 画笔光标
        if self.paint_enabled and self._cursor is not None:
            p.setPen(QPen(QColor(255, 255, 255, 200), 1))
            r = self.brush_radius * self._scale
            p.drawEllipse(self._cursor, r, r)
        p.end()

    # ---- 交互 ----
    def wheelEvent(self, e):
        factor = 1.25 ** (e.angleDelta().y() / 120.0)
        pos = e.position()
        ix = (pos.x() - self._ox) / self._scale
        iy = (pos.y() - self._oy) / self._scale
        s = float(np.clip(self._scale * factor, 0.05, 40.0))
        self.set_transform(s, pos.x() - ix * s, pos.y() - iy * s, emit=True)

    def mousePressEvent(self, e):
        if e.button() == Qt.MiddleButton or (
            e.button() == Qt.LeftButton and self.pan_enabled and not self.paint_enabled
        ):
            self._panning = True
            self._last = e.position()
            self.setCursor(Qt.ClosedHandCursor)
        elif e.button() == Qt.LeftButton and self.paint_enabled:
            self._painting = True
            p = self._to_img(e.position())
            self.strokeBegin.emit(p.x(), p.y())
        elif e.button() == Qt.LeftButton and self.pick_enabled:
            p = self._to_img(e.position())
            self.picked.emit(p.x(), p.y())

    def mouseMoveEvent(self, e):
        self._cursor = e.position()
        if self._panning:
            d = e.position() - self._last
            self._last = e.position()
            self.set_transform(self._scale, self._ox + d.x(), self._oy + d.y(), emit=True)
        elif self._painting:
            p = self._to_img(e.position())
            self.strokePoint.emit(p.x(), p.y())
        self.update()

    def mouseReleaseEvent(self, e):
        if self._panning and e.button() in (Qt.LeftButton, Qt.MiddleButton):
            self._panning = False
            self.unsetCursor()
        if self._painting and e.button() == Qt.LeftButton:
            self._painting = False
            self.strokeEnd.emit()

    def leaveEvent(self, _):
        self._cursor = None
        self.update()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("焦点合成 - 多对焦照片清晰区域合成")
        self.resize(1500, 950)

        self.images: list[np.ndarray] = []
        self.names: list[str] = []
        self.ref = 0
        self.aligns: list[AlignParams] = []
        self.params = FusionParams()
        self.strokes: list[Stroke] = []
        self.redo_stack: list[Stroke] = []
        self.results = None
        self._cur_points: list[tuple[float, float]] = []
        self._fitted = False

        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(250)
        self._timer.timeout.connect(self._recompute)
        self._build_ui()

    # ================= UI =================
    def _build_ui(self):
        central = QWidget()
        root = QHBoxLayout(central)
        root.setContentsMargins(6, 6, 6, 6)

        # 左侧面板
        left = QVBoxLayout()
        tabs = QTabWidget()
        tabs.addTab(self._build_images_tab(), "图片")
        tabs.addTab(self._build_align_tab(), "对齐")
        tabs.addTab(self._build_fusion_tab(), "融合")
        tabs.addTab(self._build_pick_tab(), "对比")
        left.addWidget(tabs, 1)
        self.btn_export = QPushButton("导出结果与来源图…")
        self.btn_export.clicked.connect(self._export)
        left.addWidget(self.btn_export)
        leftw = QWidget()
        leftw.setLayout(left)
        leftw.setFixedWidth(320)
        root.addWidget(leftw)

        # 右侧: 工具条 + 四视图
        right = QVBoxLayout()
        bar = QHBoxLayout()
        bar.addWidget(QLabel("输入视图:"))
        self.combo_input = QComboBox()
        self.combo_input.addItems(["参考图", "选中输入(对齐后)", "与参考图叠加对照"])
        self.combo_input.currentIndexChanged.connect(lambda _: self._refresh_views())
        bar.addWidget(self.combo_input)
        self.chk_valid = QCheckBox("显示公共有效区")
        self.chk_valid.setChecked(True)
        self.chk_valid.toggled.connect(self._toggle_valid)
        bar.addWidget(self.chk_valid)
        bar.addSpacing(12)
        self.radio_pan = QRadioButton("漫游")
        self.radio_brush = QRadioButton("画笔")
        self.radio_pick = QRadioButton("取点对比")
        self.radio_pan.setChecked(True)
        self.radio_pan.toggled.connect(self._tool_changed)
        self.radio_brush.toggled.connect(self._tool_changed)
        bar.addWidget(self.radio_pan)
        bar.addWidget(self.radio_brush)
        bar.addWidget(self.radio_pick)
        bar.addSpacing(12)
        bar.addWidget(QLabel("画笔来源:"))
        self.combo_brush = QComboBox()
        self.combo_brush.addItem("擦除(恢复自动)", -1)
        bar.addWidget(self.combo_brush)
        bar.addWidget(QLabel("半径:"))
        self.spin_radius = QSpinBox()
        self.spin_radius.setRange(3, 120)
        self.spin_radius.setValue(20)
        self.spin_radius.valueChanged.connect(self._brush_radius_changed)
        bar.addWidget(self.spin_radius)
        self.btn_undo = QPushButton("撤销")
        self.btn_redo = QPushButton("重做")
        self.btn_undo.clicked.connect(self._undo)
        self.btn_redo.clicked.connect(self._redo)
        bar.addWidget(self.btn_undo)
        bar.addWidget(self.btn_redo)
        bar.addStretch(1)
        right.addLayout(bar)

        grid = QGridLayout()
        self.view_input = ImageView("输入")
        self.view_auto = ImageView("自动结果")
        self.view_final = ImageView("人工修正结果")
        self.view_map = ImageView("来源图(红=低置信, 亮=人工指定)")
        self.views = [self.view_input, self.view_auto, self.view_final, self.view_map]
        grid.addWidget(self.view_input, 0, 0)
        grid.addWidget(self.view_auto, 0, 1)
        grid.addWidget(self.view_final, 1, 0)
        grid.addWidget(self.view_map, 1, 1)
        right.addLayout(grid, 1)
        root.addLayout(right, 1)

        for v in self.views:
            v.transformChanged.connect(lambda s, x, y, src=v: self._sync_views(src, s, x, y))
            v.picked.connect(self._on_pick)
        for v in (self.view_final, self.view_map):
            v.strokeBegin.connect(self._stroke_begin)
            v.strokePoint.connect(self._stroke_point)
            v.strokeEnd.connect(self._stroke_end)

        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar())

        QShortcut(QKeySequence.Undo, self, activated=self._undo)
        QShortcut(QKeySequence.Redo, self, activated=self._redo)
        self._tool_changed()

    def _build_images_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.list_imgs = QListWidget()
        self.list_imgs.currentRowChanged.connect(self._on_select_image)
        lay.addWidget(self.list_imgs, 1)
        row1 = QHBoxLayout()
        for text, fn in [
            ("添加…", self._add_images),
            ("移除", self._remove_image),
            ("上移", lambda: self._move_image(-1)),
            ("下移", lambda: self._move_image(1)),
        ]:
            b = QPushButton(text)
            b.clicked.connect(fn)
            row1.addWidget(b)
        lay.addLayout(row1)
        b = QPushButton("设为参考图")
        b.clicked.connect(self._set_reference)
        lay.addWidget(b)
        lay.addWidget(QLabel("3–6 张同尺寸照片; 长边超过 1200 会自动缩小。\n"
                             "适用: 静态物体、相同曝光、小幅机位偏移。\n"
                             "改变列表或参考图会清空对齐参数与人工笔迹。"))
        return w

    def _build_align_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.lbl_align_target = QLabel("未选择图片")
        lay.addWidget(self.lbl_align_target)
        form = QFormLayout()
        self.spin_dx = QDoubleSpinBox()
        self.spin_dy = QDoubleSpinBox()
        for sp in (self.spin_dx, self.spin_dy):
            sp.setRange(-MAX_SHIFT, MAX_SHIFT)
            sp.setSingleStep(0.1)
            sp.setDecimals(2)
        self.spin_scale = QDoubleSpinBox()
        self.spin_scale.setRange(MIN_SCALE, MAX_SCALE)
        self.spin_scale.setSingleStep(0.001)
        self.spin_scale.setDecimals(4)
        self.spin_scale.setValue(1.0)
        form.addRow("水平位移 dx", self.spin_dx)
        form.addRow("垂直位移 dy", self.spin_dy)
        form.addRow("等比缩放", self.spin_scale)
        lay.addLayout(form)
        b = QPushButton("重置该图对齐")
        b.clicked.connect(self._reset_align)
        lay.addWidget(b)
        lay.addWidget(QLabel("缩放以参考图中心为基准; 图外区域不参与清晰度选择。\n"
                             "在右上当输入视图选“叠加对照”可检查对齐。"))
        lay.addStretch(1)
        for sp in (self.spin_dx, self.spin_dy, self.spin_scale):
            sp.valueChanged.connect(self._align_changed)
        return w

    def _build_fusion_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.lbl_win = QLabel()
        self.sl_win = QSlider(Qt.Horizontal)
        self.sl_win.setRange(5, 51)
        self.sl_win.setSingleStep(2)
        self.sl_win.setValue(self.params.window)
        self.lbl_smooth = QLabel()
        self.sl_smooth = QSlider(Qt.Horizontal)
        self.sl_smooth.setRange(0, 60)
        self.sl_smooth.setValue(int(self.params.smooth))
        self.chk_lowtex = QCheckBox("低纹理防抖(抑制平坦区跳源)")
        self.chk_lowtex.setChecked(self.params.lowtex)
        lay.addWidget(self.lbl_win)
        lay.addWidget(self.sl_win)
        lay.addWidget(self.lbl_smooth)
        lay.addWidget(self.sl_smooth)
        lay.addWidget(self.chk_lowtex)
        lay.addStretch(1)
        self.sl_win.valueChanged.connect(self._fusion_changed)
        self.sl_smooth.valueChanged.connect(self._fusion_changed)
        self.chk_lowtex.toggled.connect(self._fusion_changed)
        self._fusion_changed()
        return w

    def _build_pick_tab(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.addWidget(QLabel("用“取点对比”工具点击任一视图, 比较各输入在同一位置的表现:"))
        self.tbl_pick = QTableWidget(0, 6)
        self.tbl_pick.setHorizontalHeaderLabels(["图", "有效", "灰度", "清晰度", "权重", "采用"])
        self.tbl_pick.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.tbl_pick.setEditTriggers(QTableWidget.NoEditTriggers)
        lay.addWidget(self.tbl_pick, 1)
        return w

    # ================= 图片管理 =================
    def _add_images(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "选择照片", "", "图片 (*.png *.jpg *.jpeg *.tif *.tiff *.bmp)"
        )
        if not paths:
            return
        for p in paths:
            if len(self.images) >= MAX_IMGS:
                self.statusBar().showMessage(f"最多 {MAX_IMGS} 张, 已忽略多余文件", 5000)
                break
            img = cv2.imread(p, cv2.IMREAD_COLOR)
            if img is None:
                self.statusBar().showMessage(f"无法读取: {p}", 5000)
                continue
            h, w = img.shape[:2]
            long_edge = max(h, w)
            if long_edge > MAX_EDGE:
                s = MAX_EDGE / long_edge
                img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
                self.statusBar().showMessage(f"{Path(p).name} 已缩小到长边 {MAX_EDGE}", 5000)
            if self.images and img.shape[:2] != self.images[0].shape[:2]:
                QMessageBox.warning(self, "尺寸不一致", f"{Path(p).name} 尺寸与已载入图片不一致, 已跳过")
                continue
            self.images.append(img)
            self.names.append(Path(p).name)
        self._structure_changed()

    def _remove_image(self):
        row = self.list_imgs.currentRow()
        if row < 0:
            return
        del self.images[row]
        del self.names[row]
        if self.ref >= len(self.images):
            self.ref = 0
        elif row < self.ref:
            self.ref -= 1
        elif row == self.ref:
            self.ref = 0
        self._structure_changed()

    def _move_image(self, delta: int):
        row = self.list_imgs.currentRow()
        if row < 0:
            return
        j = row + delta
        if not (0 <= j < len(self.images)):
            return
        self.images[row], self.images[j] = self.images[j], self.images[row]
        self.names[row], self.names[j] = self.names[j], self.names[row]
        if self.ref == row:
            self.ref = j
        elif self.ref == j:
            self.ref = row
        self._structure_changed()
        self.list_imgs.setCurrentRow(j)

    def _set_reference(self):
        row = self.list_imgs.currentRow()
        if row < 0 or row == self.ref:
            return
        self.ref = row
        self._structure_changed()

    def _structure_changed(self):
        """图片列表或参考图变化: 对齐与笔迹失效, 全部重置。"""
        self.aligns = [AlignParams() for _ in self.images]
        self.strokes.clear()
        self.redo_stack.clear()
        self._fitted = False
        self._refresh_list()
        self._refresh_brush_combo()
        self._recompute()

    def _refresh_list(self):
        self.list_imgs.blockSignals(True)
        self.list_imgs.clear()
        for i, n in enumerate(self.names):
            tag = " (参考)" if i == self.ref else ""
            self.list_imgs.addItem(f"{i + 1}: {n}{tag}")
        self.list_imgs.blockSignals(False)
        if self.names:
            self.list_imgs.setCurrentRow(min(self.ref, len(self.names) - 1))

    def _refresh_brush_combo(self):
        cur = self.combo_brush.currentData()
        self.combo_brush.blockSignals(True)
        self.combo_brush.clear()
        self.combo_brush.addItem("擦除(恢复自动)", -1)
        for i in range(len(self.images)):
            self.combo_brush.addItem(f"图 {i + 1}", i)
        idx = self.combo_brush.findData(cur)
        self.combo_brush.setCurrentIndex(max(0, idx))
        self.combo_brush.blockSignals(False)

    def _on_select_image(self, row: int):
        ok = 0 <= row < len(self.images) and row != self.ref
        for sp in (self.spin_dx, self.spin_dy, self.spin_scale):
            sp.blockSignals(True)
        if 0 <= row < len(self.images):
            a = self.aligns[row]
            self.spin_dx.setValue(a.dx)
            self.spin_dy.setValue(a.dy)
            self.spin_scale.setValue(a.scale)
            self.lbl_align_target.setText(
                f"图 {row + 1}: {self.names[row]}" + (" (参考图, 无需对齐)" if row == self.ref else "")
            )
        else:
            self.lbl_align_target.setText("未选择图片")
        for sp in (self.spin_dx, self.spin_dy, self.spin_scale):
            sp.blockSignals(False)
            sp.setEnabled(ok)
        self._refresh_views()

    # ================= 参数 =================
    def _align_changed(self):
        row = self.list_imgs.currentRow()
        if not (0 <= row < len(self.images)) or row == self.ref:
            return
        self.aligns[row] = AlignParams(
            self.spin_dx.value(), self.spin_dy.value(), self.spin_scale.value()
        )
        self._timer.start()

    def _reset_align(self):
        row = self.list_imgs.currentRow()
        if 0 <= row < len(self.images):
            self.aligns[row] = AlignParams()
            self._on_select_image(row)
            self._timer.start()

    def _fusion_changed(self):
        win = self.sl_win.value() | 1  # 保持奇数
        self.params.window = win
        self.params.smooth = float(self.sl_smooth.value())
        self.params.lowtex = self.chk_lowtex.isChecked()
        self.lbl_win.setText(f"清晰度判断窗口: {win} px")
        self.lbl_smooth.setText(f"边缘过渡(平滑半径): {self.sl_smooth.value()} px")
        self._timer.start()

    def _brush_radius_changed(self, v: int):
        for view in self.views:
            view.brush_radius = float(v)

    def _tool_changed(self):
        brush = self.radio_brush.isChecked()
        pick = self.radio_pick.isChecked()
        for v in self.views:
            v.pick_enabled = pick
            v.paint_enabled = False
            v.pan_enabled = not pick
        if brush:
            self.view_final.paint_enabled = True
            self.view_map.paint_enabled = True
            self.view_final.pan_enabled = False
            self.view_map.pan_enabled = False
        self._brush_radius_changed(self.spin_radius.value())

    def _toggle_valid(self, on: bool):
        for v in getattr(self, "views", []):
            v.show_valid = on
            v.update()

    # ================= 计算 =================
    def _recompute(self):
        if len(self.images) < MIN_IMGS:
            self.results = None
            self._refresh_views()
            return
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            self.results = compute_all(
                self.images, self.ref, self.aligns, self.params, self.strokes
            )
        except ValueError as ex:
            self.results = None
            QMessageBox.warning(self, "无法合成", str(ex))
        finally:
            QApplication.restoreOverrideCursor()
        if self.results is not None and self.results.rejected > 0:
            self.statusBar().showMessage(
                f"有 {self.results.rejected} 个笔迹像素的目标来源在该位置无效(图外), 已拒绝覆盖", 8000
            )
        self._refresh_views()
        if self.results is not None and not self._fitted:
            self._fitted = True
            self.view_input.fit()

    def _refresh_views(self):
        r = self.results
        if r is None:
            msg = "请载入 3–6 张同尺寸照片" if len(self.images) < MIN_IMGS else "无法合成"
            for v in self.views:
                v.set_image(None, msg)
                v.set_valid_rect(None)
            return
        # 输入视图
        mode = self.combo_input.currentIndex()
        sel = self.list_imgs.currentRow()
        if sel < 0:
            sel = self.ref
        if mode == 0 or sel >= len(self.images):
            img = self.images[self.ref]
        elif mode == 1:
            img = r.warped[sel]
        else:
            img = self._checker(self.images[self.ref], r.warped[sel])
        self.view_input.set_image(img)
        self.view_auto.set_image(r.img_auto)
        self.view_final.set_image(r.img_final)
        self.view_map.set_image(self._map_image(r))
        for v in self.views:
            v.set_valid_rect(r.crop)

    @staticmethod
    def _checker(a: np.ndarray, b: np.ndarray, tile: int = 18) -> np.ndarray:
        h, w = a.shape[:2]
        yy, xx = np.mgrid[0:h, 0:w]
        mask = ((xx // tile + yy // tile) % 2).astype(bool)
        out = a.copy()
        out[mask] = b[mask]
        return out

    @staticmethod
    def _map_image(r) -> np.ndarray:
        m = colorize_label(r.label_final, len(r.warped)).astype(np.float32)
        low = r.conf < LOWCONF_TH
        m[low] = 0.55 * m[low] + 0.45 * np.array([0, 0, 255], np.float32)
        ovr = r.override >= 0
        m[ovr] = 0.6 * m[ovr] + 0.4 * 255.0
        return m.astype(np.uint8)

    def _sync_views(self, src: ImageView, s: float, ox: float, oy: float):
        for v in self.views:
            if v is not src:
                v.set_transform(s, ox, oy)

    # ================= 笔迹 =================
    def _brush_source(self) -> int:
        return int(self.combo_brush.currentData())

    def _stroke_begin(self, x: float, y: float):
        self._cur_points = [(x, y)]
        self._update_live()

    def _stroke_point(self, x: float, y: float):
        if not self._cur_points:
            return
        lx, ly = self._cur_points[-1]
        if (x - lx) ** 2 + (y - ly) ** 2 >= 1.0:
            self._cur_points.append((x, y))
            self._update_live()

    def _stroke_end(self):
        if self._cur_points:
            src = self._brush_source()
            self.strokes.append(
                Stroke(list(self._cur_points), float(self.spin_radius.value()), src)
            )
            self.redo_stack.clear()
        self._cur_points = []
        self._update_live()
        self._recompute()

    def _update_live(self):
        src = self._brush_source()
        rgb = [
            (230, 80, 80), (80, 160, 230), (90, 200, 120),
            (230, 190, 70), (180, 120, 220), (90, 200, 200),
        ]
        color = QColor(255, 255, 255) if src < 0 else QColor(*rgb[src % 6])
        for v in (self.view_final, self.view_map):
            v.set_live_stroke(self._cur_points, float(self.spin_radius.value()), color)

    def _undo(self):
        if self.strokes:
            self.redo_stack.append(self.strokes.pop())
            self._recompute()

    def _redo(self):
        if self.redo_stack:
            self.strokes.append(self.redo_stack.pop())
            self._recompute()

    # ================= 取点对比 =================
    def _on_pick(self, x: float, y: float):
        r = self.results
        if r is None:
            return
        xi, yi = int(round(x)), int(round(y))
        h, w = r.common.shape
        if not (0 <= xi < w and 0 <= yi < h):
            return
        n = len(r.warped)
        self.tbl_pick.setRowCount(n)
        chosen = int(r.label_final[yi, xi])
        manual = int(r.override[yi, xi])
        for i in range(n):
            gray = cv2.cvtColor(r.warped[i], cv2.COLOR_BGR2GRAY)
            vals = [
                f"{i + 1}",
                "是" if r.valids[i][yi, xi] else "否",
                f"{int(gray[yi, xi])}",
                f"{r.scores[i][yi, xi]:.1f}",
                f"{r.weights[i][yi, xi]:.3f}",
                "人工" if manual == i else ("自动" if chosen == i else ""),
            ]
            for c, t in enumerate(vals):
                self.tbl_pick.setItem(i, c, QTableWidgetItem(t))
        self.statusBar().showMessage(f"取点: 参考坐标 ({xi}, {yi})", 5000)

    # ================= 导出 =================
    def _export(self):
        if self.results is None:
            QMessageBox.information(self, "无法导出", "请先载入足够的照片并完成合成")
            return
        d = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not d:
            return
        paths = export_all(
            d, self.names, self.ref, self.aligns, self.params, self.strokes, self.results
        )
        QMessageBox.information(
            self,
            "导出完成",
            "\n".join(str(p) for p in paths.values()),
        )


def main():
    app = QApplication(sys.argv)
    w = MainWindow()
    w.show()
    sys.exit(app.exec())
