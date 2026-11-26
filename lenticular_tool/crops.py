"""图首/图中/图尾放大裁片, 叠加镜条与切片分界线。"""
from __future__ import annotations

from PySide6 import QtCore, QtGui

from . import core
from .params import LensParams
from .qtio import rgba_to_qimage


def render_spot_crop(arr, spot: "core.SpotReport", p: LensParams,
                     pitch: float, n_views: int, scale: int = 6) -> QtGui.QPixmap:
    x0, x1 = spot.crop_x
    y0, y1 = spot.crop_y
    sub = arr[y0:y1, x0:x1]
    qimg = rgba_to_qimage(sub)
    big = qimg.scaled((x1 - x0) * scale, (y1 - y0) * scale,
                      QtCore.Qt.AspectRatioMode.IgnoreAspectRatio,
                      QtCore.Qt.TransformationMode.FastTransformation)
    painter = QtGui.QPainter(big)

    def X(x_native: float) -> float:
        return (x_native - x0) * scale

    def Y(y_native: float) -> float:
        return (y_native - y0) * scale

    # 该区域可能涉及的镜条: 邻近镜条只画边界, 目标镜条额外画切片虚线
    m_lo = spot.lens_index - 3
    m_hi = spot.lens_index + 4
    for m in range(m_lo, m_hi + 1):
        xa0 = core.boundary_x(m, y0, arr.shape[0], pitch, p)
        xa1 = core.boundary_x(m, y1, arr.shape[0], pitch, p)
        xb0 = core.boundary_x(m + 1, y0, arr.shape[0], pitch, p)
        xb1 = core.boundary_x(m + 1, y1, arr.shape[0], pitch, p)
        is_target = (m == spot.lens_index)
        pen = QtGui.QPen(QtGui.QColor(0, 230, 255, 235) if is_target
                         else QtGui.QColor(255, 255, 255, 150),
                         2.4 if is_target else 1.1)
        painter.setPen(pen)
        painter.drawLine(QtCore.QPointF(X(xa0), Y(y0)),
                         QtCore.QPointF(X(xa1), Y(y1)))
        painter.drawLine(QtCore.QPointF(X(xb0), Y(y0)),
                         QtCore.QPointF(X(xb1), Y(y1)))
        if is_target:
            for k in range(1, n_views):
                frac = k / n_views
                sk_top = xa0 + frac * (xb0 - xa0)
                sk_bot = xa1 + frac * (xb1 - xa1)
                pen2 = QtGui.QPen(QtGui.QColor(255, 255, 0, 200), 1.2)
                pen2.setStyle(QtCore.Qt.PenStyle.DashLine)
                painter.setPen(pen2)
                painter.drawLine(QtCore.QPointF(X(sk_top), Y(y0)),
                                 QtCore.QPointF(X(sk_bot), Y(y1)))

    # 中心参考竖线
    pen = QtGui.QPen(QtGui.QColor(255, 60, 60, 220), 1.4)
    painter.setPen(pen)
    cx = X(spot.center_x)
    painter.drawLine(QtCore.QPointF(cx, 0), QtCore.QPointF(cx, big.height()))
    painter.end()
    return QtGui.QPixmap.fromImage(big)
