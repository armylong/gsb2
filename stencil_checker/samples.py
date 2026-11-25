"""Built-in binary template samples.

The arrays are generated in code so the two required teaching cases always
exist, even before any image file is chosen.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw


@dataclass(frozen=True)
class Sample:
    key: str
    title: str
    description: str
    gray: np.ndarray
    keep_color: str
    protected: np.ndarray
    select_xy: tuple[int, int]
    bridge_width: int
    direction: str = "自动"


def _canvas(width: int, height: int) -> np.ndarray:
    return np.full((height, width), 255, dtype=np.uint8)


def _disk(gray: np.ndarray, cx: int, cy: int, radius: int, value: int = 0) -> None:
    img = Image.fromarray(gray, mode="L")
    draw = ImageDraw.Draw(img)
    draw.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius),
        fill=value,
    )
    gray[:] = np.asarray(img, dtype=np.uint8)


def _line(
    gray: np.ndarray,
    points: list[tuple[int, int]],
    width: int,
    value: int = 0,
) -> None:
    img = Image.fromarray(gray, mode="L")
    draw = ImageDraw.Draw(img)
    draw.line(points, fill=value, width=width)
    gray[:] = np.asarray(img, dtype=np.uint8)


def chain_sample() -> Sample:
    """Two islands that can be joined before either reaches the frame."""
    w, h = 460, 320
    frame = 24
    gray = _canvas(w, h)

    # Thick outer frame, touching every side.
    gray[:frame, :] = 0
    gray[-frame:, :] = 0
    gray[:, :frame] = 0
    gray[:, -frame:] = 0

    # Two central islands. Their mutual gap is smaller than the left-frame gap.
    _disk(gray, 132, 174, 36)
    _disk(gray, 250, 174, 31)

    # A deliberately fragile two-pixel tab joining a round detail to the top.
    _line(gray, [(374, frame - 2), (374, 78)], width=2)
    _disk(gray, 374, 101, 23)

    protected = np.zeros((h, w), dtype=bool)
    return Sample(
        key="chain",
        title="样例：一次桥接不够",
        description=(
            "点选左侧 #2 圆块，在方向中选“右”，再应用“合并纸块 #3”的方案；"
            "合并后的组合块仍未接外框，检查器会继续把它标为悬空。再补一座到外框的桥即可固定。"
            "右上角还有一个约 2px 细连点警告。"
        ),
        gray=gray,
        keep_color="black",
        protected=protected,
        select_xy=(132, 174),
        bridge_width=6,
        direction="自动",
    )


def tight_sample() -> Sample:
    """A protected chamber with a three-pixel slot too narrow for a wide bridge."""
    w, h = 380, 280
    frame = 18
    gray = _canvas(w, h)

    gray[:frame, :] = 0
    gray[-frame:, :] = 0
    gray[:, :frame] = 0
    gray[:, -frame:] = 0

    # The trapped island.
    cx, cy, radius = 176, 140, 19
    _disk(gray, cx, cy, radius)

    # Protected walls leave only a 3 px horizontal slot on the left.
    protected = np.zeros((h, w), dtype=bool)
    x0, x1 = 104, 248
    y0, y1 = 76, 204
    wall = 9
    protected[y0 : y0 + wall, x0:x1] = True  # top
    protected[y1 - wall : y1, x0:x1] = True  # bottom
    protected[y0:y1, x0 : x0 + wall] = True  # left
    protected[y0:y1, x1 - wall : x1] = True  # right
    slot_center_y = cy
    protected[slot_center_y - 1 : slot_center_y + 2, x0 : x0 + wall] = False

    return Sample(
        key="tight",
        title="样例：窄缝放不下宽桥",
        description=(
            "岛被已保护的细节墙围住，左侧只留 3px 窄缝。当前桥宽 8px 时方案标红；"
            "把桥宽调到 3px 后可穿过窄缝接到左外框，保护墙不会被修改。"
        ),
        gray=gray,
        keep_color="black",
        protected=protected,
        select_xy=(cx, cy),
        bridge_width=8,
        direction="自动",
    )


def all_samples() -> list[Sample]:
    return [chain_sample(), tight_sample()]
