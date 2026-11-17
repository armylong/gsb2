"""特征提取、匹配与带拒绝逻辑的单应估计。

核心原则：匹配数量多不代表关系可信。接受一对照片必须同时通过
内点数量、内点比例、重投影 RMSE、空间覆盖度、重叠比例、尺度合理性
六类检查，任一不过即拒绝并给出原因。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from . import geometry as geo
from .config import Config


@dataclass
class PairMatch:
    i: int
    j: int
    accepted: bool
    reasons: list[str] = field(default_factory=list)
    n_raw: int = 0                 # 比率测试后的候选匹配数
    n_inliers: int = 0             # RANSAC 内点数
    inlier_ratio: float = 0.0
    rmse: float = float("inf")     # 内点最终重投影 RMSE（像素）
    coverage_cells: int = 0        # 内点覆盖网格数
    overlap_frac: float = 0.0
    confidence: float = 0.0        # 0~1 综合可信度
    H_ji: np.ndarray | None = None  # i -> j
    kp_i: tuple = ()               # (keypoints, descriptors)
    kp_j: tuple = ()
    raw_pairs: np.ndarray | None = None   # Nx4: x_i,y_i,x_j,y_j（候选）
    inlier_pairs: np.ndarray | None = None # Mx4: 有效匹配
    manual: bool = False           # 是否含手动控制点贡献


def _detector(cfg: Config):
    name = cfg.feature_type.lower()
    if name == "sift":
        try:
            return cv2.SIFT_create(nfeatures=cfg.n_features), "sift"
        except cv2.error:
            pass
    return cv2.ORB_create(nfeatures=cfg.n_features), "orb"


def extract_features(img: np.ndarray, cfg: Config):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    det, kind = _detector(cfg)
    kps, desc = det.detectAndCompute(gray, None)
    if desc is None:
        return kps, desc, kind
    if kind == "orb":
        desc = desc.astype(np.uint8)
    return kps, desc, kind


def _match_descriptors(desc_a, desc_b, kind: str, cfg: Config):
    if desc_a is None or desc_b is None or len(desc_a) < 2 or len(desc_b) < 2:
        return []
    if kind == "sift":
        bf = cv2.BFMatcher(cv2.NORM_L2)
    else:
        bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    knn = bf.knnMatch(desc_a, desc_b, k=2)
    good = []
    for pair in knn:
        if len(pair) != 2:
            continue
        best, second = pair
        if best.distance < cfg.ratio_test * second.distance:
            good.append(best)
    return good


def _grid_coverage(points: np.ndarray, w: int, h: int, grid: int) -> int:
    if len(points) == 0:
        return 0
    gx = np.clip((points[:, 0] / max(w, 1) * grid).astype(int), 0, grid - 1)
    gy = np.clip((points[:, 1] / max(h, 1) * grid).astype(int), 0, grid - 1)
    return len(set(zip(gx.tolist(), gy.tolist())))


def _confidence(m: "PairMatch", cfg: Config) -> float:
    """多因子综合可信度，避免单看数量。"""
    if not m.accepted:
        return 0.0
    inlier_term = min(m.n_inliers / 60.0, 1.0)
    ratio_term = min(m.inlier_ratio / 0.8, 1.0)
    rmse_term = max(0.0, 1.0 - m.rmse / cfg.max_final_rmse_px)
    cover_term = min(m.coverage_cells / (cfg.match_grid * cfg.match_grid), 1.0)
    overlap_term = min(m.overlap_frac / 0.35, 1.0)
    return float(
        0.30 * inlier_term
        + 0.20 * ratio_term
        + 0.20 * rmse_term
        + 0.15 * cover_term
        + 0.15 * overlap_term
    )


def match_pair(
    i: int,
    j: int,
    img_i: np.ndarray,
    img_j: np.ndarray,
    feats_i,
    feats_j,
    cfg: Config,
    extra_src: np.ndarray | None = None,
    extra_dst: np.ndarray | None = None,
    manual: bool = False,
) -> PairMatch:
    """估计 i->j 的关系。extra_src/dst 为手动控制点（i 坐标 / j 坐标）。"""
    hi, wi = img_i.shape[:2]
    hj, wj = img_j.shape[:2]
    kp_i, desc_i, kind_i = feats_i
    kp_j, desc_j, _ = feats_j
    kind = kind_i
    good = _match_descriptors(desc_i, desc_j, kind, cfg)

    raw = []
    for m in good:
        p_i = kp_i[m.queryIdx].pt
        p_j = kp_j[m.trainIdx].pt
        raw.append([p_i[0], p_i[1], p_j[0], p_j[1]])
    raw = np.asarray(raw, dtype=np.float64).reshape(-1, 4)

    n_extra = 0 if extra_src is None else len(extra_src)
    src_auto = raw[:, :2] if len(raw) else np.empty((0, 2))
    dst_auto = raw[:, 2:] if len(raw) else np.empty((0, 2))
    if n_extra:
        src_all = np.concatenate([src_auto, np.asarray(extra_src, float)])
        dst_all = np.concatenate([dst_auto, np.asarray(extra_dst, float)])
    else:
        src_all, dst_all = src_auto, dst_auto

    m = PairMatch(i=i, j=j, accepted=False, n_raw=len(raw),
                  kp_i=(kp_i, desc_i), kp_j=(kp_j, desc_j),
                  raw_pairs=raw, manual=manual)

    H, mask = geo.homography_from_correspondences(src_all, dst_all, cfg)
    if H is None:
        m.reasons.append("无法从对应点估计单应（有效点不足或几何退化）")
        m.confidence = 0.0
        return m

    inl = mask.astype(bool)
    src_in, dst_in = src_all[inl], dst_all[inl]
    H_refit, _ = geo.homography_from_correspondences(
        src_in, dst_in, cfg, ransac=False
    )
    if H_refit is not None:
        H = H_refit
    rmse = geo.reprojection_rmse(H, src_in, dst_in)

    m.H_ji = H
    m.n_inliers = int(inl.sum())
    m.inlier_ratio = m.n_inliers / max(m.n_raw + n_extra, 1)
    m.rmse = rmse
    m.inlier_pairs = np.concatenate([src_in, dst_in], axis=1)
    m.coverage_cells = _grid_coverage(src_in, wi, hi, cfg.match_grid)
    m.overlap_frac = geo.estimate_overlap_frac(H, (wi, hi), (wj, hj))

    # ---- 六类硬性拒绝条件 ----
    if m.n_inliers < cfg.min_inliers:
        m.reasons.append(
            f"有效内点 {m.n_inliers} < 最少 {cfg.min_inliers}，重叠不足"
        )
    if m.inlier_ratio < cfg.min_inlier_ratio:
        m.reasons.append(
            f"内点比例 {m.inlier_ratio:.2f} < {cfg.min_inlier_ratio}，"
            "存在大量错误匹配"
        )
    if rmse > cfg.max_final_rmse_px:
        m.reasons.append(
            f"重投影 RMSE {rmse:.2f}px > {cfg.max_final_rmse_px}px，"
            "几何关系明显失真"
        )
    if m.coverage_cells < cfg.min_coverage_cells:
        m.reasons.append(
            f"匹配仅覆盖 {m.coverage_cells} 个网格，空间分布过于集中"
        )
    if m.overlap_frac < cfg.min_overlap_frac:
        m.reasons.append(
            f"估计重叠区 {m.overlap_frac:.1%} < {cfg.min_overlap_frac:.1%}，"
            "重叠不足"
        )
    sanity = geo.check_homography_sanity(H, wi, hi, cfg)
    if not sanity:
        m.reasons.extend(sanity.reasons)

    m.accepted = not m.reasons
    m.confidence = _confidence(m, cfg)
    return m
