"""核心合成流水线: 只依赖输入图片与用户设置, 与界面解耦, 可被校验脚本复用。

compute_all 不读取任何样例答案/真值文件。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .alignment import (
    AlignParams,
    common_valid,
    crop_rect,
    valid_mask,
    warp_to_reference,
)
from .fusion import FusionParams, compute_weights, focus_score

# 来源编号图的配色 (BGR), 最多 6 张
SOURCE_COLORS_BGR = [
    (80, 80, 230),
    (230, 160, 80),
    (120, 200, 90),
    (70, 190, 230),
    (220, 120, 180),
    (200, 200, 90),
]


@dataclass
class Stroke:
    """人工笔迹, 坐标一律为参考图坐标。"""

    points: list[tuple[float, float]]
    radius: float
    source: int  # 0..N-1 指定来源; -1 = 擦除(恢复自动)


@dataclass
class Results:
    warped: list[np.ndarray]      # 各输入对齐到参考坐标后的图 (uint8 BGR)
    valids: list[np.ndarray]      # 各输入有效掩膜 (bool)
    common: np.ndarray            # 公共有效区 (bool)
    crop: tuple[int, int, int, int]  # 公共有效区外接矩形 (x, y, w, h)
    scores: list[np.ndarray]      # 各输入清晰度
    weights: np.ndarray           # (N,H,W) 自动权重
    label_auto: np.ndarray        # 自动来源编号 (255=无效)
    conf: np.ndarray              # 置信度
    override: np.ndarray          # 人工指定图 (int16, -1=自动)
    rejected: int                 # 因目标来源无效被拒绝的笔迹像素数
    label_final: np.ndarray       # 人工修正后来源编号
    img_auto: np.ndarray          # 自动合成结果
    img_final: np.ndarray         # 人工修正后合成结果


def rasterize_overrides(
    strokes: list[Stroke],
    shape: tuple[int, int],
    valids: list[np.ndarray],
) -> tuple[np.ndarray, int]:
    """把笔迹栅格化为 override 图。目标来源无效(图外)的像素被拒绝并计数。"""
    ovr = np.full(shape, -1, dtype=np.int16)
    rejected = 0
    for st in strokes:
        mask = np.zeros(shape, dtype=np.uint8)
        r = max(1, int(round(st.radius)))
        if len(st.points) == 1:
            cx, cy = int(round(st.points[0][0])), int(round(st.points[0][1]))
            cv2.circle(mask, (cx, cy), r, 1, thickness=-1)
        else:
            pts = np.array(st.points, dtype=np.int32).reshape(-1, 1, 2)
            cv2.polylines(mask, [pts], False, 1, thickness=r * 2)
        m = mask.astype(bool)
        if st.source < 0:
            ovr[m] = -1
        else:
            ok = m & valids[st.source]
            bad = m & ~valids[st.source]
            rejected += int(bad.sum())
            ovr[ok] = st.source
    return ovr, rejected


def _blend(warped: list[np.ndarray], weights: np.ndarray) -> np.ndarray:
    acc = np.zeros(warped[0].shape, dtype=np.float32)
    for img, wi in zip(warped, weights):
        acc += img.astype(np.float32) * wi[..., None]
    return np.clip(acc + 0.5, 0, 255).astype(np.uint8)


def compute_all(
    images: list[np.ndarray],
    ref: int,
    aligns: list[AlignParams],
    params: FusionParams,
    strokes: list[Stroke] | None = None,
) -> Results:
    """完整合成: 对齐 → 清晰度 → 权重 → 自动结果 → 人工覆盖。"""
    n = len(images)
    if not (3 <= n <= 6):
        raise ValueError("需要 3 到 6 张同尺寸照片")
    h, w = images[ref].shape[:2]
    for img in images:
        if img.shape[:2] != (h, w):
            raise ValueError("所有照片尺寸必须一致")
    center = (w / 2.0, h / 2.0)

    warped, valids, scores = [], [], []
    for i, img in enumerate(images):
        p = AlignParams() if i == ref else aligns[i].clamped()
        warped.append(warp_to_reference(img, p, center, (h, w)))
        valids.append(valid_mask(img.shape[:2], p, center, (h, w)))

    common = common_valid(valids)
    crop = crop_rect(common)

    for i in range(n):
        gray = cv2.cvtColor(warped[i], cv2.COLOR_BGR2GRAY).astype(np.float32)
        scores.append(focus_score(gray, valids[i], params.window))

    ref_gray = cv2.cvtColor(warped[ref], cv2.COLOR_BGR2GRAY).astype(np.float32)
    weights, label_auto, conf = compute_weights(
        scores, valids, params.smooth, ref_gray, params.lowtex
    )

    ovr, rejected = rasterize_overrides(strokes or [], (h, w), valids)
    label_final = np.where(ovr >= 0, ovr.astype(np.uint8), label_auto)

    img_auto = _blend(warped, weights)
    wf = weights.copy()
    m = ovr >= 0
    if m.any():
        wf[:, m] = 0.0
        wf[ovr[m], m] = 1.0
    img_final = _blend(warped, wf)

    return Results(
        warped=warped,
        valids=valids,
        common=common,
        crop=crop,
        scores=scores,
        weights=weights,
        label_auto=label_auto,
        conf=conf,
        override=ovr,
        rejected=rejected,
        label_final=label_final,
        img_auto=img_auto,
        img_final=img_final,
    )
