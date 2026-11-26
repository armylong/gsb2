#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""圆罐标签局部展开工具.

用法:
    python can_unwrap.py              启动 GUI
    python can_unwrap.py --selftest   无界面自检(生成样例 -> 展开 -> 导出 -> 载回)

模型: 用三条线描述竖直或轻微倾斜的圆罐 —— 一条中心线(轴线)和左右两条罐身边界线.
每条线由上下两个控制点定义, x 随 y 线性变化. 展开时输出图每一列对应一个固定的
圆柱角度 theta, 采样位置 x = xc(y) + r(y)*sin(theta), 因此正中与靠边按弧长(角度)
等分, 而不是按原图像素等分.
"""
from __future__ import annotations

import json
import math
import os
import sys

import cv2
import numpy as np
from PySide6.QtCore import QPointF, Qt, QTimer
from PySide6.QtGui import QAction, QColor, QImage, QPainter, QPen
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

# ---------------------------------------------------------------- 几何模型

LINE_NAMES = ("left", "center", "right")
LINE_COLORS = {
    "left": QColor(255, 170, 0),
    "center": QColor(0, 220, 120),
    "right": QColor(255, 170, 0),
}
LINE_TITLES = {"left": "左边界", "center": "中心线", "right": "右边界"}


class CylinderModel:
    """三条竖线, 每条由 (x1,y1)-(x2,y2) 两点定义, x 随 y 线性插值/外推."""

    def __init__(self, w: int, h: int):
        self.pts = {
            "left": [(0.32 * w, 0.05 * h), (0.32 * w, 0.95 * h)],
            "center": [(0.50 * w, 0.05 * h), (0.50 * w, 0.95 * h)],
            "right": [(0.68 * w, 0.05 * h), (0.68 * w, 0.95 * h)],
        }

    def x_of(self, name: str, y):
        (x1, y1), (x2, y2) = self.pts[name]
        t = (y - y1) / max(y2 - y1, 1e-6)
        return x1 + t * (x2 - x1)

    def xc(self, y):
        return self.x_of("center", y)

    def xl(self, y):
        return self.x_of("left", y)

    def xr(self, y):
        return self.x_of("right", y)

    def radius(self, y):
        return 0.5 * (self.xr(y) - self.xl(y))

    def to_json(self, w: int, h: int) -> dict:
        return {
            name: [[p[0] / w, p[1] / h] for p in self.pts[name]] for name in LINE_NAMES
        }

    @classmethod
    def from_json(cls, data: dict, w: int, h: int) -> "CylinderModel":
        m = cls(w, h)
        for name in LINE_NAMES:
            if name in data:
                m.pts[name] = [(p[0] * w, p[1] * h) for p in data[name]]
        return m


def unwrap_cylinder(img: np.ndarray, model: CylinderModel, theta_max_deg: float,
                    out_w: int):
    """按角度展开可见罐面.

    返回 (flat, valid, sparse, thetas):
      flat   BGR 展开图, 高 = 原图高, 宽 = out_w
      valid  bool 掩膜, True = 该输出像素落在罐身边界内且在原图范围内
      sparse bool 掩膜, True = 有效但原图像素密度不足(被拉伸, 越靠侧面越多)
      thetas 每列对应的角度(度)
    """
    h, w = img.shape[:2]
    out_h = h
    out_w = max(int(out_w), 8)
    ys = np.arange(out_h, dtype=np.float64)
    xc = model.xc(ys)
    xl = model.xl(ys)
    xr = model.xr(ys)
    r = 0.5 * (xr - xl)
    r_safe = np.maximum(r, 1e-3)

    th = math.radians(theta_max_deg)
    thetas = np.linspace(-th, th, out_w)
    sin_t = np.sin(thetas)
    cos_t = np.cos(thetas)

    map_x = (xc[:, None] + r_safe[:, None] * sin_t[None, :]).astype(np.float32)
    map_y = np.repeat(ys[:, None].astype(np.float32), out_w, axis=1)
    flat = cv2.remap(img, map_x, map_y, cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=(40, 40, 40))

    valid = (
        (r > 0)[:, None]
        & (map_x >= xl[:, None])
        & (map_x <= xr[:, None])
        & (map_x >= 0)
        & (map_x <= w - 1)
    )
    # 每个输出像素摊到的原图像素数: r*cos(theta)*dtheta.
    # 与正中(cos=1)对比: 不足一半即视为"越靠侧面越缺像素"的拉伸区
    dtheta = (thetas[1] - thetas[0]) if out_w > 1 else 2 * th
    density = r_safe[:, None] * cos_t[None, :] * dtheta
    center_density = np.maximum(r_safe * dtheta, 1e-9)
    sparse = valid & (density < 0.5 * center_density[:, None])
    return flat, valid, sparse, np.degrees(thetas)


def compute_warnings(img_shape, model: CylinderModel, theta_max_deg: float,
                     valid: np.ndarray, out_w: int) -> list[str]:
    h, w = img_shape[:2]
    warns: list[str] = []
    ys = np.arange(h, dtype=np.float64)
    xl = model.xl(ys)
    xr = model.xr(ys)
    r = 0.5 * (xr - xl)

    bad = xl >= xr
    if bad.any():
        warns.append(f"左右边界相交或标反(约 {bad.mean() * 100:.0f}% 高度)")

    if np.median(r) > 0:
        rv = float(np.ptp(r) / np.median(r))
        if rv > 0.3:
            warns.append(f"边界不可信: 半径沿高度变化 {rv * 100:.0f}% (>30%)")
    else:
        warns.append("边界不可信: 半径非正")

    if theta_max_deg > 90:
        warns.append("最大角度超过 ±90°, 已超出可见半球")

    # 输出分辨率超过原图(正中处每输出像素摊不到 1 个原图像素)时整体为插值放大
    th = math.radians(theta_max_deg)
    center_density = float(np.median(r) * (2 * th / max(out_w, 1))) if r.size else 0.0
    if 0 < center_density < 1.0 and np.median(r) > 0:
        warns.append("输出宽度偏大: 正中处已不足 1 原图像素/输出像素, 整体为插值放大")

    if valid is not None and valid.size:
        covered = float(valid.mean())
        if covered < 0.999:
            warns.append(f"展开区 {100 * (1 - covered):.1f}% 无原图覆盖(超出罐身或原图)")
    return warns


# ---------------------------------------------------------------- 样例生成

def make_grid_texture(tw: int = 1800, th: int = 1000) -> np.ndarray:
    """角度等距网格纹理: 正中竖线、靠边棋盘格、带行号的水平线(高度对照)."""
    tex = np.full((th, tw, 3), 245, np.uint8)

    def tx(deg: float) -> int:
        return int(round((deg + 90.0) / 180.0 * (tw - 1)))

    # 靠边棋盘格 (±60°~±90°, 5° x 50px 一格)
    for deg0 in range(60, 90, 5):
        for sign in (-1, 1):
            x0, x1 = sorted((tx(sign * deg0), tx(sign * (deg0 + 5))))
            for y0 in range(0, th, 50):
                if (deg0 // 5 + y0 // 50) % 2 == 0:
                    cv2.rectangle(tex, (x0, y0), (x1, min(y0 + 50, th - 1)),
                                  (200, 220, 255), -1)
    # 竖线每 10°, 正中红色加粗
    for deg in range(-90, 91, 10):
        x = tx(deg)
        if deg == 0:
            color, thick = (0, 0, 220), 4
        elif deg % 30 == 0:
            color, thick = (120, 120, 120), 2
        else:
            color, thick = (190, 190, 190), 1
        cv2.line(tex, (x, 0), (x, th - 1), color, thick)
        cv2.putText(tex, f"{deg:+d}", (x + 3, 28), cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, (30, 30, 30), 1, cv2.LINE_AA)
    # 水平线每 100px, 带行号(高度对照)
    for y in range(0, th, 100):
        cv2.line(tex, (0, y), (tw - 1, y), (170, 170, 170), 1)
        cv2.putText(tex, f"y={y}", (tw // 2 + 6, y + 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (30, 30, 200), 1, cv2.LINE_AA)
    cv2.putText(tex, "CAN LABEL SAMPLE", (tw // 2 - 260, th // 2),
                cv2.FONT_HERSHEY_SIMPLEX, 1.8, (60, 60, 60), 3, cv2.LINE_AA)
    return tex


def render_sample(kind: str = "straight", w: int = 800, h: int = 1000):
    """把网格纹理按圆柱投影渲染成"照片", 返回 (img, model, theta_limit_deg)."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    r_val = 0.24 * w
    if kind == "tilted":
        xc = 0.5 * w + 0.12 * (yy - h / 2)  # 轴线倾斜
        r = np.full_like(yy, r_val)
    elif kind == "shaded":
        xc = np.full_like(yy, 0.5 * w)
        r = np.full_like(yy, r_val)
    else:  # straight
        xc = np.full_like(yy, 0.5 * w)
        r = np.full_like(yy, r_val)

    theta_lim = math.radians(88)
    s = (xx - xc) / r
    inside = np.abs(s) <= math.sin(theta_lim)
    theta = np.arcsin(np.clip(s, -1.0, 1.0))

    tex = make_grid_texture()
    th_, tw_ = tex.shape[:2]
    map_x = ((theta + math.pi / 2) / math.pi * (tw_ - 1)).astype(np.float32)
    map_y = (yy / max(h - 1, 1) * (th_ - 1)).astype(np.float32)
    img = cv2.remap(tex, map_x, map_y, cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_CONSTANT, borderValue=0)

    # 圆柱明暗: 越靠边越暗
    power = 0.6 if kind == "shaded" else 0.35
    shade = 0.35 + 0.65 * np.cos(theta) ** power
    img = np.clip(img.astype(np.float32) * shade[..., None], 0, 255).astype(np.uint8)

    img[~inside] = (70, 70, 78)  # 背景(桌面)
    cv2.line(img, (0, h - 40), (w - 1, h - 40), (90, 90, 100), 2)

    model = CylinderModel(w, h)
    for name, off in (("left", -r_val), ("center", 0.0), ("right", r_val)):
        pts = []
        for y in (0.05 * h, 0.95 * h):
            cx = 0.5 * w + (0.12 * (y - h / 2) if kind == "tilted" else 0.0)
            pts.append((cx + off, y))
        model.pts[name] = pts
    return img, model, math.degrees(theta_lim)


# ---------------------------------------------------------------- 视图部件

def np_to_qimage(bgr: np.ndarray) -> QImage:
    bgr = np.ascontiguousarray(bgr)
    h, w = bgr.shape[:2]
    return QImage(bgr.data, w, h, w * 3, QImage.Format_BGR888).copy()


class ImageView(QWidget):
    """等比缩放显示图像, 支持 overlay 绘制与鼠标回调(图像坐标)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(280, 280)
        self._qimg: QImage | None = None
        self._overlay = None  # callable(QPainter) 在图像坐标系下绘制
        self._scale = 1.0
        self._ox = 0.0
        self._oy = 0.0
        self.on_press = None
        self.on_move = None
        self.on_release = None

    def set_image(self, qimg: QImage | None):
        self._qimg = qimg
        self.update()

    def set_overlay(self, fn):
        self._overlay = fn
        self.update()

    def _fit(self):
        iw, ih = self._qimg.width(), self._qimg.height()
        vw, vh = max(self.width(), 1), max(self.height(), 1)
        self._scale = min(vw / iw, vh / ih)
        self._ox = (vw - iw * self._scale) / 2
        self._oy = (vh - ih * self._scale) / 2

    def view_to_image(self, pos: QPointF) -> QPointF:
        return QPointF((pos.x() - self._ox) / self._scale,
                       (pos.y() - self._oy) / self._scale)

    def image_tol(self, view_px: float) -> float:
        return view_px / max(self._scale, 1e-6)

    def paintEvent(self, _event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(35, 35, 38))
        if self._qimg is not None:
            self._fit()
            p.save()
            p.translate(self._ox, self._oy)
            p.scale(self._scale, self._scale)
            p.drawImage(0, 0, self._qimg)
            if self._overlay is not None:
                self._overlay(p)
            p.restore()
        p.end()

    def mousePressEvent(self, e):
        if self._qimg is not None and e.button() == Qt.LeftButton and self.on_press:
            self.on_press(self.view_to_image(e.position()))

    def mouseMoveEvent(self, e):
        if self._qimg is not None and (e.buttons() & Qt.LeftButton) and self.on_move:
            self.on_move(self.view_to_image(e.position()))

    def mouseReleaseEvent(self, e):
        if self._qimg is not None and e.button() == Qt.LeftButton and self.on_release:
            self.on_release(self.view_to_image(e.position()))


def _cosmetic(color: QColor, width: int = 2, style=Qt.SolidLine) -> QPen:
    pen = QPen(color, width, style)
    pen.setCosmetic(True)
    return pen


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("圆罐标签展开")
        self.resize(1280, 760)

        self.cv_img: np.ndarray | None = None
        self.image_desc = ""  # 路径或 generated:kind
        self.model: CylinderModel | None = None
        self.flat = self.valid = self.sparse = self.thetas = None
        self.marker = None  # ("point", theta_deg, yfrac) / ("vline", theta_deg)
        self._drag = None   # ("point", name, idx) / ("shift", name, last_pos)

        self._build_ui()
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(150)
        self._timer.timeout.connect(self.recompute)

        self.load_sample("straight")

    # ---------------- UI
    def _build_ui(self):
        self.orig_view = ImageView()
        self.flat_view = ImageView()
        self.orig_view.set_overlay(self._draw_orig_overlay)
        self.flat_view.set_overlay(self._draw_flat_overlay)
        self.orig_view.on_press = self._orig_press
        self.orig_view.on_move = self._orig_move
        self.orig_view.on_release = self._orig_release
        self.flat_view.on_press = self._flat_press
        self.flat_view.on_move = self._flat_press  # 拖动即移动标记

        splitter = QSplitter()
        left = QVBoxLayout()
        left.addWidget(QLabel("原图 (拖动圆点/线体调整三条标线)"))
        left.addWidget(self.orig_view)
        lw = QWidget(); lw.setLayout(left)
        right = QVBoxLayout()
        right.addWidget(QLabel("展开图 (点击放置标记; 灰底=无覆盖, 红纹=像素不足)"))
        right.addWidget(self.flat_view)
        rw = QWidget(); rw.setLayout(right)
        splitter.addWidget(lw)
        splitter.addWidget(rw)
        splitter.setSizes([640, 640])

        btn_open = QPushButton("打开图片…")
        btn_open.clicked.connect(self.open_image)
        btn_sample = QPushButton("生成样例")
        menu = QMenu(self)
        for kind, title in (("straight", "直罐网格(正中竖线/靠边格子)"),
                            ("tilted", "倾斜罐网格(高度对照)"),
                            ("shaded", "直罐+明暗")):
            act = QAction(title, self)
            act.triggered.connect(lambda _=False, k=kind: self.load_sample(k))
            menu.addAction(act)
        btn_sample.setMenu(menu)

        self.spin_angle = QDoubleSpinBox()
        self.spin_angle.setRange(5.0, 120.0)
        self.spin_angle.setValue(60.0)
        self.spin_angle.setSuffix(" °")
        self.spin_angle.valueChanged.connect(self._params_changed)
        self.spin_width = QSpinBox()
        self.spin_width.setRange(200, 8000)
        self.spin_width.setSingleStep(100)
        self.spin_width.setValue(1200)
        self.spin_width.valueChanged.connect(self._params_changed)

        self.combo_marker = QComboBox()
        self.combo_marker.addItems(["点标记", "竖线标记"])
        btn_clear = QPushButton("清除标记")
        btn_clear.clicked.connect(self.clear_marker)
        self.chk_sparse = QCheckBox("标出像素不足区")
        self.chk_sparse.setChecked(True)
        self.chk_sparse.toggled.connect(lambda _=None: self.recompute())

        btn_export = QPushButton("导出…")
        btn_export.clicked.connect(self.export_all)
        btn_load = QPushButton("载入参数…")
        btn_load.clicked.connect(self.load_params)

        bar = QHBoxLayout()
        for wdt in (btn_open, btn_sample, QLabel("最大角度:"), self.spin_angle,
                    QLabel("输出宽度:"), self.spin_width, self.combo_marker,
                    btn_clear, self.chk_sparse, btn_export, btn_load):
            bar.addWidget(wdt)
        bar.addStretch(1)

        self.warn_label = QLabel("")
        self.warn_label.setStyleSheet("color: #ff6666; font-weight: bold;")
        self.warn_label.setWordWrap(True)

        root = QVBoxLayout()
        root.addLayout(bar)
        root.addWidget(splitter, 1)
        root.addWidget(self.warn_label)
        cw = QWidget()
        cw.setLayout(root)
        self.setCentralWidget(cw)

    # ---------------- 图像装载
    def set_image(self, img: np.ndarray, model: CylinderModel, desc: str):
        self.cv_img = img
        self.model = model
        self.image_desc = desc
        self.marker = None
        self.orig_view.set_image(np_to_qimage(img))
        self.recompute()

    def open_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开罐身正面图", "", "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            QMessageBox.warning(self, "打开失败", f"无法读取: {path}")
            return
        h, w = img.shape[:2]
        self.set_image(img, CylinderModel(w, h), os.path.abspath(path))

    def load_sample(self, kind: str):
        img, model, _lim = render_sample(kind)
        self.set_image(img, model, f"generated:{kind}")

    # ---------------- 参数/展开
    @property
    def theta_max(self) -> float:
        return float(self.spin_angle.value())

    @property
    def out_width(self) -> int:
        return int(self.spin_width.value())

    def _params_changed(self, *_):
        self.recompute()

    def recompute(self):
        if self.cv_img is None or self.model is None:
            return
        self.flat, self.valid, self.sparse, self.thetas = unwrap_cylinder(
            self.cv_img, self.model, self.theta_max, self.out_width)

        disp = self.flat.copy()
        disp[~self.valid] = (50, 50, 55)  # 无覆盖区域不画到标签上
        if self.chk_sparse.isChecked() and self.sparse.any():
            over = disp[self.sparse]
            disp[self.sparse] = (0.4 * over + 0.6 * np.array([0, 0, 255])).astype(np.uint8)
        self.flat_view.set_image(np_to_qimage(disp))

        warns = compute_warnings(self.cv_img.shape, self.model, self.theta_max,
                                 self.valid, self.out_width)
        self.warn_label.setText("  |  ".join(warns) if warns else "")
        self.orig_view.update()

    # ---------------- 原图交互: 调整三条线
    def _orig_press(self, pos: QPointF):
        if self.model is None:
            return
        tol = self.orig_view.image_tol(12)
        x, y = pos.x(), pos.y()
        best = None
        for name in LINE_NAMES:
            for idx, (px, py) in enumerate(self.model.pts[name]):
                d = math.hypot(px - x, py - y)
                if d < tol and (best is None or d < best[0]):
                    best = (d, ("point", name, idx))
        if best is None:
            for name in LINE_NAMES:
                lx = self.model.x_of(name, y)
                if abs(lx - x) < tol:
                    best = (tol, ("shift", name, None))
                    break
        if best:
            self._drag = best[1] + (x,)

    def _orig_move(self, pos: QPointF):
        if not self._drag or self.model is None:
            return
        kind, name, idx, last_x = self._drag
        h, w = self.cv_img.shape[:2]
        x = min(max(pos.x(), -0.2 * w), 1.2 * w)
        y = min(max(pos.y(), 0.0), float(h - 1))
        if kind == "point":
            self.model.pts[name][idx] = (x, y)
        else:  # shift: 整条线水平平移
            dx = x - last_x
            self.model.pts[name] = [(px + dx, py) for px, py in self.model.pts[name]]
        self._drag = (kind, name, idx, x)
        self.orig_view.update()
        self._timer.start()  # 拖动结束后自动重算, 不用重开照片

    def _orig_release(self, _pos: QPointF):
        self._drag = None
        self.recompute()

    # ---------------- 展开图交互: 标记
    def _flat_press(self, pos: QPointF):
        if self.flat is None:
            return
        out_h, out_w = self.valid.shape
        ix = min(max(pos.x(), 0.0), out_w - 1.0)
        iy = min(max(pos.y(), 0.0), out_h - 1.0)
        theta_deg = -self.theta_max + ix / max(out_w - 1, 1) * 2 * self.theta_max
        yfrac = iy / max(out_h - 1, 1)
        if self.combo_marker.currentIndex() == 0:
            self.marker = ("point", theta_deg, yfrac)
        else:
            self.marker = ("vline", theta_deg)
        self.flat_view.update()
        self.orig_view.update()

    def clear_marker(self):
        self.marker = None
        self.flat_view.update()
        self.orig_view.update()

    # ---------------- overlay 绘制
    def _draw_orig_overlay(self, p: QPainter):
        if self.model is None or self.cv_img is None:
            return
        h, w = self.cv_img.shape[:2]
        for name in LINE_NAMES:
            (x1, y1), (x2, y2) = self.model.pts[name]
            p.setPen(_cosmetic(LINE_COLORS[name], 2))
            p.drawLine(QPointF(x1, y1), QPointF(x2, y2))
            p.setBrush(LINE_COLORS[name])
            for px, py in ((x1, y1), (x2, y2)):
                p.drawEllipse(QPointF(px, py), 6, 6)
        # 标记反投影
        if self.marker:
            p.setPen(_cosmetic(QColor(0, 200, 255), 2))
            p.setBrush(QColor(0, 200, 255))
            th = math.radians(self.marker[1])
            ys = np.linspace(0, h - 1, 200)
            xc = self.model.xc(ys)
            r = self.model.radius(ys)
            xs = xc + r * math.sin(th)
            ok = (xs >= self.model.xl(ys)) & (xs <= self.model.xr(ys)) \
                 & (xs >= 0) & (xs <= w - 1)
            if self.marker[0] == "vline":
                seg = []
                for x, y, o in zip(xs, ys, ok):
                    if o:
                        seg.append(QPointF(float(x), float(y)))
                    elif len(seg) > 1:
                        p.drawPolyline(seg)
                        seg = []
                if len(seg) > 1:
                    p.drawPolyline(seg)
            else:
                y = self.marker[2] * (h - 1)
                x = float(self.model.xc(y) + self.model.radius(y) * math.sin(th))
                if self.model.xl(y) <= x <= self.model.xr(y) and 0 <= x <= w - 1:
                    p.drawEllipse(QPointF(x, y), 7, 7)
                    p.drawLine(QPointF(x - 14, y), QPointF(x + 14, y))
                    p.drawLine(QPointF(x, y - 14), QPointF(x, y + 14))

    def _draw_flat_overlay(self, p: QPainter):
        if self.marker is None or self.valid is None:
            return
        out_h, out_w = self.valid.shape
        col = int(round((self.marker[1] + self.theta_max)
                        / max(2 * self.theta_max, 1e-9) * (out_w - 1)))
        col = min(max(col, 0), out_w - 1)
        p.setPen(_cosmetic(QColor(0, 200, 255), 2))
        p.setBrush(QColor(0, 200, 255))
        if self.marker[0] == "vline":
            # 只在有覆盖的行上画
            rows = self.valid[:, col]
            y = 0
            while y < out_h:
                if rows[y]:
                    y0 = y
                    while y < out_h and rows[y]:
                        y += 1
                    p.drawLine(col, y0, col, y - 1)
                else:
                    y += 1
        else:
            row = int(round(self.marker[2] * (out_h - 1)))
            row = min(max(row, 0), out_h - 1)
            if self.valid[row, col]:  # 无覆盖区域不画
                p.drawEllipse(QPointF(col, row), 6, 6)
                p.drawLine(col - 12, row, col + 12, row)
                p.drawLine(col, row - 12, col, row + 12)

    # ---------------- 导出 / 载回
    def export_all(self):
        if self.flat is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出展开图", "unwrap.png",
                                              "PNG (*.png)")
        if not path:
            return
        base = path[:-4] if path.lower().endswith(".png") else path
        png_path = base + ".png"
        mask_path = base + "_mask.png"
        param_path = base + "_params.json"

        out = self.flat.copy()
        out[~self.valid] = 0
        cv2.imwrite(png_path, out)
        cv2.imwrite(mask_path, (self.valid * 255).astype(np.uint8))

        h, w = self.cv_img.shape[:2]
        params = {
            "version": 1,
            "image": self.image_desc,
            "image_size": [w, h],
            "lines_norm": self.model.to_json(w, h),
            "theta_max_deg": self.theta_max,
            "out_width": self.out_width,
            "out_height": h,
        }
        with open(param_path, "w", encoding="utf-8") as f:
            json.dump(params, f, ensure_ascii=False, indent=2)
        self.warn_label.setStyleSheet("color: #66cc66; font-weight: bold;")
        self.warn_label.setText(
            f"已导出: {png_path} / {mask_path} / {param_path}")

    def load_params(self):
        path, _ = QFileDialog.getOpenFileName(self, "载入参数文件", "",
                                              "JSON (*.json)")
        if not path:
            return
        try:
            with open(path, encoding="utf-8") as f:
                params = json.load(f)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "载入失败", str(exc))
            return
        desc = params.get("image", "")
        if desc.startswith("generated:"):
            img, _m, _l = render_sample(desc.split(":", 1)[1])
        else:
            img_path = desc
            if not os.path.isabs(img_path):
                img_path = os.path.join(os.path.dirname(path), img_path)
            img = cv2.imread(img_path, cv2.IMREAD_COLOR)
        if img is None:
            QMessageBox.warning(self, "载入失败", f"找不到图像: {desc}")
            return
        h, w = img.shape[:2]
        model = CylinderModel.from_json(params.get("lines_norm", {}), w, h)
        self.spin_angle.setValue(float(params.get("theta_max_deg", 60)))
        self.spin_width.setValue(int(params.get("out_width", 1200)))
        self.set_image(img, model, desc)


# ---------------------------------------------------------------- 自检

def selftest() -> int:
    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp")
    os.makedirs(outdir, exist_ok=True)

    for kind in ("straight", "tilted", "shaded"):
        img, model, _ = render_sample(kind)
        cv2.imwrite(os.path.join(outdir, f"sample_{kind}.png"), img)

    img, model, _ = render_sample("straight")
    flat, valid, sparse, thetas = unwrap_cylinder(img, model, 80.0, 1200)
    assert flat.shape == (img.shape[0], 1200, 3), flat.shape
    assert valid.any() and valid.mean() > 0.9, valid.mean()
    # 靠边应出现像素不足, 正中不应出现
    mid = valid.shape[1] // 2
    assert not sparse[:, mid].any(), "正中不应稀疏"
    assert sparse[:, 10].any() or sparse[:, -10].any(), "靠边应稀疏"

    # 弧长检查: 输出等角 => 源采样 x 应服从 sin 分布, 而非等间距
    h = img.shape[0]
    y = h // 2
    xc = model.xc(float(y))
    r = model.radius(float(y))
    xs = xc + r * np.sin(np.radians(thetas))
    gaps = np.diff(xs)
    assert gaps[0] < 0.5 * gaps[len(gaps) // 2], "靠边源采样间隔应明显小于正中(被拉伸)"

    # 警告: 左右标反
    bad = CylinderModel(img.shape[1], img.shape[0])
    bad.pts["left"], bad.pts["right"] = bad.pts["right"], bad.pts["left"]
    warns = compute_warnings(img.shape, bad, 60.0, None, 1200)
    assert any("标反" in w_ or "相交" in w_ for w_ in warns), warns

    # 导出 + 载回
    out = flat.copy()
    out[~valid] = 0
    cv2.imwrite(os.path.join(outdir, "unwrap.png"), out)
    cv2.imwrite(os.path.join(outdir, "unwrap_mask.png"),
                (valid * 255).astype(np.uint8))
    params = {
        "version": 1,
        "image": "generated:straight",
        "image_size": [img.shape[1], img.shape[0]],
        "lines_norm": model.to_json(img.shape[1], img.shape[0]),
        "theta_max_deg": 60.0,
        "out_width": 1200,
        "out_height": img.shape[0],
    }
    ppath = os.path.join(outdir, "unwrap_params.json")
    with open(ppath, "w", encoding="utf-8") as f:
        json.dump(params, f, ensure_ascii=False, indent=2)
    with open(ppath, encoding="utf-8") as f:
        loaded = json.load(f)
    m2 = CylinderModel.from_json(loaded["lines_norm"], *loaded["image_size"])
    assert abs(m2.xc(500.0) - model.xc(500.0)) < 1e-6

    # 倾斜样例: 展开后同一 y 行应对应同一高度(行号直线)
    img_t, model_t, _ = render_sample("tilted")
    flat_t, valid_t, _, _ = unwrap_cylinder(img_t, model_t, 60.0, 1200)
    assert valid_t.mean() > 0.9

    print(f"selftest OK, 产物在 {outdir}")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        app = QApplication(sys.argv)  # noqa: F841 - QImage 需要 QApplication
        return selftest()
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
