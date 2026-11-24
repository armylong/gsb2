"""色度采样点位置（chroma sample location）与色度上采样。

本工具只实现可逐像素核对的确定性重建：把色度样本视为位于亮度网格上的
某个（可能为半整数的）位置，再做双线性插值上采样到全分辨率；边缘用
钳位（clamp）处理，因此**恒定色度在任何解释下都保持恒定**，中性灰
样例在两种解释下均保持中性。

位置约定（H.264 / H.265 chroma_sample_location，4:2:0）：

    名称        枚举值   色度样本在亮度网格上的虚拟坐标
    left        0        (2*cx + 0,   2*cy + 0)
    center      1        (2*cx + 0.5, 2*cy + 0.5)
    top-left    2        (2*cx + 0,   2*cy + 0)   （4:2:0 下同 left，保留枚举）
    top         3        (2*cx + 0.5, 2*cy + 0)
    bottom-left 4        水平左对齐、垂直底对齐（本工具不实现，显示原因）
    bottom      5        水平居中、垂直底对齐（本工具不实现，显示原因）

4:2:2 只有水平歧义（left / center），垂直方向与亮度样本对齐。
4:4:4 色度与亮度同网格，无歧义。
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import numpy as np


class ChromaSite(Enum):
    LEFT = "left"
    CENTER = "center"
    TOP_LEFT = "top-left"
    TOP = "top"
    BOTTOM_LEFT = "bottom-left"
    BOTTOM = "bottom"

    @property
    def value_str(self) -> str:
        return str(self.value)

    @property
    def label(self) -> str:
        return SITE_LABELS[self]

    @property
    def enum_value(self) -> int | None:
        """对应 H.264 chroma_sample_location 枚举值。"""
        return SITE_ENUM.get(self)

    def __str__(self) -> str:
        return str(self.value)


SITE_LABELS: dict[ChromaSite, str] = {
    ChromaSite.LEFT: "左对齐 left（类型 0：垂直共点）",
    ChromaSite.CENTER: "居中 center（类型 1：半像素偏移）",
    ChromaSite.TOP_LEFT: "左上 top-left（类型 2）",
    ChromaSite.TOP: "顶部居中 top（类型 3）",
    ChromaSite.BOTTOM_LEFT: "左下 bottom-left（类型 4）",
    ChromaSite.BOTTOM: "底部居中 bottom（类型 5）",
}

SITE_ENUM: dict[ChromaSite, int] = {
    ChromaSite.LEFT: 0,
    ChromaSite.CENTER: 1,
    ChromaSite.TOP_LEFT: 2,
    ChromaSite.TOP: 3,
    ChromaSite.BOTTOM_LEFT: 4,
    ChromaSite.BOTTOM: 5,
}

# ffprobe 报告的字符串 -> 本工具枚举
FFPROBE_SITE: dict[str, ChromaSite] = {
    "left": ChromaSite.LEFT,
    "center": ChromaSite.CENTER,
    "topleft": ChromaSite.TOP_LEFT,
    "top": ChromaSite.TOP,
    "bottomleft": ChromaSite.BOTTOM_LEFT,
    "bottom": ChromaSite.BOTTOM,
}

# 本工具实际能上采样的解释；其余仅展示并给出不支持原因
SUPPORTED_SITES_420: tuple[ChromaSite, ...] = (
    ChromaSite.LEFT,
    ChromaSite.CENTER,
    ChromaSite.TOP,
    ChromaSite.TOP_LEFT,
)
SUPPORTED_SITES_422: tuple[ChromaSite, ...] = (ChromaSite.LEFT, ChromaSite.CENTER)

UNSUPPORTED_REASON: dict[ChromaSite, str] = {
    ChromaSite.BOTTOM_LEFT: "类型 4（左下/底对齐）需要底部外推，本查看器未实现该重建",
    ChromaSite.BOTTOM: "类型 5（底部居中）需要底部外推，本查看器未实现该重建",
}


def is_supported(site: ChromaSite, h_sub: int, v_sub: int) -> bool:
    if h_sub == 1:  # 4:4:4
        return True
    if v_sub == 1:  # 4:2:2
        return site in SUPPORTED_SITES_422
    return site in SUPPORTED_SITES_420


def unsupported_reason(site: ChromaSite) -> str:
    return UNSUPPORTED_REASON.get(site, f"解释 {site.value} 不适用于当前子采样结构")


@dataclass(frozen=True)
class VirtualPoint:
    """一个色度样本在亮度网格上的虚拟位置（可为半像素）。"""

    x: float
    y: float


def virtual_point(
    site: ChromaSite, cx: int, cy: int, h_sub: int, v_sub: int
) -> VirtualPoint:
    """返回色度样本 (cx, cy) 在亮度坐标系下的虚拟位置。"""
    if h_sub == 1:  # 4:4:4：色度与亮度同位
        return VirtualPoint(float(cx), float(cy))
    if v_sub == 1:  # 4:2:2：垂直与亮度同位
        vx = 2 * cx + (0.5 if site == ChromaSite.CENTER else 0.0)
        return VirtualPoint(vx, float(cy))
    # 4:2:0
    if site == ChromaSite.CENTER:
        return VirtualPoint(2 * cx + 0.5, 2 * cy + 0.5)
    if site == ChromaSite.TOP:
        return VirtualPoint(2 * cx + 0.5, float(2 * cy))
    # left / top-left（4:2:0 下二者几何相同）
    return VirtualPoint(float(2 * cx), float(2 * cy))


def luma_to_chroma_weights(
    x: int, y: int, site: ChromaSite, h_sub: int, v_sub: int, cw: int, ch: int
) -> list[tuple[int, int, float]]:
    """亮度像素 (x,y) 的重建色度由哪些色度样本、以什么权重构成。

    用于点击画面时报告“该像素使用的原始色度位置”。
    钳位策略与 upsample_chroma 严格一致：x0/x0+1 独立夹到边界，
    因此角落像素可能只引用一个样本（权重允许小于 1，但其值就是该样本）。
    """
    if h_sub == 1:
        return [(min(x, cw - 1), min(y, ch - 1), 1.0)]

    # 找到该亮度像素反向映射到的色度空间坐标（色度样本间距为 1）
    if v_sub == 1:  # 4:2:2
        fx = (x - (0.5 if site == ChromaSite.CENTER else 0.0)) / 2.0
        fy = float(y)
    elif site == ChromaSite.CENTER:
        fx = (x - 0.5) / 2.0
        fy = (y - 0.5) / 2.0
    elif site == ChromaSite.TOP:
        fx = (x - 0.5) / 2.0
        fy = y / 2.0
    else:  # left / top-left
        fx = x / 2.0
        fy = y / 2.0

    x0 = int(np.floor(fx))
    y0 = int(np.floor(fy))
    tx = fx - x0
    ty = fy - y0

    ix0 = max(0, min(cw - 1, x0))
    ix1 = max(0, min(cw - 1, x0 + 1))
    iy0 = max(0, min(ch - 1, y0))
    iy1 = max(0, min(ch - 1, y0 + 1))
    wx0, wx1 = 1.0 - tx, tx
    wy0, wy1 = 1.0 - ty, ty

    acc: dict[tuple[int, int], float] = {}
    for ix, wx in ((ix0, wx0), (ix1, wx1)):
        for iy, wy in ((iy0, wy0), (iy1, wy1)):
            acc[(ix, iy)] = acc.get((ix, iy), 0.0) + wx * wy
    return [(cx, cy, w) for (cx, cy), w in sorted(acc.items()) if w > 0.0]


def upsample_chroma(
    plane: np.ndarray,
    site: ChromaSite,
    h_sub: int,
    v_sub: int,
    out_h: int,
    out_w: int,
) -> np.ndarray:
    """把色度平面双线性上采样到 (out_h, out_w)，uint8 输入，float64 输出。

    边缘钳位；恒定输入在任意 site 下逐点恒定（中性灰不变色的数学保证）。
    """
    ch, cw = plane.shape
    src = plane.astype(np.float64)

    if h_sub == 1:  # 4:4:4
        if (ch, cw) == (out_h, out_w):
            return src.copy()
        fx = np.arange(out_w, dtype=np.float64) * cw / out_w
        fy = np.arange(out_h, dtype=np.float64) * ch / out_h
    else:
        if v_sub == 1:  # 4:2:2
            ox = 0.5 if site == ChromaSite.CENTER else 0.0
            fx = (np.arange(out_w, dtype=np.float64) - ox) / 2.0
            fy = np.arange(out_h, dtype=np.float64)
        else:  # 4:2:0
            if site == ChromaSite.CENTER:
                ox = oy = 0.5
            elif site == ChromaSite.TOP:
                ox, oy = 0.5, 0.0
            else:  # left / top-left
                ox = oy = 0.0
            fx = (np.arange(out_w, dtype=np.float64) - ox) / 2.0
            fy = (np.arange(out_h, dtype=np.float64) - oy) / 2.0

    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    tx = (fx - x0)[None, :]
    ty = (fy - y0)[:, None]

    x1 = np.clip(x0 + 1, 0, cw - 1)
    y1 = np.clip(y0 + 1, 0, ch - 1)
    x0c = np.clip(x0, 0, cw - 1)
    y0c = np.clip(y0, 0, ch - 1)

    top = src[np.ix_(y0c, x0c)] * (1.0 - tx) + src[np.ix_(y0c, x1)] * tx
    bot = src[np.ix_(y1, x0c)] * (1.0 - tx) + src[np.ix_(y1, x1)] * tx
    return top * (1.0 - ty) + bot * ty
