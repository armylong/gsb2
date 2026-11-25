"""Light-rig bookkeeping and a "can this rig tell orientations apart?" verdict.

For Lambertian photometric stereo with known lights the shading equations are
``I = rho * max(0, n . l)``.  Writing ``g = rho n`` this is linear in ``g``, so
a per-pixel least-squares fit is possible whenever the light directions span
three dimensions.  The *quality* of that fit is governed by the eigenvalues of

    A = sum_i l_i l_i^T   (over the lights actually used at that pixel)

which is exactly the normal matrix of the fit.  If the smallest eigenvalue is
near zero, motion of the surface along that eigenvector barely changes any
reading: the rig cannot distinguish those orientations.  We expose both a
rig-wide verdict and a per-light contribution so the interface can say which
directions add information and which are redundant.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import vecmath

# Any smallest-eigenvalue below this is treated as "cannot separate normals".
MIN_EIG_WELL_POSED = 0.12
# Lights closer than this in angle are effectively duplicates.
MIN_PAIRWISE_ANGLE_DEG = 12.0
# The widest azimuth gap a good rig may leave.  An empty 180-degree arc means a
# whole side of the object never receives light, which is the case we warn about.
MAX_AZIMUTH_GAP_DEG = 179.0


@dataclass
class LightSpec:
    azimuth_deg: float
    elevation_deg: float
    enabled: bool = True
    name: str = ""

    @property
    def direction(self) -> np.ndarray:
        return vecmath.light_from_az_el(self.azimuth_deg, self.elevation_deg)

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "azimuth_deg": round(float(self.azimuth_deg), 4),
            "elevation_deg": round(float(self.elevation_deg), 4),
        }


@dataclass
class RigQuality:
    rank: int
    smallest_eigenvalue: float
    condition: float
    well_posed: bool
    max_gap_deg: float
    covers_hemisphere: bool
    per_light_notes: list[str]
    per_light_ok: list[bool]
    headline: str
    detail: str


def light_matrix(specs: list[LightSpec]) -> np.ndarray:
    return np.stack([s.direction for s in specs], axis=0) if specs else np.zeros((0, 3))


def conditioning(directions: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Eigenvalues of sum l l^T, smallest eigenvalue, and condition number."""
    d = np.asarray(directions, dtype=np.float64)
    if len(d) == 0:
        return np.zeros(3), 0.0, float("inf")
    a = np.einsum("ij,ik->jk", d, d)
    ev = np.linalg.eigvalsh(a)
    smallest = float(ev[0])
    largest = float(ev[-1])
    cond = float(largest / smallest) if smallest > 1e-9 else float("inf")
    return ev, smallest, cond


def coverage_gap(directions: np.ndarray) -> float:
    """Largest angular gap in the set of light azimuths (degrees).

    Lights that are almost identical in azimuth arc are useless for telling
    left- from right-facing surfaces, so we report the widest empty arc.
    """
    d = np.asarray(directions, dtype=np.float64)
    if len(d) < 2:
        return 360.0
    az = np.sort(np.rad2deg(np.arctan2(d[:, 1], d[:, 0])) % 360.0)
    if len(az) == 1:
        return 360.0
    gaps = np.diff(np.concatenate([az, az[:1] + 360.0]))
    return float(np.max(gaps))


def assess(specs: list[LightSpec], directions: np.ndarray | None = None) -> RigQuality:
    active = [s for s in specs if s.enabled]
    dirs = light_matrix(active) if directions is None else np.asarray(directions, dtype=np.float64)
    n = len(dirs)
    if n == 0:
        return RigQuality(0, 0.0, float("inf"), False, 360.0, False,
                          [], [], "没有可用的光照方向", "至少需要 3 个互不平行的方向。")

    ev, smallest, cond = conditioning(dirs)
    rank = int(np.sum(ev > 1e-6))
    well_posed = rank >= 3 and smallest >= MIN_EIG_WELL_POSED

    # Pairwise angles between active lights.
    dots = np.clip(dirs @ dirs.T, -1.0, 1.0)
    np.fill_diagonal(dots, -1.0)
    nearest = np.rad2deg(np.arccos(np.clip(dots.max(axis=1), -1.0, 1.0))) if n > 1 else np.full(n, 180.0)
    gap = coverage_gap(dirs)
    covers = gap <= MAX_AZIMUTH_GAP_DEG

    per_light_notes: list[str] = []
    oks: list[bool] = []
    for i, spec in enumerate(active):
        label = spec.name or f"图 {i + 1}"
        if nearest[i] < MIN_PAIRWISE_ANGLE_DEG:
            per_light_notes.append(f"{label}: 与相邻方向仅差 {nearest[i]:.0f}°，几乎重复，无法新增信息")
            oks.append(False)
            continue
        without = np.delete(dirs, i, axis=0)
        if len(without) < 3:
            per_light_notes.append(f"{label}: 去掉后不足三向，是必需方向")
            oks.append(True)
            continue
        _, small_without, _ = conditioning(without)
        gain = smallest - small_without
        if gain < 0.02 and smallest > MIN_EIG_WELL_POSED:
            per_light_notes.append(f"{label}: 其余方向已能定朝向，此灯冗余（有效增益 {gain:+.3f}）")
            oks.append(True)
        else:
            per_light_notes.append(f"{label}: 关键方向（贡献 {gain:+.3f}，张角 {nearest[i]:.0f}°）")
            oks.append(True)

    if not well_posed:
        headline = "方向不足以区分朝向"
        if rank < 3:
            detail = (f"这组方向只张成 {rank} 维空间（最小特征值 {smallest:.3f}）。"
                      "所有方向几乎共面或共线，某些朝向会得到完全相同的明暗。")
        else:
            detail = (f"最小特征值仅 {smallest:.3f}（阈值 {MIN_EIG_WELL_POSED:.2f}）。"
                      "在这组照明下，接近该特征向量的朝向几乎不改变读数，"
                      "请加入一个明显偏离现有平面的方向（例如抬高或降低一盏灯）。")
    elif not covers:
        headline = "可用，但覆盖不足"
        detail = (f"方位角上留有 {gap:.0f}° 的空档，那个方向的表面几乎不受任何灯照到。"
                  "补一盏位于空档处的灯可显著改善该侧法线。")
    else:
        headline = "方向可以区分朝向"
        detail = (f"三方向张成完整空间，最小特征值 {smallest:.2f}，条件数 {cond:.1f}；"
                  f"方位最大空档 {gap:.0f}°。")

    return RigQuality(rank, smallest, cond, well_posed, gap, covers,
                          per_light_notes, oks, headline, detail)


def per_pixel_min_eigenvalue(directions: np.ndarray, usable: np.ndarray) -> np.ndarray:
    """Smallest eigenvalue of the per-pixel normal matrix.

    ``usable`` has shape (n_lights, H, W) and marks readings that may enter
    the fit.  Returns (H, W).
    """
    d = np.asarray(directions, dtype=np.float64)
    outer = np.einsum("ij,ik->ijk", d, d)
    a = np.einsum("ihw,ijk->hwjk", usable.astype(np.float64), outer)
    return np.linalg.eigvalsh(a)[..., 0]
