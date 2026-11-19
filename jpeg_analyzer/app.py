"""PySide6 图形界面:参考图 / 两套解码结果 / 误差热图四视图同步缩放平移,
矩形检查区、像素放大镜、固定网格统计、人工标记与导出。
"""

from __future__ import annotations

import csv
import json
import os

import cv2
import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (QBrush, QColor, QImage, QPainter, QPen, QPixmap)
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QComboBox,
                               QFileDialog, QGraphicsEllipseItem,
                               QGraphicsPixmapItem, QGraphicsRectItem,
                               QGraphicsScene, QGraphicsSimpleTextItem,
                               QGraphicsView, QGridLayout, QGroupBox,
                               QHBoxLayout, QLabel, QListWidget, QMainWindow,
                               QMessageBox, QPushButton, QRadioButton,
                               QSlider, QSpinBox, QSplitter, QTableWidget,
                               QTableWidgetItem, QVBoxLayout, QWidget)

from . import codec, sample_image
from .metrics import error_map, grid_stats, region_stats, weighted_mae

MAX_ROIS = 8
CMAPS = {"jet": cv2.COLORMAP_JET, "hot": cv2.COLORMAP_HOT,
         "viridis": cv2.COLORMAP_VIRIDIS, "gray": None}
MARKER_TYPES = ["块边界", "彩色细边", "渐变区域"]
MARKER_COLORS = {"块边界": QColor(255, 180, 0),
                 "彩色细边": QColor(0, 220, 255),
                 "渐变区域": QColor(255, 0, 255)}
SET_NAMES = ("A", "B")


# ---------------------------------------------------------------- 工具函数

def np_to_qimage(rgb: np.ndarray) -> QImage:
    """uint8 RGB (H, W, 3) -> QImage (拷贝, 不共享内存)。"""
    rgb = np.ascontiguousarray(rgb)
    h, w, _ = rgb.shape
    img = QImage(rgb.data, w, h, 3 * w, QImage.Format_RGB888)
    return img.copy()


def heatmap_rgb(err: np.ndarray, gain: float, cmap: str) -> np.ndarray:
    """误差图(0~255)按增益放大后做伪彩色。增益只影响显示,不影响统计。

    cv2.applyColorMap 输出 BGR,这里显式转回 RGB,避免通道顺序弄反。
    """
    v = np.clip(err.astype(np.float32) * gain, 0, 255).astype(np.uint8)
    code = CMAPS[cmap]
    if code is None:
        return np.stack([v, v, v], axis=2)
    bgr = cv2.applyColorMap(v, code)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def error_placeholder(width: int, height: int, text: str) -> QPixmap:
    """编码失败时的占位图(不展示任何旧数据)。"""
    pm = QPixmap(max(width, 320), max(height, 120))
    pm.fill(QColor(40, 40, 40))
    p = QPainter(pm)
    p.setPen(QColor(255, 90, 90))
    p.drawText(pm.rect(), Qt.AlignCenter | Qt.TextWordWrap, text)
    p.end()
    return pm


def fmt_psnr(stats: dict) -> str:
    return "∞ (无误差)" if stats["identical"] else f"{stats['psnr']:.2f}"


# ---------------------------------------------------------------- 同步视图

class ImageView(QGraphicsView):
    """一个图像视图。滚轮缩放、平移由视图处理,变换同步由主窗口完成。"""

    viewChanged = Signal(object)
    pressed = Signal(float, float, int)     # 图像坐标 x, y, 鼠标键
    moved = Signal(float, float)
    released = Signal(float, float, int)

    def __init__(self, title: str):
        super().__init__()
        self.title = title
        self.scene_ = QGraphicsScene(self)
        self.setScene(self.scene_)
        self.pix_item = QGraphicsPixmapItem()
        self.pix_item.setZValue(0)
        self.scene_.addItem(self.pix_item)
        self.setRenderHint(QPainter.SmoothPixmapTransform, False)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setMouseTracking(True)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.horizontalScrollBar().valueChanged.connect(
            lambda *_: self.viewChanged.emit(self))
        self.verticalScrollBar().valueChanged.connect(
            lambda *_: self.viewChanged.emit(self))

    def set_rgb(self, rgb: np.ndarray | None):
        if rgb is None:
            self.pix_item.setPixmap(QPixmap())
            return
        self.pix_item.setPixmap(QPixmap.fromImage(np_to_qimage(rgb)))
        self.scene_.setSceneRect(0, 0, rgb.shape[1], rgb.shape[0])

    def set_pixmap(self, pm: QPixmap):
        self.pix_item.setPixmap(pm)
        self.scene_.setSceneRect(0, 0, pm.width(), pm.height())

    def wheelEvent(self, event):
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)
        self.viewChanged.emit(self)

    def mousePressEvent(self, event):
        p = self.mapToScene(event.pos())
        self.pressed.emit(p.x(), p.y(), event.button())
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        p = self.mapToScene(event.pos())
        self.moved.emit(p.x(), p.y())
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        p = self.mapToScene(event.pos())
        self.released.emit(p.x(), p.y(), event.button())
        super().mouseReleaseEvent(event)


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("JPEG 编码失真分析")
        self.resize(1500, 950)

        # ---- 数据状态(同一轮编码的结果,由 generation 区分) ----
        self.ref: np.ndarray | None = None
        self.ref_name = ""
        self.results: dict[str, codec.CodecResult | None] = {"A": None, "B": None}
        self.errors: dict[str, str | None] = {"A": None, "B": None}
        self.generation = 0
        self.err_map: np.ndarray | None = None   # 当前热图源的逐像素误差
        self.heat_img: np.ndarray | None = None  # 当前显示的热图 RGB

        self.rois: list[list[int]] = []          # [x, y, w, h]
        self.markers: list[dict] = []            # {"type","x","y"}
        self.grid_block_size = 64
        self.grid_result: dict[str, list[dict] | None] = {"A": None, "B": None}
        self.grid_highlight: tuple | None = None

        self._drawing: list | None = None        # 正在拖出的 ROI [x0,y0,x1,y1]
        self._moving: tuple | None = None        # (roi_index, dx, dy)
        self._syncing = False

        self._build_ui()
        self._load_sample()

    # ------------------------------------------------------------ UI 构建

    def _build_ui(self):
        root = QSplitter(Qt.Horizontal)
        self.setCentralWidget(root)
        root.addWidget(self._build_control_panel())
        root.addWidget(self._build_view_panel())
        root.setStretchFactor(0, 0)
        root.setStretchFactor(1, 1)
        root.setSizes([330, 1170])

    def _build_control_panel(self) -> QWidget:
        panel = QWidget()
        lay = QVBoxLayout(panel)

        # 参考图
        box_ref = QGroupBox("参考图(不透明 PNG,长边 ≤ 1600)")
        v = QVBoxLayout(box_ref)
        btn_sample = QPushButton("生成对照图")
        btn_sample.clicked.connect(self._load_sample)
        btn_open = QPushButton("打开 PNG…")
        btn_open.clicked.connect(self._open_png)
        v.addWidget(btn_sample)
        v.addWidget(btn_open)
        self.lbl_ref = QLabel("—")
        v.addWidget(self.lbl_ref)
        lay.addWidget(box_ref)

        # 两套编码配置
        self.spin_q, self.combo_sub = {}, {}
        box_cfg = QGroupBox("编码配置(质量 1-100 / 色度采样)")
        g = QGridLayout(box_cfg)
        g.addWidget(QLabel("套"), 0, 0)
        g.addWidget(QLabel("质量"), 0, 1)
        g.addWidget(QLabel("色度采样"), 0, 2)
        for row, name in enumerate(SET_NAMES, start=1):
            g.addWidget(QLabel(name), row, 0)
            q = QSpinBox(minimum=1, maximum=100,
                         value=90 if name == "A" else 70)
            s = QComboBox()
            s.addItems(list(codec.SUBSAMPLING))
            if name == "B":
                s.setCurrentIndex(2)  # 4:2:0
            g.addWidget(q, row, 1)
            g.addWidget(s, row, 2)
            self.spin_q[name] = q
            self.combo_sub[name] = s
        btn_enc = QPushButton("编码并比较")
        btn_enc.clicked.connect(self._encode)
        g.addWidget(btn_enc, 3, 0, 1, 3)
        self.lbl_status = {n: QLabel("—") for n in SET_NAMES}
        g.addWidget(self.lbl_status["A"], 4, 0, 1, 3)
        g.addWidget(self.lbl_status["B"], 5, 0, 1, 3)
        lay.addWidget(box_cfg)

        # 热图显示
        box_heat = QGroupBox("误差热图(增益仅影响显示)")
        g = QGridLayout(box_heat)
        g.addWidget(QLabel("误差源"), 0, 0)
        self.radio_heat = {}
        for i, n in enumerate(SET_NAMES):
            r = QRadioButton(n)
            r.toggled.connect(self._refresh_heatmap)
            self.radio_heat[n] = r
            g.addWidget(r, 0, 1 + i)
        self.radio_heat["A"].setChecked(True)
        g.addWidget(QLabel("增益"), 1, 0)
        self.slider_gain = QSlider(Qt.Horizontal, minimum=1, maximum=50, value=10)
        self.slider_gain.valueChanged.connect(self._refresh_heatmap)
        g.addWidget(self.slider_gain, 1, 1, 1, 2)
        self.lbl_gain = QLabel("×10")
        self.slider_gain.valueChanged.connect(
            lambda v: self.lbl_gain.setText(f"×{v}"))
        g.addWidget(self.lbl_gain, 1, 3)
        g.addWidget(QLabel("色标"), 2, 0)
        self.combo_cmap = QComboBox()
        self.combo_cmap.addItems(list(CMAPS))
        self.combo_cmap.currentTextChanged.connect(self._refresh_heatmap)
        g.addWidget(self.combo_cmap, 2, 1, 1, 2)
        g.addWidget(QLabel("块网格"), 3, 0)
        self.combo_grid_overlay = QComboBox()
        self.combo_grid_overlay.addItems(["关", "8×8", "16×16"])
        self.combo_grid_overlay.currentTextChanged.connect(self._refresh_overlays)
        g.addWidget(self.combo_grid_overlay, 3, 1, 1, 2)
        lay.addWidget(box_heat)

        # 交互模式
        box_mode = QGroupBox("交互模式")
        v = QVBoxLayout(box_mode)
        self.radio_mode = {}
        for label, key in [("平移/缩放", "pan"), ("框选检查区", "roi"),
                           ("放置标记", "marker")]:
            r = QRadioButton(label)
            r.toggled.connect(self._mode_changed)
            self.radio_mode[key] = r
            v.addWidget(r)
        self.radio_mode["pan"].setChecked(True)
        h = QHBoxLayout()
        h.addWidget(QLabel("标记类型"))
        self.combo_marker = QComboBox()
        self.combo_marker.addItems(MARKER_TYPES)
        h.addWidget(self.combo_marker)
        v.addLayout(h)
        lay.addWidget(box_mode)

        # 放大镜
        box_mag = QGroupBox("像素放大镜(21×21,同位置)")
        g = QGridLayout(box_mag)
        self.mag_labels = {}
        for i, key in enumerate(["ref", "A", "B", "heat"]):
            lab = QLabel()
            lab.setFixedSize(126, 126)
            lab.setStyleSheet("background:#202020;")
            self.mag_labels[key] = lab
            g.addWidget(lab, 0, i)
            t = QLabel({"ref": "参考", "A": "A", "B": "B", "heat": "热图"}[key])
            t.setAlignment(Qt.AlignCenter)
            g.addWidget(t, 1, i)
        self.lbl_mag_info = QLabel("—")
        g.addWidget(self.lbl_mag_info, 2, 0, 1, 4)
        lay.addWidget(box_mag)

        # 网格统计
        box_grid = QGroupBox("固定网格分区统计")
        g = QGridLayout(box_grid)
        g.addWidget(QLabel("块边长(px)"), 0, 0)
        self.spin_block = QSpinBox(minimum=8, maximum=512, value=64)
        g.addWidget(self.spin_block, 0, 1)
        btn_grid = QPushButton("计算网格统计")
        btn_grid.clicked.connect(self._compute_grid)
        g.addWidget(btn_grid, 0, 2)
        self.lbl_grid_check = QLabel("—")
        g.addWidget(self.lbl_grid_check, 1, 0, 1, 3)
        lay.addWidget(box_grid)

        # 导出
        btn_export = QPushButton("导出 JPEG / 选区 JSON / 指标 CSV…")
        btn_export.clicked.connect(self._export)
        lay.addWidget(btn_export)

        lay.addStretch(1)
        return panel

    def _build_view_panel(self) -> QWidget:
        panel = QWidget()
        v = QVBoxLayout(panel)

        grid = QGridLayout()
        self.views: dict[str, ImageView] = {}
        titles = {"ref": "参考图", "A": "解码 A", "B": "解码 B", "heat": "误差热图"}
        for i, key in enumerate(["ref", "A", "B", "heat"]):
            cell = QWidget()
            cv = QVBoxLayout(cell)
            cv.setContentsMargins(0, 0, 0, 0)
            lab = QLabel(titles[key])
            lab.setAlignment(Qt.AlignCenter)
            view = ImageView(key)
            view.viewChanged.connect(self._sync_views)
            view.pressed.connect(self._view_pressed)
            view.moved.connect(self._view_moved)
            view.released.connect(self._view_released)
            cv.addWidget(lab)
            cv.addWidget(view)
            grid.addWidget(cell, i // 2, i % 2)
            self.views[key] = view
        v.addLayout(grid, stretch=1)

        # 底部:指标表 + 列表区
        bottom = QHBoxLayout()
        self.table = QTableWidget(0, 8)
        self.table.setHorizontalHeaderLabels(
            ["区域", "套", "像素数", "MAE-R", "MAE-G", "MAE-B", "总MAE", "PSNR(dB)"])
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        bottom.addWidget(self.table, stretch=1)

        side = QVBoxLayout()
        side.addWidget(QLabel("最差网格块(点击定位)"))
        self.list_worst = QListWidget()
        self.list_worst.currentRowChanged.connect(self._goto_worst)
        side.addWidget(self.list_worst)

        side.addWidget(QLabel("检查区(最多 8 个)"))
        self.list_rois = QListWidget()
        side.addWidget(self.list_rois)
        btn_del_roi = QPushButton("删除选中检查区")
        btn_del_roi.clicked.connect(self._delete_selected_roi)
        side.addWidget(btn_del_roi)

        side.addWidget(QLabel("标记"))
        self.list_markers = QListWidget()
        side.addWidget(self.list_markers)
        btn_del_marker = QPushButton("删除选中标记")
        btn_del_marker.clicked.connect(self._delete_selected_marker)
        side.addWidget(btn_del_marker)
        bottom.addLayout(side, stretch=0)
        v.addLayout(bottom, stretch=0)
        return panel

    # ------------------------------------------------------------ 参考图

    def _load_sample(self):
        self._set_reference(sample_image.generate(), "内置对照图")

    def _open_png(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开参考 PNG", "", "PNG 图片 (*.png)")
        if not path:
            return
        try:
            arr = codec.load_reference_png(path)
        except Exception as e:  # noqa: BLE001 - 给用户看具体原因
            QMessageBox.warning(self, "无法加载", str(e))
            return
        self._set_reference(arr, os.path.basename(path))

    def _set_reference(self, rgb: np.ndarray, name: str):
        self.ref = rgb
        self.ref_name = name
        self.rois.clear()
        self.markers.clear()
        self.grid_result = {"A": None, "B": None}
        self.grid_highlight = None
        h, w = rgb.shape[:2]
        self.lbl_ref.setText(f"{name} · {w}×{h}")
        self.views["ref"].set_rgb(rgb)
        self._fit_views()
        self._encode()

    def _fit_views(self):
        for key in ("ref", "A", "B", "heat"):
            v = self.views[key]
            if v.pix_item.pixmap().isNull():
                continue
            v.fitInView(v.pix_item, Qt.KeepAspectRatio)
        self._sync_views(self.views["ref"])

    # ------------------------------------------------------------ 编码

    def _encode(self):
        """同一轮编码两套配置;一套失败单独说明,绝不展示旧数据。"""
        if self.ref is None:
            return
        self.generation += 1
        gen = self.generation
        # 先清空旧结果,避免旧数据被误认为新结果
        self.results = {"A": None, "B": None}
        self.errors = {"A": None, "B": None}
        self.err_map = None
        self.heat_img = None

        for name in SET_NAMES:
            q = self.spin_q[name].value()
            sub = self.combo_sub[name].currentText()
            try:
                res = codec.run_round(self.ref, q, sub)
                if (res.width, res.height) != (self.ref.shape[1], self.ref.shape[0]):
                    raise ValueError(
                        f"解码尺寸 {res.width}×{res.height} 与参考不一致")
                if gen != self.generation:  # 期间又触发了一轮
                    return
                self.results[name] = res
                self.errors[name] = None
                self.views[name].set_rgb(res.decoded)
                self.lbl_status[name].setText(
                    f"{name}: q={q} {sub.split(' ')[0]} · "
                    f"{res.nbytes:,} 字节 · {res.width}×{res.height}")
                self.lbl_status[name].setStyleSheet("color: black;")
            except Exception as e:  # noqa: BLE001 - 失败须单独说明
                if gen != self.generation:
                    return
                self.results[name] = None
                self.errors[name] = str(e)
                h, w = self.ref.shape[:2]
                self.views[name].set_pixmap(
                    error_placeholder(w, h, f"套 {name} 编码失败:\n{e}"))
                self.lbl_status[name].setText(f"{name}: 编码失败 — {e}")
                self.lbl_status[name].setStyleSheet("color: red;")

        self._refresh_heatmap()
        self._refresh_table()
        if self.grid_result["A"] is not None or self.grid_result["B"] is not None:
            self._compute_grid()
        self._refresh_overlays()

    # ------------------------------------------------------------ 热图

    def _heat_source(self) -> str:
        return "A" if self.radio_heat["A"].isChecked() else "B"

    def _refresh_heatmap(self, *_):
        if self.ref is None:
            return
        src = self._heat_source()
        res = self.results.get(src)
        if res is None:
            self.err_map = None
            self.heat_img = None
            h, w = self.ref.shape[:2]
            msg = self.errors.get(src) or "尚未编码"
            self.views["heat"].set_pixmap(
                error_placeholder(w, h, f"套 {src} 无误差数据:\n{msg}"))
            return
        self.err_map = error_map(self.ref, res.decoded)
        self.heat_img = heatmap_rgb(self.err_map, float(self.slider_gain.value()),
                                    self.combo_cmap.currentText())
        self.views["heat"].set_rgb(self.heat_img)

    # ------------------------------------------------------------ 视图同步

    def _sync_views(self, src: ImageView):
        if self._syncing:
            return
        self._syncing = True
        try:
            t = src.transform()
            c = src.mapToScene(src.viewport().rect().center())
            for v in self.views.values():
                if v is src:
                    continue
                v.setTransform(t)
                v.centerOn(c)
        finally:
            self._syncing = False

    def _mode_changed(self):
        if not hasattr(self, "views"):  # 构建控制面板时单选按钮即触发
            return
        mode = self._mode()
        drag = (QGraphicsView.ScrollHandDrag if mode == "pan"
                else QGraphicsView.NoDrag)
        for v in self.views.values():
            v.setDragMode(drag)

    def _mode(self) -> str:
        for key, r in self.radio_mode.items():
            if r.isChecked():
                return key
        return "pan"

    # ------------------------------------------------------------ 鼠标交互

    def _view_pressed(self, x: float, y: float, button: int):
        if self.ref is None:
            return
        mode = self._mode()
        h, w = self.ref.shape[:2]
        if mode == "roi":
            if button == Qt.RightButton:
                idx = self._roi_at(x, y)
                if idx is not None:
                    del self.rois[idx]
                    self._after_roi_change()
            elif button == Qt.LeftButton:
                idx = self._roi_at(x, y)
                if idx is not None:
                    rx, ry = self.rois[idx][0], self.rois[idx][1]
                    self._moving = (idx, x - rx, y - ry)
                elif len(self.rois) < MAX_ROIS:
                    self._drawing = [x, y, x, y]
                else:
                    self.statusBar().showMessage(
                        f"最多 {MAX_ROIS} 个检查区,请先删除", 3000)
        elif mode == "marker" and button == Qt.LeftButton:
            if 0 <= x < w and 0 <= y < h:
                self.markers.append({"type": self.combo_marker.currentText(),
                                     "x": int(x), "y": int(y)})
                self._refresh_marker_list()
                self._refresh_overlays()

    def _view_moved(self, x: float, y: float):
        self._update_magnifier(x, y)
        if self.ref is None:
            return
        h, w = self.ref.shape[:2]
        if self._drawing is not None:
            self._drawing[2] = x
            self._drawing[3] = y
            self._refresh_overlays()
        elif self._moving is not None:
            idx, dx, dy = self._moving
            roi = self.rois[idx]
            nx = min(max(0, int(round(x - dx))), w - roi[2])
            ny = min(max(0, int(round(y - dy))), h - roi[3])
            roi[0], roi[1] = nx, ny
            self._refresh_overlays()
            self._refresh_roi_list()

    def _view_released(self, x: float, y: float, button: int):
        if self._drawing is not None:
            x0, y0, x1, y1 = self._drawing
            self._drawing = None
            rx, ry = min(x0, x1), min(y0, y1)
            rw, rh = abs(x1 - x0), abs(y1 - y0)
            if rw >= 2 and rh >= 2 and self.ref is not None:
                h, w = self.ref.shape[:2]
                rx = min(max(0, int(rx)), w - 2)
                ry = min(max(0, int(ry)), h - 2)
                rw = min(int(round(rw)), w - rx)
                rh = min(int(round(rh)), h - ry)
                self.rois.append([rx, ry, rw, rh])
                self._after_roi_change()
            else:
                self._refresh_overlays()
        if self._moving is not None:
            self._moving = None
            self._after_roi_change()

    def _roi_at(self, x: float, y: float):
        for i in range(len(self.rois) - 1, -1, -1):
            rx, ry, rw, rh = self.rois[i]
            if rx <= x < rx + rw and ry <= y < ry + rh:
                return i
        return None

    def _after_roi_change(self):
        self._refresh_roi_list()
        self._refresh_table()
        self._refresh_overlays()

    def _delete_selected_roi(self):
        row = self.list_rois.currentRow()
        if 0 <= row < len(self.rois):
            del self.rois[row]
            self._after_roi_change()

    def _delete_selected_marker(self):
        row = self.list_markers.currentRow()
        if 0 <= row < len(self.markers):
            del self.markers[row]
            self._refresh_marker_list()
            self._refresh_overlays()

    # ------------------------------------------------------------ 放大镜

    def _update_magnifier(self, x: float, y: float):
        if self.ref is None:
            return
        xi, yi = int(x), int(y)
        h, w = self.ref.shape[:2]
        if not (0 <= xi < w and 0 <= yi < h):
            return
        half = 10
        imgs = {"ref": self.ref, "heat": self.heat_img}
        for name in SET_NAMES:
            r = self.results.get(name)
            imgs[name] = r.decoded if r is not None else None
        for key, lab in self.mag_labels.items():
            arr = imgs.get(key)
            if arr is None:
                lab.setText("无数据")
                continue
            pad = ((half, half), (half, half), (0, 0))
            padded = np.pad(arr, pad, mode="edge")
            crop = padded[yi:yi + 2 * half + 1, xi:xi + 2 * half + 1]
            qi = np_to_qimage(crop).scaled(
                126, 126, Qt.IgnoreAspectRatio, Qt.FastTransformation)
            pm = QPixmap.fromImage(qi)
            p = QPainter(pm)
            p.setPen(QColor(255, 0, 0))
            cx = 126 // 2
            p.drawLine(cx, 0, cx, 125)
            p.drawLine(0, cx, 125, cx)
            p.end()
            lab.setPixmap(pm)
        parts = [f"({xi}, {yi})",
                 f"参考 {tuple(int(v) for v in self.ref[yi, xi])}"]
        for name in SET_NAMES:
            r = self.results.get(name)
            if r is not None:
                parts.append(f"{name} {tuple(int(v) for v in r.decoded[yi, xi])}")
        self.lbl_mag_info.setText(" · ".join(parts))

    # ------------------------------------------------------------ 指标表

    def _stat_rows(self) -> list[tuple[str, str, dict | None]]:
        """(区域名, 套, stats 或 None=失败/未编码)"""
        rows = []
        scopes = [("全图", None)]
        for i, (rx, ry, rw, rh) in enumerate(self.rois):
            scopes.append((f"选区{i + 1} ({rx},{ry} {rw}×{rh})", (rx, ry, rw, rh)))
        for label, rect in scopes:
            for name in SET_NAMES:
                res = self.results.get(name)
                if res is None:
                    rows.append((label, name, None))
                else:
                    rows.append((label, name,
                                 region_stats(self.ref, res.decoded, rect)))
        return rows

    def _refresh_table(self):
        if self.ref is None:
            return
        rows = self._stat_rows()
        self.table.setRowCount(len(rows))
        for r, (label, name, st) in enumerate(rows):
            if st is None:
                note = "编码失败" if self.errors.get(name) else "未编码"
                vals = [label, name, "—", "—", "—", "—", "—", note]
            else:
                vals = [label, name, f"{st['pixels']:,}",
                        f"{st['mae_r']:.4f}", f"{st['mae_g']:.4f}",
                        f"{st['mae_b']:.4f}", f"{st['mae']:.4f}",
                        fmt_psnr(st)]
            for c, text in enumerate(vals):
                self.table.setItem(r, c, QTableWidgetItem(text))

    # ------------------------------------------------------------ 网格统计

    def _compute_grid(self):
        if self.ref is None:
            return
        block = self.spin_block.value()
        self.grid_block_size = block
        worst = []
        checks = []
        for name in SET_NAMES:
            res = self.results.get(name)
            if res is None:
                self.grid_result[name] = None
                checks.append(f"{name}: 无数据")
                continue
            blocks = grid_stats(self.ref, res.decoded, block)
            self.grid_result[name] = blocks
            full = region_stats(self.ref, res.decoded)
            diff = abs(weighted_mae(blocks) - full["mae"])
            ok = "通过" if diff < 1e-9 else f"不符(差 {diff:.3e})"
            checks.append(f"{name} 加权校验 {ok}")
            for b in blocks:
                worst.append((b["mae"], name, b["rect"]))
        self.lbl_grid_check.setText(" · ".join(checks))
        worst.sort(key=lambda t: t[0], reverse=True)
        self._worst = worst[:10]
        self.list_worst.blockSignals(True)
        self.list_worst.clear()
        for mae, name, (x, y, w, h) in self._worst:
            self.list_worst.addItem(
                f"{name} 总MAE={mae:.3f} @ ({x},{y}) {w}×{h}")
        self.list_worst.blockSignals(False)

    def _goto_worst(self, row: int):
        if not (0 <= row < len(getattr(self, "_worst", []))):
            return
        _, _, rect = self._worst[row]
        self.grid_highlight = rect
        self._refresh_overlays()
        x, y, w, h = rect
        center = QPointF(x + w / 2, y + h / 2)
        self._syncing = True
        try:
            for v in self.views.values():
                v.centerOn(center)
        finally:
            self._syncing = False

    # ------------------------------------------------------------ 覆盖层

    def _refresh_overlays(self, *_):
        for view in self.views.values():
            for item in view.scene_.items():
                if item.zValue() > 0:
                    view.scene_.removeItem(item)
        if self.ref is None:
            return

        def add_rect(rect, color, dashed=False, z=10, width=0):
            x, y, w, h = rect
            pen = QPen(color)
            pen.setWidth(width)
            pen.setCosmetic(True)
            if dashed:
                pen.setStyle(Qt.DashLine)
            for view in self.views.values():
                it = QGraphicsRectItem(QRectF(x, y, w, h))
                it.setPen(pen)
                it.setZValue(z)
                view.scene_.addItem(it)

        def add_text(text, x, y, color, z=11):
            for view in self.views.values():
                t = QGraphicsSimpleTextItem(text)
                t.setPos(x, y)
                t.setBrush(QBrush(color))
                t.setZValue(z)
                t.setFlag(QGraphicsSimpleTextItem.ItemIgnoresTransformations)
                view.scene_.addItem(t)

        # 检查区
        for i, (x, y, w, h) in enumerate(self.rois):
            add_rect((x, y, w, h), QColor(0, 255, 0), width=2)
            add_text(f"R{i + 1}", x, y, QColor(0, 255, 0))
        # 正在拖出的选区
        if self._drawing is not None:
            x0, y0, x1, y1 = self._drawing
            add_rect((min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0)),
                     QColor(0, 255, 0, 120), dashed=True)
        # 网格定位高亮
        if self.grid_highlight is not None:
            add_rect(self.grid_highlight, QColor(255, 40, 40), width=2)
        # 标记
        for m in self.markers:
            color = MARKER_COLORS[m["type"]]
            for view in self.views.values():
                e = QGraphicsEllipseItem(m["x"] - 3, m["y"] - 3, 6, 6)
                e.setBrush(QBrush(color))
                e.setPen(QPen(Qt.NoPen))
                e.setZValue(12)
                view.scene_.addItem(e)
            add_text(m["type"], m["x"] + 5, m["y"] - 6, color, z=12)
        # JPEG 块网格线
        grid_opt = self.combo_grid_overlay.currentText()
        if grid_opt != "关":
            step = 8 if grid_opt == "8×8" else 16
            h, w = self.ref.shape[:2]
            pen = QPen(QColor(255, 255, 255, 90))
            pen.setCosmetic(True)
            for view in self.views.values():
                for gx in range(step, w, step):
                    line = view.scene_.addLine(gx, 0, gx, h, pen)
                    line.setZValue(5)
                for gy in range(step, h, step):
                    line = view.scene_.addLine(0, gy, w, gy, pen)
                    line.setZValue(5)

    def _refresh_roi_list(self):
        self.list_rois.clear()
        for i, (x, y, w, h) in enumerate(self.rois):
            self.list_rois.addItem(f"选区{i + 1}: ({x},{y}) {w}×{h}")

    def _refresh_marker_list(self):
        self.list_markers.clear()
        for m in self.markers:
            self.list_markers.addItem(f"{m['type']} @ ({m['x']},{m['y']})")

    # ------------------------------------------------------------ 导出

    def _export(self):
        if self.ref is None:
            return
        if all(r is None for r in self.results.values()):
            QMessageBox.warning(self, "无法导出", "两套编码都失败了,没有可导出的数据")
            return
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        settings = {}
        written = []
        for name in SET_NAMES:
            q = self.spin_q[name].value()
            sub = self.combo_sub[name].currentText()
            settings[name] = {"quality": q, "subsampling": sub}
            res = self.results.get(name)
            if res is None:
                continue
            tag = codec.SUBSAMPLING_TAG[sub]
            jpg = os.path.join(out_dir, f"jpeg_{name}_q{q}_{tag}.jpg")
            with open(jpg, "wb") as f:
                f.write(res.jpeg_bytes)
            written.append(jpg)

        h, w = self.ref.shape[:2]
        meta = {
            "reference": {"name": self.ref_name, "width": w, "height": h},
            "settings": settings,
            "rois": [{"name": f"选区{i + 1}", "x": x, "y": y, "w": rw, "h": rh}
                     for i, (x, y, rw, rh) in enumerate(self.rois)],
            "markers": list(self.markers),
        }
        meta_path = os.path.join(out_dir, "rois.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        written.append(meta_path)

        csv_path = os.path.join(out_dir, "metrics.csv")
        with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
            wr = csv.writer(f)
            wr.writerow(["区域", "套", "质量", "色度采样", "像素数",
                         "MAE_R", "MAE_G", "MAE_B", "总MAE", "PSNR_dB"])
            for label, name, st in self._stat_rows():
                if st is None:
                    wr.writerow([label, name, settings[name]["quality"],
                                 settings[name]["subsampling"],
                                 "", "", "", "", "", "编码失败"])
                else:
                    wr.writerow([label, name, settings[name]["quality"],
                                 settings[name]["subsampling"], st["pixels"],
                                 f"{st['mae_r']:.6f}", f"{st['mae_g']:.6f}",
                                 f"{st['mae_b']:.6f}", f"{st['mae']:.6f}",
                                 "inf" if st["identical"] else f"{st['psnr']:.4f}"])
            # 网格块统计(使用当前块边长)
            for name in SET_NAMES:
                res = self.results.get(name)
                if res is None:
                    continue
                for b in grid_stats(self.ref, res.decoded, self.grid_block_size):
                    x, y, bw, bh = b["rect"]
                    wr.writerow([f"网格块({x},{y} {bw}×{bh})", name,
                                 settings[name]["quality"],
                                 settings[name]["subsampling"], b["pixels"],
                                 f"{b['mae_r']:.6f}", f"{b['mae_g']:.6f}",
                                 f"{b['mae_b']:.6f}", f"{b['mae']:.6f}",
                                 "inf" if b["identical"] else f"{b['psnr']:.4f}"])
        written.append(csv_path)
        QMessageBox.information(self, "导出完成",
                                "已写出:\n" + "\n".join(written))


def main():
    app = QApplication([])
    win = MainWindow()
    win.show()
    app.exec()
