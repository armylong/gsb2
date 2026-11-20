"""调墨曲线编辑器控件（容器 + 内部绘图画布）。

* 控制点拖动编辑，端点 (0,0)/(1,1) 固定不可删
* 双击空白处加点，右键/双击非端点控制点删点
* 鼠标移动给出同一输入 x 的 调整前->调整后 覆盖率读数
* 另附 gamma 快捷设置与线性复位按钮（文字按钮，不只靠颜色传达含义）
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (QDoubleSpinBox, QHBoxLayout, QLabel, QPushButton,
                               QSizePolicy, QVBoxLayout, QWidget)

from ..curves import ToneCurve

_MARGIN = 44


class _Plot(QWidget):
    def __init__(self, owner: "CurveEditor"):
        super().__init__()
        self.owner = owner
        self.setMinimumSize(220, 200)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)
        self.drag_idx = -1
        self.hover_x = -1.0

    def _plot_rect(self):
        return _MARGIN, _MARGIN, self.width() - _MARGIN - 10, self.height() - _MARGIN - 10

    def _to_widget(self, x: float, y: float) -> tuple[float, float]:
        x0, y0, x1, y1 = self._plot_rect()
        return x0 + x * (x1 - x0), y1 - y * (y1 - y0)

    def _to_data(self, px: float, py: float) -> tuple[float, float]:
        x0, y0, x1, y1 = self._plot_rect()
        x = (px - x0) / max(x1 - x0, 1)
        y = 1.0 - (py - y0) / max(y1 - y0, 1)
        return float(np.clip(x, 0, 1)), float(np.clip(y, 0, 1))

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        x0, y0, x1, y1 = self._plot_rect()
        p.fillRect(x0, y0, x1 - x0, y1 - y0, QColor("#ffffff"))
        pen = QPen(QColor("#d9d9d9"), 1)
        p.setPen(pen)
        for i in range(5):
            gx = x0 + i / 4 * (x1 - x0)
            gy = y0 + i / 4 * (y1 - y0)
            p.drawLine(int(gx), y0, int(gx), y1)
            p.drawLine(x0, int(gy), x1, int(gy))
        p.setPen(QColor("#555555"))
        for i in range(5):
            v = i / 4
            p.drawText(int(x0 + v * (x1 - x0)) - 12, y1 + 14, f"{v:.2f}")
            p.drawText(2, int(y1 - v * (y1 - y0)) + 4, f"{v:.2f}")
        p.drawText(x0, y0 - 14, "输入覆盖率（横轴）→  输出覆盖率（纵轴）↓")
        # 对角参考线
        p.setPen(QPen(QColor("#bbbbbb"), 1, Qt.DashLine))
        p.drawLine(x0, y1, x1, y0)
        # 曲线（身份色 = 该版墨色，配标题文字）
        q, fq = self.owner.curve().sample(200)
        p.setPen(QPen(self.owner.ink_color, 2))
        prev = None
        for xx, yy in zip(q, fq):
            pt = self._to_widget(xx, yy)
            if prev is not None:
                p.drawLine(int(prev[0]), int(prev[1]), int(pt[0]), int(pt[1]))
            prev = pt
        for kx, ky in self.owner.points:
            cx, cy = self._to_widget(kx, ky)
            p.setBrush(QColor("#ffffff"))
            p.setPen(QPen(self.owner.ink_color, 2))
            p.drawEllipse(int(cx) - 5, int(cy) - 5, 10, 10)
        if 0.0 <= self.hover_x <= 1.0:
            hx, _ = self._to_widget(self.hover_x, 0)
            p.setPen(QPen(QColor("#888888"), 1, Qt.DotLine))
            p.drawLine(int(hx), y0, int(hx), y1)
        p.end()

    def _hit(self, px, py) -> int:
        for i, (kx, ky) in enumerate(self.owner.points):
            cx, cy = self._to_widget(kx, ky)
            if (px - cx) ** 2 + (py - cy) ** 2 < 100:
                return i
        return -1

    def mousePressEvent(self, e):
        idx = self._hit(e.position().x(), e.position().y())
        if e.button() == Qt.LeftButton:
            self.drag_idx = idx
        elif e.button() == Qt.RightButton and idx not in (0, len(self.owner.points) - 1) and idx >= 0:
            del self.owner.points[idx]
            self.owner._emit()

    def mouseDoubleClickEvent(self, e):
        idx = self._hit(e.position().x(), e.position().y())
        if idx >= 0:
            if idx not in (0, len(self.owner.points) - 1):
                del self.owner.points[idx]
                self.owner._emit()
        else:
            x, y = self._to_data(e.position().x(), e.position().y())
            if 0.02 < x < 0.98:
                self.owner.points.append((x, y))
                self.owner.points.sort(key=lambda t: t[0])
                self.owner._emit()

    def mouseMoveEvent(self, e):
        x, _ = self._to_data(e.position().x(), e.position().y())
        self.hover_x = x
        if self.drag_idx >= 0:
            _, y = self._to_data(e.position().x(), e.position().y())
            pts = self.owner.points
            if self.drag_idx in (0, len(pts) - 1):
                fixed_x = pts[self.drag_idx][0]
                pts[self.drag_idx] = (fixed_x, y)
            else:
                x = min(max(x, 0.02), 0.98)
                pts[self.drag_idx] = (x, y)
                pts.sort(key=lambda t: t[0])
                self.drag_idx = next(i for i, k in enumerate(pts) if abs(k[0] - x) < 1e-9)
            self.owner._emit()
        out = float(self.owner.curve().apply(np.array([x]))[0])
        self.owner.probeText.emit(
            f"{self.owner.title}：输入覆盖率 {x:.3f} → 调整后 {out:.3f}（Δ={out - x:+.3f}）"
        )
        self.update()

    def mouseReleaseEvent(self, e):
        self.drag_idx = -1

    def leaveEvent(self, e):
        self.hover_x = -1.0
        self.update()


class CurveEditor(QWidget):
    changed = Signal(object)  # 发射 ToneCurve
    probeText = Signal(str)

    def __init__(self, title: str, ink_hex: str, parent=None):
        super().__init__(parent)
        self.title = title
        self.ink_color = QColor(ink_hex)
        self.points = list(ToneCurve.linear().knots)

        header = QLabel(title)
        f = QFont()
        f.setBold(True)
        header.setFont(f)

        self.gamma_spin = QDoubleSpinBox()
        self.gamma_spin.setRange(0.2, 3.0)
        self.gamma_spin.setSingleStep(0.05)
        self.gamma_spin.setValue(1.0)
        self.gamma_spin.setPrefix("γ=")
        self.gamma_spin.valueChanged.connect(self._apply_gamma)

        reset = QPushButton("线性复位")
        reset.clicked.connect(self._reset_linear)

        bar = QHBoxLayout()
        bar.addWidget(self.gamma_spin)
        bar.addWidget(reset)

        self.plot = _Plot(self)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)
        lay.addWidget(header)
        lay.addLayout(bar)
        lay.addWidget(self.plot, 1)

    def curve(self) -> ToneCurve:
        return ToneCurve(tuple((x, y) for x, y in self.points)).normalized()

    def set_curve(self, tc: ToneCurve) -> None:
        self.points = [tuple(k) for k in tc.normalized().knots]
        self.plot.update()

    def _emit(self) -> None:
        self.changed.emit(self.curve())
        self.plot.update()

    def _apply_gamma(self, g: float) -> None:
        self.set_curve(ToneCurve.gamma(float(g)))
        self._emit()

    def _reset_linear(self) -> None:
        self.gamma_spin.blockSignals(True)
        self.gamma_spin.setValue(1.0)
        self.gamma_spin.blockSignals(False)
        self.points = [(0.0, 0.0), (1.0, 1.0)]
        self._emit()
