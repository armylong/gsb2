"""阅读顺序。

先按格子位置重建「行带」(y 方向重叠的格子归为同一带), 行带之间从上到下,
带内按阅读方向从左到右或从右到左。

跨行 (跨两带高度) 的格子不能简单按中心 y 归行, 否则会和下一行的阅读顺序打架。
归属规则 (可观察、可在界面上标注):

1. 格子高度 h >= 1.6 * 同带普通格子高度, 视为跨行格;
2. 它的归属带 = 与其纵向重叠面积最大的行带 (通常就是它顶部所在带);
3. 在该带内, 跨行格只占一个序号; 被它压到的下一行带里, 它不再重复出现;
4. 规则对左到右 / 右到左都生效, 带内排序只用 x, 归属只用 y 重叠。
"""

from __future__ import annotations

from dataclasses import dataclass

Rect = tuple[int, int, int, int]


@dataclass
class OrderInfo:
    order: list[int]  # panel 索引的阅读顺序
    bands: list[tuple[int, list[int]]]  # (带号, 该带 panel 索引)
    spanning: set[int]  # 被判为跨行的 panel 索引
    owner_band: dict[int, int]  # 跨行格实际归属的带号
    direction: str


def _y_overlap(a: Rect, b: Rect) -> int:
    return max(0, min(a[3], b[3]) - max(a[1], b[1]))


def build_bands(panels: list[Rect]) -> list[list[int]]:
    """把面板聚成行带。

    两遍法:
    1. 按顶部 y 排序做一维聚类, 相邻顶部差 <= 容差就同带, 定出每个带的带心;
    2. 每个面板分给「与其 y 重叠最大」的带 (顶部聚类漏不掉独立成行的格,
       重叠分配又能把跨行格放回它真正占据的带)。
    容差取面板中位高度的 35%, 对应正常同行格之间只差一个缝宽。
    """
    n = len(panels)
    if n == 0:
        return []

    heights = sorted(r[3] - r[1] for r in panels)
    mid = n // 2
    median_h = heights[mid] if n % 2 else (heights[mid - 1] + heights[mid]) / 2
    # 容差只容得下缝宽级的顶部差; 跨行靠第二遍的重叠分配处理, 不靠聚类
    tol = max(8.0, 0.15 * median_h)

    # 第一遍: 顶部 y 一维聚类。每个带记住自己的基准顶部 (第一个成员),
    # 新面板与基准顶部差 <= 容差才进同一带, 否则另起一带。
    # 注意: 跨行高格的顶部仍与所在带对齐, 会进对的带; 这里不做任何重排,
    # 跨行格的最终归属交给 compute_order 按重叠单独算。
    order_top = sorted(range(n), key=lambda i: panels[i][1])
    bands: list[list[int]] = []
    band_base_top: list[int] = []
    for i in order_top:
        if bands and panels[i][1] - band_base_top[-1] <= tol:
            bands[-1].append(i)
        else:
            bands.append([i])
            band_base_top.append(panels[i][1])

    bands.sort(key=lambda ids: min(panels[i][1] for i in ids))
    return bands


def compute_order(
    panels: list[Rect], direction: str = "ltr"
) -> OrderInfo:
    """计算阅读顺序。direction: 'ltr' 左到右, 'rtl' 右到左。"""
    if not panels:
        return OrderInfo([], [], set(), {}, direction)

    bands = build_bands(panels)
    band_of: dict[int, int] = {}
    for bi, ids in enumerate(bands):
        for i in ids:
            band_of[i] = bi

    heights = [r[3] - r[1] for r in panels]
    median_h = float(np_median(heights))

    def overlap_with_band(i: int, bi: int) -> int:
        """面板 i 与某带内所有普通格的纵向重叠之和 (只看 y, 不看 x:
        跨行格常与被跨行的格左右错开, 但 y 上确实压着)。"""
        x0, y0, x1, y1 = panels[i]
        total = 0
        for j in bands[bi]:
            if j == i:
                continue
            by0, by1 = panels[j][1], panels[j][3]
            total += max(0, min(y1, by1) - max(y0, by0))
        return total

    # 跨行格: 高度显著高于中位, 且与两个及以上带的普通格有纵向重叠
    spanning: set[int] = set()
    if len(bands) > 1:
        for i, h in enumerate(heights):
            if h < 1.6 * median_h:
                continue
            touched = sum(
                1 for bi in range(len(bands))
                if overlap_with_band(i, bi) > 0
            )
            if touched >= 2:
                spanning.add(i)

    # 归属带 = 重叠面积最大的带 (通常就是顶部所在带)
    owner_band: dict[int, int] = {}
    for i in spanning:
        best_b, best_ov = band_of[i], -1
        for bi in range(len(bands)):
            ov = overlap_with_band(i, bi)
            if ov > best_ov:
                best_ov, best_b = ov, bi
        owner_band[i] = best_b

    # 普通格留在自己的聚类带; 跨行格从原带移到归属带
    placed: dict[int, list[int]] = {bi: [] for bi in range(len(bands))}
    for i in range(len(panels)):
        target = owner_band.get(i, band_of[i])
        placed[target].append(i)

    order: list[int] = []
    band_records: list[tuple[int, list[int]]] = []
    for bi in range(len(bands)):
        ids = placed[bi]
        ids.sort(
            key=lambda i: panels[i][0],
            reverse=(direction == "rtl"),
        )
        band_records.append((bi, ids))
        order.extend(ids)

    return OrderInfo(
        order=order,
        bands=band_records,
        spanning=spanning,
        owner_band=owner_band,
        direction=direction,
    )


def np_median(values: list[int]) -> float:
    # 小列表手写中位数, 避免这个模块强依赖 numpy 的 import 顺序问题
    s = sorted(values)
    m = len(s)
    if m == 0:
        return 0.0
    mid = m // 2
    if m % 2:
        return float(s[mid])
    return (s[mid - 1] + s[mid]) / 2.0
