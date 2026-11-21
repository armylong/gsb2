#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""demosaic_lab.py — 相机马赛克(CFA/Bayer)采样与去马赛克实验工具

用途: 直观观察"斜边冒彩点"的成因——
  每个像素只采样 R/G/B 中的一种颜色, 重建时要从邻域猜出另外两种,
  在斜边/细线等高频区域猜错就表现为彩色斑点(伪色 / zipper)。

功能:
  1. 内置样例场景: 纯色 / 彩色细条纹 / 黑白斜边, 按选定的 CFA 排列采样成单通道 raw
  2. 可改变采样图案起点(相位偏移 ox/oy), 并提供边界(边缘)局部放大视图
  3. 两种重建: 基础邻域(双线性) 与 按边缘方向选择插值方向的重建
  4. 彩色误差图对比; 点击任意像素查看 实测raw值 / 真值 / 两种估算值
  5. 可保存重建图; --selftest 提供 纯色/斜边/奇数宽高 的自动化验证

启动:   python demosaic_lab.py
自检:   python demosaic_lab.py --selftest
"""
from __future__ import annotations

import argparse
import sys

import numpy as np

# ----------------------------------------------------------------------
# CFA 排列 (2x2 周期), 0=R 1=G 2=B
# ----------------------------------------------------------------------
CFA_PATTERNS = {
    "RGGB": ((0, 1), (1, 2)),
    "BGGR": ((2, 1), (1, 0)),
    "GRBG": ((1, 0), (2, 1)),
    "GBRG": ((1, 2), (0, 1)),
}
CHANNEL_NAMES = ("R", "G", "B")


def cfa_indices(h: int, w: int, pattern: str, ox: int = 0, oy: int = 0) -> np.ndarray:
    """返回 (h,w) 的通道索引图; ox/oy 为采样图案起点偏移(0或1)。"""
    base = np.array(CFA_PATTERNS[pattern], dtype=np.int8)
    yy, xx = np.mgrid[0:h, 0:w]
    return base[(yy + oy) % 2, (xx + ox) % 2]


def mosaic(rgb: np.ndarray, pattern: str, ox: int = 0, oy: int = 0):
    """把 RGB 场景按 CFA 采样成单通道 raw。返回 (raw, idx)。"""
    h, w = rgb.shape[:2]
    idx = cfa_indices(h, w, pattern, ox, oy)
    raw = np.take_along_axis(rgb, idx[..., None], axis=2)[..., 0]
    return raw, idx


def mosaic_view(raw: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """把单通道 raw 放回各自通道, 用于显示马赛克效果。"""
    out = np.zeros(raw.shape + (3,), dtype=np.float64)
    for c in range(3):
        out[..., c] = np.where(idx == c, raw, 0.0)
    return out


# ----------------------------------------------------------------------
# 样例场景
# ----------------------------------------------------------------------
def scene_solid(h: int, w: int, color=(0.2, 0.5, 0.8)) -> np.ndarray:
    img = np.empty((h, w, 3), dtype=np.float64)
    img[:] = color
    return img


def scene_stripes(h: int, w: int, period: int = 4) -> np.ndarray:
    """竖直彩色细线: 每 period 像素一条 1px 宽的彩色线, 背景深灰。"""
    img = np.full((h, w, 3), 0.08, dtype=np.float64)
    palette = np.array([
        [1.0, 0.2, 0.2],
        [0.2, 1.0, 0.2],
        [0.3, 0.5, 1.0],
        [1.0, 1.0, 0.2],
    ])
    xx = np.arange(w)
    mask = (xx % period) == 0
    cols = palette[(xx // period) % len(palette)]
    img[:, mask] = cols[mask]
    return img


def scene_edge(h: int, w: int, angle_deg: float = 30.0) -> np.ndarray:
    """黑白斜边: 平滑(sigmoid)过渡的阶跃边, 角度可调。"""
    yy, xx = np.mgrid[0:h, 0:w]
    th = np.deg2rad(angle_deg)
    d = (xx - w / 2.0) * np.cos(th) + (yy - h / 2.0) * np.sin(th)
    v = 1.0 / (1.0 + np.exp(-d / 1.2))
    return np.stack([v, v, v], axis=-1)


# ----------------------------------------------------------------------
# 去马赛克
# ----------------------------------------------------------------------
def _conv3(img: np.ndarray, k: np.ndarray) -> np.ndarray:
    """3x3 卷积, 边界用 edge 复制(支持任意宽高, 含奇数)。"""
    p = np.pad(img, 1, mode="edge")
    out = np.zeros_like(img, dtype=np.float64)
    for dy in range(3):
        for dx in range(3):
            out += k[dy, dx] * p[dy:dy + img.shape[0], dx:dx + img.shape[1]]
    return out


_G_KERNEL = np.array([[0., 1., 0.],
                      [1., 4., 1.],
                      [0., 1., 0.]])
_RB_KERNEL = np.ones((3, 3))


def demosaic_bilinear(raw: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """基础邻域(双线性)重建: 每通道用固定核做归一化插值。"""
    raw = raw.astype(np.float64)
    out = np.empty(raw.shape + (3,), dtype=np.float64)
    for c in range(3):
        k = _G_KERNEL if c == 1 else _RB_KERNEL
        m = (idx == c).astype(np.float64)
        num = _conv3(raw * m, k)
        den = _conv3(m, k)
        out[..., c] = num / np.maximum(den, 1e-12)
    return out


def _nb(a: np.ndarray) -> dict:
    """返回 3x3 邻域视图字典。

    用 reflect(镜像)填充: 镜像步长为 2, 恰好保持 Bayer 通道奇偶性,
    边界处取到的仍是同通道邻居, 纯色在边界也能精确重建。
    """
    p = np.pad(a, 2, mode="reflect")
    return {
        "c":  p[2:-2, 2:-2],
        "l":  p[2:-2, 1:-3],  "r":  p[2:-2, 3:-1],
        "u":  p[1:-3, 2:-2],  "d":  p[3:-1, 2:-2],
        "ul": p[1:-3, 1:-3],  "ur": p[1:-3, 3:-1],
        "dl": p[3:-1, 1:-3],  "dr": p[3:-1, 3:-1],
    }


def demosaic_edge(raw: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """按边缘方向选择的重建:
      1) 绿通道: 比较水平/垂直梯度, 沿梯度小的方向插值(不跨越边缘);
      2) 红/蓝: 用色差(R-G, B-G)假设, 绿点上沿含该色的方向插值,
         异色点上在两条对角线中选梯度小的一条。
    斜边上不跨边插值, 因此彩点明显减少。
    """
    raw = raw.astype(np.float64)
    n = _nb(raw)
    dh = np.abs(n["l"] - n["r"])
    dv = np.abs(n["u"] - n["d"])
    g_h = 0.5 * (n["l"] + n["r"])
    g_v = 0.5 * (n["u"] + n["d"])
    G = np.where(idx == 1, raw, np.where(dh <= dv, g_h, g_v))

    out = np.empty(raw.shape + (3,), dtype=np.float64)
    out[..., 1] = G
    ni = _nb(idx.astype(np.int8))
    ng = _nb(G)
    for c in (0, 2):
        D = np.where(idx == c, raw - G, 0.0)      # 已知色差
        nd = _nb(D)
        # 异色点: 两条对角线选梯度小者
        g1 = np.abs(ng["ul"] - ng["dr"])
        g2 = np.abs(ng["ur"] - ng["dl"])
        d_diag = np.where(g1 <= g2,
                          0.5 * (nd["ul"] + nd["dr"]),
                          0.5 * (nd["ur"] + nd["dl"]))
        # 绿点: 该色只出现在水平或垂直其一方向上
        has_h = (ni["l"] == c) & (ni["r"] == c)
        d_green = np.where(has_h,
                           0.5 * (nd["l"] + nd["r"]),
                           0.5 * (nd["u"] + nd["d"]))
        Dfull = np.where(idx == c, D,
                         np.where(idx == 1, d_green, d_diag))
        out[..., c] = G + Dfull
    return out


METHODS = {
    "双线性": demosaic_bilinear,
    "边缘方向": demosaic_edge,
}


# ----------------------------------------------------------------------
# 误差
# ----------------------------------------------------------------------
def color_error_map(rec: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """每像素彩色误差 = 三通道绝对差的均值。"""
    return np.abs(rec - ref).mean(axis=-1)


def mean_color_error(rec: np.ndarray, ref: np.ndarray, border: int = 2) -> float:
    e = color_error_map(rec, ref)
    if border:
        e = e[border:-border, border:-border]
    return float(e.mean())


# ----------------------------------------------------------------------
# 自检: 纯色 / 斜边 / 奇数宽高
# ----------------------------------------------------------------------
def selftest() -> int:
    checks = []

    def check(name, ok, detail=""):
        checks.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}  {detail}")

    # 1) 纯色: 所有排列 x 所有起点偏移, 两种方法都应精确重建
    solid = scene_solid(64, 64)
    worst = 0.0
    for pat in CFA_PATTERNS:
        for ox in (0, 1):
            for oy in (0, 1):
                raw, idx = mosaic(solid, pat, ox, oy)
                assert raw.ndim == 2, "raw 应为单通道"
                for fn in METHODS.values():
                    rec = fn(raw, idx)
                    worst = max(worst, float(np.abs(rec - solid).max()))
    check("纯色精确重建 (4排列x4偏移x2方法)", worst < 1e-9, f"max_err={worst:.2e}")

    # 2) 黑白斜边: 边缘方向法的平均彩色误差应低于双线性
    img = scene_edge(128, 128, 30.0)
    raw, idx = mosaic(img, "RGGB", 0, 0)
    eb = mean_color_error(demosaic_bilinear(raw, idx), img)
    ee = mean_color_error(demosaic_edge(raw, idx), img)
    check("斜边: 边缘方向优于双线性", ee < eb,
          f"bilinear={eb:.5f} edge={ee:.5f} 降低={100*(1-ee/eb):.1f}%")

    # 3) 奇数宽高: 形状正确且数值有限
    ok, detail = True, []
    for (h, w) in ((101, 103), (63, 65)):
        for scene in (scene_stripes(h, w), scene_edge(h, w, 25.0)):
            raw, idx = mosaic(scene, "GRBG", 1, 1)
            for name, fn in METHODS.items():
                rec = fn(raw, idx)
                good = rec.shape == scene.shape and np.isfinite(rec).all()
                ok &= good
                detail.append(f"{h}x{w}/{name}:{'ok' if good else 'BAD'}")
    check("奇数宽高重建", ok, " ".join(detail))

    # 4) 彩色细条纹: 采样后重建必然出现可见彩色误差(演示彩点现象本身)
    img = scene_stripes(96, 128)
    raw, idx = mosaic(img, "RGGB", 0, 0)
    e = mean_color_error(demosaic_bilinear(raw, idx), img)
    check("细条纹出现彩色误差(现象复现)", e > 0.01, f"mean_err={e:.4f}")

    print("=" * 56)
    print("全部通过" if all(checks) else "存在失败项")
    return 0 if all(checks) else 1


# ----------------------------------------------------------------------
# GUI
# ----------------------------------------------------------------------
def run_gui(after_show=None):
    from PySide6.QtCore import Qt, Signal, QTimer
    from PySide6.QtGui import QImage, QPixmap
    from PySide6.QtWidgets import (
        QComboBox, QFileDialog, QFormLayout, QGridLayout, QGroupBox,
        QHBoxLayout, QLabel, QMainWindow, QPushButton, QSpinBox,
        QVBoxLayout, QWidget,
    )

    SCENE_W, SCENE_H = 160, 120
    VIEW_SCALE = 3

    def to_qimage(arr):
        a = arr
        if a.ndim == 2:
            a = np.stack([a] * 3, axis=-1)
        a = np.ascontiguousarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
        h, w, _ = a.shape
        img = QImage(a.data, w, h, 3 * w, QImage.Format.Format_RGB888)
        return img.copy()

    class ImageView(QLabel):
        clicked = Signal(int, int)

        def __init__(self, title):
            super().__init__(title)
            self.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
            self.setStyleSheet("QLabel{border:1px solid #888; background:#202020;}")
            self._scale = 1
            self._title = title

        def set_image(self, arr, scale):
            self._scale = scale
            qimg = to_qimage(arr)
            pix = QPixmap.fromImage(qimg).scaled(
                qimg.width() * scale, qimg.height() * scale,
                Qt.AspectRatioMode.IgnoreAspectRatio,
                Qt.TransformationMode.FastTransformation)  # 最近邻放大, 便于看像素
            self.setPixmap(pix)
            self.setFixedSize(pix.size())

        def mousePressEvent(self, ev):
            x = int(ev.position().x()) // self._scale
            y = int(ev.position().y()) // self._scale
            self.clicked.emit(x, y)

    class MainWindow(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("马赛克采样与去马赛克实验 — 斜边彩点成因")
            self._build_ui()
            self.recompute()

        def _build_ui(self):
            root = QWidget()
            self.setCentralWidget(root)
            lay = QHBoxLayout(root)

            # ---- 左侧控制 ----
            ctrl = QVBoxLayout()
            box = QGroupBox("采样设置")
            form = QFormLayout(box)
            self.cb_scene = QComboBox()
            self.cb_scene.addItems(["黑白斜边", "彩色细条纹", "纯色"])
            self.cb_pattern = QComboBox()
            self.cb_pattern.addItems(list(CFA_PATTERNS))
            self.sp_ox = QSpinBox(); self.sp_ox.setRange(0, 1)
            self.sp_oy = QSpinBox(); self.sp_oy.setRange(0, 1)
            self.sp_angle = QSpinBox(); self.sp_angle.setRange(5, 85); self.sp_angle.setValue(30)
            form.addRow("场景", self.cb_scene)
            form.addRow("CFA排列", self.cb_pattern)
            form.addRow("起点偏移X", self.sp_ox)
            form.addRow("起点偏移Y", self.sp_oy)
            form.addRow("斜边角度°", self.sp_angle)
            ctrl.addWidget(box)

            box2 = QGroupBox("边界放大查看")
            form2 = QFormLayout(box2)
            self.cb_zoom_src = QComboBox()
            self.cb_zoom_src.addItems(["原图", "马赛克", "双线性", "边缘方向",
                                       "误差(双线性)", "误差(边缘方向)"])
            self.sp_crop = QSpinBox(); self.sp_crop.setRange(8, 64); self.sp_crop.setValue(24)
            form2.addRow("内容", self.cb_zoom_src)
            form2.addRow("裁剪边长", self.sp_crop)
            ctrl.addWidget(box2)

            self.btn_save = QPushButton("保存重建图(PNG)...")
            ctrl.addWidget(self.btn_save)
            self.info = QLabel("点击任意视图中的像素查看数值")
            self.info.setWordWrap(True)
            self.info.setStyleSheet("QLabel{background:#303030; padding:6px;}")
            self.info.setMinimumWidth(240)
            ctrl.addWidget(self.info)
            ctrl.addStretch(1)
            lay.addLayout(ctrl)

            # ---- 右侧视图 ----
            grid = QGridLayout()
            self.views = {}
            titles = ["原图", "马赛克", "双线性", "边缘方向",
                      "误差x6(双线性)", "误差x6(边缘方向)"]
            for i, t in enumerate(titles):
                cell = QVBoxLayout()
                cell.addWidget(QLabel(t))
                v = ImageView(t)
                v.clicked.connect(self.on_pixel)
                cell.addWidget(v)
                grid.addLayout(cell, i // 3, i % 3)
                self.views[t] = v
            # 边界放大视图
            cell = QVBoxLayout()
            cell.addWidget(QLabel("边界放大"))
            self.zoom_view = ImageView("zoom")
            cell.addWidget(self.zoom_view)
            grid.addLayout(cell, 2, 0)
            lay.addLayout(grid)

            for w in (self.cb_scene, self.cb_pattern, self.cb_zoom_src):
                w.currentIndexChanged.connect(self.recompute)
            for s in (self.sp_ox, self.sp_oy, self.sp_angle, self.sp_crop):
                s.valueChanged.connect(self.recompute)
            self.btn_save.clicked.connect(self.save_image)

        # ---- 数据流水线 ----
        def recompute(self):
            kind = self.cb_scene.currentText()
            if kind == "黑白斜边":
                self.scene = scene_edge(SCENE_H, SCENE_W, self.sp_angle.value())
            elif kind == "彩色细条纹":
                self.scene = scene_stripes(SCENE_H, SCENE_W)
            else:
                self.scene = scene_solid(SCENE_H, SCENE_W)
            self.raw, self.idx = mosaic(self.scene, self.cb_pattern.currentText(),
                                        self.sp_ox.value(), self.sp_oy.value())
            self.rec_b = demosaic_bilinear(self.raw, self.idx)
            self.rec_e = demosaic_edge(self.raw, self.idx)
            self.err_b = color_error_map(self.rec_b, self.scene)
            self.err_e = color_error_map(self.rec_e, self.scene)

            self.views["原图"].set_image(self.scene, VIEW_SCALE)
            self.views["马赛克"].set_image(mosaic_view(self.raw, self.idx), VIEW_SCALE)
            self.views["双线性"].set_image(self.rec_b, VIEW_SCALE)
            self.views["边缘方向"].set_image(self.rec_e, VIEW_SCALE)
            self.views["误差x6(双线性)"].set_image(self.err_b * 6, VIEW_SCALE)
            self.views["误差x6(边缘方向)"].set_image(self.err_e * 6, VIEW_SCALE)
            self._update_zoom()

        def _src_by_name(self, name):
            return {
                "原图": self.scene,
                "马赛克": mosaic_view(self.raw, self.idx),
                "双线性": self.rec_b,
                "边缘方向": self.rec_e,
                "误差(双线性)": np.stack([self.err_b * 6] * 3, -1),
                "误差(边缘方向)": np.stack([self.err_e * 6] * 3, -1),
            }[name]

        def _update_zoom(self):
            n = self.sp_crop.value()
            cy, cx = self.scene.shape[0] // 2, self.scene.shape[1] // 2
            y0, x0 = cy - n // 2, cx - n // 2
            crop = self._src_by_name(self.cb_zoom_src.currentText())[y0:y0 + n, x0:x0 + n]
            scale = max(1, 256 // n)
            self.zoom_view.set_image(crop, scale)

        def on_pixel(self, x, y):
            h, w = self.scene.shape[:2]
            if not (0 <= x < w and 0 <= y < h):
                return
            c = int(self.idx[y, x])
            gt = self.scene[y, x]
            rb = self.rec_b[y, x]
            re = self.rec_e[y, x]
            f = lambda v: f"({v[0]:.3f},{v[1]:.3f},{v[2]:.3f})"
            self.info.setText(
                f"像素 (x={x}, y={y})\n"
                f"CFA采样颜色: {CHANNEL_NAMES[c]}\n"
                f"实测raw值: {self.raw[y, x]:.3f}\n"
                f"真值 RGB: {f(gt)}\n"
                f"双线性估: {f(rb)}  误差={np.abs(rb-gt).mean():.4f}\n"
                f"边缘方向估: {f(re)}  误差={np.abs(re-gt).mean():.4f}")

        def save_image(self):
            path, _ = QFileDialog.getSaveFileName(
                self, "保存重建图", "reconstructed.png", "PNG (*.png)")
            if not path:
                return
            to_qimage(np.clip(self.rec_e, 0, 1)).save(path)
            self.info.setText(f"已保存: {path}")

    from PySide6.QtWidgets import QApplication
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    if after_show is not None:  # 测试钩子: 事件循环启动后回调一次
        QTimer.singleShot(0, lambda: after_show(win))
    sys.exit(app.exec())


def main():
    ap = argparse.ArgumentParser(description="马赛克采样/去马赛克实验工具")
    ap.add_argument("--selftest", action="store_true",
                    help="无界面自检: 纯色/斜边/奇数宽高验证")
    args = ap.parse_args()
    if args.selftest:
        sys.exit(selftest())
    run_gui()


if __name__ == "__main__":
    main()
