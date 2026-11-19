"""自生成演示图与独立写死的预期结果。

演示图均为浅色背景 + 深色零件，默认参数为：固定阈值 128、暗目标、8 邻接、
不去噪、不填隙、无限定面积、不排除触边。预期数量/面积是按生成规则手工算出的
精确值，测试不会调用分割器来反推预期。
"""
from __future__ import annotations

import cv2
import numpy as np

from .models import Demo

BG = 235
FG = 40


def _canvas(h: int, w: int) -> np.ndarray:
    return np.full((h, w), BG, dtype=np.uint8)


def _rect(img: np.ndarray, x0: int, y0: int, w: int, h: int) -> None:
    img[y0:y0 + h, x0:x0 + w] = FG


def _disc(img: np.ndarray, cx: int, cy: int, radius: int) -> None:
    h, w = img.shape
    yy, xx = np.ogrid[:h, :w]
    img[(xx - cx) ** 2 + (yy - cy) ** 2 <= radius * radius] = FG


def _expected(total: int, areas: list[int], holes: list[int] | None = None,
              included_area: int | None = None) -> dict:
    return {
        "total": total,
        "areas": list(areas),
        "holes": list(holes) if holes is not None else [0] * len(areas),
        "included_area": sum(areas) if included_area is None else included_area,
    }


def _same(exp: dict) -> dict:
    return {"4": exp, "8": dict(exp, areas=list(exp["areas"]), holes=list(exp["holes"]))}


def make_demos() -> list[Demo]:
    demos: list[Demo] = []

    # 1) 圆片与带孔零件 ---------------------------------------------------
    img = _canvas(300, 420)
    _disc(img, 70, 70, 20)    # 1257 px
    _disc(img, 160, 70, 14)   # 613 px
    _disc(img, 230, 70, 10)   # 317 px
    _rect(img, 280, 110, 120, 80)  # 9600 px
    _disc(img, 320, 150, 10)  # 孔 317 px
    _disc(img, 360, 150, 10)  # 孔 317 px
    # 上面两行圆片先被画成前景，这里恢复为背景，作为板的两个孔
    for cx in (320, 360):
        yy, xx = np.ogrid[:300, :420]
        img[(xx - cx) ** 2 + (yy - 150) ** 2 <= 100] = BG
    circular = Demo(
        key="circular",
        name="圆片与带孔零件",
        image=img,
        expected=_same(_expected(4, [1257, 613, 317, 8966], [0, 0, 0, 2])),
        note="3 个实心圆片 + 1 块带 2 个圆孔的板；板面积 9600-634=8966，孔洞不计入面积。",
    )
    demos.append(circular)

    # 2) 对角接触 ---------------------------------------------------------
    img = _canvas(160, 200)
    _rect(img, 50, 50, 10, 10)
    _rect(img, 60, 60, 10, 10)   # 与上一块只对角接触
    _rect(img, 90, 50, 10, 10)   # 独立
    diagonal = Demo(
        key="diagonal",
        name="对角接触",
        image=img,
        expected={
            "4": _expected(3, [100, 100, 100]),
            "8": _expected(2, [200, 100]),
        },
        note="两个方块只在角点接触：4 邻接算 2 块（加另一块共 3），8 邻接合并成 1 块（加另一块共 2）。",
    )
    demos.append(diagonal)

    # 3) 一像素连接与一像素线 --------------------------------------------
    img = _canvas(220, 300)
    _rect(img, 40, 80, 20, 20)
    _rect(img, 100, 80, 20, 20)
    img[90, 60:100] = FG          # 1 像素桥，长 40
    for t in range(40):           # 对角 1 像素线，40 个像素
        img[40 + t, 200 + t] = FG
    thin = Demo(
        key="thin",
        name="一像素连接",
        image=img,
        expected={
            "4": _expected(41, [1] * 40 + [840]),
            "8": _expected(2, [40, 840]),
        },
        note="1 像素横桥把两个 20×20 方块连成 840 px 的一块；对角 1 像素线 40 px 在 4 邻接下拆成 40 个点，8 邻接下连成 1 条。",
    )
    demos.append(thin)

    # 4) 触边残片 ---------------------------------------------------------
    img = _canvas(300, 420)
    _rect(img, 30, 0, 120, 10)     # 上边 1200
    _rect(img, 0, 40, 10, 100)     # 左边 1000
    _disc(img, 200, 150, 10)       # 完整 317
    _rect(img, 380, 260, 40, 40)   # 右下角 1600
    border = Demo(
        key="border",
        name="触边残片",
        image=img,
        expected=_same(_expected(4, [1200, 1000, 317, 1600])),
        note="三个触边区域 + 一个完整圆片；勾选“排除触边”后应只剩 1 个、面积 317。",
    )
    demos.append(border)

    # 5) 噪点与小孔 -------------------------------------------------------
    img = _canvas(220, 360)
    _rect(img, 50, 50, 40, 40)
    img[67:73, 67:73] = BG        # 6×6 孔，36 px
    for x in (200, 220, 240):
        img[60, x] = FG            # 1 px 噪点
    _rect(img, 260, 60, 2, 2)     # 4 px 噪点
    _rect(img, 300, 100, 10, 10)
    img[104:106, 304:306] = BG    # 2×2 孔，4 px
    noise = Demo(
        key="noise",
        name="噪点与小孔",
        image=img,
        expected=_same(_expected(6, [1564, 1, 1, 1, 4, 96], [1, 0, 0, 0, 0, 1])),
        note="去噪半径 2（≤13 px）可删掉 3 个 1 px 点和 1 个 2×2 点；填隙半径 2 可补 2×2 孔，半径 4 才补 6×6 孔。",    )
    demos.append(noise)

    # 6) 空白图 -----------------------------------------------------------
    img = _canvas(200, 300)
    empty = Demo(
        key="empty",
        name="空白图",
        image=img,
        expected=_same(_expected(0, [])),
        note="浅色背景、无前景：全部区域数 0，计入总面积 0；标签图应全为 0。",
    )
    demos.append(empty)
    return demos


DEMOS = {d.key: d for d in make_demos()}
DEMO_ORDER = [d.key for d in make_demos()]


def get_demo(key: str) -> Demo:
    if key not in DEMOS:
        raise KeyError(f"未知演示：{key}")
    return DEMOS[key]


def expected_for(demo: Demo, connectivity: int) -> dict:
    return demo.expected[str(connectivity)]


def expected_for_params(demo: Demo, connectivity: int, despeckle: int = 0,
                        fill: int = 0) -> dict | None:
    """按分割参数查找内置预期；没有覆盖该组合时返回 None（不臆造预期）。

    默认参数（不去噪、不填隙）适用于全部演示；噪点与小孔演示额外提供
    去噪/填隙后的精确预期，便于验证过滤后的数量与面积。
    """
    if demo.key == "noise":
        # 噪点演示里的各块互不接触，4/8 邻接结果相同。
        # 去噪半径 2 删掉 1 px×3 与 2×2 的点；填隙半径 2（13 px）补 2×2 孔，
        # 半径 4（49 px）连 6×6 孔（36 px）一起补上，故大块面积从 1564 变 1600。
        variants = {
            (0, 0): demo.expected[str(connectivity)],
            (2, 0): _expected(2, [1564, 96], [1, 1]),
            (2, 2): _expected(2, [1564, 100], [1, 0]),
            (4, 0): _expected(2, [1564, 96], [1, 1]),
            (4, 4): _expected(2, [1600, 100], [0, 0]),
        }
        return variants.get((despeckle, fill))
    if (despeckle, fill) != (0, 0):
        return None
    return demo.expected[str(connectivity)]


def demo_image_bgr(demo: Demo) -> np.ndarray:
    """导出/显示用的三通道版本。"""
    if demo.image.ndim == 2:
        return cv2.cvtColor(demo.image, cv2.COLOR_GRAY2BGR)
    return demo.image.copy()
