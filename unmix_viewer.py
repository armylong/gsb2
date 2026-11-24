# -*- coding: utf-8 -*-
"""
双底色透明图还原工具

原理: 同一透明前景 (F, A) 分别叠在两种纯色底 B1, B2 上得到
    I1 = F*A + B1*(1-A)
    I2 = F*A + B2*(1-A)
两式相减:  I1 - I2 = (1-A)*(B1-B2)   =>  解出 A, 再回代解出 F。

用法:  python unmix_viewer.py
"""
import sys

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QImage, QPixmap
from PySide6.QtWidgets import (
    QApplication, QColorDialog, QComboBox, QFileDialog, QHBoxLayout, QLabel,
    QMainWindow, QMessageBox, QPushButton, QSizePolicy, QSplitter, QTextEdit, QVBoxLayout,
    QWidget,
)

# ---------------- 标记位 ----------------
FLAG_ILLCOND = 1    # 两种底色太接近, 方程病态
FLAG_NEARTRANS = 2  # 趋近透明, 前景色无依据
FLAG_CLIPPED = 4    # 输入触到 0/255 边界, 可能被剪
FLAG_INCONSIST = 8  # 用解出的 (F,A) 重合成后与输入对不上

FLAG_NAMES = {
    FLAG_ILLCOND: "底色相近(病态)",
    FLAG_NEARTRANS: "趋近透明",
    FLAG_CLIPPED: "输入触边界",
    FLAG_INCONSIST: "重合成不一致",
}
FLAG_COLORS = {  # 叠加显示颜色 (RGB)
    FLAG_INCONSIST: (255, 40, 40),
    FLAG_CLIPPED: (255, 0, 255),
    FLAG_ILLCOND: (255, 220, 0),
    FLAG_NEARTRANS: (0, 220, 220),
}
FLAG_ORDER = [FLAG_INCONSIST, FLAG_CLIPPED, FLAG_ILLCOND, FLAG_NEARTRANS]


# ---------------- 核心解混 ----------------
def box_mean(x, r=20):
    """HxWx3 的 (2r+1)^2 窗口均值 (边缘复制), 用于归因的局部参照。"""
    xp = np.pad(x, ((r + 1, r), (r + 1, r), (0, 0)), mode="edge")
    c = xp.cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s / float(k * k)


def grad_mag(x):
    """HxWx3 → 梯度幅值 (通道取最大)"""
    gx = np.zeros_like(x)
    gy = np.zeros_like(x)
    gx[:, 1:-1] = 0.5 * (x[:, 2:] - x[:, :-2])
    gy[1:-1] = 0.5 * (x[2:] - x[:-2])
    return np.abs(gx).max(-1) + np.abs(gy).max(-1)


def unmix(i1, i2, bg1, bg2,
          sep_eps=16 / 255.0, alpha_eps=0.03,
          res_tol=3 / 255.0, clip_half=0.5 / 255.0):
    """i1,i2: float HxWx3 in [0,1]; bg1,bg2: (3,)。
    返回 dict: F, A, alpha_raw, flags, e1, e2 (各自重合成误差),
    s1, s2 (归因分数: 哪张输入更可能不可信, 启发式)。"""
    h, w = i1.shape[:2]
    flags = np.zeros((h, w), np.uint32)
    d = bg1 - bg2
    dd = float(d @ d)
    delta = i1 - i2
    if dd < sep_eps * sep_eps:
        # 两种底色几乎相同: (1-A) 的系数近零, 透明度不可解
        flags |= FLAG_ILLCOND
        alpha_raw = np.ones((h, w))
    else:
        alpha_raw = 1.0 - (delta @ d) / dd
    alpha = np.clip(alpha_raw, 0.0, 1.0)

    a_safe = np.maximum(alpha, 1e-6)[..., None]
    f1 = (i1 - (1.0 - alpha)[..., None] * bg1) / a_safe
    f2 = (i2 - (1.0 - alpha)[..., None] * bg2) / a_safe
    F = np.clip(0.5 * (f1 + f2), 0.0, 1.0)

    near = alpha < alpha_eps
    F[near] = 0.0
    flags[near] |= FLAG_NEARTRANS

    lo, hi = clip_half, 1.0 - clip_half
    clipped = ((i1 <= lo) | (i1 >= hi)).any(-1) | ((i2 <= lo) | (i2 >= hi)).any(-1)
    # 只有前景有实际贡献 (alpha 不趋零) 时, 边界值才意味着信息被剪;
    # 纯背景处输入等于底色是精确值, 不算被剪
    clipped &= ~near
    flags[clipped] |= FLAG_CLIPPED

    # 重合成残差: 数学上 r1 == -r2 (最小二乘解对称), 所以残差只能定位
    # "两张输入对不上" 的位置, 不能单独指认哪一张
    r1 = F * alpha[..., None] + (1.0 - alpha)[..., None] * bg1 - i1
    r2 = F * alpha[..., None] + (1.0 - alpha)[..., None] * bg2 - i2
    e1 = np.abs(r1).max(-1)
    e2 = np.abs(r2).max(-1)
    flags[np.maximum(e1, e2) > res_tol] |= FLAG_INCONSIST

    # 归因 (启发式), 两个空间线索相乘:
    #  b_k: f_k 偏离联合重建的大窗口局部参照有多远 (篡改块内部有效)
    #  c_k: 输入 k 的局部梯度能量 (篡改边界的"鬼影边"只出现在被改的那张里)
    # 注意: 纯逐像素层面两张输入数学对称, 此归因依赖空间先验, 仅供参考。
    ref = box_mean(F, r=20)
    b1 = np.abs(np.clip(f1, 0, 1) - ref).max(-1)
    b2 = np.abs(np.clip(f2, 0, 1) - ref).max(-1)
    c1 = box_mean(grad_mag(i1)[..., None], r=4)[..., 0]
    c2 = box_mean(grad_mag(i2)[..., None], r=4)[..., 0]
    s1 = b1 * (c1 + 0.5 / 255.0)
    s2 = b2 * (c2 + 0.5 / 255.0)
    # 两张输入各自推出的 F 不一致的程度: 没有分歧就谈不上谁可疑
    d12 = np.abs(np.clip(f1, 0, 1) - np.clip(f2, 0, 1)).max(-1)
    quiet = np.maximum(e1, e2) < res_tol
    s1[quiet | near] = 0.0
    s2[quiet | near] = 0.0

    return dict(F=F, A=alpha, alpha_raw=alpha_raw, flags=flags,
                e1=e1, e2=e2, s1=s1, s2=s2, d12=d12)


def composite(F, A, bg):
    return F * A[..., None] + (1.0 - A)[..., None] * np.asarray(bg, float)


def checkerboard(h, w, cell=8, c1=0.75, c2=0.45):
    yy, xx = np.mgrid[0:h, 0:w]
    m = ((yy // cell) + (xx // cell)) % 2
    g = np.where(m, c1, c2)
    return np.repeat(g[..., None], 3, axis=-1)


def to_u8(imgf):
    return np.clip(np.round(imgf * 255.0), 0, 255).astype(np.uint8)


# ---------------- 内置测试对 ----------------
def make_test_pair():
    """合成一对黑/白底输入, 并对白底图做两处故意修改。
    返回 (img_black_u8, img_white_u8, 说明str)"""
    h, w = 240, 320
    yy, xx = np.mgrid[0:h, 0:w].astype(float)

    A = np.zeros((h, w))
    r = np.sqrt((xx - 90) ** 2 + (yy - 75) ** 2)
    A = np.clip(1.15 - r / 45.0, 0, 1)                      # 软边圆
    strip = (yy > 145) & (yy < 185) & (xx > 20) & (xx < 300)
    A[strip] = np.clip((xx[strip] - 20) / 280.0, 0, 1)      # 0→1 渐变条
    block = (yy > 25) & (yy < 85) & (xx > 190) & (xx < 295)
    A[block] = 0.55                                          # 半透明块
    nt = (yy > 200) & (yy < 232) & (xx > 20) & (xx < 130)
    A[nt] = 0.02                                             # 趋近透明区

    F = np.zeros((h, w, 3))
    F[..., 0] = np.clip(xx / w * 1.3, 0, 1)                  # 红渐变(右端饱和到1)
    F[..., 1] = yy / h
    F[..., 2] = 0.65
    # 在半透明块 (A=0.55) 里放纯白/纯黑小块 → 输入分别顶到 255 / 0 边界
    white_sq = (yy > 35) & (yy < 75) & (xx > 200) & (xx < 240)
    F[white_sq] = 1.0
    black_sq = (yy > 35) & (yy < 75) & (xx > 250) & (xx < 290)
    F[black_sq] = 0.0

    ib = to_u8(composite(F, A, (0, 0, 0)))
    iw = to_u8(composite(F, A, (1, 1, 1)))

    # 故意修改白底输入:
    # 1) 圆内一小块 (28x24) 只提亮红通道 —— 逐像素方程无法同时拟合两张输入,
    #    残差应暴露它 (若三通道同量加减, 在黑/白底下会被 alpha 完全吸收, 数学上不可检)
    # 2) 把渐变条一段复制到上方白底区 —— 多出来的"鬼影"边缘与黑底图对不上
    iw2 = iw.astype(float) / 255.0
    tamper1 = (yy > 45) & (yy < 69) & (xx > 70) & (xx < 98)
    iw2[tamper1, 0] = np.clip(iw2[tamper1, 0] + 0.18, 0, 1)
    seg = iw2[150:180, 200:280].copy()
    iw2[120:150, 200:280] = seg
    iw = to_u8(iw2)

    note = ("测试对说明: 黑/白底各一张; 白底图被故意修改两处——"
            "圆内一小块红通道提亮、渐变条一段被复制到上方。"
            "「重合成误差」视图定位它们,「误差归因」视图应指向输入2。")
    return ib, iw, note


# ---------------- 图像显示控件 ----------------
class ImageLabel(QLabel):
    pixelClicked = Signal(int, int)

    def __init__(self):
        super().__init__()
        self.setAlignment(Qt.AlignCenter)
        self.setMinimumSize(320, 240)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setStyleSheet("background:#202020;")
        self._arr = None

    def set_image(self, arr_u8):
        self._arr = arr_u8
        self._refresh()

    def _refresh(self):
        if self._arr is None:
            self.setPixmap(QPixmap())
            return
        h, w = self._arr.shape[:2]
        buf = np.ascontiguousarray(self._arr)
        qimg = QImage(buf.data, w, h, 3 * w, QImage.Format_RGB888).copy()
        pm = QPixmap.fromImage(qimg)
        self._pm_size = pm.size()
        self.setPixmap(pm)

    def resizeEvent(self, ev):
        self._refresh_scaled()
        super().resizeEvent(ev)

    def _refresh_scaled(self):
        if not hasattr(self, "_pm_size") or self._arr is None:
            return
        h, w = self._arr.shape[:2]
        buf = np.ascontiguousarray(self._arr)
        qimg = QImage(buf.data, w, h, 3 * w, QImage.Format_RGB888).copy()
        pm = QPixmap.fromImage(qimg).scaled(
            self.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation)
        self.setPixmap(pm)

    def mousePressEvent(self, ev):
        if self._arr is None or self.pixmap() is None or self.pixmap().isNull():
            return
        pm = self.pixmap()
        ox = (self.width() - pm.width()) / 2
        oy = (self.height() - pm.height()) / 2
        h, w = self._arr.shape[:2]
        x = (ev.position().x() - ox) * w / pm.width()
        y = (ev.position().y() - oy) * h / pm.height()
        ix, iy = int(x), int(y)
        if 0 <= ix < w and 0 <= iy < h:
            self.pixelClicked.emit(ix, iy)


# ---------------- 主窗口 ----------------
VIEW_MODES = [
    "输入1 (底色1)", "输入2 (底色2)", "透明度 A", "前景 (棋盘底)",
    "换底合成", "重合成误差", "误差归因 (哪张不可信)",
    "标记叠加", "读回核对差异",
]

BG_PRESETS = {
    "黑 / 白": ((0, 0, 0), (1, 1, 1)),
    "白 / 黑": ((1, 1, 1), (0, 0, 0)),
    "深灰 / 浅灰 (相近)": ((0.25, 0.25, 0.25), (0.75, 0.75, 0.75)),
    "黑 / 深蓝 (相近)": ((0, 0, 0), (0.02, 0.02, 0.05)),
}


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("双底色透明图还原")
        self.resize(1280, 760)

        self.i1 = None          # float HxWx3
        self.i2 = None
        self.bg1 = np.array([0.0, 0.0, 0.0])
        self.bg2 = np.array([1.0, 1.0, 1.0])
        self.comp_bg = np.array([0.0, 0.5, 0.0])   # 换底合成底色
        self.res = None
        self.readback_diff = None
        self.sel = None         # 选中像素 (x, y)

        # 左侧控制面板
        panel = QVBoxLayout()
        panel.addWidget(QLabel("<b>输入</b>"))
        for text, fn in [("载入图1 (底色1)...", lambda: self.load_image(1)),
                         ("载入图2 (底色2)...", lambda: self.load_image(2)),
                         ("载入内置测试对", self.load_test_pair)]:
            b = QPushButton(text)
            b.clicked.connect(fn)
            panel.addWidget(b)

        panel.addWidget(QLabel("<b>纯色底</b>"))
        self.preset = QComboBox()
        self.preset.addItems(list(BG_PRESETS.keys()))
        self.preset.currentTextChanged.connect(self.apply_preset)
        panel.addWidget(self.preset)
        hb = QHBoxLayout()
        self.btn_bg1 = QPushButton("底色1")
        self.btn_bg2 = QPushButton("底色2")
        self.btn_bg1.clicked.connect(lambda: self.pick_bg(1))
        self.btn_bg2.clicked.connect(lambda: self.pick_bg(2))
        hb.addWidget(self.btn_bg1)
        hb.addWidget(self.btn_bg2)
        panel.addLayout(hb)
        self.bg_label = QLabel()
        panel.addWidget(self.bg_label)

        panel.addWidget(QLabel("<b>视图</b>"))
        self.view_combo = QComboBox()
        self.view_combo.addItems(VIEW_MODES)
        self.view_combo.currentIndexChanged.connect(lambda _: self.refresh_view())
        panel.addWidget(self.view_combo)
        b = QPushButton("换底合成底色...")
        b.clicked.connect(self.pick_comp_bg)
        panel.addWidget(b)

        panel.addWidget(QLabel("<b>导出</b>"))
        b = QPushButton("导出透明 PNG 并读回核对")
        b.clicked.connect(self.export_png)
        panel.addWidget(b)
        self.export_label = QLabel("尚未导出")
        self.export_label.setWordWrap(True)
        panel.addWidget(self.export_label)
        panel.addStretch(1)

        left = QWidget()
        left.setLayout(panel)
        left.setFixedWidth(230)

        # 中间视图
        self.view = ImageLabel()
        self.view.pixelClicked.connect(self.on_pixel)

        # 右侧信息
        self.info = QTextEdit()
        self.info.setReadOnly(True)
        self.info.setFixedWidth(340)
        self.info.setText("点击图像查看像素详情")

        split = QSplitter()
        split.addWidget(left)
        split.addWidget(self.view)
        split.addWidget(self.info)
        split.setSizes([230, 720, 340])
        self.setCentralWidget(split)

        self._update_bg_label()
        self.statusBar().showMessage("就绪")

    # ---------- 输入 ----------
    def load_image(self, which):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择图像", "", "Images (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        qimg = QImage(path).convertToFormat(QImage.Format_RGB888)
        if qimg.isNull():
            QMessageBox.warning(self, "错误", "无法读取图像")
            return
        arr = qimage_to_np(qimg).astype(float) / 255.0
        if which == 1:
            self.i1 = arr
        else:
            self.i2 = arr
        self.readback_diff = None
        self.recompute()

    def load_test_pair(self):
        ib, iw, note = make_test_pair()
        self.i1 = ib.astype(float) / 255.0
        self.i2 = iw.astype(float) / 255.0
        self.bg1 = np.array([0.0, 0.0, 0.0])
        self.bg2 = np.array([1.0, 1.0, 1.0])
        self.preset.setCurrentText("黑 / 白")
        self._update_bg_label()
        self.readback_diff = None
        self.recompute()
        self.info.setText(note)

    # ---------- 底色 ----------
    def apply_preset(self, name):
        b1, b2 = BG_PRESETS[name]
        self.bg1 = np.array(b1, float)
        self.bg2 = np.array(b2, float)
        self._update_bg_label()
        self.recompute()

    def pick_bg(self, which):
        cur = self.bg1 if which == 1 else self.bg2
        c = QColorDialog_get(QColor.fromRgbF(*cur))
        if c is None:
            return
        arr = np.array([c.redF(), c.greenF(), c.blueF()])
        if which == 1:
            self.bg1 = arr
        else:
            self.bg2 = arr
        self._update_bg_label()
        self.recompute()

    def pick_comp_bg(self):
        c = QColorDialog_get(QColor.fromRgbF(*self.comp_bg))
        if c is not None:
            self.comp_bg = np.array([c.redF(), c.greenF(), c.blueF()])
            self.refresh_view()

    def _update_bg_label(self):
        def hx(b):
            return "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in b)
        self.bg_label.setText(f"底色1={hx(self.bg1)}  底色2={hx(self.bg2)}")

    # ---------- 计算与视图 ----------
    def recompute(self):
        if self.i1 is None or self.i2 is None:
            return
        if self.i1.shape != self.i2.shape:
            QMessageBox.warning(self, "错误",
                                f"两张图尺寸不一致: {self.i1.shape} vs {self.i2.shape}")
            return
        self.res = unmix(self.i1, self.i2, self.bg1, self.bg2)
        n_flag = int((self.res["flags"] != 0).sum())
        self.statusBar().showMessage(
            f"已解混 {self.i1.shape[1]}x{self.i1.shape[0]}, "
            f"被标记像素 {n_flag} ({100.0 * n_flag / self.res['flags'].size:.1f}%)")
        self.refresh_view()

    def current_view_array(self):
        mode = self.view_combo.currentText()
        if mode.startswith("输入1"):
            return to_u8(self.i1)
        if mode.startswith("输入2"):
            return to_u8(self.i2)
        if self.res is None:
            return to_u8(np.zeros_like(self.i1))
        F, A, flags = self.res["F"], self.res["A"], self.res["flags"]
        h, w = A.shape
        if mode == "透明度 A":
            g = to_u8(np.repeat(A[..., None], 3, axis=-1))
            return g
        if mode == "前景 (棋盘底)":
            return to_u8(composite(F, A, checkerboard(h, w)))
        if mode == "换底合成":
            return to_u8(composite(F, A, self.comp_bg))
        if mode == "重合成误差":
            return heat(np.maximum(self.res["e1"], self.res["e2"]))
        if mode == "误差归因 (哪张不可信)":
            return blame_map(self.res["s1"], self.res["s2"],
                             np.maximum(self.res["e1"], self.res["e2"]))
        if mode == "标记叠加":
            base = composite(F, A, checkerboard(h, w)) * 0.35
            out = base.copy()
            for fl in FLAG_ORDER:
                m = (flags & fl) != 0
                col = np.array(FLAG_COLORS[fl], float) / 255.0
                out[m] = 0.45 * out[m] + 0.55 * col
            return to_u8(out)
        if mode == "读回核对差异":
            if self.readback_diff is None:
                return to_u8(np.zeros_like(self.i1))
            return heat(self.readback_diff, scale=20.0)
        return to_u8(np.zeros_like(self.i1))

    def refresh_view(self):
        if self.i1 is None:
            return
        self.view.set_image(self.current_view_array())
        if self.sel is not None:
            self.show_pixel(*self.sel)

    # ---------- 像素详情 ----------
    def on_pixel(self, x, y):
        self.sel = (x, y)
        self.show_pixel(x, y)

    def show_pixel(self, x, y):
        def px(img):
            return tuple(int(round(v * 255)) for v in img[y, x])

        lines = [f"像素 ({x}, {y})"]
        lines.append(f"输入1 RGB = {px(self.i1)}")
        lines.append(f"输入2 RGB = {px(self.i2)}")
        if self.res is not None:
            r = self.res
            a_raw = r["alpha_raw"][y, x]
            a = r["A"][y, x]
            F = r["F"][y, x]
            lines.append(f"α 原始解 = {a_raw:.4f}   α 截断后 = {a:.4f}")
            lines.append(f"前景 F RGB = {tuple(int(round(v * 255)) for v in F)}")
            c1 = composite(F[None, :], np.array([a]), self.bg1)[0]
            c2 = composite(F[None, :], np.array([a]), self.bg2)[0]
            lines.append(f"重合成→底1 RGB = {tuple(int(round(v * 255)) for v in c1)}"
                         f"  误差 {r['e1'][y, x] * 255:.2f}/255")
            lines.append(f"重合成→底2 RGB = {tuple(int(round(v * 255)) for v in c2)}"
                         f"  误差 {r['e2'][y, x] * 255:.2f}/255")
            s1, s2 = r["s1"][y, x], r["s2"][y, x]
            if max(s1, s2) > 1e-12:
                worse = "输入1" if s1 > s2 else "输入2"
                lines.append(f"归因分数: 输入1={s1:.2e}  输入2={s2:.2e}"
                             f"  → {worse}更可疑 (启发式)")
            fl = r["flags"][y, x]
            if fl:
                names = [n for b, n in FLAG_NAMES.items() if fl & b]
                lines.append("标记: " + ", ".join(names))
            else:
                lines.append("标记: 无")
        self.info.setText("\n".join(lines))
        self.statusBar().showMessage(f"选中像素 ({x}, {y})")

    # ---------- 导出与读回核对 ----------
    def export_png(self):
        if self.res is None:
            QMessageBox.information(self, "提示", "请先载入两张输入图")
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出透明 PNG", "unmixed.png",
                                              "PNG (*.png)")
        if not path:
            return
        F, A = self.res["F"], self.res["A"]
        h, w = A.shape
        rgba = np.zeros((h, w, 4), np.uint8)
        rgba[..., :3] = to_u8(F)
        rgba[..., 3] = to_u8(A)
        buf = np.ascontiguousarray(rgba)
        qimg = QImage(buf.data, w, h, 4 * w, QImage.Format_RGBA8888).copy()
        if not qimg.save(path):
            QMessageBox.warning(self, "错误", "保存失败")
            return

        # 读回核对
        back = QImage(path).convertToFormat(QImage.Format_RGBA8888)
        arr = qimage_to_np_rgba(back).astype(float) / 255.0
        Fr, Ar = arr[..., :3], arr[..., 3]
        d_rgba = np.abs(arr - rgba.astype(float) / 255.0).max(-1)
        self.readback_diff = d_rgba
        # 读回结果重新叠回两种底色的残差
        e1 = np.abs(composite(Fr, Ar, self.bg1) - self.i1).max(-1)
        e2 = np.abs(composite(Fr, Ar, self.bg2) - self.i2).max(-1)
        self.export_label.setText(
            f"已导出并读回: {path}\n"
            f"RGBA 读回最大差: {d_rgba.max() * 255:.2f}/255\n"
            f"读回重合成残差: 底1 max {e1.max() * 255:.1f}, 底2 max {e2.max() * 255:.1f} (/255)\n"
            f"切到「读回核对差异」视图查看分布")
        self.statusBar().showMessage(f"已导出 {path}")


def qimage_to_np(qimg):
    w, h = qimg.width(), qimg.height()
    ptr = qimg.bits()
    return np.frombuffer(ptr, np.uint8, w * h * 3).reshape(h, w, 3).copy()


def qimage_to_np_rgba(qimg):
    w, h = qimg.width(), qimg.height()
    ptr = qimg.bits()
    return np.frombuffer(ptr, np.uint8, w * h * 4).reshape(h, w, 4).copy()


def heat(e, scale=8.0):
    """误差 → 黑-红-黄热力图, scale 为放大倍数"""
    t = np.clip(e * scale, 0, 1)
    out = np.zeros(e.shape + (3,))
    out[..., 0] = np.clip(t * 2, 0, 1)
    out[..., 1] = np.clip(t * 2 - 1, 0, 1)
    return to_u8(out)


def blame_map(s1, s2, e, scale=8.0):
    """归因热力图: 红=输入1更可疑, 蓝=输入2更可疑;
    亮度=重合成残差, 无残差处为黑"""
    t = np.clip(e * scale, 0, 1)
    out = np.zeros(s1.shape + (3,))
    one_worse = s1 > s2
    out[..., 0] = np.where(one_worse, t, 0.0)
    out[..., 2] = np.where(~one_worse, t, 0.0)
    return to_u8(out)


def QColorDialog_get(initial):
    c = QColorDialog.getColor(initial)
    return c if c.isValid() else None


def main():
    app = QApplication(sys.argv)
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
