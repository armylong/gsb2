"""PySide6 界面: 左源图 / 右展平图, 引导点编辑, 联动定位, 导出与格纸核对。"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import cv2
from PySide6.QtCore import Qt, QTimer, QPointF, QRectF, Signal
from PySide6.QtGui import (QImage, QPixmap, QPainter, QPen, QColor, QBrush,
                           QTransform, QPolygonF, QFont)
from PySide6.QtWidgets import (QApplication, QMainWindow, QWidget, QSplitter,
                               QDockWidget, QVBoxLayout, QHBoxLayout, QPushButton,
                               QLabel, QListWidget, QSpinBox, QCheckBox,
                               QRadioButton, QButtonGroup, QFileDialog, QMessageBox,
                               QGroupBox)

from .core import FlattenField
from .gridcheck import run_grid_check

CURVE_COLORS = [QColor(230, 60, 60), QColor(60, 130, 230), QColor(40, 180, 90),
                QColor(220, 150, 30), QColor(160, 70, 200), QColor(0, 170, 170),
                QColor(220, 90, 160), QColor(120, 120, 60)]


def to_qpixmap(img):
    if img is None:
        return QPixmap()
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    else:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w = img.shape[:2]
    qimg = QImage(img.data, w, h, 3 * w, QImage.Format_RGB888).copy()
    return QPixmap.fromImage(qimg)


# ---------------------------------------------------------------- 视图基类

class ImageView(QWidget):
    hovered = Signal(float, float)   # 图像坐标
    pinned = Signal(float, float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(320, 240)
        self.setMouseTracking(True)
        self.pix = QPixmap()
        self.crosshair = None        # 图像坐标, 由另一侧联动设置
        self.pin = None
        self._scale = 1.0
        self._dx = 0.0
        self._dy = 0.0

    def set_image(self, img):
        self.pix = to_qpixmap(img)
        self.update()

    # 坐标变换 --------------------------------------------------------
    def _fit(self):
        if self.pix.isNull():
            return
        s = min(self.width() / self.pix.width(),
                self.height() / self.pix.height()) * 0.98
        self._scale = s
        self._dx = (self.width() - self.pix.width() * s) / 2
        self._dy = (self.height() - self.pix.height() * s) / 2

    def view_to_img(self, pos):
        return ((pos.x() - self._dx) / self._scale,
                (pos.y() - self._dy) / self._scale)

    def img_to_view(self, x, y):
        return (x * self._scale + self._dx, y * self._scale + self._dy)

    def _xform(self):
        return QTransform().translate(self._dx, self._dy).scale(self._scale, self._scale)

    # 事件 ------------------------------------------------------------
    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(45, 45, 48))
        if self.pix.isNull():
            p.setPen(QColor(200, 200, 200))
            p.drawText(self.rect(), Qt.AlignCenter, self.hint_text())
            p.end()
            return
        self._fit()
        p.setTransform(self._xform())
        p.setRenderHint(QPainter.SmoothPixmapTransform)
        p.drawPixmap(0, 0, self.pix)
        self.draw_overlay(p)
        self._draw_mark(p, self.crosshair, QColor(255, 255, 0), 10)
        self._draw_mark(p, self.pin, QColor(0, 255, 255), 14)
        p.end()

    def _draw_mark(self, p, pos, color, size):
        if pos is None:
            return
        r = size / self._scale
        pen = QPen(color)
        pen.setCosmetic(True)
        pen.setWidth(2)
        p.setPen(pen)
        p.drawLine(QPointF(pos[0] - r, pos[1]), QPointF(pos[0] + r, pos[1]))
        p.drawLine(QPointF(pos[0], pos[1] - r), QPointF(pos[0], pos[1] + r))

    def hint_text(self):
        return ""

    def draw_overlay(self, p):
        pass

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton and e.modifiers() & Qt.ShiftModifier:
            self.pinned.emit(*self.view_to_img(e.position()))
            return
        self.on_mouse_press(e)

    def mouseMoveEvent(self, e):
        self.on_mouse_move(e)
        self.hovered.emit(*self.view_to_img(e.position()))

    def mouseReleaseEvent(self, e):
        self.on_mouse_release(e)

    def on_mouse_press(self, e):
        pass

    def on_mouse_move(self, e):
        pass

    def on_mouse_release(self, e):
        pass


# ---------------------------------------------------------------- 源图视图

class SourceView(ImageView):
    changed = Signal()          # 点/角被拖动或增删, 需要重算
    selection_changed = Signal()

    def __init__(self, win):
        super().__init__()
        self.win = win
        self._drag = None       # ('quad', idx) 或 ('curve', ci, pi)

    def hint_text(self):
        return "打开图片后: 先点 4 个页角, 再沿弯曲文字行点引导点"

    # -- 绘制 --
    def draw_overlay(self, p):
        win = self.win
        s = self._scale
        # 外推区域阴影(页边没有引导的部分)
        if win.field and len(win.quad) == 4 and win.field.n_curves:
            self._draw_extrap(p, win)
        # 页面四边形
        pen = QPen(QColor(255, 200, 0)); pen.setCosmetic(True); pen.setWidth(2)
        p.setPen(pen)
        q = win.quad
        if len(q) >= 2:
            for i in range(len(q) - 1):
                p.drawLine(QPointF(*q[i]), QPointF(*q[i + 1]))
        if len(q) == 4:
            p.drawLine(QPointF(*q[3]), QPointF(*q[0]))
        for pt in q:
            p.setBrush(QBrush(QColor(255, 200, 0)))
            p.drawEllipse(QPointF(*pt), 6 / s, 6 / s)
        # 引导曲线
        font = QFont(); font.setPointSize(max(9, int(12 / s)))
        p.setFont(font)
        for ci, curve in enumerate(win.curves):
            used = len(curve) >= 2
            color = CURVE_COLORS[ci % len(CURVE_COLORS)] if used else QColor(150, 150, 150)
            pen = QPen(color); pen.setCosmetic(True); pen.setWidth(3 if ci == win.active_curve else 2)
            if not used:
                pen.setStyle(Qt.DashLine)
            p.setPen(pen)
            # 实际使用的曲线画样条折线, 未使用的画点间虚线
            if used and win.field and ci in win.field_curve_index:
                    poly = win.field.polylines_src[win.field_curve_index[ci]]
                    qpoly = QPolygonF([QPointF(x, y) for x, y in poly])
                    p.drawPolyline(qpoly)
            else:
                for i in range(len(curve) - 1):
                    p.drawLine(QPointF(*curve[i]), QPointF(*curve[i + 1]))
            for pi, pt in enumerate(curve):
                sel = (ci == win.active_curve and pi == win.selected_point)
                p.setBrush(QBrush(QColor(255, 255, 255) if sel else color))
                r = (7 if sel else 5) / s
                p.setPen(QPen(color)); p.drawEllipse(QPointF(*pt), r, r)
                if pi == 0:
                    p.setPen(color)
                    p.drawText(QPointF(pt[0] + 8 / s, pt[1] - 8 / s), f"曲线{ci + 1}")
        # 相交/接触警告
        if win.field:
            pen = QPen(QColor(255, 0, 0)); pen.setCosmetic(True); pen.setWidth(3)
            p.setPen(pen); p.setBrush(Qt.NoBrush)
            for (x, y, *_rest) in win.crossings_src:
                p.drawEllipse(QPointF(x, y), 14 / s, 14 / s)
                p.drawLine(QPointF(x - 20 / s, y), QPointF(x + 20 / s, y))

    def _draw_extrap(self, p, win):
        """页边没有引导线覆盖的区域(源图侧)画半透明阴影。"""
        f = win.field
        W, H = f.out_w, f.out_h
        xs = np.linspace(0, W - 1, 60)
        cols = np.clip(np.round(xs).astype(int), 0, W - 1)
        brush = QBrush(QColor(255, 80, 80, 45))
        p.setBrush(brush)
        pen = QPen(QColor(255, 80, 80, 120)); pen.setCosmetic(True)
        pen.setStyle(Qt.DashLine); p.setPen(pen)
        for band in ("top", "bottom"):
            edge_y = 0 if band == "top" else H - 1
            curve_y = f.src_ys[0] if band == "top" else f.src_ys[-1]
            poly_w = [(0.0, float(edge_y)), (float(W - 1), float(edge_y))]
            poly_w += [(float(xs[k]), float(curve_y[cols[k]])) for k in range(len(xs) - 1, -1, -1)]
            poly_src = f._to_src(np.array(poly_w))
            p.drawPolygon(QPolygonF([QPointF(x, y) for x, y in poly_src]))

    # -- 鼠标 --
    def _nearest_handle(self, x, y):
        tol = 12 / self._scale
        win = self.win
        best = None
        if win.mode == "quad":
            for i, pt in enumerate(win.quad):
                d = np.hypot(pt[0] - x, pt[1] - y)
                if d < tol:
                    return ("quad", i)
        else:
            for ci, curve in enumerate(win.curves):
                for pi, pt in enumerate(curve):
                    d = np.hypot(pt[0] - x, pt[1] - y)
                    if d < tol and (best is None or d < best[0]):
                        best = (d, ci, pi)
            if best:
                return ("curve", best[1], best[2])
        return None

    def on_mouse_press(self, e):
        if e.button() == Qt.RightButton:
            self._delete_nearest(e)
            return
        if e.button() != Qt.LeftButton:
            return
        x, y = self.view_to_img(e.position())
        win = self.win
        hit = self._nearest_handle(x, y)
        if hit:
            self._drag = hit
            if hit[0] == "curve":
                win.active_curve = hit[1]
                win.selected_point = hit[2]
                self.selection_changed.emit()
            return
        if win.mode == "quad":
            if len(win.quad) < 4:
                win.quad.append((x, y))
                win.on_quad_maybe_complete()
                self.changed.emit()
        else:
            if not win.curves:
                win.curves.append([])
                win.active_curve = 0
            win.curves[win.active_curve].append((x, y))
            win.selected_point = len(win.curves[win.active_curve]) - 1
            self.changed.emit()
            self.selection_changed.emit()

    def _delete_nearest(self, e):
        x, y = self.view_to_img(e.position())
        hit = self._nearest_handle(x, y)
        win = self.win
        if not hit:
            return
        if hit[0] == "quad":
            win.quad.pop(hit[1])
        else:
            _, ci, pi = hit
            win.curves[ci].pop(pi)
            win.selected_point = None
        self.changed.emit()
        self.selection_changed.emit()

    def on_mouse_move(self, e):
        if not self._drag or not (e.buttons() & Qt.LeftButton):
            return
        x, y = self.view_to_img(e.position())
        win = self.win
        if self._drag[0] == "quad":
            win.quad[self._drag[1]] = (x, y)
        else:
            _, ci, pi = self._drag
            win.curves[ci][pi] = (x, y)
        self.changed.emit()

    def on_mouse_release(self, e):
        self._drag = None


# ---------------------------------------------------------------- 输出视图

class OutputView(ImageView):
    def __init__(self, win):
        super().__init__()
        self.win = win

    def hint_text(self):
        return "展平结果 (选完页角并画至少一条引导线后显示)"

    def draw_overlay(self, p):
        win = self.win
        f = win.field
        if not f or not f.n_curves:
            return
        s = self._scale
        # 外推区域
        y0, y1 = f.extrapolated_rows()
        p.setBrush(QBrush(QColor(255, 80, 80, 40)))
        p.setPen(Qt.NoPen)
        p.drawRect(QRectF(0, 0, f.out_w, y0))
        p.drawRect(QRectF(0, y1, f.out_w, f.out_h - y1))
        # 目标水平线
        for k, y in enumerate(f.dst_ys):
            ci = win.field_user_index.get(int(f.order[k]), int(f.order[k]))
            color = CURVE_COLORS[ci % len(CURVE_COLORS)]
            pen = QPen(color); pen.setCosmetic(True); pen.setWidth(2)
            pen.setStyle(Qt.DashLine)
            p.setPen(pen)
            p.drawLine(QPointF(0, y), QPointF(f.out_w, y))
            p.drawText(QPointF(6 / s, y - 5 / s), f"曲线{ci + 1}")


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("书页展平工具")
        self.resize(1500, 950)
        self.img = None
        self.img_path = None
        self.quad = []              # [(x,y)] 最多4个
        self.curves = []            # [[(x,y),...],...]
        self.active_curve = -1
        self.selected_point = None
        self.mode = "quad"
        self.field = None
        self.field_curve_index = {}  # 用户曲线号 -> field 内序号
        self.field_user_index = {}   # field 内序号 -> 用户曲线号
        self.crossings_src = []
        self.flat_img = None

        self.src_view = SourceView(self)
        self.out_view = OutputView(self)
        splitter = QSplitter()
        splitter.addWidget(self.src_view)
        splitter.addWidget(self.out_view)
        splitter.setSizes([750, 750])
        self.setCentralWidget(splitter)
        self._build_panel()

        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.recompute)

        self.src_view.changed.connect(self.schedule_recompute)
        self.src_view.selection_changed.connect(self.refresh_lists)
        self.src_view.hovered.connect(self.on_src_hover)
        self.out_view.hovered.connect(self.on_out_hover)
        self.src_view.pinned.connect(self.on_src_pin)
        self.out_view.pinned.connect(self.on_out_pin)
        self.statusBar().showMessage("打开图片开始")

    # ---------------- 面板 ----------------
    def _build_panel(self):
        dock = QDockWidget("控制", self)
        dock.setFeatures(QDockWidget.DockWidgetMovable)
        w = QWidget()
        v = QVBoxLayout(w)

        row = QHBoxLayout()
        for text, fn in [("打开图片", self.open_image),
                         ("保存项目", self.save_project),
                         ("载入项目", self.load_project)]:
            b = QPushButton(text); b.clicked.connect(fn); row.addWidget(b)
        v.addLayout(row)
        row = QHBoxLayout()
        for text, fn in [("导出展平图", self.export_flat),
                         ("格纸核对", self.grid_check)]:
            b = QPushButton(text); b.clicked.connect(fn); row.addWidget(b)
        v.addLayout(row)

        g = QGroupBox("编辑模式")
        h = QHBoxLayout(g)
        self.rb_quad = QRadioButton("页角点"); self.rb_curve = QRadioButton("引导点")
        self.rb_quad.setChecked(True)
        grp = QButtonGroup(self); grp.addButton(self.rb_quad); grp.addButton(self.rb_curve)
        self.rb_quad.toggled.connect(lambda on: on and self._set_mode("quad"))
        self.rb_curve.toggled.connect(lambda on: on and self._set_mode("curve"))
        h.addWidget(self.rb_quad); h.addWidget(self.rb_curve)
        v.addWidget(g)

        g = QGroupBox("引导曲线 (右键删点, 拖动移点)")
        cv = QVBoxLayout(g)
        self.curve_list = QListWidget()
        self.curve_list.currentRowChanged.connect(self.on_curve_selected)
        cv.addWidget(self.curve_list)
        row = QHBoxLayout()
        for text, fn in [("新建曲线", self.add_curve),
                         ("删除曲线", self.del_curve)]:
            b = QPushButton(text); b.clicked.connect(fn); row.addWidget(b)
        cv.addLayout(row)
        self.point_list = QListWidget()
        self.point_list.currentRowChanged.connect(self.on_point_selected)
        cv.addWidget(self.point_list)
        row = QHBoxLayout()
        for text, fn in [("点上移", lambda: self.move_point(-1)),
                         ("点下移", lambda: self.move_point(1)),
                         ("删除点", self.del_point)]:
            b = QPushButton(text); b.clicked.connect(fn); row.addWidget(b)
        cv.addLayout(row)
        v.addWidget(g)

        g = QGroupBox("输出")
        ov = QVBoxLayout(g)
        row = QHBoxLayout()
        row.addWidget(QLabel("宽"))
        self.sp_w = QSpinBox(); self.sp_w.setRange(200, 8000); self.sp_w.setValue(1400)
        self.sp_h = QSpinBox(); self.sp_h.setRange(200, 8000); self.sp_h.setValue(1000)
        row.addWidget(self.sp_w); row.addWidget(QLabel("高")); row.addWidget(self.sp_h)
        ov.addLayout(row)
        self.sp_w.valueChanged.connect(self.schedule_recompute)
        self.sp_h.valueChanged.connect(self.schedule_recompute)
        self.chk_lock = QCheckBox("锁定左右对应位置 (Shift+点击钉住标记)")
        self.chk_lock.setChecked(True)
        ov.addWidget(self.chk_lock)
        v.addWidget(g)

        self.lbl_cross = QLabel("引导线相交检测: -")
        self.lbl_cross.setWordWrap(True)
        self.lbl_cross.setStyleSheet("color: #c0392b")
        v.addWidget(self.lbl_cross)
        v.addStretch(1)
        dock.setWidget(w)
        self.addDockWidget(Qt.RightDockWidgetArea, dock)

    # ---------------- 状态与重算 ----------------
    def _set_mode(self, mode):
        self.mode = mode

    def on_quad_maybe_complete(self):
        if len(self.quad) == 4:
            q = np.array(self.quad)
            w = (np.hypot(*(q[1] - q[0])) + np.hypot(*(q[2] - q[3]))) / 2
            h = (np.hypot(*(q[3] - q[0])) + np.hypot(*(q[2] - q[1]))) / 2
            self.sp_w.setValue(max(200, int(w)))
            self.sp_h.setValue(max(200, int(h)))
            self.rb_curve.setChecked(True)

    def schedule_recompute(self):
        self._timer.start(200)

    def recompute(self):
        if self.img is None or len(self.quad) != 4:
            self.src_view.update()
            return
        used = [c for c in self.curves if len(c) >= 2]
        self.field_curve_index = {}
        k = 0
        for ci, c in enumerate(self.curves):
            if len(c) >= 2:
                self.field_curve_index[ci] = k
                k += 1
        # field 内部序号 -> 用户曲线号 (用于标注)
        self.field_user_index = {v: k_ for k_, v in self.field_curve_index.items()}
        self.field = FlattenField(self.quad, used,
                                  self.sp_w.value(), self.sp_h.value())
        self.flat_img = self.field.flatten(self.img)
        self.out_view.set_image(self.flat_img)
        # 相交检测 (工作坐标 -> 源图坐标)
        crossings = self.field.find_crossings()
        self.crossings_src = []
        msgs = []
        for (x, y, i, j, kind) in crossings:
            src = self.field._to_src(np.array([[x, y]]))[0]
            self.crossings_src.append((src[0], src[1], i, j, kind))
            ui = self.field_user_index.get(i, i) + 1
            uj = self.field_user_index.get(j, j) + 1
            label = "相交(会折叠!)" if kind == "cross" else "过近"
            msgs.append(f"曲线{ui}与曲线{uj}在输出 x={x:.0f} 处{label}")
        if msgs:
            self.lbl_cross.setText("⚠ " + "\n".join(msgs[:6]))
        else:
            self.lbl_cross.setText("引导线相交检测: 正常")
        self.refresh_lists()
        self.src_view.update()
        self.out_view.update()

    # ---------------- 联动 ----------------
    def on_src_hover(self, x, y):
        if not self.chk_lock.isChecked() or not self.field:
            return
        out = self.field.map_src_to_out(np.array([[x, y]]))[0]
        self.out_view.crosshair = out
        self.out_view.update()
        self.statusBar().showMessage(
            f"源 ({x:.0f},{y:.0f}) -> 输出 ({out[0]:.0f},{out[1]:.0f})")

    def on_out_hover(self, x, y):
        if not self.chk_lock.isChecked() or not self.field:
            return
        src = self.field.map_out_to_src(np.array([[x, y]]))[0]
        self.src_view.crosshair = src
        self.src_view.update()
        self.statusBar().showMessage(
            f"输出 ({x:.0f},{y:.0f}) -> 源取样 ({src[0]:.0f},{src[1]:.0f})")

    def on_src_pin(self, x, y):
        self.src_view.pin = (x, y)
        if self.field:
            self.out_view.pin = tuple(self.field.map_src_to_out(np.array([[x, y]]))[0])
        self.src_view.update(); self.out_view.update()

    def on_out_pin(self, x, y):
        self.out_view.pin = (x, y)
        if self.field:
            self.src_view.pin = tuple(self.field.map_out_to_src(np.array([[x, y]]))[0])
        self.src_view.update(); self.out_view.update()

    # ---------------- 列表 ----------------
    def refresh_lists(self):
        self.curve_list.blockSignals(True)
        self.curve_list.clear()
        for ci, c in enumerate(self.curves):
            mark = "✓使用" if len(c) >= 2 else "×(不足2点)"
            self.curve_list.addItem(f"曲线{ci + 1}  {len(c)}点  {mark}")
        if 0 <= self.active_curve < len(self.curves):
            self.curve_list.setCurrentRow(self.active_curve)
        self.curve_list.blockSignals(False)
        self.refresh_point_list()

    def refresh_point_list(self):
        self.point_list.blockSignals(True)
        self.point_list.clear()
        if 0 <= self.active_curve < len(self.curves):
            for pi, (x, y) in enumerate(self.curves[self.active_curve]):
                self.point_list.addItem(f"{pi + 1}: ({x:.0f}, {y:.0f})")
            if self.selected_point is not None and \
                    self.selected_point < self.point_list.count():
                self.point_list.setCurrentRow(self.selected_point)
        self.point_list.blockSignals(False)

    def on_curve_selected(self, row):
        if row >= 0:
            self.active_curve = row
            self.selected_point = None
            self.refresh_point_list()
            self.src_view.update()

    def on_point_selected(self, row):
        self.selected_point = row if row >= 0 else None
        self.src_view.update()

    def add_curve(self):
        self.curves.append([])
        self.active_curve = len(self.curves) - 1
        self.selected_point = None
        self.refresh_lists()

    def del_curve(self):
        if 0 <= self.active_curve < len(self.curves):
            self.curves.pop(self.active_curve)
            self.active_curve = min(self.active_curve, len(self.curves) - 1)
            self.selected_point = None
            self.refresh_lists()
            self.schedule_recompute()

    def move_point(self, delta):
        ci, pi = self.active_curve, self.selected_point
        if not (0 <= ci < len(self.curves)) or pi is None:
            return
        c = self.curves[ci]
        ni = pi + delta
        if 0 <= ni < len(c):
            c[pi], c[ni] = c[ni], c[pi]
            self.selected_point = ni
            self.refresh_lists()
            self.schedule_recompute()

    def del_point(self):
        ci, pi = self.active_curve, self.selected_point
        if 0 <= ci < len(self.curves) and pi is not None and pi < len(self.curves[ci]):
            self.curves[ci].pop(pi)
            self.selected_point = None
            self.refresh_lists()
            self.schedule_recompute()

    # ---------------- 文件 ----------------
    def open_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开照片", "", "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            QMessageBox.warning(self, "错误", "无法读取图片")
            return
        self.img = img
        self.img_path = path
        self.quad = []
        self.curves = []
        self.active_curve = -1
        self.selected_point = None
        self.field = None
        self.flat_img = None
        self.rb_quad.setChecked(True)
        self.src_view.set_image(img)
        self.out_view.set_image(None)
        self.refresh_lists()
        self.statusBar().showMessage(f"已打开 {path} — 请按 左上/右上/右下/左下 点 4 个页角")

    def _project_dict(self):
        return {"image": self.img_path,
                "quad": [[float(x), float(y)] for x, y in self.quad],
                "curves": [[[float(x), float(y)] for x, y in c] for c in self.curves],
                "out_size": [self.sp_w.value(), self.sp_h.value()]}

    def save_project(self):
        if self.img is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "保存项目", "", "项目 (*.json)")
        if not path:
            return
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self._project_dict(), f, ensure_ascii=False, indent=1)
        self.statusBar().showMessage(f"项目已保存: {path}")

    def load_project(self):
        path, _ = QFileDialog.getOpenFileName(self, "载入项目", "", "项目 (*.json)")
        if not path:
            return
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        img_path = d.get("image")
        if img_path and not os.path.isabs(img_path):
            img_path = os.path.join(os.path.dirname(path), img_path)
        img = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR) \
            if img_path and os.path.exists(img_path) else None
        if img is None:
            QMessageBox.warning(self, "错误", f"找不到项目引用的图片: {img_path}")
            return
        self.img = img
        self.img_path = img_path
        self.quad = [tuple(p) for p in d.get("quad", [])]
        self.curves = [[tuple(p) for p in c] for c in d.get("curves", [])]
        self.active_curve = len(self.curves) - 1
        self.selected_point = None
        if d.get("out_size"):
            self.sp_w.setValue(int(d["out_size"][0]))
            self.sp_h.setValue(int(d["out_size"][1]))
        self.src_view.set_image(img)
        self.refresh_lists()
        self.recompute()

    def export_flat(self):
        if self.field is None or self.flat_img is None:
            QMessageBox.information(self, "提示", "请先完成页角选择和引导线")
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出展平图", "", "PNG (*.png)")
        if not path:
            return
        cv2.imencode(".png", self.flat_img)[1].tofile(path)
        sidecar = os.path.splitext(path)[0] + "_guides.json"
        with open(sidecar, "w", encoding="utf-8") as f:
            json.dump(self._project_dict(), f, ensure_ascii=False, indent=1)
        self.statusBar().showMessage(f"已导出 {path} , 引导点存于 {sidecar}")

    def grid_check(self):
        if self.field is None or not self.field.n_curves:
            QMessageBox.information(self, "提示", "请先完成页角选择和引导线")
            return
        out_dir = QFileDialog.getExistingDirectory(self, "选择格纸输出目录")
        if not out_dir:
            return
        report = run_grid_check(self.field, self.img.shape, out_dir)
        QMessageBox.information(self, "格纸核对", report)


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
