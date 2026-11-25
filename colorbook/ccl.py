"""4 连通区域标记：按相邻像素找出每个需要各填一次颜色的区域。

用"逐行行程(run-length)+并查集"实现，比逐像素 Python 循环快得多，
且不依赖 scipy。同色但不接触的两个部分会得到不同标签，
正是涂色页需要的语义：每个连通块各填一次。
"""

from __future__ import annotations

import numpy as np
from PIL import Image


class DSU:
    """并查集，路径压缩 + 按大小合并。"""

    __slots__ = ("parent", "size")

    def __init__(self, n: int = 0) -> None:
        self.parent = list(range(n))
        self.size = [1] * n

    def add(self) -> int:
        idx = len(self.parent)
        self.parent.append(idx)
        self.size.append(1)
        return idx

    def find(self, x: int) -> int:
        parent = self.parent
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != x:
            parent[x], x = root, parent[x]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.size[ra] < self.size[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        self.size[ra] += self.size[rb]


def to_rgb_array(image: Image.Image) -> np.ndarray:
    """统一成 RGB 的 (H, W, 3) uint8 数组；半透明像素合成到白底。"""
    if image.mode in ("RGBA", "LA") or (
        image.mode == "P" and "transparency" in image.info
    ):
        rgba = image.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        image = Image.alpha_composite(bg, rgba).convert("RGB")
    else:
        image = image.convert("RGB")
    return np.asarray(image, dtype=np.uint8)


def label_connected(rgb: np.ndarray) -> dict:
    """对 RGB 图做 4 连通标记，颜色不同的相邻像素不算连通。

    返回字典:
      labels : (H, W) int32，0..N-1 的连续区域标签
      colors : (N, 3) uint8，每个标签的颜色
      areas  : (N,) int64，像素面积
      bboxes : (N, 4) int64，每块 (min_y, min_x, max_y, max_x)（含端点）
    """
    h, w = rgb.shape[:2]
    if h == 0 or w == 0:
        raise ValueError("空图像无法标记区域")

    # (r,g,b) 打包成单个 int，方便逐像素比较
    packed = (
        rgb[:, :, 0].astype(np.int64) * 65536
        + rgb[:, :, 1].astype(np.int64) * 256
        + rgb[:, :, 2].astype(np.int64)
    )

    dsu = DSU()
    # 扫描过程中按"根标签"累计统计量；union 后根可能变化，结束时再归并
    root_color: dict[int, int] = {}
    root_area: dict[int, int] = {}
    root_bbox: dict[int, list[int]] = {}

    # 标签图先写并查集的根，最后一次性重映射成连续 id
    raw_labels = np.empty((h, w), dtype=np.int32)
    # 上一行行程: (start, end_exclusive, color_packed, label)
    prev_runs: list[tuple[int, int, int, int]] = []

    for y in range(h):
        row = packed[y]
        changes = np.flatnonzero(np.diff(row)) + 1
        bounds = np.concatenate(([0], changes, [w]))
        cur_runs: list[tuple[int, int, int, int]] = []
        for k in range(len(bounds) - 1):
            s, e = int(bounds[k]), int(bounds[k + 1])
            color = int(row[s])
            label = dsu.add()

            # 与上一行颜色相同且 x 区间相交的行程连通
            for ps, pe, pcolor, plabel in prev_runs:
                if ps >= e:
                    break
                if pe > s and pcolor == color:
                    dsu.union(label, plabel)

            root = dsu.find(label)
            raw_labels[y, s:e] = root
            root_color[root] = color
            root_area[root] = root_area.get(root, 0) + (e - s)
            bbox = root_bbox.get(root)
            if bbox is None:
                root_bbox[root] = [y, s, y, e - 1]
            else:
                if s < bbox[1]:
                    bbox[1] = s
                if e - 1 > bbox[3]:
                    bbox[3] = e - 1
                # y 单调递增，直接更新
                bbox[2] = y
            cur_runs.append((s, e, color, label))
        prev_runs = cur_runs

    # union 会让旧根挂到新根下，把统计量统一归并到最终根
    final_roots: dict[int, int] = {}
    for old_root in list(root_color.keys()):
        final = dsu.find(old_root)
        final_roots[old_root] = final
        if final != old_root:
            root_area[final] = root_area.get(final, 0) + root_area.pop(old_root)
            old_bbox = root_bbox.pop(old_root)
            bbox = root_bbox.get(final)
            if bbox is None:
                root_bbox[final] = old_bbox
            else:
                bbox[0] = min(bbox[0], old_bbox[0])
                bbox[1] = min(bbox[1], old_bbox[1])
                bbox[2] = max(bbox[2], old_bbox[2])
                bbox[3] = max(bbox[3], old_bbox[3])

    sorted_roots = sorted(root_bbox.keys())
    root_to_id = {root: i for i, root in enumerate(sorted_roots)}
    n = len(sorted_roots)

    remap = np.zeros(len(dsu.parent), dtype=np.int32)
    for old_root, final in final_roots.items():
        remap[old_root] = root_to_id[final]
    labels = remap[raw_labels]

    colors = np.zeros((n, 3), dtype=np.uint8)
    areas = np.zeros(n, dtype=np.int64)
    bboxes = np.zeros((n, 4), dtype=np.int64)
    for root, lid in root_to_id.items():
        packed_color = root_color[root]
        colors[lid] = (
            (packed_color >> 16) & 255,
            (packed_color >> 8) & 255,
            packed_color & 255,
        )
        areas[lid] = root_area[root]
        bboxes[lid] = root_bbox[root]

    return {
        "labels": labels,
        "colors": colors,
        "areas": areas,
        "bboxes": bboxes,
    }
