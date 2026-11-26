"""内置黑白样图: 同尺寸两张墨版, 包含拐角、内洞、窄缝、薄指等结构。"""

from __future__ import annotations

import numpy as np

SAMPLE_SIZE = 420


def _ring(cx: int, cy: int, r_out: int, r_in: int) -> np.ndarray:
    y, x = np.ogrid[:SAMPLE_SIZE, :SAMPLE_SIZE]
    d2 = (x - cx) ** 2 + (y - cy) ** 2
    return (d2 <= r_out**2) & (d2 >= r_in**2)


def build_sample() -> tuple[np.ndarray, np.ndarray]:
    """返回 (plate_a, plate_b), 均为 SAMPLE_SIZE×SAMPLE_SIZE 的布尔墨版。

    设计要点
    --------
    * 左上: L 形拐角对接, 直角凹角是搭接最容易出问题的地方;
    * 右上: A 版实心圆包住 B 版圆环(真正的内洞), 验证内洞不会被填;
    * 中部: 两条平行窄缝, 缝宽分别为 6px 和 2px;
    * 下部: 两根 5px 薄指与对方短粗块对接, 看薄线/尖角;
    * 左下: 两条本来就重合的边(共享边界, 无空白), 验证不会反复加大;
    * 外轮廓四周都留足空白, 验证外边不会普遍长大。
    """
    n = SAMPLE_SIZE
    a = np.zeros((n, n), dtype=bool)
    b = np.zeros((n, n), dtype=bool)

    # --- 1. L 形拐角对接 (A 在左/上, B 在右/下, 中间留 4px 空白缝) ---
    a[40:120, 40:150] = True          # 横臂
    a[40:200, 40:90] = True           # 竖臂, 合成 L
    b[124:200, 94:200] = True         # 方块, 与 L 的两个端面各隔 4px

    # --- 2. 圆环内洞: A 是带中心孔的圆, B 是套在外面的环 ---
    cy, cx = 110, 310
    yy, xx = np.ogrid[:n, :n]
    d2 = (xx - cx) ** 2 + (yy - cy) ** 2
    # A: 外径 40 的圆盘, 中心挖掉半径 5.5 的真内洞 (11×11 空白)
    a |= (d2 <= 40**2) & (d2 > 5.5**2)
    b |= _ring(cx, cy, 78, 60)
    # 环的内孔与 A 圆之间隔 20px 空白, 常规搭接宽度进不去;
    # A 自己的内洞、环外侧空白都不应被填。

    # --- 3. 两条平行窄缝 ---
    a[225:245, 60:200] = True         # 上条 A
    b[251:271, 60:200] = True         # 缝宽 6px
    a[285:300, 60:200] = True         # 上条 A
    b[302:317, 60:200] = True         # 缝宽 2px

    # --- 4. 薄指与尖角 ---
    a[335:340, 40:150] = True         # 5px 薄指, 水平
    b[330:355, 154:200] = True        # 对方粗块, 间隔 4px
    # 三角尖: A 的三角形尖点指向 B 块
    tri = (yy >= 360) & (yy < 400) & (xx >= 40) & (xx < 40 + (yy - 360))
    a |= tri
    b[355:405, 90:140] = True         # 与尖点之间留窄缝

    # --- 5. 本来就重合(共享边界、无空白)的直边 ---
    a[40:90, 230:260] = True
    b[40:90, 260:290] = True          # x=260 处两版直接相接

    return a, b
