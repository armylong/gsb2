#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地去模糊工作台

用法:
    python deblur_workbench.py            启动图形界面
    python deblur_workbench.py --selftest 运行无界面自检(合成数据全流程)

流程: 在点样照片上圈一块背景干净的区域提取模糊核(PSF) -> 对目标灰度图做
维纳反卷积(恢复幅度可调) -> 同一选区联动对比 原图/恢复/重新模糊/残差。
点样太暗、被截断或有多个亮点时标记为不可靠, 不替换最后一个有效 PSF。
"""

import sys

import numpy as np
from scipy import fft, ndimage
from scipy.signal import fftconvolve

from PySide6.QtCore import Qt, QRect, QPoint, QTimer, Signal
from PySide6.QtGui import QImage, QPixmap, QPainter, QPen, QColor, QWheelEvent
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QLabel, QPushButton, QComboBox,
    QSlider, QSpinBox, QDoubleSpinBox, QCheckBox, QFileDialog, QMessageBox,
    QHBoxLayout, QVBoxLayout, QGridLayout, QGroupBox, QScrollArea,
    QGraphicsView, QGraphicsScene, QGraphicsPixmapItem, QRubberBand,
    QStackedWidget, QSizePolicy, QFrame,
)

# ---------------------------------------------------------------------------
# 数值部分 (numpy / scipy)
# ---------------------------------------------------------------------------


def psf_gaussian(size, sigma):
    """各向同性高斯核, 归一化和为 1。"""
    ax = np.arange(size) - size // 2
    xx, yy = np.meshgrid(ax, ax)
    k = np.exp(-(xx**2 + yy**2) / (2.0 * sigma**2))
    return k / k.sum()


def psf_box(size):
    """均匀方块核。"""
    k = np.ones((size, size))
    return k / k.sum()


def psf_motion(length, angle_deg):
    """方向性拖影核: 一条 length 长的线旋转 angle 度。"""
    length = max(2, int(length))
    pad = 4
    size = length + 2 * pad
    k = np.zeros((size, size))
    c = size // 2
    half = length // 2
    k[c, c - half:c - half + length] = 1.0
    k = ndimage.rotate(k, angle_deg, reshape=False, order=1, mode="constant")
    k[k < 1e-4] = 0.0
    s = k.sum()
    return k / s if s > 0 else psf_gaussian(size, 1.0)


def _corner_noise(crop):
    """用选区四角估计背景噪声标准差。"""
    h, w = crop.shape
    qh, qw = max(2, h // 6), max(2, w // 6)
    corners = np.concatenate([
        crop[:qh, :qw].ravel(), crop[:qh, -qw:].ravel(),
        crop[-qh:, :qw].ravel(), crop[-qh:, -qw:].ravel(),
    ])
    return float(corners.std()) + 1e-6


def _isolate_spot(signed, noise):
    """只保留主峰所在的连通块, 其余置零。signed 为减背景后的有符号信号。

    掩膜在平滑后的有符号信号上确定——必须先不截断: clip 会把零均值噪声
    整流成 +0.4σ 的偏置, 平滑后偏置保留, 阈值稍低半个背景都会漏进掩膜。
    平滑把噪声压得很低, 阈值可以放到峰值的 5%, 拖影核暗淡的尾巴不会被
    切掉; 膨胀 2px 收回边缘。返回的掩膜内减去半σ, 抵消整流噪声偏置。
    """
    if signed.max() <= 0:
        return None
    smooth = ndimage.gaussian_filter(signed, 1.5)
    noise_s = _corner_noise(smooth)
    peak_s = float(smooth.max())
    mask = smooth > max(4 * noise_s, 0.05 * peak_s)
    lab, n = ndimage.label(mask)
    if n == 0:
        return None
    peak_pos = np.unravel_index(np.argmax(smooth), smooth.shape)
    main = lab == lab[peak_pos]
    main = ndimage.binary_dilation(main, iterations=2)
    return np.where(main, np.clip(signed - 0.5 * noise, 0, None), 0.0)


def analyze_point_crop(crop, clip_level=0.98):
    """评估点样选区是否可靠。

    返回 (issues, info): issues 为问题字符串列表(空=可靠), info 含背景/
    峰值/质心等。crop 为 0..1 浮点灰度。

    注意: 方向性拖影核被拉成长线, 峰值天然很低, 因此"太暗"按信号总质量
    和核信噪比判断, 而不是看单像素峰值。
    """
    issues = []
    bg = float(np.median(crop))
    signed = crop - bg
    noise = _corner_noise(crop)

    iso = _isolate_spot(signed, noise)
    if iso is None:
        issues.append("点样太暗(信噪比不足)")
        h, w = crop.shape
        info = dict(bg=bg, peak=0.0, mass=0.0, noise=noise, snr=0.0,
                    centroid=(h / 2, w / 2), peak_pos=(h // 2, w // 2),
                    n_spots=0)
        return issues, info

    peak = float(iso.max())
    mass = float(iso.sum())
    support = int((iso > 0).sum())

    # 核信噪比: 总质量 / (噪声 × 支撑区像素数的平方根)
    kernel_snr = mass / (noise * np.sqrt(max(support, 1)))
    if mass < 0.05 or kernel_snr < 8.0:
        issues.append("点样太暗(信噪比不足)")

    if float(crop.max()) >= clip_level:
        issues.append("点样被截断(高光溢出)")

    # 多个亮点: 在平滑后的有符号信号上数连通域(平滑压低噪声, 避免把散噪
    # 当亮点; 闭运算合并碎块, 避免把拉长的线核误拆成多个)。次峰需超过主峰 60%。
    smooth = ndimage.gaussian_filter(signed, 1.5)
    noise_s = _corner_noise(smooth)
    peak_s = float(smooth.max())
    n_spots = 0
    if peak_s > 0:
        thr = max(0.5 * peak_s, 4 * noise_s)
        mask = ndimage.binary_closing(smooth > thr,
                                      structure=np.ones((3, 3)), iterations=2)
        lab, n = ndimage.label(mask)
        for i in range(1, n + 1):
            region = lab == i
            if region.sum() >= 5 and smooth[region].max() > 0.6 * peak_s:
                n_spots += 1
        if n_spots > 1:
            issues.append(f"画面中有 {n_spots} 个亮点")

    pos = np.unravel_index(np.argmax(iso), iso.shape)
    cy, cx = ndimage.center_of_mass(iso)

    info = dict(bg=bg, peak=peak, mass=mass, noise=noise, snr=kernel_snr,
                centroid=(float(cy), float(cx)), peak_pos=pos, n_spots=n_spots)
    return issues, info


def extract_psf(crop, centroid, size):
    """以质心为中心切 size×size 窗口, 减背景、隔离主连通块、去噪、归一化。

    连通块隔离很关键: 暗底照片的零均值噪声被 clip 成偏正后, 在整个窗口
    上累计的质量可能超过点样本身, 不隔离会把核严重稀释、把质心拉偏。
    切窗后再做轻度平滑+阈值截断: 核里残留的逐像素噪声会被反卷积放大,
    稍微平滑一点的核比带噪的核安全得多。
    """
    bg = float(np.median(crop))
    noise = _corner_noise(crop)
    iso = _isolate_spot(crop - bg, noise)
    if iso is None:
        return None
    signal = iso
    cy, cx = centroid
    h, w = signal.shape
    r = size // 2
    y0, x0 = int(round(cy)) - r, int(round(cx)) - r
    # 目标窗口在源图中的有效交集
    sy0, sy1 = max(0, y0), min(h, y0 + size)
    sx0, sx1 = max(0, x0), min(w, x0 + size)
    k = np.zeros((size, size))
    k[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = signal[sy0:sy1, sx0:sx1]
    s = k.sum()
    if s <= 0:
        return None
    k /= s
    # 去噪: 轻度平滑 + 阈值截断(噪声标准差经平滑后按 2√π·σ 缩小)
    noise_k = noise / s
    k = ndimage.gaussian_filter(k, 0.5)
    thr = max(2.5 * noise_k / (2 * np.sqrt(np.pi) * 0.5), 0.005 * k.max())
    k = np.where(k > thr, k, 0.0)
    s = k.sum()
    if s <= 0:
        return None
    return k / s


def _ramp(n, width):
    r = np.ones(n)
    width = int(min(width, n // 2))
    if width > 0:
        t = np.arange(width) / width
        r[:width] = 0.5 - 0.5 * np.cos(t * np.pi)
        r[-width:] = r[:width][::-1]
    return r


def edgetaper(img, psf):
    """边缘锥化: 边界处混入模糊图, 减轻反卷积的边界振铃。"""
    kh, kw = psf.shape
    blurred = fftconvolve(img, psf, mode="same")
    alpha = np.outer(_ramp(img.shape[0], kh / 2), _ramp(img.shape[1], kw / 2))
    return alpha * img + (1.0 - alpha) * blurred


def _transfer(psf, shape):
    """由点脉冲响应构造循环卷积的传递函数。

    直接对位于图中心的 delta 做 fftconvolve(..., 'same') 再移位到原点,
    保证与 reblur 所用的 'same' 卷积逐像素对齐(手工放置核容易差 1px)。
    """
    c0, c1 = shape[0] // 2, shape[1] // 2
    delta = np.zeros(shape)
    delta[c0, c1] = 1.0
    resp = fftconvolve(delta, psf, mode="same")
    resp = np.roll(resp, (-c0, -c1), axis=(0, 1))
    return fft.fft2(resp)


def wiener_deconv(img, psf, k, taper=True):
    """维纳反卷积。k 为噪声功率谱常数, 越小恢复越激进(振铃越明显)。"""
    src = edgetaper(img, psf) if taper else img
    H = _transfer(psf, img.shape)
    Y = fft.fft2(src)
    X = np.conj(H) / (np.abs(H) ** 2 + k) * Y
    out = np.real(fft.ifft2(X))
    return np.clip(out, 0.0, 1.0)


def blur_same(img, psf):
    """前向模糊模型: 边缘延拓(场景延续到画面外, 符合真实扫描件)。

    不能用 fftconvolve 的 'same'——它在画面外隐式补零, 会让边缘向 0
    衰减, 与反卷积的循环模型严重失配, 逆滤波器把这种失配放大成全图
    振铃。
    """
    return ndimage.convolve(img, psf, mode="nearest")


def reblur(img, psf):
    return np.clip(blur_same(img, psf), 0.0, 1.0)


# ---------------------------------------------------------------------------
# 合成输入生成 (方向性拖影 / 均匀模糊)
# ---------------------------------------------------------------------------


def make_test_scene(n=512):
    """灰度测试图: 直边、细线、伪文字行、斜边、棋盘、渐变, 浅底深字仿扫描件。"""
    img = np.full((n, n), 0.85)
    # 大直边块
    img[40:120, 40:160] = 0.15
    img[40:120, 180:220] = 0.45
    # 细线 (1px / 2px)
    img[150, 40:470] = 0.1
    img[160:162, 40:470] = 0.1
    img[175, 40:470:2] = 0.1  # 点线
    # 伪文字行: 随机小墨块
    rng = np.random.default_rng(7)
    for row in range(4):
        y = 210 + row * 28
        x = 40
        while x < n - 60:
            wch = int(rng.integers(6, 14))
            if rng.random() < 0.85:
                img[y:y + 14, x:x + wch] = 0.12
            x += wch + int(rng.integers(3, 9))
    # 斜边三角
    for i in range(90):
        img[360 + i, 40:40 + i] = 0.2
    # 棋盘 (4px)
    yy, xx = np.mgrid[0:80, 0:80]
    img[360:440, 220:300] = np.where(((yy // 4) + (xx // 4)) % 2, 0.15, 0.85)
    # 渐变楔
    img[360:440, 330:470] = np.linspace(0.1, 0.9, 140)[None, :]
    # 圆环
    cy, cx, r = 480, 120, 26
    yy, xx = np.mgrid[0:n, 0:n]
    ring = np.abs(np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2) - r) < 1.5
    img[ring] = 0.1
    return img


def make_dot_scene(psf, n=256, clipped=False, multi=False, dark=False):
    """点样照片: 暗底亮点, 与目标图共用同一 PSF。"""
    img = np.full((n, n), 0.08)
    dot = np.zeros_like(img)
    dot[n // 2, n // 2] = 1.0
    if multi:
        dot[n // 2 - 40, n // 2 + 50] = 0.9
    img += fftconvolve(dot, psf, mode="same") * (0.1 if dark else 1.0)
    if clipped:
        img *= 12.0  # 严重过曝, 让被拖散的亮点中心也饱和
    img += np.random.default_rng(3).normal(0, 0.002, img.shape)
    return np.clip(img, 0.0, 1.0)


def make_synthetic_input(kind):
    """生成 (目标图, 点样图, 真值PSF, 清晰原图)。kind: 'motion' | 'box'。"""
    sharp = make_test_scene()
    if kind == "motion":
        psf = psf_motion(31, 25.0)
    else:
        psf = psf_box(9)
    blurred = blur_same(sharp, psf)
    blurred += np.random.default_rng(5).normal(0, 0.003, blurred.shape)
    target = np.clip(blurred, 0.0, 1.0)
    dot = make_dot_scene(psf)
    return target, dot, psf, sharp


# ---------------------------------------------------------------------------
# Qt 辅助
# ---------------------------------------------------------------------------


def float_to_qimage(a):
    b = np.ascontiguousarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))
    h, w = b.shape
    img = QImage(b.data, w, h, w, QImage.Format_Grayscale8)
    return img.copy()


def qimage_to_float(img):
    img = img.convertToFormat(QImage.Format_Grayscale8)
    w, h = img.width(), img.height()
    buf = np.frombuffer(img.bits(), np.uint8, img.sizeInBytes())
    buf = buf.reshape(h, img.bytesPerLine())[:, :w]
    return buf.astype(np.float64) / 255.0


class ImageView(QGraphicsView):
    """可缩放图像视图, 左键拖框发出 rectSelected(图像坐标 QRect)。"""

    rectSelected = Signal(QRect)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self._item = None
        self._rubber = QRubberBand(QRubberBand.Rectangle, self)
        self._origin = QPoint()
        self.setRenderHint(QPainter.SmoothPixmapTransform, False)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)

    def set_array(self, arr, keep_view=False):
        pm = QPixmap.fromImage(float_to_qimage(arr))
        if self._item is None:
            self._item = QGraphicsPixmapItem(pm)
            self._scene.addItem(self._item)
        else:
            self._item.setPixmap(pm)
        self._scene.setSceneRect(0, 0, pm.width(), pm.height())
        if not keep_view:
            self.fitInView(self._item, Qt.KeepAspectRatio)

    def has_image(self):
        return self._item is not None

    def wheelEvent(self, event: QWheelEvent):
        if self._item is None:
            return
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton and self._item is not None:
            self._origin = e.position().toPoint()
            self._rubber.setGeometry(QRect(self._origin, self._origin))
            self._rubber.show()
            return
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._rubber.isVisible():
            self._rubber.setGeometry(
                QRect(self._origin, e.position().toPoint()).normalized())
            return
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.LeftButton and self._rubber.isVisible():
            self._rubber.hide()
            rect = self._rubber.geometry()
            if rect.width() > 4 and rect.height() > 4:
                p0 = self.mapToScene(rect.topLeft())
                p1 = self.mapToScene(rect.bottomRight())
                img_rect = QRect(int(p0.x()), int(p0.y()),
                                 int(p1.x() - p0.x()), int(p1.y() - p0.y()))
                self.rectSelected.emit(img_rect)
            return
        super().mouseReleaseEvent(e)


class CropPanel(QFrame):
    """对比选区的一个小格子: 标题 + 最近邻放大的图。"""

    def __init__(self, title):
        super().__init__()
        self.setFrameShape(QFrame.StyledPanel)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)
        self.title = QLabel(title)
        self.title.setAlignment(Qt.AlignCenter)
        self.image = QLabel("—")
        self.image.setAlignment(Qt.AlignCenter)
        self.image.setMinimumSize(180, 180)
        self.image.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        lay.addWidget(self.title)
        lay.addWidget(self.image, 1)

    def set_crop(self, arr):
        if arr is None or arr.size == 0:
            self.image.setText("—")
            return
        pm = QPixmap.fromImage(float_to_qimage(arr))
        s = pm.size()
        s.scale(self.image.width() or 200, self.image.height() or 200,
                Qt.KeepAspectRatio)
        self.image.setPixmap(pm.scaled(s, Qt.KeepAspectRatio,
                                       Qt.FastTransformation))


# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("去模糊工作台")
        self.resize(1280, 860)

        # 状态
        self.point_img = None      # 点样照片 0..1
        self.target_img = None     # 目标灰度图
        self.psf = None            # 当前有效 PSF
        self.psf_desc = "无"
        self.restored = None
        self.reblurred = None
        self.target_rect = None    # 目标图上的对比选区
        self._last_valid_psf = None
        self._timer = QTimer(self, singleShot=True, interval=150)
        self._timer.timeout.connect(self._recompute)

        self._build_ui()

    # ---------------- UI 搭建 ----------------

    def _build_ui(self):
        central = QWidget()
        root = QHBoxLayout(central)

        # 左侧控制栏
        ctrl = QVBoxLayout()
        ctrl_widget = QWidget()
        ctrl_widget.setLayout(ctrl)
        ctrl_widget.setFixedWidth(300)
        scroll = QScrollArea()
        scroll.setWidget(ctrl_widget)
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(320)
        root.addWidget(scroll)

        # --- 点样 ---
        g1 = QGroupBox("1. 点样照片 → 模糊形状")
        v = QVBoxLayout(g1)
        b = QPushButton("加载点样照片…")
        b.clicked.connect(self.load_point)
        v.addWidget(b)
        row = QHBoxLayout()
        row.addWidget(QLabel("核窗口"))
        self.spin_psf_size = QSpinBox(minimum=15, maximum=151, value=65)
        self.spin_psf_size.setSingleStep(2)
        row.addWidget(self.spin_psf_size)
        b = QPushButton("从选区提取")
        b.clicked.connect(self.extract_from_selection)
        row.addWidget(b)
        v.addLayout(row)
        row = QHBoxLayout()
        row.addWidget(QLabel("或内置形状"))
        self.combo_builtin = QComboBox()
        self.combo_builtin.addItems(["高斯", "均匀方块", "方向拖影"])
        self.combo_builtin.currentIndexChanged.connect(
            lambda _: self.apply_builtin())
        row.addWidget(self.combo_builtin)
        v.addLayout(row)
        self.stack_builtin = QStackedWidget()
        # 高斯参数
        w = QWidget(); h = QHBoxLayout(w); h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(QLabel("σ")); self.spin_sigma = QDoubleSpinBox(
            minimum=0.3, maximum=10.0, value=2.0, singleStep=0.1)
        h.addWidget(self.spin_sigma); self.stack_builtin.addWidget(w)
        # 方块参数
        w = QWidget(); h = QHBoxLayout(w); h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(QLabel("边长")); self.spin_box = QSpinBox(
            minimum=3, maximum=41, value=11)
        h.addWidget(self.spin_box); self.stack_builtin.addWidget(w)
        # 拖影参数
        w = QWidget(); h = QHBoxLayout(w); h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(QLabel("长度")); self.spin_mlen = QSpinBox(
            minimum=3, maximum=101, value=31)
        h.addWidget(self.spin_mlen)
        h.addWidget(QLabel("角度")); self.spin_mang = QDoubleSpinBox(
            minimum=-90, maximum=90, value=25.0)
        h.addWidget(self.spin_mang); self.stack_builtin.addWidget(w)
        v.addWidget(self.stack_builtin)
        b = QPushButton("应用内置形状")
        b.clicked.connect(self.apply_builtin)
        v.addWidget(b)
        for wdt in (self.spin_sigma, self.spin_box, self.spin_mlen,
                    self.spin_mang):
            wdt.valueChanged.connect(self.apply_builtin)
        ctrl.addWidget(g1)

        self.lbl_psf_status = QLabel("PSF: 未设置")
        self.lbl_psf_status.setWordWrap(True)
        ctrl.addWidget(self.lbl_psf_status)
        self.lbl_psf_preview = QLabel("模糊形状预览")
        self.lbl_psf_preview.setAlignment(Qt.AlignCenter)
        self.lbl_psf_preview.setMinimumHeight(140)
        self.lbl_psf_preview.setFrameShape(QFrame.StyledPanel)
        ctrl.addWidget(self.lbl_psf_preview)

        # --- 目标图 ---
        g2 = QGroupBox("2. 目标灰度图")
        v = QVBoxLayout(g2)
        b = QPushButton("加载目标图…")
        b.clicked.connect(self.load_target)
        v.addWidget(b)
        row = QHBoxLayout()
        b = QPushButton("生成: 方向性拖影")
        b.clicked.connect(lambda: self.make_synthetic("motion"))
        row.addWidget(b)
        b = QPushButton("生成: 均匀模糊")
        b.clicked.connect(lambda: self.make_synthetic("box"))
        row.addWidget(b)
        v.addLayout(row)
        ctrl.addWidget(g2)

        # --- 恢复 ---
        g3 = QGroupBox("3. 恢复")
        v = QVBoxLayout(g3)
        v.addWidget(QLabel("恢复幅度 (右=激进, 注意振铃)"))
        self.slider = QSlider(Qt.Horizontal, minimum=0, maximum=1000,
                              value=500)
        self.slider.valueChanged.connect(self._on_strength)
        v.addWidget(self.slider)
        self.lbl_strength = QLabel("")
        v.addWidget(self.lbl_strength)
        self.chk_taper = QCheckBox("边缘锥化(实验性, 通常不需要)")
        self.chk_taper.setChecked(False)
        self.chk_taper.stateChanged.connect(lambda _: self._schedule())
        v.addWidget(self.chk_taper)
        b = QPushButton("导出恢复图…")
        b.clicked.connect(self.export_restored)
        v.addWidget(b)
        ctrl.addWidget(g3)
        ctrl.addStretch(1)

        # 中部: 两个主视图
        mid = QVBoxLayout()
        views = QHBoxLayout()
        col = QVBoxLayout()
        col.addWidget(QLabel("点样照片 (左键拖框选干净区域)"))
        self.view_point = ImageView()
        self.view_point.rectSelected.connect(self.on_point_rect)
        col.addWidget(self.view_point, 1)
        views.addLayout(col, 1)
        col = QVBoxLayout()
        row = QHBoxLayout()
        row.addWidget(QLabel("目标图 (拖框选对比区域)  显示:"))
        self.combo_view = QComboBox()
        self.combo_view.addItems(["原图", "恢复图", "重新模糊", "残差×4"])
        self.combo_view.currentIndexChanged.connect(
            lambda _: self._refresh_main_view())
        row.addWidget(self.combo_view)
        row.addStretch(1)
        col.addLayout(row)
        self.view_target = ImageView()
        self.view_target.rectSelected.connect(self.on_target_rect)
        col.addWidget(self.view_target, 1)
        views.addLayout(col, 1)
        mid.addLayout(views, 3)

        # 底部: 联动对比
        row = QHBoxLayout()
        self.panel_orig = CropPanel("原图")
        self.panel_rest = CropPanel("恢复图")
        self.panel_rebl = CropPanel("重新模糊")
        self.panel_resid = CropPanel("残差×4 (原图−重模糊)")
        for p in (self.panel_orig, self.panel_rest, self.panel_rebl,
                  self.panel_resid):
            row.addWidget(p, 1)
        mid.addLayout(row, 2)

        right = QWidget()
        right.setLayout(mid)
        root.addWidget(right, 1)
        self.setCentralWidget(central)
        self._on_strength(self.slider.value())

    # ---------------- 状态更新 ----------------

    def _strength_k(self):
        t = self.slider.value() / 1000.0
        return 10 ** (-6.0 + 5.0 * t)  # 1e-6 .. 1e-1

    def _on_strength(self, val):
        k = self._strength_k()
        self.lbl_strength.setText(f"正则系数 k = {k:.2e}")
        self._schedule()

    def _schedule(self):
        self._timer.start()

    def _set_psf(self, psf, desc):
        self.psf = psf
        self._last_valid_psf = psf
        self.psf_desc = desc
        self.lbl_psf_status.setText(f"PSF: {desc} ✔")
        self.lbl_psf_status.setStyleSheet("color: #1a7f37")
        self._show_psf_preview(psf)
        self._schedule()

    def _reject_psf(self, issues, psf_attempt=None):
        msg = "选区不可靠: " + "; ".join(issues) + " — 保留上一个有效设置"
        self.lbl_psf_status.setText(msg)
        self.lbl_psf_status.setStyleSheet("color: #b3261e")
        if psf_attempt is not None:
            self._show_psf_preview(psf_attempt, unreliable=True)

    def _show_psf_preview(self, psf, unreliable=False):
        vis = psf / psf.max() if psf.max() > 0 else psf
        pm = QPixmap.fromImage(float_to_qimage(vis)).scaled(
            130, 130, Qt.KeepAspectRatio, Qt.FastTransformation)
        self.lbl_psf_preview.setPixmap(pm)
        self.lbl_psf_preview.setToolTip(
            ("不可靠, 未采用" if unreliable else "当前有效")
            + f"  {psf.shape[0]}×{psf.shape[1]}")

    def _recompute(self):
        if self.target_img is None or self.psf is None:
            return
        self.restored = wiener_deconv(
            self.target_img, self.psf, self._strength_k(),
            taper=self.chk_taper.isChecked())
        self.reblurred = reblur(self.restored, self.psf)
        self._refresh_main_view()
        self._refresh_crops()

    def _current_target_display(self):
        idx = self.combo_view.currentIndex()
        if idx == 1 and self.restored is not None:
            return self.restored
        if idx == 2 and self.reblurred is not None:
            return self.reblurred
        if idx == 3 and self.reblurred is not None:
            return np.clip(0.5 + 4 * (self.target_img - self.reblurred), 0, 1)
        return self.target_img

    def _refresh_main_view(self):
        if self.target_img is not None:
            self.view_target.set_array(self._current_target_display(),
                                       keep_view=True)

    def _crop(self, arr):
        if arr is None:
            return None
        if self.target_rect is None:
            return arr
        r = self.target_rect
        h, w = arr.shape
        x0 = max(0, r.x()); y0 = max(0, r.y())
        x1 = min(w, r.x() + r.width()); y1 = min(h, r.y() + r.height())
        if x1 <= x0 or y1 <= y0:
            return None
        return arr[y0:y1, x0:x1]

    def _refresh_crops(self):
        self.panel_orig.set_crop(self._crop(self.target_img))
        self.panel_rest.set_crop(self._crop(self.restored))
        self.panel_rebl.set_crop(self._crop(self.reblurred))
        if self.reblurred is not None:
            resid = np.clip(0.5 + 4 * (self.target_img - self.reblurred), 0, 1)
            self.panel_resid.set_crop(self._crop(resid))

    # ---------------- 事件 ----------------

    def load_point(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "加载点样照片", "", "图像 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        img = QImage(path)
        if img.isNull():
            QMessageBox.warning(self, "加载失败", "无法读取该文件")
            return
        self.point_img = qimage_to_float(img)
        self.view_point.set_array(self.point_img)

    def load_target(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "加载目标灰度图", "", "图像 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        img = QImage(path)
        if img.isNull():
            QMessageBox.warning(self, "加载失败", "无法读取该文件")
            return
        self.target_img = qimage_to_float(img)
        self.target_rect = None
        self._schedule()

    def make_synthetic(self, kind):
        target, dot, psf_true, _sharp = make_synthetic_input(kind)
        self.target_img = target
        self.point_img = dot
        self.target_rect = None
        self.view_point.set_array(self.point_img)
        name = "方向性拖影" if kind == "motion" else "均匀模糊"
        self.lbl_psf_status.setText(
            f"已生成合成输入({name}), 请在点样图上圈选亮点提取 PSF")
        self.lbl_psf_status.setStyleSheet("color: #555")
        self._schedule()

    def on_point_rect(self, rect):
        self._point_rect = rect
        self.extract_from_selection()

    def extract_from_selection(self):
        if self.point_img is None:
            QMessageBox.information(self, "提示", "请先加载或生成点样照片")
            return
        rect = getattr(self, "_point_rect", None)
        if rect is None:
            QMessageBox.information(self, "提示", "请先在点样照片上拖框选区")
            return
        h, w = self.point_img.shape
        x0 = max(0, rect.x()); y0 = max(0, rect.y())
        x1 = min(w, rect.x() + rect.width()); y1 = min(h, rect.y() + rect.height())
        crop = self.point_img[y0:y1, x0:x1]
        if crop.size == 0:
            return
        issues, info = analyze_point_crop(crop)
        size = self.spin_psf_size.value() | 1  # 保证奇数
        psf = extract_psf(crop, info["centroid"], size)
        if issues or psf is None:
            if psf is None:
                issues = issues + ["选区内没有可用信号"]
            self._reject_psf(issues, psf)
            return
        desc = (f"选区提取 {size}×{size}  峰值 {info['peak']:.2f}  "
                f"SNR {info['snr']:.0f}")
        self._set_psf(psf, desc)

    def apply_builtin(self):
        idx = self.combo_builtin.currentIndex()
        self.stack_builtin.setCurrentIndex(idx)
        size = self.spin_psf_size.value() | 1
        if idx == 0:
            psf = psf_gaussian(size, self.spin_sigma.value())
            desc = f"内置高斯 σ={self.spin_sigma.value():.1f}"
        elif idx == 1:
            s = self.spin_box.value()
            psf = psf_box(s)
            desc = f"内置均匀方块 {s}×{s}"
        else:
            psf = psf_motion(self.spin_mlen.value(), self.spin_mang.value())
            desc = (f"内置方向拖影 长{self.spin_mlen.value()} "
                    f"角{self.spin_mang.value():.0f}°")
        self._set_psf(psf, desc)

    def on_target_rect(self, rect):
        self.target_rect = rect
        self._refresh_crops()

    def export_restored(self):
        if self.restored is None:
            QMessageBox.information(self, "提示", "还没有恢复结果")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出恢复图", "restored.png", "PNG (*.png);;JPEG (*.jpg)")
        if not path:
            return
        if not float_to_qimage(self.restored).save(path):
            QMessageBox.warning(self, "导出失败", "无法写入该文件")


# ---------------------------------------------------------------------------
# 自检 (无界面)
# ---------------------------------------------------------------------------


def selftest():
    print("== 合成输入(方向性拖影) ==")
    target, dot, psf_true, sharp = make_synthetic_input("motion")
    # 自动圈选点样中心区域提取
    n = dot.shape[0]
    r = 40
    crop = dot[n // 2 - r:n // 2 + r, n // 2 - r:n // 2 + r]
    issues, info = analyze_point_crop(crop)
    assert not issues, f"正常点样被误报: {issues}"
    psf = extract_psf(crop, info["centroid"], 65)
    assert psf is not None and abs(psf.sum() - 1) < 1e-9
    # 提取核与真值核对齐误差 (两者都以质心/中心对齐, 嵌入同尺寸画布比较)
    canvas = np.zeros_like(psf)
    th, tw = psf_true.shape
    c = canvas.shape[0] // 2
    canvas[c - th // 2:c - th // 2 + th, c - tw // 2:c - tw // 2 + tw] = psf_true
    err = np.abs(psf - canvas).sum()
    print(f"  PSF 提取成功, 与真值 L1 误差 {err:.3f}")
    assert err < 0.5

    # 恢复质量: 与清晰原图比较的均方误差应显著下降
    rest = wiener_deconv(target, psf, 1e-3, taper=False)
    mse_before = np.mean((target - sharp) ** 2)
    mse_after = np.mean((rest - sharp) ** 2)
    print(f"  MSE 模糊 {mse_before:.2e} -> 恢复 {mse_after:.2e}")
    assert mse_after < mse_before * 0.6

    # 重模糊应回到原图附近 (残差小说明恢复结果能解释输入)
    rb = reblur(rest, psf)
    resid = np.abs(target - rb).mean()
    print(f"  重模糊残差均值 {resid:.4f}")
    assert resid < 0.02

    print("== 不可靠点样检测 ==")
    for name, kw in [("太暗", dict(dark=True)),
                     ("截断", dict(clipped=True)),
                     ("多亮点", dict(multi=True))]:
        bad = make_dot_scene(psf_true, **kw)
        rb2 = 80 if "multi" in kw else r  # 多亮点场景需要框进两个点
        c = bad[n // 2 - rb2:n // 2 + rb2, n // 2 - rb2:n // 2 + rb2]
        issues, _ = analyze_point_crop(c)
        print(f"  {name}: {issues}")
        assert issues, f"{name} 未被检出"

    print("== 均匀模糊合成输入 ==")
    target, dot, psf_true, sharp = make_synthetic_input("box")
    crop = dot[n // 2 - r:n // 2 + r, n // 2 - r:n // 2 + r]
    issues, info = analyze_point_crop(crop)
    assert not issues, f"均匀模糊点样被误报: {issues}"
    psf = extract_psf(crop, info["centroid"], 65)
    rest = wiener_deconv(target, psf, 1e-3, taper=False)
    mse_after = np.mean((rest - sharp) ** 2)
    mse_before = np.mean((target - sharp) ** 2)
    print(f"  MSE 模糊 {mse_before:.2e} -> 恢复 {mse_after:.2e}")
    assert mse_after < mse_before * 0.6

    print("自检通过 ✔")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
