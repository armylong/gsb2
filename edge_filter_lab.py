#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
edge_filter_lab.py — 小图边缘滤波边界延拓观察工具

功能:
  * 可编辑灰度格子 / 内置灰度样例图, 固定尺寸滤波核 (1/3/5/7)
  * 四种边界延拓: 常数 / 重复 / 镜像 / 循环
  * 相关 与 卷积 两种核方向 (非对称核可见差异)
  * 点击输出像素, 高亮真正参与计算的邻域并列出每拍数值
  * 邻域大于图像、一像素宽图像均按所选边界规则计算

用法:
  python3 edge_filter_lab.py            # 启动 GUI
  python3 edge_filter_lab.py --selftest # 独立数值核验 (无需 PySide6)
"""
import sys

import numpy as np

# ---------------------------------------------------------------- 核心算法

MODES = ["constant", "replicate", "mirror", "wrap"]
MODE_LABELS = {"constant": "常数", "replicate": "重复", "mirror": "镜像", "wrap": "循环"}


def map_index(j, n, mode):
    """把延拓后的坐标 j 映射到原图坐标 [0, n)。越界且 mode=constant 时返回 None。

    mirror 采用“边缘重复”的对称反射 (同 np.pad 'symmetric' / OpenCV BORDER_REFLECT):
        n=4:  ... 2 1 0 | 0 1 2 3 | 3 2 1 ...
    对任意大的延拓量、n==1 均有定义。
    """
    if 0 <= j < n:
        return j
    if mode == "constant":
        return None
    if mode == "replicate":
        return 0 if j < 0 else n - 1
    if mode == "wrap":
        return j % n
    if mode == "mirror":
        if n == 1:
            return 0
        k = j % (2 * n)
        return k if k < n else 2 * n - 1 - k
    raise ValueError(mode)


def sample(img, y, x, mode, cval):
    """按边界规则取 (y, x) 处的像素, 越界时按 mode 延拓。"""
    iy = map_index(y, img.shape[0], mode)
    ix = map_index(x, img.shape[1], mode)
    if iy is None or ix is None:
        return cval
    return img[iy, ix]


def filter_image(img, kernel, mode="constant", cval=0.0, conv=False):
    """对灰度图做相关(conv=False)或卷积(conv=True), 输出与输入同尺寸。"""
    img = np.asarray(img, dtype=float)
    kernel = np.asarray(kernel, dtype=float)
    h, w = img.shape
    kh, kw = kernel.shape
    cy, cx = kh // 2, kw // 2
    k = kernel[::-1, ::-1] if conv else kernel  # 卷积 = 核旋转180°后相关
    out = np.zeros((h, w))
    for y in range(h):
        for x in range(w):
            acc = 0.0
            for u in range(kh):
                for v in range(kw):
                    acc += sample(img, y + u - cy, x + v - cx, mode, cval) * k[u, v]
            out[y, x] = acc
    return out


def build_padded(img, kh, kw, mode, cval):
    """构造可视化用的延拓图。返回 (padded, inside_mask, (py, px))。"""
    h, w = img.shape
    py, px = kh // 2, kw // 2
    H, W = h + 2 * py, w + 2 * px
    padded = np.zeros((H, W))
    inside = np.zeros((H, W), dtype=bool)
    for Y in range(H):
        for X in range(W):
            iy = map_index(Y - py, h, mode)
            ix = map_index(X - px, w, mode)
            if iy is None or ix is None:
                padded[Y, X] = cval
            else:
                padded[Y, X] = img[iy, ix]
                inside[Y, X] = (Y - py == iy) and (X - px == ix)
    return padded, inside, (py, px)


# ---------------------------------------------------------------- 内置样例 / 核

def make_sample(name, n=8):
    if name == "渐变":
        g = np.linspace(0, 255, n)
        return np.outer(g, np.ones(n)) / 1.0 + np.outer(np.ones(n), g)
    if name == "棋盘":
        return ((np.indices((n, n)).sum(0) % 2) * 255).astype(float)
    if name == "随机":
        return np.random.default_rng(0).integers(0, 256, (n, n)).astype(float)
    if name == "脉冲":
        a = np.zeros((n, n))
        a[n // 2, n // 2] = 255.0
        return a
    if name == "细线 9x1":
        return (np.arange(9, dtype=float) * 30).reshape(9, 1)
    raise ValueError(name)


def default_grid(n=5):
    return np.array([[y * 10 + x for x in range(n)] for y in range(n)], dtype=float)


def make_kernels():
    g1 = np.array([1, 4, 6, 4, 1], float)
    g5 = np.outer(g1, g1)
    g5 /= g5.sum()
    return [
        ("3x3 均值", np.ones((3, 3)) / 9.0),
        ("3x3 Sobel-X", np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], float)),
        ("3x3 非对称 1..9", np.arange(1, 10, dtype=float).reshape(3, 3)),
        ("5x5 高斯", g5),
        ("5x5 非对称 1..25", np.arange(1, 26, dtype=float).reshape(5, 5)),
        ("7x7 均值", np.ones((7, 7)) / 49.0),
        ("7x7 非对称 1..49", np.arange(1, 50, dtype=float).reshape(7, 7)),
    ]


# ---------------------------------------------------------------- 独立核验 (--selftest)

def _reference_filter(img, kernel, mode, cval, conv):
    """参考实现: 用 np.pad 显式延拓后滑窗点积。与 filter_image 的索引映射互为独立实现。"""
    np_mode = {"constant": "constant", "replicate": "edge",
               "mirror": "symmetric", "wrap": "wrap"}[mode]
    kh, kw = kernel.shape
    py, px = kh // 2, kw // 2
    if np_mode == "constant":
        pad = np.pad(img, ((py, py), (px, px)), "constant", constant_values=cval)
    else:
        pad = np.pad(img, ((py, py), (px, px)), np_mode)
    k = kernel[::-1, ::-1] if conv else kernel
    h, w = img.shape
    out = np.zeros((h, w))
    for y in range(h):
        for x in range(w):
            out[y, x] = float((pad[y:y + kh, x:x + kw] * k).sum())
    return out


def selftest():
    rng = np.random.default_rng(42)
    shapes = [(1, 1), (1, 5), (5, 1), (2, 3), (3, 3), (4, 4)]
    kernels = [np.array([[2.0]]),
               np.arange(1, 10, dtype=float).reshape(3, 3),
               np.arange(1, 26, dtype=float).reshape(5, 5),
               np.ones((7, 7)) / 49.0]
    cases, fails = 0, 0
    for shape in shapes:
        img = rng.integers(0, 10, shape).astype(float)
        for k in kernels:
            for mode in MODES:
                for conv in (False, True):
                    cases += 1
                    got = filter_image(img, k, mode, cval=5.0, conv=conv)
                    ref = _reference_filter(img, k, mode, 5.0, conv)
                    if not np.allclose(got, ref, atol=1e-9):
                        fails += 1
                        print(f"FAIL shape={shape} k={k.shape} mode={mode} conv={conv}")
    # 卷积 == 核翻转后的相关
    img = rng.integers(0, 10, (3, 4)).astype(float)
    k = np.arange(1, 10, dtype=float).reshape(3, 3)
    for mode in MODES:
        cases += 1
        a = filter_image(img, k, mode, 0.0, conv=True)
        b = filter_image(img, k[::-1, ::-1], mode, 0.0, conv=False)
        if not np.allclose(a, b, atol=1e-9):
            fails += 1
            print(f"FAIL conv/corr flip mode={mode}")

    # 打印一个极小矩阵的边缘数值, 供人工核对
    tiny = np.array([[1., 2., 3.], [4., 5., 6.], [7., 8., 9.]])
    k3 = np.ones((3, 3))
    print("极小矩阵核验  图像=\n", tiny, "\n核=3x3全1, 相关, 输出[0,0] (期望=邻域9拍之和):")
    for mode in MODES:
        v = filter_image(tiny, k3, mode, cval=100.0)[0, 0]
        # 手工展开: 邻域坐标 (-1..1, -1..1)
        taps = [sample(tiny, y, x, mode, 100.0) for y in (-1, 0, 1) for x in (-1, 0, 1)]
        print(f"  {MODE_LABELS[mode]}: out[0,0]={v:8.1f}  邻域={ [int(t) for t in taps] }")
    print(f"\nSELFTEST {'PASS' if fails == 0 else 'FAIL'}  ({cases - fails}/{cases} 用例通过)")
    return 0 if fails == 0 else 1


# ---------------------------------------------------------------- GUI

def run_gui():
    from PySide6.QtCore import Qt, Signal
    from PySide6.QtGui import QColor, QPainter, QPen
    from PySide6.QtWidgets import (QApplication, QComboBox, QDialog, QDialogButtonBox,
                                   QDoubleSpinBox, QGridLayout, QGroupBox, QHBoxLayout,
                                   QLabel, QMainWindow, QPlainTextEdit, QPushButton,
                                   QRadioButton, QSpinBox, QSplitter, QTableWidget,
                                   QTableWidgetItem, QVBoxLayout, QWidget)

    def fmt(v):
        s = f"{v:.2f}".rstrip("0").rstrip(".")
        return s if s not in ("-0", "") else "0"

    class GridWidget(QWidget):
        """把 2D 数组画成带数值的格子; 支持高亮集合与选中格。"""
        cellClicked = Signal(int, int)

        def __init__(self, title=""):
            super().__init__()
            self.title = title
            self.arr = np.zeros((1, 1))
            self.highlights = set()
            self.inside = None      # 延拓图的“原图区域”掩码
            self.selected = None
            self._geo = None
            self.setMinimumSize(240, 240)

        def set_data(self, arr, highlights=(), inside=None, selected=None):
            self.arr = np.asarray(arr, dtype=float)
            self.highlights = set(highlights)
            self.inside = inside
            self.selected = selected
            self.update()

        def paintEvent(self, _):
            p = QPainter(self)
            p.fillRect(self.rect(), QColor("#fafafa"))
            rows, cols = self.arr.shape
            cell = max(8, min((self.width() - 8) / cols, (self.height() - 28) / rows))
            ox = (self.width() - cell * cols) / 2
            oy = 24 + (self.height() - 28 - cell * rows) / 2
            self._geo = (ox, oy, cell)
            p.drawText(6, 16, self.title)
            lo, hi = float(self.arr.min()), float(self.arr.max())
            span = (hi - lo) or 1.0
            fs = max(7, min(11, int(cell / 4.2)))
            f = p.font(); f.setPixelSize(fs); p.setFont(f)
            for y in range(rows):
                for x in range(cols):
                    rx, ry = ox + x * cell, oy + y * cell
                    v = self.arr[y, x]
                    g = int(235 - 175 * (v - lo) / span)
                    bg = QColor(g, g, g)
                    if self.inside is not None and not self.inside[y, x]:
                        bg = QColor("#dfe3ea")  # 画面外延拓区
                    if (y, x) in self.highlights:
                        bg = QColor("#ffc766")  # 参与计算的邻域
                    p.fillRect(int(rx), int(ry), int(cell) + 1, int(cell) + 1, bg)
                    p.setPen(QPen(QColor("#999999")))
                    p.drawRect(int(rx), int(ry), int(cell), int(cell))
                    if self.selected == (y, x):
                        pen = QPen(QColor("#1a6fd4")); pen.setWidth(2)
                        p.setPen(pen)
                        p.drawRect(int(rx) + 1, int(ry) + 1, int(cell) - 2, int(cell) - 2)
                    if cell >= 18:
                        lum = 0.299 * bg.red() + 0.587 * bg.green() + 0.114 * bg.blue()
                        p.setPen(QColor("#ffffff") if lum < 110 else QColor("#222222"))
                        p.drawText(int(rx), int(ry), int(cell), int(cell),
                                   Qt.AlignCenter, fmt(v))
            p.end()

        def mousePressEvent(self, e):
            if not self._geo:
                return
            ox, oy, cell = self._geo
            x = int((e.position().x() - ox) // cell)
            y = int((e.position().y() - oy) // cell)
            if 0 <= y < self.arr.shape[0] and 0 <= x < self.arr.shape[1]:
                self.cellClicked.emit(y, x)

    class EditDialog(QDialog):
        def __init__(self, arr, parent=None):
            super().__init__(parent)
            self.setWindowTitle("编辑灰度格子")
            lay = QVBoxLayout(self)
            row = QHBoxLayout()
            row.addWidget(QLabel("尺寸 N:"))
            self.nspin = QSpinBox(minimum=1, maximum=12, value=arr.shape[0])
            row.addWidget(self.nspin)
            btn = QPushButton("重建 NxN")
            btn.clicked.connect(lambda: self._fill(default_grid(self.nspin.value())))
            row.addWidget(btn); row.addStretch(1)
            lay.addLayout(row)
            self.table = QTableWidget()
            lay.addWidget(self.table)
            bb = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
            bb.accepted.connect(self.accept); bb.rejected.connect(self.reject)
            lay.addWidget(bb)
            self._fill(arr)
            self.resize(420, 420)

        def _fill(self, arr):
            self.table.setRowCount(arr.shape[0]); self.table.setColumnCount(arr.shape[1])
            for y in range(arr.shape[0]):
                for x in range(arr.shape[1]):
                    self.table.setItem(y, x, QTableWidgetItem(fmt(float(arr[y, x]))))

        def values(self):
            n, m = self.table.rowCount(), self.table.columnCount()
            a = np.zeros((n, m))
            for y in range(n):
                for x in range(m):
                    it = self.table.item(y, x)
                    try:
                        a[y, x] = float(it.text()) if it and it.text().strip() else 0.0
                    except ValueError:
                        a[y, x] = 0.0
            return a

    class Main(QMainWindow):
        def __init__(self):
            super().__init__()
            self.setWindowTitle("边缘滤波边界延拓观察工具")
            self.grid = default_grid(5)
            self.sel = (0, 0)

            ctrl = QGroupBox("设置")
            cl = QGridLayout(ctrl)
            self.img_combo = QComboBox()
            self.img_combo.addItems(["可编辑格子", "渐变", "棋盘", "随机", "脉冲", "细线 9x1"])
            self.edit_btn = QPushButton("编辑格子…")
            self.k_combo = QComboBox()
            self.kernels = make_kernels()
            for name, _ in self.kernels:
                self.k_combo.addItem(name)
            self.mode_combo = QComboBox()
            for m in MODES:
                self.mode_combo.addItem(MODE_LABELS[m])
            self.cval = QDoubleSpinBox(minimum=-999, maximum=999, value=0.0)
            self.rb_corr = QRadioButton("相关"); self.rb_corr.setChecked(True)
            self.rb_conv = QRadioButton("卷积")
            cl.addWidget(QLabel("图像:"), 0, 0); cl.addWidget(self.img_combo, 0, 1)
            cl.addWidget(self.edit_btn, 0, 2)
            cl.addWidget(QLabel("滤波核:"), 1, 0); cl.addWidget(self.k_combo, 1, 1, 1, 2)
            cl.addWidget(QLabel("边界:"), 2, 0); cl.addWidget(self.mode_combo, 2, 1)
            cl.addWidget(QLabel("常数值:"), 2, 2); cl.addWidget(self.cval, 2, 3)
            cl.addWidget(QLabel("运算:"), 3, 0)
            cl.addWidget(self.rb_corr, 3, 1); cl.addWidget(self.rb_conv, 3, 2)

            self.in_view = GridWidget("延拓后的输入 (灰底=画面外, 橙=参与选中点的邻域)")
            self.out_view = GridWidget("输出 (点击像素查看邻域)")
            self.detail = QPlainTextEdit(readOnly=True)
            self.detail.setPlaceholderText("点击右侧输出图的像素…")

            right = QSplitter(Qt.Vertical)
            right.addWidget(self.out_view); right.addWidget(self.detail)
            right.setSizes([420, 260])
            mid = QSplitter(Qt.Horizontal)
            mid.addWidget(self.in_view); mid.addWidget(right)
            mid.setSizes([520, 560])
            root = QWidget(); rl = QVBoxLayout(root)
            rl.addWidget(ctrl); rl.addWidget(mid, 1)
            self.setCentralWidget(root)
            self.resize(1180, 760)

            self.img_combo.currentIndexChanged.connect(self.recompute)
            self.k_combo.currentIndexChanged.connect(self.recompute)
            self.mode_combo.currentIndexChanged.connect(self.recompute)
            self.cval.valueChanged.connect(self.recompute)
            self.rb_corr.toggled.connect(self.recompute)
            self.edit_btn.clicked.connect(self.edit_grid)
            self.out_view.cellClicked.connect(self.on_out_click)
            self.in_view.cellClicked.connect(self.on_in_click)
            self.recompute()

        def current_image(self):
            name = self.img_combo.currentText()
            return self.grid if name == "可编辑格子" else make_sample(name)

        def edit_grid(self):
            d = EditDialog(self.grid, self)
            if d.exec():
                self.grid = d.values()
                self.img_combo.setCurrentText("可编辑格子")
                self.recompute()

        def on_out_click(self, y, x):
            self.sel = (y, x)
            self.recompute()

        def on_in_click(self, Y, X):
            py, px = self._pad
            y, x = Y - py, X - px
            h, w = self._img.shape
            if 0 <= y < h and 0 <= x < w:
                self.sel = (y, x)
                self.recompute()

        def recompute(self):
            img = self.current_image()
            self._img = img
            kname, kernel = self.kernels[self.k_combo.currentIndex()]
            mode = MODES[self.mode_combo.currentIndex()]
            cval = self.cval.value()
            conv = self.rb_conv.isChecked()
            kh, kw = kernel.shape
            h, w = img.shape
            self.sel = (min(self.sel[0], h - 1), min(self.sel[1], w - 1))
            y, x = self.sel

            out = filter_image(img, kernel, mode, cval, conv)
            padded, inside, (py, px) = build_padded(img, kh, kw, mode, cval)
            self._pad = (py, px)

            hl = {(y + u, x + v) for u in range(kh) for v in range(kw)}
            self.in_view.set_data(padded, highlights=hl, inside=inside,
                                  selected=(y + py, x + px))
            self.out_view.set_data(out, selected=self.sel)

            keff = kernel[::-1, ::-1] if conv else kernel
            lines = [f"输出 out[{y},{x}] = {out[y, x]:.4f}   "
                     f"(核={kname}, {('卷积' if conv else '相关')}, 边界={MODE_LABELS[mode]}"
                     + (f" c={fmt(cval)}" if mode == 'constant' else "") + ")",
                     "有效核(已按运算定向): "
                     + " / ".join("[" + ", ".join(fmt(v) for v in row) + "]" for row in keff),
                     "各拍: 来源坐标 → 值 × 权重 = 积"]
            for u in range(kh):
                for v in range(kw):
                    sy, sx = y + u - kh // 2, x + v - kw // 2
                    iy = map_index(sy, h, mode); ix = map_index(sx, w, mode)
                    if iy is None or ix is None:
                        src, val = "画面外→常数", cval
                    elif (iy, ix) == (sy, sx):
                        src, val = f"({sy},{sx})", img[iy, ix]
                    else:
                        src, val = f"({sy},{sx})→延拓自({iy},{ix})", img[iy, ix]
                    lines.append(f"  {src:>22}  {fmt(val)} × {fmt(keff[u, v])}"
                                 f" = {fmt(val * keff[u, v])}")
            lines.append(f"合计 = {out[y, x]:.4f}")
            self.detail.setPlainText("\n".join(lines))

    app = QApplication(sys.argv)
    w = Main()
    w.show()
    app.exec()


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    run_gui()
