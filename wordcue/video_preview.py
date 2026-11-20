"""视频预览: 用与导出完全相同的 ``FrameRenderer`` 绘制当前播放位置.  """

from __future__ import annotations

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QSizePolicy, QWidget

from .export import FrameRenderer
from .model import Timeline


class VideoPreview(QWidget):
    """9:16 竖屏预览。画面比例固定, 只在有足够空间时显示。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.timeline = Timeline()
        self.renderer = FrameRenderer(self.timeline, 540, 960)
        self.position_ms = 0
        self._image: QImage | None = None
        self._last_ms: int | None = None
        self.setMinimumWidth(160)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Expanding)

    def set_timeline(self, timeline: Timeline) -> None:
        self.timeline = timeline
        self.renderer = FrameRenderer(timeline, 540, 960)
        self._image = None
        self._last_ms = None
        self.update()

    def set_position(self, ms: int) -> None:
        self.position_ms = ms
        if self._last_ms != ms:
            self._last_ms = ms
            self._image = None
            self.update()

    def _target_rect(self) -> QRectF:
        w = min(self.width() - 8, (self.height() - 8) * 9 / 16)
        h = w * 16 / 9
        return QRectF((self.width() - w) / 2, (self.height() - h) / 2, w, h)

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#0A0D11"))
        target = self._target_rect()
        if target.width() < 20:
            p.end()
            return
        if self._image is None:
            self._image = self.renderer.render(self.position_ms)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        p.drawImage(target, self._image)
        p.setPen(QColor("#2A3442"))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(target)
        p.end()

    def sizeHint(self) -> QSize:  # noqa: N802
        return QSize(240, 420)
