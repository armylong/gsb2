"""PIL <-> Qt image helpers."""

from __future__ import annotations

from PIL import Image
from PySide6.QtGui import QImage, QPixmap


def pil_to_qimage(img: Image.Image) -> QImage:
    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGBA")
    if img.mode == "L":
        img = img.convert("RGB")
    if img.mode == "RGBA":
        data = img.tobytes("raw", "RGBA")
        fmt = QImage.Format.Format_RGBA8888
    else:
        data = img.tobytes("raw", "RGB")
        fmt = QImage.Format.Format_RGB888
    qimg = QImage(data, img.width, img.height, img.width * len(img.mode),
                  fmt)
    return qimg.copy()


def qimage_to_pil(qimg: QImage) -> Image.Image:
    qimg = qimg.convertToFormat(QImage.Format.Format_RGBA8888)
    ptr = qimg.bits()
    data = bytes(ptr)
    return Image.frombuffer("RGBA", (qimg.width(), qimg.height()), data,
                            "raw", "RGBA", 0, 1).convert("RGB")


def pil_to_pixmap(img: Image.Image) -> QPixmap:
    return QPixmap.fromImage(pil_to_qimage(img))
