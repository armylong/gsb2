"""数字标签落位：找区域内放得下文字的位置，放不下时移到外部加引线。

距离变换用 chamfer-3/4 两次扫描（纯 numpy），不依赖 scipy。
带孔区域的孔会自然被当成"外部"，距离值为 0；
狭长区域内部找不到足够空间时，沿 8 个方向把标签放到区域旁边并画引线。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class LabelPlan:
    """一个区域的标签落位方案。"""

    region_id: int
    text: str
    anchor: tuple[int, int]           # 文字外接框左上角（图像坐标）
    box_size: tuple[int, int]          # (宽, 高)
    inside: bool                       # 是否落在区域内部（允许小幅覆盖边界）
    fits: bool                         # 是否存在可用落位
    overflow: bool = False             # 框比区域大，数字压在区域上、盖住部分边界
    leader_to: tuple[int, int] | None = None  # 外部标签时引线指向的区域内点
    reason: str = ""


def chamfer_distance(mask: np.ndarray) -> np.ndarray:
    """二值前景 mask 的 chamfer-3/4 距离变换（3=直边步长，4=对角步长）。

    经典两遍扫描：
      前向模板  上(3)  左上(4)  右上(4)  左(3)
      后向模板  下(3)  左下(4)  右下(4)  右(3)
    所有邻域更新都用独立临时数组，避免 numpy 切片原地写入互相污染。
    返回前景像素到最近背景像素的近似距离，背景像素为 0；
    整幅都是前景时距离按"到图像边界外"不可达处理，返回大值。
    """
    h, w = mask.shape
    INF = 10 ** 9
    dist = np.where(mask, INF, 0).astype(np.int64)
    if h == 0 or w == 0:
        return dist

    def shifted(arr: np.ndarray, dy: int, dx: int) -> np.ndarray:
        """把 arr 平移 (dy, dx)，空缺位置填 INF（图像外不是背景）。"""
        out = np.full_like(arr, INF)
        sy0, sy1 = max(0, dy), min(h, h + dy)
        sx0, sx1 = max(0, dx), min(w, w + dx)
        oy0, oy1 = max(0, -dy), min(h, h - dy)
        ox0, ox1 = max(0, -dx), min(w, w - dx)
        if sy1 > sy0 and sx1 > sx0:
            out[sy0:sy1, sx0:sx1] = arr[oy0:oy1, ox0:ox1]
        return out

    # 前向扫描：依赖上一行与左侧，行序自上而下、列序自左而右
    for y in range(h):
        cur = dist[y]
        if y > 0:
            up = dist[y - 1]
            cur = np.minimum(cur, up + 3)
            if w > 1:
                cur = np.minimum(cur, shifted(up[None, :], 0, -1)[0] + 4)
                cur = np.minimum(cur, shifted(up[None, :], 0, 1)[0] + 4)
        if w > 1:
            left = shifted(cur[None, :], 0, -1)[0]
            cur = np.minimum(cur, left + 3)
        dist[y] = cur

    # 后向扫描：依赖下一行与右侧
    for y in range(h - 1, -1, -1):
        cur = dist[y]
        if y < h - 1:
            down = dist[y + 1]
            cur = np.minimum(cur, down + 3)
            if w > 1:
                cur = np.minimum(cur, shifted(down[None, :], 0, -1)[0] + 4)
                cur = np.minimum(cur, shifted(down[None, :], 0, 1)[0] + 4)
        if w > 1:
            right = shifted(cur[None, :], 0, 1)[0]
            cur = np.minimum(cur, right + 3)
        dist[y] = cur

    return dist


def _box_fits(
    labels: np.ndarray,
    region_id: int,
    top: int,
    left: int,
    box_w: int,
    box_h: int,
) -> bool:
    """以 (top, left) 为左上角的文字框是否整块落在该区域内。"""
    h, w = labels.shape
    if top < 0 or left < 0 or top + box_h > h or left + box_w > w:
        return False
    patch = labels[top : top + box_h, left : left + box_w]
    return bool(np.all(patch == region_id))


def _first_region_pixel_on_ray(
    labels: np.ndarray,
    region_id: int,
    start: tuple[int, int],
    direction: tuple[int, int],
) -> tuple[int, int] | None:
    """从 start 沿方向走，找到第一个属于 region_id 的像素（引线落点）。"""
    h, w = labels.shape
    x, y = start
    dx, dy = direction
    steps = max(h, w)
    for _ in range(steps):
        x += dx
        y += dy
        if not (0 <= x < w and 0 <= y < h):
            return None
        if labels[y, x] == region_id:
            return x, y
    return None


def _box_inside_canvas(
    h: int, w: int, top: int, left: int, box_w: int, box_h: int
) -> bool:
    return top >= 0 and left >= 0 and top + box_h <= h and left + box_w <= w


def _box_coverage(
    labels: np.ndarray,
    region_id: int,
    top: int,
    left: int,
    box_w: int,
    box_h: int,
) -> float:
    """文字框覆盖范围内属于该区域的像素比例。"""
    h, w = labels.shape
    y0, y1 = max(0, top), min(h, top + box_h)
    x0, x1 = max(0, left), min(w, left + box_w)
    if y1 <= y0 or x1 <= x0:
        return 0.0
    patch = labels[y0:y1, x0:x1]
    return float((patch == region_id).mean())


def plan_region_label(
    labels: np.ndarray,
    region_id: int,
    text: str,
    box_w: int,
    box_h: int,
    manual_anchor: tuple[int, int] | None = None,
    max_candidates: int = 250,
    occupied_rects: list[tuple[int, int, int, int]] | None = None,
) -> LabelPlan:
    """为单个区域计算标签落位方案。

    分三档:
      A. 严格内部：文字框整块在区域内（距离变换找最宽处）；
      B. 覆盖落位：框比区域还大（小岛/小块），数字直接压在区域上，
         允许盖住边界，仍算 inside，标记 overflow；
      C. 外部引线：狭长/带孔区域内部没有空间，沿 8 个方向把框推到
         区域外足够远处，引线从框边连到区域内点；
      都失败则 fits=False，由界面列入问题清单。
    手动锚点优先，无效时退回自动方案。occupied_rects 是已确定的
    其他标签框 (x, y, w, h)，外部落位会避开它们。
    """
    occupied_rects = occupied_rects or []
    h, w = labels.shape
    ys, xs = np.nonzero(labels == region_id)
    if len(ys) == 0:
        return LabelPlan(
            region_id, text, (0, 0), (box_w, box_h),
            inside=False, fits=False, reason="区域为空",
        )

    min_y, max_y = int(ys.min()), int(ys.max())
    min_x, max_x = int(xs.min()), int(xs.max())
    centroid = (float(xs.mean()), float(ys.mean()))

    def make_inside(top: int, left: int, overflow: bool = False) -> LabelPlan:
        return LabelPlan(
            region_id, text, (left, top), (box_w, box_h),
            inside=True, fits=True, overflow=overflow,
        )

    # 1) 手动锚点：以点击位置为框中心，框在画布内即可（允许覆盖边界）
    if manual_anchor is not None:
        mx, my = manual_anchor
        top = my - box_h // 2
        left = mx - box_w // 2
        if _box_inside_canvas(h, w, top, left, box_w, box_h):
            strict = _box_fits(labels, region_id, top, left, box_w, box_h)
            return make_inside(top, left, overflow=not strict)

    # 2) 严格内部落位：bbox 裁剪范围内做距离变换
    pad = 1
    cy0 = max(0, min_y - pad)
    cy1 = min(h, max_y + pad + 1)
    cx0 = max(0, min_x - pad)
    cx1 = min(w, max_x + pad + 1)
    sub = labels[cy0:cy1, cx0:cx1] == region_id
    dist = chamfer_distance(sub)

    # 锚点像素到边界的 chamfer 距离需容纳半个文字框（3=直边步长权重）
    need = 3 * max(box_w, box_h) // 2 + 3
    eligible = np.argwhere(dist >= need)  # (row, col)，局部坐标
    if len(eligible) > 0:
        flat_dist = dist.ravel()
        flat_idx = np.ravel_multi_index((eligible[:, 0], eligible[:, 1]), dist.shape)
        scores = flat_dist[flat_idx]
        # 只在距离最大（最宽）的一批候选里挑离质心最近的
        limit = int(scores.max()) - 2
        good = eligible[scores >= limit]
        if len(good) > max_candidates:
            rng = np.random.default_rng(region_id)
            good = good[rng.choice(len(good), max_candidates, replace=False)]
        gy = good[:, 0] + cy0
        gx = good[:, 1] + cx0
        d2 = (gx - centroid[0]) ** 2 + (gy - centroid[1]) ** 2
        best = int(np.argmin(d2))
        cy, cx = int(gy[best]), int(gx[best])
        top = cy - box_h // 2
        left = cx - box_w // 2
        if _box_fits(labels, region_id, top, left, box_w, box_h):
            return make_inside(top, left)

    # 3) 覆盖落位：仅用于"整体偏小的岛/碎块"。要求:
    #    - 区域 bbox 两个方向都不远大于框（排除狭长带）；
    #    - 区域两个方向都至少有框的 60%（否则框比区域大太多，
    #      数字会显得脱离区域，改走外部引线更清楚）。
    region_w = max_x - min_x + 1
    region_h = max_y - min_y + 1
    ccx, ccy = int(round(centroid[0])), int(round(centroid[1]))
    is_compact = (
        region_w <= box_w * 3
        and region_h <= box_h * 3
        and region_w >= box_w * 0.6
        and region_h >= box_h * 0.6
    )
    top = ccy - box_h // 2
    left = ccx - box_w // 2
    if is_compact and _box_inside_canvas(h, w, top, left, box_w, box_h):
        coverage = _box_coverage(labels, region_id, top, left, box_w, box_h)
        if coverage >= 0.5:
            # 框比区域大时，让框相对区域 bbox 居中，数字盖住区域而不是偏向一侧
            aligned_top = (min_y + max_y + 1 - box_h) // 2
            aligned_left = (min_x + max_x + 1 - box_w) // 2
            # 夹回画布
            aligned_top = max(0, min(aligned_top, h - box_h))
            aligned_left = max(0, min(aligned_left, w - box_w))
            if _box_coverage(
                labels, region_id, aligned_top, aligned_left, box_w, box_h
            ) >= coverage * 0.9:
                top, left = aligned_top, aligned_left
            return LabelPlan(
                region_id, text, (left, top), (box_w, box_h),
                inside=True, fits=True, overflow=True,
                reason="区域略小于数字框，数字压在区域上绘制",
            )

    # 4) 外部引线：沿 8 个方向把框推到区域外，引线连回区域内点。
    #    狭长区域优先沿短轴（垂直于长边）方向，并先试空间更大的一侧，
    #    引线最短最清楚，也减少与其他区域挤在一起。
    region_center = (ccx, ccy)
    # 区域到画布四边的留白（注意 bbox 字段顺序是 min_y, min_x, max_y, max_x）
    room_up = min_y
    room_down = h - 1 - max_y
    room_left = min_x
    room_right = w - 1 - max_x
    if region_w >= region_h * 3:
        # 空间更大的一侧优先
        vertical = [(0, 1), (0, -1)] if room_down >= room_up else [(0, -1), (0, 1)]
        directions = vertical + [
            (-1, 0), (1, 0), (-1, -1), (1, -1), (-1, 1), (1, 1)
        ]
    elif region_h >= region_w * 3:
        horizontal = [(1, 0), (-1, 0)] if room_right >= room_left else [(-1, 0), (1, 0)]
        directions = horizontal + [
            (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)
        ]
    else:
        directions = [(0, -1), (0, 1), (-1, 0), (1, 0),
                      (-1, -1), (1, -1), (-1, 1), (1, 1)]
    # 外部框与区域 bbox 之间的固定间隙，引线清楚且标签不压区域
    gap = max(8, box_h // 2 + 2)
    candidates: list[LabelPlan] = []
    for dx, dy in directions:
        leader = _first_region_pixel_on_ray(
            labels, region_id, region_center, (dx, dy)
        )
        if leader is None:
            continue
        lx, ly = leader
        # 沿方向从区域 bbox 边界外推 gap，而不是只从引线点外推，
        # 避免框边缘仍压在区域实体上
        if dy < 0:       # 向上
            top = min_y - gap - box_h
            left = lx - box_w // 2
        elif dy > 0:     # 向下
            top = max_y + gap
            left = lx - box_w // 2
        elif dx < 0:     # 向左
            top = ly - box_h // 2
            left = min_x - gap - box_w
        else:            # 向右
            top = ly - box_h // 2
            left = max_x + gap

        if not _box_inside_canvas(h, w, top, left, box_w, box_h):
            continue
        # 外部框不应大面积压住自己（否则退化为覆盖落位）
        if _box_coverage(labels, region_id, top, left, box_w, box_h) >= 0.5:
            continue
        cur_rect = (left, top, box_w, box_h)
        # 避开已确定的其他标签框
        if any(_rects_intersect(cur_rect, other) for other in occupied_rects):
            continue
        candidates.append(
            LabelPlan(
                region_id, text, (left, top), (box_w, box_h),
                inside=False, fits=True, leader_to=leader,
                reason="区域内放不下，标签移到外部并用引线指示",
            )
        )
    if candidates:
        # directions 已按空间偏好排序，第一个候选即在最宽敞一侧
        return candidates[0]

    # 5) 所有方向都出画布
    fallback_top = min(max(top, 0), h - box_h)
    fallback_left = min(max(left, 0), w - box_w)
    return LabelPlan(
        region_id, text,
        (fallback_left, fallback_top),
        (box_w, box_h),
        inside=False, fits=False, leader_to=region_center,
        reason="区域过窄且画面边缘没有空间放置外部标签",
    )


def _rects_intersect(
    a: tuple[int, int, int, int],
    b: tuple[int, int, int, int],
    margin: int = 4,
) -> bool:
    """两个矩形是否相交（或距离小于 margin 像素），用于标签避让。

    margin 只用来消除真正的框体重叠/相切，不用它强行拉开视觉距离——
    过度避让会把外部标签推到更远、引线穿过其他区域的位置。
    """
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return not (
        ax + aw + margin <= bx
        or bx + bw + margin <= ax
        or ay + ah + margin <= by
        or by + bh + margin <= ay
    )


def resolve_label_overlaps(
    plans: dict[int, LabelPlan],
    canvas_size: tuple[int, int],
    region_bboxes: dict[int, tuple[int, int, int, int]] | None = None,
    region_ids: set[int] | None = None,
) -> dict[int, LabelPlan]:
    """消解外部标签与其他标签框的重叠。

    内部标签（含覆盖落位）不动；只调整 inside=False 的方案。
    策略：先在原位置附近沿引线方向小步外推；若越过区域 bbox 仍冲突，
    再尝试引线的反方向；保证引线仍指向原来的区域内点。
    区域实体不作为硬障碍（涂色页允许引线穿过相邻区域，文字有白底），
    只避免数字框互相压住。
    """
    w, h = canvas_size
    external = [pid for pid, p in plans.items() if not p.inside]
    external.sort(key=lambda pid: plans[pid].box_size[0] * plans[pid].box_size[1])

    def to_rect(x: int, y: int, bw: int, bh: int) -> tuple[int, int, int, int]:
        return x, y, bw, bh

    fixed_rects = [
        to_rect(p.anchor[0], p.anchor[1], p.box_size[0], p.box_size[1])
        for pid, p in plans.items()
        if p.inside
    ]

    for pid in external:
        plan = plans[pid]
        if plan.leader_to is None:
            continue
        ax, ay = plan.anchor
        bw, bh = plan.box_size
        cx_box, cy_box = ax + bw // 2, ay + bh // 2
        dx = plan.leader_to[0] - cx_box
        dy = plan.leader_to[1] - cy_box
        sx = 0 if dx == 0 else (1 if dx > 0 else -1)
        sy = 0 if dy == 0 else (1 if dy > 0 else -1)
        # 标签在引线反方向（远离区域），外推方向与 dx/dy 相反；
        # 两个候选方向：继续外推、或反向越过区域
        candidate_steps = [(-sx, -sy), (sx, sy)]

        best: tuple[int, int] | None = None
        for step_x, step_y in candidate_steps:
            cur_ax, cur_ay = ax, ay
            for _ in range(max(w, h) // 4):
                cur_rect = to_rect(cur_ax, cur_ay, bw, bh)
                if not any(_rects_intersect(cur_rect, o) for o in fixed_rects):
                    best = (cur_ax, cur_ay)
                    break
                next_ax = cur_ax + step_x * 4
                next_ay = cur_ay + step_y * 4
                if not (
                    0 <= next_ax
                    and next_ax + bw <= w
                    and 0 <= next_ay
                    and next_ay + bh <= h
                ):
                    break
                cur_ax, cur_ay = next_ax, next_ay
            if best is not None:
                break

        if best is not None and best != (ax, ay):
            plans[pid] = LabelPlan(
                plan.region_id,
                plan.text,
                best,
                plan.box_size,
                inside=False,
                fits=plan.fits,
                overflow=False,
                leader_to=plan.leader_to,
                reason=plan.reason,
            )
        final_pos = best if best is not None else (ax, ay)
        fixed_rects.append(to_rect(final_pos[0], final_pos[1], bw, bh))
    return plans
