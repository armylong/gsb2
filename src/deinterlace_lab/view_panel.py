"""三个对照视图共用的显示组件。

职责:
  - 全分辨率帧按窗口大小等比显示;
  - 共用同一个 ROI (源像素坐标的 QRect), 框选后只放大该区域用于检查梳齿,
    放大不改变任何输出尺寸;
  - 鼠标框选 ROI, 双击清除;
  - 底部显示该输出帧的时间/场来源标签。
"""
from __future__ import annotations

from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QLabel, QSizePolicy, QVBoxLayout, QWidget


class ViewPanel(QWidget):
    roiChanged = Signal()

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.title = title
        self._image: QImage | None = None
        self._roi: QRect | None = None
        self._zoom = 3
        self._label_text = ""
        self._drag_start: QPoint | None = None
        self._drag_rect: QRect | None = None

        self._title_label = QLabel(title)
        f = self._title_label.font()
        f.setBold(True)
        self._title_label.setFont(f)

        self._canvas = QLabel()
        self._canvas.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._canvas.setMinimumSize(220, 160)
        self._canvas.setSizePolicy(QSizePolicy.Policy.Expanding,
                                   QSizePolicy.Policy.Expanding)
        self._canvas.setStyleSheet("background:#111; border:1px solid #333;")
        self._canvas.setMouseTracking(True)

        self._info = QLabel("—")
        self._info.setWordWrap(True)
        self._info.setStyleSheet("color:#bbb; font-family:monospace;")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)
        lay.addWidget(self._title_label)
        lay.addWidget(self._canvas, 1)
        lay.addWidget(self._info)

        self._canvas.installEventFilter(self)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    # ---- 数据 ----
    def set_frame(self, image: QImage | None) -> None:
        self._image = image
        self._update_canvas()

    def set_info(self, text: str) -> None:
        self._label_text = text
        self._info.setText(text)

    def set_roi(self, roi: QRect | None) -> None:
        self._roi = QRect(roi) if roi else None
        self._update_canvas()

    def roi(self) -> QRect | None:
        return QRect(self._roi) if self._roi else None

    def set_zoom(self, factor: int) -> None:
        self._zoom = max(1, factor)
        self._update_canvas()

    # ---- 渲染 ----
    def _displayed_image_rect(self) -> QRect:
        """当前帧在 canvas 内的实际显示矩形 (letterbox 后)。"""
        if not self._image or self._image.isNull():
            return QRect()
        cw, ch = self._canvas.width(), self._canvas.height()
        iw, ih = self._image.width(), self._image.height()
        scale = min(cw / iw, ch / ih)
        dw, dh = max(1, int(iw * scale)), max(1, int(ih * scale))
        x = (cw - dw) // 2
        y = (ch - dh) // 2
        return QRect(x, y, dw, dh)

    def _update_canvas(self) -> None:
        if not self._image or self._image.isNull():
            self._canvas.setText("等待预渲染…")
            return
        canvas = QImage(self._canvas.size(), QImage.Format.Format_RGB888)
        canvas.fill(QColor(17, 17, 17))
        p = QPainter(canvas)
        target = self._displayed_image_rect()
        p.drawImage(target, self._image)

        if self._roi:
            # 在整帧上描出 ROI 框。
            disp = self._displayed_image_rect()
            scale_x = disp.width() / self._image.width()
            scale_y = disp.height() / self._image.height()
            r = QRect(
                int(disp.x() + self._roi.x() * scale_x),
                int(disp.y() + self._roi.y() * scale_y),
                int(self._roi.width() * scale_x),
                int(self._roi.height() * scale_y),
            )
            p.setPen(QPen(QColor(0, 230, 120), 2))
            p.drawRect(r)
        if self._drag_rect:
            p.setPen(QPen(QColor(255, 210, 60), 1))
            p.drawRect(self._drag_rect)
        p.end()
        self._canvas.setPixmap(QPixmap.fromImage(canvas))

        # 放大窗口: 独立的放大预览, 仅用于检查, 不回写输出。
        if self._roi:
            self._render_zoom()

    def _render_zoom(self) -> None:
        # 放大预览画在同一 canvas 右下角的浮层上。
        if not self._image or not self._roi:
            return
        crop = self._image.copy(self._roi)
        zw = min(self._canvas.width() - 20, self._roi.width() * self._zoom)
        zh = min(self._canvas.height() - 20, self._roi.height() * self._zoom)
        scaled = crop.scaled(zw, zh, Qt.AspectRatioMode.KeepAspectRatio,
                             Qt.TransformationMode.FastTransformation)
        canvas = self._canvas.pixmap().toImage()
        p = QPainter(canvas)
        x0 = self._canvas.width() - scaled.width() - 10
        y0 = self._canvas.height() - scaled.height() - 10
        p.fillRect(x0 - 4, y0 - 4, scaled.width() + 8, scaled.height() + 8,
                   QColor(0, 0, 0, 200))
        p.drawImage(x0, y0, scaled)
        p.setPen(QPen(QColor(0, 230, 120), 1))
        p.drawRect(x0 - 4, y0 - 4, scaled.width() + 8, scaled.height() + 8)
        p.end()
        self._canvas.setPixmap(QPixmap.fromImage(canvas))

    # ---- 鼠标: 框选 ROI ----
    def eventFilter(self, obj, event):  # noqa: N802
        if obj is not self._canvas or self._image is None:
            return super().eventFilter(obj, event)
        try:
            from PySide6.QtCore import QEvent
            t = event.type()
            if t == QEvent.Type.MouseButtonPress and event.button() == Qt.MouseButton.LeftButton:
                self.setFocus(Qt.FocusReason.MouseFocusReason)
                self._drag_start = event.position().toPoint()
                self._drag_rect = QRect(self._drag_start, self._drag_start)
                return True
            if t == QEvent.Type.MouseMove and self._drag_start is not None:
                self._drag_rect = QRect(self._drag_start, event.position().toPoint()).normalized()
                self._update_canvas()
                return True
            if t == QEvent.Type.MouseButtonDblClick:
                self._roi = None
                self.roiChanged.emit()
                self._update_canvas()
                return True
            if t == QEvent.Type.MouseButtonRelease and self._drag_start is not None:
                rect = self._drag_rect or QRect()
                self._drag_start = None
                self._drag_rect = None
                roi_src = self._canvas_to_source(rect)
                if roi_src and roi_src.width() >= 4 and roi_src.height() >= 4:
                    self._roi = roi_src
                    self.roiChanged.emit()
                self._update_canvas()
                return True
        except RuntimeError:
            # 窗口关闭过程中底层 C++ 对象可能已销毁。
            return False
        return super().eventFilter(obj, event)

    def _canvas_to_source(self, canvas_rect: QRect) -> QRect | None:
        disp = self._displayed_image_rect()
        if not disp or not self._image:
            return None
        inter = canvas_rect.intersected(disp)
        if inter.isEmpty():
            return None
        sx = self._image.width() / disp.width()
        sy = self._image.height() / disp.height()
        x = int((inter.x() - disp.x()) * sx)
        y = int((inter.y() - disp.y()) * sy)
        w = max(1, int(inter.width() * sx))
        h = max(1, int(inter.height() * sy))
        return QRect(x, y, w, h).intersected(
            QRect(0, 0, self._image.width(), self._image.height())
        )

    def resizeEvent(self, event):  # noqa: N802
        super().resizeEvent(event)
        self._update_canvas()
