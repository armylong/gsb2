"""图像输入、亮度提取、重采样、色阶调整与测试图生成。

所有内部灰度图均为 float32 / float64 的二维数组，取值范围 [0, 1]，
数组第 0 行对应图像顶部。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtGui import QImage

from .mapping import DegenerateRangeError

# Rec.709 亮度系数
_LUMA_R, _LUMA_G, _LUMA_B = 0.2126, 0.7152, 0.0722


def qimage_to_rgb(qimg: QImage) -> np.ndarray:
    """QImage -> (H, W, 3) uint8，字节顺序固定为 R,G,B。"""
    conv = qimg.convertToFormat(QImage.Format.Format_RGBA8888)
    h, w = conv.height(), conv.width()
    buf = np.frombuffer(conv.bits(), dtype=np.uint8, count=conv.sizeInBytes())
    arr = buf.reshape(h, w, 4)
    return np.ascontiguousarray(arr[:, :, :3])


def rgb_to_gray(rgb: np.ndarray) -> np.ndarray:
    """彩色 RGB 数组 -> 亮度灰度 [0,1] float64。"""
    rgb = rgb.astype(np.float64)
    return (_LUMA_R * rgb[:, :, 0] + _LUMA_G * rgb[:, :, 1] + _LUMA_B * rgb[:, :, 2]) / 255.0


def is_color_image(rgb: np.ndarray) -> bool:
    """判断原图是否真的带彩色信息（三通道有差异）。"""
    return bool(np.any(rgb[:, :, 0] != rgb[:, :, 1]) or np.any(rgb[:, :, 1] != rgb[:, :, 2]))


def load_image(path: str) -> tuple[np.ndarray, bool]:
    """读取图片，返回 (原始灰度[0,1], 是否彩色)。

    灰度图直接取其亮度；彩色图按 Rec.709 折算亮度。
    """
    qimg = QImage(path)
    if qimg.isNull():
        raise OSError(f"无法读取图像: {path}")
    rgb = qimage_to_rgb(qimg)
    return rgb_to_gray(rgb), is_color_image(rgb)


def gray_to_qimage(gray: np.ndarray) -> QImage:
    """[0,1] 灰度数组 -> Grayscale8 QImage（拷贝，脱离原缓冲）。"""
    u8 = np.clip(np.rint(gray * 255.0), 0, 255).astype(np.uint8)
    h, w = u8.shape
    img = QImage(u8.data, w, h, w, QImage.Format.Format_Grayscale8).copy()
    return img


def rgba_qimage(rgba: np.ndarray) -> QImage:
    """(H,W,4) uint8 -> RGBA8888 QImage。"""
    if rgba.dtype != np.uint8:
        raise ValueError("rgba 数组必须为 uint8")
    h, w = rgba.shape[:2]
    return QImage(np.ascontiguousarray(rgba).data, w, h, 4 * w,
                  QImage.Format.Format_RGBA8888).copy()


def save_gray_png(path: str, gray_u8: np.ndarray) -> None:
    """把 uint8 灰度数组保存为 PNG。"""
    h, w = gray_u8.shape
    QImage(gray_u8.data, w, h, w, QImage.Format.Format_Grayscale8).copy().save(path)


def resize_grid(gray: np.ndarray, out_h: int, out_w: int) -> np.ndarray:
    """双线性重采样到 out_h x out_w。

    对只有一行或一列的退化图同样安全：越界采样点被夹到唯一像素，
    不会出现除零或下标错误。
    """
    h, w = gray.shape
    if out_h <= 0 or out_w <= 0:
        raise ValueError("输出尺寸必须为正数")
    if (h, w) == (out_h, out_w):
        return gray.copy()

    # 输出格点中心对应到源图的连续坐标
    sx = (np.arange(out_w, dtype=np.float64) + 0.5) * (w / out_w) - 0.5
    sy = (np.arange(out_h, dtype=np.float64) + 0.5) * (h / out_h) - 0.5

    x0 = np.clip(np.floor(sx).astype(np.int64), 0, w - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    fx = np.clip(sx - np.floor(sx), 0.0, 1.0)

    y0 = np.clip(np.floor(sy).astype(np.int64), 0, h - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fy = np.clip(sy - np.floor(sy), 0.0, 1.0)

    g = gray.astype(np.float64)
    top = g[np.ix_(y0, x0)] * (1.0 - fx) + g[np.ix_(y0, x1)] * fx
    bot = g[np.ix_(y1, x0)] * (1.0 - fx) + g[np.ix_(y1, x1)] * fx
    return top * (1.0 - fy[:, None]) + bot * fy[:, None]


def apply_levels(gray: np.ndarray, black_point: float, white_point: float) -> np.ndarray:
    """黑白点拉伸。black/white 取值 [0,1]，黑点 >= 白点属于参数冲突。"""
    if not (0.0 <= black_point <= 1.0 and 0.0 <= white_point <= 1.0):
        raise DegenerateRangeError("黑白点必须落在 0~1 之间")
    if black_point >= white_point:
        raise DegenerateRangeError(
            f"黑白点冲突：黑点({black_point:.3f}) 必须小于白点({white_point:.3f})"
        )
    return np.clip((gray - black_point) / (white_point - black_point), 0.0, 1.0)


def make_staircase(size: int = 256, steps: int = 8) -> np.ndarray:
    """灰度阶梯测试图：纵向 8 个等宽条带，亮度 0→255 线性递增。"""
    if steps < 2:
        raise ValueError("阶梯数至少为 2")
    img = np.empty((size, size), dtype=np.uint8)
    band = size / steps
    for col in range(size):
        idx = min(int(col / band), steps - 1)
        img[:, col] = round(255.0 * idx / (steps - 1))
    return img


def make_thinline(size: int = 256) -> np.ndarray:
    """细线测试图：白底深色 1/2/3px 竖线、1px 横线，左上角放方向标记方块。

    坐标按 size 比例缩放（基准 256），保证任意尺寸都能生成。
    """
    dark = 40
    img = np.full((size, size), 255, dtype=np.uint8)

    def s(v: int) -> int:
        return max(1, int(round(v * size / 256)))

    # 左上角方向标记（读回时用来核对图像上下方向与厚度位置）
    img[s(8):s(29), s(8):s(29)] = dark
    # 宽度 1 / 2 / 3 像素的竖线
    for x, width in ((64, 1), (128, 2), (192, 3)):
        x0, x1 = s(x), s(x) + max(1, s(width))
        img[s(48):s(209), x0:min(x1, size)] = dark
    # 一条 1px 横线
    hr = s(200)
    img[hr, s(48):min(s(209), size)] = dark
    return img
