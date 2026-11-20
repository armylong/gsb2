"""图像视图组件：缩放平移下准确绘图、保护/删除路径叠加、分界对照与点选溯源。

坐标约定：所有笔迹事件先经 ``map_to_image`` 反算为**源图像素坐标**，
掩码始终以源图分辨率存储，因此无论怎样缩放平移，笔迹都与源图严格对齐。
"""

from __future__ import annotations

import cv2
import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QBrush,
    QColor,
    QImage,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
)
from PySide6.QtWidgets import QGraphicsView, QGraphicsScene

PROTECT_COLOR = QColor(255, 170, 0, 110)      # 橙色半透明：保护区
PROTECT_EDGE = QColor(255, 120, 0, 200)
SEAM_COLOR = QColor(255, 60, 90, 200)         # 红色：实际删除的像素路径
CROSS_COLOR = QColor(40, 220, 255)            # 青色：来源标记
CROSS_RESULT_COLOR = QColor(120, 255, 120)    # 绿色：结果端标记


def bgr_to_qpixmap(image: np.ndarray) -> QPixmap:
    """uint8 BGR (H,W,3) -> QPixmap。"""
    rgb = image[:, :, ::-1].copy()
    h, w = rgb.shape[:2]
    qimg = QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())


def mask_to_qpixmap(mask: np.ndarray, color: QColor) -> QPixmap:
    """bool 掩码 -> 同尺寸半透明彩色 QPixmap。"""
    h, w = mask.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[mask] = (color.red(), color.green(), color.blue(), color.alpha())
    qimg = QImage(rgba.data, w, h, 4 * w, QImage.Format.Format_RGBA8888)
    return QPixmap.fromImage(qimg.copy())


def seams_to_qpixmap(
    removed_points: list[tuple[int, int]], height: int, width: int
) -> QPixmap:
    """把已删除的 (row, source_col) 像素画成红色路径叠加图。"""
    mask = np.zeros((height, width), dtype=bool)
    for r, c in removed_points:
        mask[r, c] = True
    return mask_to_qpixmap(mask, SEAM_COLOR)


class ImageView(QGraphicsView):
    """可缩放平移、可在源图上画/擦保护区域的通用视图。"""

    imageClicked = Signal(int, int)  # 源图坐标 (x=列, y=行)
    maskEdited = Signal()            # 保护掩码被画笔修改

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(QPainter.RenderHint.Antialiasing)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setMouseTracking(True)

        self._image_pixmap: QPixmap | None = None
        self._mask: np.ndarray | None = None
        self._seam_pixmap: QPixmap | None = None
        self._brush_size = 18
        self._mode = "protect"            # protect | erase | pick | none
        self._panning = False
        self._drawing = False
        self._last_pos: QPointF | None = None
        self._pan_start = QPointF()
        self._marker: tuple[int, int] | None = None  # 源图坐标十字
        self._marker_color = CROSS_COLOR

    # ------------------------------------------------------------------ #
    # 数据装载
    # ------------------------------------------------------------------ #
    def set_image(self, image: np.ndarray, mask: np.ndarray | None = None) -> None:
        self._scene.clear()
        self._image_pixmap = bgr_to_qpixmap(image)
        self._scene.addPixmap(self._image_pixmap)
        h, w = image.shape[:2]
        self.setSceneRect(0, 0, w, h)
        if mask is None:
            mask = np.zeros((h, w), dtype=bool)
        self._mask = mask
        self._seam_pixmap = None
        self._marker = None
        self._build_overlays()
        self.fitInView(self.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def set_mask(self, mask: np.ndarray) -> None:
        self._mask = mask.copy()
        self._build_overlays()

    def set_removed_points(self, points, height, width) -> None:
        self._seam_pixmap = seams_to_qpixmap(points, height, width) if points else None
        self._build_overlays()

    def set_marker(self, x: int | None, y: int | None = None, result_side=False):
        if x is None:
            self._marker = None
        else:
            self._marker = (int(x), int(y))
            self._marker_color = CROSS_RESULT_COLOR if result_side else CROSS_COLOR
        self.viewport().update()

    def _build_overlays(self) -> None:
        """重画所有叠加层（底图不动）。"""
        if self._image_pixmap is None:
            return
        self._scene.clear()
        self._scene.addPixmap(self._image_pixmap)
        if self._mask is not None and self._mask.any():
            pm = mask_to_qpixmap(self._mask, PROTECT_COLOR)
            item = self._scene.addPixmap(pm)
            item.setOpacity(1.0)
            # 保护区描边：用掩码轮廓强化边界
            edge = self._mask.astype(np.uint8) * 255
            contours, _ = cv2.findContours(
                edge, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            pen = QPen(PROTECT_EDGE, 1.4)
            for cnt in contours:
                path = QPainterPath()
                pts = cnt.reshape(-1, 2)
                path.moveTo(float(pts[0][0]), float(pts[0][1]))
                for x, y in pts[1:]:
                    path.lineTo(float(x), float(y))
                path.closeSubpath()
                self._scene.addPath(path, pen)
        if self._seam_pixmap is not None:
            self._scene.addPixmap(self._seam_pixmap)

    # ------------------------------------------------------------------ #
    # 交互配置
    # ------------------------------------------------------------------ #
    def set_mode(self, mode: str) -> None:
        self._mode = mode
        if mode == "pick":
            self.setCursor(Qt.CursorShape.CrossCursor)
        elif mode in ("protect", "erase"):
            self.setCursor(Qt.CursorShape.BlankCursor)
        else:
            self.setCursor(Qt.CursorShape.ArrowCursor)

    def set_brush_size(self, size: int) -> None:
        self._brush_size = max(2, int(size))

    def fit_view(self) -> None:
        if self._image_pixmap is not None:
            self.fitInView(self.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def map_to_image(self, pos) -> tuple[float, float]:
        scene_pt = self.mapToScene(int(pos.x()), int(pos.y()))
        return scene_pt.x(), scene_pt.y()

    # ------------------------------------------------------------------ #
    # 鼠标 / 滚轮
    # ------------------------------------------------------------------ #
    def wheelEvent(self, event) -> None:
        if self._image_pixmap is None:
            return
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)

    def mousePressEvent(self, event) -> None:
        if self._image_pixmap is None:
            return
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton
            and event.modifiers() & Qt.KeyboardModifier.SpaceModifier
        ):
            self._panning = True
            self._pan_start = event.position()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        if event.button() == Qt.MouseButton.LeftButton:
            if self._mode == "pick":
                x, y = self.map_to_image(event.position())
                self.imageClicked.emit(int(round(x)), int(round(y)))
                return
            if self._mode in ("protect", "erase"):
                self._drawing = True
                self._last_pos = event.position()
                self._paint_stroke(event.position())
                return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._panning:
            delta = event.position() - self._pan_start
            self._pan_start = event.position()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - int(delta.x())
            )
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - int(delta.y())
            )
            return
        if self._drawing and self._mode in ("protect", "erase"):
            self._paint_stroke(event.position())
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.MiddleButton:
            self._panning = False
            self.set_mode(self._mode)
        elif event.button() == Qt.MouseButton.LeftButton:
            self._drawing = False
            self._last_pos = None
        super().mouseReleaseEvent(event)

    def _paint_stroke(self, pos) -> None:
        """把视图坐标的笔迹反算到源图，按圆形笔刷修改保护掩码。"""
        if self._mask is None:
            return
        before = int(self._mask.sum())
        x, y = self.map_to_image(pos)
        h, w = self._mask.shape
        if not (0 <= x < w and 0 <= y < h):
            self._last_pos = pos
            return
        value = self._mode == "protect"
        r = self._brush_size / 2.0
        if self._last_pos is not None:
            # 连线采样，避免快速拖动时笔迹断开
            lx, ly = self.map_to_image(self._last_pos)
            steps = max(
                int(np.hypot(x - lx, y - ly) / max(r * 0.5, 1.0)), 1
            )
            for t in np.linspace(0, 1, steps + 1):
                cx, cy = lx + (x - lx) * t, ly + (y - ly) * t
                self._stamp(cx, cy, r, value)
        else:
            self._stamp(x, y, r, value)
        self._last_pos = pos
        self._build_overlays()
        if int(self._mask.sum()) != before:
            self.maskEdited.emit()

    def _stamp(self, cx, cy, r, value) -> None:
        h, w = self._mask.shape
        x0 = max(0, int(np.floor(cx - r)))
        x1 = min(w, int(np.ceil(cx + r)))
        y0 = max(0, int(np.floor(cy - r)))
        y1 = min(h, int(np.ceil(cy + r)))
        if x0 >= x1 or y0 >= y1:
            return
        yy, xx = np.ogrid[y0:y1, x0:x1]
        disk = (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r
        self._mask[y0:y1, x0:x1][disk] = value

    def drawForeground(self, painter: QPainter, rect: QRectF) -> None:
        """画十字来源标记和跟随鼠标的笔刷圈。"""
        if self._marker is not None and self._image_pixmap is not None:
            x, y = self._marker
            if self.sceneRect().contains(QPointF(x + 0.5, y + 0.5)):
                pen = QPen(self._marker_color, 0)
                pen.setCosmetic(True)
                painter.setPen(pen)
                painter.drawLine(QPointF(x - 10, y + 0.5), QPointF(x + 11, y + 0.5))
                painter.drawLine(QPointF(x + 0.5, y - 10), QPointF(x + 0.5, y + 11))
                painter.setBrush(QBrush(self._marker_color))
                painter.drawEllipse(QPointF(x + 0.5, y + 0.5), 2.2, 2.2)
        if self._mode in ("protect", "erase") and self._image_pixmap is not None:
            pos = self.mapFromGlobal(self.cursor().pos())
            x, y = self.map_to_image(pos)
            if self.sceneRect().contains(QPointF(x, y)):
                color = QColor(255, 220, 0) if self._mode == "protect" else QColor(255, 90, 90)
                pen = QPen(color, 0)
                pen.setCosmetic(True)
                painter.setPen(pen)
                painter.setBrush(Qt.BrushStyle.NoBrush)
                painter.drawEllipse(QPointF(x, y), self._brush_size / 2, self._brush_size / 2)


class ResultView(ImageView):
    """结果视图：前后分界对照 + 点选结果像素溯源。

    分界左侧显示原图、右侧显示缩窄结果（结果顶部对齐，按相同视图缩放
    渲染），拖动滑条改变分界位置。点选右侧结果像素时通过
    ``resultPixelPicked`` 发出结果坐标，由主窗口用 source_index 溯源。
    """

    resultPixelPicked = Signal(int, int)   # 结果图坐标 (x=列, y=行)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._result_pixmap: QPixmap | None = None
        self._split = 1.0                  # 0=全原图, 1=全结果
        self.set_mode("pick")

    def set_result(self, result: np.ndarray) -> None:
        self._result_pixmap = bgr_to_qpixmap(result)
        self._split = 1.0

    def set_split(self, ratio: float) -> None:
        self._split = float(np.clip(ratio, 0.0, 1.0))
        self.viewport().update()

    def _draw_result(self, painter: QPainter) -> None:
        if self._result_pixmap is None:
            return
        # 分界 x 以场景坐标表示：结果与原图等高、顶对齐
        img_rect = self.sceneRect()
        cut_x = img_rect.width() * self._split
        painter.save()
        painter.setClipRect(QRectF(cut_x, 0, img_rect.width() - cut_x, img_rect.height()))
        painter.drawPixmap(0, 0, self._result_pixmap)
        painter.restore()
        # 分界线
        pen = QPen(QColor(255, 255, 255, 230), 0)
        pen.setCosmetic(True)
        painter.setPen(pen)
        painter.drawLine(QPointF(cut_x, 0), QPointF(cut_x, img_rect.height()))
        painter.setPen(QPen(QColor(20, 20, 20, 200), 0))
        painter.drawLine(QPointF(cut_x + 1, 0), QPointF(cut_x + 1, img_rect.height()))

    def drawForeground(self, painter: QPainter, rect: QRectF) -> None:
        self._draw_result(painter)
        super().drawForeground(painter, rect)

    def mousePressEvent(self, event) -> None:
        if (
            event.button() == Qt.MouseButton.LeftButton
            and self._mode == "pick"
            and self._result_pixmap is not None
        ):
            x, y = self.map_to_image(event.position())
            rw = self._result_pixmap.width()
            rh = self._result_pixmap.height()
            # 点在结果实际宽高范围内即按结果像素溯源（结果顶对齐、等缩放）
            if 0 <= x < rw and 0 <= y < rh:
                self.resultPixelPicked.emit(int(round(x)), int(round(y)))
                return
        super().mousePressEvent(event)
