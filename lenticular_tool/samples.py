"""内置样例图: 大号数字 + 细线网格 + 取样分辨条纹。

用 QPainter 绘制(界面本来就依赖 PySide6), 输出固定 1200x800 RGBA。
"""
from __future__ import annotations

import numpy as np
from PySide6 import QtCore, QtGui

from .params import VIEW_COLORS
from .qtio import qimage_to_rgba

SAMPLE_W = 1200
SAMPLE_H = 800

# 每个样例略微不同的辅助标记, 串图时更容易分辨
_ACCENTS = ["●", "▲", "■", "★"]


def make_sample(index: int, width: int = SAMPLE_W, height: int = SAMPLE_H) -> np.ndarray:
    """绘制第 index(0..3) 张内置视角样例。"""
    idx = int(index) % 4
    r, g, b = VIEW_COLORS[idx]
    img = QtGui.QImage(width, height, QtGui.QImage.Format.Format_RGBA8888)
    img.fill(QtGui.QColor(255, 255, 255, 255))
    p = QtGui.QPainter(img)
    p.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing, True)
    p.setRenderHint(QtGui.QPainter.RenderHint.TextAntialiasing, True)

    # -- 极淡的视角色底, 让混合 / 串图一眼可见 --
    p.fillRect(0, 0, width, height, QtGui.QColor(r, g, b, 16))

    # -- 细线网格: 25px 细线, 100px 粗一点 --
    pen_fine = QtGui.QPen(QtGui.QColor(60, 60, 60, 60), 1)
    pen_major = QtGui.QPen(QtGui.QColor(40, 40, 40, 120), 1)
    x = 0
    while x <= width:
        p.setPen(pen_major if x % 100 == 0 else pen_fine)
        p.drawLine(x + 0.5, 0, x + 0.5, height)
        x += 25
    y = 0
    while y <= height:
        p.setPen(pen_major if y % 100 == 0 else pen_fine)
        p.drawLine(0, y + 0.5, width, y + 0.5)
        y += 25

    # -- 顶部色条与标签 --
    p.fillRect(0, 0, width, 64, QtGui.QColor(r, g, b, 235))
    f_label = QtGui.QFont("Helvetica", 26, QtGui.QFont.Weight.Bold)
    p.setFont(f_label)
    p.setPen(QtGui.QColor(255, 255, 255))
    p.drawText(QtCore.QRect(24, 0, 700, 64),
               QtCore.Qt.AlignmentFlag.AlignVCenter | QtCore.Qt.AlignmentFlag.AlignLeft,
               f"VIEW {idx + 1}  /  视角 {idx + 1}")
    p.drawText(QtCore.QRect(width - 260, 0, 236, 64),
               QtCore.Qt.AlignmentFlag.AlignVCenter | QtCore.Qt.AlignmentFlag.AlignRight,
               f"{width}x{height}")

    # -- 大号数字(描边 + 实色, 保证缩小时轮廓仍清楚) --
    digit = str(idx + 1)
    font = QtGui.QFont("Helvetica", 560, QtGui.QFont.Weight.Black)
    font.setStyleStrategy(QtGui.QFont.StyleStrategy.PreferAntialias)
    p.setFont(font)
    path = QtGui.QPainterPath()
    # 用 QFontMetrics 精确居中
    fm = QtGui.QFontMetrics(font)
    tw = fm.horizontalAdvance(digit)
    th = fm.ascent() - fm.descent()
    dx = (width - tw) / 2
    dy = (height + th) / 2 - 30
    path.addText(dx, dy, font, digit)
    pen_outline = QtGui.QPen(QtGui.QColor(20, 20, 20, 255), 6)
    p.setPen(pen_outline)
    p.setBrush(QtGui.QBrush(QtGui.QColor(r, g, b, 255)))
    p.drawPath(path)

    # 角落辅助符号
    f_acc = QtGui.QFont("Helvetica", 60, QtGui.QFont.Weight.Bold)
    p.setFont(f_acc)
    p.setPen(QtGui.QColor(r, g, b, 220))
    p.drawText(QtCore.QRect(width - 150, height - 150, 120, 120),
               QtCore.Qt.AlignmentFlag.AlignCenter, _ACCENTS[idx])

    # -- 底部分辨条纹区: 1px 黑白线对 + 刻度数字 --
    band_y = height - 96
    p.fillRect(0, band_y, width, 96, QtGui.QColor(255, 255, 255, 235))
    p.setPen(QtGui.QPen(QtGui.QColor(0, 0, 0), 1))
    # 左侧: 每 4px 一对 1px 黑线(检验取样/摩尔纹)
    sx = 24
    for i in range(0, 240):
        xx = sx + i * 2
        if i % 2 == 0:
            p.drawLine(xx + 0.5, band_y + 12, xx + 0.5, band_y + 52)
    p.setPen(QtGui.QColor(0, 0, 0))
    f_small = QtGui.QFont("Helvetica", 13)
    p.setFont(f_small)
    p.drawText(QtCore.QRect(sx, band_y + 56, 260, 20),
               QtCore.Qt.AlignmentFlag.AlignLeft, "1px line pairs")

    # 右侧: 毫米/像素刻度感的长短线
    rx = width - 560
    for i in range(0, 501, 10):
        xx = rx + i
        long = (i % 50 == 0)
        p.setPen(QtGui.QPen(QtGui.QColor(0, 0, 0), 1))
        p.drawLine(xx + 0.5, band_y + (18 if long else 32), xx + 0.5, band_y + 52)
        if long:
            p.drawText(QtCore.QRect(xx - 25, band_y + 56, 50, 20),
                       QtCore.Qt.AlignmentFlag.AlignCenter, str(i))
    p.drawText(QtCore.QRect(rx, band_y - 2, 500, 18),
               QtCore.Qt.AlignmentFlag.AlignLeft, "pixel ticks (sample artwork)")

    p.end()
    return qimage_to_rgba(img)


def make_samples(n: int = 3) -> list[np.ndarray]:
    """一次生成 n 张同尺寸样例(2..4)。"""
    n = int(np.clip(n, 2, 4))
    return [make_sample(i) for i in range(n)]
