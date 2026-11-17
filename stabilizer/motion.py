"""帧间运动估计与硬切检测。

正常流程使用 Shi-Tomasi 角点 + 光流 + RANSAC 部分仿射(相似变换),
特征不足时回退 ECC; 两者都无法可靠匹配的帧判定为硬切。
本模块只输出帧间相对运动与检测分数, 不做任何平滑处理。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# 硬切判定阈值
MIN_MATCHED_POINTS = 20
MIN_INLIER_RATIO = 0.25
ECC_MIN_CC = 0.5
MIN_SHOT_FRAMES = 8          # 距上一个切点太近的检测结果忽略
DIFF_SMALL = 12.0            # 灰度差很小的帧直接视为同镜头, 不判切


@dataclass
class MotionResult:
    affines: np.ndarray         # (N,2,3), A_i 把帧 i 坐标映射到帧 i-1 坐标; A_0=I
    inlier_ratios: np.ndarray   # (N,), 帧0为 1.0
    gray_diffs: np.ndarray      # (N,), 缩小灰度图的平均绝对差, 帧0为 0
    ecc_fallback: np.ndarray    # (N,) bool, 是否使用了 ECC 回退
    auto_cuts: list[int]        # 检测到的硬切首帧索引(不含 0)


def _downscale(gray: np.ndarray, target_w: int = 320) -> tuple[np.ndarray, float]:
    h, w = gray.shape
    if w <= target_w:
        return gray, 1.0
    scale = target_w / w
    small = cv2.resize(gray, (target_w, max(1, round(h * scale))),
                       interpolation=cv2.INTER_AREA)
    return small, scale


def _ecc_estimate(prev_gray: np.ndarray, gray: np.ndarray,
                  full_w: int) -> tuple[np.ndarray | None, float]:
    """ECC 欧氏变换回退, 返回全分辨率 2x3 矩阵与相关系数。"""
    small_prev, scale = _downscale(prev_gray)
    small_cur, _ = _downscale(gray)
    warp = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 1e-4)
    try:
        cc, warp = cv2.findTransformECC(
            small_prev, small_cur, warp, cv2.MOTION_EUCLIDEAN, criteria, None, 5,
        )
    except cv2.error:
        return None, 0.0
    if scale != 1.0:
        warp = warp.copy()
        warp[:, 2] *= full_w / small_prev.shape[1]
    return warp.astype(np.float64), float(cc)


def _match_affine(prev_gray: np.ndarray, gray: np.ndarray
                  ) -> tuple[np.ndarray | None, float, int, float]:
    """返回 (2x3矩阵或None, 内点率, 有效匹配点数, 灰度差)。"""
    pts = cv2.goodFeaturesToTrack(
        prev_gray, maxCorners=400, qualityLevel=0.01, minDistance=8,
    )
    h, w = prev_gray.shape
    small_prev, _ = _downscale(prev_gray, 160)
    small_cur, _ = _downscale(gray, 160)
    gray_diff = float(np.mean(cv2.absdiff(small_prev, small_cur)))
    if pts is None or len(pts) < MIN_MATCHED_POINTS:
        return None, 0.0, 0, gray_diff

    nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, pts, None)
    back, st_back, _ = cv2.calcOpticalFlowPyrLK(gray, prev_gray, nxt, None)
    fb_err = np.linalg.norm(pts - back, axis=2).ravel()
    ok = (st.ravel() == 1) & (st_back.ravel() == 1) & (fb_err < 1.0)
    p0, p1 = pts[ok], nxt[ok]
    if len(p0) < MIN_MATCHED_POINTS:
        return None, 0.0, len(p0), gray_diff

    matrix, inliers = cv2.estimateAffinePartial2D(
        p0, p1, method=cv2.RANSAC, ransacReprojThreshold=3.0, maxIters=2000,
        confidence=0.99, refineIters=10,
    )
    if matrix is None or inliers is None:
        return None, 0.0, len(p0), gray_diff
    ratio = float(inliers.mean())
    return matrix.astype(np.float64), ratio, len(p0), gray_diff


def estimate_motions(video_path: str, frame_count: int,
                     progress_cb=None) -> MotionResult:
    """逐帧估计 i-1 -> i 的相似变换, 并自动检测硬切。"""
    cv2.setRNGSeed(12345)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV 无法打开视频: {video_path}")

    affines = [np.eye(2, 3, dtype=np.float64)]
    inlier_ratios = [1.0]
    gray_diffs = [0.0]
    ecc_used = [False]
    auto_cuts: list[int] = []

    ok, prev_frame = cap.read()
    if not ok:
        cap.release()
        raise RuntimeError("视频首帧读取失败")
    prev_gray = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
    idx = 1
    while idx < frame_count:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        matrix, ratio, matched, gdiff = _match_affine(prev_gray, gray)
        used_ecc = False

        if matrix is None or ratio < MIN_INLIER_RATIO:
            # 灰度差很小说明画面没真的切, 尝试 ECC 回退
            ecc_matrix, cc = _ecc_estimate(prev_gray, gray, gray.shape[1])
            if ecc_matrix is not None and cc >= ECC_MIN_CC:
                matrix, ratio, used_ecc = ecc_matrix, max(ratio, cc), True
            else:
                # 硬切: 新镜头从单位变换重新开始
                # 末尾不足一个最小镜头的位置不判切点 (末帧匹配本就不可靠)
                if (gdiff >= DIFF_SMALL
                        and (not auto_cuts or idx - auto_cuts[-1] >= MIN_SHOT_FRAMES)
                        and frame_count - idx >= MIN_SHOT_FRAMES):
                    auto_cuts.append(idx)
                matrix = np.eye(2, 3, dtype=np.float64)
                ratio = 0.0

        affines.append(matrix)
        inlier_ratios.append(ratio)
        gray_diffs.append(gdiff)
        ecc_used.append(used_ecc)
        prev_gray = gray
        idx += 1
        if progress_cb and idx % 10 == 0:
            progress_cb(idx, frame_count)

    cap.release()
    n = len(affines)
    if n != frame_count:
        raise RuntimeError(f"实际读取 {n} 帧, 与声明的 {frame_count} 帧不一致")
    return MotionResult(
        affines=np.asarray(affines, dtype=np.float64),
        inlier_ratios=np.asarray(inlier_ratios, dtype=np.float64),
        gray_diffs=np.asarray(gray_diffs, dtype=np.float64),
        ecc_fallback=np.asarray(ecc_used, dtype=bool),
        auto_cuts=auto_cuts,
    )


def validate_cuts(cuts: list[int], frame_count: int) -> list[int]:
    """校正后的切点需要满足范围与最小镜头长度约束。"""
    cleaned = sorted({int(c) for c in cuts
                      if 1 <= int(c) <= frame_count - MIN_SHOT_FRAMES})
    result: list[int] = []
    for c in cleaned:
        if result and c - result[-1] < MIN_SHOT_FRAMES:
            continue
        result.append(c)
    return result
