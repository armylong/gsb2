"""GUI 组件：视频画面（框选/像素高亮）与示波图（渲染/点击反查）。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen
from PySide6.QtWidgets import QWidget


def rgb_to_qimage(R, G, B) -> QImage:
    h, w = R.shape
    buf = np.empty((h, w, 4), np.uint8)
    buf[..., 0] = R
    buf[..., 1] = G
    buf[..., 2] = B
    buf[..., 3] = 255
    return QImage(buf.data, w, h, w * 4, QImage.Format_RGBA8888).copy()


def waveform_to_qimage(wf: np.ndarray, tint=(200, 200, 200)) -> QImage:
    """(256, W) 波形 -> QImage，电平 255 在上方，对数亮度。"""
    a = np.log1p(wf[::-1])  # 翻转：高电平在上
    m = a.max()
    if m > 0:
        a = a / m
    h, w = a.shape
    buf = np.zeros((h, w, 4), np.uint8)
    for k in range(3):
        buf[..., k] = (a * tint[k]).astype(np.uint8)
    buf[..., 3] = np.clip(a * 1.6 * 255.0, 0, 255).astype(np.uint8)
    return QImage(buf.data, w, h, w * 4, QImage.Format_RGBA8888).copy()


def parade_to_qimage(parade, out_w_each: int) -> QImage:
    """三段分量拼成一张图，段间留 4px 分隔。"""
    gap = np.zeros((256, 4), np.float32)
    full = np.concatenate(
        [parade[0], gap, parade[1], gap, parade[2]], axis=1)
    a = np.log1p(full[::-1])
    m = a.max()
    if m > 0:
        a = a / m
    h, w = a.shape
    buf = np.zeros((h, w, 4), np.uint8)
    seg = out_w_each + 4
    for k, off in enumerate((0, seg, 2 * seg)):
        ch = np.zeros_like(a)
        ch[:, off: off + out_w_each] = a[:, off: off + out_w_each]
        buf[..., k] = np.clip(ch * 1.6 * 255.0, 0, 255).astype(np.uint8)
    buf[..., 3] = np.clip(a * 1.6 * 255.0, 0, 255).astype(np.uint8)
    return QImage(buf.data, w, h, w * 4, QImage.Format_RGBA8888).copy()


# ---------------------------------------------------------------- 视频画面

class VideoWidget(QWidget):
    """显示当前帧；左键拖出 ROI（图像坐标）；可叠加点击反查的像素高亮。"""

    roiSelected = Signal(object)  # (x0,y0,x1,y1) 图像坐标，或 None 表示清除

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(480, 270)
        self._img: QImage | None = None
        self._hl: QImage | None = None       # 高亮掩码（与帧同尺寸）
        self._roi_img: QRect | None = None   # 图像坐标
        self._drag: QPoint | None = None
        self._cur: QPoint | None = None

    # -- 数据 ----------------------------------------------------------
    def set_frame(self, img: QImage):
        self._img = img
        self.update()

    def set_highlight(self, mask: np.ndarray | None):
        if mask is None:
            self._hl = None
        else:
            h, w = mask.shape
            buf = np.zeros((h, w, 4), np.uint8)
            buf[mask] = (255, 0, 255, 170)  # 品红高亮
            self._hl = QImage(buf.data, w, h, w * 4,
                              QImage.Format_RGBA8888).copy()
        self.update()

    def set_roi(self, rect: QRect | None):
        self._roi_img = rect
        self.update()

    # -- 坐标映射 ------------------------------------------------------
    def _target_rect(self) -> QRect:
        if self._img is None:
            return self.rect()
        iw, ih = self._img.width(), self._img.height()
        s = min(self.width() / iw, self.height() / ih)
        tw, th = int(iw * s), int(ih * s)
        return QRect((self.width() - tw) // 2, (self.height() - th) // 2, tw, th)

    def _to_image(self, pos: QPoint) -> QPoint:
        t = self._target_rect()
        iw, ih = self._img.width(), self._img.height()
        x = int((pos.x() - t.x()) * iw / max(1, t.width()))
        y = int((pos.y() - t.y()) * ih / max(1, t.height()))
        return QPoint(max(0, min(iw - 1, x)), max(0, min(ih - 1, y)))

    # -- 事件 ----------------------------------------------------------
    def mousePressEvent(self, e):
        if self._img is not None and e.button() == Qt.LeftButton:
            self._drag = self._to_image(e.position().toPoint())
            self._cur = self._drag
        elif e.button() == Qt.RightButton:
            self._roi_img = None
            self.roiSelected.emit(None)
            self.update()

    def mouseMoveEvent(self, e):
        if self._drag is not None:
            self._cur = self._to_image(e.position().toPoint())
            self.update()

    def mouseReleaseEvent(self, e):
        if self._drag is not None and e.button() == Qt.LeftButton:
            p0, p1 = self._drag, self._to_image(e.position().toPoint())
            self._drag = None
            x0, x1 = sorted((p0.x(), p1.x()))
            y0, y1 = sorted((p0.y(), p1.y()))
            if x1 - x0 >= 3 and y1 - y0 >= 3:
                self._roi_img = QRect(x0, y0, x1 - x0, y1 - y0)
                self.roiSelected.emit((x0, y0, x1 + 1, y1 + 1))
            self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(24, 24, 24))
        if self._img is None:
            p.setPen(QColor(160, 160, 160))
            p.drawText(self.rect(), Qt.AlignCenter,
                       "打开本地短片，或选择一个内置样片")
            p.end()
            return
        t = self._target_rect()
        p.drawImage(t, self._img)
        if self._hl is not None:
            p.drawImage(t, self._hl)
        pen = QPen(QColor(0, 220, 255))
        pen.setWidth(1)
        p.setPen(pen)
        if self._drag is not None and self._cur is not None:
            r = self._img_rect_to_widget(QRect(self._drag, self._cur).normalized())
            p.drawRect(r)
        elif self._roi_img is not None:
            p.drawRect(self._img_rect_to_widget(self._roi_img))
        p.end()

    def _img_rect_to_widget(self, r: QRect) -> QRect:
        t = self._target_rect()
        iw, ih = self._img.width(), self._img.height()
        sx = t.width() / iw
        sy = t.height() / ih
        return QRect(int(t.x() + r.x() * sx), int(t.y() + r.y() * sy),
                     max(1, int(r.width() * sx)), max(1, int(r.height() * sy)))


# ---------------------------------------------------------------- 示波图

class ScopeWidget(QWidget):
    """渲染一张示波图（可叠加对照快照），点击发出 (全图列, 电平) 或 (通道, 全图列, 电平)。"""

    clicked = Signal(int, int)        # luma 模式: (全图列, 电平)
    clickedParade = Signal(int, int, int)  # parade 模式: (通道0/1/2, 全图列, 电平)

    def __init__(self, mode="luma", frame_width=640, parent=None):
        super().__init__(parent)
        self.mode = mode              # 'luma' | 'parade'
        self.frame_width = frame_width
        self._img: QImage | None = None
        self._snap: QImage | None = None
        self._snap_label = ""
        self.setMinimumHeight(180)

    def set_scope(self, img: QImage | None, frame_width: int):
        self._img = img
        self.frame_width = frame_width
        self.update()

    def set_snapshot(self, img: QImage | None, label: str = ""):
        self._snap = img
        self._snap_label = label
        self.update()

    def mousePressEvent(self, e):
        if self._img is None or e.button() != Qt.LeftButton:
            return
        pos = e.position()
        fx = int(pos.x() / max(1, self.width()) * self.frame_width)
        level = 255 - int(pos.y() / max(1, self.height()) * 256)
        level = max(0, min(255, level))
        if self.mode == "luma":
            self.clicked.emit(fx, level)
        else:
            third = self.width() / 3.0
            ch = min(2, int(pos.x() / third))
            fx = int((pos.x() - ch * third) / third * self.frame_width)
            self.clickedParade.emit(ch, max(0, min(self.frame_width - 1, fx)), level)

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(16, 16, 16))
        if self._img is None:
            p.setPen(QColor(140, 140, 140))
            p.drawText(self.rect(), Qt.AlignCenter, "无数据")
            p.end()
            return
        # 电平参考线：0/64/128/192/255
        p.setPen(QPen(QColor(60, 60, 60)))
        for lv in (0, 64, 128, 192, 255):
            y = int(self.height() * (255 - lv) / 255.0)
            p.drawLine(0, y, self.width(), y)
            p.setPen(QColor(110, 110, 110))
            p.drawText(4, y + 12, str(lv))
            p.setPen(QPen(QColor(60, 60, 60)))
        if self._snap is not None:
            p.setOpacity(0.35)
            p.drawImage(self.rect(), self._snap)
            p.setOpacity(1.0)
        p.drawImage(self.rect(), self._img)
        if self.mode == "parade":
            p.setPen(QColor(200, 200, 200))
            for k, name in enumerate(("R", "G", "B")):
                p.drawText(int((k + 0.02) * self.width() / 3), 16, name)
        if self._snap is not None and self._snap_label:
            p.setPen(QColor(255, 200, 80))
            p.drawText(self.rect().adjusted(6, 4, -6, -4),
                       Qt.AlignRight | Qt.AlignTop, self._snap_label)
        p.end()
