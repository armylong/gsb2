"""核心颜色计算：采样、变换拟合、色差、色域检查、工程读写。

所有图像在内部统一为 float64、RGB、取值 [0, 1] 的 numpy 数组。
变换模型：对每个源图独立拟合一个把源颜色映射到参考图颜色的 3x3 仿射变换
    y = M @ x + t
支持两种模型：
  - affine   : 完整 3x3 矩阵 + 偏移（12 个参数，至少 4 个非退化采样）
  - diagonal : 每通道独立增益 + 偏移（6 个参数，至少 2 个采样）
白点锁定：把标记为白点的采样对 (xs, ys) 作为硬约束，令 M @ xs + t = ys。
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class Rect:
    """图像像素坐标系下的矩形（左上角 + 宽高），w/h 为正整数。"""

    x: int
    y: int
    w: int
    h: int

    def clamped(self, width: int, height: int) -> "Rect":
        x0 = max(0, min(self.x, width - 1))
        y0 = max(0, min(self.y, height - 1))
        x1 = max(0, min(self.x + self.w, width))
        y1 = max(0, min(self.y + self.h, height))
        return Rect(x0, y0, max(0, x1 - x0), max(0, y1 - y0))

    @property
    def area(self) -> int:
        return max(0, self.w) * max(0, self.h)


@dataclass
class ImageEntry:
    id: str
    path: str                # 绝对路径，或相对于工程文件的路径
    role: str                # "reference" 或 "source"
    sha256: str
    width: int
    height: int
    generated: bool = False


@dataclass
class Sample:
    """一组对应的公共色块：rects 按 image_id 记录每张图上的框选位置。"""

    id: str
    name: str
    rects: dict[str, Rect] = field(default_factory=dict)
    is_white: bool = False


@dataclass
class PatchStat:
    mean: np.ndarray         # (3,) 平均 RGB
    std: np.ndarray          # (3,) 每通道标准差
    n_pixels: int


@dataclass
class FitParams:
    source_id: str
    method: str                       # affine / diagonal
    M: list[list[float]]              # 3x3
    t: list[float]                    # 长度 3
    white_locked: bool
    white_sample_id: Optional[str]
    n_samples: int
    rank: int
    condition_number: float
    residual_rms: float               # 拟合残差 RMS（RGB 0..255 量纲）
    warnings: list[str] = field(default_factory=list)


@dataclass
class FitResult:
    params: FitParams
    errors: list["PatchError"]


@dataclass
class PatchError:
    sample_id: str
    sample_name: str
    delta_e_before: float
    delta_e_after: float
    src_mean: list[float]
    ref_mean: list[float]
    matched_mean: list[float]


class FitError(Exception):
    """输入不足或采样退化导致无法拟合。"""


# ---------------------------------------------------------------------------
# 图像 IO
# ---------------------------------------------------------------------------


def load_image_rgb(path: str) -> np.ndarray:
    """读图并转成 float64 RGB 数组（H, W, 3），值域 [0, 1]。"""
    with Image.open(path) as im:
        im = im.convert("RGB")
        arr = np.asarray(im, dtype=np.float64) / 255.0
    return arr


def save_image_rgb(path: str, img_f: np.ndarray) -> None:
    """把 float 图像裁剪到 [0,1] 后按扩展名保存（PNG/TIFF/JPG 由 PIL 决定）。"""
    arr = np.rint(np.clip(img_f, 0.0, 1.0) * 255.0).astype(np.uint8)
    Image.fromarray(arr, mode="RGB").save(path)


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# 采样统计
# ---------------------------------------------------------------------------


def patch_stat(img: np.ndarray, rect: Rect) -> PatchStat:
    r = rect.clamped(img.shape[1], img.shape[0])
    if r.area == 0:
        raise ValueError(f"采样矩形无效或落在图像外: {rect}")
    region = img[r.y : r.y + r.h, r.x : r.x + r.w, :].reshape(-1, 3)
    return PatchStat(
        mean=region.mean(axis=0),
        std=region.std(axis=0),
        n_pixels=region.shape[0],
    )


def collect_means(
    images: dict[str, np.ndarray],
    samples: list[Sample],
    ref_id: str,
    source_id: str,
) -> tuple[np.ndarray, np.ndarray, list[Sample], list[PatchStat], list[PatchStat], list[str]]:
    """收集某个源图与参考图之间成对的色块均值。

    返回 X(源, n×3)、Y(参考, n×3)、用到的采样、两侧 PatchStat、警告信息。
    """
    X, Y, used, src_stats, ref_stats, warnings = [], [], [], [], [], []
    for s in samples:
        if ref_id not in s.rects or source_id not in s.rects:
            continue
        ps_src = patch_stat(images[source_id], s.rects[source_id])
        ps_ref = patch_stat(images[ref_id], s.rects[ref_id])
        if ps_src.std.max() > 0.12 or ps_ref.std.max() > 0.12:
            warnings.append(
                f"采样「{s.name}」框内不均匀 (std={255 * max(ps_src.std.max(), ps_ref.std.max()):.1f}/255)，"
                "框可能压到了色块边缘，建议收紧矩形"
            )
        X.append(ps_src.mean)
        Y.append(ps_ref.mean)
        used.append(s)
        src_stats.append(ps_src)
        ref_stats.append(ps_ref)
    if not X:
        raise FitError("没有同时落在参考图和该源图上的采样对，至少需要 1 组公共色块")
    return np.asarray(X), np.asarray(Y), used, src_stats, ref_stats, warnings


# ---------------------------------------------------------------------------
# 变换拟合
# ---------------------------------------------------------------------------

_MIN_SAMPLES = {"affine": 4, "diagonal": 2}


def _rank_and_cond(A: np.ndarray) -> tuple[int, float, float]:
    """返回设计矩阵的秩、条件数、最小奇异值。"""
    sv = np.linalg.svd(A, compute_uv=False)
    tol = A.shape[0] * sv[0] * np.finfo(float).eps
    rank = int((sv > tol).sum())
    cond = float(sv[0] / sv[-1]) if sv[-1] > 0 else float("inf")
    return rank, cond, float(sv[-1])


def fit_transform(
    X: np.ndarray,
    Y: np.ndarray,
    method: str,
    lock_white: bool,
    white_sample_id: Optional[str],
    used_samples: list[Sample],
) -> FitParams:
    """按选定模型拟合 X -> Y，必要时施加白点硬约束。"""
    n = len(X)
    if method not in _MIN_SAMPLES:
        raise FitError(f"未知模型: {method}")
    need = _MIN_SAMPLES[method]
    warnings: list[str] = []
    if n < need:
        raise FitError(
            f"{method} 模型至少需要 {need} 组采样，当前只有 {n} 组；"
            f"请补采样点，或改用 {'diagonal（至少 2 组）' if method == 'affine' else '更多色块'}"
        )

    w_idx = None
    if lock_white:
        if white_sample_id is None:
            raise FitError("已开启白点锁定，但没有标记任何白点采样")
        for i, s in enumerate(used_samples):
            if s.id == white_sample_id:
                w_idx = i
                break
        if w_idx is None:
            raise FitError("白点采样在该源图上缺少对应矩形，无法锁定")

    if method == "affine":
        M, t, rank, required_rank, cond, rms = _fit_affine(X, Y, w_idx)
        if rank < required_rank:
            raise FitError(
                f"采样退化：仿射设计矩阵秩为 {rank}（满秩需 {required_rank}），"
                "色块颜色可能过于集中（例如全是灰阶）。请增加色相更分散的色块，或改用 diagonal 模型"
            )
    else:
        M, t, rank, cond, rms = _fit_diagonal(X, Y, w_idx)
        if rank < 2:
            raise FitError(
                "采样退化：某通道上的采样值几乎不变（逐通道设计矩阵秩不足 2），"
                "请增加明暗不同的色块"
            )

    if not np.isfinite(cond):
        raise FitError("设计矩阵奇异，无法稳定求解，请增加分布更分散的色块")
    if cond > 1e6:
        warnings.append(f"设计矩阵条件数较大 ({cond:.2e})，结果对采样噪声敏感，建议增加色块分散度")

    # 白点约束校验
    if lock_white:
        err = np.linalg.norm(M @ X[w_idx] + t - Y[w_idx])
        if err > 1e-9:
            warnings.append("白点约束未精确满足，结果可能不可靠")

    return FitParams(
        source_id="",
        method=method,
        M=M.tolist(),
        t=t.tolist(),
        white_locked=lock_white,
        white_sample_id=white_sample_id if lock_white else None,
        n_samples=n,
        rank=rank,
        condition_number=cond,
        residual_rms=float(rms * 255.0),
        warnings=warnings,
    )


def _fit_affine(X, Y, w_idx: Optional[int]):
    """返回 M, t, rank, required_rank, cond, rms。

    无白点锁定时设计矩阵为 [X, 1]，满秩 4；
    锁定后偏移被约束消去，设计矩阵为中心化的 X，满秩 3。
    """
    if w_idx is None:
        A = np.hstack([X, np.ones((len(X), 1))])
        required_rank = 4
        rank, cond, _ = _rank_and_cond(A)
        P, *_ = np.linalg.lstsq(A, Y, rcond=None)
        M = P[:3, :].T
        t = P[3, :]
    else:
        xs, ys = X[w_idx], Y[w_idx]
        Xc, Yc = X - xs, Y - ys
        required_rank = 3
        rank, cond, _ = _rank_and_cond(Xc)
        Pc, *_ = np.linalg.lstsq(Xc, Yc, rcond=None)
        M = Pc.T
        t = ys - M @ xs
    pred = X @ M.T + t
    rms = float(np.sqrt(np.mean((pred - Y) ** 2)))
    return M, t, rank, required_rank, cond, rms


def _fit_diagonal(X, Y, w_idx: Optional[int]):
    """逐通道线性拟合 y_c = g_c * x_c + b_c，取三通道中最差的秩与条件数。"""
    n = len(X)
    rank_worst, cond_worst = 2, 0.0
    gains = np.zeros(3)
    bias = np.zeros(3)
    for c in range(3):
        Ac = np.column_stack([X[:, c], np.ones(n)])
        r, cond, _ = _rank_and_cond(Ac)
        rank_worst = min(rank_worst, r)
        cond_worst = max(cond_worst, cond)
        p, *_ = np.linalg.lstsq(Ac, Y[:, c], rcond=None)
        gains[c], bias[c] = p
    if w_idx is not None:
        # 保持增益，调整每通道偏移使白点精确落在参考白点上
        bias = Y[w_idx] - gains * X[w_idx]
    M = np.diag(gains)
    t = bias
    pred = X @ M.T + t
    rms = float(np.sqrt(np.mean((pred - Y) ** 2)))
    return M, t, rank_worst, cond_worst, rms


def apply_transform(img_f: np.ndarray, params: FitParams) -> np.ndarray:
    M = np.asarray(params.M)
    t = np.asarray(params.t)
    return img_f @ M.T + t


# ---------------------------------------------------------------------------
# 色差（sRGB -> Lab -> CIEDE2000）
# ---------------------------------------------------------------------------

_SRGB2XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)
_D65 = np.array([0.95047, 1.0, 1.08883])


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    rgb = np.asarray(rgb, dtype=np.float64)
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    xyz = lin @ _SRGB2XYZ.T / _D65
    eps = 216 / 24389.0
    kappa = 24389 / 27.0
    f = np.where(xyz > eps, np.cbrt(xyz), (kappa * xyz + 16.0) / 116.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def delta_e00(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    """CIEDE2000 色差，支持批量 (..., 3) 输入。kL=kC=kH=1。"""
    lab1, lab2 = np.broadcast_arrays(np.asarray(lab1, float), np.asarray(lab2, float))
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]

    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cbar = (C1 + C2) / 2.0
    G = 0.5 * (1.0 - np.sqrt(Cbar**7 / (Cbar**7 + 25.0**7)))
    ap1, ap2 = (1.0 + G) * a1, (1.0 + G) * a2
    Cp1 = np.hypot(ap1, b1)
    Cp2 = np.hypot(ap2, b2)
    Cpbar = (Cp1 + Cp2) / 2.0

    hp1 = np.degrees(np.arctan2(b1, ap1)) % 360.0
    hp2 = np.degrees(np.arctan2(b2, ap2)) % 360.0
    hp1 = np.where(Cp1 == 0, 0.0, hp1)
    hp2 = np.where(Cp2 == 0, 0.0, hp2)

    dL = L2 - L1
    dC = Cp2 - Cp1
    dh = hp2 - hp1
    dh = np.where(dh > 180.0, dh - 360.0, dh)
    dh = np.where(dh < -180.0, dh + 360.0, dh)
    dh = np.where((Cp1 * Cp2) == 0, 0.0, dh)
    dH = 2.0 * np.sqrt(Cp1 * Cp2) * np.sin(np.radians(dh / 2.0))

    Lbar = (L1 + L2) / 2.0
    hsum = hp1 + hp2
    hbar = np.where(
        (Cp1 * Cp2) == 0,
        hsum,
        np.where(np.abs(hp1 - hp2) > 180.0, np.where(hsum < 360.0, hsum + 360.0, hsum - 360.0), hsum) / 2.0,
    )
    T = (
        1.0
        - 0.17 * np.cos(np.radians(hbar - 30.0))
        + 0.24 * np.cos(np.radians(2.0 * hbar))
        + 0.32 * np.cos(np.radians(3.0 * hbar + 6.0))
        - 0.20 * np.cos(np.radians(4.0 * hbar - 63.0))
    )
    dtheta = 30.0 * np.exp(-(((hbar - 275.0) / 25.0) ** 2))
    RC = 2.0 * np.sqrt(Cpbar**7 / (Cpbar**7 + 25.0**7))
    SL = 1.0 + (0.015 * (Lbar - 50.0) ** 2) / np.sqrt(20.0 + (Lbar - 50.0) ** 2)
    SC = 1.0 + 0.045 * Cpbar
    SH = 1.0 + 0.015 * Cpbar * T
    RT = -np.sin(np.radians(2.0 * dtheta)) * RC
    term = (dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH)
    return np.sqrt(np.maximum(term, 0.0))


def compute_errors(
    X: np.ndarray,
    Y: np.ndarray,
    used_samples: list[Sample],
    params: FitParams,
) -> list[PatchError]:
    M = np.asarray(params.M)
    t = np.asarray(params.t)
    matched = X @ M.T + t
    de_before = delta_e00(rgb_to_lab(X), rgb_to_lab(Y))
    de_after = delta_e00(rgb_to_lab(matched), rgb_to_lab(Y))
    out = []
    for i, s in enumerate(used_samples):
        out.append(
            PatchError(
                sample_id=s.id,
                sample_name=s.name,
                delta_e_before=float(de_before[i]),
                delta_e_after=float(de_after[i]),
                src_mean=X[i].tolist(),
                ref_mean=Y[i].tolist(),
                matched_mean=matched[i].tolist(),
            )
        )
    return out


# ---------------------------------------------------------------------------
# 色域检查
# ---------------------------------------------------------------------------


def gamut_mask(transformed_f: np.ndarray) -> np.ndarray:
    """变换后、裁剪前，超出 [0,1] 的像素掩码（H, W）。"""
    return np.any((transformed_f < 0.0) | (transformed_f > 1.0), axis=-1)


def gamut_stats(
    transformed_f: np.ndarray,
    valid_mask: np.ndarray | None = None,
) -> dict:
    """变换后、裁剪前的越界统计。

    valid_mask 给定时（H, W 布尔，True=参与统计的有效像素），
    同时给出“全图”和“有效像素”两套口径，避免黑边/背景污染比例。
    """
    total = transformed_f.shape[0] * transformed_f.shape[1]
    mask = gamut_mask(transformed_f)
    if valid_mask is None:
        valid_mask = np.ones(transformed_f.shape[:2], dtype=bool)

    def _part(sel: np.ndarray) -> dict:
        n = int(np.count_nonzero(sel))
        per_channel = []
        for c in range(3):
            ch = transformed_f[..., c]
            per_channel.append(
                {
                    "under": float(np.count_nonzero((ch < 0.0) & sel) / n) if n else 0.0,
                    "over": float(np.count_nonzero((ch > 1.0) & sel) / n) if n else 0.0,
                }
            )
        return {
            "n_pixels": n,
            "n_out": int(np.count_nonzero(mask & sel)),
            "out_of_gamut_fraction": float(np.count_nonzero(mask & sel) / n) if n else 0.0,
            "per_channel": per_channel,
        }

    return {
        "n_pixels": int(total),
        "n_out": int(np.count_nonzero(mask)),
        "out_of_gamut_fraction": float(np.count_nonzero(mask) / total),
        "per_channel": _part(np.ones_like(valid_mask))["per_channel"],
        "foreground": _part(valid_mask),
    }


# ---------------------------------------------------------------------------
# 工程文件
# ---------------------------------------------------------------------------

PROJECT_VERSION = 1


class Project:
    def __init__(
        self,
        images: list[ImageEntry],
        samples: list[Sample],
        fits: dict[str, FitParams],
        settings: Optional[dict] = None,
    ):
        self.images = images
        self.samples = samples
        self.fits = fits
        self.settings = settings or {"method": "affine", "lock_white": True, "white_sample_id": None}

    @property
    def reference(self) -> Optional[ImageEntry]:
        return next((im for im in self.images if im.role == "reference"), None)

    @property
    def sources(self) -> list[ImageEntry]:
        return [im for im in self.images if im.role == "source"]

    def image_path(self, entry: ImageEntry, project_dir: str) -> str:
        return entry.path if os.path.isabs(entry.path) else os.path.normpath(
            os.path.join(project_dir, entry.path)
        )

    def to_dict(self) -> dict:
        return {
            "version": PROJECT_VERSION,
            "settings": self.settings,
            "images": [asdict(im) for im in self.images],
            "samples": [
                {
                    "id": s.id,
                    "name": s.name,
                    "is_white": s.is_white,
                    "rects": {iid: asdict(r) for iid, r in s.rects.items()},
                }
                for s in self.samples
            ],
            "fits": {sid: asdict(fp) for sid, fp in self.fits.items()},
        }

    def save(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str) -> "Project":
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        images = [ImageEntry(**im) for im in data["images"]]
        samples = [
            Sample(
                id=s["id"],
                name=s["name"],
                is_white=s.get("is_white", False),
                rects={iid: Rect(**r) for iid, r in s["rects"].items()},
            )
            for s in data["samples"]
        ]
        fits = {sid: FitParams(**fp) for sid, fp in data.get("fits", {}).items()}
        return cls(images, samples, fits, data.get("settings"))
