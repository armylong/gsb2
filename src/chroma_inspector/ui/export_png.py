"""用 QPainter 渲染并排检查图并保存为 PNG。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QFont, QFontMetrics, QImage, QPainter, QPen

from ..export import assemble_side_by_side


def _draw_elided(painter: QPainter, rect: QRect, text: str) -> None:
    metrics = QFontMetrics(painter.font())
    elided = metrics.elidedText(
        text, Qt.TextElideMode.ElideRight, rect.width()
    )
    painter.drawText(
        rect,
        Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
        elided,
    )


def _rgb_to_qimage(rgb: np.ndarray) -> QImage:
    h, w = rgb.shape[:2]
    return QImage(
        np.ascontiguousarray(rgb).data, w, h, 3 * w, QImage.Format.Format_RGB888
    ).copy()


def render_png(
    rgb_a: np.ndarray,
    rgb_b: np.ndarray,
    title_a: str,
    title_b: str,
    frame_label: str,
    out_path: str,
    zoom_crop: tuple[int, int, int, int] | None = None,
) -> None:
    canvas, geo = assemble_side_by_side(
        rgb_a, rgb_b, title_a, title_b, frame_label, zoom_crop
    )
    h, w = canvas.shape[:2]
    img = QImage(
        canvas.data, w, h, 3 * w, QImage.Format.Format_RGB888
    ).copy()

    painter = QPainter(img)
    painter.setPen(QPen(QColor(40, 40, 40)))
    header_font = QFont()
    header_font.setBold(True)
    header_font.setPointSize(11)
    painter.setFont(header_font)
    fx, fy, fw, fh = geo["frame_text"]
    _draw_elided(painter, QRect(fx, fy, fw, fh), frame_label)
    label_font = QFont()
    label_font.setPointSize(9)
    painter.setFont(label_font)
    for (lx, ly, lw, lh), title in (
        (geo["label_a"], title_a),
        (geo["label_b"], title_b),
    ):
        _draw_elided(painter, QRect(lx, ly, lw, lh), title)
    painter.setPen(QPen(QColor(60, 60, 60)))
    for rx, ry, rw, rh in geo["frames"]:
        painter.drawRect(rx, ry, rw, rh)
    painter.end()

    if not img.save(out_path, "PNG"):
        raise OSError(f"PNG 写入失败：{out_path}")
