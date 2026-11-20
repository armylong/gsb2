"""PySide6 本地窗口:局部对比度调整实验台。

启动:
    python -m lce_lab.app
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PySide6.QtCore import Qt, QTimer, QPointF, QRectF
from PySide6.QtGui import (QBrush, QColor, QImage, QPainter, QPen,
                           QPixmap, QPolygonF)
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDoubleSpinBox,
                               QFileDialog, QFormLayout, QGroupBox,
                               QHBoxLayout, QLabel, QMainWindow, QMessageBox,
                               QPushButton, QRadioButton, QSlider, QSpinBox,
                               QSplitter, QVBoxLayout, QWidget)

from . import processing as P

VIEW_ORIGINAL = "原图"
VIEW_RESULT = "处理后"
VIEW_DIFF = "差异(x4)"
VIEW_MARKED = "标记叠加"


# ---------------------------------------------------------------------------
# 图像画布
# ---------------------------------------------------------------------------
class ImageCanvas(QWidget):
    """显示图像,支持画检查矩形与两段多边形遮罩。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(520, 400)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self._pix = None
        self._scale = 1.0
        self._draw_mode = "inspect"          # inspect | mask
        self._active_seg = 0
        self._draft = []                     # 正在绘制的多边形点
        self._segments = []                  # 与 Params.segments 共享引用
        self._inspect_rect = None            # 悬停检查块 (x,y,w,h)
        self._pinned_rect = None             # 固定检查块
        self._ref_rect = None
        self._show_masks = True
        self._show_markers = False
        self._marker_overlay = None
        self.set_segments([])

    # -- 数据 ---------------------------------------------------------------
    def set_image(self, bgr: np.ndarray):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        h, w, ch = rgb.shape
        qimg = QImage(rgb.data, w, h, ch * w, QImage.Format_RGB888).copy()
        old_size = self._pix.size() if self._pix is not None else None
        self._pix = QPixmap.fromImage(qimg)
        if old_size is None or old_size != self._pix.size():
            self._fit()
        self.update()

    def set_marker_overlay(self, bgr: np.ndarray | None):
        if bgr is None:
            self._marker_overlay = None
        else:
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            h, w, ch = rgb.shape
            qimg = QImage(rgb.data, w, h, ch * w, QImage.Format_RGB888).copy()
            self._marker_overlay = QPixmap.fromImage(qimg)
        self.update()

    def set_segments(self, segments):
        self._segments = segments
        self._draft = []
        self.update()

    def set_draw_mode(self, mode: str):
        self._draw_mode = mode
        self._draft = []
        self.setCursor(Qt.CrossCursor if mode == "mask" else Qt.ArrowCursor)
        self.update()

    def set_active_segment(self, idx: int):
        self._active_seg = idx

    def set_show_masks(self, on: bool):
        self._show_masks = on
        self.update()

    def set_show_markers(self, on: bool):
        self._show_markers = on
        self.update()

    def set_reference_rect(self, rect):
        self._ref_rect = rect
        self.update()

    def pinned_rect(self):
        return self._pinned_rect

    def clear_pinned(self):
        self._pinned_rect = None
        self.update()

    def reset_view(self):
        self._fit()

    # -- 坐标 ---------------------------------------------------------------
    def _fit(self):
        if self._pix is None:
            return
        self._scale = min(self.width() / self._pix.width(),
                          self.height() / self._pix.height(), 4.0)
        self.update()

    def _origin(self) -> QPointF:
        if self._pix is None:
            return QPointF(0, 0)
        w = self._pix.width() * self._scale
        h = self._pix.height() * self._scale
        return QPointF((self.width() - w) / 2.0, (self.height() - h) / 2.0)

    def _to_image(self, pos: QPointF):
        o = self._origin()
        x = int((pos.x() - o.x()) / self._scale)
        y = int((pos.y() - o.y()) / self._scale)
        if self._pix is None:
            return None
        if not (0 <= x < self._pix.width() and 0 <= y < self._pix.height()):
            return None
        return x, y

    # -- 绘制 ---------------------------------------------------------------
    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 30, 32))
        if self._pix is None:
            p.setPen(QColor(180, 180, 180))
            p.drawText(self.rect(), Qt.AlignCenter, "载入图片或生成内置样例")
            return
        o = self._origin()
        pix = self._marker_overlay if (self._show_markers and self._marker_overlay) else self._pix
        p.drawPixmap(o, pix.scaled(self._pix.size() * self._scale,
                                   Qt.KeepAspectRatio, Qt.SmoothTransformation))
        p.setTransform(self._img_transform())
        if self._show_masks:
            self._paint_masks(p)
        self._paint_rects(p)
        if self._draft:
            self._paint_polygon(p, self._draft, QColor(255, 255, 255), closed=False)

    def _img_transform(self):
        from PySide6.QtGui import QTransform
        o = self._origin()
        t = QTransform()
        t.translate(o.x(), o.y())
        t.scale(self._scale, self._scale)
        return t

    def _paint_masks(self, p: QPainter):
        for i, seg in enumerate(self._segments):
            if len(seg.points) < 3:
                continue
            col = QColor(*seg.color_rgb)
            fill = QColor(col); fill.setAlpha(46)
            p.setBrush(QBrush(fill))
            pen = QPen(col, 1.5 / self._scale)
            p.setPen(pen)
            p.drawPolygon(QPolygonF([QPointF(x, y) for x, y in seg.points]))
            p.setPen(QPen(QColor(255, 255, 255), 1.0 / self._scale))
            for j, (x, y) in enumerate(seg.points):
                p.drawEllipse(QPointF(x, y), 2.2 / self._scale, 2.2 / self._scale)
            cx = float(np.mean([pt[0] for pt in seg.points]))
            cy = float(np.mean([pt[1] for pt in seg.points]))
            p.setPen(col)
            f = p.font(); f.setPointSizeF(max(7.0, 8.0 / self._scale)); p.setFont(f)
            p.drawText(QPointF(cx, cy), seg.name)

    def _paint_polygon(self, p, points, col, closed=True):
        pen = QPen(col, 1.5 / self._scale, Qt.DashLine)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        poly = QPolygonF([QPointF(x, y) for x, y in points])
        if closed:
            p.drawPolygon(poly)
        else:
            p.drawPolyline(poly)

    def _paint_rects(self, p: QPainter):
        def draw(rect, col, label):
            if rect is None:
                return
            x, y, w, h = rect
            pen = QPen(col, 1.4 / self._scale)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            p.drawRect(QRectF(x, y, w, h))
            f = p.font(); f.setPointSizeF(max(7.0, 8.0 / self._scale)); p.setFont(f)
            p.drawText(QPointF(x, max(0, y - 3)), label)
        draw(self._inspect_rect, QColor(0, 230, 230), "检查")
        draw(self._pinned_rect, QColor(255, 255, 120), "固定块")
        draw(self._ref_rect, QColor(120, 255, 120), "噪声参照(锁定)")

    def resizeEvent(self, event):
        self._fit()

    def wheelEvent(self, event):
        if self._pix is None:
            return
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self._scale = float(np.clip(self._scale * factor, 0.05, 40.0))
        self.update()

    # -- 鼠标 ---------------------------------------------------------------
    def mouseMoveEvent(self, event):
        if self._pix is None or self._draw_mode != "inspect":
            return
        pt = self._to_image(event.position())
        if pt is None:
            self._inspect_rect = None
        else:
            s = self.inspect_size
            x = int(np.clip(pt[0] - s // 2, 0, self._pix.width() - s))
            y = int(np.clip(pt[1] - s // 2, 0, self._pix.height() - s))
            s2 = min(s, self._pix.width(), self._pix.height())
            self._inspect_rect = (x, y, s2, s2)
        self.update()
        self.parent_main and self.parent_main.on_inspect_moved(self._inspect_rect)

    def mousePressEvent(self, event):
        if self._pix is None:
            return
        pt = self._to_image(event.position())
        if pt is None:
            return
        if self._draw_mode == "mask":
            if event.button() == Qt.LeftButton:
                self._draft.append(pt)
                self.update()
            elif event.button() == Qt.RightButton and self._draft:
                self._draft = []
                self.update()
            return
        if event.button() == Qt.LeftButton:
            if self._inspect_rect:
                self._pinned_rect = self._inspect_rect
                self.update()
                self.parent_main and self.parent_main.on_inspect_pinned(self._pinned_rect)

    def mouseDoubleClickEvent(self, event):
        if self._draw_mode == "mask" and len(self._draft) >= 3:
            seg = self._segments[self._active_seg]
            seg.points = list(self._draft)
            self._draft = []
            self.update()
            self.parent_main and self.parent_main.on_mask_finished(self._active_seg)

    inspect_size = 32
    parent_main = None


# ---------------------------------------------------------------------------
# 直方图控件
# ---------------------------------------------------------------------------
class HistogramView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(170)
        self._before = None
        self._after = None
        self._title = "L 通道分布(32 bins)"

    def set_data(self, before: np.ndarray, after: np.ndarray, title: str):
        self._before = before
        self._after = after
        self._title = title
        self.update()

    def clear(self):
        self._before = self._after = None
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(245, 245, 247))
        p.setPen(QColor(40, 40, 40))
        f = p.font(); f.setBold(True); p.setFont(f)
        p.drawText(10, 16, self._title)
        if self._before is None:
            p.setPen(QColor(120, 120, 120))
            p.drawText(self.rect(), Qt.AlignCenter, "在图像上选择检查块后显示分布")
            return
        x0, y0, w, h = 34, 28, self.width() - 46, self.height() - 48
        p.setPen(QPen(QColor(200, 200, 200), 1))
        p.drawRect(x0, y0, w, h)
        maxv = max(float(self._before.max()), float(self._after.max()), 1e-9)

        def curve(data, col, fill_col):
            n = len(data)
            pts = [QPointF(x0, y0 + h)]
            for i, v in enumerate(data):
                x = x0 + w * (i + 0.5) / n
                y = y0 + h * (1 - v / maxv)
                pts.append(QPointF(x, y))
            pts.append(QPointF(x0 + w, y0 + h))
            p.setPen(QPen(col, 2))
            p.setBrush(QBrush(fill_col))
            p.drawPolygon(QPolygonF(pts))

        fb = QColor(120, 120, 130, 70)
        fa = QColor(220, 90, 40, 80)
        curve(self._before, QColor(90, 90, 100), fb)
        curve(self._after, QColor(210, 70, 30), fa)
        p.setPen(QColor(90, 90, 100))
        p.drawText(x0 + 4, y0 + 14, "灰:调整前")
        p.setPen(QColor(210, 70, 30))
        p.drawText(x0 + 90, y0 + 14, "橙:调整后")
        p.setPen(QColor(80, 80, 80))
        p.drawText(x0, y0 + h + 14, "暗 0")
        p.drawText(x0 + w - 36, y0 + h + 14, "亮 255")


# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("局部对比度实验台 (CLAHE / 全局均衡)")
        self.resize(1280, 840)

        self.image: np.ndarray | None = None
        self.params = P.Params()
        self.result: P.ProcessResult | None = None
        self.reference_rect = None
        self.reference_id = None
        self._last_inspect_rect = None
        self._rebuild_timer = QTimer(self)
        self._rebuild_timer.setSingleShot(True)
        self._rebuild_timer.timeout.connect(self._rebuild)

        self.canvas = ImageCanvas()
        self.canvas.parent_main = self
        self.hist = HistogramView()
        self._build_ui()
        self._new_image(P.make_sample("blocks"), reset_ref=True)

    # -- UI 构建 ------------------------------------------------------------
    def _build_ui(self):
        central = QSplitter(Qt.Horizontal)
        left = QWidget()
        lv = QVBoxLayout(left)
        lv.addWidget(self.canvas, 1)
        lv.addWidget(self.hist)
        central.addWidget(left)

        panel = QWidget()
        panel.setFixedWidth(330)
        pv = QVBoxLayout(panel)

        # 输入
        g_in = QGroupBox("1. 输入")
        f_in = QVBoxLayout(g_in)
        row = QHBoxLayout()
        b_load = QPushButton("载入图片…")
        b_load.clicked.connect(self.load_image)
        row.addWidget(b_load)
        self.cmb_sample = QComboBox()
        self.cmb_sample.addItems(["blocks 明暗块+纹理", "edge 渐变交界",
                                  "extreme 32x24 极小图", "color 彩边样例"])
        self.cmb_sample.currentIndexChanged.connect(self.gen_sample)
        row.addWidget(self.cmb_sample)
        f_in.addLayout(row)
        self.lbl_id = QLabel()
        self.lbl_id.setWordWrap(True)
        self.lbl_id.setStyleSheet("color:#666;")
        f_in.addWidget(self.lbl_id)
        pv.addWidget(g_in)

        # 模式
        g_mode = QGroupBox("2. 处理模式")
        fm = QVBoxLayout(g_mode)
        self.rb_global = QRadioButton("整张图 · 全局直方图均衡")
        self.rb_full = QRadioButton("整张图 · 局部 CLAHE")
        self.rb_mask = QRadioButton("局部范围 · 两段遮罩(各自限制参数)")
        self.rb_full.setChecked(True)
        for rb in (self.rb_global, self.rb_full, self.rb_mask):
            fm.addWidget(rb)
            rb.toggled.connect(self._on_mode)
        pv.addWidget(g_mode)

        # 通用 CLAHE 参数
        self.g_common = QGroupBox("3. 对比限制参数(整图模式)")
        fc = QFormLayout(self.g_common)
        self.sld_clip, self.spn_clip = self._linked_dspin(0.0, 40.0, 0.1, 3.0, fc, "对比上限 clip")
        self.sld_tile, self.spn_tile = self._linked_ispin(2, 256, 32, fc, "区域大小 tile(px)")
        self.sld_strength, self.spn_strength = self._linked_dspin(0.0, 1.0, 0.01, 1.0, fc, "处理强度")
        pv.addWidget(self.g_common)

        # 遮罩段参数
        self.g_mask = QGroupBox("4. 局部遮罩与分段限制")
        mv = QVBoxLayout(self.g_mask)
        self.cmb_seg = QComboBox()
        self.cmb_seg.addItems(["段 1", "段 2"])
        self.cmb_seg.currentIndexChanged.connect(self._on_seg_selected)
        mv.addWidget(self.cmb_seg)
        fm2 = QFormLayout()
        self.sld_mclip, self.spn_mclip = self._linked_dspin(0.0, 40.0, 0.1, 3.0, fm2, "本段 clip")
        self.sld_mtile, self.spn_mtile = self._linked_ispin(2, 256, 32, fm2, "本段 tile(px)")
        self.sld_mstr, self.spn_mstr = self._linked_dspin(0.0, 1.0, 0.01, 1.0, fm2, "本段强度")
        mv.addLayout(fm2)
        mrow = QHBoxLayout()
        b_draw = QPushButton("画遮罩(双击结束)")
        b_draw.clicked.connect(lambda: self.canvas.set_draw_mode("mask"))
        b_inspect = QPushButton("切回检查模式")
        b_inspect.clicked.connect(lambda: self.canvas.set_draw_mode("inspect"))
        mrow.addWidget(b_draw); mrow.addWidget(b_inspect)
        mv.addLayout(mrow)
        mrow2 = QHBoxLayout()
        b_clear = QPushButton("清空本段")
        b_clear.clicked.connect(self.clear_segment)
        mrow2.addWidget(b_clear)
        b_clear_all = QPushButton("清空两段")
        b_clear_all.clicked.connect(self.clear_all_segments)
        mrow2.addWidget(b_clear_all)
        mv.addLayout(mrow2)
        fm3 = QFormLayout()
        self.sld_feather, self.spn_feather = self._linked_ispin(0, 80, 12, fm3, "羽化宽度(px)")
        mv.addLayout(fm3)
        self.chk_masks = QCheckBox("显示遮罩")
        self.chk_masks.setChecked(True)
        self.chk_masks.toggled.connect(self.canvas.set_show_masks)
        mv.addWidget(self.chk_masks)
        pv.addWidget(self.g_mask)

        # 噪声参照
        g_ref = QGroupBox("5. 低纹理噪声参照")
        rv = QVBoxLayout(g_ref)
        self.lbl_ref = QLabel("未锁定。检查模式下在平坦处左键固定一块,再锁定。")
        self.lbl_ref.setWordWrap(True)
        rv.addWidget(self.lbl_ref)
        rrow = QHBoxLayout()
        b_lock = QPushButton("锁定固定块为参照")
        b_lock.clicked.connect(self.lock_reference)
        b_unlock = QPushButton("解除锁定")
        b_unlock.clicked.connect(self.unlock_reference)
        rrow.addWidget(b_lock); rrow.addWidget(b_unlock)
        rv.addLayout(rrow)
        fm4 = QFormLayout()
        self.spn_inspect = QSpinBox()
        self.spn_inspect.setRange(4, 256)
        self.spn_inspect.setValue(32)
        self.spn_inspect.valueChanged.connect(self._on_inspect_size)
        fm4.addRow("检查块边长(px)", self.spn_inspect)
        rv.addLayout(fm4)
        pv.addWidget(g_ref)

        # 显示与输出
        g_view = QGroupBox("6. 显示 / 输出")
        vv = QVBoxLayout(g_view)
        self.cmb_view = QComboBox()
        self.cmb_view.addItems([VIEW_RESULT, VIEW_ORIGINAL, VIEW_DIFF, VIEW_MARKED])
        self.cmb_view.currentTextChanged.connect(self._update_view)
        vv.addWidget(self.cmb_view)
        self.chk_markers = QCheckBox("叠加标记:红=新增饱和裁切, 蓝=彩边")
        self.chk_markers.toggled.connect(self._on_markers)
        vv.addWidget(self.chk_markers)
        self.lbl_stats = QLabel("实测对比:—")
        self.lbl_stats.setWordWrap(True)
        vv.addWidget(self.lbl_stats)
        orow = QHBoxLayout()
        b_export = QPushButton("导出处理图 PNG")
        b_export.clicked.connect(self.export_png)
        b_save = QPushButton("保存项目…")
        b_save.clicked.connect(self.save_project)
        b_open = QPushButton("恢复项目…")
        b_open.clicked.connect(self.open_project)
        orow.addWidget(b_export); orow.addWidget(b_save); orow.addWidget(b_open)
        vv.addLayout(orow)
        b_selftest_hint = QLabel("无头验证:python -m lce_lab.selftest --out out")
        b_selftest_hint.setStyleSheet("color:#777;")
        vv.addWidget(b_selftest_hint)
        pv.addWidget(g_view)
        pv.addStretch(1)

        central.addWidget(panel)
        central.setStretchFactor(0, 1)
        self.setCentralWidget(central)

        self.statusBar().showMessage("就绪")

    def _linked_dspin(self, lo, hi, step, val, form, label):
        sld = QSlider(Qt.Horizontal)
        sld.setRange(int(lo * 100), int(hi * 100))
        spn = QDoubleSpinBox()
        spn.setRange(lo, hi); spn.setSingleStep(step); spn.setValue(val)
        sld.setValue(int(val * 100))
        sld.valueChanged.connect(lambda v: spn.setValue(v / 100.0))
        spn.valueChanged.connect(lambda v: sld.setValue(int(round(v * 100))))
        spn.valueChanged.connect(self._schedule_rebuild)
        form.addRow(label, self._with_slider(sld, spn))
        return sld, spn

    def _linked_ispin(self, lo, hi, val, form, label):
        sld = QSlider(Qt.Horizontal)
        sld.setRange(lo, hi)
        spn = QSpinBox()
        spn.setRange(lo, hi); spn.setValue(val)
        sld.setValue(val)
        sld.valueChanged.connect(spn.setValue)
        spn.valueChanged.connect(sld.setValue)
        spn.valueChanged.connect(self._schedule_rebuild)
        form.addRow(label, self._with_slider(sld, spn))
        return sld, spn

    @staticmethod
    def _with_slider(sld, spn):
        w = QWidget()
        lay = QHBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(sld, 1); lay.addWidget(spn)
        spn.setFixedWidth(78)
        return w

    # -- 图像输入 -----------------------------------------------------------
    def load_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择图像", "", "图像 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        try:
            data = np.fromfile(path, dtype=np.uint8)
            img = cv2.imdecode(data, cv2.IMREAD_COLOR)
            if img is None:
                raise ValueError("解码失败")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "载入失败", str(exc))
            return
        self._new_image(img, reset_ref=True)
        self.statusBar().showMessage(f"已载入 {Path(path).name}")

    def gen_sample(self):
        kinds = ["blocks", "edge", "extreme", "color"]
        self._new_image(P.make_sample(kinds[self.cmb_sample.currentIndex()]), reset_ref=True)

    def _new_image(self, img: np.ndarray, reset_ref: bool):
        self.image = img
        self.lbl_id.setText(f"输入指纹: {P.image_id(img)}  尺寸: {img.shape[1]}x{img.shape[0]}")
        self.canvas.set_image(img)
        if reset_ref:
            self.unlock_reference(silent=True)
        self.canvas.clear_pinned()
        self.hist.clear()
        self._rebuild()

    # -- 模式与参数 ---------------------------------------------------------
    def _on_mode(self):
        if self.rb_global.isChecked():
            self.params.mode = "global"
        elif self.rb_full.isChecked():
            self.params.mode = "local_full"
        else:
            self.params.mode = "local_mask"
        self.g_common.setVisible(self.params.mode != "local_mask")
        self.g_mask.setVisible(self.params.mode == "local_mask")
        self.canvas.set_draw_mode("inspect")
        self._rebuild()

    def _on_seg_selected(self, idx):
        self.canvas.set_active_segment(idx)
        seg = self.params.segments[idx]
        self._block_signals(True)
        self.spn_mclip.setValue(seg.clip_limit)
        self.spn_mtile.setValue(seg.tile_size)
        self.spn_mstr.setValue(seg.strength)
        self._block_signals(False)

    def _block_signals(self, on: bool):
        for w in (self.spn_mclip, self.spn_mtile, self.spn_mstr):
            w.blockSignals(on)

    def _schedule_rebuild(self, *_):
        self._sync_params_from_widgets()
        self._rebuild_timer.start(180)

    def _sync_params_from_widgets(self):
        p = self.params
        p.clip_limit = self.spn_clip.value()
        p.tile_size = self.spn_tile.value()
        p.strength = self.spn_strength.value()
        p.feather = self.spn_feather.value()
        if p.segments:
            seg = p.segments[self.cmb_seg.currentIndex()]
            seg.clip_limit = self.spn_mclip.value()
            seg.tile_size = self.spn_mtile.value()
            seg.strength = self.spn_mstr.value()

    def clear_segment(self):
        seg = self.params.segments[self.cmb_seg.currentIndex()]
        seg.points = []
        self.canvas.update()
        self._rebuild()

    def clear_all_segments(self):
        for s in self.params.segments:
            s.points = []
        self.canvas.update()
        self._rebuild()

    def on_mask_finished(self, idx):
        self.canvas.set_draw_mode("inspect")
        self.statusBar().showMessage(f"段 {idx + 1} 遮罩已记录({len(self.params.segments[idx].points)} 点)")
        self._rebuild()

    def _on_markers(self, on):
        self.canvas.set_show_markers(on)
        self._update_view()

    def _on_inspect_size(self, val: int):
        self.canvas.inspect_size = int(val)

    # -- 检查块与参照 -------------------------------------------------------
    def on_inspect_moved(self, rect):
        self._last_inspect_rect = rect
        if rect and self.result is not None:
            self._show_stats(rect, pinned=False)

    def on_inspect_pinned(self, rect):
        self._last_inspect_rect = rect
        if rect and self.result is not None:
            self._show_stats(rect, pinned=True)
            self._update_hist(rect)

    def lock_reference(self):
        rect = self.canvas.pinned_rect() or self._last_inspect_rect
        if rect is None:
            self.statusBar().showMessage("请先在检查模式下左键固定一个检查块,再锁定参照。")
            return
        self.reference_rect = rect
        self.reference_id = P.image_id(self.image)
        self.canvas.set_reference_rect(rect)
        self.lbl_ref.setText(
            f"已锁定参照块 {rect}(输入 {self.reference_id})。切换图片后自动失效。")
        self._rebuild()

    def unlock_reference(self, silent=False):
        self.reference_rect = None
        self.reference_id = None
        self.canvas.set_reference_rect(None)
        if not silent:
            self.lbl_ref.setText("未锁定。")
            self._rebuild()

    def _show_stats(self, rect, pinned):
        bs = P.block_stats(self.image, self.result.image, rect)
        txt = (f"检查块 {rect}\n"
               f"L 均值 {bs.l_mean_before:.1f} → {bs.l_mean_after:.1f}\n"
               f"L 标准差(≈对比/噪声) {bs.l_std_before:.2f} → {bs.l_std_after:.2f}\n"
               f"实测对比变化 {bs.contrast_change:+.1f}%   噪声增益 x{bs.noise_gain:.2f}")
        if self.reference_rect is not None:
            br = P.block_stats(self.image, self.result.image, self.reference_rect)
            warn = ""
            if br.noise_gain > 1.15:
                warn = "  ⚠ 平坦参照噪声已被明显放大"
            txt += ("\n— 噪声参照(锁定) —\n"
                    f"参照 std {br.l_std_before:.2f} → {br.l_std_after:.2f}, "
                    f"增益 x{br.noise_gain:.2f}, 对比变化 {br.contrast_change:+.1f}%{warn}")
        self.lbl_stats.setText(txt)

    def _update_hist(self, rect):
        h0 = P.luma_histogram(self.image, rect)
        h1 = P.luma_histogram(self.result.image, rect)
        self.hist.set_data(h0, h1, f"L 通道分布 · 块 {rect}")

    # -- 处理管线 -----------------------------------------------------------
    def _rebuild(self):
        if self.image is None:
            return
        self._sync_params_from_widgets()
        # 参照有效性:切换图片后指纹不符即失效
        if self.reference_id is not None and self.reference_id != P.image_id(self.image):
            self.unlock_reference(silent=True)
            self.statusBar().showMessage("输入已变化,噪声参照失效")
        self.canvas.set_segments(self.params.segments)
        self.result = P.process(self.image, self.params)
        self.canvas.set_marker_overlay(self.result.markers)
        self._update_view()
        pinned = self.canvas.pinned_rect()
        if pinned:
            self._show_stats(pinned, pinned=True)
            self._update_hist(pinned)
        elif self.reference_rect:
            self._show_stats(self.reference_rect, pinned=False)

    def _update_view(self):
        if self.result is None or self.image is None:
            return
        mode = self.cmb_view.currentText()
        show_markers = self.chk_markers.isChecked() or mode == VIEW_MARKED
        self.canvas.set_show_markers(show_markers)
        if mode == VIEW_MARKED:
            self.canvas.set_marker_overlay(self.result.markers)
            return
        if mode == VIEW_ORIGINAL:
            base = self.image
        elif mode == VIEW_DIFF:
            d = cv2.absdiff(self.image, self.result.image)
            base = np.clip(d.astype(np.uint16) * 4, 0, 255).astype(np.uint8)
        else:
            base = self.result.image
        self.canvas.set_image(base)
        if show_markers:
            # 标记始终叠加在"处理后"图像上,不改变明暗
            self.canvas.set_marker_overlay(self.result.markers)

    # -- 项目与导出 ---------------------------------------------------------
    def export_png(self):
        if self.result is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出处理图", "processed.png", "PNG (*.png)")
        if not path:
            return
        # 与预览完全相同的参数重新跑一遍,保证可复验
        out = P.process(self.image, self.params).image
        with open(path, "wb") as f:
            f.write(P.encode_png(out))
        self.statusBar().showMessage(f"已导出 {path}(参数与预览一致)")

    def save_project(self):
        path, _ = QFileDialog.getSaveFileName(self, "保存项目", "project.lceproj", "LCE 项目 (*.lceproj)")
        if not path:
            return
        in_id = P.save_project(path, self.image, self.params, self.reference_rect)
        self.statusBar().showMessage(f"项目已保存 {path}(输入 {in_id})")

    def open_project(self):
        path, _ = QFileDialog.getOpenFileName(self, "恢复项目", "", "LCE 项目 (*.lceproj)")
        if not path:
            return
        try:
            bgr, params, rect, in_id = P.load_project(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "恢复失败", str(exc))
            return
        self.image = bgr
        self.params = params
        self.reference_rect = rect
        self.reference_id = P.image_id(bgr) if rect else None
        self.canvas.set_reference_rect(rect)
        self.lbl_ref.setText(
            f"已随项目恢复参照块 {rect}" if rect else "未锁定。")
        self._apply_widgets_from_params()
        self.cmb_sample.blockSignals(True)
        self._new_image(bgr, reset_ref=False)
        self.cmb_sample.blockSignals(False)
        # 复验:同输入同参数导出一致
        again = P.process(bgr, params).image
        same = P.encode_png(again) == P.encode_png(P.process(bgr, params).image)
        self.statusBar().showMessage(
            f"已恢复项目 {Path(path).name};复验导出确定性: {'一致' if same else '不一致'}")

    def _apply_widgets_from_params(self):
        p = self.params
        self._block_signals(True)
        self.spn_clip.setValue(p.clip_limit)
        self.spn_tile.setValue(p.tile_size)
        self.spn_strength.setValue(p.strength)
        self.spn_feather.setValue(p.feather)
        if p.segments:
            s0 = p.segments[0]
            self.spn_mclip.setValue(s0.clip_limit)
            self.spn_mtile.setValue(s0.tile_size)
            self.spn_mstr.setValue(s0.strength)
        self._block_signals(False)
        self.rb_global.setChecked(p.mode == "global")
        self.rb_full.setChecked(p.mode == "local_full")
        self.rb_mask.setChecked(p.mode == "local_mask")
        self.cmb_seg.setCurrentIndex(0)
        self.canvas.set_segments(p.segments)


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
