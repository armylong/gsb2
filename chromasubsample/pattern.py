"""程序自带测试样例生成 (纯 numpy, 不依赖外部测试卡)。

样例内容刻意针对色度采样弱点:
- 水平 / 竖直 1px 彩色细线 (红、绿、蓝、青、品、黄) 与中性细线
- 等亮度异色边 (两侧 Y 量化后相同, 只剩 Cb/Cr 翻转)
- 中性灰阶块 (Cb=Cr=128, 用于核对亮度平面基本不受色度采样影响)
- 5x7 点阵文字边缘
- 一条逐帧移动的高饱和竖线, 让运动位置与偶数采样网格的关系可见
"""

from __future__ import annotations

import numpy as np

from .color import C_CENTER, KB, KG, KR, Y_MIN, Y_SPAN, _round_u8

# ---------------------------------------------------------------- 5x7 点阵字
# 每个字形 7 行, 每行 5 个 0/1; 行之间、字之间留 1px 空白。
FONT: dict[str, tuple[str, ...]] = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    " ": ("00000",) * 7,
    ":": ("00000", "00100", "00100", "00000", "00100", "00100", "00000"),
}

GLYPH_W, GLYPH_H = 5, 7

# 受保护的纯中性基准块 (Cb=Cr=128): 运动线与所有彩色图案都不进入该区域,
# 测试与界面据此核对"色度采样在中性区零误差、亮度不变"。
NEUTRAL_PATCH = {"x0_frac": 0.86, "y0_frac": 0.04, "w_frac": 0.10, "h_frac": 0.08}


def draw_text(canvas: np.ndarray, text: str, x0: int, y0: int,
              color: tuple[int, int, int], scale: int = 1) -> None:
    for ci, ch in enumerate(text):
        glyph = FONT.get(ch, FONT[" "])
        base_x = x0 + ci * (GLYPH_W + 1) * scale
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit == "1":
                    canvas[
                        y0 + row * scale:y0 + (row + 1) * scale,
                        base_x + col * scale:base_x + (col + 1) * scale,
                    ] = color


def equiluminant_pair() -> tuple[tuple[int, int, int], tuple[int, int, int], float]:
    """构造一对 full-range RGB 颜色, 使其 BT.709 亮度 (量化后) 完全相等。

    选红偏色 (r0, b0) 后解 G 使 Y 等于目标值; 另一侧取 (255-r, 255-g, 255-b)
    一般不严格等亮, 因此直接在同一 Y 上构造两个 Cb/Cr 相反方向的点。
    """
    target_y = 128.0  # 中间灰, limited Y = 16 + 219*0.5 ≈ 125.5
    y_norm = (target_y - Y_MIN) / Y_SPAN

    # 颜色 A: 固定 r=200, b=64, 解 g
    r0 = 200 / 255.0
    b0 = 64 / 255.0
    g0 = (y_norm - KR * r0 - KB * b0) / KG
    g0 = float(np.clip(g0, 0.0, 1.0))

    # 颜色 B: 交换 r/b 并重新解 g, 保证同一 Y
    r1 = b0
    b1 = r0
    g1 = (y_norm - KR * r1 - KB * b1) / KG
    g1 = float(np.clip(g1, 0.0, 1.0))

    rgb_a = tuple(int(v) for v in _round_u8(np.array([r0, g0, b0]) * 255.0))
    rgb_b = tuple(int(v) for v in _round_u8(np.array([r1, g1, b1]) * 255.0))
    return rgb_a, rgb_b, y_norm  # type: ignore[return-value]


def _vline(img: np.ndarray, x: int, color: tuple[int, int, int], width: int = 1) -> None:
    img[:, x:x + width] = color


def _hline(img: np.ndarray, y: int, color: tuple[int, int, int], width: int = 1) -> None:
    img[y:y + width, :] = color


def generate_pattern(width: int = 640, height: int = 480,
                     frame_count: int = 60, fps: int = 30) -> np.ndarray:
    """生成 [N,H,W,3] uint8 RGB 样例, 第 0 帧为静态底图, 其后叠加运动线。"""
    if width < 320 or height < 240 or width % 2 or height % 2:
        raise ValueError("样例尺寸需为偶数且不小于 320x240")

    base = np.zeros((height, width, 3), dtype=np.uint8)
    gray = (128, 128, 128)
    base[:, :] = gray

    # ---- 区域 1: 竖直彩色细线带 (左侧, 1px 线 + 1px 间隔) ----
    line_colors = [
        (255, 0, 0), (0, 255, 0), (0, 0, 255),
        (0, 255, 255), (255, 0, 255), (255, 255, 0),
        (255, 255, 255), (0, 0, 0),
    ]
    band_top, band_bottom = 8, height // 2 - 10
    x = 8
    for color in line_colors:
        if x + 1 >= width // 2:
            break
        base[band_top:band_bottom, x] = color
        x += 2  # 1px 线 + 1px 灰底间隔

    # ---- 区域 2: 水平彩色细线带 (顶部, 检验 4:2:0 竖直方向减半) ----
    y = 8
    for color in line_colors:
        if y + 1 >= height // 3:
            break
        base[y, width // 2 + 8:width - 8] = color
        y += 2

    # ---- 区域 3: 等亮度异色边 (中部通栏, 左右两半 Y 相同、Cb/Cr 反向) ----
    rgb_a, rgb_b, _ = equiluminant_pair()
    edge_y0 = height // 2
    edge_y1 = height // 2 + max(24, height // 8)
    base[edge_y0:edge_y1, : width // 2] = rgb_a
    base[edge_y0:edge_y1, width // 2:] = rgb_b
    # 边界本身落在偶/奇列各画一条 1px 线, 方便看字边式的突变
    base[edge_y0:edge_y1, width // 2 - 1] = (255, 255, 255)
    base[edge_y0:edge_y1, width // 2] = (0, 0, 0)

    # ---- 区域 4: 中性灰阶块 (右下, Cb=Cr=128, 亮度细节不应被色度采样影响) ----
    ramp_y0 = edge_y1 + 12
    ramp_h = max(20, height - ramp_y0 - 8)
    blocks = 8
    block_w = (width // 2 - 16) // blocks
    for i in range(blocks):
        v = int(round(16 + i * (235 - 16) / (blocks - 1)))
        # full-range 灰: 用同值 RGB 近似, 实际 Y 由矩阵换算
        g = int(round((v - Y_MIN) / Y_SPAN * 255.0))
        base[ramp_y0:ramp_y0 + ramp_h, 8 + i * block_w:8 + (i + 1) * block_w] = (g, g, g)

    # ---- 区域 5: 点阵文字 (右上), 字边即典型高频亮度+色度混合边缘 ----
    draw_text(base, "YUV 4:4:4", width // 2 + 12, height // 2 + 12, (255, 255, 255), scale=2)
    draw_text(base, "CHROMA 420", width // 2 + 12, height // 2 + 40, (255, 80, 160), scale=2)

    # ---- 区域 6: 棋盘式黑白 1px 格 (右下小块, 纯亮度高频) ----
    cb_x0 = width // 2 + 12
    cb_y0 = height // 2 + 70
    cb_sz = min(64, width - cb_x0 - 12, height - cb_y0 - 12)
    cb_sz = cb_sz - cb_sz % 2
    if cb_sz >= 8:
        yy, xx = np.mgrid[0:cb_sz, 0:cb_sz]
        checker = ((yy + xx) % 2 * 255).astype(np.uint8)
        base[cb_y0:cb_y0 + cb_sz, cb_x0:cb_x0 + cb_sz] = checker[..., None]

    # ---- 受保护中性基准块: 最后再刷一次纯灰, 覆盖任何穿过它的图案 ----
    nx0, ny0, nx1, ny1 = neutral_patch_rect(width, height)
    base[ny0:ny1, nx0:nx1] = gray

    frames = np.repeat(base[None], frame_count, axis=0)

    # ---- 运动高饱和竖线: 每帧移动 1px, 奇偶列上的采样差异直接可见 ----
    # 水平范围避开右侧受保护中性块; 竖直范围避开顶部中性块。
    moving = (255, 0, 255)
    nx0 = int(width * NEUTRAL_PATCH["x0_frac"])
    ny1 = int(height * (NEUTRAL_PATCH["y0_frac"] + NEUTRAL_PATCH["h_frac"])) + 2
    for f in range(frame_count):
        mx = (f * 2) % (nx0 - 6) + 2
        frames[f, ny1:height - 10, mx] = moving
    return frames


def neutral_patch_rect(width: int, height: int) -> tuple[int, int, int, int]:
    """返回中性基准块 (x0, y0, x1, y1), 偶数对齐。"""
    x0 = int(width * NEUTRAL_PATCH["x0_frac"])
    y0 = int(height * NEUTRAL_PATCH["y0_frac"])
    x1 = x0 + int(width * NEUTRAL_PATCH["w_frac"])
    y1 = y0 + int(height * NEUTRAL_PATCH["h_frac"])
    return x0 - x0 % 2, y0 - y0 % 2, x1 - x1 % 2, y1 - y1 % 2


def neutral_chroma_value() -> int:
    """中性色的 Cb/Cr 值 (供测试断言)。"""
    return C_CENTER


def expected_luma_diff_equiluminant() -> int:
    """等亮度色对量化后的 Y 最大差值 (供测试断言, 期望 <=1)。"""
    from .color import rgb_to_yuv

    a, b, _ = equiluminant_pair()
    ya = rgb_to_yuv(np.array(a, dtype=np.uint8).reshape(1, 1, 3))[0]
    yb = rgb_to_yuv(np.array(b, dtype=np.uint8).reshape(1, 1, 3))[0]
    return int(np.abs(ya.astype(int) - yb.astype(int)).max())
