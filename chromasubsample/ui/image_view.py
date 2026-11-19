"""像素级图像视图: 整数倍最近邻放大, 不做任何平滑。

特性:
- 最近邻 (Qt::FastTransformation / 逐像素填充), 缩放量为 1..16 的整数倍
- 放大后绘制像素网格, 并在轴上标注取样坐标
- 4:2:2 / 4:2:0 色度平面叠加实际色度取样点标记 (偶数坐标)
- 鼠标框选测量区域; 水平/竖直剖面线
- 三个视图共享缩放与滚动, 保证同一区域像素级对齐
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QScrollArea, QSizePolicy, QWidget

from ..color import MODES


class PixelCanvas(QWidget):
    regionChanged = Signal(object)          # QRect|None
    hoverChanged = Signal(int, int)         # 图像坐标 x, y (-1,-1 表示移出)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._image: QImage | None = None
        self._zoom = 1
        self._grid = True
        self._show_samples = False
        self._sample_dims: tuple[int, int] | None = None  # 色度平面 (cw, ch)
        self._roi: QRect | None = None
        self._drag_start: QPoint | None = None
        self._hover = QPoint(-1, -1)
        self._profile_line: tuple[str, int] | None = None
        self.setMouseTracking(True)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)

    # ------------------------------------------------------------ 数据
    def set_image(self, rgb: np.ndarray):
        h, w = rgb.shape[:2]
        cont = np.ascontiguousarray(rgb)
        self._image = QImage(cont.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
        self._update_geometry()
        self.update()

    def set_zoom(self, zoom: int):
        self._zoom = max(1, int(zoom))
        self._update_geometry()
        self.update()

    def set_grid(self, on: bool):
        self._grid = on
        self.update()

    def set_sample_markers(self, on: bool, chroma_dims: tuple[int, int] | None):
        self._show_samples = on
        self._sample_dims = chroma_dims
        self.update()

    def set_roi(self, rect: QRect | None):
        self._roi = rect
        self.update()

    def roi(self) -> QRect | None:
        return QRect(self._roi) if self._roi else None

    def set_profile_line(self, orientation: str | None, position: int = -1):
        self._profile_line = (orientation, position) if orientation else None
        self.update()

    def zoom(self) -> int:
        return self._zoom

    # ------------------------------------------------------------ 几何
    def image_size(self) -> tuple[int, int]:
        if self._image is None:
            return 0, 0
        return self._image.width(), self._image.height()

    def _update_geometry(self):
        if self._image is None:
            return
        w, h = self._image.width(), self._image.height()
        self.resize(w * self._zoom, h * self._zoom)

    def _to_image_pos(self, pos: QPoint) -> QPoint:
        return QPoint(pos.x() // self._zoom, pos.y() // self._zoom)

    # ------------------------------------------------------------ 绘制
    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), Qt.GlobalColor.black)
        if self._image is None:
            return

        # 最近邻: 先整数倍缩放到 pixmap, 关闭平滑
        pix = QPixmap.fromImage(self._image)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        p.drawPixmap(0, 0, self.width(), self.height(), pix)

        z = self._zoom
        iw, ih = self.image_size()

        if self._grid and z >= 4:
            grid_pen = QPen(QColor(255, 255, 255, 55))
            grid_pen.setWidth(1)
            p.setPen(grid_pen)
            for x in range(0, iw + 1):
                p.drawLine(x * z, 0, x * z, ih * z)
            for y in range(0, ih + 1):
                p.drawLine(0, y * z, iw * z, y * z)

        # 色度取样点 (left / co-sited: 偶数像素位置); 点只画在网格可辨的缩放下
        if self._show_samples and self._sample_dims is not None and z >= 4:
            cw, ch = self._sample_dims
            pen = QPen(QColor(255, 210, 0))
            pen.setWidth(1)
            p.setPen(pen)
            p.setBrush(QColor(255, 210, 0, 70))
            r = max(1.0, z / 5.0)
            # 只标记可视区域内的样本, 避免全画面绘制造成卡顿与遮挡
            x0 = max(0, self.visibleRegion().boundingRect().left() // (2 * z) - 1)
            x1 = min(cw, self.visibleRegion().boundingRect().right() // (2 * z) + 2)
            y0 = max(0, self.visibleRegion().boundingRect().top() // (2 * z) - 1)
            y1 = min(ch, self.visibleRegion().boundingRect().bottom() // (2 * z) + 2)
            for cy in range(y0, y1):
                for cx in range(x0, x1):
                    px, py = cx * 2 * z + z // 2, cy * 2 * z + z // 2
                    p.drawEllipse(QPoint(px, py), r, r)

        # 坐标标注 (每 8 个像素标一次, 避免拥挤)
        if z >= 8:
            p.setPen(QColor(255, 255, 255, 180))
            font = p.font()
            font.setPixelSize(max(8, z // 2))
            p.setFont(font)
            step = 8
            for x in range(0, iw, step):
                p.drawText(x * z + 2, min(z, ih * z) - 2, str(x))
            for y in range(0, ih, step):
                p.drawText(2, y * z + font.pixelSize(), str(y))

        # 剖面线
        if self._profile_line is not None:
            orient, pos = self._profile_line
            pen = QPen(QColor(0, 255, 128))
            pen.setWidth(max(1, z // 6))
            p.setPen(pen)
            if orient == "h" and 0 <= pos < ih:
                p.drawLine(0, pos * z, iw * z, pos * z)
            elif orient == "v" and 0 <= pos < iw:
                p.drawLine(pos * z, 0, pos * z, ih * z)

        # ROI
        if self._roi is not None:
            r = QRect(self._roi.x() * z, self._roi.y() * z,
                      self._roi.width() * z, self._roi.height() * z)
            overlay = QColor(0, 150, 255, 45)
            p.fillRect(r, overlay)
            pen = QPen(QColor(0, 170, 255))
            pen.setWidth(max(1, z // 6))
            p.setPen(pen)
            p.drawRect(r)

        # 鼠标十字
        if self._hover.x() >= 0 and z >= 4:
            pen = QPen(QColor(255, 255, 255, 120))
            p.setPen(pen)
            hx, hy = self._hover.x() * z, self._hover.y() * z
            p.drawLine(hx, 0, hx, ih * z)
            p.drawLine(0, hy, iw * z, hy)

    # ------------------------------------------------------------ 鼠标
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self._image is not None:
            self._drag_start = self._to_image_pos(event.pos())
            self.set_roi(QRect(self._drag_start, self._drag_start).normalized())

    def mouseMoveEvent(self, event):
        if self._image is None:
            return
        ip = self._to_image_pos(event.pos())
        iw, ih = self.image_size()
        ip.setX(max(0, min(iw - 1, ip.x())))
        ip.setY(max(0, min(ih - 1, ip.y())))
        if ip != self._hover:
            self._hover = ip
            self.hoverChanged.emit(ip.x(), ip.y())
            self.update()
        if self._drag_start is not None:
            r = QRect(self._drag_start, ip).normalized()
            self.set_roi(r)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self._drag_start is not None:
            self._drag_start = None
            if self._roi is not None and (self._roi.width() < 2 or self._roi.height() < 2):
                self._roi = None
            self.regionChanged.emit(self.roi())


class PixelView(QScrollArea):
    """带标题的滚动像素视图, 对外发同步信号。"""

    hoverChanged = Signal(str, int, int)          # mode, x, y
    regionChanged = Signal(str, object)
    scrollMoved = Signal(int, int)

    def __init__(self, mode: str, parent=None):
        super().__init__(parent)
        self.mode = mode
        self.canvas = PixelCanvas()
        self.setWidget(self.canvas)
        self.setWidgetResizable(False)
        self.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.canvas.hoverChanged.connect(lambda x, y: self.hoverChanged.emit(self.mode, x, y))
        self.canvas.regionChanged.connect(lambda r: self.regionChanged.emit(self.mode, r))
        self.horizontalScrollBar().valueChanged.connect(self._emit_scroll)
        self.verticalScrollBar().valueChanged.connect(self._emit_scroll)

    def _emit_scroll(self):
        self.scrollMoved.emit(
            self.horizontalScrollBar().value(),
            self.verticalScrollBar().value(),
        )

    def sync_scroll(self, hx: int, vy: int):
        self.horizontalScrollBar().setValue(hx)
        self.verticalScrollBar().setValue(vy)

    # 透传常用接口
    def set_image(self, rgb): self.canvas.set_image(rgb)
    def set_zoom(self, z): self.canvas.set_zoom(z)
    def set_grid(self, on): self.canvas.set_grid(on)
    def set_sample_markers(self, on, dims): self.canvas.set_sample_markers(on, dims)
    def set_roi(self, r): self.canvas.set_roi(r)
    def roi(self): return self.canvas.roi()
    def set_profile_line(self, orient, pos=-1): self.canvas.set_profile_line(orient, pos)
    def zoom(self): return self.canvas.zoom()


def mode_title(mode: str, chroma_w: int, chroma_h: int,
               luma_w: int, luma_h: int, pix_fmt: str,
               chroma_location: str) -> str:
    label = {"444": "4:4:4", "422": "4:2:2", "420": "4:2:0"}[mode]
    return (f"{label}  {pix_fmt}\n"
            f"Y {luma_w}x{luma_h}   Cb/Cr {chroma_w}x{chroma_h}\n"
            f"chroma location: {chroma_location}")
