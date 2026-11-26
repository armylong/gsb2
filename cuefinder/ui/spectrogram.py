"""特征对照视图：查询与参考命中段的特征热图 + 逐帧一致度曲线。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QImage, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..features import MATCH_COS

TEXT = QColor("#3a3f47")
BG = QColor("#ffffff")
GOOD = QColor("#2f6feb")
BAD = QColor("#c0392b")
BORDER = QColor(0, 0, 0, 30)


def _colormap(v: np.ndarray) -> np.ndarray:
    v = np.clip(v, 0.0, 1.0)
    stops = np.array([
        [0.05, 0.06, 0.16],
        [0.23, 0.18, 0.42],
        [0.48, 0.28, 0.50],
        [0.79, 0.44, 0.39],
        [0.98, 0.79, 0.45],
    ])
    pos = np.array([0.0, 0.25, 0.5, 0.75, 1.0])
    idx = np.searchsorted(pos, v, side="right") - 1
    idx = np.clip(idx, 0, len(pos) - 2)
    t = (v - pos[idx]) / (pos[idx + 1] - pos[idx] + 1e-9)
    rgb = stops[idx] * (1 - t[..., None]) + stops[idx + 1] * t[..., None]
    return (rgb * 255).astype(np.uint8)


class FeatureCompare(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(220)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self._q: np.ndarray | None = None
        self._r: np.ndarray | None = None
        self._cos: np.ndarray | None = None
        self._good: np.ndarray | None = None
        self._playhead = None

    def set_data(self, query_feats: np.ndarray, ref_feats: np.ndarray,
                 cos: np.ndarray, good: np.ndarray) -> None:
        self._q = np.asarray(query_feats, dtype=np.float64)
        self._r = np.asarray(ref_feats, dtype=np.float64)
        self._cos = np.asarray(cos, dtype=np.float64)
        self._good = np.asarray(good, dtype=bool)
        self._playhead = None
        self.update()

    def set_playhead(self, frame: float | None) -> None:
        self._playhead = frame
        self.update()

    def clear(self) -> None:
        self._q = self._r = self._cos = self._good = None
        self.update()

    def _image(self, feats: np.ndarray, width: int, height: int) -> QImage:
        lo, hi = float(feats.min()), float(feats.max())
        norm = (feats - lo) / (hi - lo + 1e-9)
        rgb = np.ascontiguousarray(_colormap(norm.T)[::-1])
        img = QImage(rgb.tobytes(), rgb.shape[1], rgb.shape[0],
                     rgb.shape[1] * 3, QImage.Format.Format_RGB888)
        return img.scaled(max(1, width), max(1, height),
                          Qt.AspectRatioMode.IgnoreAspectRatio,
                          Qt.TransformationMode.SmoothTransformation)

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        rect = self.rect()
        p.fillRect(rect, BG)
        if self._q is None or self._r is None or self._q.size == 0:
            p.setPen(QColor(120, 120, 120))
            p.drawText(rect, Qt.AlignmentFlag.AlignCenter, "选一个候选查看特征对照")
            return

        pad = 10
        label_h = 16
        curve_h = 64
        avail = rect.height() - 2 * pad - 2 * label_h - curve_h - 18
        img_h = max(36, avail / 2)
        w = max(10, rect.width() - 2 * pad)
        q_rect = QRectF(pad, pad + label_h, w, img_h)
        r_rect = QRectF(pad, q_rect.bottom() + label_h + 4, w, img_h)
        c_rect = QRectF(pad, r_rect.bottom() + 20, w, curve_h)

        p.setPen(TEXT)
        p.drawText(QRectF(pad, pad, w, label_h), Qt.AlignmentFlag.AlignLeft, "查询特征（40 频带）")
        p.drawText(QRectF(pad, q_rect.bottom(), w, label_h), Qt.AlignmentFlag.AlignLeft,
                   "参考命中段特征")
        p.drawImage(q_rect, self._image(self._q, int(w), int(img_h)))
        p.drawImage(r_rect, self._image(self._r, int(w), int(img_h)))
        p.setPen(QPen(BORDER, 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(q_rect)
        p.drawRect(r_rect)

        T = self._cos.size
        if T:
            base = c_rect.bottom() - 4
            p.setPen(QPen(QColor(0, 0, 0, 40), 1))
            p.drawLine(QRectF(c_rect.left(), base, c_rect.width(), 0).topLeft(),
                       QRectF(c_rect.right(), base, 0, 0).topLeft())
            bar_w = max(1.0, c_rect.width() / T)
            for i in range(T):
                v = max(0.0, min(1.0, float(self._cos[i])))
                h = v * (c_rect.height() - 6)
                is_good = self._good is not None and i < self._good.size and self._good[i]
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(GOOD if is_good else BAD)
                p.drawRect(QRectF(c_rect.left() + i * bar_w, base - h, bar_w, h))
            y = base - MATCH_COS * (c_rect.height() - 6)
            p.setPen(QPen(QColor("#2c3e50"), 1, Qt.PenStyle.DashLine))
            p.drawLine(QRectF(c_rect.left(), y, c_rect.width(), 0).topLeft(),
                       QRectF(c_rect.right(), y, 0, 0).topLeft())
            p.setPen(TEXT)
            p.drawText(QRectF(c_rect.left(), c_rect.top() - 16, w, 14),
                       Qt.AlignmentFlag.AlignLeft,
                       f"逐帧一致度（虚线 {MATCH_COS:.2f}；红=缺支持，蓝=一致）")
            if self._playhead is not None and T > 1:
                x = c_rect.left() + (self._playhead / (T - 1)) * c_rect.width()
                p.setPen(QPen(QColor("#d9480f"), 1.4))
                p.drawLine(QRectF(x, q_rect.top(), 0, base - q_rect.top()).topLeft(),
                           QRectF(x, base, 0, 0).topLeft())
