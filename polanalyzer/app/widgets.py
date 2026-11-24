"""自定义 Qt 部件: 可缩放/取点的图像视图与角度曲线画布."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal, QPointF
from PySide6.QtGui import QImage, QPixmap, QPen, QColor
from PySide6.QtWidgets import QGraphicsView, QGraphicsScene, QGraphicsPixmapItem, QGraphicsLineItem

import matplotlib
matplotlib.use("QtAgg")
from matplotlib import rcParams
from matplotlib.figure import Figure
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas

# 中文标签字体回退 (macOS / Windows / Linux 常见 CJK 字体)
rcParams["font.sans-serif"] = [
    "PingFang SC", "Hiragino Sans GB", "Arial Unicode MS", "Heiti SC",
    "Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "DejaVu Sans",
]
rcParams["axes.unicode_minus"] = False


def ndarray_to_qpixmap(rgb: np.ndarray) -> QPixmap:
    """RGB uint8 -> QPixmap (必须 copy, numpy 缓冲可能被回收)."""
    rgb = np.ascontiguousarray(rgb)
    h, w = rgb.shape[:2]
    img = QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
    return QPixmap.fromImage(img)


class ImageView(QGraphicsView):
    """支持滚轮缩放、拖拽平移、悬停/取点的图像视图."""

    hovered = Signal(int, int)
    picked = Signal(int, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self._pixmap_item = QGraphicsPixmapItem()
        self._scene.addItem(self._pixmap_item)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setMouseTracking(True)
        self._w = self._h = 0
        self._first = True
        self._press_pos: QPointF | None = None

        pen = QPen(QColor(0, 255, 255))
        pen.setWidth(0)
        pen.setCosmetic(True)
        self._ch_h = QGraphicsLineItem()
        self._ch_v = QGraphicsLineItem()
        for item in (self._ch_h, self._ch_v):
            item.setPen(pen)
            item.setVisible(False)
            item.setZValue(10)
            self._scene.addItem(item)
        self._probe: tuple[int, int] | None = None

    def set_image(self, rgb: np.ndarray):
        pm = ndarray_to_qpixmap(rgb)
        self._pixmap_item.setPixmap(pm)
        self._h, self._w = rgb.shape[:2]
        self.setSceneRect(0, 0, self._w, self._h)
        if self._first:
            self.fitInView(self._pixmap_item, Qt.AspectRatioMode.KeepAspectRatio)
            self._first = False
        self._update_crosshair()

    def reset_view(self):
        self._first = True
        if self._w:
            self.fitInView(self._pixmap_item, Qt.AspectRatioMode.KeepAspectRatio)

    def set_probe(self, xy: tuple[int, int] | None):
        self._probe = xy
        self._update_crosshair()

    def _update_crosshair(self):
        if not self._probe or not self._w:
            for item in (self._ch_h, self._ch_v):
                item.setVisible(False)
            return
        x, y = self._probe
        self._ch_h.setLine(0, y + 0.5, self._w, y + 0.5)
        self._ch_v.setLine(x + 0.5, 0, x + 0.5, self._h)
        self._ch_h.setVisible(True)
        self._ch_v.setVisible(True)

    def wheelEvent(self, event):
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)

    def _scene_xy(self, event) -> tuple[int, int] | None:
        if not self._w:
            return None
        p = self.mapToScene(event.position().toPoint())
        x, y = int(np.floor(p.x())), int(np.floor(p.y()))
        if 0 <= x < self._w and 0 <= y < self._h:
            return x, y
        return None

    def mouseMoveEvent(self, event):
        xy = self._scene_xy(event)
        if xy is not None:
            self.hovered.emit(*xy)
        super().mouseMoveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_pos = event.position()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self._press_pos is not None:
            moved = (event.position() - self._press_pos).manhattanLength()
            self._press_pos = None
            if moved < 4:
                xy = self._scene_xy(event)
                if xy is not None:
                    self.picked.emit(*xy)
        super().mouseReleaseEvent(event)

    def resizeEvent(self, event):
        if self._first and self._w:
            self.fitInView(self._pixmap_item, Qt.AspectRatioMode.KeepAspectRatio)
        super().resizeEvent(event)


class CurveCanvas(FigureCanvas):
    """固定点亮度随滤镜角度变化的曲线: 拟合曲线 + 四点实测 + 当前角度."""

    def __init__(self, parent=None):
        self.fig = Figure(figsize=(5, 2.6), tight_layout=True)
        super().__init__(self.fig)
        self.setParent(parent)
        self.ax = self.fig.add_subplot(111)
        self._vline = None

    def plot_probe(self, fit, x: int, y: int, current_theta: float):
        ax = self.ax
        ax.clear()
        grid = np.arange(0.0, 180.0 + 1e-9, 0.5)
        t = np.deg2rad(grid)
        curve = fit.A[y, x] + fit.B[y, x] * np.cos(2 * t) + fit.C[y, x] * np.sin(2 * t)
        ax.plot(grid, curve, "-", color="#1f6feb", lw=1.6, label="马吕斯拟合")
        ax.plot(fit.angles, fit.lum[:, y, x], "o", ms=8, color="#d1242f",
                mfc="none", mew=1.8, label="实测四点")

        phi = fit.phi[y, x]
        ax.axvline(phi, color="#2da44e", ls="--", lw=1, alpha=0.8)
        ax.axvline((phi + 90) % 180, color="#bf8700", ls=":", lw=1, alpha=0.8)
        ax.annotate(f"亮 {phi:.1f}°", xy=(phi, 1.02), xycoords=("data", "axes fraction"),
                    color="#2da44e", fontsize=8, ha="center")
        ax.annotate(f"暗 {(phi + 90) % 180:.1f}°", xy=((phi + 90) % 180, 1.02),
                    xycoords=("data", "axes fraction"), color="#bf8700", fontsize=8, ha="center")

        self._vline = ax.axvline(current_theta, color="#8250df", lw=1.2, alpha=0.9,
                                 label=f"当前 {current_theta:.1f}°")
        ax.set_xlim(0, 180)
        ax.set_xlabel("滤镜角度 (°)")
        ax.set_ylabel("归一化亮度")
        ax.grid(alpha=0.25)
        ax.legend(fontsize=7, loc="upper right", ncol=2)
        cat = fit.category_at(y, x)
        ax.set_title(
            f"({x}, {y})  A={fit.A[y, x]:.4f}  R={fit.R[y, x]:.4f}  "
            f"ρ={fit.rho[y, x]:.3f}  φ={fit.phi[y, x]:.1f}°  类别: {cat}",
            fontsize=9,
        )
        self.draw_idle()

    def update_vline(self, theta: float):
        if self._vline is not None:
            self._vline.set_xdata([theta, theta])
            self.draw_idle()
