"""单元采样、样本叠图与干净单元拼接。

所有取样都只在原图的真实像素上做双线性插值; 单元伸出图外的部分被记为缺口
(mask=0), 不会被边框像素涂抹填充。样本来自同一张图上按格点平移得到的若干
"同位置"单元, 因此样本之间的差异就是织物本身的磨损与色差, 而不是测量错误。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence, Tuple

import numpy as np

from .geometry import CellBasis


# ---------------------------------------------------------------------------
# 采样
# ---------------------------------------------------------------------------

def _sample_bilinear(img: np.ndarray, xs: np.ndarray, ys: np.ndarray
                     ) -> Tuple[np.ndarray, np.ndarray]:
    """在像素索引坐标上双线性采样。返回 (值, 有效掩码)。

    有效要求插值核完全落在图内 (索引在 [0, W-1] / [0, H-1] 内), 避免边缘涂抹。
    """
    h, w = img.shape[:2]
    valid = (xs >= 0.0) & (xs <= w - 1.0) & (ys >= 0.0) & (ys <= h - 1.0)
    xs_c = np.clip(xs, 0.0, w - 1.0)
    ys_c = np.clip(ys, 0.0, h - 1.0)
    x0 = np.floor(xs_c).astype(np.int64)
    y0 = np.floor(ys_c).astype(np.int64)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (xs_c - x0)[..., None]
    fy = (ys_c - y0)[..., None]
    v00 = img[y0, x0]
    v01 = img[y0, x1]
    v10 = img[y1, x0]
    v11 = img[y1, x1]
    top = v00 * (1 - fx) + v01 * fx
    bot = v10 * (1 - fx) + v11 * fx
    out = top * (1 - fy) + bot * fy
    return out.astype(np.float32), valid


@dataclass
class CellSample:
    rgb: np.ndarray            # (n, n, 3) float32
    valid: np.ndarray          # (n, n) bool
    cell: CellBasis
    index: Tuple[int, int] = (0, 0)

    @property
    def coverage(self) -> float:
        return float(self.valid.mean())


def sample_cell(img: np.ndarray, basis: CellBasis, n: int = 256,
                supersample: int = 1) -> CellSample:
    """把一个平行四边形单元重采样成 n x n 的规则网格。

    像素 (i, j) 的中心对应单元坐标 (u, v) = ((j+0.5)/n, (i+0.5)/n)。
    """
    n = int(max(8, n))
    s = max(1, int(supersample))
    # 超采样网格 (s x s 个子点, 逐子点独立判断有效性)
    k = n * s
    u = (np.arange(k) + 0.5) / k
    v = (np.arange(k) + 0.5) / k
    U, V = np.meshgrid(u, v)
    world = basis.to_world(np.stack([U, V], axis=-1))  # (k,k,2)
    xs = world[..., 0] - 0.5
    ys = world[..., 1] - 0.5
    vals, valid = _sample_bilinear(img, xs, ys)
    if s > 1:
        vals = vals.reshape(n, s, n, s, -1).mean(axis=(1, 3))
        # 子点全有效才算有效
        valid = valid.reshape(n, s, n, s).all(axis=(1, 3))
    return CellSample(vals.astype(np.float32), valid, basis)


def complete_cell_origins(basis: CellBasis, img_w: int, img_h: int,
                          max_cells: int = 400) -> List[CellBasis]:
    """图内所有完整单元, 按离原单元原点由近到远排序。"""
    from .geometry import fully_inside_cells
    cells = fully_inside_cells(basis, img_w, img_h)
    o = np.array(basis.origin, dtype=float)
    cells.sort(key=lambda c: float(np.hypot(*(np.array(c.origin) - o))))
    return cells[:max_cells]


def gather_samples(img: np.ndarray, basis: CellBasis, n: int = 192,
                   max_samples: int = 9, min_coverage: float = 0.995,
                   supersample: int = 1) -> List[CellSample]:
    """从图内若干完整单元取"同位置"样本。"""
    h, w = img.shape[:2]
    out: List[CellSample] = []
    for i, cell in enumerate(complete_cell_origins(basis, w, h)):
        if len(out) >= max_samples:
            break
        s = sample_cell(img, cell, n=n, supersample=supersample)
        if s.coverage >= min_coverage:
            out.append(s)
    return out


# ---------------------------------------------------------------------------
# 样本统计 / 叠图
# ---------------------------------------------------------------------------

def stack_arrays(samples: Sequence[CellSample]
                 ) -> Tuple[np.ndarray, np.ndarray]:
    S = np.stack([s.rgb for s in samples], axis=0)
    M = np.stack([s.valid for s in samples], axis=0)
    return S, M


def sample_stats(samples: Sequence[CellSample]) -> dict:
    """样本之间的差异统计 (磨损 / 色差), 并明确这不是周期误差。"""
    S, M = stack_arrays(samples)
    if S.shape[0] == 0:
        return {"count": 0}
    cnt = np.maximum(M.sum(axis=0), 1)
    mean = (S * M[..., None]).sum(axis=0) / cnt[..., None]
    # 逐样本平均色偏 (相对所有样本均值)
    color_offsets = []
    for k in range(S.shape[0]):
        m = M[k]
        if not m.any():
            color_offsets.append([0.0, 0.0, 0.0])
            continue
        diff = (S[k][m] - mean[m]).mean(axis=0)
        color_offsets.append([float(x) for x in diff])
    # 逐像素离散度 (仅统计至少两个样本的像素)
    two = M.sum(axis=0) >= 2
    dev = np.zeros(S.shape[1:3], dtype=np.float64)
    if two.any():
        med = np.median(np.where(M[..., None], S, np.nan), axis=0)
        d = np.abs(S - med[None]).mean(axis=-1) * M
        dev[two] = (d.sum(axis=0) / cnt)[two]
    # 任意两个样本之间的 RMS 差 (平均)
    rms_pairs = []
    for a in range(S.shape[0]):
        for b in range(a + 1, S.shape[0]):
            m = M[a] & M[b]
            if m.sum() < 16:
                continue
            rms_pairs.append(float(np.sqrt(((S[a][m] - S[b][m]) ** 2).mean())))
    return {
        "count": int(S.shape[0]),
        "color_offsets": color_offsets,      # 每个样本相对均值的平均色偏
        "pixel_spread": dev,                 # (n,n) 逐像素离散度 (0..1)
        "mean_pair_rms": float(np.mean(rms_pairs)) if rms_pairs else 0.0,
        "max_pair_rms": float(np.max(rms_pairs)) if rms_pairs else 0.0,
        "coverage": [float(m.mean()) for m in M],
    }


@dataclass
class CleanUnit:
    rgb: np.ndarray              # (n, n, 3)
    mask: np.ndarray             # (n, n) 有效
    filled: np.ndarray           # (n, n) 由邻近像素补出的缺口
    method: str
    n_samples: int
    removed: int = 0             # 被剔除的样本层数


def _nanmedian_stack(S: np.ndarray, M: np.ndarray) -> np.ndarray:
    arr = np.where(M[..., None], S, np.nan)
    with np.errstate(invalid="ignore"):
        out = np.nanmedian(arr, axis=0)
    return out


def _robust_mean_stack(S: np.ndarray, M: np.ndarray, k: float = 2.5,
                       ) -> Tuple[np.ndarray, np.ndarray]:
    """逐像素剔除偏离中位数过大的样本层, 再平均。返回 (图, 每像素使用层数)。"""
    arr = np.where(M[..., None], S, np.nan)
    med = np.nanmedian(arr, axis=0, keepdims=True)
    mad = np.nanmedian(np.abs(arr - med), axis=0, keepdims=True)
    keep = np.abs(arr - med) <= (k * np.maximum(mad, 1e-4) + 0.01)
    arr2 = np.where(keep, arr, np.nan)
    cnt = np.sum(np.isfinite(arr2[..., 0]), axis=0)
    with np.errstate(invalid="ignore"):
        out = np.nanmean(arr2, axis=0)
    return out, cnt


def _fill_gaps(rgb: np.ndarray, mask: np.ndarray, iterations: int = 64
               ) -> Tuple[np.ndarray, np.ndarray]:
    """用邻近有效像素反复扩散填补完全无样本的像素。返回 (图, 被填补掩码)。"""
    out = rgb.copy()
    known = mask.copy()
    filled = np.zeros_like(mask)
    if known.all():
        return out, filled
    h, w = mask.shape
    for _ in range(iterations):
        if known.all():
            break
        acc = np.zeros_like(out)
        cnt = np.zeros((h, w), dtype=np.float64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                ys0, ys1 = max(0, dy), min(h, h + dy)
                xs0, xs1 = max(0, dx), min(w, w + dx)
                ys_dst = slice(ys0, ys1)
                xs_dst = slice(xs0, xs1)
                ys_src = slice(ys0 - dy, ys1 - dy)
                xs_src = slice(xs0 - dx, xs1 - dx)
                k = known[ys_src, xs_src]
                acc[ys_dst, xs_dst] += out[ys_src, xs_src] * k[..., None]
                cnt[ys_dst, xs_dst] += k
        newly = (~known) & (cnt > 0)
        if not newly.any():
            break
        out[newly] = acc[newly] / cnt[newly][..., None]
        filled |= newly
        known |= newly
    return out, filled


def clean_unit(samples: Sequence[CellSample], method: str = "median",
               robust_k: float = 2.5) -> CleanUnit:
    """把若干同位置样本拼成一块干净单元。

    method:
      * ``median``  – 逐像素中位数 (对污渍/缺损最稳)
      * ``robust``  – 剔除离群层后平均, 保留更多细节
      * ``mean``    – 直接平均 (保留磨损纹理, 最"诚实")
    """
    if not samples:
        raise ValueError("没有可用样本")
    S, M = stack_arrays(samples)
    if method == "median":
        rgb = _nanmedian_stack(S, M)
    elif method == "robust":
        rgb, _ = _robust_mean_stack(S, M, k=robust_k)
    elif method == "mean":
        cnt = np.maximum(M.sum(axis=0), 1)[..., None]
        rgb = (S * M[..., None]).sum(axis=0) / cnt
    else:
        raise ValueError(f"未知的拼接方式: {method}")
    mask = np.isfinite(rgb[..., 0])
    rgb = np.where(mask[..., None], rgb, 0.0)
    rgb = np.clip(np.nan_to_num(rgb, nan=0.0), 0.0, 1.0)
    rgb, filled = _fill_gaps(rgb.astype(np.float32), mask)
    return CleanUnit(rgb.astype(np.float32), mask, filled, method,
                     n_samples=len(samples))


# ---------------------------------------------------------------------------
# 叠图渲染
# ---------------------------------------------------------------------------

def overlay_samples(samples: Sequence[CellSample], mode: str = "difference",
                    gain: float = 6.0) -> np.ndarray:
    """把多个样本叠成一张可视化图, 用来观察磨损与色差。

    mode:
      * ``difference`` – 灰度均值 + 红/蓝表示各样本相对中位数的正/负偏差
      * ``mean``        – 普通平均叠加
      * ``checker``     – 样本按棋盘排布成一张拼图 (每个样本一格)
    """
    if not samples:
        raise ValueError("没有可用样本")
    S, M = stack_arrays(samples)
    if mode == "checker":
        n = S.shape[1]
        k = len(samples)
        cols = int(np.ceil(np.sqrt(k)))
        rows = int(np.ceil(k / cols))
        step = max(1, n // 2)
        canvas = np.zeros((rows * step, cols * step, 3), dtype=np.float32)
        for idx, s in enumerate(samples):
            r, c = divmod(idx, cols)
            small = s.rgb[::max(1, n // step), ::max(1, n // step)][:step, :step]
            v = s.valid[::max(1, n // step), ::max(1, n // step)][:step, :step]
            block = canvas[r * step:(r + 1) * step, c * step:(c + 1) * step]
            hh = min(block.shape[0], small.shape[0])
            ww = min(block.shape[1], small.shape[1])
            # 无效区域用醒目的洋红标出, 但不参与内容
            blk = small[:hh, :ww]
            vv = v[:hh, :ww]
            blk = np.where(vv[..., None], blk, np.array([1.0, 0.2, 1.0]))
            block[:hh, :ww] = blk
        return canvas

    cnt = np.maximum(M.sum(axis=0), 1)[..., None]
    mean = (S * M[..., None]).sum(axis=0) / cnt
    if mode == "mean":
        return np.clip(mean, 0, 1).astype(np.float32)
    if mode != "difference":
        raise ValueError(f"未知的叠图方式: {mode}")
    med = _nanmedian_stack(S, M)
    dev = np.where(M[..., None], S - med[None], 0.0).mean(axis=0)
    gray = mean.mean(axis=-1, keepdims=True)
    base = np.repeat(gray, 3, axis=-1) * 0.65
    pos = np.clip(dev, 0, None).mean(axis=-1, keepdims=True) * gain
    neg = np.clip(-dev, 0, None).mean(axis=-1, keepdims=True) * gain
    out = base.copy()
    out[..., 0] += pos[..., 0]
    out[..., 2] += neg[..., 0]
    out = np.clip(out, 0, 1)
    return out.astype(np.float32)
