"""阈值、连通域统计与筛选。与 Qt 完全解耦，便于精确测试。

口径
----
- **二值处理范围**：整幅图像；阈值后的掩码是去噪/填隙之前的那一层（界面中的“二值图”）。
- **连通域**：对最终前景按 4 或 8 邻接标记；相连物体算一个，不做实例拆分。
- **孔洞**：与前景互补的邻接口径 —— 前景 8 邻接时，孔洞背景按 4 邻接标记；
  前景 4 邻接时，孔洞背景按 8 邻接标记。只统计被该区域完全包围、且不连到图像边界的背景块。
- **面积**：区域自身的前景像素个数，不包含孔洞。
- **质心**：按像素中心统计，即 x+0.5 / y+0.5 的平均。
- **编号**：按区域最上方像素的 y 最小、同一行再 x 最小的顺序，从 1 连续编号。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .models import (
    Connectivity,
    FilterCriteria,
    FilterReason,
    Polarity,
    RegionRecord,
    RegionStats,
    SegmentationResult,
    SegmentParams,
    ThresholdMode,
    ThresholdParams,
)

DEFAULT_CRITERIA = FilterCriteria(min_area=0, max_area=0, exclude_border=False)


def complementary_connectivity(conn: Connectivity) -> int:
    """前景 4 邻接 ↔ 孔洞 8 邻接；前景 8 邻接 ↔ 孔洞 4 邻接。"""
    return 8 if conn is Connectivity.FOUR else 4


def disk_area(radius: int) -> int:
    """半径 r 的圆盘像素数；界面用“等效半径”表达去噪/填隙的面积上限。"""
    if radius <= 0:
        return 0
    yy, xx = np.mgrid[-radius:radius + 1, -radius:radius + 1]
    return int(((xx * xx + yy * yy) <= radius * radius).sum())


def _validate_threshold(p: ThresholdParams) -> None:
    if not 0 <= int(p.fixed_value) <= 255:
        raise ValueError("固定阈值需在 0..255 之间")
    if p.local_radius < 0:
        raise ValueError("局部阈值半径不能为负")
    if p.local_offset < 0:
        raise ValueError("局部阈值偏移不能为负")


def threshold_mask(gray: np.ndarray, p: ThresholdParams) -> np.ndarray:
    """返回二值处理范围（uint8，0/1）。

    固定阈值：亮目标取 gray > t，暗目标取 gray < t（严格比较）。
    局部阈值：以 (2r+1)×(2r+1) 邻域均值作为每像素阈值；亮目标需高出均值 offset，
    暗目标需低于均值 offset。
    """
    _validate_threshold(p)
    if gray.ndim != 2:
        raise ValueError("阈值输入必须是灰度图")
    if p.mode is ThresholdMode.FIXED:
        mask = gray > p.fixed_value if p.polarity is Polarity.BRIGHT else gray < p.fixed_value
    else:
        k = 2 * int(p.local_radius) + 1
        mean = cv2.blur(gray.astype(np.float32), (k, k), borderType=cv2.BORDER_REPLICATE)
        if p.polarity is Polarity.BRIGHT:
            mask = gray.astype(np.float32) > mean + float(p.local_offset)
        else:
            mask = gray.astype(np.float32) < mean - float(p.local_offset)
    return mask.astype(np.uint8)


def _remove_small_components(mask: np.ndarray, max_area: int, conn: Connectivity) -> np.ndarray:
    """删除面积 <= max_area 的独立小块；保留区域的像素原样不动。"""
    if max_area <= 0 or not mask.any():
        return mask
    n, lbl, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=conn.value)
    if n <= 1:
        return mask
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = np.zeros(n, dtype=np.uint8)
    keep[1:] = (areas > max_area).astype(np.uint8)
    return keep[lbl]


def _fill_small_holes(mask: np.ndarray, max_area: int, conn: Connectivity) -> tuple[np.ndarray, np.ndarray]:
    """填补面积 <= max_area、且完全不连到图像边界的背景孔洞。"""
    if max_area <= 0 or not mask.any():
        return mask, np.zeros_like(mask)
    inv_conn = complementary_connectivity(conn)
    n, lbl, stats, _ = cv2.connectedComponentsWithStats((mask == 0).astype(np.uint8),
                                                       connectivity=inv_conn)
    if n <= 1:
        return mask, np.zeros_like(mask)
    border_ids = set(np.unique(np.concatenate([lbl[0, :], lbl[-1, :], lbl[:, 0], lbl[:, -1]])).tolist())
    areas = stats[:, cv2.CC_STAT_AREA]
    fill_ids = [i for i in range(1, n) if int(areas[i]) <= max_area and i not in border_ids]
    if not fill_ids:
        return mask, np.zeros_like(mask)
    fill = np.isin(lbl, fill_ids)
    out = mask.copy()
    out[fill] = 1
    return out, fill.astype(np.uint8)


@dataclass(frozen=True)
class HoleSummary:
    count: int
    area: int
    ys: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.int64))
    xs: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.int64))


def _region_holes(labels: np.ndarray, lab: int, x0: int, y0: int, x1: int, y1: int,
                  conn: Connectivity) -> HoleSummary:
    """单个区域的孔洞数、孔洞面积与孔洞像素（整图坐标）。

    在该区域外接矩形（外扩 1 像素）的裁剪框里，只把本区域当背景以外的前景，
    其余像素都视为背景；按互补邻接标记背景，凡是不连到裁剪框边界的背景块
    就是本区域的孔洞。裁剪框边界在区域外接矩形之外，因此不会把区域内部的
    孔洞误当成外部背景。

    孔洞面积只累计真正的背景像素（labels==0），不把落在孔内的其它前景编号
    算进孔洞面积；区域自身的面积本来就不包含孔洞。若某片背景由两个区域
    共同围成、各自单独都关不住它，则两边都不计为孔洞（孔洞必须属于某个区域）。
    """
    inv_conn = complementary_connectivity(conn)
    h, w = labels.shape
    py0, py1 = max(0, y0 - 1), min(h, y1 + 1)
    px0, px1 = max(0, x0 - 1), min(w, x1 + 1)
    crop_labels = labels[py0:py1, px0:px1]
    sub = (crop_labels == lab).astype(np.uint8)
    inv = (sub == 0).astype(np.uint8)
    n, clbl, cstats, _ = cv2.connectedComponentsWithStats(inv, connectivity=inv_conn)
    if n <= 1:
        return HoleSummary(0, 0)
    border = set(np.unique(np.concatenate([
        clbl[0, :], clbl[-1, :], clbl[:, 0], clbl[:, -1],
    ])).tolist())
    count = 0
    area = 0
    chunks_y: list[np.ndarray] = []
    chunks_x: list[np.ndarray] = []
    for bi in range(1, n):
        if bi in border:
            continue
        comp = clbl == bi
        real_bg = comp & (crop_labels == 0)
        bg_count = int(np.count_nonzero(real_bg))
        if bg_count <= 0:
            # 口袋完全被其它编号占据（数字拓扑下的岛），不属于本区域的孔洞
            continue
        count += 1
        area += bg_count
        yy, xx = np.nonzero(real_bg)
        chunks_y.append(yy + py0)
        chunks_x.append(xx + px0)
    if chunks_y:
        return HoleSummary(count, area, np.concatenate(chunks_y), np.concatenate(chunks_x))
    return HoleSummary(count, area)


def reevaluate(result: SegmentationResult, criteria: FilterCriteria | None = None,
               manual_ignored: set[int] | None = None) -> SegmentationResult:
    """只重新应用面积/触边/人工筛选，不重新分割。

    被筛掉的区域仍保留在 labels、mask 和表格里；仅 included 与 reason 变化。
    """
    criteria = criteria or DEFAULT_CRITERIA
    manual = set(manual_ignored or ())
    for rec in result.regions:
        rec.reason = criteria.check(rec.stats, manual=rec.stats.label_id in manual)
        rec.included = rec.reason is FilterReason.KEPT
    included = [r for r in result.regions if r.included]
    excluded = [r for r in result.regions if not r.included]
    result.calc.update({
        "total": len(result.regions),
        "included": len(included),
        "included_area": sum(r.stats.area for r in included),
        "excluded": len(excluded),
        "excluded_area": sum(r.stats.area for r in excluded),
    })
    return result


def segment(gray: np.ndarray, params: SegmentParams, criteria: FilterCriteria | None = None,
            manual_ignored: set[int] | None = None) -> SegmentationResult:
    """执行一次完整分割，返回真实重新计算的标签场、统计与筛选结果。

    manual_ignored 使用本轮编号；调用方在分割参数变化后应清空它，避免把旧编号
    绑定到新物体上。仅改变筛选条件时调用 reevaluate 即可。
    """
    if gray.ndim != 2:
        raise ValueError("segment 只接受灰度图")
    conn = params.connectivity
    base = threshold_mask(gray, params.threshold)
    working = _remove_small_components(base, disk_area(params.despeckle_radius), conn)
    filled, fill_pixels = _fill_small_holes(working, disk_area(params.fill_radius), conn)
    mask = filled.astype(np.uint8)

    n, raw, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=conn.value)

    # 编号：按“最小光栅索引”排序，等价于最上方、同一行最左方。
    # 前景像素通常远少于整图，取前景索引后按标签求首个下标即可。
    flat = raw.reshape(-1)
    fg_idx = np.flatnonzero(flat)
    if fg_idx.size:
        fg_lbl = flat[fg_idx]
        uniq_lbl, first_pos = np.unique(fg_lbl, return_index=True)
        order = uniq_lbl[np.argsort(fg_idx[first_pos], kind="stable")].astype(np.int32)
    else:
        order = np.empty(0, dtype=np.int32)
    remap = np.zeros(max(n, 1), dtype=np.int32)
    for new_id, old_id in enumerate(order.tolist(), start=1):
        remap[int(old_id)] = new_id
    labels = remap[raw]

    touches_set = set(np.unique(np.concatenate([
        labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1],
    ])).tolist())

    regions: list[RegionRecord] = []
    hole_map = np.zeros_like(mask)
    for new_id, old_id in enumerate(order.tolist(), start=1):
        area = int(stats[old_id, cv2.CC_STAT_AREA])
        if area <= 0:
            continue
        x0 = int(stats[old_id, cv2.CC_STAT_LEFT])
        y0 = int(stats[old_id, cv2.CC_STAT_TOP])
        x1 = x0 + int(stats[old_id, cv2.CC_STAT_WIDTH])
        y1 = y0 + int(stats[old_id, cv2.CC_STAT_HEIGHT])
        # OpenCV 的质心是像素索引的均值；加 0.5 换成像素中心坐标。
        cx = float(centroids[old_id][0] + 0.5)
        cy = float(centroids[old_id][1] + 0.5)
        holes = _region_holes(labels, new_id, x0, y0, x1, y1, conn)
        if holes.ys.size:
            hole_map[holes.ys, holes.xs] = 1
        st = RegionStats(
            label_id=new_id,
            area=area,
            centroid_x=cx,
            centroid_y=cy,
            bbox=(x0, y0, x1 - x0, y1 - y0),
            touches_border=new_id in touches_set,
            hole_count=holes.count,
            hole_area=holes.area,
        )
        regions.append(RegionRecord(stats=st))

    calc = {
        "foreground_pixels": int(mask.sum()),
        "base_pixels": int(base.sum()),
        "removed_small_pixels": int(base.sum()) - int(working.sum()),
        "filled_pixels": int(fill_pixels.sum()),
        "hole_pixels": int(hole_map.sum()),
        "despeckle_area": disk_area(params.despeckle_radius),
        "fill_area": disk_area(params.fill_radius),
    }
    result = SegmentationResult(
        base_mask=base, mask=mask, labels=labels, regions=regions,
        params=params, hole_mask=hole_map, calc=calc,
    )
    return reevaluate(result, criteria, manual_ignored)


def hit_region(result: SegmentationResult | None, x: int, y: int) -> int | None:
    """图片坐标点击命中；只认严格落在前景像素上的编号。

    点击背景、孔洞或图外都返回 None，不做“最近物体”吸附。
    """
    if result is None:
        return None
    h, w = result.labels.shape
    if not (0 <= x < w and 0 <= y < h):
        return None
    lab = int(result.labels[y, x])
    return lab if lab > 0 else None
