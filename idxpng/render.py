"""把 IndexedImage 渲染成 RGBA 字节 / QImage。

高亮严格按“色号相等”判定, 而不是按颜色值判定:
所以 #2 和 #3 即使 RGBA 一模一样, 点 #2 也只会亮 #2 实际覆盖的像素。
"""

from __future__ import annotations

from typing import Optional

from .model import MISSING_RGBA, IndexedImage


def render_rgba(
    doc: IndexedImage,
    highlight: Optional[int] = None,
    dim_others: bool = True,
    outline: bool = False,
) -> bytes:
    """返回 width*height*4 的 RGBA 字节。仅供屏幕预览, 不影响导出数据。

    outline 参数仅为兼容旧调用保留; 清晰的矢量边界由 PixelCanvas 绘制。
    高亮严格按“色号相等”判定, 而不是按颜色值判定:
    所以 #2 和 #3 即使 RGBA 一模一样, 点 #2 也只会亮 #2 实际覆盖的像素。
    """
    w, h = doc.width, doc.height
    pal = doc.palette
    n_pal = len(pal)
    data = bytearray(w * h * 4)

    hi = highlight if highlight is not None and highlight < n_pal else None
    mask: Optional[set[int]] = None
    if hi is not None:
        mask = {p for p, v in enumerate(doc.indices) if v == hi}

    for p, idx in enumerate(doc.indices):
        if idx < n_pal:
            r, g, b, a = pal[idx]
        else:
            r, g, b, a = MISSING_RGBA

        if mask is not None:
            if p in mask:
                # 高亮: 向亮黄提亮(保留一部分原色), 并提高不透明度以便看清覆盖区
                r = int(r * 0.45 + 255 * 0.55)
                g = int(g * 0.45 + 226 * 0.55)
                b = int(b * 0.45 + 66 * 0.55)
                a = max(a, 205)
            elif dim_others:
                # 其他索引适度后退, 但颜色仍可辨认(同色异号区域会保持其旧颜色)
                r = int(r * 0.55)
                g = int(g * 0.55)
                b = int(b * 0.55)
                a = min(255, int(a * 0.72) + 24)

        o = p * 4
        data[o] = r
        data[o + 1] = g
        data[o + 2] = b
        data[o + 3] = a

    return bytes(data)


def render_qimage(doc: IndexedImage, **kwargs):
    """渲染并返回一个自持有内存的 QImage。延迟导入 QtGui, 方便无 GUI 测试。"""
    from PySide6.QtGui import QImage

    raw = render_rgba(doc, **kwargs)
    img = QImage(raw, doc.width, doc.height, doc.width * 4, QImage.Format.Format_RGBA8888)
    return img.copy()  # copy 后 QImage 自己持有内存, raw 可以释放
