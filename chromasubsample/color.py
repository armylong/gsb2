"""BT.709 limited-range YCbCr 转换与色度上/下采样 (纯 numpy, 8-bit)。

三路对照 (4:4:4 / 4:2:2 / 4:2:0) 共用本模块, 保证除色度采样外,
颜色矩阵、范围、取整规则完全一致, 不引入任何锐化或降噪。

色度采样位置 (chroma sample location): 统一采用 MPEG-2 风格的
left / co-sited —— 色度样本落在偶数编号像素上, 即
4:2:2 取列 0,2,4,...; 4:2:0 取 (行,列) = (0,0),(0,2),(2,0),...
重建时使用整数倍最近邻 (重复相邻色度样本), 不做插值平滑。
"""

from __future__ import annotations

import numpy as np

# ---- BT.709 原色系数 ----
KR = 0.2126
KB = 0.0722
KG = 1.0 - KR - KB  # 0.7152

# ---- limited (TV) range: Y 16..235, Cb/Cr 16..240, 中性 128 ----
Y_MIN = 16
Y_SPAN = 235 - 16          # 219
C_CENTER = 128
C_SPAN = 240 - 16          # 224

MODES = ("444", "422", "420")
PIXEL_FORMATS = {
    "444": "yuv444p",
    "422": "yuv422p",
    "420": "yuv420p",
}
# ffmpeg chroma_sample_location 枚举名
CHROMA_LOCATION = {
    "444": "unspecified",   # 4:4:4 无色度子采样, 无采样位置概念
    "422": "left",          # MPEG-2 / co-sited, 仅水平方向
    "420": "left",          # MPEG-2 / co-sited (JPEG 居中则为 center)
}


def _round_u8(x: np.ndarray) -> np.ndarray:
    """确定性四舍五入 (避免 np.round 的银行家舍入), 并截断到 uint8。"""
    return np.clip(np.floor(x + 0.5), 0, 255).astype(np.uint8)


def rgb_to_yuv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """full-range R'G'B' uint8 -> limited-range BT.709 Y/Cb/Cr uint8。

    输入输出均为 8-bit; 这里只做矩阵运算, 不做 EOTF/伽马管理。
    """
    rgb = rgb.astype(np.float32)
    r = rgb[..., 0] / 255.0
    g = rgb[..., 1] / 255.0
    b = rgb[..., 2] / 255.0

    yf = KR * r + KG * g + KB * b
    y = Y_MIN + Y_SPAN * yf
    cb = C_CENTER + C_SPAN * (b - yf) / (2.0 * (1.0 - KB))
    cr = C_CENTER + C_SPAN * (r - yf) / (2.0 * (1.0 - KR))
    return _round_u8(y), _round_u8(cb), _round_u8(cr)


def yuv_to_rgb(y: np.ndarray, cb: np.ndarray, cr: np.ndarray) -> np.ndarray:
    """limited-range BT.709 Y/Cb/Cr -> full-range R'G'B' uint8 (逆矩阵)。"""
    yn = (y.astype(np.float32) - Y_MIN) / Y_SPAN
    cbn = (cb.astype(np.float32) - C_CENTER) / C_SPAN
    crn = (cr.astype(np.float32) - C_CENTER) / C_SPAN

    r = yn + 2.0 * (1.0 - KR) * crn
    b = yn + 2.0 * (1.0 - KB) * cbn
    g = (yn - KR * r - KB * b) / KG
    rgb = np.stack([r, g, b], axis=-1) * 255.0
    return _round_u8(rgb)


def plane_dims(mode: str, width: int, height: int) -> tuple[int, int]:
    """返回该采样模式下色度平面的实际 (宽, 高)。"""
    if mode == "444":
        return width, height
    if mode == "422":
        return width // 2, height          # 只在水平方向减半
    if mode == "420":
        return width // 2, height // 2     # 两个方向都减半
    raise ValueError(f"未知采样模式: {mode}")


def subsample(plane: np.ndarray, mode: str) -> np.ndarray:
    """色度下采样: 直接取偶数坐标样本 (left / co-sited), 不做平均。"""
    if mode == "444":
        return plane.copy()
    if mode == "422":
        return plane[:, 0::2].copy()
    if mode == "420":
        return plane[0::2, 0::2].copy()
    raise ValueError(f"未知采样模式: {mode}")


def upsample(plane_sub: np.ndarray, mode: str, height: int, width: int) -> np.ndarray:
    """最近邻上采样, 把色度平面重建回亮度全尺寸 (H, W)。

    源样本位于偶数坐标, 因此 np.repeat(2) 后像素 2j、2j+1 共享样本 j。
    """
    if mode == "444":
        out = plane_sub
    elif mode == "422":
        out = np.repeat(plane_sub, 2, axis=1)
    elif mode == "420":
        out = np.repeat(np.repeat(plane_sub, 2, axis=0), 2, axis=1)
    else:
        raise ValueError(f"未知采样模式: {mode}")
    return out[:height, :width]


def reconstruct_rgb(
    y: np.ndarray, cb_sub: np.ndarray, cr_sub: np.ndarray, mode: str
) -> np.ndarray:
    """把某一采样模式的 (可能已子采样的) 三平面重建为全尺寸 RGB。"""
    height, width = y.shape
    cb = upsample(cb_sub, mode, height, width)
    cr = upsample(cr_sub, mode, height, width)
    return yuv_to_rgb(y, cb, cr)
