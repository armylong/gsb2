"""画布构建、曝光补偿、羽化融合、鬼影提示与有效区域导出。

注意：黑色实景（像素本身就是 (0,0,0)）通过 warp 后的 *几何 mask* 判定，
绝不按像素亮度判定有效性，因此黑色内容不会被当作空洞删除。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from . import geometry as geo
from .config import Config


@dataclass
class CanvasResult:
    ok: bool
    reasons: list[str]
    canvas: np.ndarray | None = None          # BGRA 融合结果
    overlay: np.ndarray | None = None         # 未融合叠加（最后绘制者覆盖）
    valid_mask: np.ndarray | None = None      # uint8 0/255
    bounds: tuple[int, int, int, int] = (0, 0, 0, 0)  # x0,y0,x1,y1
    ghost_frac: float = 0.0
    ghost_map: np.ndarray | None = None
    gains: list[float] = field(default_factory=list)


class CanvasTooLargeError(Exception):
    pass


def compute_bounds(
    globals_H: dict[int, np.ndarray],
    sizes: dict[int, tuple[int, int]],
    cfg: Config,
) -> tuple[int, int, int, int]:
    xs, ys = [], []
    for idx, H in globals_H.items():
        w, h = sizes[idx]
        c = geo.warp_corners(H, w, h)
        xs.extend(c[:, 0].tolist())
        ys.extend(c[:, 1].tolist())
    x0, x1 = int(np.floor(min(xs))), int(np.ceil(max(xs)))
    y0, y1 = int(np.floor(min(ys))), int(np.ceil(max(ys)))
    width, height = x1 - x0, y1 - y0
    if (
        width > cfg.max_canvas_side
        or height > cfg.max_canvas_side
        or width * height > cfg.max_canvas_pixels
        or width <= 0 or height <= 0
    ):
        raise CanvasTooLargeError(
            f"画布尺寸 {width}x{height} 超过安全上限 "
            f"({cfg.max_canvas_side}px / {cfg.max_canvas_pixels/1e6:.0f}MP)"
        )
    return x0, y0, x1, y1


def _translation(x0: int, y0: int) -> np.ndarray:
    return np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], float)


def _warp_image_and_mask(img, H, Hgt, canvas_w, canvas_h):
    M = Hgt @ H
    warped = cv2.warpPerspective(
        img, M, (canvas_w, canvas_h),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    mask = cv2.warpPerspective(
        np.ones((img.shape[0], img.shape[1]), np.uint8), M,
        (canvas_w, canvas_h),
        flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    return warped, mask


def _gain_compensation(
    images_warped: list[np.ndarray], masks: list[np.ndarray]
) -> list[float]:
    """重叠区最小二乘增益，缓解相邻照片亮度差。"""
    n = len(images_warped)
    A = np.zeros((n, n))
    b = np.zeros(n)
    gray = [
        cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float64)
        for im in images_warped
    ]
    for a in range(n):
        for c in range(a + 1, n):
            ov = masks[a].astype(bool) & masks[c].astype(bool)
            if ov.sum() < 100:
                continue
            va, vc = gray[a][ov], gray[c][ov]
            ia, ic = float((va * vc).sum()), float((vc * vc).sum())
            # va ≈ g_a/g_c * vc  ->  线性化到对数域更稳，这里用均值比正则
            ma, mc = float(va.mean()), float(vc.mean())
            wgt = ov.sum()
            A[a, a] += wgt
            A[c, c] += wgt
            A[a, c] -= wgt
            A[c, a] -= wgt
            b[a] += wgt * (ma - mc)
            b[c] += wgt * (mc - ma)
            del ia, ic
    # 固定 g_0 = 1 的约束
    A[0, :] = 0
    A[0, 0] = 1
    b[0] = 0
    try:
        g = np.linalg.solve(A + np.eye(n) * 1e-6, b)
        gains = np.exp(-g).tolist()
        # 归一化使几何均值为 1，避免整体变暗
        gains = np.array(gains)
        gains = gains / np.exp(np.mean(np.log(np.maximum(gains, 1e-3))))
        return [float(np.clip(x, 0.5, 2.0)) for x in gains]
    except np.linalg.LinAlgError:
        return [1.0] * n


def _feather_weight(mask: np.ndarray, feather_px: int) -> np.ndarray:
    if feather_px <= 1:
        return mask.astype(np.float32)
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    w = np.clip(dist / feather_px, 0.0, 1.0)
    return w.astype(np.float32)


def largest_valid_rectangle(mask: np.ndarray) -> tuple[int, int, int, int]:
    """二值 mask 内最大全有效内接矩形（柱状图最大矩形算法）。

    返回 (x, y, w, h)，保证矩形内不含任何无效像素。
    """
    m = (mask > 0).astype(np.uint8)
    h, w = m.shape
    height = np.zeros(w, dtype=np.int32)
    best = (0, 0, 0, 0)
    best_area = 0
    for row in range(h):
        height = np.where(m[row] > 0, height + 1, 0)
        stack: list[int] = []
        for col in range(w + 1):
            cur = height[col] if col < w else 0
            while stack and height[stack[-1]] > cur:
                hgt = height[stack.pop()]
                left = stack[-1] + 1 if stack else 0
                area = hgt * (col - left)
                if area > best_area:
                    best_area = area
                    best = (left, row - hgt + 1, col - left, hgt)
            stack.append(col)
    return best


def render_canvas(
    order: list[int],
    images: dict[int, np.ndarray],
    globals_H: dict[int, np.ndarray],
    cfg: Config,
) -> CanvasResult:
    sizes = {i: (im.shape[1], im.shape[0]) for i, im in images.items()}
    try:
        x0, y0, x1, y1 = compute_bounds(globals_H, sizes, cfg)
    except CanvasTooLargeError as exc:
        return CanvasResult(False, [str(exc)])
    cw, ch = x1 - x0, y1 - y0
    Hgt = _translation(x0, y0)

    warped, masks = [], []
    for idx in order:
        if idx not in globals_H:
            continue
        im = images[idx]
        h, w = im.shape[:2]
        wim, wmask = _warp_image_and_mask(
            im, globals_H[idx], Hgt, cw, ch
        )
        warped.append(wim)
        masks.append(wmask)
    if not warped:
        return CanvasResult(False, ["没有可渲染的有效照片"])

    gains = _gain_compensation(warped, masks)

    # ---- 融合（距离变换羽化 + 增益）----
    acc = np.zeros((ch, cw, 3), np.float32)
    wsum = np.zeros((ch, cw), np.float32)
    overlay = np.zeros((ch, cw, 3), np.uint8)
    valid = np.zeros((ch, cw), np.uint8)
    # 鬼影：基于补偿后边缘结构的两两重叠不一致
    ghost_hits = np.zeros((ch, cw), np.uint8)
    overlap_total = np.zeros((ch, cw), np.uint8)
    edge_prev = None
    mask_prev = None

    for k, (im, mask, g) in enumerate(zip(warped, masks, gains)):
        compensated = np.clip(im.astype(np.float32) * g, 0, 255)
        weight = _feather_weight(mask, cfg.feather_px)
        acc += compensated * weight[..., None]
        wsum += weight
        # 未融合叠加：后绘者直接覆盖
        sel = mask.astype(bool)
        overlay[sel] = np.clip(compensated[sel], 0, 255).astype(np.uint8)
        valid[sel] = 255

        gray = cv2.cvtColor(
            np.clip(compensated, 0, 255).astype(np.uint8),
            cv2.COLOR_BGR2GRAY,
        )
        # 边缘结构对整体亮度偏移不敏感，更能反映真实重影
        edge = cv2.Canny(gray, 60, 140)
        if edge_prev is not None:
            ov = sel & mask_prev.astype(bool)
            overlap_total[ov] = 1
            # 仅在边缘邻域判定：一张有边而对应位置另一张无边 => 结构错位
            edge_dil = cv2.dilate(edge, np.ones((5, 5), np.uint8))
            prev_dil = cv2.dilate(edge_prev, np.ones((5, 5), np.uint8))
            mismatch = ((edge > 0) & (prev_dil == 0)) | (
                (edge_prev > 0) & (edge_dil == 0)
            )
            ghost_hits[ov & mismatch] = 1
        edge_prev, mask_prev = edge, mask

    nonzero = wsum > 1e-6
    blended = np.zeros_like(acc)
    blended[nonzero] = acc[nonzero] / wsum[nonzero][..., None]
    blended = np.clip(blended, 0, 255).astype(np.uint8)

    bgra = cv2.cvtColor(blended, cv2.COLOR_BGR2BGRA)
    bgra[..., 3] = valid
    overlay_bgra = cv2.cvtColor(overlay, cv2.COLOR_BGR2BGRA)
    overlay_bgra[..., 3] = valid

    # ---- 鬼影提示（只统计真实重叠区）----
    overlap_pixels = int(overlap_total.sum())
    if overlap_pixels:
        ghost_pixels = int((ghost_hits & overlap_total).sum())
        ghost_frac = ghost_pixels / overlap_pixels
        ghost_map = (ghost_hits & overlap_total) * 255
    else:
        ghost_frac = 0.0
        ghost_map = np.zeros((ch, cw), np.uint8)

    return CanvasResult(
        ok=True,
        reasons=[],
        canvas=bgra,
        overlay=overlay_bgra,
        valid_mask=valid,
        bounds=(x0, y0, x1, y1),
        ghost_frac=ghost_frac,
        ghost_map=ghost_map,
        gains=gains,
    )


def export_full_canvas(result: CanvasResult, cfg: Config) -> np.ndarray:
    """完整画布导出，无效区域保持透明（alpha=0）。"""
    h, w = result.canvas.shape[:2]
    if (
        w > cfg.max_export_side or h > cfg.max_export_side
        or w * h > cfg.max_export_pixels
    ):
        raise CanvasTooLargeError(
            f"导出尺寸 {w}x{h} 超过上限 "
            f"{cfg.max_export_side}px / {cfg.max_export_pixels/1e6:.0f}MP"
        )
    return result.canvas.copy()


def export_valid_crop(
    result: CanvasResult, cfg: Config
) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """内部有效矩形裁剪，保证不含空洞；矩形过小时拒绝导出。"""
    x, y, w, h = largest_valid_rectangle(result.valid_mask)
    if w <= 0 or h <= 0:
        raise ValueError("有效区域退化，不存在可裁剪矩形")
    valid_total = int(np.count_nonzero(result.valid_mask))
    if w * h < cfg.min_valid_crop_frac * max(valid_total, 1):
        raise ValueError(
            f"有效内接矩形仅 {w}x{h}，形状过于破碎，拒绝导出不可靠裁剪"
        )
    crop = result.canvas[y:y + h, x:x + w].copy()
    # 双保险：矩形内不允许透明像素
    if int((crop[..., 3] == 0).sum()) > 0:
        raise ValueError("裁剪矩形内检测到无效空洞，导出中止")
    return crop, (x, y, w, h)
