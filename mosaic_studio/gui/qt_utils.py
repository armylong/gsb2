"""PIL 图像与 PySide6 像素图互转的小工具。"""
from __future__ import annotations

from PIL import Image
from PySide6.QtGui import QImage, QPixmap


def pil_to_qpixmap(image: Image.Image) -> QPixmap:
    im = image.convert("RGBA")
    data = im.tobytes("raw", "RGBA")
    qimg = QImage(data, im.width, im.height, 4 * im.width,
                  QImage.Format.Format_RGBA8888)
    # copy() 让 QImage 持有自己的数据，避免 data 被回收后花屏。
    return QPixmap.fromImage(qimg.copy())


def pil_to_qicon(image: Image.Image, size: int = 52) -> "QIcon":  # noqa: F821
    from PySide6.QtGui import QIcon
    thumb = image.convert("RGB").resize((size, size),
                                        Image.Resampling.BILINEAR)
    return QIcon(pil_to_qpixmap(thumb))
