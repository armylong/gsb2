# -*- coding: utf-8 -*-
"""
texture_orientation.py — 材质贴图纹理主方向 / 周期分析工具 (PySide6 + numpy)

功能
----
1. 生成条纹 / 双方向 / 噪声样例纹理(角度、周期、强度可调), 或载入灰度图。
2. 对选区(ROI)做 2D FFT, 显示频谱与角度能量分布, 给出主方向(度)与周期(像素)。
   自动标注 "低信号" 与 "多个竞争方向"。
3. 选区尺寸、边缘处理(窗函数)可调, 结果面板解释每个量的含义与单位。
4. 方向线叠加在图上可与像素直接比对; 旋转原图后测量角度随之等量变化。
5. 一键导出选区测量值 CSV。

约定(单位与方向)
----------------
- 角度单位: 度(°)。0° = 条纹沿水平方向延伸; 正值在屏幕上顺时针(图像坐标 y 向下)。
  方向是 "无向线方向", 周期 180°, 即 10° 与 190° 等价。
- 周期单位: 像素/周期 (px)。频率单位: 周期/像素 (cycle/px), 周期 = 1/频率。
- 强度: 条纹振幅占满量程(0~1 灰度)的比例。

自检(无界面):
    python texture_orientation.py --selftest
启动界面:
    python texture_orientation.py
"""

import sys
import math
import numpy as np

# ----------------------------------------------------------------------
# 纹理生成
# ----------------------------------------------------------------------

def make_stripes(size=256, angle_deg=30.0, period_px=16.0, strength=0.8,
                 noise=0.05, seed=0):
    """单方向正弦条纹。angle_deg 为条纹延伸方向(度), period_px 为周期(像素)。"""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    a = math.radians(angle_deg)
    # 条纹沿 angle 方向延伸 => 灰度沿其法线方向变化
    phase = (x * -math.sin(a) + y * math.cos(a)) / period_px
    img = 0.5 + 0.5 * strength * np.sin(2 * np.pi * phase)
    img += noise * rng.standard_normal(img.shape)
    return np.clip(img, 0.0, 1.0)


def make_dual(size=256, angle1=20.0, angle2=80.0, period1=14.0, period2=18.0,
              strength=0.5, noise=0.05, seed=0):
    """双方向条纹叠加(两个竞争方向)。"""
    a = make_stripes(size, angle1, period1, strength, 0.0, seed)
    b = make_stripes(size, angle2, period2, strength, 0.0, seed + 1)
    rng = np.random.default_rng(seed + 2)
    img = a + b - 0.5 + noise * rng.standard_normal((size, size))
    return np.clip(img, 0.0, 1.0)


def make_noise(size=256, seed=0):
    """无规律白噪声(无主导方向)。"""
    rng = np.random.default_rng(seed)
    return np.clip(0.5 + 0.25 * rng.standard_normal((size, size)), 0.0, 1.0)


# ----------------------------------------------------------------------
# 图像旋转(双线性, 屏幕顺时针为正, 与角度约定一致)
# ----------------------------------------------------------------------

def rotate_image(img, angle_deg):
    """绕中心旋转, 输出尺寸不变, 界外填局部均值。angle_deg 正值 = 屏幕顺时针。"""
    h, w = img.shape
    a = math.radians(angle_deg)
    cy, cx = (h - 1) / 2.0, (w - 1) / 2.0
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    # 输出像素 -> 源像素(逆旋转); 内容随 angle 正值做屏幕顺时针旋转
    dx, dy = x - cx, y - cy
    sx = cx + dx * math.cos(a) + dy * math.sin(a)
    sy = cy - dx * math.sin(a) + dy * math.cos(a)
    x0 = np.floor(sx).astype(int)
    y0 = np.floor(sy).astype(int)
    fx = sx - x0
    fy = sy - y0
    x1, y1 = x0 + 1, y0 + 1
    valid = (x0 >= 0) & (y0 >= 0) & (x1 < w) & (y1 < h)
    x0c, x1c = np.clip(x0, 0, w - 1), np.clip(x1, 0, w - 1)
    y0c, y1c = np.clip(y0, 0, h - 1), np.clip(y1, 0, h - 1)
    Ia, Ib = img[y0c, x0c], img[y0c, x1c]
    Ic, Id = img[y1c, x0c], img[y1c, x1c]
    top = Ia + (Ib - Ia) * fx
    bot = Ic + (Id - Ic) * fx
    out = top + (bot - top) * fy
    fill = float(img.mean())
    return np.where(valid, out, fill)


# ----------------------------------------------------------------------
# 选区分析: 2D FFT + 角度能量直方图
# ----------------------------------------------------------------------

WINDOWS = {
    "矩形(无窗)": "rect",
    "Hann(抑制边缘泄漏)": "hann",
    "Tukey(平顶+边缘衰减)": "tukey",
}


def _window2d(kind, h, w):
    if kind == "rect":
        return np.ones((h, w))
    if kind == "hann":
        wy = np.hanning(h)
        wx = np.hanning(w)
    else:  # tukey, alpha=0.5
        def tukey(n, alpha=0.5):
            t = np.arange(n) / max(n - 1, 1)
            win = np.ones(n)
            edge = alpha / 2
            lo = t < edge
            hi = t > 1 - edge
            win[lo] = 0.5 * (1 + np.cos(np.pi * (2 * t[lo] / alpha - 1)))
            win[hi] = 0.5 * (1 + np.cos(np.pi * (2 * t[hi] / alpha - 1)))
            return win
        wy, wx = tukey(h), tukey(w)
    return np.outer(wy, wx)


def _angle_diff(a, b):
    """无向线方向(周期180°)的最小差, 结果 ∈ (-90, 90]。"""
    return (a - b + 90.0) % 180.0 - 90.0


def analyze_roi(gray, window="hann", dc_radius=3.0, n_bins=90):
    """
    对选区灰度图(0~1, 2D ndarray)做频谱分析。

    返回 dict:
      angle_deg    主方向(条纹延伸方向, 度, 0=水平, 屏幕顺时针为正)
      period_px    主周期(像素/周期)
      freq_cpp     主频率(周期/像素)
      coherence    方向集中度 0~1 (主峰±10°扇区能量 / 总能量)
      peak_ratio   谱峰信噪比 (峰值 / 谱均值), 越大信号越强
      low_signal   True = 信号太弱, 结果不可信
      competing    (True, angle2_deg) 或 (False, None): 存在第二个竞争方向
      hist         (bin_centers_deg, energy) 角度能量直方图
      spectrum     log 幅度谱(显示用, 已 fftshift)
      message      人类可读的结论/警告
    """
    h, w = gray.shape
    win = _window2d(window, h, w)
    x = (gray - gray.mean()) * win
    F = np.fft.fftshift(np.fft.fft2(x))
    P = np.abs(F) ** 2

    fy = (np.arange(h) - h // 2) / h          # cycle/px
    fx = (np.arange(w) - w // 2) / w
    FX, FY = np.meshgrid(fx, fy)
    R = np.hypot(FX, FY)
    mask = R > (dc_radius / max(h, w))        # 去掉直流与超低频(光照不均等)

    Pm = P * mask
    total = Pm.sum()
    if total <= 0 or gray.std() < 1e-3:
        return dict(angle_deg=0.0, period_px=0.0, freq_cpp=0.0, coherence=0.0,
                    peak_ratio=0.0, low_signal=True, competing=(False, None),
                    hist=(np.arange(2, 180, 2), np.zeros(89)),
                    spectrum=np.log1p(P), message="低信号: 选区几乎无纹理变化")

    # --- 角度直方图(频率向量方向, 折叠到 [0,180)) ---
    ang = (np.degrees(np.arctan2(FY, FX)) + 180.0) % 180.0
    edges = np.linspace(0, 180, n_bins + 1)
    idx = np.clip(np.digitize(ang[mask], edges) - 1, 0, n_bins - 1)
    hist = np.bincount(idx, weights=Pm[mask], minlength=n_bins).astype(float)
    # 循环平滑(窗宽3)
    hist_s = (np.roll(hist, 1) + hist + np.roll(hist, -1)) / 3.0
    centers = (edges[:-1] + edges[1:]) / 2.0

    k1 = int(np.argmax(hist_s))
    # 主峰精化: ±2 bin 能量加权质心(循环)
    offs = np.arange(-2, 3)
    ks = (k1 + offs) % n_bins
    wts = hist_s[ks]
    d_ang = ((centers[ks] - centers[k1] + 90) % 180 - 90)
    peak_ang_f = (centers[k1] + float((d_ang * wts).sum() / wts.sum())) % 180.0

    # 频率向量方向 -> 纹理方向(条纹延伸方向 = 频率方向 + 90°)
    angle_deg = (peak_ang_f + 90.0) % 180.0

    # --- 周期: 主峰角度扇区内, 径向频率的能量加权质心 ---
    dang = np.abs((ang - peak_ang_f + 90) % 180 - 90)
    sector = mask & (dang <= 8.0)
    if sector.any():
        freq = float((R[sector] * P[sector]).sum() / P[sector].sum())
    else:
        freq = float(R[np.unravel_index(np.argmax(Pm), Pm.shape)])
    period_px = 1.0 / freq if freq > 0 else 0.0

    # --- 指标 ---
    coherence = float(P[sector].sum() / total) if sector.any() else 0.0
    peak_ratio = float(Pm.max() / (Pm[mask].mean() + 1e-12))

    # --- 竞争方向: 与主峰相距≥20° 的次峰 ---
    competing = (False, None)
    sep_bins = max(1, int(round(20.0 / 180.0 * n_bins)))
    dist = np.minimum((np.arange(n_bins) - k1) % n_bins,
                      (k1 - np.arange(n_bins)) % n_bins)
    far = hist_s.copy()
    far[dist < sep_bins] = 0.0
    k2 = int(np.argmax(far))
    if hist_s[k1] > 0 and hist_s[k2] / hist_s[k1] >= 0.5:
        angle2 = (centers[k2] + 90.0) % 180.0
        competing = (True, angle2)

    # 白噪声谱的 max/mean ≈ ln(谱点数), 阈值取 2·ln(N) 以上才认为有真实谱峰
    noise_ref = 2.0 * math.log(max(Pm[mask].size, 8))
    low_signal = peak_ratio < max(15.0, noise_ref) or coherence < 0.05

    msgs = []
    if low_signal:
        msgs.append("⚠ 低信号: 谱峰不突出, 方向/周期可能不可信")
    if competing[0]:
        msgs.append(f"⚠ 多个竞争方向: 次方向 ≈ {competing[1]:.1f}°")
    if not msgs:
        msgs.append("✓ 主方向明确")
    return dict(angle_deg=angle_deg, period_px=period_px, freq_cpp=freq,
                coherence=coherence, peak_ratio=peak_ratio,
                low_signal=low_signal, competing=competing,
                hist=(centers, hist_s), spectrum=np.log1p(P),
                message="; ".join(msgs))


# ----------------------------------------------------------------------
# 自检(无界面): python texture_orientation.py --selftest
# ----------------------------------------------------------------------

def selftest():
    ok = True

    def check(name, cond, detail):
        nonlocal ok
        ok = ok and cond
        print(f"[{'PASS' if cond else 'FAIL'}] {name}: {detail}")

    # 1) 单方向条纹: 角度/周期精度
    img = make_stripes(256, angle_deg=30.0, period_px=12.0, strength=0.8, noise=0.05)
    r = analyze_roi(img, "hann")
    check("条纹角度", abs(_angle_diff(r["angle_deg"], 30.0)) < 2.0,
          f"期望30°, 测得 {r['angle_deg']:.2f}°")
    check("条纹周期", abs(r["period_px"] - 12.0) / 12.0 < 0.05,
          f"期望12px, 测得 {r['period_px']:.2f}px")
    check("条纹标志位", not r["low_signal"] and not r["competing"][0],
          r["message"])

    # 2) 旋转 +45° => 角度同步 +45° (mod 180)
    img_rot = rotate_image(img, 45.0)
    r2 = analyze_roi(img_rot, "hann")
    check("旋转跟随", abs(_angle_diff(r2["angle_deg"], 75.0)) < 2.5,
          f"期望75°, 测得 {r2['angle_deg']:.2f}°")

    # 3) 双方向 => 竞争方向标志
    img_dual = make_dual(256, angle1=20.0, angle2=80.0)
    r3 = analyze_roi(img_dual, "hann")
    check("双方向竞争", r3["competing"][0], r3["message"])

    # 4) 噪声 => 低信号或低集中度
    r4 = analyze_roi(make_noise(256), "hann")
    check("噪声低信号", r4["low_signal"] or r4["coherence"] < 0.1,
          f"coherence={r4['coherence']:.3f}, peak_ratio={r4['peak_ratio']:.1f}")

    # 5) 极弱条纹 => 低信号
    img_weak = make_stripes(256, 45.0, 16.0, strength=0.01, noise=0.3)
    r5 = analyze_roi(img_weak, "hann")
    check("弱信号标注", r5["low_signal"], f"peak_ratio={r5['peak_ratio']:.1f}")

    print("自检", "全部通过 ✓" if ok else "存在失败 ✗")
    return 0 if ok else 1


# ----------------------------------------------------------------------
# GUI
# ----------------------------------------------------------------------

def run_gui():
    from PySide6.QtCore import Qt, QRectF, QPointF
    from PySide6.QtGui import QImage, QPainter, QPen, QColor, QFont
    from PySide6.QtWidgets import (
        QApplication, QMainWindow, QWidget, QHBoxLayout, QVBoxLayout,
        QGridLayout, QLabel, QComboBox, QSlider, QPushButton, QFileDialog,
        QMessageBox, QGroupBox, QFormLayout, QDoubleSpinBox, QSpinBox,
        QTextBrowser, QSplitter,
    )

    def to_qimage(gray):
        g8 = np.ascontiguousarray((np.clip(gray, 0, 1) * 255).astype(np.uint8))
        img = QImage(g8.data, g8.shape[1], g8.shape[0], g8.shape[1],
                     QImage.Format_Grayscale8)
        return img.copy()

    class ImageView(QWidget):
        """原图 + 选区框 + 方向线叠加(方向线间距 = 测得周期, 可与像素比对)。"""
        def __init__(self):
            super().__init__()
            self.setMinimumSize(360, 360)
            self.qimg = None
            self.roi = None          # (x, y, s) 像素坐标
            self.overlay = None      # (angle_deg, period_px)

        def paintEvent(self, _):
            p = QPainter(self)
            p.fillRect(self.rect(), QColor(30, 30, 30))
            if self.qimg is None:
                p.end()
                return
            iw, ih = self.qimg.width(), self.qimg.height()
            scale = min(self.width() / iw, self.height() / ih)
            dw, dh = iw * scale, ih * scale
            ox, oy = (self.width() - dw) / 2, (self.height() - dh) / 2
            p.drawImage(QRectF(ox, oy, dw, dh), self.qimg,
                        QRectF(0, 0, iw, ih))
            if self.roi:
                x, y, s = self.roi
                rect = QRectF(ox + x * scale, oy + y * scale,
                              s * scale, s * scale)
                p.setPen(QPen(QColor(255, 200, 0), 2))
                p.drawRect(rect)
                if self.overlay:
                    ang, per = self.overlay
                    a = math.radians(ang)
                    # 方向线沿 angle 方向, 法线 n 方向按 period 间距排布
                    dx, dy = math.cos(a), math.sin(a)
                    nx, ny = -dy, dx
                    cx, cy = rect.center().x(), rect.center().y()
                    half = s * scale * 0.75
                    p.setPen(QPen(QColor(0, 255, 255, 200), 1.5))
                    k = 0
                    while k * per * scale <= half * 1.5:
                        for sgn in ((1,) if k == 0 else (1, -1)):
                            off = sgn * k * per * scale
                            mx, my = cx + nx * off, cy + ny * off
                            p.drawLine(QPointF(mx - dx * half, my - dy * half),
                                       QPointF(mx + dx * half, my + dy * half))
                        k += 1
            p.end()

    class SpectrumView(QWidget):
        """log 幅度谱(中心=直流)。"""
        def __init__(self):
            super().__init__()
            self.setMinimumSize(240, 240)
            self.qimg = None

        def set_spectrum(self, spec):
            s = spec - spec.min()
            s = s / (s.max() + 1e-12)
            self.qimg = to_qimage(s)
            self.update()

        def paintEvent(self, _):
            p = QPainter(self)
            p.fillRect(self.rect(), QColor(30, 30, 30))
            if self.qimg:
                s = min(self.width(), self.height())
                p.drawImage(QRectF((self.width() - s) / 2,
                                   (self.height() - s) / 2, s, s),
                            self.qimg)
            p.end()

    class HistView(QWidget):
        """角度能量直方图(0~180°), 标出主峰/次峰。"""
        def __init__(self):
            super().__init__()
            self.setMinimumSize(240, 160)
            self.centers = None
            self.hist = None
            self.peak1 = None
            self.peak2 = None

        def paintEvent(self, _):
            p = QPainter(self)
            p.fillRect(self.rect(), QColor(30, 30, 30))
            if self.centers is None:
                p.end()
                return
            w, h = self.width(), self.height()
            pad = 24
            hmax = self.hist.max() + 1e-12
            p.setPen(QPen(QColor(120, 200, 255), 2))
            pts = []
            for c, v in zip(self.centers, self.hist):
                px = pad + c / 180.0 * (w - 2 * pad)
                py = h - pad - v / hmax * (h - 2 * pad)
                pts.append(QPointF(px, py))
            p.drawPolyline(pts)
            for ang, color in ((self.peak1, QColor(0, 255, 255)),
                               (self.peak2, QColor(255, 120, 120))):
                if ang is not None:
                    px = pad + ang / 180.0 * (w - 2 * pad)
                    p.setPen(QPen(color, 1, Qt.DashLine))
                    p.drawLine(QPointF(px, pad), QPointF(px, h - pad))
            p.setPen(QColor(200, 200, 200))
            p.setFont(QFont("sans", 9))
            p.drawText(4, h - 6, "0°")
            p.drawText(w - 24, h - 6, "180°")
            p.drawText(4, 14, "角度能量分布")
            p.end()

    class MainWindow(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("纹理主方向分析 (FFT)")
            self.img = make_stripes(256, 30, 16, 0.8, 0.05)   # 当前图(0~1)
            self.result = None
            self.loaded = None   # 载入的外部图

            central = QWidget()
            self.setCentralWidget(central)
            root = QHBoxLayout(central)

            # ---- 左: 控制面板 ----
            ctrl = QVBoxLayout()
            root.addLayout(ctrl, 0)

            gb_src = QGroupBox("1. 纹理来源")
            f = QFormLayout(gb_src)
            self.cb_sample = QComboBox()
            self.cb_sample.addItems(["条纹(单方向)", "双方向条纹", "无规律噪声",
                                     "载入灰度图…"])
            f.addRow("样例", self.cb_sample)
            self.sb_angle = QDoubleSpinBox(); self.sb_angle.setRange(0, 179.9)
            self.sb_angle.setValue(30); self.sb_angle.setSuffix(" °")
            f.addRow("条纹角度", self.sb_angle)
            self.sb_period = QSpinBox(); self.sb_period.setRange(4, 64)
            self.sb_period.setValue(16); self.sb_period.setSuffix(" px")
            f.addRow("周期", self.sb_period)
            self.sb_strength = QDoubleSpinBox(); self.sb_strength.setRange(0, 1)
            self.sb_strength.setSingleStep(0.05); self.sb_strength.setValue(0.8)
            f.addRow("强度", self.sb_strength)
            self.sb_noise = QDoubleSpinBox(); self.sb_noise.setRange(0, 1)
            self.sb_noise.setSingleStep(0.05); self.sb_noise.setValue(0.05)
            f.addRow("噪声", self.sb_noise)
            ctrl.addWidget(gb_src)

            gb_roi = QGroupBox("2. 选区与边缘处理")
            f2 = QFormLayout(gb_roi)
            self.sb_roi = QSpinBox(); self.sb_roi.setRange(32, 256)
            self.sb_roi.setSingleStep(8); self.sb_roi.setValue(128)
            self.sb_roi.setSuffix(" px")
            f2.addRow("选区边长", self.sb_roi)
            self.cb_win = QComboBox(); self.cb_win.addItems(list(WINDOWS))
            self.cb_win.setCurrentIndex(1)
            f2.addRow("窗函数", self.cb_win)
            self.sb_rot = QDoubleSpinBox(); self.sb_rot.setRange(-180, 180)
            self.sb_rot.setSingleStep(5); self.sb_rot.setValue(0)
            self.sb_rot.setSuffix(" °")
            f2.addRow("旋转原图", self.sb_rot)
            ctrl.addWidget(gb_roi)

            self.btn_export = QPushButton("导出选区测量值 CSV…")
            ctrl.addWidget(self.btn_export)
            ctrl.addStretch(1)

            # ---- 中: 图像 ----
            self.view = ImageView()
            # ---- 右: 频谱 + 直方图 + 结果 ----
            right = QVBoxLayout()
            self.spec_view = SpectrumView()
            self.hist_view = HistView()
            self.txt = QTextBrowser()
            self.txt.setMinimumWidth(340)
            right.addWidget(self.spec_view, 1)
            right.addWidget(self.hist_view, 0)
            right.addWidget(self.txt, 1)

            split = QSplitter()
            split.addWidget(self.view)
            w2 = QWidget(); w2.setLayout(right)
            split.addWidget(w2)
            split.setSizes([500, 420])
            root.addWidget(split, 1)

            # ---- 信号 ----
            self.cb_sample.currentIndexChanged.connect(self.refresh_source)
            for sb in (self.sb_angle, self.sb_period, self.sb_strength,
                       self.sb_noise):
                sb.valueChanged.connect(self.refresh_source)
            self.sb_roi.valueChanged.connect(self.reanalyze)
            self.cb_win.currentIndexChanged.connect(self.reanalyze)
            self.sb_rot.valueChanged.connect(self.reanalyze)
            self.btn_export.clicked.connect(self.export_csv)

            self.refresh_source()
            self.resize(1180, 640)

        # -- 生成/载入纹理 --
        def refresh_source(self):
            i = self.cb_sample.currentIndex()
            if i == 0:
                self.img = make_stripes(256, self.sb_angle.value(),
                                        self.sb_period.value(),
                                        self.sb_strength.value(),
                                        self.sb_noise.value())
            elif i == 1:
                self.img = make_dual(256, self.sb_angle.value(),
                                     (self.sb_angle.value() + 60) % 180,
                                     self.sb_period.value(),
                                     max(4, self.sb_period.value() + 4),
                                     self.sb_strength.value() * 0.6,
                                     self.sb_noise.value())
            elif i == 2:
                self.img = make_noise(256)
            else:
                path, _ = QFileDialog.getOpenFileName(
                    self, "选择灰度图", "", "Images (*.png *.jpg *.bmp *.tif)")
                if not path:
                    self.cb_sample.setCurrentIndex(0)
                    return
                q = QImage(path).convertToFormat(QImage.Format_Grayscale8)
                w, h = q.width(), q.height()
                ptr = q.bits()
                arr = np.frombuffer(ptr, np.uint8, h * q.bytesPerLine())
                arr = arr.reshape(h, q.bytesPerLine())[:, :w]
                self.loaded = np.ascontiguousarray(arr).astype(float) / 255.0
                self.img = self.loaded
            self.reanalyze()

        # -- 分析 --
        def reanalyze(self):
            rot = self.sb_rot.value()
            img = rotate_image(self.img, rot) if rot else self.img
            h, w = img.shape
            s = min(self.sb_roi.value(), h, w)
            x, y = (w - s) // 2, (h - s) // 2
            roi = img[y:y + s, x:x + s]
            win = WINDOWS[self.cb_win.currentText()]
            r = analyze_roi(roi, win)
            self.result = r
            self.roi_img = roi

            self.view.qimg = to_qimage(img)
            self.view.roi = (x, y, s)
            self.view.overlay = None if r["low_signal"] else \
                (r["angle_deg"], max(r["period_px"], 1e-6))
            self.view.update()

            self.spec_view.set_spectrum(r["spectrum"])
            centers, hist = r["hist"]
            self.hist_view.centers, self.hist_view.hist = centers, hist
            self.hist_view.peak1 = None if r["low_signal"] else r["angle_deg"]
            self.hist_view.peak2 = r["competing"][1] if r["competing"][0] else None
            self.hist_view.update()

            comp = (f"<br>次方向 ≈ <b>{r['competing'][1]:.1f}°</b>"
                    if r["competing"][0] else "")
            self.txt.setHtml(f"""
            <h3>测量结果(选区 {s}×{s} px, 窗: {self.cb_win.currentText()})</h3>
            <p>主方向: <b>{r['angle_deg']:.1f}°</b>
               <i>(条纹延伸方向; 0°=水平, 屏幕顺时针为正, 周期180°)</i>{comp}</p>
            <p>主周期: <b>{r['period_px']:.2f} px</b>
               (频率 {r['freq_cpp']:.4f} cycle/px; 周期=1/频率)</p>
            <p>方向集中度 coherence: <b>{r['coherence']:.3f}</b>
               <i>(主峰±10°扇区能量占总能量的比例, 越接近1方向越单一)</i></p>
            <p>谱峰信噪比 peak/mean: <b>{r['peak_ratio']:.1f}</b>
               <i>(频谱峰值与均值之比; 白噪声约为 ln(谱点数),
               低于 2·ln(谱点数) 判为低信号)</i></p>
            <p><b>{r['message']}</b></p>
            <hr>
            <p><i>说明: 选区越大频率分辨率越高(周期更准); 窗函数抑制选区边缘
            突变造成的频谱泄漏, Hann 最平滑, 矩形窗分辨率最高但泄漏最大。
            旋转原图后, 主方向应同步变化相同角度(模180°)。
            青色方向线间距 = 测得周期, 可直接与图中条纹比对。</i></p>
            """)

        # -- 导出 --
        def export_csv(self):
            if self.result is None:
                return
            path, _ = QFileDialog.getSaveFileName(
                self, "导出测量值", "measurement.csv", "CSV (*.csv)")
            if not path:
                return
            r = self.result
            centers, hist = r["hist"]
            with open(path, "w", encoding="utf-8-sig") as f:
                f.write("# 纹理选区测量值\n")
                f.write(f"# 选区边长_px,{self.sb_roi.value()}\n")
                f.write(f"# 窗函数,{self.cb_win.currentText()}\n")
                f.write(f"# 原图旋转_deg,{self.sb_rot.value()}\n")
                f.write("key,value,unit\n")
                f.write(f"angle_deg,{r['angle_deg']:.3f},deg(0=水平,屏幕顺时针,周期180)\n")
                f.write(f"period_px,{r['period_px']:.3f},px/cycle\n")
                f.write(f"freq,{r['freq_cpp']:.6f},cycle/px\n")
                f.write(f"coherence,{r['coherence']:.4f},1\n")
                f.write(f"peak_ratio,{r['peak_ratio']:.2f},1\n")
                f.write(f"low_signal,{int(r['low_signal'])},bool\n")
                f.write(f"competing,{int(r['competing'][0])},bool\n")
                if r["competing"][0]:
                    f.write(f"angle2_deg,{r['competing'][1]:.3f},deg\n")
                f.write("\n# 角度能量直方图\nangle_deg,energy\n")
                for c, v in zip(centers, hist):
                    f.write(f"{c:.1f},{v:.6e}\n")
            QMessageBox.information(self, "导出", f"已保存: {path}")

    app = QApplication(sys.argv)
    mw = MainWindow()
    mw.show()
    if "--smoke" in sys.argv:  # 冒烟测试: 构建界面后立即退出
        from PySide6.QtCore import QTimer
        QTimer.singleShot(300, app.quit)
    sys.exit(app.exec())


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    run_gui()
