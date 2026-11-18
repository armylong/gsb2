"""预览画布。

负责两件坐标空间的严格换算:
* 输出画布坐标: 720p 实际像素, 关键帧存的就是这个空间的左上角;
* 显示坐标: 窗口按 ``fit`` 等比缩放后的像素, 只影响显示, 不影响数据。

拖动叠加层时把显示坐标换算回画布坐标并夹到合法范围(必须完整留在画布内),
松手才 upsert 关键帧, 避免拖动中途产生大量中间点。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QImage, QMouseEvent, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..composite import render_frame
from ..model import Project


class CanvasView(QWidget):
    """显示当前帧合成结果并支持拖动叠加层。"""

    position_committed = Signal(int, int, int)  # frame, x, y(松手时)
    position_dragging = Signal(int, int)  # x, y(拖动过程实时显示)

    def __init__(self) -> None:
        super().__init__()
        self._project: Project | None = None
        self._bg: np.ndarray | None = None
        self._ov: np.ndarray | None = None
        self._frame = 0
        self._scale = 1.0
        self._offset_x = 0
        self._offset_y = 0
        self._pixmap: QPixmap | None = None
        # 拖动中的临时画布坐标; None 表示未在拖。
        self._drag_pos: tuple[int, int] | None = None
        self._drag_moved = False
        self.setMinimumSize(480, 270)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    # ------------------------------------------------------------- data input
    def set_project(self, project: Project) -> None:
        self._project = project
        self._drag_pos = None
        self.update()

    def show_frame(self, frame: int, bg: np.ndarray | None,
                   ov: np.ndarray | None) -> None:
        self._frame = frame
        self._bg = bg
        self._ov = ov
        self._rebuild_pixmap()
        self.update()

    # ------------------------------------------------------------- coordinate
    def _compute_geometry(self) -> None:
        if self._project is None:
            self._scale = 1.0
            self._offset_x = self._offset_y = 0
            return
        cw, ch = self._project.canvas_w, self._project.canvas_h
        avail_w = max(1, self.width() - 4)
        avail_h = max(1, self.height() - 4)
        self._scale = min(avail_w / cw, avail_h / ch)
        draw_w, draw_h = cw * self._scale, ch * self._scale
        self._offset_x = (self.width() - draw_w) / 2
        self._offset_y = (self.height() - draw_h) / 2

    def canvas_to_display(self, x: float, y: float) -> tuple[float, float]:
        return (
            self._offset_x + x * self._scale,
            self._offset_y + y * self._scale,
        )

    def display_to_canvas(self, px: float, py: float) -> tuple[float, float]:
        return (
            (px - self._offset_x) / self._scale,
            (py - self._offset_y) / self._scale,
        )

    def current_canvas_pos(self) -> tuple[int, int] | None:
        """当前帧叠加层左上角的画布坐标(拖动中用临时值)。"""

        if self._project is None or not self._project.keyframes:
            return None
        if self._drag_pos is not None:
            return self._drag_pos
        if not self._project.overlay_visible(self._frame):
            return None
        return self._project.position_at(self._frame)

    # ---------------------------------------------------------------- painting
    def _rebuild_pixmap(self) -> None:
        if self._project is None or self._bg is None:
            self._pixmap = None
            return
        composited = render_frame(self._project, self._frame, self._bg, self._ov)
        h, w, _ = composited.shape
        img = QImage(composited.data, w, h, 3 * w, QImage.Format.Format_RGB888)
        # copy(): 数据来自 numpy 临时数组, 必须拷贝脱离其生命周期。
        self._pixmap = QPixmap.fromImage(img.copy())

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.GlobalColor.black)
        self._compute_geometry()
        if self._pixmap is None or self._project is None:
            painter.setPen(Qt.GlobalColor.gray)
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                             "导入背景与叠加视频后在此预览")
            return

        cw, ch = self._project.canvas_w, self._project.canvas_h
        dw, dh = cw * self._scale, ch * self._scale
        target_rect = self._pixmap.rect()
        painter.drawPixmap(
            int(self._offset_x), int(self._offset_y),
            int(dw), int(dh), self._pixmap,
            target_rect.x(), target_rect.y(), target_rect.width(),
            target_rect.height(),
        )
        self._paint_overlay_chrome(painter)

    def _paint_overlay_chrome(self, painter: QPainter) -> None:
        """画拖动框与辅助线(仅预览, 导出不烧入)。"""

        pos = self.current_canvas_pos()
        if pos is None:
            return
        x, y = pos
        xd, yd = self.canvas_to_display(x, y)
        wd = self._project.overlay_w * self._scale
        hd = self._project.overlay_h * self._scale

        # 画布中线辅助线。
        cw, ch = self._project.canvas_w, self._project.canvas_h
        guide_pen = QPen(Qt.GlobalColor.cyan, 1, Qt.PenStyle.DashLine)
        painter.setPen(guide_pen)
        cx, _ = self.canvas_to_display(self._project.canvas_w / 2, 0)
        _, cy = self.canvas_to_display(0, self._project.canvas_h / 2)
        painter.drawLine(int(cx), int(self._offset_y),
                         int(cx), int(self._offset_y + ch * self._scale))
        painter.drawLine(int(self._offset_x), int(cy),
                         int(self._offset_x + cw * self._scale), int(cy))

        # 拖动框(黄色) + 左上定位点。
        pen = QPen(Qt.GlobalColor.yellow, 2)
        painter.setPen(pen)
        painter.drawRect(int(xd), int(yd), int(wd), int(hd))
        painter.fillRect(int(xd) - 3, int(yd) - 3, 7, 7, Qt.GlobalColor.yellow)

    # ------------------------------------------------------------------ mouse
    def _overlay_rect_display(self):
        pos = self.current_canvas_pos()
        if pos is None:
            return None
        x, y = pos
        xd, yd = self.canvas_to_display(x, y)
        return (xd, yd,
                self._project.overlay_w * self._scale,
                self._project.overlay_h * self._scale)

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton:
            return
        rect = self._overlay_rect_display()
        if rect is None or self._project is None:
            return
        xd, yd, wd, hd = rect
        if not (xd <= event.position().x() <= xd + wd
                and yd <= event.position().y() <= yd + hd):
            return
        # 记录鼠标与叠加层左上角的显示空间偏移, 拖动手感稳定。
        self._grab_dx = event.position().x() - xd
        self._grab_dy = event.position().y() - yd
        self._drag_pos = self.current_canvas_pos()
        self._drag_moved = False
        self.setCursor(Qt.CursorShape.ClosedHandCursor)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._drag_pos is None or self._project is None:
            if self._overlay_rect_display() is not None:
                self.setCursor(Qt.CursorShape.OpenHandCursor)
            else:
                self.setCursor(Qt.CursorShape.ArrowCursor)
            return
        cx, cy = self.display_to_canvas(
            event.position().x() - self._grab_dx,
            event.position().y() - self._grab_dy,
        )
        clamped = self._project.clamp_position(cx, cy)
        self._drag_pos = clamped
        self._drag_moved = True
        self.position_dragging.emit(*clamped)
        self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton or self._drag_pos is None:
            return
        pos = self._drag_pos
        moved = self._drag_moved
        self._drag_pos = None
        self.setCursor(Qt.CursorShape.OpenHandCursor)
        if moved:
            # 关键规则: 拖动当前时间的叠加层 => 创建或更新该时刻关键帧。
            self.position_committed.emit(self._frame, pos[0], pos[1])
        self.update()

    # -------------------------------------------------------------- keyboard
    def keyPressEvent(self, event) -> None:  # noqa: N802
        # 方向键逐像素微调当前帧关键帧(不存在则先落到插值位置再建点)。
        delta = {
            Qt.Key.Key_Left: (-1, 0), Qt.Key.Key_Right: (1, 0),
            Qt.Key.Key_Up: (0, -1), Qt.Key.Key_Down: (0, 1),
        }.get(event.key())
        if delta is None or self._project is None:
            super().keyPressEvent(event)
            return
        base = self.current_canvas_pos()
        # 叠加层在该帧已结束时不存在可定位的窗口, 不建点。
        if base is None or not self._project.overlay_visible(self._frame):
            super().keyPressEvent(event)
            return
        x, y = self._project.clamp_position(
            base[0] + delta[0], base[1] + delta[1]
        )
        self.position_committed.emit(self._frame, x, y)
