"""Canvas widgets for the four preview panels.

Every panel renders a BGR numpy frame through a shared helper, so scaling and
overlay drawing behave the same in all of them.  Overlays use plain OpenCV
drawing; the canvas only handles fitting and the frame/interval label.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QSizePolicy, QWidget

# Overlay palette (BGR) - chosen for legibility on photographic texture.
C_WINDOW = (235, 205, 60)      # window / scope brackets
C_CURRENT = (255, 255, 255)    # current-frame tick
C_TRAIL = (90, 220, 255)       # motion trail points
C_MASK = (60, 200, 120)        # moving region contour
C_CUT = (40, 190, 250)         # cut banner


def bgr_to_qimage(frame: np.ndarray) -> QImage:
    if frame.ndim == 2:
        frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    return QImage(rgb.data, w, h, rgb.strides[0], QImage.Format_RGB888).copy()


@dataclass
class PanelLabel:
    title: str
    subtitle: str = ""


class Canvas(QWidget):
    """Draws one BGR frame, letterboxed, with a corner caption."""

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self._title = title
        self._subtitle = ""
        self._frame: np.ndarray | None = None
        self._image: QImage | None = None
        self.setMinimumSize(240, 150)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setAttribute(Qt.WA_OpaquePaintEvent, True)

    def set_frame(self, frame: np.ndarray | None, subtitle: str = "") -> None:
        self._frame = frame
        self._image = bgr_to_qimage(frame) if frame is not None else None
        self._subtitle = subtitle
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), Qt.black)
        if self._image is None:
            p.setPen(Qt.gray)
            p.drawText(self.rect(), Qt.AlignCenter, self._title)
            return
        iw, ih = self._image.width(), self._image.height()
        target = QRect(0, 0, self.width(), self.height())
        scaled = target.size().scaled(iw, ih, Qt.KeepAspectRatio)
        x = (self.width() - scaled.width()) // 2
        y = (self.height() - scaled.height()) // 2
        p.setRenderHint(QPainter.SmoothPixmapTransform, True)
        p.drawImage(QRect(x, y, scaled.width(), scaled.height()), self._image)

        p.setPen(Qt.white)
        # A translucent strip keeps the caption legible over bright frames
        # without hiding the pixels it names.
        strip = QRect(0, self.height() - 22, self.width(), 22)
        p.fillRect(strip, QColor(0, 0, 0, 150))
        p.drawText(8, self.height() - 6, f"{self._title}   {self._subtitle}")


# --------------------------------------------------------------- overlays

def _fit_scale(shape: tuple[int, int], canvas_shape: tuple[int, int]) -> tuple[float, int, int]:
    h, w = shape
    ch, cw = canvas_shape
    scale = min(cw / w, ch / h)
    return scale, int((cw - w * scale) // 2), int((ch - h * scale) // 2)


def draw_window_overlay(frame: np.ndarray, window: list[int], current: int,
                        shot_start: int, shot_end: int) -> np.ndarray:
    """Draw the processed scope on the frame.

    The temporal window is a *frame range*, so it's drawn as a strip along the
    bottom: one tick per frame in the shot, with the frames used by the window
    highlighted and the current frame marked.  This is the "参加了处理的范围".
    """
    out = frame.copy()
    h, w = out.shape[:2]
    bar_h = max(18, h // 18)
    x0, x1 = int(w * 0.04), int(w * 0.96)
    y0 = h - bar_h - max(6, h // 40)
    cv2.rectangle(out, (x0 - 2, y0 - 2), (x1 + 2, y0 + bar_h + 2), (0, 0, 0), -1)
    span = max(1, shot_end - shot_start + 1)
    tick_w = (x1 - x0) / span
    for k, f in enumerate(range(shot_start, shot_end + 1)):
        px = int(x0 + k * tick_w)
        if f in window:
            cv2.rectangle(out, (px, y0), (px + max(1, int(tick_w) - 1), y0 + bar_h),
                          C_WINDOW, -1)
        else:
            cv2.line(out, (px, y0 + bar_h // 2), (px, y0 + bar_h), (90, 90, 90), 1)
    if current in window:
        k = current - shot_start
        px = int(x0 + k * tick_w)
        cv2.rectangle(out, (px - 1, y0 - 3), (px + max(1, int(tick_w) - 1) + 1, y0 + bar_h + 3),
                      C_CURRENT, 1)
    label = f"window {window[0]}-{window[-1]}  ({len(window)}f)"
    cv2.putText(out, label, (x0, y0 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.42,
                (255, 255, 255), 1, cv2.LINE_AA)
    return out


def draw_motion_overlay(frame: np.ndarray, motion_mask: np.ndarray,
                        trail: list[tuple[int, int, int]], show_mask: bool,
                        show_trail: bool) -> np.ndarray:
    """Outline the moving region and draw the trail points in the window."""
    out = frame.copy()
    if show_mask and motion_mask is not None and motion_mask.any():
        contours, _ = cv2.findContours(motion_mask.astype(np.uint8), cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        contours = [c for c in contours if cv2.contourArea(c) >= 30]
        if contours:
            cv2.drawContours(out, contours, -1, C_MASK, 2, cv2.LINE_AA)
    if show_trail and trail:
        pts = np.array([[x, y] for _, x, y in trail], np.int32)
        if len(pts) > 1:
            cv2.polylines(out, [pts], False, C_TRAIL, 1, cv2.LINE_AA)
        for idx, (_, x, y) in enumerate(trail):
            newest = idx == len(trail) - 1
            cv2.circle(out, (x, y), 3 if newest else 2, C_TRAIL, -1, cv2.LINE_AA)
    return out


def draw_cut_banner(frame: np.ndarray, text: str) -> np.ndarray:
    out = frame.copy()
    h, w = out.shape[:2]
    cv2.rectangle(out, (0, 0), (w, max(20, h // 14)), (0, 0, 0), -1)
    cv2.putText(out, text, (8, max(15, h // 28)), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                C_CUT, 1, cv2.LINE_AA)
    return out
