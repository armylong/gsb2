"""视频显示组件: 保持比例的帧显示、无画面占位、可拖动分隔的叠合视图。"""
from __future__ import annotations

from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPixmap
from PySide6.QtWidgets import QWidget


class VideoView(QWidget):
    """单路画面: 等比缩放 QPixmap; 无帧时显示原因(绝不停在末帧)。"""

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.title = title
        self._pixmap: QPixmap | None = None
        self._blank_reason: str | None = "尚未载入"
        self.setMinimumSize(240, 180)
        self.setStyleSheet("background:#111;")

    def show_frame(self, pixmap: QPixmap | None, blank_reason: str | None) -> None:
        self._pixmap = pixmap
        self._blank_reason = blank_reason
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor("#111111"))
        painter.setPen(QColor("#9aa4b2"))
        painter.setFont(QFont("", 11, QFont.Weight.DemiBold))
        painter.drawText(
            self.rect().adjusted(8, 6, -8, -8),
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft,
            self.title,
        )

        if self._pixmap is not None and not self._pixmap.isNull():
            scaled = self._pixmap.scaled(
                self.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
            x = (self.width() - scaled.width()) // 2
            y = (self.height() - scaled.height()) // 2
            painter.drawPixmap(x, y, scaled)
        else:
            painter.setPen(QColor("#e06c6c"))
            painter.setFont(QFont("", 14, QFont.Weight.Medium))
            painter.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                f"无画面\n{self._blank_reason or ''}",
            )
        painter.end()


class OverlayView(QWidget):
    """叠合视图: A 铺满, B 以可拖动竖线为界做左右揭片(wiping)。

    分隔线比例由 MainWindow 持有, 与并排视图共用位置/偏移状态。
    """

    dividerChanged = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._a: QPixmap | None = None
        self._b: QPixmap | None = None
        self._b_blank: str | None = "尚未载入"
        self._divider = 0.5
        self._dragging = False
        self.setMouseTracking(True)
        self.setMinimumSize(320, 240)
        self.setStyleSheet("background:#111;")

    def set_pixmaps(self, a: QPixmap | None, b: QPixmap | None,
                    b_blank: str | None) -> None:
        self._a = a
        self._b = b
        self._b_blank = b_blank
        self.update()

    def set_divider(self, ratio: float) -> None:
        self._divider = min(1.0, max(0.0, ratio))
        self.update()

    def _scaled_rect(self) -> tuple[int, int, int, int]:
        # 两路统一在同一矩形内显示, 叠合时坐标可逐像素对齐
        if self._a is not None and not self._a.isNull():
            scaled = self._a.scaled(
                self.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
        else:
            scaled = self.size()
        x = (self.width() - scaled.width()) // 2
        y = (self.height() - scaled.height()) // 2
        return x, y, scaled.width(), scaled.height()

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor("#111111"))
        x, y, w, h = self._scaled_rect()
        split_x = x + int(self._divider * w)
        area = QRect(x, y, w, h)

        # A 铺满
        if self._a is not None and not self._a.isNull():
            painter.drawPixmap(area, self._a)
        else:
            painter.fillRect(area, QColor("#1b1b1d"))
            painter.setPen(QColor("#e06c6c"))
            painter.drawText(area, Qt.AlignmentFlag.AlignCenter, "A 无画面")

        # B 只画分隔线右侧(clip), 无帧时画原因
        painter.save()
        painter.setClipRect(QRect(split_x, y, x + w - split_x, h))
        if self._b is not None and not self._b.isNull():
            painter.drawPixmap(area, self._b)
        else:
            painter.fillRect(area, QColor("#222224"))
            painter.setPen(QColor("#e06c6c"))
            painter.drawText(
                area, Qt.AlignmentFlag.AlignCenter,
                f"B 无画面\n{self._b_blank or ''}",
            )
        painter.restore()

        # 分隔线
        painter.setPen(QColor("#ffd166"))
        painter.drawLine(split_x, y, split_x, y + h)
        painter.drawText(
            QRect(split_x - 30, y + 4, 60, 18),
            Qt.AlignmentFlag.AlignCenter, "拖我",
        )
        painter.end()

    def _update_divider(self, pos: QPoint) -> None:
        x, _y, w, _h = self._scaled_rect()
        if w <= 0:
            return
        ratio = min(1.0, max(0.0, (pos.x() - x) / w))
        if abs(ratio - self._divider) > 1e-4:
            self._divider = ratio
            self.dividerChanged.emit(ratio)
            self.update()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self._dragging = True
            self._update_divider(event.position().toPoint())

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._dragging:
            self._update_divider(event.position().toPoint())

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        self._dragging = False
