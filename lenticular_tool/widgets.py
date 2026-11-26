"""小部件: 占用比例堆叠条 + 可拖动观察位置的镜片示意图。"""
from __future__ import annotations

from PySide6 import QtCore, QtGui, QtWidgets
from PySide6.QtCore import Signal

from .params import VIEW_COLORS


class StackedBar(QtWidgets.QWidget):
    """按各视角像素占比绘制的堆叠条, 并标出理想等分线。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._counts: list[int] = []
        self._n = 0
        self.setMinimumHeight(34)
        self.setSizePolicy(QtWidgets.QSizePolicy.Policy.Expanding,
                           QtWidgets.QSizePolicy.Policy.Fixed)

    def set_data(self, counts: list[int], n_views: int) -> None:
        self._counts = list(counts)
        self._n = n_views
        self.update()

    def paintEvent(self, event) -> None:
        p = QtGui.QPainter(self)
        p.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing, False)
        r = self.rect().adjusted(2, 6, -2, -6)
        total = sum(self._counts)
        x = r.left()
        if total > 0:
            for vid, c in enumerate(self._counts):
                w = r.width() * c / total
                color = VIEW_COLORS[vid % len(VIEW_COLORS)]
                p.fillRect(QtCore.QRectF(x, r.top(), w, r.height()),
                           QtGui.QColor(*color))
                if w > 34:
                    p.setPen(QtGui.QColor(255, 255, 255))
                    f = p.font()
                    f.setPointSize(9)
                    f.setBold(True)
                    p.setFont(f)
                    p.drawText(QtCore.QRectF(x, r.top(), w, r.height()),
                               QtCore.Qt.AlignmentFlag.AlignCenter, str(c))
                x += w
        p.setPen(QtGui.QPen(QtGui.QColor(0, 0, 0, 160), 1))
        p.drawRect(r)

        # 理想等分虚线
        if self._n > 1:
            pen = QtGui.QPen(QtGui.QColor(255, 255, 255, 220), 1.2)
            pen.setStyle(QtCore.Qt.PenStyle.DashLine)
            p.setPen(pen)
            for k in range(1, self._n):
                xx = r.left() + r.width() * k / self._n
                p.drawLine(QtCore.QPointF(xx, r.top() - 3),
                           QtCore.QPointF(xx, r.bottom() + 3))
        p.end()


class LensSchematic(QtWidgets.QWidget):
    """一根镜条的横截面示意: N 个切片 + 可左右拖动的观察位置。

    发出 ``eyeChanged(phase 0..1)``。
    """

    eyeChanged = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._n = 3
        self._order: tuple[int, ...] = (0, 1, 2)
        self._phase = 0.18
        self._dragging = False
        self.setMinimumHeight(158)
        self.setMaximumHeight(180)
        self.setSizePolicy(QtWidgets.QSizePolicy.Policy.Expanding,
                           QtWidgets.QSizePolicy.Policy.Fixed)
        self.setMouseTracking(True)

    def set_model(self, n_views: int, order, phase: float) -> None:
        self._n = n_views
        self._order = tuple(order)
        self._phase = float(phase) % 1.0
        self.update()

    def set_phase(self, phase: float) -> None:
        self._phase = float(phase) % 1.0
        self.update()

    # -- 几何 -----------------------------------------------------------
    def _strip_rect(self) -> QtCore.QRectF:
        m_left, m_right = 44.0, 24.0
        top = 56.0
        h = 30.0
        return QtCore.QRectF(m_left, top,
                             max(10.0, self.width() - m_left - m_right), h)

    def _phase_to_x(self, phase: float) -> float:
        r = self._strip_rect()
        return r.left() + phase * r.width()

    def _x_to_phase(self, x: float) -> float:
        r = self._strip_rect()
        return min(1.0, max(0.0, (x - r.left()) / r.width()))

    # -- 鼠标 -----------------------------------------------------------
    def mousePressEvent(self, e: QtGui.QMouseEvent) -> None:
        if e.button() == QtCore.Qt.MouseButton.LeftButton:
            self._dragging = True
            self._update_from_pos(e.position())
            e.accept()

    def mouseMoveEvent(self, e: QtGui.QMouseEvent) -> None:
        if self._dragging:
            self._update_from_pos(e.position())
            e.accept()

    def mouseReleaseEvent(self, e: QtGui.QMouseEvent) -> None:
        self._dragging = False

    def _update_from_pos(self, pos: QtCore.QPointF) -> None:
        ph = self._x_to_phase(pos.x())
        if abs(ph - self._phase) > 1e-4:
            self._phase = ph
            self.update()
            self.eyeChanged.emit(ph)

    # -- 绘制 -----------------------------------------------------------
    def paintEvent(self, event) -> None:
        p = QtGui.QPainter(self)
        p.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), QtGui.QColor(248, 248, 250))

        r = self._strip_rect()
        n = self._n

        # 镜片穹顶(三次贝塞尔, 确定性地落在控件上部)
        dome_h = 40.0
        dome = QtGui.QPainterPath()
        dome.moveTo(r.left(), r.top() + 2)
        dome.cubicTo(r.left() + r.width() * 0.10, r.top() - dome_h * 1.7,
                     r.right() - r.width() * 0.10, r.top() - dome_h * 1.7,
                     r.right(), r.top() + 2)
        body = QtGui.QPainterPath(dome)
        body.lineTo(r.right(), r.bottom())
        body.lineTo(r.left(), r.bottom())
        body.closeSubpath()
        grad = QtGui.QLinearGradient(0, r.top() - dome_h, 0, r.bottom())
        grad.setColorAt(0, QtGui.QColor(150, 200, 255, 70))
        grad.setColorAt(1, QtGui.QColor(200, 225, 255, 28))
        p.setBrush(QtGui.QBrush(grad))
        p.setPen(QtCore.Qt.PenStyle.NoPen)
        p.drawPath(body)
        p.setBrush(QtCore.Qt.BrushStyle.NoBrush)
        p.setPen(QtGui.QPen(QtGui.QColor(70, 110, 170), 1.8))
        p.drawPath(dome)

        # N 个切片(按当前视图顺序着色)
        for k in range(n):
            x0 = r.left() + r.width() * k / n
            x1 = r.left() + r.width() * (k + 1) / n
            vid = self._order[k] if k < len(self._order) else k
            col = VIEW_COLORS[vid % len(VIEW_COLORS)]
            p.fillRect(QtCore.QRectF(x0, r.top(), x1 - x0, r.height()),
                       QtGui.QColor(col[0], col[1], col[2], 215))
            p.setPen(QtGui.QColor(255, 255, 255, 220))
            f = QtGui.QFont()
            f.setBold(True)
            f.setPointSize(11)
            p.setFont(f)
            p.drawText(QtCore.QRectF(x0, r.top(), x1 - x0, r.height()),
                       QtCore.Qt.AlignmentFlag.AlignCenter, str(vid + 1))
        p.setPen(QtGui.QPen(QtGui.QColor(40, 40, 40), 1.2))
        p.drawRect(r)

        # 相位刻度 0 .. 1
        p.setPen(QtGui.QColor(90, 90, 90))
        f = QtGui.QFont()
        f.setPointSize(8)
        p.setFont(f)
        for k in range(n + 1):
            x = r.left() + r.width() * k / n
            p.drawLine(QtCore.QPointF(x, r.bottom()),
                       QtCore.QPointF(x, r.bottom() + 5))
            if k in (0, n):
                p.drawText(QtCore.QRectF(x - 14, r.bottom() + 5, 28, 14),
                           QtCore.Qt.AlignmentFlag.AlignCenter,
                           "0" if k == 0 else "1")

        # 观察位置标线 + 顶部红色三角
        ex = self._phase_to_x(self._phase)
        pen = QtGui.QPen(QtGui.QColor(210, 30, 30), 2.0)
        p.setPen(pen)
        p.drawLine(QtCore.QPointF(ex, 20), QtCore.QPointF(ex, r.bottom() + 2))
        tri = QtGui.QPolygonF([
            QtCore.QPointF(ex - 7, 8),
            QtCore.QPointF(ex + 7, 8),
            QtCore.QPointF(ex, 19),
        ])
        p.setBrush(QtGui.QColor(210, 30, 30))
        p.setPen(QtCore.Qt.PenStyle.NoPen)
        p.drawPolygon(tri)
        # 相位数值(带白底, 避免与刻度数字打架)
        f2 = QtGui.QFont()
        f2.setPointSize(9)
        f2.setBold(True)
        p.setFont(f2)
        text = f"e={self._phase:.3f}"
        fm = QtGui.QFontMetrics(f2)
        tw = fm.horizontalAdvance(text) + 10
        tx = min(max(ex - tw / 2, 4.0), self.width() - tw - 4.0)
        p.setPen(QtCore.Qt.PenStyle.NoPen)
        p.setBrush(QtGui.QColor(255, 255, 255, 220))
        p.drawRoundedRect(QtCore.QRectF(tx, 100, tw, 17), 4, 4)
        p.setPen(QtGui.QColor(210, 30, 30))
        p.drawText(QtCore.QRectF(tx, 100, tw, 17),
                   QtCore.Qt.AlignmentFlag.AlignCenter, text)

        # 方向提示(允许换行, 窄面板不裁切)
        p.setPen(QtGui.QColor(110, 110, 110))
        f3 = QtGui.QFont()
        f3.setPointSize(9)
        p.setFont(f3)
        p.drawText(QtCore.QRectF(10, 124, self.width() - 20, 34),
                   QtCore.Qt.AlignmentFlag.AlignHCenter
                   | QtCore.Qt.AlignmentFlag.AlignTop
                   | QtCore.Qt.TextFlag.TextWordWrap,
                   "在镜片示意图上左右拖动红色标记改变观察位置；"
                   "用左侧视图顺序调换可立即反查观察方向是否颠倒。")
        p.end()
