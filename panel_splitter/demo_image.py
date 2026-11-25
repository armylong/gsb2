"""生成演示页。

一张 1000x1400 的分格讲解图, 刻意包含三种典型麻烦:
1. 跨两行的高格 (B), 左右形成 T 形接版, 不能按规则行列硬切;
2. 浅灰横缝 (#e6e6e6, 非纯白) 和被深色色块打断一小段的竖缝 (断缝);
3. 底格内部一条细长白色假缝, 诱导初次切分误切, 留给人工合并。

格子里只画色块、图形和字母, 不做任何文字识别。
"""

from __future__ import annotations

import cv2
import numpy as np

PAGE_W, PAGE_H = 1000, 1400
WHITE = (255, 255, 255)
LIGHT_GRAY = (230, 230, 230)  # #e6e6e6
GUTTER = 24
MARGIN = 30

# 人工标注的「正确」7 格 (x0, y0, x1, y1)
GROUND_TRUTH = {
    "A": (30, 30, 970, 330),
    "B": (30, 354, 420, 1046),
    "C": (444, 354, 693, 688),
    "D": (717, 354, 970, 688),
    "E": (444, 712, 693, 1046),
    "F": (717, 712, 970, 1046),
    "G": (30, 1070, 970, 1370),
}

# BGR, 都明显暗于浅灰缝, Otsu 能把缝判成背景
PANEL_COLORS = {
    "A": (224, 214, 200),
    "B": (205, 222, 232),
    "C": (210, 232, 214),
    "D": (232, 220, 208),
    "E": (226, 210, 230),
    "F": (208, 226, 230),
    "G": (228, 228, 200),
}


def _draw_panel_content(
    canvas: np.ndarray, name: str, rect: tuple[int, int, int, int]
) -> None:
    x0, y0, x1, y1 = rect
    cv2.rectangle(canvas, (x0, y0), (x1 - 1, y1 - 1), PANEL_COLORS[name], -1)
    # 每个格子里画两个不靠边的几何图形, 模拟讲解图内容
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    r = min(x1 - x0, y1 - y0) // 6
    cv2.circle(canvas, (cx - r, cy), r, (90, 90, 160), -1)
    cv2.rectangle(
        canvas,
        (cx + r // 2, cy - r),
        (cx + r // 2 + 2 * r, cy + r),
        (150, 110, 80),
        -1,
    )
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(
        canvas,
        name,
        (x0 + 14, y0 + 46),
        font,
        1.4,
        (40, 40, 40),
        3,
        cv2.LINE_AA,
    )


def generate_demo_page(path: str | None = None) -> np.ndarray:
    canvas = np.full((PAGE_H, PAGE_W, 3), 255, np.uint8)

    for name, rect in GROUND_TRUTH.items():
        _draw_panel_content(canvas, name, rect)

    # --- 麻烦 2a: A 下方的整页通横缝用浅灰, 不用纯白 (演示非白缝识别) ---
    cv2.rectangle(canvas, (30, 330), (969, 353), LIGHT_GRAY, -1)

    # --- 麻烦 2b: B 与右区之间的竖缝, 中间被深色色块打断一小段 (断缝) ---
    bridge_y0, bridge_y1 = 500, 558
    cv2.rectangle(canvas, (420, bridge_y0), (443, bridge_y1), (72, 72, 72), -1)

    # --- 麻烦 3: G 内部一条几乎贯通整格的白色假缝, 诱导误切 ---
    gx = (GROUND_TRUTH["G"][0] + GROUND_TRUTH["G"][2]) // 2
    cv2.rectangle(
        canvas,
        (gx - 10, GROUND_TRUTH["G"][1] + 4),
        (gx + 10, GROUND_TRUTH["G"][3] - 4),
        WHITE,
        -1,
    )

    if path:
        cv2.imwrite(path, canvas)
    return canvas
