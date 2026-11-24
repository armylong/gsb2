"""YUV -> RGB 重建（范围与矩阵可追溯，不做任何隐式“美化”）。

中性灰（Cb=Cr=128）在任意矩阵/范围下必须严格得到 R=G=B：
矩阵按标准整数缩放系数构造，配合“先缩放后四舍五入”的实现，
使零色度偏移时三个通道在取整前完全相等，而不是相差 ±1~2。
"""
from __future__ import annotations

import numpy as np

# 标准矩阵系数 (Kr, Kb)
MATRIX_COEFFS: dict[str, tuple[float, float, str]] = {
    "bt601": (0.299, 0.114, "BT.601 (SD)"),
    "bt709": (0.2126, 0.0722, "BT.709 (HD)"),
    "bt2020": (0.2627, 0.0593, "BT.2020 (UHD)"),
}


def _channel_scales(kr: float, kb: float) -> tuple[float, float, float, float]:
    """返回 (R 的 V 系数, B 的 U 系数, G 的 U 系数, G 的 V 系数)。"""
    kg = 1.0 - kr - kb
    return (
        2.0 * (1.0 - kr),
        2.0 * (1.0 - kb),
        2.0 * kb * (1.0 - kb) / kg,
        2.0 * kr * (1.0 - kr) / kg,
    )


def matrix_from_ffprobe(color_space: str | None) -> tuple[str, str]:
    """把 ffprobe color_space 映射到本工具矩阵，返回 (内部键, 说明)。"""
    mapping = {
        "bt709": "bt709",
        "bt470bg": "bt601",
        "smpte170m": "bt601",
        "smpte240m": "bt601",
        "bt2020nc": "bt2020",
        "bt2020c": "bt2020",
    }
    key = mapping.get(color_space or "", "bt601")
    note = "" if color_space in mapping else "媒体未声明矩阵，回退 BT.601"
    return key, note


def yuv_to_rgb(
    y: np.ndarray,
    u_up: np.ndarray,
    v_up: np.ndarray,
    matrix: str = "bt601",
    full_range: bool = False,
) -> np.ndarray:
    """三个同形 float 数组（Y 0..255，色度 0..255）-> uint8 RGB(H,W,3)。

    色度先归零化再整体缩放：中性灰时色差项严格为 0，
    三个通道在 uint8 取整前共享同一个 Y 线性值，故严格相等。
    """
    kr, kb, _ = MATRIX_COEFFS[matrix]
    rv, bu, gu, gv = _channel_scales(kr, kb)

    if full_range:
        yn = y / 255.0
        # 归零化后的色差（-0.5..0.5），再按 2 倍色度跨度缩放
        du = (u_up - 128.0) / 128.0
        dv = (v_up - 128.0) / 128.0
    else:
        yn = (y - 16.0) / 219.0
        du = (u_up - 128.0) / 112.0
        dv = (v_up - 128.0) / 112.0

    r = yn + rv * dv
    g = yn - gu * du - gv * dv
    b = yn + bu * du
    rgb = np.stack([r, g, b], axis=-1)
    return np.clip(np.round(rgb * 255.0), 0, 255).astype(np.uint8)
