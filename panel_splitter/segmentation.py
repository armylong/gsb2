"""直缝递归切分。

思路: 把整页当作一个矩形, 在当前矩形内分别找「横向空白带」和「纵向空白带」,
取评分更高的一条 *通缝* 把矩形一分为二, 再递归处理两个子矩形。

关键性质:
- 只有横跨当前矩形整个边长的空白带才算通缝。一侧两小格、另一侧一大格
  (T 形接版) 时, 先切通长的那条缝, 局部缝在子矩形里自然变成通缝,
  不会把整页硬套成规则行列网格。
- 被内容打断、盖不满整个边长的缝进 partial_cuts, 界面用虚线画出,
  作为「这里可能需要补断缝」的提示, 不参与自动切分。
- 背景判定用纸张亮度的高分位, 而不是全局 Otsu: 浅底色面板不会被当成纸缝,
  浅灰纸缝 (#e6e6e6 这类) 又仍能判成背景。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

# 矩形约定: (x0, y0, x1, y1), 半开区间, 原图像素坐标
Rect = tuple[int, int, int, int]


@dataclass
class Cut:
    """一条检测到的直缝。

    orientation='h' 横向缝 (沿 x 延伸, 切上下), pos 为行坐标;
    orientation='v' 纵向缝 (沿 y 延伸, 切左右), pos 为列坐标。
    start/end 是缝在另一个轴上的覆盖范围 (半开)。
    """

    orientation: str
    pos: int
    start: int
    end: int
    depth: int
    coverage: float  # 覆盖范围内背景占比, 1.0 表示完整通缝

    def as_rect(self) -> Rect:
        if self.orientation == "h":
            return (self.start, self.pos, self.end, self.pos + 1)
        return (self.pos, self.start, self.pos + 1, self.end)


@dataclass
class SegmentationResult:
    panels: list[Rect]
    cuts: list[Cut]
    partial_cuts: list[Cut] = field(default_factory=list)
    background_threshold: int = 0


def build_background_mask(image_bgr: np.ndarray) -> tuple[np.ndarray, int]:
    """返回背景掩膜 (255=纸缝/留白, 0=内容) 和使用的亮度阈值。

    纸张白度取全图亮度 95 分位 (页边距和缝占了足够像素), 再留 25 级容差,
    这样 #e6e6e6 的浅灰缝算背景, 而更暗的面板底色 / 图形不算。
    """
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    paper = int(np.percentile(gray, 95))
    median = int(np.median(gray))
    # 整页亮度几乎一致 (没有真正的留白) 时, 不能把内容也当背景:
    # 只认接近纯白的像素, 避免纯色页被切成碎片
    if paper - median <= 12:
        threshold = max(245, paper - 4)
    else:
        threshold = max(180, paper - 25)
    mask = np.where(gray >= threshold, 255, 0).astype(np.uint8)
    # 不做腐蚀/中值: 窄纸缝必须原样保留; 扫描噪点由 line_bg 占比门槛容忍
    return mask, threshold


def _gap_runs(flag: np.ndarray) -> list[tuple[int, int]]:
    """布尔数组里连续 True 段的 [start, end) 列表。"""
    if flag.size == 0:
        return []
    padded = np.concatenate(([False], flag, [False]))
    diff = np.diff(padded.astype(np.int8))
    starts = np.where(diff == 1)[0]
    ends = np.where(diff == -1)[0]
    return list(zip(starts.tolist(), ends.tolist(), strict=True))


def _find_cuts(
    mask: np.ndarray,
    rect: Rect,
    orientation: str,
    min_gap: int,
    min_side: int,
    line_bg_thresh: float,
    full_span_thresh: float,
    partial_bg_thresh: float,
) -> tuple[Cut | None, list[Cut]]:
    """在 rect 内找某方向的缝。

    返回 (最佳通缝或 None, 局部缝列表)。
    - 严格门槛 line_bg_thresh 找完整通缝, 通缝要求空白带横跨 rect 整个边长;
    - 宽松门槛 partial_bg_thresh 额外捞带断口的局部缝 (断缝提示), 不参与切分。
    """
    x0, y0, x1, y1 = rect
    region = mask[y0:y1, x0:x1]
    h, w = region.shape

    if orientation == "h":
        line_bg = (region == 255).mean(axis=1)
        dim, cross = h, w
    else:
        line_bg = (region == 255).mean(axis=0)
        dim, cross = w, h

    full: Cut | None = None
    full_score = -1.0
    partials: list[Cut] = []
    seen_positions: set[int] = set()

    # 先按宽松门槛枚举所有候选空白带, 再分级
    for start, end in _gap_runs(line_bg >= partial_bg_thresh):
        run_len = end - start
        if run_len < min_gap:
            continue
        pos = start + run_len // 2
        if pos < min_side or dim - pos < min_side:
            continue
        coverage = float(line_bg[start:end].mean())

        # 缝在另一个轴上的真实背景段 (断口之外的部分)
        band_bg = (
            (region[start:end, :] == 255).mean(axis=0)
            if orientation == "h"
            else (region[:, start:end] == 255).mean(axis=1)
        )
        bg_runs = _gap_runs(band_bg >= line_bg_thresh)
        if bg_runs:
            cover_start = bg_runs[0][0]
            cover_end = bg_runs[-1][1]
        else:
            cover_start, cover_end = 0, cross
        # 通缝看的是空白带在「另一个轴」上盖住的比例
        span = (cover_end - cover_start) / cross
        is_full_line = bool(np.all(line_bg[start:end] >= line_bg_thresh))

        if orientation == "h":
            cut = Cut(
                "h", y0 + pos,
                x0 + cover_start, x0 + cover_end,
                -1, coverage,
            )
        else:
            cut = Cut(
                "v", x0 + pos,
                y0 + cover_start, y0 + cover_end,
                -1, coverage,
            )

        if is_full_line and span >= full_span_thresh:
            score = coverage * span
            if score > full_score:
                full_score, full = score, cut
            seen_positions.add(pos)
        elif not is_full_line and pos not in seen_positions:
            # 局部缝: 有明显断口, 留作人工补缝提示
            partials.append(cut)

    return full, partials


def segment_image(
    image_bgr: np.ndarray,
    *,
    line_bg_thresh: float = 0.95,
    full_span_thresh: float = 0.97,
    partial_bg_thresh: float = 0.85,
    min_gap_frac: float = 0.01,
    min_side_frac: float = 0.06,
    max_depth: int = 12,
) -> SegmentationResult:
    """对整页图做递归直缝切分。

    line_bg_thresh: 一条扫描线上背景像素占比超过它才算完整空白线。
    full_span_thresh: 空白带占当前矩形边长超过它才算通缝。
    partial_bg_thresh: 宽松门槛, 用于发现带断口的局部缝 (只提示不切分)。
    min_gap_frac: 缝宽至少占整页短边的比例。
    min_side_frac: 切出的格子短边至少占整页短边的比例。
    """
    mask, threshold = build_background_mask(image_bgr)
    page_h, page_w = mask.shape[:2]

    # 内容像素占比极低 (近空白页) 时直接返回整页, 否则满屏都是假缝
    content_frac = float((mask == 0).mean())
    if content_frac < 0.01:
        return SegmentationResult(
            panels=[(0, 0, page_w, page_h)],
            cuts=[],
            partial_cuts=[],
            background_threshold=threshold,
        )

    min_gap = max(3, int(round(min_gap_frac * min(page_h, page_w))))
    min_side = max(8, int(round(min_side_frac * min(page_h, page_w))))

    panels: list[Rect] = []
    cuts: list[Cut] = []
    partial_cuts: list[Cut] = []
    root: Rect = (0, 0, page_w, page_h)

    def walk(rect: Rect, depth: int) -> None:
        if depth > max_depth:
            panels.append(rect)
            return
        x0, y0, x1, y1 = rect
        h_full, h_part = _find_cuts(
            mask, rect, "h", min_gap, min_side,
            line_bg_thresh, full_span_thresh, partial_bg_thresh,
        )
        v_full, v_part = _find_cuts(
            mask, rect, "v", min_gap, min_side,
            line_bg_thresh, full_span_thresh, partial_bg_thresh,
        )
        partial_cuts.extend(h_part)
        partial_cuts.extend(v_part)

        if h_full is None and v_full is None:
            panels.append(rect)
            return
        # 通缝之间取覆盖更完整的, 同分时横缝优先, 结果稳定
        if v_full is None or (
            h_full is not None and h_full.coverage >= v_full.coverage
        ):
            cut = h_full
        else:
            cut = v_full

        cut.depth = depth
        cuts.append(cut)

        if cut.orientation == "h":
            walk((x0, y0, x1, cut.pos), depth + 1)
            walk((x0, cut.pos, x1, y1), depth + 1)
        else:
            walk((x0, y0, cut.pos, y1), depth + 1)
            walk((cut.pos, y0, x1, y1), depth + 1)

    walk(root, 0)
    panels.sort(key=lambda r: (r[1], r[0], r[3], r[2]))

    # 同一条局部缝会在父子矩形里各出现一次, 按 (方向, 位置) 去重, 保留覆盖最长的
    dedup: dict[tuple[str, int], Cut] = {}
    for cut in partial_cuts:
        key = (cut.orientation, cut.pos)
        old = dedup.get(key)
        if old is None or (cut.end - cut.start) > (old.end - old.start):
            dedup[key] = cut
    partial_cuts = sorted(
        dedup.values(), key=lambda c: (c.orientation, c.pos)
    )

    return SegmentationResult(
        panels=panels,
        cuts=cuts,
        partial_cuts=partial_cuts,
        background_threshold=threshold,
    )
