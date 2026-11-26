"""带刻度的印刷校准条(QImage 绘制, 像素坐标与交错图严格对齐)。"""
from __future__ import annotations

import math

from PySide6 import QtCore, QtGui

from . import core
from .params import VIEW_COLORS, LensParams
from .qtio import rgba_to_qimage
import numpy as np


def build_calibration_strip(width_px: int, p: LensParams, n_views: int,
                            dpi: float | None = None) -> QtGui.QImage:
    """生成宽 ``width_px`` 设备像素的校准条。

    条内 x 坐标与交错输出 PNG 的像素列一一对应(无左右边距),
    可以直接和成品并排打印核对。
    """
    dpi = float(dpi or p.dpi)
    s = max(0.75, dpi / 300.0)
    W = int(width_px)
    H = int(170 * s)
    img = QtGui.QImage(W, H, QtGui.QImage.Format.Format_RGBA8888)
    img.fill(QtGui.QColor(255, 255, 255, 255))
    painter = QtGui.QPainter(img)
    painter.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing, True)
    painter.setRenderHint(QtGui.QPainter.RenderHint.TextAntialiasing, True)

    # 校准条本身按竖直镜条绘制(倾角只是压片模拟参数)
    p0 = LensParams(**{**p.to_dict(), "angle_deg": 0.0, "pivot_frac": 0.0,
                       "fit_right_edge": p.fit_right_edge})
    pitch = core.effective_pitch(p0, W)

    # ---- 顶部参数文字 ----
    f_title = QtGui.QFont("Helvetica", int(15 * s), QtGui.QFont.Weight.Bold)
    f_small = QtGui.QFont("Helvetica", int(11 * s))
    painter.setFont(f_title)
    painter.setPen(QtGui.QColor(0, 0, 0))
    lock = " [右端相位锁定]" if p.fit_right_edge else ""
    title = (f"LENTICULAR CALIBRATION  LPI={p.lpi:g}  DPI={dpi:g}  "
             f"P={pitch:.4f}px  offset={p.offset_px:g}px{lock}  views={n_views}")
    painter.drawText(QtCore.QRectF(10 * s, 4 * s, W - 20 * s, 26 * s),
                     QtCore.Qt.AlignmentFlag.AlignLeft | QtCore.Qt.AlignmentFlag.AlignVCenter,
                     title)

    band_top = 36 * s
    band_h = 58 * s

    # ---- 视角切片彩色带(与交错图第 0 行完全相同的取样) ----
    assign = core.assignment_map(1, W, n_views, pitch, p0)
    layer = core.source_layer(assign, n_views, VIEW_COLORS)
    row_img = rgba_to_qimage(layer)  # 1 x W? 实际 shape (1,W,4) -> QImage W x 1
    band = row_img.scaled(W, int(band_h),
                          QtCore.Qt.AspectRatioMode.IgnoreAspectRatio,
                          QtCore.Qt.TransformationMode.FastTransformation)
    painter.drawImage(0, int(band_top), band)
    painter.setPen(QtGui.QPen(QtGui.QColor(0, 0, 0), max(1, int(s))))
    painter.drawRect(QtCore.QRectF(0.5, band_top + 0.5, W - 1, band_h - 1))

    # ---- 镜条分界线 + 编号 ----
    painter.setFont(f_small)
    m_first = int(math.floor((-p.offset_px) / pitch))
    m_last = int(math.ceil((W - p.offset_px) / pitch))
    label_every = max(1, int(round(48 / max(pitch, 0.01))))
    for m in range(m_first, m_last + 1):
        x = core.boundary_x(m, 0.5, 1, pitch, p0)
        if not (0 <= x <= W):
            continue
        major = (m % label_every == 0)
        pen = QtGui.QPen(QtGui.QColor(0, 0, 0, 200 if major else 110),
                         max(1, int(1.4 * s)) if major else 1)
        painter.setPen(pen)
        painter.drawLine(QtCore.QLineF(x + 0.5, band_top, x + 0.5, band_top + band_h))
        if major:
            painter.setPen(QtGui.QColor(0, 0, 0))
            painter.drawText(QtCore.QRectF(x - 30 * s, band_top + 4 * s, 60 * s, 18 * s),
                             QtCore.Qt.AlignmentFlag.AlignCenter, f"#{m}")

    # ---- 像素刻度尺 ----
    ruler_top = band_top + band_h + 8 * s
    painter.setFont(f_small)
    ten = 10
    for x in range(0, W + 1, ten):
        if x % 100 == 0:
            ln = 20 * s
        elif x % 50 == 0:
            ln = 14 * s
        else:
            ln = 7 * s
        painter.setPen(QtGui.QPen(QtGui.QColor(0, 0, 0), 1))
        painter.drawLine(QtCore.QLineF(x + 0.5, ruler_top, x + 0.5, ruler_top + ln))
        if x % 100 == 0:
            painter.drawText(QtCore.QRectF(x - 45 * s, ruler_top + ln + 1 * s,
                                          90 * s, 16 * s),
                             QtCore.Qt.AlignmentFlag.AlignHCenter | QtCore.Qt.AlignmentFlag.AlignTop,
                             f"{x}")

    # ---- 英寸刻度尺(0.1 英寸主刻度) ----
    inch_top = ruler_top + 40 * s
    tenth = dpi / 10.0
    n_ticks = int(W / tenth) + 1
    for i in range(n_ticks + 1):
        x = i * tenth
        if x > W:
            break
        whole = (i % 10 == 0)
        half = (i % 5 == 0)
        ln = (18 if whole else 12 if half else 7) * s
        painter.setPen(QtGui.QPen(QtGui.QColor(20, 60, 160), 1))
        painter.drawLine(QtCore.QLineF(x + 0.5, inch_top, x + 0.5, inch_top + ln))
        if whole:
            painter.setPen(QtGui.QColor(20, 60, 160))
            inch_val = i // 10
            painter.drawText(QtCore.QRectF(x - 40 * s, inch_top + ln + 1 * s,
                                           80 * s, 16 * s),
                             QtCore.Qt.AlignmentFlag.AlignHCenter | QtCore.Qt.AlignmentFlag.AlignTop,
                             f'{inch_val}in')

    # 右端相位提示三角
    ep = core.edge_phases(1, W, pitch, p0)
    painter.setBrush(QtGui.QBrush(QtGui.QColor(220, 40, 40)))
    painter.setPen(QtCore.Qt.PenStyle.NoPen)
    painter.drawPolygon(QtGui.QPolygonF([
        QtCore.QPointF(W - 8 * s, 4 * s),
        QtCore.QPointF(W - 2 * s, 4 * s),
        QtCore.QPointF(W - 5 * s, 10 * s),
    ]))
    painter.end()
    img.setDotsPerMeterX(int(round(dpi / 0.0254)))
    img.setDotsPerMeterY(int(round(dpi / 0.0254)))
    return img
